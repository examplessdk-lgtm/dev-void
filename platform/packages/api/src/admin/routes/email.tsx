import { asc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import {
  countProjectsUsingDestination,
  deleteEmailDestination,
  getEmailDestinationsByProjectId,
  getProject,
} from '../../db.ts';
import {
  refreshOauthGrantSerialized,
  revokeOauthGrantSerialized,
  withEmailDomainRowLock,
} from '../../email/credential-lease.ts';
import { addEmailDomainForProject } from '../../email/domain-service.ts';
import {
  clearEmailDomainMirror,
  decryptEmailDomainRelaySecret,
  decryptEmailDomainToken,
  hashEmailRelaySecret,
  writeEmailDomainMirror,
} from '../../email/domains.ts';
import {
  DEFAULT_EMAIL_BURST_LIMIT as DEFAULT_BURST_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT as DEFAULT_MONTHLY_LIMIT,
  emailBurstLimitKey as burstLimitKey,
  emailMonthlyLimitKey as monthlyLimitKey,
  emailSuspendKey as suspendKey,
  parseEmailLimit as parseLimit,
} from '../../email/limits.ts';
import { removeEmailDomain } from '../../email/relay-engine.ts';
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
import { emailDomains } from '../../schema.ts';
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
  const [sent, received, suspended, monthlyOverride, burstOverride, destinations, domains] =
    await Promise.all([
      context.env.ROUTING.get(sentKey(projectId, month)),
      context.env.ROUTING.get(recvKey(projectId, month)),
      context.env.ROUTING.get(suspendKey(projectId)),
      context.env.ROUTING.get(monthlyLimitKey(projectId)),
      context.env.ROUTING.get(burstLimitKey(projectId)),
      getEmailDestinationsByProjectId(context.get('db'), projectId),
      context
        .get('db')
        .select()
        .from(emailDomains)
        .where(eq(emailDomains.project_id, projectId))
        .orderBy(asc(emailDomains.created_at)),
    ]);

  // Distinguish an override from the default so an operator can see at a
  // glance whether someone bumped a cap during a past incident — the
  // override keys are write-only otherwise.
  const monthlyLimit = parseLimit(monthlyOverride);
  const burstLimit = parseLimit(burstOverride);
  const isSuspended = suspended !== null;
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
              {parseCounter(sent)} / {monthlyLimit ?? DEFAULT_MONTHLY_LIMIT}{' '}
              <span style={META}>({monthlyLimit === undefined ? 'default' : 'override'})</span>
            </td>
          </tr>
          <tr>
            <th>Inbound (received)</th>
            <td>{parseCounter(received)}</td>
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
        Counters live in <code>ROUTING</code> KV and are written by the proxy worker. The monthly
        buckets expire shortly after the month ends; there is no historical series here.
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

      <h2>Danger Zone</h2>
      {/* Keep apostrophes out of the `onsubmit` text: oxfmt decodes `&apos;`
          back to a bare quote, which closes the handler's string literal. */}
      <form
        method="post"
        action={`/admin/email/${projectId}/reset-counter`}
        onsubmit="return confirm('Reset the outbound counter for this month? The project regains its full monthly quota and this cannot be undone.')"
        style="margin-top: 12px"
      >
        {/* The typed slug is the real confirmation: it is checked on the server,
            so the counter cannot be zeroed by a stray POST that never rendered
            (or ever ran) the browser dialog above. */}
        <input type="text" name="confirm" placeholder={project.slug} autocomplete="off" required />
        <button type="submit" class="danger">
          Reset {month} sent counter
        </button>{' '}
        <span style={META}>
          Type <code>{project.slug}</code> to confirm.
        </span>
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
        Sender/recipient domains on a Cloudflare zone, registered by the project owner through{' '}
        <code>void email domain add</code> or by an administrator below (the row then runs on the
        platform's own credential and the zone must be in the platform's account — paste a token for
        a zone elsewhere). Revoke clears the <code>email-domain:</code> ROUTING mirror FIRST — the
        proxy trusts only that key, and a failed clear keeps the row so the retry can finish — then
        deletes the relay worker and catch-all rule in the customer's account best-effort (a
        stranded relay is inert without the mirror entry) and drops the row. For{' '}
        <code>oauth_grant</code> rows, revoke grant is the lighter escape hatch: it kills just the
        customer's OAuth grant at Cloudflare and flips the row to <code>token_revoked</code>,
        leaving the row and mirror in place. The customer's credential and the relay secret are
        never shown here.
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
                  {/* Keep apostrophes out of the `onsubmit` text (see the Danger
                      Zone note above); the typed slug is the real confirmation
                      and is checked on the server. */}
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/domains/${domain.domain}/revoke`}
                    onsubmit="return confirm('Revoke &quot;' + this.dataset.domain + '&quot;? The mirror key and row are deleted; the relay worker and catch-all in the customer account are deleted best-effort.')"
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
                  {/* OAuth rows only: kill just the customer's grant (the row
                      and mirror stay). API tokens are the customer's own — the
                      route refuses those and points at dash.cloudflare.com. */}
                  {domain.credential_kind === 'oauth_grant' ? (
                    <form
                      method="post"
                      action={`/admin/email/${projectId}/domains/${domain.domain}/revoke-grant`}
                      onsubmit="return confirm('Revoke the OAuth grant for &quot;' + this.dataset.domain + '&quot;? The domain stops sending and receiving until the customer reconnects it. The row and mirror stay in place.')"
                      data-domain={domain.domain}
                      style="margin-top: 6px"
                    >
                      <button type="submit" class="danger-sm">
                        revoke grant
                      </button>
                    </form>
                  ) : null}
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
    await context.env.ROUTING.put(suspendKey(projectId), new Date().toISOString());
  } else if (desired === 'active') {
    await context.env.ROUTING.delete(suspendKey(projectId));
  } else {
    return context.html('<h1>Invalid state</h1><p>Expected "suspended" or "active".</p>', 400);
  }
  return context.redirect(`/admin/email/${projectId}`);
});

// POST /email/:projectId/limit — set (or clear) the monthly outbound override
app.post('/:projectId/limit', async (context) => {
  return setLimit(context, context.req.param('projectId'), monthlyLimitKey, 'limit');
});

// POST /email/:projectId/burst-limit — set (or clear) the per-minute override
app.post('/:projectId/burst-limit', async (context) => {
  return setLimit(context, context.req.param('projectId'), burstLimitKey, 'burstLimit');
});

// POST /email/:projectId/reset-counter — zero this month's outbound counter
app.post('/:projectId/reset-counter', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  if (body.confirm !== project.slug) {
    return context.html(
      `<h1>Not confirmed</h1><p>Type the project slug (<code>${project.slug}</code>) to reset the counter.</p>`,
      400,
    );
  }
  await context.env.ROUTING.delete(sentKey(projectId, monthBucket()));
  return context.redirect(`/admin/email/${projectId}`);
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

// POST /email/:projectId/domains/:domain/revoke — operator revoke of a custom
// email domain: clear the proxy's mirror key, best-effort CF cleanup in the
// customer's account via the relay engine, then the row. The owner-facing
// twin is DELETE /projects/:id/email/domains/:domain in `routes/email.ts`.
app.post('/:projectId/domains/:domain/revoke', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const domain = context.req.param('domain');
  const rows = await context
    .get('db')
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.project_id, projectId));
  const row = rows.find((r) => r.domain === domain);
  if (!row) {
    return context.html('<h1>Email domain not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  if (body.confirm !== project.slug) {
    return context.html(
      `<h1>Not confirmed</h1><p>Type the project slug (<code>${project.slug}</code>) to revoke ${row.domain}.</p>`,
      400,
    );
  }

  // Remove under the row's serialized lock, with the row and credential
  // re-read inside it — the same shape as the owner DELETE. A replace that
  // commits between the entry read and the cleanup must not have its fresh
  // credential orphaned by the row delete: the replace never invalidates an
  // old api_token, so cleanup built on a stale snapshot would SUCCEED and
  // a newly committed oauth grant's only handle would go with the row. The
  // lock also orders the mirror clear against a replacement sync's
  // republish (both hold the row lock across their KV write). The
  // serialized helpers take THIS tx — passing the pool handle would
  // deadlock against the held FOR UPDATE.
  const removal: Readonly<{ kind: 'removed' } | { kind: 'vanished' }> | null = await (async () => {
    try {
      return await withEmailDomainRowLock(context.get('db'), row.id, async (tx) => {
        const locked = await tx
          .select()
          .from(emailDomains)
          .where(eq(emailDomains.id, row.id))
          .limit(1);
        const current = locked[0];
        if (!current) {
          // Teardown's cascade can take the row mid-request — the
          // idempotent re-clear below proceeds.
          return { kind: 'vanished' } as const;
        }

        // Tighten BEFORE anything destructive — the same inversion as the
        // destination revoke above. The proxy trusts only the mirror key,
        // and the row is what a retry re-runs from: a KV failure here
        // throws, the transaction rolls back with the row intact, and the
        // operator's retry starts from nothing-happened.
        await clearEmailDomainMirror(context.env.ROUTING, current.domain);

        // Best-effort CF cleanup (relay script DELETE + catch-all reset);
        // removeEmailDomain never throws. A stranded relay or rule in the
        // customer's account is inert without the mirror entry, so neither
        // a CF failure nor a decrypt failure (a rotated-away key version)
        // may block the revoke — this log line is the trace an operator
        // gets, same as the CF deleteDestination failure above.
        try {
          const credential = await decryptEmailDomainToken(
            context.env,
            projectId,
            current.domain,
            current,
          );
          const { failed_steps } = await removeEmailDomain(
            {
              row: {
                credential_kind: current.credential_kind,
                account_id: current.account_id,
                relay_worker_name: current.relay_worker_name,
                zone_id: current.zone_id,
              },
              credential,
            },
            {
              // Same doctrine as the owner DELETE: rotations persist
              // through the row's serialized chain while it lives, and the
              // grant is revoked (last, with the rotated head) — the row
              // being deleted is the only place the rotated token exists,
              // so omitting revokeGrant here would orphan a live grant
              // with no platform handle.
              refreshGrant: () => refreshOauthGrantSerialized(tx, context.env, current.id),
              ...(current.credential_kind === 'oauth_grant'
                ? {
                    revokeGrant: () => revokeOauthGrantSerialized(tx, context.env, current.id),
                  }
                : {}),
            },
          );
          if (failed_steps.length > 0) {
            console.error('[admin-email] email-domain CF cleanup incomplete', {
              projectId,
              domain: current.domain,
              failedSteps: failed_steps,
            });
          }
        } catch (error) {
          console.error(
            '[admin-email] email-domain credential decrypt failed; skipping CF cleanup',
            {
              projectId,
              domain: current.domain,
              error,
            },
          );
        }

        await tx.delete(emailDomains).where(eq(emailDomains.id, current.id));
        return { kind: 'removed' } as const;
      });
    } catch (error) {
      console.error('[admin-email] email-domain mirror clear failed; keeping the row', {
        projectId,
        domain: row.domain,
        error,
      });
      return null;
    }
  })();

  if (removal === null) {
    return context.html('<h1>Failed to clear the domain mirror. Try again.</h1>', 503);
  }
  if (removal.kind === 'vanished') {
    // Teardown already cleared the mirror; the re-clear is idempotent.
    await clearEmailDomainMirror(context.env.ROUTING, row.domain);
  }
  return context.redirect(`/admin/email/${projectId}`);
});

// POST /email/:projectId/domains/:domain/revoke-grant — operator revocation
// of one domain's OAuth grant: the support escape hatch when a customer asks
// us to kill their grant without tearing the domain down. Mirror write, RFC
// 7009 against dash.cloudflare.com, and the row flip run as ONE
// row-serialized operation — the lock is the credential fence: a replace
// either commits first (the locked re-read revokes and marks the NEW grant,
// never the stale snapshot's, and a replacement sync's `active` republish
// orders strictly before the mirror tighten) or waits and sees
// token_revoked. Mirror stays first inside the section (the proxy's relay
// auth checks its `active` status, so inbound stops here); a failed revoke
// leaves the row active with the mirror flipped, and the next status GET
// repairs the mirror back (self-healing, same as any drift).
app.post('/:projectId/domains/:domain/revoke-grant', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const domain = context.req.param('domain');
  const rows = await context
    .get('db')
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.project_id, projectId));
  const row = rows.find((r) => r.domain === domain);
  if (!row) {
    return context.html('<h1>Email domain not found</h1>', 404);
  }

  type RevokeGrantOutcome =
    | 'revoked'
    | 'gone'
    | 'not_oauth'
    | 'decrypt_failed'
    | 'mirror_failed'
    | 'revoke_failed';
  const outcome: RevokeGrantOutcome = await withEmailDomainRowLock(
    context.get('db'),
    row.id,
    async (tx): Promise<RevokeGrantOutcome> => {
      const locked = await tx
        .select()
        .from(emailDomains)
        .where(eq(emailDomains.id, row.id))
        .limit(1);
      const current = locked[0];
      if (!current) {
        // Teardown's cascade took the row mid-request.
        return 'gone';
      }
      if (current.credential_kind !== 'oauth_grant') {
        // A replace committed an api_token first (and revoked the old
        // grant itself) — there is no platform-side grant left to revoke.
        return 'not_oauth';
      }
      let relaySecretSha256: string;
      try {
        relaySecretSha256 = await hashEmailRelaySecret(
          await decryptEmailDomainRelaySecret(context.env, projectId, current.domain, current),
        );
      } catch (error) {
        // No status change: without the relay secret the mirror cannot be
        // tightened safely, so there is nothing to base the revoke on
        // either.
        console.error('[admin-email] grant revoke failed to decrypt the stored relay secret', {
          projectId,
          domain: current.domain,
          error,
        });
        return 'decrypt_failed';
      }
      // Mirror BEFORE the revoke — the same inversion as the removal
      // route. A failed write rolls back with nothing else written.
      try {
        await writeEmailDomainMirror(
          context.env.ROUTING,
          { ...current, status: 'token_revoked' },
          relaySecretSha256,
        );
      } catch (error) {
        console.error('[admin-email] grant revoke failed to tighten the mirror', {
          projectId,
          domain: current.domain,
          error,
        });
        return 'mirror_failed';
      }
      try {
        // The row's LIVE chain head, under the same lock: a token
        // decrypted beforehand could already be consumed by an
        // interleaved lease refresh, and CF answers 200 for a consumed
        // token whether or not the grant survived.
        await revokeOauthGrantSerialized(tx, context.env, current.id);
      } catch (error) {
        // Network/non-2xx — the grant's state is unknown, so the row keeps
        // its status and the operator retries. The mirror already flipped
        // (KV is not transactional); the next status GET repairs it while
        // the row stays active.
        console.error('[admin-email] grant revoke request failed', {
          projectId,
          domain: current.domain,
          error,
        });
        return 'revoke_failed';
      }
      await tx
        .update(emailDomains)
        .set({ status: 'token_revoked', updated_at: sql`now()` })
        .where(eq(emailDomains.id, current.id));
      return 'revoked';
    },
  );

  if (outcome === 'gone') {
    return context.html('<h1>Email domain not found</h1>', 404);
  }
  if (outcome === 'not_oauth') {
    return context.html(
      '<h1>Not an OAuth grant</h1><p>API tokens are revoked by the customer at dash.cloudflare.com; there is no platform-side grant to revoke.</p>',
      400,
    );
  }
  if (outcome === 'decrypt_failed') {
    return context.html(
      '<h1>Failed to decrypt the stored relay secret</h1><p>The grant cannot be revoked from here; the row keeps its current status.</p>',
      500,
    );
  }
  if (outcome === 'mirror_failed') {
    return context.html('<h1>Failed to tighten the domain mirror. Try again.</h1>', 503);
  }
  if (outcome === 'revoke_failed') {
    return context.html('<h1>Failed to revoke the grant at Cloudflare. Try again.</h1>', 502);
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
  key: (projectId: string) => string,
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
    await context.env.ROUTING.delete(key(projectId));
    return context.redirect(`/admin/email/${projectId}`);
  }
  const limit = parseLimit(raw);
  if (limit === undefined) {
    return context.html('<h1>Invalid limit</h1><p>Expected a positive integer, or blank.</p>', 400);
  }
  await context.env.ROUTING.put(key(projectId), String(limit));
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
