import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import { deleteEmailDestination, getEmailDestinationsByProjectId, getProject } from '../../db.ts';
import { emailMonthlyUsage, emailProjectControls } from '../../email/admission-schema.ts';
import { setProjectEmailLimits, setProjectEmailSuspended } from '../../email/admission.ts';
import {
  emailDomainRoutes,
  emailOperations,
  emailZoneConnections,
} from '../../email/connection-schema.ts';
import {
  addEmailDomainForProject,
  removeEmailDomainForProject,
  rotateEmailIngressSecretForProject,
} from '../../email/domain-service.ts';
import {
  DEFAULT_EMAIL_BURST_LIMIT as DEFAULT_BURST_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT as DEFAULT_MONTHLY_LIMIT,
  parseEmailLimitInput,
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
import { runEmailDestinationCleanup } from '../../provisioning/email-destination-cleanup.ts';
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

/** The admin layout has no utility classes, so secondary text is inline. */
const META = 'font-size: 0.8rem; color: #666';

type AdminEmailOperationOutcome = {
  operationId?: string;
  operationStatus?: typeof emailOperations.$inferSelect.status | null;
  error?: string | null;
};

async function incompleteEmailOperationResponse(
  context: Context<ApiEnv>,
  projectId: string,
  label: string,
  outcome: AdminEmailOperationOutcome,
): Promise<Response> {
  const status = outcome.operationStatus ?? 'pending';
  return context.html(
    <Layout title={label} username={context.get('user').login}>
      <h1>
        {label} {status}
      </h1>
      <p>{outcome.error ?? 'The operation has not completed. Check its status before retrying.'}</p>
      <p>
        Operation ID: <code>{outcome.operationId ?? 'unavailable'}</code>
      </p>
      <a href={`/admin/email/${projectId}`}>Back to email settings</a>
    </Layout>,
    status === 'blocked' || status === 'unknown' ? 409 : 202,
  );
}

// GET /email/ — installation-wide recipient policy and domain management
app.get('/', async (context) => {
  const db = context.get('db');
  // Refresh the best-effort display mirror before showing the authoritative SQL policy.
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
  const [usageRows, controls, destinations, domainRows] = await Promise.all([
    context
      .get('db')
      .select({
        attempts: emailMonthlyUsage.recipient_attempts,
        received: emailMonthlyUsage.inbound_receipts,
      })
      .from(emailMonthlyUsage)
      .where(
        sql`${emailMonthlyUsage.project_id} = ${projectId} AND ${emailMonthlyUsage.month} = ${month}`,
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
      })
      .from(emailDomainRoutes)
      .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
      .where(eq(emailDomainRoutes.project_id, projectId))
      .orderBy(asc(emailDomainRoutes.created_at)),
  ]);
  const attempts = usageRows[0]?.attempts ?? 0;
  const received = usageRows[0]?.received ?? 0;
  const latestOperations = domainRows.length
    ? await context
        .get('db')
        .select({
          id: emailOperations.id,
          routeId: emailOperations.route_id,
          connectionId: emailOperations.connection_id,
          status: emailOperations.status,
        })
        .from(emailOperations)
        .where(
          inArray(
            emailOperations.connection_id,
            domainRows.map(({ connection }) => connection.id),
          ),
        )
        .orderBy(desc(emailOperations.created_at))
    : [];

  // Distinguish an override from the default in the project controls row.
  const control = controls[0];
  const monthlyLimit =
    control && control.monthly_limit !== DEFAULT_MONTHLY_LIMIT ? control.monthly_limit : undefined;
  const burstLimit =
    control && control.burst_limit !== DEFAULT_BURST_LIMIT ? control.burst_limit : undefined;
  const isSuspended = Boolean(control?.suspended_at);
  const domains = domainRows.map(({ route, connection }) => ({
    id: route.id,
    domain: route.domain,
    inbound: route.inbound_status,
    inboundReason: route.inbound_reason,
    outbound: route.outbound_status,
    outboundReason: route.outbound_reason,
    management: connection.management_status,
    managementReason: connection.management_reason,
    managed_by: route.managed_by,
    relay_worker_name: connection.ingress_worker_name,
    relay_version: connection.ingress_version,
    operation: latestOperations.find(
      (operation) =>
        operation.routeId === route.id ||
        (operation.routeId === null && operation.connectionId === connection.id),
    ),
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
            <th>Outbound recipient attempts</th>
            <td>
              {attempts} / {monthlyLimit ?? DEFAULT_MONTHLY_LIMIT}{' '}
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
          Suspending stops new outbound attempts and rejects new inbound messages with a permanent
          SMTP error. Outbound submissions that already started may still finish. There is no
          per-direction switch.
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
              <th>Inbound</th>
              <th>Outbound</th>
              <th>Management</th>
              <th>Managed by</th>
              <th>Ingress worker</th>
              <th>v</th>
              <th>Latest operation</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td>{domain.domain}</td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.inbound)}`}>
                    {domain.inbound}
                  </span>
                  {domain.inboundReason && <small> — {domain.inboundReason}</small>}
                </td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.outbound)}`}>
                    {domain.outbound}
                  </span>
                  {domain.outboundReason && <small> — {domain.outboundReason}</small>}
                </td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.management)}`}>
                    {domain.management}
                  </span>
                  {domain.managementReason && <small> — {domain.managementReason}</small>}
                </td>
                <td>{domain.managed_by}</td>
                <td>{domain.relay_worker_name ?? '-'}</td>
                <td>{domain.relay_version ?? '-'}</td>
                <td>
                  {domain.operation ? (
                    <>
                      <code>{domain.operation.id}</code> ({domain.operation.status})
                    </>
                  ) : (
                    '-'
                  )}
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
      const outcome = (await res.json()) as AdminEmailOperationOutcome;
      if (outcome.operationStatus !== 'completed') {
        return {
          response: await incompleteEmailOperationResponse(
            context,
            projectId,
            `Adding ${domain}`,
            outcome,
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
  if (desired !== 'suspended' && desired !== 'active') {
    return context.html('<h1>Invalid state</h1><p>Expected "suspended" or "active".</p>', 400);
  }
  const suspended = desired === 'suspended';
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/projects/${projectId}/suspend`, { suspended }),
    async () => {
      await setProjectEmailSuspended(context.get('db'), projectId, suspended);
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
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
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/projects/${projectId}/destinations/${destinationId}/remove`),
    async () => {
      const cleanupTag = await deleteEmailDestination(context.get('db'), destination.id);
      if (cleanupTag) {
        await runEmailDestinationCleanup(
          context.get('db'),
          { accountId: context.env.CF_ACCOUNT_ID, apiToken: context.env.CF_API_TOKEN },
          cleanupTag,
        );
      }
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
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
  const domain = context.req.param('domain');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/domains/${domain}/remove`, { force: false }),
    async () => {
      const result = await removeEmailDomainForProject(context, project, domain, 'admin');
      if (!result.ok) {
        return {
          response: await context.html(
            '<h1>Email domain removal failed</h1>',
            result.status as 400,
          ),
          succeeded: false,
        };
      }
      const outcome = (await result.json()) as AdminEmailOperationOutcome;
      if (outcome.operationStatus !== 'completed') {
        return {
          response: await incompleteEmailOperationResponse(
            context,
            projectId,
            'Email domain removal',
            outcome,
          ),
          succeeded: false,
        };
      }
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
});

app.post('/:projectId/domains/:domain/rotate-secret', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const domain = context.req.param('domain');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/domains/${domain}/rotate-secret`),
    async () => {
      const result = await rotateEmailIngressSecretForProject(context, project, domain, 'admin');
      if (!result.ok) {
        return {
          response: await context.html(
            '<h1>Email ingress rotation failed</h1>',
            result.status as 400,
          ),
          succeeded: false,
        };
      }
      const outcome = (await result.json()) as AdminEmailOperationOutcome;
      if (outcome.operationStatus !== 'completed') {
        return {
          response: await incompleteEmailOperationResponse(
            context,
            projectId,
            'Email ingress rotation',
            outcome,
          ),
          succeeded: false,
        };
      }
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
});

/**
 * Shared body of the two limit forms. A blank submission clears the SQL
 * override so the project uses the platform default.
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
  const limit = raw === '' ? null : parseEmailLimitInput(raw);
  if (limit === undefined) {
    return context.html('<h1>Invalid limit</h1><p>Expected a positive integer, or blank.</p>', 400);
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/projects/${projectId}/limit`, {
      [kind]: limit === null ? 'default' : String(limit),
    }),
    async () => {
      await setProjectEmailLimits(context.get('db'), projectId, { [kind]: limit });
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
}

/** Domain readiness uses the shared status palette. */
function domainStatusColor(status: string): string {
  if (status === 'ready' || status === 'healthy') {
    return STATUS_COLORS.success;
  }
  if (status === 'pending' || status === 'verified_only' || status === 'probe_failed') {
    return STATUS_COLORS.pending;
  }
  return STATUS_COLORS.failed;
}

/** UTC `YYYY-MM` for the current usage window. */
function monthBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default app;
