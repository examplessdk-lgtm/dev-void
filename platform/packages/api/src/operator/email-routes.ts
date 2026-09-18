import { asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { capabilityMiddleware } from '../capabilities.ts';
import { getProject, getProjectBySlug, type Db } from '../db.ts';
import {
  MAX_DOMAIN_LENGTH,
  isValidEmailDomain,
  normalizeEmailDomain,
} from '../email/domain-name.ts';
import {
  addEmailDomainForProject,
  getEmailDomainRowByDomain,
  getEmailDomainStatusForProject,
  removeEmailDomainForProject,
  serializeEmailDomain,
  syncEmailDomainForProject,
} from '../email/domain-service.ts';
import {
  emailBurstLimitKey,
  emailMonthlyLimitKey,
  parseEmailLimit,
  parseEmailLimitInput,
  MAX_EMAIL_LIMIT,
} from '../email/limits.ts';
import { lookupMxOverDns } from '../email/relay-engine.ts';
import {
  EmailSettingsError,
  getEmailDomainManagement,
  getEmailRecipientPolicy,
  isEmailDomainManagement,
  normalizeEmailRecipientPolicy,
  repairEmailRecipientPolicyMirror,
  setEmailDomainManagement,
  setEmailRecipientPolicy,
  type EmailRecipientPolicy,
} from '../email/settings.ts';
import type { ApiEnv } from '../env.ts';
import { emailDomains, projects } from '../schema.ts';
import { dryRun, OperatorError, preview, readBody, stringField } from './common.ts';

/**
 * Installation-wide email administration (design doc 0078, "Recipient
 * policy" and "Administrator-managed domains"). The browser admin UI calls
 * the same service functions below so both surfaces write one contract.
 */
export const emailOperatorRoutes = new Hono<ApiEnv>().use(
  '/email/*',
  capabilityMiddleware('email'),
);

function policyEffect(policy: EmailRecipientPolicy): string {
  switch (policy.mode) {
    case 'any':
      return "Shared-sender mail reaches any recipient; addresses on the platform's own mail domain stay verified-destination-only, so no project reaches another project's inbox without its consent. Cloudflare still refuses unverified destinations until the platform mail domain is onboarded for Email Sending.";
    case 'domains':
      return `Shared-sender mail reaches verified destinations and any address on ${policy.domains.join(', ')}; addresses on the platform's own mail domain stay verified-destination-only. Cloudflare still refuses unverified destinations until the platform mail domain is onboarded for Email Sending.`;
    default:
      return "Shared-sender mail reaches only each project's verified destinations.";
  }
}

export async function getOperatorEmailPolicy(context: Context<ApiEnv>) {
  const db = context.get('db');
  const policy = await getEmailRecipientPolicy(db);
  await repairEmailRecipientPolicyMirror(db, context.env.ROUTING);
  return { policy: { mode: policy.mode, domains: [...policy.domains] } };
}

export async function setOperatorEmailPolicy(
  context: Context<ApiEnv>,
  input: { mode: string; domains?: string },
  dryRunRequested = false,
) {
  let policy: EmailRecipientPolicy;
  try {
    policy = normalizeEmailRecipientPolicy(input);
  } catch (err) {
    if (err instanceof EmailSettingsError) {
      throw new OperatorError(400, err.message, 'invalid_argument');
    }
    throw err;
  }
  const db = context.get('db');
  const previous = await getEmailRecipientPolicy(db);
  const action = 'email.policy.set';
  const target = { mode: policy.mode, domains: [...policy.domains] };
  if (dryRunRequested) {
    return preview(action, target, {
      previous: { mode: previous.mode, domains: [...previous.domains] },
      effect: policyEffect(policy),
    });
  }
  try {
    await setEmailRecipientPolicy(db, context.env.ROUTING, policy);
  } catch (err) {
    throw new OperatorError(503, err instanceof Error ? err.message : String(err), 'mirror_failed');
  }
  return { action, target, policy: target };
}

export async function getOperatorEmailSettings(context: Context<ApiEnv>) {
  return { domains: { management: await getEmailDomainManagement(context.get('db')) } };
}

export async function setOperatorEmailSettings(
  context: Context<ApiEnv>,
  domains: string,
  dryRunRequested = false,
) {
  if (!isEmailDomainManagement(domains)) {
    throw new OperatorError(400, 'domains must be self-serve or admin.', 'invalid_argument');
  }
  const db = context.get('db');
  const previous = await getEmailDomainManagement(db);
  const action = 'email.settings.set';
  const target = { domains };
  if (dryRunRequested) {
    return preview(action, target, {
      previous: { domains: previous },
      effect:
        domains === 'admin'
          ? 'Project owners are told to ask an administrator; `void email domain add` no longer opens a Cloudflare consent.'
          : 'Project owners register email domains with their own Cloudflare credential.',
    });
  }
  await setEmailDomainManagement(db, domains);
  return { action, target, domains: { management: domains } };
}

async function resolveProject(db: Db, selector: string) {
  const project = (await getProject(db, selector)) ?? (await getProjectBySlug(db, selector));
  if (!project) {
    throw new OperatorError(404, 'Project not found');
  }
  return project;
}

export async function setOperatorEmailLimit(
  context: Context<ApiEnv>,
  selector: string,
  input: { monthly?: string; burst?: string },
  dryRunRequested = false,
) {
  const parse = (name: 'monthly' | 'burst'): number | undefined => {
    const raw = input[name];
    if (raw === undefined || raw === '') {
      return undefined;
    }
    const value = parseEmailLimitInput(raw);
    if (value === undefined) {
      throw new OperatorError(
        400,
        `${name} must be an integer from 1 to ${MAX_EMAIL_LIMIT}.`,
        'invalid_argument',
      );
    }
    return value;
  };
  const monthly = parse('monthly');
  const burst = parse('burst');
  if (monthly === undefined && burst === undefined) {
    throw new OperatorError(400, 'Supply --monthly, --burst, or both.', 'invalid_argument');
  }
  const db = context.get('db');
  const project = await resolveProject(db, selector);
  const kv = context.env.ROUTING;
  const [previousMonthly, previousBurst] = await Promise.all([
    kv.get(emailMonthlyLimitKey(project.id)),
    kv.get(emailBurstLimitKey(project.id)),
  ]);
  const action = 'email.limit.set';
  const target = {
    projectId: project.id,
    slug: project.slug,
    ...(monthly === undefined ? {} : { monthly }),
    ...(burst === undefined ? {} : { burst }),
  };
  const previous = {
    monthly: parseEmailLimit(previousMonthly) ?? null,
    burst: parseEmailLimit(previousBurst) ?? null,
  };
  if (dryRunRequested) {
    return preview(action, target, { previous });
  }
  const applied: Array<'monthly' | 'burst'> = [];
  const failed: Array<'monthly' | 'burst'> = [];
  for (const [name, key, value] of [
    ['monthly', emailMonthlyLimitKey(project.id), monthly],
    ['burst', emailBurstLimitKey(project.id), burst],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    try {
      await kv.put(key, String(value));
      applied.push(name);
    } catch (err) {
      console.error(`[operator-email] ${name} cap write failed:`, err);
      failed.push(name);
    }
  }
  if (failed.length === 0) {
    return { action, target, previous };
  }
  if (applied.length === 0) {
    throw new OperatorError(
      502,
      'No cap was changed: routing storage refused the write.',
      'kv_failed',
      { failed },
    );
  }
  return { action, target, previous, ok: false as const, partial: true as const, applied, failed };
}

emailOperatorRoutes.get('/email/policy', async (context) =>
  context.json(await getOperatorEmailPolicy(context)),
);
emailOperatorRoutes.post('/email/policy', async (context) => {
  const body = await readBody(context);
  return context.json(
    await setOperatorEmailPolicy(
      context,
      {
        mode: stringField(body, 'mode', { maxLength: 32 }),
        domains:
          stringField(body, 'domains', { optional: true, maxLength: 100 * 254 }) || undefined,
      },
      dryRun(body),
    ),
  );
});
emailOperatorRoutes.get('/email/settings', async (context) =>
  context.json(await getOperatorEmailSettings(context)),
);
emailOperatorRoutes.post('/email/settings', async (context) => {
  const body = await readBody(context);
  return context.json(
    await setOperatorEmailSettings(
      context,
      stringField(body, 'domains', { maxLength: 32 }),
      dryRun(body),
    ),
  );
});
emailOperatorRoutes.post('/email/projects/:project/limit', async (context) => {
  const body = await readBody(context);
  const result = await setOperatorEmailLimit(
    context,
    context.req.param('project'),
    {
      monthly: stringField(body, 'monthly', { optional: true, maxLength: 16 }) || undefined,
      burst: stringField(body, 'burst', { optional: true, maxLength: 16 }) || undefined,
    },
    dryRun(body),
  );
  return context.json(result, 'ok' in result && result.ok === false ? 207 : 200);
});

// ---------------------------------------------------------------------------
// Administrator-managed domains. The operations are the owner routes' own
// (email/domain-service.ts); this layer resolves the project for the
// administrator, previews without touching Cloudflare, and re-shapes the
// service's JSON responses into operator results.
// ---------------------------------------------------------------------------

/** The service answers with the owner routes' JSON; carry a refusal over as an OperatorError. */
async function operatorResult(
  response: Response,
  action: string,
  target: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof body.error === 'string' && body.error !== ''
        ? body.error
        : 'The email domain operation failed.';
    throw new OperatorError(response.status, message, 'email_domain_error', body);
  }
  // A kept row after a failed destructive step answers 200 with `ok: false`
  // (the owner contract), and a setup or sync that ended on a Cloudflare
  // failure answers 200 with the row in a failed state. Both surface as a
  // top-level `ok: false` so the audit records a failed mutation and the
  // CLI reports the partial result.
  const failed =
    body.ok === false ||
    body.status === 'failed' ||
    body.status === 'token_revoked' ||
    body.status === 'token_expired';
  return { action, target, ...(failed ? { ok: false } : {}), domain: body };
}

function requireDomain(raw: string): string {
  if (raw.length > MAX_DOMAIN_LENGTH) {
    throw new OperatorError(400, 'Invalid domain.', 'invalid_argument');
  }
  const domain = normalizeEmailDomain(raw);
  if (!isValidEmailDomain(domain)) {
    throw new OperatorError(400, 'Invalid domain.', 'invalid_argument');
  }
  return domain;
}

async function requireDomainRow(db: Db, raw: string) {
  const domain = requireDomain(raw);
  const row = await getEmailDomainRowByDomain(db, domain);
  if (!row) {
    throw new OperatorError(404, 'Email domain not found.');
  }
  const project = await getProject(db, row.project_id);
  if (!project) {
    throw new OperatorError(404, 'Project not found.');
  }
  return { domain, row, project };
}

export async function listOperatorEmailDomains(context: Context<ApiEnv>, selector?: string) {
  const db = context.get('db');
  const project = selector ? await resolveProject(db, selector) : null;
  const rows = await db
    .select()
    .from(emailDomains)
    .where(project ? eq(emailDomains.project_id, project.id) : undefined)
    .orderBy(asc(emailDomains.created_at));
  const projectIds = [...new Set(rows.map((row) => row.project_id))];
  const owners =
    projectIds.length === 0
      ? []
      : await db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, projectIds));
  const slugs = new Map(owners.map((owner) => [owner.id, owner.slug]));
  return {
    domains: rows.map((row) => ({
      ...serializeEmailDomain(row),
      project: { id: row.project_id, slug: slugs.get(row.project_id) ?? null },
    })),
  };
}

export async function addOperatorEmailDomain(
  context: Context<ApiEnv>,
  input: { domain: string; project: string; apiToken?: string },
  dryRunRequested = false,
) {
  const db = context.get('db');
  const domain = requireDomain(input.domain);
  const project = await resolveProject(db, input.project);
  const existing = await getEmailDomainRowByDomain(db, domain);
  if (existing && existing.project_id !== project.id) {
    throw new OperatorError(409, 'This email domain is registered to another project.');
  }
  if (existing && existing.managed_by === 'owner') {
    throw new OperatorError(
      409,
      'This email domain was registered by its project owner; ask them to remove it first.',
    );
  }
  const credentialKind = input.apiToken ? 'api_token' : 'platform';
  const action = 'email.domain.add';
  const target = { domain, projectId: project.id, slug: project.slug, credentialKind };
  if (dryRunRequested) {
    // Read-only: the engine's own MX rule, previewed over public DNS. No
    // Cloudflare call — the preview must never spend the credential.
    let mx: 'apex' | 'subdomain' | 'unknown' = 'unknown';
    try {
      mx = (await lookupMxOverDns(domain)).length > 0 ? 'subdomain' : 'apex';
    } catch {
      mx = 'unknown';
    }
    return preview(action, target, {
      existing: existing ? { status: existing.status, managed_by: existing.managed_by } : null,
      plan: existing ? 'rerun' : 'setup',
      mx,
      effect: existing?.mode
        ? `Re-runs setup for ${domain} on ${project.slug} in its stored ${existing.mode} mode; the credential is replaced, rules and the relay stay.`
        : mx === 'subdomain'
          ? `${domain} already receives mail; setup will refuse it — name a subdomain such as mail.${domain} instead.`
          : credentialKind === 'platform'
            ? `Registers ${domain} for ${project.slug} on the platform's own Cloudflare credential; the zone must be in the platform's account.`
            : `Registers ${domain} for ${project.slug} with the supplied API token.`,
    });
  }
  return operatorResult(
    await addEmailDomainForProject(context, project, {
      domain,
      apiToken: input.apiToken,
      managedBy: 'admin',
    }),
    action,
    target,
  );
}

export async function getOperatorEmailDomain(context: Context<ApiEnv>, rawDomain: string) {
  const { row, project } = await requireDomainRow(context.get('db'), rawDomain);
  const response = await getEmailDomainStatusForProject(context, project, row.domain);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorError(response.status, String(body.error ?? 'status failed'));
  }
  return { ...body, project: { id: project.id, slug: project.slug } };
}

export async function syncOperatorEmailDomain(
  context: Context<ApiEnv>,
  rawDomain: string,
  dryRunRequested = false,
) {
  const { domain, row, project } = await requireDomainRow(context.get('db'), rawDomain);
  const action = 'email.domain.sync';
  const target = { domain, projectId: project.id, slug: project.slug };
  if (dryRunRequested) {
    return preview(action, target, {
      status: row.status,
      managed_by: row.managed_by,
      relay_worker_name: row.relay_worker_name,
      effect:
        'Redeploys the relay worker at the current version, rotates its secret and re-ensures the zone catch-all.',
    });
  }
  return operatorResult(
    await syncEmailDomainForProject(context, project, domain, 'admin'),
    action,
    target,
  );
}

export async function removeOperatorEmailDomain(
  context: Context<ApiEnv>,
  rawDomain: string,
  force: boolean,
  dryRunRequested = false,
) {
  const { domain, row, project } = await requireDomainRow(context.get('db'), rawDomain);
  const action = 'email.domain.remove';
  const target = { domain, projectId: project.id, slug: project.slug, force };
  if (dryRunRequested) {
    return preview(action, target, {
      status: row.status,
      managed_by: row.managed_by,
      relay_worker_name: row.relay_worker_name,
      effect: force
        ? 'Deletes the row even if the Cloudflare cleanup fails; anything left behind is reported for manual removal.'
        : 'Resets the zone catch-all, deletes the relay worker, then deletes the row; a failed destructive step keeps the row for retry.',
    });
  }
  return operatorResult(
    await removeEmailDomainForProject(context, project, domain, force, 'admin'),
    action,
    target,
  );
}

emailOperatorRoutes.get('/email/domains', async (context) =>
  context.json(await listOperatorEmailDomains(context, context.req.query('project') || undefined)),
);
emailOperatorRoutes.post('/email/domains', async (context) => {
  const body = await readBody(context);
  return context.json(
    await addOperatorEmailDomain(
      context,
      {
        domain: stringField(body, 'domain', { maxLength: MAX_DOMAIN_LENGTH }),
        project: stringField(body, 'project'),
        apiToken: stringField(body, 'apiToken', { optional: true, maxLength: 2048 }) || undefined,
      },
      dryRun(body),
    ),
  );
});
emailOperatorRoutes.get('/email/domains/:domain', async (context) =>
  context.json(await getOperatorEmailDomain(context, context.req.param('domain'))),
);
emailOperatorRoutes.post('/email/domains/:domain/sync', async (context) => {
  const body = await readBody(context);
  return context.json(
    await syncOperatorEmailDomain(context, context.req.param('domain'), dryRun(body)),
  );
});
emailOperatorRoutes.post('/email/domains/:domain/remove', async (context) => {
  const body = await readBody(context);
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    throw new OperatorError(400, 'force must be a boolean.', 'invalid_argument');
  }
  return context.json(
    await removeOperatorEmailDomain(
      context,
      context.req.param('domain'),
      body.force === true,
      dryRun(body),
    ),
  );
});
