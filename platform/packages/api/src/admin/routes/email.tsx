import { asc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  countProjectsUsingDestination,
  deleteEmailDestination,
  getEmailDestinationsByProjectId,
  getProject,
} from '../../db.ts';
import { revokeOauthGrant } from '../../email/cf-customer.ts';
import { clearEmailDomainMirror, decryptEmailDomainToken } from '../../email/domains.ts';
import { removeEmailDomain } from '../../email/relay-engine.ts';
import type { ApiEnv } from '../../env.ts';
import {
  syncProjectAllowlistKv,
  syncProjectAllowlistKvBestEffort,
} from '../../provisioning/email-allowlist.ts';
import { deleteDestination } from '../../provisioning/email-routing.ts';
import { emailDomains } from '../../schema.ts';
import { STATUS_COLORS, formatDateTime } from '../views/format.ts';
import { Layout } from '../views/layout.tsx';

const app = new Hono<ApiEnv>();

/**
 * Per-project email control plane for operators.
 *
 * Every number on this page is read straight out of `ROUTING` KV, which is
 * where the proxy worker (`packages/proxy/src/email.ts`) keeps the counters
 * and reads the caps from. The keys and the defaults below MUST stay in
 * lockstep with that worker — they are the same contract written from both
 * ends, and nothing at build time catches a drift.
 *
 * The destination and custom-domain rows are Postgres. The proxy's only
 * view of a custom domain is the `email-domain:` ROUTING mirror, so the
 * revoke below clears that key before the row.
 */
const suspendKey = (projectId: string) => `email-suspended:${projectId}`;
const monthlyLimitKey = (projectId: string) => `email-limit:${projectId}`;
const burstLimitKey = (projectId: string) => `email-burst-limit:${projectId}`;
const sentKey = (projectId: string, month: string) => `email-sent:${projectId}:${month}`;
const recvKey = (projectId: string, month: string) => `email-recv:${projectId}:${month}`;

/** Mirrors `getMonthlyLimit` in `packages/proxy/src/email.ts`. */
const DEFAULT_MONTHLY_LIMIT = 200;
/** Mirrors `getBurstLimit` in `packages/proxy/src/email.ts`. */
const DEFAULT_BURST_LIMIT = 10;

/** The admin layout has no utility classes, so secondary text is inline. */
const META = 'font-size: 0.8rem; color: #666';

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
        Sender/recipient domains on the customer's own Cloudflare zone, registered by the project
        owner through <code>POST /projects/:id/email/domains</code>. Revoke clears the{' '}
        <code>email-domain:</code> ROUTING mirror FIRST — the proxy trusts only that key, and a
        failed clear keeps the row so the retry can finish — then deletes the relay worker and
        catch-all rule in the customer's account best-effort (a stranded relay is inert without the
        mirror entry) and drops the row. For <code>oauth_grant</code> rows, revoke grant is the
        lighter escape hatch: it kills just the customer's OAuth grant at Cloudflare and flips the
        row to <code>token_revoked</code>, leaving the row and mirror in place. The customer's
        credential and the relay secret are never shown here.
      </p>
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

  // Tighten BEFORE anything destructive — the same inversion as the
  // destination revoke above. The proxy trusts only the mirror key, and the
  // row is what a retry re-runs from, so a failed clear keeps the row and
  // nothing else has happened yet.
  try {
    await clearEmailDomainMirror(context.env.ROUTING, row.domain);
  } catch (error) {
    console.error('[admin-email] email-domain mirror clear failed; keeping the row', {
      projectId,
      domain: row.domain,
      error,
    });
    return context.html('<h1>Failed to clear the domain mirror. Try again.</h1>', 503);
  }

  // Best-effort CF cleanup (relay script DELETE + catch-all reset);
  // removeEmailDomain never throws. A stranded relay or rule in the
  // customer's account is inert without the mirror entry, so neither a CF
  // failure nor a decrypt failure (a rotated-away key version) may block the
  // revoke — this log line is the trace an operator gets, same as the CF
  // deleteDestination failure above.
  try {
    const credential = await decryptEmailDomainToken(context.env, projectId, row.domain, row);
    const { failed_steps } = await removeEmailDomain({
      row: {
        credential_kind: row.credential_kind,
        account_id: row.account_id,
        relay_worker_name: row.relay_worker_name,
        zone_id: row.zone_id,
      },
      credential,
    });
    if (failed_steps.length > 0) {
      console.error('[admin-email] email-domain CF cleanup incomplete', {
        projectId,
        domain: row.domain,
        failedSteps: failed_steps,
      });
    }
  } catch (error) {
    console.error('[admin-email] email-domain credential decrypt failed; skipping CF cleanup', {
      projectId,
      domain: row.domain,
      error,
    });
  }

  await context.get('db').delete(emailDomains).where(eq(emailDomains.id, row.id));
  return context.redirect(`/admin/email/${projectId}`);
});

// POST /email/:projectId/domains/:domain/revoke-grant — operator revocation
// of one domain's OAuth grant: the support escape hatch when a customer asks
// us to kill their grant without tearing the domain down. RFC 7009 against
// dash.cloudflare.com, then the row flips to 'token_revoked'. The proxy's
// `email-domain:` mirror keeps the old status until the next status-GET
// repair or sync — accepted for an operator tool.
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
  if (row.credential_kind !== 'oauth_grant') {
    return context.html(
      '<h1>Not an OAuth grant</h1><p>API tokens are revoked by the customer at dash.cloudflare.com; there is no platform-side grant to revoke.</p>',
      400,
    );
  }
  let refreshToken: string;
  try {
    refreshToken = await decryptEmailDomainToken(context.env, projectId, row.domain, row);
  } catch (error) {
    // No status change: without the credential there is nothing to revoke.
    console.error('[admin-email] grant revoke failed to decrypt the stored credential', {
      projectId,
      domain: row.domain,
      error,
    });
    return context.html(
      '<h1>Failed to decrypt the stored credential</h1><p>The grant cannot be revoked from here; the row keeps its current status.</p>',
      500,
    );
  }
  // Never throws; RFC 7009 answers 200 whether the token was live or already
  // dead, so the status flip is safe either way.
  await revokeOauthGrant(refreshToken);
  await context
    .get('db')
    .update(emailDomains)
    .set({ status: 'token_revoked', updated_at: sql`now()` })
    .where(eq(emailDomains.id, row.id));
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

/**
 * Undefined means "no usable override" — either the key is absent or it holds
 * a value the proxy would itself reject, in which case the proxy is already
 * serving the default and this page must say so too.
 */
function parseLimit(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default app;
