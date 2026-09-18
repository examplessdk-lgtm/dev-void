import { asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import {
  countProjectsUsingDestination,
  deleteEmailDestination,
  getEmailDestinationsByProjectId,
  getProject,
} from '../../db.ts';
import {
  emailActionRecipients,
  emailProjectControls,
  emailReceipts,
} from '../../email/admission-schema.ts';
import { setProjectEmailLimits, setProjectEmailSuspended } from '../../email/admission.ts';
import {
  emailDomainRoutes,
  emailZoneConnections,
  emailCredentials,
} from '../../email/connection-schema.ts';
import {
  addEmailDomainForProject,
  removeEmailDomainForProject,
  rotateEmailIngressSecretForProject,
} from '../../email/domain-service.ts';
import {
  DEFAULT_EMAIL_BURST_LIMIT as DEFAULT_BURST_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT as DEFAULT_MONTHLY_LIMIT,
  emailBurstLimitKey as burstLimitKey,
  emailMonthlyLimitKey as monthlyLimitKey,
  emailSuspendKey as suspendKey,
  parseEmailLimit as parseLimit,
} from '../../email/limits.ts';
import {
  getEmailDomainManagement,
  getEmailRecipientPolicy,
  repairEmailRecipientPolicyMirror,
} from '../../email/settings.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import { setOperatorEmailPolicy, setOperatorEmailSettings } from '../../operator/email-routes.ts';
import {
  syncProjectAllowlistKv,
  syncProjectAllowlistKvBestEffort,
} from '../../provisioning/email-allowlist.ts';
import { deleteDestination } from '../../provisioning/email-routing.ts';
import { renderOperationError } from '../operation-error.tsx';
import { EmailSettingsPage } from '../views/email-settings.tsx';
import { STATUS_COLORS, formatDateTime } from '../views/format.ts';
import { Layout } from '../views/layout.tsx';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);
// The same capability boundary the owner and operator email routes sit
// behind: a platform that does not enable email must not have its policy,
// settings or domains changed from the browser either.
app.use('*', async (context, next) => {
  if (!getPlatformCapabilities(context.env).email) {
    return context.html('<h1>Email is not enabled on this platform</h1>', 501);
  }
  await next();
});

/**
 * Email control plane for operators: installation-wide settings at `/`,
 * one project's usage, caps, kill switch, destinations and domains at
 * `/:projectId`.
 *
 * Every number on the project page is read straight out of `ROUTING` KV,
 * which is where the proxy worker (`packages/proxy/src/email.ts`) keeps the
 * counters and reads the caps from. The keys and defaults come from
 * `email/limits.ts`, the one spelling the api's writers share with the
 * proxy's readers — nothing at build time catches a drift.
 *
 * The destination and custom-domain rows are Postgres. The proxy's only
 * view of a custom domain is the `email-domain:` ROUTING mirror, so the
 * revoke below clears that key before the row.
 */
const sentKey = (projectId: string, month: string) => `email-sent:${projectId}:${month}`;
const recvKey = (projectId: string, month: string) => `email-recv:${projectId}:${month}`;

/** The admin layout has no utility classes, so secondary text is inline. */
const META = 'font-size: 0.8rem; color: #666';

// GET /email/ — installation-wide recipient policy and domain management
app.get('/', async (context) => {
  const db = context.get('db');
  // Every read surface republishes a drifted mirror, this page included:
  // an administrator who sees `verified` here must be seeing what the
  // proxy enforces.
  await repairEmailRecipientPolicyMirror(db, context.env.ROUTING);
  const [policy, management] = await Promise.all([
    getEmailRecipientPolicy(db),
    getEmailDomainManagement(db),
  ]);
  return context.html(
    <EmailSettingsPage
      policy={policy}
      management={management}
      senderDomain={context.env.EMAIL_SENDER_DOMAIN}
      username={context.get('user').login}
    />,
  );
});

// POST /email/policy — the shared-sender recipient policy
app.post('/policy', async (context) => {
  const body = await context.req.parseBody();
  const mode = String(body.mode ?? '');
  const domains = typeof body.domains === 'string' ? body.domains : '';
  return executeAuditedMutation(
    context,
    operatorAuditIntent('email/policy', { mode, domains }),
    async () => {
      await setOperatorEmailPolicy(context, { mode, domains: domains || undefined });
      return { response: context.redirect('/admin/email'), succeeded: true };
    },
  );
});

// POST /email/settings — who manages email domains
app.post('/settings', async (context) => {
  const body = await context.req.parseBody();
  const domains = String(body.domains ?? '');
  return executeAuditedMutation(
    context,
    operatorAuditIntent('email/settings', { domains }),
    async () => {
      await setOperatorEmailSettings(context, domains);
      return { response: context.redirect('/admin/email'), succeeded: true };
    },
  );
});

// GET /email/:projectId — usage, caps, kill switch, destinations
app.get('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }

  const month = monthBucket();
  const monthStart = `${month}-01T00:00:00.000Z`;
  const [sentRows, receivedRows, controls, destinations, domainRows] = await Promise.all([
    context
      .get('db')
      .select({ count: sql<number>`count(*)::int` })
      .from(emailActionRecipients)
      .where(
        sql`${emailActionRecipients.project_id} = ${projectId} AND ${emailActionRecipients.state} IN ('reserved','attempt_started','provider_accepted','failed','outcome_unknown') AND ${emailActionRecipients.reserved_at} >= ${monthStart}::timestamptz`,
      ),
    context
      .get('db')
      .select({ count: sql<number>`count(*)::int` })
      .from(emailReceipts)
      .where(
        sql`${emailReceipts.project_id} = ${projectId} AND ${emailReceipts.created_at} >= ${monthStart}::timestamptz`,
      ),
    context
      .get('db')
      .select()
      .from(emailProjectControls)
      .where(eq(emailProjectControls.project_id, projectId))
      .limit(1),
    getEmailDestinationsByProjectId(context.get('db'), projectId),
    context
      .get('db')
      .select({
        route: emailDomainRoutes,
        connection: emailZoneConnections,
        credential: emailCredentials,
      })
      .from(emailDomainRoutes)
      .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
      .leftJoin(emailCredentials, eq(emailZoneConnections.credential_id, emailCredentials.id))
      .where(eq(emailDomainRoutes.project_id, projectId))
      .orderBy(asc(emailDomainRoutes.created_at)),
  ]);
  const sent = sentRows[0]?.count ?? 0;
  const received = receivedRows[0]?.count ?? 0;

  // Distinguish an override from the default so an operator can see at a
  // glance whether someone bumped a cap during a past incident — the
  // override keys are write-only otherwise.
  const control = controls[0];
  const monthlyLimit =
    control && control.monthly_limit !== DEFAULT_MONTHLY_LIMIT ? control.monthly_limit : undefined;
  const burstLimit =
    control && control.burst_limit !== DEFAULT_BURST_LIMIT ? control.burst_limit : undefined;
  const isSuspended = Boolean(control?.suspended_at);
  const domains = domainRows.map(({ route, connection, credential }) => ({
    id: route.id,
    domain: route.domain,
    status: route.inbound_status,
    managed_by: route.managed_by,
    credential_kind: credential?.kind ?? 'platform',
    mode: route.addressing,
    relay_worker_name: connection.ingress_worker_name,
    relay_version: connection.ingress_version,
    token_id: credential?.token_id ?? null,
    token_expires_on: credential?.expires_on ?? null,
  }));
  const senderDomain = context.env.EMAIL_SENDER_DOMAIN;
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  return context.html(
    <Layout title={`Email - ${project.slug}`} username={context.get('user').login}>
      <h1>
        Email &mdash; <a href={`/admin/projects/${projectId}`}>{project.slug}</a>
      </h1>

      <table>
        <tbody>
          <tr>
            <th>Project ID</th>
            <td>{projectId}</td>
          </tr>
          <tr>
            <th>Sender</th>
            <td>
              {senderDomain ? (
                <code>{`${project.slug}+noreply@${senderDomain}`}</code>
              ) : (
                <em>EMAIL_SENDER_DOMAIN is not configured for this environment</em>
              )}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              {isSuspended ? (
                <strong style="color: red">SUSPENDED</strong>
              ) : (
                <span style="color: #16a34a">active</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Usage ({month})</h2>
      <table>
        <tbody>
          <tr>
            <th>Outbound (sent)</th>
            <td>
              {sent} / {monthlyLimit ?? DEFAULT_MONTHLY_LIMIT}{' '}
              <span style={META}>({monthlyLimit === undefined ? 'default' : 'override'})</span>
            </td>
          </tr>
          <tr>
            <th>Inbound (received)</th>
            <td>{received}</td>
          </tr>
          <tr>
            <th>Burst cap</th>
            <td>
              {burstLimit ?? DEFAULT_BURST_LIMIT} / minute{' '}
              <span style={META}>({burstLimit === undefined ? 'default' : 'override'})</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p style={META}>
        Recipient submission attempts and inbound receipts are recorded in the platform database.
      </p>

      <h2>Controls</h2>
      <form method="post" action={`/admin/email/${projectId}/suspend`}>
        {/* Post the desired terminal state rather than a "toggle" intent, so a
            double-click cannot race two toggles and flip the switch back on. */}
        <input type="hidden" name="state" value={isSuspended ? 'active' : 'suspended'} />
        <button type="submit" class={isSuspended ? '' : 'danger'}>
          {isSuspended ? 'Unsuspend email' : 'Suspend email'}
        </button>{' '}
        <span style={META}>
          Suspending stops mail in both directions immediately. Outbound sends fail, and inbound
          messages are rejected with a permanent SMTP error, so the sender gets a bounce rather than
          a silent drop. There is no per-direction switch.
        </span>
      </form>

      <form method="post" action={`/admin/email/${projectId}/limit`} style="margin-top: 12px">
        <input type="number" name="limit" min="1" placeholder="blank = default" />
        <button type="submit">Set monthly limit</button>{' '}
        <span style={META}>Submit blank to drop the override back to the platform default.</span>
      </form>

      <form method="post" action={`/admin/email/${projectId}/burst-limit`} style="margin-top: 12px">
        <input type="number" name="burstLimit" min="1" placeholder="blank = default" />
        <button type="submit">Set burst limit</button>{' '}
        <span style={META}>Per-minute cap. Submit blank to drop the override.</span>
      </form>

      <h2>Verified destinations ({destinations.length})</h2>
      <p style={META}>
        Recipient addresses this project is allowed to send to. A <code>pending</code> row is
        waiting on the recipient clicking their verification link. Removing a row revokes it for
        this project only; the Cloudflare account-level address is deleted just when no other
        project still references it.
      </p>
      {destinations.length === 0 ? (
        <p>
          <em>No destinations yet.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Status</th>
              <th>Source</th>
              <th>Verified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {destinations.map((destination) => (
              <tr key={destination.id}>
                <td>{destination.address}</td>
                <td>
                  {destination.status === 'verified' ? (
                    <span style="color: #16a34a">verified</span>
                  ) : (
                    <span style="color: #d97706">pending</span>
                  )}
                </td>
                <td>{destination.verification_source}</td>
                <td>
                  {destination.verified_at ? formatDateTime(destination.verified_at, tz) : '-'}
                </td>
                <td>
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/destinations/${destination.id}/delete`}
                    onsubmit="return confirm('Remove &quot;' + this.dataset.address + '&quot; from this project?')"
                    data-address={destination.address}
                  >
                    <button type="submit" class="danger-sm">
                      remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={META}>
        Destinations are added by the project owner through{' '}
        <code>POST /projects/:id/email/destinations</code>, which emails the recipient for consent.
        There is deliberately no operator-side "add" here: an admin cannot consent on a recipient's
        behalf.
      </p>

      <h2>Custom domains ({domains.length})</h2>
      <p style={META}>
        Exact sender and recipient domains on a Cloudflare zone. One connection owns the ingress
        Worker and catch-all; removing an assignment keeps shared resources while sibling domains
        use them. The platform stores connection credentials and never shows them here.
      </p>
      <form
        method="post"
        action={`/admin/email/${projectId}/domains/add`}
        style="margin-bottom: 12px; display: flex; gap: 8px; align-items: center"
      >
        <input
          type="text"
          name="domain"
          placeholder="mail.example.com"
          autocomplete="off"
          required
          style="width: 240px"
        />
        <input
          type="password"
          name="token"
          placeholder="API token (blank = platform credential)"
          autocomplete="off"
          style="width: 300px"
        />
        <button type="submit">Add domain</button>
      </form>
      {domains.length === 0 ? (
        <p>
          <em>No custom domains.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Status</th>
              <th>Managed by</th>
              <th>Mode</th>
              <th>Relay worker</th>
              <th>v</th>
              <th>Token ID</th>
              <th>Token expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td>{domain.domain}</td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.status)}`}>{domain.status}</span>
                </td>
                <td>
                  {domain.managed_by}
                  {domain.credential_kind === 'platform' ? ' (platform credential)' : ''}
                </td>
                <td>{domain.mode ?? '-'}</td>
                <td>{domain.relay_worker_name ?? '-'}</td>
                <td>{domain.relay_version ?? '-'}</td>
                <td>{domain.token_id ?? '-'}</td>
                <td>
                  {domain.token_expires_on ? formatDateTime(domain.token_expires_on, tz) : '-'}
                </td>
                <td>
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/domains/${domain.domain}/rotate-secret`}
                  >
                    <button type="submit">rotate secret</button>
                  </form>
                  {/* Keep apostrophes out of the `onsubmit` text (see the Danger
                      Zone note above); the typed slug is the real confirmation
                      and is checked on the server. */}
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/domains/${domain.domain}/revoke`}
                    onsubmit="return confirm('Remove &quot;' + this.dataset.domain + '&quot;? This disables its exact assignment. Shared ingress stays while another domain uses it.')"
                    data-domain={domain.domain}
                  >
                    <input
                      type="text"
                      name="confirm"
                      placeholder={project.slug}
                      autocomplete="off"
                      required
                    />{' '}
                    <button type="submit" class="danger-sm">
                      revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>,
  );
});

// POST /email/:projectId/domains/add — register a domain for the project as
// an administrator (design doc 0078, "Administrator-managed domains"). The
// same operation the operator CLI runs; a blank token means the platform's
// own credential. The token is never echoed or audited.
app.post('/:projectId/domains/add', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (domain === '' || domain.length > 253) {
    throw new OperatorError(400, 'Enter the mail domain to register.');
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent('email/domains', { domain, project: projectId }),
    async () => {
      const res = await addEmailDomainForProject(context, project, {
        domain,
        apiToken: token || undefined,
        managedBy: 'admin',
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: unknown };
        throw new OperatorError(
          res.status,
          typeof json.error === 'string' ? json.error : 'Adding the email domain failed.',
        );
      }
      const row = (await res.json()) as {
        status?: string;
        error?: string;
        setup_state?: { failed_step?: string };
      };
      if (
        row.status === 'failed' ||
        row.status === 'token_revoked' ||
        row.status === 'token_expired'
      ) {
        const message =
          row.error ??
          (row.setup_state?.failed_step
            ? `Setup failed at step "${row.setup_state.failed_step}".`
            : 'The email domain setup did not finish.');
        return {
          response: await context.html(
            <Layout title={`Adding ${domain} did not finish`} username={context.get('user').login}>
              <h1>Adding {domain} did not finish</h1>
              <p>{message}</p>
              <p>
                Fix the step named above, then add the domain again — adding again retries it; rules
                stay.
              </p>
              <p>
                <a href={`/admin/email/${projectId}`}>&larr; Back to project email</a>
              </p>
            </Layout>,
            502,
          ),
          succeeded: false,
        };
      }
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
});

// POST /email/:projectId/suspend — set the kill switch to a desired terminal state
app.post('/:projectId/suspend', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const desired = body.state;
  if (desired === 'suspended') {
    await setProjectEmailSuspended(context.get('db'), projectId, true);
  } else if (desired === 'active') {
    await setProjectEmailSuspended(context.get('db'), projectId, false);
  } else {
    return context.html('<h1>Invalid state</h1><p>Expected "suspended" or "active".</p>', 400);
  }
  return context.redirect(`/admin/email/${projectId}`);
});

// POST /email/:projectId/limit — set (or clear) the monthly outbound override
app.post('/:projectId/limit', async (context) => {
  return setLimit(context, context.req.param('projectId'), 'monthly', 'limit');
});

// POST /email/:projectId/burst-limit — set (or clear) the per-minute override
app.post('/:projectId/burst-limit', async (context) => {
  return setLimit(context, context.req.param('projectId'), 'burst', 'burstLimit');
});

// POST /email/:projectId/destinations/:destId/delete — revoke one recipient
app.post('/:projectId/destinations/:destId/delete', async (context) => {
  const projectId = context.req.param('projectId');
  const destinationId = context.req.param('destId');
  const rows = await getEmailDestinationsByProjectId(context.get('db'), projectId);
  const destination = rows.find((row) => row.id === destinationId);
  if (!destination) {
    return context.html('<h1>Destination not found</h1>', 404);
  }
  // Tighten the KV mirror BEFORE anything destructive runs. Same inversion as
  // the user-facing revoke in `routes/email.ts`: the row is what a retry
  // re-derives the mirror from, so deleting it first leaves a failed KV write
  // with nothing to repair from and the revoked address keeps receiving mail.
  // The sync must EXCLUDE this row — it is still `verified` in Postgres here,
  // so a plain re-sync would write the address straight back.
  if (destination.status === 'verified') {
    try {
      await syncProjectAllowlistKv(context.get('db'), context.env.ROUTING, projectId, {
        excludeDestinationId: destination.id,
      });
    } catch (error) {
      console.error('[admin-email] allowlist tighten failed; keeping destination row', {
        projectId,
        destinationId,
        error,
      });
      return context.html('<h1>Failed to update send allowlist. Try again.</h1>', 503);
    }
  }

  // The Cloudflare destination address is account-level, so deleting it would
  // revoke the address for every project that shares it. Only the last
  // referencing project may remove it upstream.
  if (destination.cf_destination_id) {
    const references = await countProjectsUsingDestination(
      context.get('db'),
      destination.cf_destination_id,
    );
    if (references <= 1) {
      try {
        await deleteDestination(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          destination.cf_destination_id,
        );
      } catch (error) {
        // Best effort: a stranded CF address is inert (the per-project
        // allowlist below is what the proxy enforces), and failing the
        // operator's revoke on it would leave the row in place instead.
        console.error('[admin-email] CF deleteDestination failed', {
          projectId,
          destinationId,
          error,
        });
      }
    }
  }
  await deleteEmailDestination(context.get('db'), destination.id);
  // Re-derive after the delete: the tighten above works from a snapshot that
  // a concurrent confirm click can make stale. Same shape and same reasoning
  // as the owner-facing revoke in `routes/email.ts`.
  await syncProjectAllowlistKvBestEffort(context.get('db'), context.env.ROUTING, projectId);
  return context.redirect(`/admin/email/${projectId}`);
});

// An administrator removes one exact assignment through the same durable
// operation service as the owner API. Sibling routes keep their shared ingress.
app.post('/:projectId/domains/:domain/revoke', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  if (body.confirm !== project.slug) {
    return context.html('<h1>Not confirmed</h1>', 400);
  }
  const result = await removeEmailDomainForProject(
    context,
    project,
    context.req.param('domain'),
    false,
    'admin',
  );
  if (!result.ok) {
    return context.html('<h1>Email domain removal failed</h1>', result.status as 400);
  }
  return context.redirect(`/admin/email/${projectId}`);
});

app.post('/:projectId/domains/:domain/rotate-secret', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const result = await rotateEmailIngressSecretForProject(
    context,
    project,
    context.req.param('domain'),
    'admin',
  );
  if (!result.ok) {
    return context.html('<h1>Email ingress rotation failed</h1>', result.status as 400);
  }
  return context.redirect(`/admin/email/${projectId}`);
});

/**
 * Shared body of the two limit forms. A blank submission deletes the override
 * key, which is how an operator hands a project back to the platform default
 * after an incident — the proxy falls back to its own default on a missing key.
 */
async function setLimit(
  context: Context<ApiEnv>,
  projectId: string,
  kind: 'monthly' | 'burst',
  field: string,
): Promise<Response> {
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const submitted = body[field];
  const raw = typeof submitted === 'string' ? submitted.trim() : '';
  if (raw === '') {
    await setProjectEmailLimits(context.get('db'), projectId, { [kind]: null });
    return context.redirect(`/admin/email/${projectId}`);
  }
  const limit = parseLimit(raw);
  if (limit === undefined) {
    return context.html('<h1>Invalid limit</h1><p>Expected a positive integer, or blank.</p>', 400);
  }
  await setProjectEmailLimits(context.get('db'), projectId, { [kind]: limit });
  return context.redirect(`/admin/email/${projectId}`);
}

/** Domain rows reuse the shared status palette: active reads as success, anything dead as failed. */
function domainStatusColor(status: string): string {
  if (status === 'active') {
    return STATUS_COLORS.success;
  }
  if (status === 'pending') {
    return STATUS_COLORS.pending;
  }
  return STATUS_COLORS.failed;
}

/** UTC `YYYY-MM`, matching `monthBucket` in `packages/proxy/src/email.ts`. */
function monthBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseCounter(raw: string | null): number {
  if (!raw) {
    return 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export default app;
