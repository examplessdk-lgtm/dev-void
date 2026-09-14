import { Hono, type Context } from 'hono';
import {
  countProjectsUsingDestination,
  deleteEmailDestination,
  getEmailDestinationsByProjectId,
  getProject,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import {
  syncProjectAllowlistKv,
  syncProjectAllowlistKvBestEffort,
} from '../../provisioning/email-allowlist.ts';
import { deleteDestination } from '../../provisioning/email-routing.ts';
import { formatDateTime } from '../views/format.ts';
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
  const [sent, received, suspended, monthlyOverride, burstOverride, destinations] =
    await Promise.all([
      context.env.ROUTING.get(sentKey(projectId, month)),
      context.env.ROUTING.get(recvKey(projectId, month)),
      context.env.ROUTING.get(suspendKey(projectId)),
      context.env.ROUTING.get(monthlyLimitKey(projectId)),
      context.env.ROUTING.get(burstLimitKey(projectId)),
      getEmailDestinationsByProjectId(context.get('db'), projectId),
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
