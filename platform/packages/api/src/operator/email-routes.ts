import { Hono } from 'hono';
import type { Context } from 'hono';
import { capabilityMiddleware } from '../capabilities.ts';
import { getProject, getProjectBySlug, type Db } from '../db.ts';
import {
  emailBurstLimitKey,
  emailMonthlyLimitKey,
  parseEmailLimit,
  parseEmailLimitInput,
  MAX_EMAIL_LIMIT,
} from '../email/limits.ts';
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
      return 'Shared-sender mail reaches any recipient; Cloudflare still refuses unverified destinations until the platform mail domain is onboarded for Email Sending.';
    case 'domains':
      return `Shared-sender mail reaches verified destinations and any address on ${policy.domains.join(', ')}; Cloudflare still refuses unverified destinations until the platform mail domain is onboarded for Email Sending.`;
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
  if (monthly !== undefined) {
    await kv.put(emailMonthlyLimitKey(project.id), String(monthly));
  }
  if (burst !== undefined) {
    await kv.put(emailBurstLimitKey(project.id), String(burst));
  }
  return { action, target, previous };
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
  return context.json(
    await setOperatorEmailLimit(
      context,
      context.req.param('project'),
      {
        monthly: stringField(body, 'monthly', { optional: true, maxLength: 16 }) || undefined,
        burst: stringField(body, 'burst', { optional: true, maxLength: 16 }) || undefined,
      },
      dryRun(body),
    ),
  );
});
