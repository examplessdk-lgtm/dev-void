import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { signConfirmToken, type ConfirmTokenPayload } from '../auth/confirm-token.ts';
import { capabilityMiddleware } from '../capabilities.ts';
import {
  countProjectsUsingDestination,
  deleteEmailDestination,
  getEmailDestinationByAddress,
  getEmailDestinationsByProjectId,
  getProject,
  getUser,
  promoteEmailDestinationWithOwnerAudit,
  tryCreateEmailDestination,
  updateEmailDestinationStatus,
  type Db,
  type OwnerVerificationAudit,
} from '../db.ts';
import { OAuthGrantError, createCfCustomerClient, revokeOauthGrant } from '../email/cf-customer.ts';
import type { CfCustomerClient } from '../email/cf-customer.ts';
import { refreshOauthGrantSerialized } from '../email/credential-lease.ts';
import {
  applyEmailDomainDeployCheckpoint,
  clearEmailDomainMirror,
  decryptEmailDomainRelaySecret,
  decryptEmailDomainToken,
  EmailDomainRowGoneError,
  encryptEmailDomainRelaySecret,
  encryptEmailDomainToken,
  generateEmailRelaySecret,
  hashEmailRelaySecret,
  markEmailDomainRemovalFailed,
  writeEmailDomainMirror,
  type EmailDomain,
  type EmailDomainMirror,
} from '../email/domains.ts';
import {
  ROUTING_SUBDOMAIN_STEP,
  domainHasRoutingMx,
  removeEmailDomain,
  setupEmailDomain,
  syncEmailDomain,
  type EmailDomainSetupResult,
} from '../email/relay-engine.ts';
import { RELAY_VERSION } from '../email/relay-worker.ts';
import { sendPlatformVerificationEmail } from '../email/send-verification.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
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
import { emailDomains, type EmailDomainSetupState } from '../schema.ts';
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
 * Cap the raw `address` string BEFORE `.trim().toLowerCase()` and BEFORE
 * `isValidEmail`. Both run ahead of the rate limiter, and a 400 never
 * charges it, so whatever they cost is free to the caller. `toLowerCase`
 * allocates a full-size copy up front (V8 sizes the result before it knows
 * nothing changed), and the loose regex backtracks quadratically on a
 * crafted string — `a@` + `b.` x 80k + ` x` (160 KB) is ~7s of CPU in the
 * shared isolate. RFC 5321 caps a forward-path at 256 octets, UTF-16 length
 * is never more than the octet count, so 320 cannot reject a deliverable
 * address. Same value as the proxy's `MAX_RECIPIENT_LENGTH`.
 */
const MAX_ADDRESS_LENGTH = 320;

/**
 * Caps for the custom-domain add route, checked on the RAW strings before
 * normalization (same reasoning as MAX_ADDRESS_LENGTH). 253 is the DNS
 * name cap from RFC 1035 — no legitimate domain exceeds it, IDN punycode
 * included. The credential cap is generous for either kind (a pasted API
 * token is ~50 chars; an OAuth refresh token a few hundred) and exists only
 * to bound the encrypt + CF call work.
 */
const MAX_DOMAIN_LENGTH = 253;
const MAX_CREDENTIAL_LENGTH = 2048;

/**
 * Email observability + destinations management.
 *
 * Counters live in `ROUTING` KV under monthly buckets — exposed via the
 * `/usage` endpoint. Recipient destinations live in the `email_destinations`
 * Postgres table; the `/destinations` endpoints proxy CF Email Routing's
 * account-level address API and keep our per-project view in sync.
 */
const app = new Hono<ApiEnv>()
  // Path-scoped, NOT `use('*')` as `domains.ts` does: this router is one of
  // several mounted at `/projects`, and Hono re-registers a sub-app's
  // `use('*')` as `ALL /projects/*` on the parent, where it runs for every
  // sibling mounted after it (`githubProjectRoutes`, `projectUsage`). Pinned
  // by the sibling-router test in `api-email.test.ts`.
  .use('/:id/email/*', capabilityMiddleware('email'))
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
        // The owner's address is read only when a row needs it (below).
        let ownerEmail: string | null | undefined;
        for (const row of pending) {
          const cf = byEmail.get(row.address);
          if (!cf?.verified) {
            continue;
          }
          if (cf.tag === row.cf_destination_id) {
            // The click answered the destination THIS row registered.
            await updateEmailDestinationStatus(
              context.get('db'),
              row.id,
              'verified',
              cf.tag,
              cf.verified,
            );
          } else {
            // The account carries the address under a tag this row never
            // registered: its own destination was deleted at Cloudflare
            // (an operator, or the delete-vs-register window the DELETE
            // route names) and another project's add recreated it, so CF's
            // mail — which names no project — was answered for THAT
            // registration. Had the destination survived, this project
            // would have been the second registrant and taken the
            // per-project platform link (Option B); promoting by address
            // here would hand it the other registration's consent instead.
            // So a NON-owner row stays pending — `void email disallow` then
            // `allow` re-registers it, and because the address is now
            // CF-verified that add takes the platform link. This GET must
            // not mail that link itself. The OWNER's own address is Option
            // C: the human who clicked is the human who owns the project,
            // so the row adopts the live tag and records the inherited
            // consent the way the create paths do.
            if (ownerEmail === undefined) {
              const owner = await getUser(context.get('db'), project.user_id);
              ownerEmail = owner?.email?.toLowerCase() ?? null;
            }
            if (ownerEmail !== row.address) {
              console.warn(
                `[email] destination tag mismatch: row=${row.id} project=${projectId} registered=${row.cf_destination_id} cloudflare=${cf.tag}; the verified destination belongs to another registration, so the row stays pending (disallow + allow re-registers it)`,
              );
              continue;
            }
            // The helper re-checks the owner's address under a lock: the
            // read above is unlocked, and a login that rotates the address
            // can commit between it and this write.
            const promoted = await promoteEmailDestinationWithOwnerAudit(
              context.get('db'),
              projectId,
              row.id,
              cf.tag,
              cf.verified,
              { userId: project.user_id, emailSnapshot: ownerEmail },
            );
            if (!promoted) {
              console.warn(
                `[email] destination tag mismatch: row=${row.id} project=${projectId} registered=${row.cf_destination_id} cloudflare=${cf.tag}; the owner's address changed while the listing was refreshing, so the row stays pending`,
              );
              continue;
            }
            row.verified_by_user_id = project.user_id;
            row.verified_by_email_snapshot = ownerEmail;
          }
          row.status = 'verified';
          row.cf_destination_id = cf.tag;
          row.verified_at = cf.verified;
          anyFlipped = true;
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
    // Length is checked on the RAW string: `MAX_ADDRESS_LENGTH` exists to
    // bound the normalization and the regex, so neither may run first.
    const raw = body.address;
    if (typeof raw !== 'string' || raw.length > MAX_ADDRESS_LENGTH) {
      return context.json({ error: 'invalid address' }, 400);
    }
    const address = raw.trim().toLowerCase();
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
      // on create only, and the row flips via the GET refresh when clicked —
      // so that repeat is answered with `verificationSent: false`, the same
      // marker the recovered-owner insert below carries, because both mean
      // "nothing went out; the row waits on a Cloudflare link mailed earlier".
      if (existing.status === 'pending' && existing.verification_source === 'platform') {
        await dispatchPlatformVerification(context, project, existing, address);
        return context.json(
          { ...serializeDestination(existing), platformVerificationPending: true },
          200,
        );
      }
      return context.json(
        existing.status === 'pending'
          ? { ...serializeDestination(existing), verificationSent: false }
          : serializeDestination(existing),
        200,
      );
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
        await rollbackCfDestination(
          context.get('db'),
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          projectId,
          address,
          cfRow.tag,
        );
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
        await rollbackCfDestination(
          context.get('db'),
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          projectId,
          address,
          cfRow.tag,
        );
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

    // The row waits on CLOUDFLARE's link. Two ways to get here:
    //   - CF created the address for THIS request: it is mailing the
    //     recipient right now, and the GET refresh flips the row to verified
    //     when they click.
    //   - The address is the owner's own and CF already held it, still
    //     pending (their first project's auto-add, or a hand add). CF refused
    //     our create and mails its link on create only, so NOTHING went out
    //     for this add — the link from the first add is the only one the
    //     owner has, and this route cannot mint another (CF has no resend
    //     API; `deleteDestination` + a fresh create is the only way, and the
    //     DELETE route takes it only when no other project references the
    //     tag). Report that as `verificationSent: false` rather than let a
    //     bare 201 read as "a link went out": `void email allow` prints
    //     "Verification email sent" from the status code alone.
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
      await rollbackCfDestination(
        context.get('db'),
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        projectId,
        address,
        cfRow.tag,
      );
      return context.json({ error: 'destination concurrently modified, try again' }, 409);
    }
    return context.json(
      recoveredExistingCfRow
        ? { ...serializeDestination(inserted.row), verificationSent: false }
        : serializeDestination(inserted.row),
      201,
    );
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
    // would write the address straight back. `status` is the snapshot's: a
    // `pending` row is not in the mirror and has nothing to tighten, and the
    // re-derive after the delete below covers a row that was promoted in
    // between.
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
    //
    // The count and the upstream delete are not one step, and nothing
    // serializes them against a sibling project's POST. Two concurrent
    // revokes of a shared tag can both read `refs === 2`, both decline the
    // upstream delete, and both drop their row (an orphan). The mirror image:
    // a POST for the same address on another project whose already-exists
    // recovery listed this tag BEFORE the delete below lands, and whose row
    // INSERT lands AFTER this count, commits a row pointing at a tag CF no
    // longer has. The listing never re-checks a `verified` row against CF and
    // a repeat POST returns the existing row without calling CF, so that row
    // stays dangling until its owner runs `void email disallow` then `allow`:
    // the DELETE's upstream call 404s (caught below), the row goes, and the
    // re-add is a fresh create that mails a new link. Re-validating the tag
    // from the POST side after its insert only narrows this to "insert and
    // re-check both land between this count and this delete"; closing it
    // needs both sides to compensate, and the same count-then-delete shape is
    // in the admin revoke and in teardown, where the rows die later in the
    // cascade and the window is far wider — so it belongs in one change
    // across all three (design doc 0067), not here.
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
          // Non-fatal — proceed with the row delete. There is NO sweep for the
          // orphan this leaves, so this log line is the only trace an operator
          // gets. A 404 here is also the recovery path for a dangling row (see
          // above): the tag is already gone, and the row must go with it.
          console.error('[email] CF deleteDestination failed:', err);
        }
      }
    }

    await deleteEmailDestination(context.get('db'), dest.id);

    // Re-derive the mirror now that the row is gone. The tighten above works
    // from a snapshot, and the snapshot can go stale before this delete: a
    // confirm click (or the listing's CF refresh) can flip a `pending` row to
    // `verified` and write it into the mirror after the snapshot was taken,
    // and a click on a SIBLING row re-derives the whole project from rows
    // that still include this one. Either way the delete then drops the row
    // and the mirror keeps granting an address nothing backs. Deriving after
    // the delete cannot include the row. Best-effort on purpose: the row is
    // already gone, so a 503 here would not be retryable, and the residual
    // is bounded — Postgres and KV are written separately and KV has no
    // compare-and-swap, so a concurrent writer that derived its mirror while
    // the row still existed can still land its write after this one, and
    // the grant then lasts until this project's next listing re-derives the
    // mirror (`projectAllowlistKvDiffers`) or any other mirror write for the
    // project. That is a revoke delayed, not consent bypassed: the recipient
    // clicked to allow this project. Serializing the two routes is the
    // project-level lock class from design doc 0067, deliberately not here.
    await syncProjectAllowlistKvBestEffort(context.get('db'), context.env.ROUTING, projectId);
    return context.json({ ok: true });
  })

  // -------------------------------------------------------------------------
  // Custom email domains on the customer's own Cloudflare zone (design doc
  // 0078, "Custom domains on Cloudflare"). The add/sync/remove orchestration
  // lives in src/email/relay-engine.ts (contract 7); these routes own the
  // owner guard, the `email_domains` row, both encrypted triples, and the
  // ROUTING KV mirror the proxy reads (contract 2). Neither the credential
  // nor the relay secret is ever returned — serializers carry metadata only.
  // -------------------------------------------------------------------------
  .get('/:id/email/domains', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const rows = await context
      .get('db')
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.project_id, projectId))
      .orderBy(asc(emailDomains.created_at));
    return context.json(rows.map((row) => serializeEmailDomain(row)));
  })

  .post('/:id/email/domains', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    // Same teardown guard the destinations POST uses.
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    let body: {
      domain?: unknown;
      mode?: unknown;
      refreshToken?: unknown;
      apiToken?: unknown;
    } = {};
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'invalid domain' }, 400);
    }
    // Length is checked on the RAW string before any normalization — same
    // reason as MAX_ADDRESS_LENGTH above: the 400 costs nothing, the
    // normalization and regex never run on attacker-sized input.
    if (typeof body.domain !== 'string' || body.domain.length > MAX_DOMAIN_LENGTH) {
      return context.json({ error: 'invalid domain' }, 400);
    }
    const domain = normalizeEmailDomain(body.domain);
    if (!isValidEmailDomain(domain)) {
      return context.json({ error: 'invalid domain' }, 400);
    }
    if (body.mode !== undefined && body.mode !== 'apex' && body.mode !== 'subdomain') {
      return context.json({ error: 'invalid mode' }, 400);
    }
    const refreshToken =
      typeof body.refreshToken === 'string' && body.refreshToken.length > 0
        ? body.refreshToken
        : undefined;
    const apiToken =
      typeof body.apiToken === 'string' && body.apiToken.length > 0 ? body.apiToken : undefined;
    if ((refreshToken === undefined) === (apiToken === undefined)) {
      return context.json({ error: 'exactly one of refreshToken or apiToken is required' }, 400);
    }
    const credential = (refreshToken ?? apiToken)!;
    if (credential.length > MAX_CREDENTIAL_LENGTH) {
      return context.json({ error: 'invalid credential' }, 400);
    }
    const credentialKind: EmailDomain['credential_kind'] =
      refreshToken !== undefined ? 'oauth_grant' : 'api_token';
    const db = context.get('db');
    const proxyOrigin = proxyOriginForEmail(context.env);

    const existing = await getEmailDomainRow(db, projectId, domain);
    if (existing) {
      // "add again replaces the token, rules stay" (design doc, branch
      // table) — the credential renewal path for token_expired /
      // token_revoked rows, and the retry path for failed ones.
      return await replaceEmailDomainCredential(
        context,
        projectId,
        existing,
        credentialKind,
        credential,
        proxyOrigin,
        body.mode,
      );
    }

    // A domain belongs to exactly one project: the proxy proves a relay
    // secret against the single `email-domain:<domain>` mirror key, and two
    // projects registering the same domain would flip-flop that key and
    // misroute inbound mail. Reject before any credential work.
    const claimed = await getEmailDomainRowByDomain(db, domain);
    if (claimed && claimed.project_id !== projectId) {
      return context.json({ error: 'domain is registered to another project' }, 409);
    }

    // New domain. Persist the credential + a fresh relay secret FIRST: the
    // oauth_grant setup refreshes THROUGH the row (the serialized dep locks
    // and re-reads it), so the grant must be stored before the engine runs.
    const relaySecret = generateEmailRelaySecret();
    const tokenEnc = await encryptEmailDomainToken(context.env, projectId, domain, credential);
    const relayEnc = await encryptEmailDomainRelaySecret(
      context.env,
      projectId,
      domain,
      relaySecret,
    );
    const id = generateId('edom');
    try {
      await db.insert(emailDomains).values({
        id,
        project_id: projectId,
        domain,
        credential_kind: credentialKind,
        token_ciphertext: tokenEnc.ciphertext,
        token_iv: tokenEnc.iv,
        token_key_version: tokenEnc.keyVersion,
        relay_ciphertext: relayEnc.ciphertext,
        relay_iv: relayEnc.iv,
        relay_key_version: relayEnc.keyVersion,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost an add/add race on the domain-wide unique index. The winner
        // decides the error: another project claimed the domain, or this
        // project registered it concurrently.
        const winner = await getEmailDomainRowByDomain(db, domain);
        if (winner && winner.project_id !== projectId) {
          return context.json({ error: 'domain is registered to another project' }, 409);
        }
        return context.json({ error: 'domain concurrently modified, try again' }, 409);
      }
      throw err;
    }

    // The checkpoint makes first-to-persist win — a racing loser 23505s
    // HERE, right after its relay deploy, and never writes its catch-all.
    let checkpoint: {
      zone_id: string | null;
      account_id: string | null;
      mode: 'apex' | 'subdomain' | null;
      relay_worker_name: string;
    } | null = null;
    let result: EmailDomainSetupResult;
    try {
      result = await setupEmailDomain(
        { row: { domain, credential_kind: credentialKind }, credential, relaySecret, proxyOrigin },
        {
          refreshGrant: () => refreshOauthGrantSerialized(db, context.env, id),
          persistProgress: async (progress) => {
            // Capture BEFORE the write: a 23505 throw still needs the
            // checkpoint for compensation below.
            checkpoint = progress;
            await applyEmailDomainDeployCheckpoint(db, id, progress);
          },
        },
      );
    } catch (err) {
      if (isUniqueViolation(err) && checkpoint !== null) {
        const conflict = await compensateEmailDomainRace(
          context,
          id,
          { credentialKind, credential },
          checkpoint,
          err,
        );
        return context.json({ error: conflict }, 409);
      }
      // Any other checkpoint failure leaves the deployed relay
      // unreferenced (the UPDATE rolled back — or the row is gone
      // entirely, so teardown's per-row cleanup can't see it either):
      // compensate from the captured checkpoint before propagating.
      if (checkpoint !== null) {
        await compensateCheckpointDeploy(context, id, { credentialKind, credential }, checkpoint, {
          rowGone: err instanceof EmailDomainRowGoneError,
        });
      }
      if (err instanceof EmailDomainRowGoneError) {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      throw err;
    }
    // The serialized refreshGrant already persisted any rotation under the
    // row lock — result.rotated_refresh_token is deliberately NOT written
    // again (a second write could overwrite a newer rotation a concurrent
    // lease committed in between, killing the chain).
    const applied = await applyEmailDomainSetupResultOrConflict(context, id, result, {
      credentialKind,
      credential,
    });
    if ('conflict' in applied) {
      // The row stays in its pre-apply state; the loser's CF-side work was
      // already compensated best-effort inside.
      return context.json({ error: applied.conflict }, 409);
    }
    const row = applied.row;
    const modeMismatch = body.mode !== undefined && row.mode !== null && body.mode !== row.mode;
    // Mirror AFTER the row is final — the proxy reads only the mirror.
    await writeEmailDomainMirror(context.env.ROUTING, row, await hashEmailRelaySecret(relaySecret));
    if (modeMismatch) {
      return context.json(
        {
          error: `requested mode ${String(body.mode)} but ${domain} is ${row.mode} on its zone`,
          domain: serializeEmailDomain(row, result.error),
        },
        409,
      );
    }
    return context.json(serializeEmailDomain(row, result.error), 201);
  })

  .get('/:id/email/domains/:domain', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const domain = normalizeEmailDomain(context.req.param('domain'));
    const db = context.get('db');
    const row = await getEmailDomainRow(db, projectId, domain);
    if (!row) {
      return context.json({ error: 'email domain not found' }, 404);
    }

    // Re-probe with the decrypted credential. Probe failures never hide the
    // stored view — the row answers with credential_status 'probe_failed',
    // the same non-fatal shape as the destinations listing's CF refresh.
    let credentialStatus: 'active' | 'expired' | 'revoked' | 'probe_failed';
    let probeClient: CfCustomerClient | null = null;
    let tokenPatch: { token_id: string | null; token_expires_on: string | null } | null = null;
    if (row.credential_kind === 'api_token') {
      try {
        const credential = await decryptEmailDomainToken(context.env, projectId, row.domain, row);
        const client = createCfCustomerClient(credential);
        const verification = await client.verifyToken();
        if (verification.status === 'active') {
          credentialStatus = 'active';
          probeClient = client;
          tokenPatch = {
            token_id: verification.id,
            token_expires_on: verification.expires_on ?? null,
          };
        } else if (verification.status === 'expired') {
          credentialStatus = 'expired';
        } else {
          credentialStatus = 'revoked';
        }
      } catch (err) {
        console.error('[email] domain credential probe failed:', err);
        credentialStatus = 'probe_failed';
      }
    } else {
      try {
        // The ONLY probe a grant supports is one refresh round-trip. The
        // rotation is persisted under the row lock inside; the access token
        // rides the drift probe below and is then dropped.
        const tokens = await refreshOauthGrantSerialized(db, context.env, row.id);
        credentialStatus = 'active';
        probeClient = createCfCustomerClient(tokens.accessToken);
      } catch (err) {
        if (err instanceof OAuthGrantError && err.code === 'invalid_grant') {
          // The row was already marked token_revoked under the lock.
          credentialStatus = 'revoked';
        } else {
          console.error('[email] domain grant probe failed:', err);
          credentialStatus = 'probe_failed';
        }
      }
    }

    // Persist what the probe learned. A dead credential flips the row (and,
    // via the mirror repair below, the proxy's view) to token_expired /
    // token_revoked; a healthy api_token refreshes token_id/expires_on.
    // Probes never RESURRECT a row — re-running add is the renewal path.
    const patch: {
      status?: EmailDomain['status'];
      token_id?: string | null;
      token_expires_on?: string | null;
    } = {};
    if (credentialStatus === 'expired' && row.status !== 'token_expired') {
      patch.status = 'token_expired';
    } else if (credentialStatus === 'revoked' && row.status !== 'token_revoked') {
      patch.status = 'token_revoked';
    }
    if (
      tokenPatch &&
      (tokenPatch.token_id !== row.token_id || tokenPatch.token_expires_on !== row.token_expires_on)
    ) {
      patch.token_id = tokenPatch.token_id;
      patch.token_expires_on = tokenPatch.token_expires_on;
    }
    if (Object.keys(patch).length > 0) {
      await db
        .update(emailDomains)
        .set({ ...patch, updated_at: sql`now()` })
        .where(eq(emailDomains.id, row.id));
    }

    let fresh = await getEmailDomainRowById(db, row.id);
    if (!fresh) {
      // Project teardown's cascade can take the row mid-request.
      return context.json({ error: 'email domain not found' }, 404);
    }

    // Self-clear the routing-subdomain human step: the dashboard form's
    // observable effect is public MX records naming Cloudflare's inbound
    // exchanges. On that evidence the step is done — flip the row to
    // active (the mirror repair below carries the new status to the
    // proxy). No evidence — MX not there yet, or the lookup failed —
    // leaves the row pending for the next poll.
    if (
      fresh.status === 'pending' &&
      fresh.setup_state?.remaining_steps?.length === 1 &&
      fresh.setup_state.remaining_steps[0] === ROUTING_SUBDOMAIN_STEP &&
      (await domainHasRoutingMx(fresh.domain))
    ) {
      await db
        .update(emailDomains)
        .set({ status: 'active', setup_state: null, updated_at: sql`now()` })
        .where(eq(emailDomains.id, fresh.id));
      fresh = await getEmailDomainRowById(db, row.id);
      if (!fresh) {
        return context.json({ error: 'email domain not found' }, 404);
      }
    }

    // Relay drift: the version the row recorded vs the embedded
    // RELAY_VERSION, plus an existence probe — the customer can edit or
    // delete the relay in their own account, and status reports drift
    // rather than fighting it.
    let relayMissing: boolean | null = null;
    if (probeClient && fresh.account_id && fresh.relay_worker_name) {
      try {
        relayMissing = !(await probeClient.relayScriptExists(
          fresh.account_id,
          fresh.relay_worker_name,
        ));
      } catch (err) {
        console.error('[email] relay existence probe failed:', err);
      }
    }
    const relayDrift = fresh.relay_version !== RELAY_VERSION || relayMissing === true;

    // Catch-all drift probe — the same try/catch-and-report-never-fight
    // doctrine as the relay probe above. Read-only: healing is the sync
    // POST's job (its ensure runs in the engine).
    let catchAll: 'points_here' | 'points_elsewhere' | 'missing' | 'disabled' | 'unknown' =
      'unknown';
    if (probeClient && fresh.zone_id && fresh.relay_worker_name) {
      try {
        const rule = await probeClient.getCatchAll(fresh.zone_id);
        catchAll =
          rule === null
            ? 'missing'
            : !rule.enabled
              ? 'disabled'
              : rule.workerName === fresh.relay_worker_name
                ? 'points_here'
                : 'points_elsewhere';
      } catch (err) {
        console.error('[email] catch-all probe failed:', err);
      }
    }
    const catchAllDrift =
      (fresh.status === 'active' || fresh.status === 'pending') &&
      (catchAll === 'points_elsewhere' || catchAll === 'missing' || catchAll === 'disabled');

    // This GET is the mirror's repair point (the same read-compare-write
    // self-heal shape as the allowlist listing): probe transitions and any
    // other drift land here; no difference means no write. Suppressed
    // while a removal failure is pending — the row is mid-removal, and the
    // proxy mirror must not be "repaired" against a state the operator is
    // about to finish removing.
    if (fresh.setup_state?.failed_step !== 'remove') {
      await repairEmailDomainMirrorIfDrifted(context.env, fresh);
    }

    return context.json({
      ...serializeEmailDomain(fresh),
      credential_status: credentialStatus,
      current_relay_version: RELAY_VERSION,
      relay_drift: relayDrift,
      relay_missing: relayMissing,
      catch_all: catchAll,
      catch_all_drift: catchAllDrift,
    });
  })

  .post('/:id/email/domains/:domain/sync', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    // Sync mutates CF state and the row — same teardown guard as add/remove.
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    const domain = normalizeEmailDomain(context.req.param('domain'));
    const db = context.get('db');
    const row = await getEmailDomainRow(db, projectId, domain);
    if (!row) {
      return context.json({ error: 'email domain not found' }, 404);
    }

    const credential = await decryptEmailDomainToken(context.env, projectId, row.domain, row);
    // Sync redeploys the relay in place at RELAY_VERSION and rotates its
    // secret (overwrite, never read-compare — worker secrets are
    // write-only).
    const result = await syncEmailDomain(
      {
        row: {
          domain: row.domain,
          credential_kind: row.credential_kind,
          account_id: row.account_id,
          relay_worker_name: row.relay_worker_name,
          zone_id: row.zone_id,
        },
        credential,
        proxyOrigin: proxyOriginForEmail(context.env),
      },
      { refreshGrant: () => refreshOauthGrantSerialized(db, context.env, row.id) },
    );

    let relaySecretSha256: string;
    const relayPatch: {
      relay_ciphertext?: string;
      relay_iv?: string;
      relay_key_version?: string;
    } = {};
    if (result.new_relay_secret !== undefined) {
      const relayEnc = await encryptEmailDomainRelaySecret(
        context.env,
        projectId,
        row.domain,
        result.new_relay_secret,
      );
      relayPatch.relay_ciphertext = relayEnc.ciphertext;
      relayPatch.relay_iv = relayEnc.iv;
      relayPatch.relay_key_version = relayEnc.keyVersion;
      relaySecretSha256 = await hashEmailRelaySecret(result.new_relay_secret);
    } else {
      // No rotation happened (failed before the secret PUT) — the mirror
      // still moves with the new status, hashed from the existing secret.
      relaySecretSha256 = await hashEmailRelaySecret(
        await decryptEmailDomainRelaySecret(context.env, projectId, row.domain, row),
      );
    }
    // A successful sync does not clear a pending human step: the engine
    // cannot observe the routing-subdomain dashboard form, so
    // remaining_steps survive and the row stays 'pending'.
    const remainingSteps = row.setup_state?.remaining_steps;
    const setupState: EmailDomainSetupState | null =
      result.setup_state !== null
        ? result.setup_state
        : remainingSteps && remainingSteps.length > 0
          ? { remaining_steps: remainingSteps }
          : null;
    const status: EmailDomain['status'] =
      result.status === 'active' && setupState?.remaining_steps?.length ? 'pending' : result.status;
    try {
      await db
        .update(emailDomains)
        .set({
          status,
          relay_version: result.relay_version,
          setup_state: setupState,
          ...relayPatch,
          updated_at: sql`now()`,
        })
        .where(eq(emailDomains.id, row.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        // NO compensation here — sync deployed in place on the row's OWN
        // relay, so the 409 just refuses the live-status flip: a 'failed'
        // row carrying its zone can collide with the winner when sync
        // flips it back to a live status.
        return context.json(
          {
            error: uniqueViolationConstraintName(err).includes('relay')
              ? 'another email domain is deploying the same relay worker — retry'
              : 'another active email domain already uses this zone — remove it first',
          },
          409,
        );
      }
      throw err;
    }

    const fresh = await getEmailDomainRowById(db, row.id);
    if (!fresh) {
      throw new Error('email_domains row vanished mid-sync');
    }
    await writeEmailDomainMirror(context.env.ROUTING, fresh, relaySecretSha256);
    return context.json({
      ...serializeEmailDomain(fresh, result.error),
      ...(result.catch_all === undefined ? {} : { catch_all: result.catch_all }),
    });
  })

  .delete('/:id/email/domains/:domain', async (context) => {
    const projectId = context.req.param('id');
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

    const domain = normalizeEmailDomain(context.req.param('domain'));
    const db = context.get('db');
    const row = await getEmailDomainRow(db, projectId, domain);
    if (!row) {
      return context.json({ error: 'email domain not found' }, 404);
    }

    const force = context.req.query('force') === '1';

    // Remove: best-effort CF cleanup (catch-all reset, relay DELETE, grant
    // revoke LAST), then the row and the mirror key. removeEmailDomain
    // never throws; a decrypt failure skips CF cleanup entirely. A failed
    // DESTRUCTIVE step (catch-all or relay delete) KEEPS the row so the
    // operator can retry — unless forced, or the grant is already dead:
    // token_revoked rows are always deleted (CF may be unreachable and
    // keeping buys no retry leverage — re-add is the renewal path), and a
    // 'revoke_grant'-only failure still deletes (a stranded grant breaks
    // no mail).
    let failedSteps: ReadonlyArray<string>;
    try {
      const credential = await decryptEmailDomainToken(context.env, projectId, row.domain, row);
      const result = await removeEmailDomain(
        {
          row: {
            credential_kind: row.credential_kind,
            account_id: row.account_id,
            relay_worker_name: row.relay_worker_name,
            zone_id: row.zone_id,
          },
          credential,
        },
        {
          // Refresh rotations must persist through the row's serialized
          // chain while the row lives — in the keep-row world a failed
          // removal KEEPS the row, and a bricked rotation would kill the
          // retry.
          refreshGrant: () => refreshOauthGrantSerialized(db, context.env, row.id),
          ...(row.credential_kind === 'oauth_grant' ? { revokeGrant: revokeOauthGrant } : {}),
        },
      );
      failedSteps = result.failed_steps;
    } catch (err) {
      console.error('[email] domain remove credential decrypt failed:', err);
      failedSteps = ['delete_relay', 'catch_all'];
    }

    const destructive = failedSteps.some((s) => s === 'catch_all' || s === 'delete_relay');
    if (destructive && !force && row.status !== 'token_revoked') {
      await markEmailDomainRemovalFailed(db, row.id, failedSteps);
      return context.json({ ok: false, removed: false, failed_steps: failedSteps }, 200);
    }

    // Mirror key BEFORE the row — never destroy the record a retry would
    // re-derive the mirror from (the destinations DELETE inversion). A KV
    // failure 500s here with the row intact, so the retry can finish it.
    await clearEmailDomainMirror(context.env.ROUTING, row.domain);
    await db.delete(emailDomains).where(eq(emailDomains.id, row.id));
    return context.json({
      ok: true,
      removed: true,
      ...(force && failedSteps.length > 0 ? { forced: true } : {}),
      ...(failedSteps.length > 0 ? { failed_steps: failedSteps } : {}),
    });
  });

/**
 * The proxy origin baked into the relay worker as VOID_PROXY_ORIGIN — the
 * same resolution the platform discovery document uses.
 */
function proxyOriginForEmail(env: ApiEnv['Bindings']): string {
  const origin =
    env.PROXY_URL ??
    (env.PLATFORM_ENV === 'staging'
      ? 'https://proxy.staging.void.cloud'
      : 'https://proxy.void.cloud');
  return origin.replace(/\/+$/, '');
}

function normalizeEmailDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * DNS hostname shape: two or more labels, each 1–63 chars, alphanumeric +
 * interior hyphens. Real validation is the engine's zone lookup — this
 * keeps junk out of the encrypt and CF calls.
 */
function isValidEmailDomain(domain: string): boolean {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain);
}

/**
 * The mirror key spelling is owned by `src/email/domains.ts` (the writer —
 * frozen for this phase); the status route's read-compare repair reads the
 * same key. A rename there must move this spelling with it.
 */
function emailDomainMirrorKey(domain: string): string {
  return `email-domain:${domain}`;
}

async function getEmailDomainRow(
  db: Db,
  projectId: string,
  domain: string,
): Promise<EmailDomain | null> {
  const rows = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.project_id, projectId), eq(emailDomains.domain, domain)))
    .limit(1);
  return rows[0] ?? null;
}

async function getEmailDomainRowById(db: Db, id: string): Promise<EmailDomain | null> {
  const rows = await db.select().from(emailDomains).where(eq(emailDomains.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Cross-project lookup: a domain is globally unique across projects
 * (`email_domains_domain_uq`), because one domain produces exactly one
 * `email-domain:<domain>` mirror key and one relay secret.
 */
async function getEmailDomainRowByDomain(db: Db, domain: string): Promise<EmailDomain | null> {
  const rows = await db.select().from(emailDomains).where(eq(emailDomains.domain, domain)).limit(1);
  return rows[0] ?? null;
}

/**
 * The public shape of an email_domains row — metadata only. Neither
 * ciphertext triple nor any plaintext secret ever appears here.
 */
function serializeEmailDomain(row: EmailDomain, error?: string) {
  return {
    id: row.id,
    domain: row.domain,
    mode: row.mode,
    status: row.status,
    credential_kind: row.credential_kind,
    relay_worker_name: row.relay_worker_name,
    relay_version: row.relay_version,
    token_id: row.token_id,
    token_expires_on: row.token_expires_on,
    setup_state: row.setup_state,
    // The engine's failure text names the failing step / CF error — never
    // credential material — so the CLI can print it verbatim.
    ...(error === undefined ? {} : { error }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Persist the engine's setup outcome onto the row and return the final
 * row. Never touches the token_* triple: the caller wrote it at insert,
 * and any rotation since was persisted by the serialized refresh under the
 * row lock.
 */
async function applyEmailDomainSetupResult(
  db: Db,
  id: string,
  result: EmailDomainSetupResult,
  relay?: { ciphertext: string; iv: string; keyVersion: string },
): Promise<EmailDomain> {
  await db
    .update(emailDomains)
    .set({
      status: result.status,
      zone_id: result.zone_id,
      account_id: result.account_id,
      mode: result.mode,
      relay_worker_name: result.relay_worker_name,
      relay_version: result.relay_version,
      token_id: result.token_id,
      token_expires_on: result.token_expires_on,
      setup_state: result.setup_state,
      ...(relay === undefined
        ? {}
        : {
            relay_ciphertext: relay.ciphertext,
            relay_iv: relay.iv,
            relay_key_version: relay.keyVersion,
          }),
      updated_at: sql`now()`,
    })
    .where(eq(emailDomains.id, id));
  const row = await getEmailDomainRowById(db, id);
  if (!row) {
    throw new Error('email_domains row vanished mid-setup');
  }
  return row;
}

/**
 * The 23505 loser's best-effort CF compensation, shared by the apply-time
 * backstop (applyEmailDomainSetupResultOrConflict) and the deploy-time
 * checkpoint (persistProgress): both lose a zone (or one account's relay
 * name) to a setup that already passed the engine's CF-side reads —
 * first-to-persist wins.
 *
 * Works from what the engine RETURNED or checkpointed (the loser's row
 * still holds nulls). A relay-NAME conflict never deletes the worker —
 * the name is contested, the winner is using it — so the compensation
 * runs with account_id nulled: only the loser's zone rule is detached. On
 * a ZONE conflict the winner is looked up and an owned catch-all is
 * REPOINTED at its relay: the loser's conditional reset only detaches a
 * rule naming its OWN relay, so without a repoint target the zone's rule
 * dies with the loser; repointing hands it to the winner instead. (At
 * checkpoint-time conflicts the loser never wrote its rule, so the
 * repoint probe is a harmless no-op — one code path.) A failed winner
 * lookup degrades to the plain reset. Deliberately NO revokeGrant dep:
 * the loser's row/credential may survive — conflict compensation is not
 * removal.
 */
async function compensateEmailDomainRace(
  context: Context<ApiEnv>,
  loserRowId: string,
  race: {
    credentialKind: EmailDomain['credential_kind'];
    credential: string;
  },
  loser: {
    zone_id: string | null;
    account_id: string | null;
    relay_worker_name: string | null;
  },
  err: unknown,
): Promise<string> {
  const relayRace = uniqueViolationConstraintName(err).includes('relay');
  let repointTo: string | null = null;
  if (!relayRace && loser.zone_id !== null) {
    try {
      const winners = await context
        .get('db')
        .select()
        .from(emailDomains)
        .where(
          and(
            eq(emailDomains.zone_id, loser.zone_id),
            // The exact live-status set of the schema's
            // email_domains_zone_uq partial index — the rows this loser
            // lost to.
            inArray(emailDomains.status, ['active', 'pending']),
            isNotNull(emailDomains.relay_worker_name),
            ne(emailDomains.id, loserRowId),
          ),
        )
        .limit(1);
      repointTo = winners[0]?.relay_worker_name ?? null;
    } catch (lookupErr) {
      console.error('[email] race winner lookup failed; falling back to reset:', lookupErr);
    }
  }
  try {
    await removeEmailDomain(
      {
        row: {
          credential_kind: race.credentialKind,
          // A contested relay name is never deleted (see the header).
          account_id: relayRace ? null : loser.account_id,
          relay_worker_name: loser.relay_worker_name,
          zone_id: loser.zone_id,
        },
        credential: race.credential,
        ...(repointTo === null ? {} : { repoint_catch_all_to: repointTo }),
      },
      {
        // Grant refresh tokens are single-use: the compensation's refresh
        // must persist its rotation through the row's serialized chain,
        // or the cleanup would brick the credential it leaves behind.
        refreshGrant: () => refreshOauthGrantSerialized(context.get('db'), context.env, loserRowId),
      },
    );
  } catch (compensationErr) {
    // removeEmailDomain never throws; this is paranoia for the log only.
    console.error('[email] race compensation failed:', compensationErr);
  }
  return relayRace
    ? 'another email domain is deploying the same relay worker — retry'
    : 'another active email domain already uses this zone — remove it first';
}

/**
 * applyEmailDomainSetupResult + the concurrent-add backstop (schema's
 * partial unique indexes): two setups racing one zone (or one account's
 * relay name) both pass the engine's CF-side reads, so the loser is caught
 * here — a 409, never a falsely-active second row.
 *
 * A NON-unique apply failure after the engine may have deployed CF-side is
 * reconciled against the row (orphan-relay fix): if the UPDATE actually
 * committed — the failure was the follow-up read — the committed row
 * stands; otherwise the possibly-deployed relay is compensated
 * best-effort, so no orphan worker is left for a zone the row never
 * recorded.
 */
async function applyEmailDomainSetupResultOrConflict(
  context: Context<ApiEnv>,
  id: string,
  result: EmailDomainSetupResult,
  race: {
    credentialKind: EmailDomain['credential_kind'];
    credential: string;
  },
  relay?: { ciphertext: string; iv: string; keyVersion: string },
): Promise<{ row: EmailDomain } | { conflict: string }> {
  try {
    return { row: await applyEmailDomainSetupResult(context.get('db'), id, result, relay) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const conflict = await compensateEmailDomainRace(
        context,
        id,
        race,
        {
          zone_id: result.zone_id,
          account_id: result.account_id,
          relay_worker_name: result.relay_worker_name,
        },
        err,
      );
      return { conflict };
    }
    // Nothing to clean when setup failed before the deploy.
    if (result.relay_worker_name === null) {
      throw err;
    }
    let reread: EmailDomain | null;
    try {
      reread = await getEmailDomainRowById(context.get('db'), id);
    } catch (rereadErr) {
      console.error(
        '[email] post-apply re-read failed; possible orphan relay left for sync/drift',
        rereadErr,
      );
      throw err;
    }
    // Committed ⟺ the row carries the apply's relay_version, not only the
    // name: the deploy checkpoint persists relay_worker_name first, so a
    // name match alone cannot tell a committed apply apart from a failed
    // one on a checkpointed row. A same-version re-run whose UPDATE fails
    // still reads as committed — the benign direction: CF state was
    // redeployed in place, only status/token fields stay stale until the
    // next sync, and no referenced relay is torn down.
    if (
      reread &&
      reread.relay_worker_name === result.relay_worker_name &&
      reread.relay_version === result.relay_version
    ) {
      // The UPDATE committed despite the error (the failure was the
      // follow-up read).
      return { row: reread };
    }
    try {
      // Not a name race — the loser owns its relay, so the compensation
      // runs with the result's OWN account_id (not nulled).
      await removeEmailDomain(
        {
          row: {
            credential_kind: race.credentialKind,
            account_id: result.account_id,
            relay_worker_name: result.relay_worker_name,
            zone_id: result.zone_id,
          },
          credential: race.credential,
        },
        {
          // Same single-use refresh doctrine as the race compensation.
          refreshGrant: () => refreshOauthGrantSerialized(context.get('db'), context.env, id),
        },
      );
    } catch (compErr) {
      console.error('[email] orphan compensation failed:', compErr);
    }
    throw err;
  }
}

/**
 * Best-effort compensation for a checkpoint write that failed for any
 * non-race reason (a DB error, or the row cascade-deleted by teardown
 * mid-setup): the relay and its secret are deployed but the row carries
 * no reference to them, so remove them from the captured checkpoint
 * payload before the error propagates. The catch-all was never written
 * (the checkpoint precedes it), so the conditional reset is a no-op.
 * `rowGone` switches the refresh to the engine default, which acts on the
 * held credential directly — the serialized chain needs the row.
 */
async function compensateCheckpointDeploy(
  context: Context<ApiEnv>,
  rowId: string,
  race: { credentialKind: EmailDomain['credential_kind']; credential: string },
  checkpoint: { zone_id: string | null; account_id: string | null; relay_worker_name: string },
  opts: { rowGone: boolean },
): Promise<void> {
  try {
    await removeEmailDomain(
      {
        row: {
          credential_kind: race.credentialKind,
          account_id: checkpoint.account_id,
          relay_worker_name: checkpoint.relay_worker_name,
          zone_id: checkpoint.zone_id,
        },
        credential: race.credential,
      },
      opts.rowGone
        ? {}
        : {
            // Same single-use refresh doctrine as the race compensation.
            refreshGrant: () => refreshOauthGrantSerialized(context.get('db'), context.env, rowId),
          },
    );
  } catch (compErr) {
    console.error('[email] checkpoint-failure compensation failed:', compErr);
  }
}

/**
 * POST /domains on an existing row — "add again replaces the token, rules
 * stay" (design doc, branch table). The new credential is stored first
 * because the oauth_grant engine path refreshes THROUGH the row. Healthy
 * rows (active / pending / credential renewal) take the sync path —
 * redeploy in place + rotate the relay secret. A row that never finished
 * setup re-runs the FULL engine with a fresh relay secret: status
 * 'failed', or the relay/account fields missing. The engine is
 * re-runnable against the row's recorded progress, so a catch-all
 * failure gets its rule written rather than just re-deploying the relay.
 */
async function replaceEmailDomainCredential(
  context: Context<ApiEnv>,
  projectId: string,
  existing: EmailDomain,
  credentialKind: EmailDomain['credential_kind'],
  credential: string,
  proxyOrigin: string,
  requestedMode: unknown,
): Promise<Response> {
  const db = context.get('db');
  const domain = existing.domain;
  // Captured BEFORE the replace overwrites the ciphertext triple — the old
  // grant is revoked below once the new credential is safely stored.
  let oldGrantRefreshToken: string | null = null;
  if (existing.credential_kind === 'oauth_grant') {
    try {
      oldGrantRefreshToken = await decryptEmailDomainToken(
        context.env,
        projectId,
        domain,
        existing,
      );
    } catch (err) {
      console.error('[email] old grant decrypt failed; skipping revoke:', err);
    }
  }
  const tokenEnc = await encryptEmailDomainToken(context.env, projectId, domain, credential);
  await db
    .update(emailDomains)
    .set({
      credential_kind: credentialKind,
      token_ciphertext: tokenEnc.ciphertext,
      token_iv: tokenEnc.iv,
      token_key_version: tokenEnc.keyVersion,
      // Re-derived by the engine for api_token; grants carry neither.
      token_id: null,
      token_expires_on: null,
      updated_at: sql`now()`,
    })
    .where(eq(emailDomains.id, existing.id));

  // Revoke AFTER the commit so a failed replace never strands the old
  // grant; a re-pasted identical grant is skipped — revoking it would
  // brick the just-stored credential. A revoke failure (network/non-2xx —
  // the helper throws on both) is logged, never fatal: the new credential
  // is already committed.
  if (oldGrantRefreshToken !== null && oldGrantRefreshToken !== credential) {
    try {
      await revokeOauthGrant(oldGrantRefreshToken);
    } catch (err) {
      console.error('[email] old grant revoke failed after credential replace:', err);
    }
  }

  // Sync keeps a healthy row healthy; anything that never finished setup
  // re-runs the full engine (see the header). A catch-all failure is the
  // one 'failed' shape that still carries relay_worker_name/account_id —
  // it must NOT take the sync path, which never writes the catch-all.
  const setupIncomplete =
    existing.status === 'failed' || !existing.relay_worker_name || !existing.account_id;
  if (!setupIncomplete) {
    const result = await syncEmailDomain(
      {
        row: {
          domain,
          credential_kind: credentialKind,
          account_id: existing.account_id,
          relay_worker_name: existing.relay_worker_name,
          zone_id: existing.zone_id,
        },
        credential,
        proxyOrigin,
      },
      { refreshGrant: () => refreshOauthGrantSerialized(db, context.env, existing.id) },
    );
    let relaySecretSha256: string;
    const relayPatch: {
      relay_ciphertext?: string;
      relay_iv?: string;
      relay_key_version?: string;
    } = {};
    if (result.new_relay_secret !== undefined) {
      const relayEnc = await encryptEmailDomainRelaySecret(
        context.env,
        projectId,
        domain,
        result.new_relay_secret,
      );
      relayPatch.relay_ciphertext = relayEnc.ciphertext;
      relayPatch.relay_iv = relayEnc.iv;
      relayPatch.relay_key_version = relayEnc.keyVersion;
      relaySecretSha256 = await hashEmailRelaySecret(result.new_relay_secret);
    } else {
      relaySecretSha256 = await hashEmailRelaySecret(
        await decryptEmailDomainRelaySecret(context.env, projectId, domain, existing),
      );
    }
    // A successful sync does not clear a pending human step — the engine
    // cannot observe the routing-subdomain dashboard form, so
    // remaining_steps survive and the row stays 'pending'.
    const remainingSteps = existing.setup_state?.remaining_steps;
    const setupState: EmailDomainSetupState | null =
      result.setup_state !== null
        ? result.setup_state
        : remainingSteps && remainingSteps.length > 0
          ? { remaining_steps: remainingSteps }
          : null;
    const status: EmailDomain['status'] =
      result.status === 'active' && setupState?.remaining_steps?.length ? 'pending' : result.status;
    try {
      await db
        .update(emailDomains)
        .set({
          status,
          relay_version: result.relay_version,
          setup_state: setupState,
          ...relayPatch,
          updated_at: sql`now()`,
        })
        .where(eq(emailDomains.id, existing.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Same refusal as the sync route: the deploy ran in place on the
        // row's OWN relay, so there is nothing to compensate — only the
        // live-status flip is refused.
        return context.json(
          {
            error: uniqueViolationConstraintName(err).includes('relay')
              ? 'another email domain is deploying the same relay worker — retry'
              : 'another active email domain already uses this zone — remove it first',
          },
          409,
        );
      }
      throw err;
    }
    const row = await getEmailDomainRowById(db, existing.id);
    if (!row) {
      throw new Error('email_domains row vanished mid-update');
    }
    await writeEmailDomainMirror(context.env.ROUTING, row, relaySecretSha256);
    return context.json(
      {
        ...serializeEmailDomain(row, result.error),
        ...(result.catch_all === undefined ? {} : { catch_all: result.catch_all }),
      },
      200,
    );
  }

  // Setup never finished — re-run the full engine with a fresh relay
  // secret, carrying the row's recorded progress so completed steps are
  // idempotent (mode skips the MX check; a relay name redeploys in
  // place; 'already done' 4xx is believed only on a confirming read-back).
  const relaySecret = generateEmailRelaySecret();
  const relayEnc = await encryptEmailDomainRelaySecret(context.env, projectId, domain, relaySecret);
  // The checkpoint makes first-to-persist win — a racing loser 23505s
  // HERE, right after its relay deploy, and never writes its catch-all.
  let checkpoint: {
    zone_id: string | null;
    account_id: string | null;
    mode: 'apex' | 'subdomain' | null;
    relay_worker_name: string;
  } | null = null;
  let result: EmailDomainSetupResult;
  try {
    result = await setupEmailDomain(
      {
        row: {
          domain,
          credential_kind: credentialKind,
          ...(existing.mode === null ? {} : { mode: existing.mode }),
          ...(existing.relay_worker_name === null
            ? {}
            : { relay_worker_name: existing.relay_worker_name }),
          ...(existing.zone_id === null ? {} : { zone_id: existing.zone_id }),
          ...(existing.account_id === null ? {} : { account_id: existing.account_id }),
        },
        credential,
        relaySecret,
        proxyOrigin,
      },
      {
        refreshGrant: () => refreshOauthGrantSerialized(db, context.env, existing.id),
        persistProgress: async (progress) => {
          // Capture BEFORE the write: a 23505 throw still needs the
          // checkpoint for compensation below.
          checkpoint = progress;
          await applyEmailDomainDeployCheckpoint(db, existing.id, progress);
        },
      },
    );
  } catch (err) {
    if (isUniqueViolation(err) && checkpoint !== null) {
      const conflict = await compensateEmailDomainRace(
        context,
        existing.id,
        { credentialKind, credential },
        checkpoint,
        err,
      );
      return context.json({ error: conflict }, 409);
    }
    // Any other checkpoint failure leaves the deployed relay unreferenced
    // (the UPDATE rolled back — or the row is gone entirely, so teardown's
    // per-row cleanup can't see it either): compensate from the captured
    // checkpoint before propagating.
    if (checkpoint !== null) {
      await compensateCheckpointDeploy(
        context,
        existing.id,
        { credentialKind, credential },
        checkpoint,
        { rowGone: err instanceof EmailDomainRowGoneError },
      );
    }
    if (err instanceof EmailDomainRowGoneError) {
      return context.json({ error: 'project is being deleted' }, 409);
    }
    throw err;
  }
  const applied = await applyEmailDomainSetupResultOrConflict(
    context,
    existing.id,
    result,
    { credentialKind, credential },
    relayEnc,
  );
  if ('conflict' in applied) {
    return context.json({ error: applied.conflict }, 409);
  }
  const row = applied.row;
  await writeEmailDomainMirror(context.env.ROUTING, row, await hashEmailRelaySecret(relaySecret));
  if (requestedMode !== undefined && row.mode !== null && requestedMode !== row.mode) {
    return context.json(
      {
        error: `requested mode ${String(requestedMode)} but ${domain} is ${row.mode} on its zone`,
        domain: serializeEmailDomain(row, result.error),
      },
      409,
    );
  }
  return context.json(serializeEmailDomain(row, result.error), 200);
}

/**
 * The status GET's mirror repair — the same read-compare-write self-heal
 * shape as the allowlist listing (`projectAllowlistKvDiffers`): rewrite
 * only on a real difference, so polling never amplifies into KV writes.
 */
async function repairEmailDomainMirrorIfDrifted(
  env: Pick<
    ApiEnv['Bindings'],
    'ROUTING' | 'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
  >,
  row: EmailDomain,
): Promise<void> {
  const relaySecretSha256 = await hashEmailRelaySecret(
    await decryptEmailDomainRelaySecret(env, row.project_id, row.domain, row),
  );
  const raw = await env.ROUTING.get(emailDomainMirrorKey(row.domain));
  if (raw !== null) {
    try {
      const mirror = JSON.parse(raw) as Partial<EmailDomainMirror>;
      if (
        mirror.projectId === row.project_id &&
        mirror.status === row.status &&
        mirror.relaySecretSha256 === relaySecretSha256 &&
        mirror.relayWorkerName === row.relay_worker_name &&
        mirror.accountId === row.account_id &&
        mirror.zoneId === row.zone_id &&
        mirror.mode === row.mode
      ) {
        return;
      }
    } catch {
      // Unparseable mirror — rewrite below.
    }
  }
  await writeEmailDomainMirror(env.ROUTING, row, relaySecretSha256);
}

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
 * the catch below. So does `ownerEmailChanged`, without the retry: the
 * helper found the owner's address rotated away from the one whose
 * Cloudflare consent the Option C branch meant to inherit (the read the
 * branch made is unlocked, and a login can commit between it and the
 * insert). A second attempt would read the same answer. The 409 is right
 * on the merits — the retry re-reads the owner and, the address now being
 * somebody else's, takes the Option B platform link instead.
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
    let result: { row: EmailDestination | null; inserted: boolean; ownerEmailChanged?: true };
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
    if (result.row || result.ownerEmailChanged) {
      return result;
    }
  }
  return { row: null, inserted: false };
}

/** Postgres SQLSTATEs — surfaced by both `pg` and PGlite. */
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Does this error carry the given Postgres SQLSTATE anywhere in its cause
 * chain?
 *
 * The SQLSTATE rides on the DRIVER error, and drizzle wraps that in a
 * `DrizzleQueryError` whose own `code` is undefined — so the `cause` chain
 * has to be walked, not just the frame that was thrown. Verified against
 * PGlite in `api-delete.test.ts`; `pg` reports the same code the same way.
 * Bounded so a self-referencing `cause` cannot spin.
 */
function hasSqlState(err: unknown, code: string): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cursor !== 'object' || cursor === null) {
      return false;
    }
    if ((cursor as { code?: unknown }).code === code) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** The project row vanished under an insert that references it. */
function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, PG_FOREIGN_KEY_VIOLATION);
}

/** Lost an insert race on a unique index (the add/add domains race). */
function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, PG_UNIQUE_VIOLATION);
}

/**
 * The constraint behind a unique violation, walked like hasSqlState: the
 * `23505` code can sit on a nested cause (drizzle wraps the driver error),
 * and the constraint name rides the same frame the code does. Both drivers
 * here — PGlite and `pg` via pg-protocol — expose it as `constraint`
 * (`constraint_name` is postgres.js naming, not used in this repo). An
 * empty answer classifies as a zone race — the relay race is the
 * destructive misclassification (its compensation would delete a worker
 * another live row owns), so the name must be found wherever the driver
 * put it.
 */
function uniqueViolationConstraintName(err: unknown): string {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cursor !== 'object' || cursor === null) {
      return '';
    }
    const name = (cursor as { constraint?: unknown }).constraint;
    if (typeof name === 'string' && name !== '') {
      return name;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return '';
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
 *
 * Takes `db` / account / token explicitly rather than a Hono `Context`
 * because `autoAddOwnerDestination` in `routes/projects.ts` shares it and has
 * no context by design — it runs after the 201 response, so it outlives the
 * request whose context it would otherwise borrow.
 */
export async function rollbackCfDestination(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  address: string,
  cfDestinationId: string,
): Promise<void> {
  try {
    const refs = await countProjectsUsingDestination(db, cfDestinationId);
    if (refs === 0) {
      await deleteDestination(accountId, apiToken, cfDestinationId);
      return;
    }
  } catch (err) {
    console.error('[email] CF destination rollback failed:', err);
  }
  console.error(
    `[email] destination row not persisted for project=${projectId} address=${address}; orphan CF tag candidate: ${cfDestinationId}`,
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
