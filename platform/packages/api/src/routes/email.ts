import { Hono } from 'hono';
import type { Context } from 'hono';
import { signConfirmToken, type ConfirmTokenPayload } from '../auth/confirm-token.ts';
import {
  countProjectsUsingDestination,
  deleteEmailDestination,
  getEmailDestinationByAddress,
  getEmailDestinationsByProjectId,
  getProject,
  getUser,
  tryCreateEmailDestination,
  updateEmailDestinationStatus,
  type Db,
  type OwnerVerificationAudit,
} from '../db.ts';
import { sendPlatformVerificationEmail } from '../email/send-verification.ts';
import type { ApiEnv } from '../env.ts';
import {
  projectAllowlistKvDiffers,
  syncProjectAllowlistKv,
  syncProjectAllowlistKvBestEffort,
} from '../provisioning/email-allowlist.ts';
import {
  addDestination,
  deleteDestination,
  isAlreadyExistsError,
  listDestinations,
  type CfDestinationAddress,
} from '../provisioning/email-routing.ts';
import type { EmailDestination } from '../types.ts';

/**
 * Per-project rate-limit on POST /destinations to prevent abuse where a
 * project owner could spam an arbitrary recipient with platform-side
 * verification emails. Two windows so a sustained attacker can't pace
 * around the burst cap:
 *   - 5 requests / minute (TTL 5m)
 *   - 50 requests / day   (TTL 25h)
 *
 * Counters live in ROUTING KV (same namespace as the email-* counters)
 * with poisoning defense identical to the proxy's send counter:
 * `parseInt('NaN', 10) → NaN` would silently bypass `count >= LIMIT` if
 * not coerced, so any non-finite or negative read becomes 0.
 */
const ADD_RATE_PER_MINUTE = 5;
const ADD_RATE_PER_DAY = 50;

/**
 * Email observability + destinations management.
 *
 * Counters live in `ROUTING` KV under monthly buckets — exposed via the
 * `/usage` endpoint. Recipient destinations live in the `email_destinations`
 * Postgres table; the `/destinations` endpoints proxy CF Email Routing's
 * account-level address API and keep our per-project view in sync.
 */
const app = new Hono<ApiEnv>()
  .get('/:id/email/usage', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const month = monthBucket();
    const [sent, recv, suspended, limitOverride] = await Promise.all([
      context.env.ROUTING.get(`email-sent:${projectId}:${month}`),
      context.env.ROUTING.get(`email-recv:${projectId}:${month}`),
      context.env.ROUTING.get(`email-suspended:${projectId}`),
      context.env.ROUTING.get(`email-limit:${projectId}`),
    ]);

    const limit = parseLimit(limitOverride) ?? 200;
    const sentCount = parseCounter(sent);
    const recvCount = parseCounter(recv);

    return context.json({
      month,
      sent: sentCount,
      received: recvCount,
      limit,
      remaining: Math.max(0, limit - sentCount),
      suspended: suspended !== null,
    });
  })

  .get('/:id/email/logs', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    // Log entries currently live only in worker `console.log` output —
    // surfaced via the existing tail/observability pipeline. This endpoint
    // returns an empty list with a marker so consumers know AE-backed logs
    // aren't wired yet.
    return context.json({
      logs: [],
      pending: true,
      note: 'Persistent log storage lands when Analytics Engine queries are wired.',
    });
  })

  // -------------------------------------------------------------------------
  // Destinations: per-project verified recipient addresses for outbound mail
  // via the shared platform sender (`EMAIL_SENDER_DOMAIN`, per environment).
  // CF Email Routing is the source of truth for verification status; the
  // platform adds a per-project allowlist on top so projects only see /
  // send to addresses they declared.
  // -------------------------------------------------------------------------
  .get('/:id/email/destinations', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const rows = await getEmailDestinationsByProjectId(context.get('db'), projectId);
    // Refresh status from CF for any rows still pending. CF's
    // listDestinations is account-level; we filter to the rows we care about.
    //
    // Platform-pending rows (verification_source='platform') are
    // intentionally excluded from CF refresh: CF already shows them as
    // verified (a different project verified them), but we issued our
    // own per-project confirmation link and the row stays pending until
    // THAT link is clicked. Refreshing from CF here would defeat the
    // platform-side verification gate (Option B in the email design doc).
    const pending = rows.filter(
      (r) => r.status === 'pending' && r.verification_source !== 'platform',
    );
    let anyFlipped = false;
    if (pending.length > 0) {
      try {
        const cfRows = await listDestinations(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN);
        const byEmail = new Map<string, CfDestinationAddress>();
        for (const cf of cfRows) {
          byEmail.set(cf.email.toLowerCase(), cf);
        }
        for (const row of pending) {
          const cf = byEmail.get(row.address);
          if (cf?.verified) {
            await updateEmailDestinationStatus(
              context.get('db'),
              row.id,
              'verified',
              cf.tag,
              cf.verified,
            );
            row.status = 'verified';
            row.cf_destination_id = cf.tag;
            row.verified_at = cf.verified;
            anyFlipped = true;
          }
        }
      } catch (err) {
        console.error('[email] destinations refresh failed:', err);
        // Non-fatal — we still return the cached view.
      }
    }
    // Push any newly-verified address into the proxy's allowlist KV, and
    // repair the mirror whenever it has drifted from the verified rows.
    //
    // The repair is not belt-and-braces. Every write to this mirror is
    // best-effort, and nothing else re-derives the key: the confirm route
    // early-returns on an already-verified row, the hourly `scheduled()`
    // backfill in `index.ts` touches only `email-slug:`, and no deploy hook
    // calls the sync. One swallowed KV failure after Postgres committed
    // `verified` therefore leaves the owner looking at a `verified` listing
    // while the proxy — which reads a missing key as deny-all — rejects every
    // send as an unverified destination, with no user-visible cause. So THIS
    // listing is the repair: the same read-compare-write self-heal shape as
    // the `email-slug:` backfill. Cost is one KV read (skipped entirely when
    // a flip already forces the write); the write happens only on a real
    // difference, never on every listing.
    if (
      anyFlipped ||
      (await projectAllowlistKvDiffers(context.get('db'), context.env.ROUTING, projectId))
    ) {
      await syncProjectAllowlistKvBestEffort(context.get('db'), context.env.ROUTING, projectId);
    }

    return context.json(rows.map(serializeDestination));
  })

  .post('/:id/email/destinations', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    // Same guard the other provisioning routes use (see `routes/projects.ts`).
    // Teardown snapshots the CF destination tags it must clean up ONCE; a
    // destination registered after that snapshot but before the cascade drops
    // our rows leaves an account-level CF address no row points at any more.
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    // Malformed JSON is user input, not a server fault — 400 it here rather
    // than letting the throw reach the app-level `onError` 500 (same shape
    // the secrets/domains routes use).
    let body: { address?: unknown } = {};
    try {
      body = await context.req.json<{ address?: unknown }>();
    } catch {
      return context.json({ error: 'invalid address' }, 400);
    }
    const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
    if (!isValidEmail(address)) {
      return context.json({ error: 'invalid address' }, 400);
    }

    // Per-project rate-limit BEFORE calling CF. Counters use the
    // NaN-poison-resistant reader; reads are not strongly consistent so
    // the gate is approximate, but at our planned volumes that's fine.
    const rateCheck = await checkAndIncrementAddRate(context.env.ROUTING, projectId);
    if (!rateCheck.allowed) {
      return context.json({ error: rateCheck.message }, 429);
    }

    const existing = await getEmailDestinationByAddress(context.get('db'), projectId, address);
    if (existing) {
      // A platform-pending row waits on OUR link (Option B below), which is
      // best-effort and expires in 24h — so a repeat POST is the resend, and
      // the only one a project owner has. The rate check above already
      // bounds it. A CF-pending row is not resendable: CF mails its own link
      // on create only, and the row flips via the GET refresh when clicked.
      if (existing.status === 'pending' && existing.verification_source === 'platform') {
        await dispatchPlatformVerification(context, project, existing, address);
        return context.json(
          { ...serializeDestination(existing), platformVerificationPending: true },
          200,
        );
      }
      return context.json(serializeDestination(existing), 200);
    }

    // Create CF destination; CF responds with the tag and triggers the
    // verification email. If the address already exists on the CF account
    // (e.g. another project already registered it, or this is a same-
    // request race), narrowly handle the "already exists" error by
    // listing + reusing the existing record so we don't spam users with
    // duplicate verification emails and don't fail their request.
    // Other errors (auth, network, CF outage) are surfaced as 502.
    let cfRow: CfDestinationAddress;
    // `cfRow.verified` cannot distinguish a row CF just created for THIS
    // request from a row that was already on the account and nobody has
    // clicked yet — both report `null`. Only the recovery path below knows
    // which one we are holding, so it records that here.
    let recoveredExistingCfRow = false;
    try {
      cfRow = await addDestination(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN, address);
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        console.error('[email] addDestination failed:', err);
        return context.json({ error: 'failed to register destination' }, 502);
      }
      try {
        const all = await listDestinations(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN);
        const found = all.find((r) => r.email.toLowerCase() === address);
        if (!found) {
          console.error('[email] addDestination reported exists but list missed it:', err);
          return context.json({ error: 'failed to register destination' }, 502);
        }
        cfRow = found;
        recoveredExistingCfRow = true;
      } catch (innerErr) {
        console.error('[email] addDestination recovery failed:', innerErr);
        return context.json({ error: 'failed to register destination' }, 502);
      }
    }

    // C+B: when CF reports the address already verified, decide whether
    // to inherit that verification or issue our own platform-side check.
    //   Option C (owner-relaxed): the project owner's own email — trust
    //   CF. Most common case for second-and-later projects of the same
    //   user.
    //   Option B (everyone else): a different person/project verified
    //   it on CF. We cannot trust CF's verified flag for per-project
    //   consent, so we issue our own confirmation link and keep the row
    //   'pending' / 'platform' until the recipient clicks it.
    const owner = await getUser(context.get('db'), project.user_id);
    const ownerEmail = owner?.email?.toLowerCase() ?? null;
    const ownerMatches = !!ownerEmail && ownerEmail === address;
    const cfVerified = !!cfRow.verified;

    if (cfVerified && ownerMatches) {
      // Option C — owner-relaxed CF reuse. Persist who consented + the
      // email snapshot so we can revoke if the owner's identity later
      // changes (see `revokeOwnerVerifiedDestinationsForUserChange`).
      const ownerAudit: OwnerVerificationAudit = {
        userId: project.user_id,
        emailSnapshot: ownerEmail!,
      };
      const inserted = await tryInsertWithRetry(
        context.get('db'),
        projectId,
        address,
        cfRow.tag,
        'verified',
        cfRow.verified ?? null,
        'cf',
        ownerAudit,
      );
      if (!inserted.row) {
        // Either a sibling DELETE ate the row mid-INSERT-then-SELECT twice,
        // or project teardown's cascade landed between the `status` guard
        // above and the INSERT. Neither persisted the CF tag we just
        // registered, so roll it back rather than leaking an account-level
        // address, then surface a clean retryable error.
        await rollbackCfDestination(context, projectId, address, cfRow.tag);
        return context.json({ error: 'destination concurrently modified, try again' }, 409);
      }
      const { row } = inserted;
      if (row.status === 'verified') {
        await syncProjectAllowlistKvBestEffort(context.get('db'), context.env.ROUTING, projectId);
      }
      return context.json(serializeDestination(row), 201);
    }

    if (!ownerMatches && (cfVerified || recoveredExistingCfRow)) {
      // Option B — platform-side verification required. It is required
      // whenever the Cloudflare-side click is not ours to claim:
      //   - the row was already VERIFIED by someone else, or
      //   - the row was already on the account and still pending, meaning
      //     CF mailed the recipient for the OTHER project and will not mail
      //     again for this one (it refused our create).
      // Either way, nothing CF does can express consent for THIS project, so
      // our own link is the only one that can.
      //
      // Accepted cost: this creates a state where our row is `verified`
      // while the CF account row is still pending — the recipient clicked
      // OUR link, not CF's. The send then fails at the `send_email` binding,
      // and `packages/proxy/src/email.ts` classifies that CF error as
      // `UNVERIFIED_DESTINATION`, which the framework reports as "verify the
      // address first". It fails safe, and it self-heals the moment the
      // recipient clicks CF's link. No machinery for it.
      const inserted = await tryInsertWithRetry(
        context.get('db'),
        projectId,
        address,
        cfRow.tag,
        'pending',
        null,
        'platform',
      );
      if (!inserted.row) {
        await rollbackCfDestination(context, projectId, address, cfRow.tag);
        return context.json({ error: 'destination concurrently modified, try again' }, 409);
      }
      const { row } = inserted;
      // Only fire a fresh confirmation email when WE inserted the row.
      // A sibling concurrent POST that races to the unique constraint
      // gets `inserted=false` and reads back the winner's row — without
      // this gate it would also dispatch a platform email, doubling
      // recipient mail per race.
      if (inserted.inserted && row.status === 'pending' && row.verification_source === 'platform') {
        await dispatchPlatformVerification(context, project, row, address);
      }
      return context.json({ ...serializeDestination(row), platformVerificationPending: true }, 201);
    }

    // CF created the row for THIS request (or the address is the owner's
    // own) — normal flow: insert pending, CF is mailing the recipient right
    // now, and the GET refresh flips the row to verified when they click.
    const inserted = await tryInsertWithRetry(
      context.get('db'),
      projectId,
      address,
      cfRow.tag,
      'pending',
      null,
      'cf',
    );
    if (!inserted.row) {
      await rollbackCfDestination(context, projectId, address, cfRow.tag);
      return context.json({ error: 'destination concurrently modified, try again' }, 409);
    }
    return context.json(serializeDestination(inserted.row), 201);
  })

  .delete('/:id/email/destinations/:destId', async (context) => {
    const projectId = context.req.param('id');
    const destId = context.req.param('destId');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    const rows = await getEmailDestinationsByProjectId(context.get('db'), projectId);
    const dest = rows.find((r) => r.id === destId);
    if (!dest) {
      return context.json({ error: 'destination not found' }, 404);
    }

    // Tighten the KV mirror BEFORE anything destructive runs. The proxy
    // enforces every send against `email-allowlist:<projectId>`, and this row
    // is what a retry would re-derive that mirror from — delete the row first
    // and a failed KV write strands the revoked address in the allowlist with
    // nothing left to repair it from, so a revoked recipient keeps receiving
    // mail. (Same inversion as unretain-before-cleanup: never destroy the
    // record the retry needs.) The sync must EXCLUDE this row explicitly:
    // it is still `verified` in Postgres at this point, so a plain re-sync
    // would write the address straight back.
    if (dest.status === 'verified') {
      try {
        await syncProjectAllowlistKv(context.get('db'), context.env.ROUTING, projectId, {
          excludeDestinationId: dest.id,
        });
      } catch (err) {
        console.error('[email] allowlist tighten failed; keeping destination row:', err);
        return context.json({ error: 'failed to update send allowlist; try again' }, 503);
      }
    }

    // Best-effort CF cleanup. Only delete from CF if no other project
    // references the same destination tag — destinations are account-wide.
    if (dest.cf_destination_id) {
      const refs = await countProjectsUsingDestination(context.get('db'), dest.cf_destination_id);
      if (refs <= 1) {
        try {
          await deleteDestination(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            dest.cf_destination_id,
          );
        } catch (err) {
          // Non-fatal — proceed with DB delete; orphaned CF rows can be
          // cleaned up later via a sweep.
          console.error('[email] CF deleteDestination failed:', err);
        }
      }
    }

    await deleteEmailDestination(context.get('db'), dest.id);
    return context.json({ ok: true });
  });

function monthBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseCounter(raw: string | null): number {
  if (!raw) {
    return 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Loose RFC 5322 sanity check. Defers real validation to CF Email
 * Routing — we just want to keep obviously-bad input out of the rate
 * limiter / CF API call. Exported so the admin route can share the
 * same regex without duplicating it.
 */
export function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

function serializeDestination(row: EmailDestination) {
  return {
    id: row.id,
    address: row.address,
    status: row.status,
    verified_at: row.verified_at,
    verification_source: row.verification_source,
    created_at: row.created_at,
  };
}

/**
 * Mint a fresh 24h confirmation token for a platform-pending row and mail
 * the link (Option B). Shared by the first insert and the repeat-POST
 * resend; the token is single-use by ROW state, so an earlier unexpired
 * link stays valid and a second click is idempotent.
 */
async function dispatchPlatformVerification(
  context: Context<ApiEnv>,
  project: { id: string; slug: string },
  row: EmailDestination,
  address: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload: ConfirmTokenPayload = {
    v: 1,
    pid: project.id,
    did: row.id,
    addr: address,
    iat: now,
    exp: now + 24 * 60 * 60,
  };
  const token = await signConfirmToken(tokenPayload, context.env.JWT_SECRET);
  const sendPromise = sendPlatformVerificationEmail(
    context.env,
    { id: project.id, slug: project.slug },
    address,
    token,
  );
  // Same shape the rest of the api uses for post-response work: the
  // call STARTS synchronously so it cannot be skipped, and a test
  // harness that invoked `app.request` without an ExecutionContext
  // falls back to an inline await so the send still happens.
  // `sendPlatformVerificationEmail` logs and swallows delivery
  // failures itself — the only thing that escapes it is a missing
  // `EMAIL_SENDER_DOMAIN`, which is a deploy-time misconfiguration
  // and is deliberately left loud.
  try {
    context.executionCtx.waitUntil(sendPromise);
  } catch {
    await sendPromise;
  }
}

/**
 * Insert + retry-on-race wrapper around `tryCreateEmailDestination`.
 *
 * The underlying helper returns `{ row: null }` only when:
 *   1. Our INSERT lost the ON CONFLICT race AND
 *   2. The winning row was DELETED before our follow-up SELECT could
 *      read it back.
 *
 * That's a real, observable race (sibling tab issuing a DELETE while
 * we're processing a duplicate POST). One retry with a fresh insert+
 * select almost always wins — if it still misses, the caller surfaces
 * a clean 409 to the user with a "concurrently modified, try again"
 * message rather than a generic 500. The caller rolls the CF tag back.
 *
 * A foreign-key violation reports the same "not inserted" outcome: see
 * the catch below.
 */
async function tryInsertWithRetry(
  db: Db,
  projectId: string,
  address: string,
  cfDestinationId: string | null,
  status: EmailDestination['status'],
  verifiedAt: string | null,
  verificationSource: EmailDestination['verification_source'],
  ownerAudit?: OwnerVerificationAudit,
): Promise<{ row: EmailDestination | null; inserted: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: { row: EmailDestination | null; inserted: boolean };
    try {
      result = await tryCreateEmailDestination(
        db,
        projectId,
        address,
        cfDestinationId,
        status,
        verifiedAt,
        verificationSource,
        ownerAudit,
      );
    } catch (err) {
      if (!isForeignKeyViolation(err)) {
        throw err;
      }
      // Project teardown committed its cascade between the route's
      // `status === 'deleting'` guard (an unlocked read) and this INSERT, so
      // `email_destinations.project_id` has no project row left to point at.
      // Retrying cannot help — the project is gone for good. Report the same
      // "not inserted" shape as the row-deleted race so the caller rolls the
      // CF destination back (`rollbackCfDestination`) and answers 409,
      // instead of letting a raw 23503 reach the app's `onError` as a 500
      // that leaves the account-level address allocated with nothing left to
      // reclaim it.
      return { row: null, inserted: false };
    }
    if (result.row) {
      return result;
    }
  }
  return { row: null, inserted: false };
}

/** Postgres `foreign_key_violation` SQLSTATE — surfaced by both `pg` and PGlite. */
const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * The project row vanished under an insert that references it.
 *
 * The SQLSTATE rides on the DRIVER error, and drizzle wraps that in a
 * `DrizzleQueryError` whose own `code` is undefined — so the `cause` chain
 * has to be walked, not just the frame that was thrown. Verified against
 * PGlite in `api-delete.test.ts`; `pg` reports the same code the same way.
 * Bounded so a self-referencing `cause` cannot spin.
 */
function isForeignKeyViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cursor !== 'object' || cursor === null) {
      return false;
    }
    if ((cursor as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Undo the CF-side registration for a destination whose row never landed.
 *
 * `email_destinations` rows are the ONLY thing that maps an account-level CF
 * destination back to a project — teardown's cleanup reads them, and there is
 * no sweep for one nothing points at. Every path here already failed to
 * persist a row, so without this the address stays allocated forever against
 * the shared 200-destination account cap.
 *
 * The reference count must be ZERO, not `<= 1` the way the DELETE route reads
 * it: that route still holds its own row, and we have none. A live sibling
 * project can legitimately share the tag (the already-exists recovery above
 * reuses one CF address across projects), so a non-zero count must never
 * delete — it would silently revoke the sibling's recipient. Anything that
 * goes wrong keeps the original log line so an operator can still find the
 * tag by hand.
 */
async function rollbackCfDestination(
  context: Context<ApiEnv>,
  projectId: string,
  address: string,
  cfDestinationId: string,
): Promise<void> {
  try {
    const refs = await countProjectsUsingDestination(context.get('db'), cfDestinationId);
    if (refs === 0) {
      await deleteDestination(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN, cfDestinationId);
      return;
    }
  } catch (err) {
    console.error('[email] CF destination rollback failed:', err);
  }
  console.error(
    `[email] tryCreateEmailDestination concurrently modified for project=${projectId} address=${address}; orphan CF tag candidate: ${cfDestinationId}`,
  );
}

/**
 * Approximate per-project rate-limit on POST /destinations. Same
 * NaN-poisoning defense as the proxy's send counter (`parseInt('NaN')`
 * returns NaN, which would silently bypass `count >= LIMIT`).
 *
 * Not strongly consistent — KV reads can lag writes for ~60s per colo,
 * so racing requests across colos can exceed the limit by a few. That's
 * fine for this defense: we want order-of-magnitude protection against
 * spam, not a strict cap.
 */
async function checkAndIncrementAddRate(
  kv: KVNamespace,
  projectId: string,
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const now = new Date();
  const minuteKey = `email-add-rate:${projectId}:${minuteBucket(now)}`;
  const dayKey = `email-add-rate:${projectId}:${dayBucket(now)}`;
  const [minuteRaw, dayRaw] = await Promise.all([kv.get(minuteKey), kv.get(dayKey)]);
  const minute = parseCounter(minuteRaw);
  const day = parseCounter(dayRaw);
  if (minute >= ADD_RATE_PER_MINUTE) {
    return {
      allowed: false,
      message: `too many destination requests per minute (limit ${ADD_RATE_PER_MINUTE}); try again shortly`,
    };
  }
  if (day >= ADD_RATE_PER_DAY) {
    return {
      allowed: false,
      message: `too many destination requests today (limit ${ADD_RATE_PER_DAY}); try again tomorrow`,
    };
  }
  await Promise.all([
    kv.put(minuteKey, String(minute + 1), { expirationTtl: 5 * 60 }),
    kv.put(dayKey, String(day + 1), { expirationTtl: 25 * 60 * 60 }),
  ]);
  return { allowed: true };
}

function minuteBucket(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}${String(
    now.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

function dayBucket(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
}

export default app;
