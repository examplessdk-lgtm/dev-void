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
  type DbOrTx,
  type OwnerVerificationAudit,
  type Tx,
} from '../db.ts';
import { OAuthGrantError, createCfCustomerClient, revokeOauthGrant } from '../email/cf-customer.ts';
import type { CfCustomerClient } from '../email/cf-customer.ts';
import {
  EmailDomainCredentialChangedError,
  refreshOauthGrantSerialized,
  revokeOauthGrantSerialized,
  withEmailDomainRowLock,
} from '../email/credential-lease.ts';
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
  SENDING_ONBOARDING_STEP,
  domainHasRoutingMx,
  removeEmailDomain,
  sendingOnboardedReadback,
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
import { emailDomains, projects, type EmailDomainSetupState } from '../schema.ts';
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
    // Parsed up-front so EVERY rejection below can revoke a posted grant:
    // the CLI mints a fresh user-wide OAuth grant per attempt and drops its
    // only copy on an error response, so any reject without a revoke strands
    // a live broad grant in the customer's account per retry.
    const postedRefreshToken =
      typeof body.refreshToken === 'string' && body.refreshToken.length > 0
        ? body.refreshToken
        : undefined;
    // Length is checked on the RAW string before any normalization — same
    // reason as MAX_ADDRESS_LENGTH above: the 400 costs nothing, the
    // normalization and regex never run on attacker-sized input.
    if (typeof body.domain !== 'string' || body.domain.length > MAX_DOMAIN_LENGTH) {
      await revokeRejectedGrant(context, postedRefreshToken);
      return context.json({ error: 'invalid domain' }, 400);
    }
    const domain = normalizeEmailDomain(body.domain);
    if (!isValidEmailDomain(domain)) {
      await revokeRejectedGrant(context, postedRefreshToken);
      return context.json({ error: 'invalid domain' }, 400);
    }
    if (body.mode !== undefined && body.mode !== 'apex' && body.mode !== 'subdomain') {
      await revokeRejectedGrant(context, postedRefreshToken);
      return context.json({ error: 'invalid mode' }, 400);
    }
    const refreshToken = postedRefreshToken;
    const apiToken =
      typeof body.apiToken === 'string' && body.apiToken.length > 0 ? body.apiToken : undefined;
    if ((refreshToken === undefined) === (apiToken === undefined)) {
      await revokeRejectedGrant(context, postedRefreshToken);
      return context.json({ error: 'exactly one of refreshToken or apiToken is required' }, 400);
    }
    const credential = (refreshToken ?? apiToken)!;
    if (credential.length > MAX_CREDENTIAL_LENGTH) {
      await revokeRejectedGrant(context, postedRefreshToken);
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
      await revokeRejectedGrant(context, postedRefreshToken, claimed);
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

    // The insert runs under the PROJECT row's FOR UPDATE — teardown's own
    // first lock (lockAndMarkDeleting, deleteProjectCascade) — with the
    // 'deleting' verdict re-read inside it: an add admitted on the unlocked
    // entry snapshot could otherwise insert and finish setup AFTER
    // teardown's one-time cleanup enumerations ran, and the later cascade
    // would delete the row without its domain handle — the mirror, the
    // relay/catch-all in the customer account, and a fresh OAuth grant all
    // orphaned. The engine then runs in the follow-up serialized section
    // (runEmailDomainEngineSerialized), which re-takes this same lock, so
    // teardown either marks first (both transactions refuse) or runs
    // strictly after the committed setup and cleans everything it created.
    type InsertOutcome = 'inserted' | 'project_gone' | 'project_deleting';
    let outcome: InsertOutcome;
    try {
      outcome = await db.transaction(async (tx): Promise<InsertOutcome> => {
        const projectRows = await tx
          .select({ status: projects.status })
          .from(projects)
          .where(eq(projects.id, projectId))
          .for('update')
          .limit(1);
        const lockedProject = projectRows[0];
        if (!lockedProject) {
          return 'project_gone';
        }
        if (lockedProject.status === 'deleting') {
          return 'project_deleting';
        }
        await tx.insert(emailDomains).values({
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
        return 'inserted';
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost an add/add race on the domain-wide unique index. The winner
        // decides the error: another project claimed the domain, or this
        // project registered it concurrently. The transaction rolled back,
        // so the posted grant was never persisted — revoke it (the
        // decrypt-compare guard spares a re-pasted grant the winner stored).
        const winner = await getEmailDomainRowByDomain(db, domain);
        await revokeRejectedGrant(context, postedRefreshToken, winner);
        if (winner && winner.project_id !== projectId) {
          return context.json({ error: 'domain is registered to another project' }, 409);
        }
        return context.json({ error: 'domain concurrently modified, try again' }, 409);
      }
      throw err;
    }
    if (outcome !== 'inserted') {
      // Nothing was persisted — the posted grant has no handle.
      await revokeRejectedGrant(context, postedRefreshToken);
      return outcome === 'project_gone'
        ? context.json({ error: 'project not found' }, 404)
        : context.json({ error: 'Project is being deleted' }, 409);
    }

    return await runEmailDomainEngineSerialized(context, projectId, id, proxyOrigin, {
      relaySecret,
      relayEnc,
      requestedMode: body.mode,
      created: true,
    });
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
        if (err instanceof EmailDomainCredentialChangedError) {
          // A replace committed mid-probe — the probe is void, nothing
          // was written, and the fresh re-read below answers for the
          // replacement credential.
          credentialStatus = 'probe_failed';
        } else if (err instanceof OAuthGrantError && err.code === 'invalid_grant') {
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
      // Fenced on the probed credential's identity: a replace committing
      // mid-probe (renewing an expired token is the case that bites) must
      // not have the OLD credential's verdict — status flip or token
      // metadata — stamped on the NEW one. A fenced-out patch voids the
      // probe: the fresh re-read answers, and the next poll re-probes.
      const applied = await db
        .update(emailDomains)
        .set({ ...patch, updated_at: sql`now()` })
        .where(
          and(
            eq(emailDomains.id, row.id),
            eq(emailDomains.credential_kind, row.credential_kind),
            eq(emailDomains.token_ciphertext, row.token_ciphertext),
          ),
        )
        .returning({ id: emailDomains.id });
      if (applied.length === 0) {
        credentialStatus = 'probe_failed';
        probeClient = null;
      }
    }

    let fresh = await getEmailDomainRowById(db, row.id);
    if (!fresh) {
      // Project teardown's cascade can take the row mid-request.
      return context.json({ error: 'email domain not found' }, 404);
    }

    // Self-clear recorded remaining steps on observable evidence. The
    // routing-subdomain step's effect is public MX records naming
    // Cloudflare's inbound exchanges; the sending-onboarding step's is
    // the customer-credential read-back showing the subdomain onboarded
    // (a Workers Paid upgrade plus a sync, which re-attempts the POST).
    // No evidence — the probe failed or the step is genuinely undone —
    // leaves the row for the next poll. The row flips pending → active
    // only once no INBOUND-BLOCKING step (routing_subdomain) remains; a
    // sending_onboarding step rides along on an active row. Suppressed
    // while a removal failure is pending — the same doctrine as the
    // mirror repair below: the row is mid-removal, and neither its
    // status nor its setup state is this route's to rewrite.
    const probedSetupState = fresh.setup_state;
    const pendingSteps = probedSetupState?.remaining_steps;
    if (
      probedSetupState &&
      probedSetupState.failed_step !== 'remove' &&
      pendingSteps &&
      pendingSteps.length > 0
    ) {
      const cleared: Array<string> = [];
      if (
        pendingSteps.includes(ROUTING_SUBDOMAIN_STEP) &&
        (await domainHasRoutingMx(fresh.domain))
      ) {
        cleared.push(ROUTING_SUBDOMAIN_STEP);
      }
      if (
        pendingSteps.includes(SENDING_ONBOARDING_STEP) &&
        probeClient !== null &&
        fresh.zone_id !== null &&
        (await sendingOnboardedReadback(probeClient, fresh.zone_id, fresh.domain))
      ) {
        cleared.push(SENDING_ONBOARDING_STEP);
      }
      if (cleared.length > 0) {
        const keptSteps = pendingSteps.filter((step) => !cleared.includes(step));
        // Fenced on the probed state: a revocation (or a removal-failure
        // marker) landing while the evidence checks were in flight must
        // not be overwritten back to a live state — the subsequent
        // mirror repair would reauthorize inbound against it. A
        // fenced-out update voids the self-clear: the re-read answers
        // this poll, and the next poll re-proves the evidence.
        await db
          .update(emailDomains)
          .set({
            ...(fresh.status === 'pending' && !keptSteps.includes(ROUTING_SUBDOMAIN_STEP)
              ? { status: 'active' as const }
              : {}),
            setup_state: keptSteps.length > 0 ? { remaining_steps: keptSteps } : null,
            updated_at: sql`now()`,
          })
          .where(
            and(
              eq(emailDomains.id, fresh.id),
              eq(emailDomains.status, fresh.status),
              sql`${emailDomains.setup_state} IS NOT DISTINCT FROM ${JSON.stringify(probedSetupState)}::jsonb`,
            ),
          );
        fresh = await getEmailDomainRowById(db, row.id);
        if (!fresh) {
          return context.json({ error: 'email domain not found' }, 404);
        }
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
      await repairEmailDomainMirrorIfDrifted(db, context.env, fresh);
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

    // Sync redeploys the relay in place at RELAY_VERSION and rotates its
    // secret (overwrite, never read-compare — worker secrets are
    // write-only). The row and credential are re-read inside the row
    // lock, so a replace that lands while this request waits is synced
    // as the NEW credential, never verified as the superseded one.
    return syncEmailDomainAndApply(context, projectId, row.id, proxyOriginForEmail(context.env));
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

    // Remove under the row's serialized lock, with the row and credential
    // re-read inside it: a replace that commits between this request's
    // entry read and the cleanup must not have its fresh credential
    // orphaned by the row delete — the replace never invalidates an old
    // api_token, so cleanup built on a stale snapshot would SUCCEED, the
    // row would be deleted, and a newly committed oauth grant's only
    // handle would go with it (live at CF with its broad scopes,
    // revocable by nobody). The lock serializes with the replace's commit
    // and with lease refreshes; the serialized helpers take THIS tx —
    // passing the pool handle here would deadlock.
    //
    // removeEmailDomain never throws; a decrypt failure skips CF cleanup
    // entirely. A failed DESTRUCTIVE step (catch-all or relay delete)
    // KEEPS the row so the operator can retry — unless forced, or the
    // grant is already dead: token_revoked rows are always deleted (CF
    // may be unreachable and keeping buys no retry leverage — re-add is
    // the renewal path), and a 'revoke_grant'-only failure still deletes
    // (a stranded grant breaks no mail).
    type Removal =
      | Readonly<{ kind: 'removed'; failedSteps: ReadonlyArray<string> }>
      | Readonly<{ kind: 'kept'; failedSteps: ReadonlyArray<string> }>
      | Readonly<{ kind: 'vanished' }>;
    const removal: Removal = await withEmailDomainRowLock(db, row.id, async (tx) => {
      const locked = await tx
        .select()
        .from(emailDomains)
        .where(eq(emailDomains.id, row.id))
        .limit(1);
      const current = locked[0];
      if (!current) {
        // Teardown's cascade can take the row mid-request — the
        // idempotent delete branch below proceeds.
        return { kind: 'vanished' };
      }
      let failedSteps: ReadonlyArray<string>;
      try {
        const credential = await decryptEmailDomainToken(
          context.env,
          projectId,
          current.domain,
          current,
        );
        const result = await removeEmailDomain(
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
            // Refresh rotations must persist through the row's serialized
            // chain while the row lives — in the keep-row world a failed
            // removal KEEPS the row, and a bricked rotation would kill
            // the retry. The revoke likewise goes through the chain: it
            // revokes the row's LIVE head, so a lease refresh that
            // committed before this removal cannot leave a rotated grant
            // orphaned behind a 200-for-a-consumed-token.
            refreshGrant: () => refreshOauthGrantSerialized(tx, context.env, current.id),
            ...(current.credential_kind === 'oauth_grant'
              ? { revokeGrant: () => revokeOauthGrantSerialized(tx, context.env, current.id) }
              : {}),
          },
        );
        failedSteps = result.failed_steps;
      } catch (err) {
        console.error('[email] domain remove credential decrypt failed:', err);
        failedSteps = ['delete_relay', 'catch_all'];
      }

      const destructive = failedSteps.some((s) => s === 'catch_all' || s === 'delete_relay');
      // Decide on the CURRENT status, not the pre-removal snapshot: an
      // invalid_grant inside the removal's refresh persisted
      // token_revoked through THIS tx, and a now-revoked row takes the
      // unconditional-delete path exactly like one revoked before the
      // request — keeping it would leave its stale active mirror
      // accepting inbound with repair suppressed. The row cannot vanish
      // here — this tx holds its lock.
      const currentStatus = (
        await tx
          .select({ status: emailDomains.status })
          .from(emailDomains)
          .where(eq(emailDomains.id, current.id))
          .limit(1)
      )[0]?.status;
      if (destructive && !force && currentStatus !== 'token_revoked') {
        await markEmailDomainRemovalFailed(tx, current.id, failedSteps);
        return { kind: 'kept', failedSteps };
      }

      // Mirror key BEFORE the row — never destroy the record a retry
      // would re-derive the mirror from (the destinations DELETE
      // inversion). A KV failure rolls the transaction back with the row
      // intact, so the retry can finish it.
      await clearEmailDomainMirror(context.env.ROUTING, current.domain);
      await tx.delete(emailDomains).where(eq(emailDomains.id, current.id));
      return { kind: 'removed', failedSteps };
    });

    if (removal.kind === 'kept') {
      return context.json({ ok: false, removed: false, failed_steps: removal.failedSteps }, 200);
    }
    if (removal.kind === 'vanished') {
      // Teardown already cleared the mirror; the re-clear is idempotent.
      await clearEmailDomainMirror(context.env.ROUTING, row.domain);
    }
    const failedSteps = removal.kind === 'removed' ? removal.failedSteps : [];
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

async function getEmailDomainRowById(db: DbOrTx, id: string): Promise<EmailDomain | null> {
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
  db: DbOrTx,
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
 * Run one fallible statement of the serialized engine section behind a
 * savepoint, so an expected constraint violation — the first-to-persist
 * races the partial unique indexes exist to catch — aborts only that
 * statement. The transaction stays committable, keeping the row and any
 * grant rotations the engine already persisted through the row's
 * serialized chain: without this a 23505 would poison the whole
 * transaction, and the rollback would strand the rotated chain head (the
 * only copy CF issued) with no database handle, breaking the race
 * compensation's refresh-through-the-row.
 */
async function tryEmailDomainSavepoint<T>(
  tx: Tx,
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  await tx.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    const value = await fn();
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return { ok: true, value };
  } catch (err) {
    await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    return { ok: false, err };
  }
}

/**
 * Best-effort revocation of a POSTed OAuth grant the request is rejecting
 * before persistence. The CLI mints a fresh user-wide grant (zone, email
 * and workers scopes) per add attempt and drops its only copy on an error
 * response, so a rejection without a revoke strands a live broad grant in
 * the customer's account per retry. api_token credentials are out of
 * scope: user-created out-of-band, and no token-delete primitive exists.
 *
 * `holder` is the conflicting row when one is in hand: a re-pasted grant
 * equal to the row's stored credential must NOT be revoked — that would
 * brick the live row (the same guard as the replace route's
 * identical-grant skip). A holder whose credential can't be decrypted
 * fails safe toward keeping.
 */
async function revokeRejectedGrant(
  context: Context<ApiEnv>,
  refreshToken: string | undefined,
  holder?: EmailDomain | null,
): Promise<void> {
  if (refreshToken === undefined) {
    return;
  }
  if (holder) {
    let held: string | null = null;
    try {
      held = await decryptEmailDomainToken(context.env, holder.project_id, holder.domain, holder);
    } catch (err) {
      console.error('[email] rejected-grant holder decrypt failed; skipping revoke:', err);
      return;
    }
    if (held === refreshToken) {
      return;
    }
  }
  try {
    await revokeOauthGrant(refreshToken);
  } catch (err) {
    // Best-effort: the rejection stands either way, and this log line is
    // the trace an operator gets.
    console.error('[email] rejected-grant revoke failed:', err);
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
 * The sync sequence — relay redeploy, secret rotation, row apply, mirror
 * publication — under one transaction holding the project lock and then
 * the credential chain's row lock, shared by the sync route and the
 * replace path's healthy-row branch. The row lock must span the worker
 * secret PUT, the row persist, and the mirror PUT: two overlapping syncs
 * would otherwise interleave them (A-put, B-put, B-apply, A-apply) and
 * leave the worker or the mirror holding a secret the other side no
 * longer names — inbound authentication fails until the next sync. The
 * row FOR UPDATE is the lease chain's own, held across the CF calls
 * exactly like the refresh holds it across the token round-trip;
 * concurrent sends on an oauth_grant domain wait out the sync, which is
 * rare and manual.
 *
 * The row — credential included — is RE-READ inside the lock: a replace
 * that committed while this request waited for the lock is synced as its
 * new credential, never verified as the superseded one (whose expired or
 * revoked verdict would otherwise be stamped onto the replacement). The
 * mirror PUT runs inside the serialized section even though KV is not
 * transactional: a commit failure after it leaves the mirror briefly
 * ahead of the row, which the status GET's drift repair converges — the
 * inverse (publishing outside the lock) would let an older sync's hash
 * land last and break inbound auth until someone polls.
 */
async function syncEmailDomainAndApply(
  context: Context<ApiEnv>,
  projectId: string,
  rowId: string,
  proxyOrigin: string,
): Promise<Response> {
  const db = context.get('db');
  let outcome:
    | Readonly<{
        kind: 'ok';
        result: Awaited<ReturnType<typeof syncEmailDomain>>;
        applied: EmailDomain;
      }>
    | Readonly<{ kind: 'project_gone' }>
    | Readonly<{ kind: 'project_deleting' }>;
  try {
    outcome = await db.transaction(async (tx) => {
      // The project lock comes FIRST — teardown's own order
      // (lockAndMarkDeleting, deleteProjectCascade and the status route's
      // mirror-repair fence all go project → row) — so a sync serializes
      // with teardown instead of racing it. Without this recheck a sync
      // that passed the route's entry guard could redeploy the relay and
      // republish the mirror AFTER teardown cleared them, and the cascade
      // would then delete the row, leaving a recreated mirror, worker and
      // catch-all with no database handle. Holding the project lock
      // across the CF calls blocks a teardown for the duration — the same
      // tradeoff the mirror-repair fence makes, and safe: when the sync
      // commits first, teardown's later clear/remove/cascade sees
      // everything it created.
      const projectRows = await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const project = projectRows[0];
      if (!project) {
        return { kind: 'project_gone' } as const;
      }
      if (project.status === 'deleting') {
        return { kind: 'project_deleting' } as const;
      }
      // The row lock is the lease chain's own FOR UPDATE — refreshes,
      // revokes, replaces and removals serialize on it exactly as before.
      const locked = await tx
        .select()
        .from(emailDomains)
        .where(eq(emailDomains.id, rowId))
        .for('update')
        .limit(1);
      const current = locked[0];
      if (!current) {
        // Teardown's cascade can take the row while this request waited
        // on the lock.
        throw new Error('email_domains row vanished mid-sync');
      }
      const { result, applied } = await syncEmailDomainLocked(
        context,
        tx,
        projectId,
        current,
        proxyOrigin,
      );
      return { kind: 'ok', result, applied } as const;
    });
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

  if (outcome.kind === 'project_gone') {
    return context.json({ error: 'project not found' }, 404);
  }
  if (outcome.kind === 'project_deleting') {
    return context.json({ error: 'Project is being deleted' }, 409);
  }
  return context.json(
    {
      ...serializeEmailDomain(outcome.applied, outcome.result.error),
      ...(outcome.result.catch_all === undefined ? {} : { catch_all: outcome.result.catch_all }),
    },
    200,
  );
}

/**
 * The sync sequence's locked core, shared by syncEmailDomainAndApply and
 * the serialized engine section's healthy-row branch. Callers hold the
 * project lock and the row's FOR UPDATE; `current` is the row as re-read
 * under those locks — credential included, so a replace that committed
 * while the caller waited is synced as its new credential.
 */
async function syncEmailDomainLocked(
  context: Context<ApiEnv>,
  tx: Tx,
  projectId: string,
  current: EmailDomain,
  proxyOrigin: string,
): Promise<{
  result: Awaited<ReturnType<typeof syncEmailDomain>>;
  applied: EmailDomain;
}> {
  const domain = current.domain;
  const credential = await decryptEmailDomainToken(context.env, projectId, domain, current);
  const result = await syncEmailDomain(
    {
      row: {
        domain,
        credential_kind: current.credential_kind,
        account_id: current.account_id,
        relay_worker_name: current.relay_worker_name,
        zone_id: current.zone_id,
        // Lets sync re-attempt a pending sending onboarding (a
        // Workers Paid upgrade) and report the cleared step.
        setup_remaining_steps: current.setup_state?.remaining_steps,
      },
      credential,
      proxyOrigin,
    },
    { refreshGrant: () => refreshOauthGrantSerialized(tx, context.env, current.id) },
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
    // No rotation happened (failed before the secret PUT) — the
    // mirror still moves with the new status, hashed from the
    // existing secret.
    relaySecretSha256 = await hashEmailRelaySecret(
      await decryptEmailDomainRelaySecret(context.env, projectId, domain, current),
    );
  }
  // A successful sync does not clear a pending human step on its own:
  // the engine cannot observe the routing-subdomain dashboard form,
  // so remaining_steps survive — minus any the sync itself cleared
  // (the sending-onboarding retry). The row stays 'pending' only
  // while an INBOUND-BLOCKING step (routing_subdomain) remains; a
  // sending_onboarding step rides along on an active row.
  const keptSteps = current.setup_state?.remaining_steps?.filter(
    (step) => !(result.cleared_steps ?? []).includes(step),
  );
  const setupState: EmailDomainSetupState | null =
    result.setup_state !== null
      ? result.setup_state
      : keptSteps && keptSteps.length > 0
        ? { remaining_steps: keptSteps }
        : null;
  const status: EmailDomain['status'] =
    result.status === 'active' && setupState?.remaining_steps?.includes(ROUTING_SUBDOMAIN_STEP)
      ? 'pending'
      : result.status;
  const appliedRows = await tx
    .update(emailDomains)
    .set({
      status,
      relay_version: result.relay_version,
      setup_state: setupState,
      ...relayPatch,
      updated_at: sql`now()`,
    })
    .where(eq(emailDomains.id, current.id))
    .returning();
  const applied = appliedRows[0];
  if (!applied) {
    throw new Error('email_domains row vanished mid-sync');
  }
  // Mirror publication stays inside the serialized section: an
  // overlapping sync publishes its own rotation behind this lock, so
  // hashes land in the same order the secrets were written to the worker.
  await writeEmailDomainMirror(context.env.ROUTING, applied, relaySecretSha256);
  return { result, applied };
}

/**
 * The serialized engine section shared by the add route (after its insert
 * transaction) and the replace route (after its credential commit). Both
 * locks are held across the engine's CF calls, the apply, and the mirror
 * publication: the PROJECT row FOR UPDATE first — teardown's own order
 * (lockAndMarkDeleting, deleteProjectCascade and the status route's
 * mirror-repair fence all go project → row) — then the credential chain's
 * row FOR UPDATE. The project fence gives a total order with teardown:
 * either teardown marked first (this refuses) or this commits first and
 * teardown's later cleanup sees everything the engine created — an
 * unfenced setup could otherwise finish AFTER teardown's one-time
 * enumerations ran, and the cascade would delete the row without its
 * domain handle, orphaning the mirror, the relay/catch-all in the
 * customer account, and a fresh OAuth grant.
 *
 * The row — credential and recorded progress included — is RE-READ under
 * the lock, and the branch is decided there: a COMPLETE row takes the
 * sync path (redeploy in place + relay-secret rotation); an incomplete
 * one re-runs the full engine seeded from the locked row. The row lock
 * serializes concurrent full-setup retries: without it two of them could
 * upload DIFFERENT relay secrets to the same relay and then apply their
 * rows/mirrors in the opposite order — the worker holding secret B while
 * KV expects A, rejecting every inbound message — or strand competing
 * relay names.
 *
 * The fallible row writes (deploy checkpoint, final apply) run behind
 * savepoints (tryEmailDomainSavepoint) so their expected 23505s abort
 * only the one statement: the transaction then COMMITS the row and the
 * engine's grant rotations, and the loser compensation below works
 * through the row's live chain head exactly as it did when every write
 * autocommitted. Holding the project lock across the CF calls blocks a
 * teardown for the duration — the same tradeoff sync and the
 * mirror-repair fence make.
 */
async function runEmailDomainEngineSerialized(
  context: Context<ApiEnv>,
  projectId: string,
  rowId: string,
  proxyOrigin: string,
  opts: Readonly<{
    relaySecret: string;
    relayEnc: { ciphertext: string; iv: string; keyVersion: string };
    requestedMode: unknown;
    created: boolean;
  }>,
): Promise<Response> {
  const db = context.get('db');
  const { relaySecret, relayEnc, requestedMode, created } = opts;
  // Captured BEFORE each checkpoint write: a 23505 throw still needs the
  // progress payload for compensation below.
  let checkpoint: {
    zone_id: string | null;
    account_id: string | null;
    mode: 'apex' | 'subdomain' | null;
    relay_worker_name: string;
  } | null = null;
  type EngineOutcome =
    | Readonly<{
        kind: 'ok_sync';
        result: Awaited<ReturnType<typeof syncEmailDomain>>;
        applied: EmailDomain;
      }>
    | Readonly<{ kind: 'ok_setup'; result: EmailDomainSetupResult; applied: EmailDomain }>
    | Readonly<{ kind: 'project_gone' }>
    | Readonly<{ kind: 'project_deleting' }>
    | Readonly<{ kind: 'row_gone' }>
    | Readonly<{
        kind: 'engine_failed';
        err: unknown;
        race: { credentialKind: EmailDomain['credential_kind']; credential: string };
      }>
    | Readonly<{
        kind: 'apply_failed';
        err: unknown;
        result: EmailDomainSetupResult;
        race: { credentialKind: EmailDomain['credential_kind']; credential: string };
      }>;
  let outcome: EngineOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<EngineOutcome> => {
      const projectRows = await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedProject = projectRows[0];
      if (!lockedProject) {
        return { kind: 'project_gone' } as const;
      }
      if (lockedProject.status === 'deleting') {
        return { kind: 'project_deleting' } as const;
      }
      // The row lock is the lease chain's own FOR UPDATE — refreshes,
      // revokes, replaces and removals serialize on it exactly as before.
      const locked = await tx
        .select()
        .from(emailDomains)
        .where(eq(emailDomains.id, rowId))
        .for('update')
        .limit(1);
      const current = locked[0];
      if (!current) {
        // An owner DELETE (or the admin revoke) took the row while this
        // request waited on the lock; its cleanup owned the credential.
        return { kind: 'row_gone' } as const;
      }

      // Sync keeps a healthy row healthy; anything that never finished
      // setup re-runs the full engine. A catch-all failure is the one
      // 'failed' shape that still carries relay_worker_name/account_id —
      // it must NOT take the sync path, which never writes the catch-all.
      const setupIncomplete =
        current.status === 'failed' || !current.relay_worker_name || !current.account_id;
      if (!setupIncomplete) {
        const { result, applied } = await syncEmailDomainLocked(
          context,
          tx,
          projectId,
          current,
          proxyOrigin,
        );
        return { kind: 'ok_sync', result, applied } as const;
      }

      // Setup never finished — re-run the full engine with a fresh relay
      // secret, carrying the row's recorded progress so completed steps
      // are idempotent (mode skips the MX check; a relay name redeploys in
      // place; 'already done' 4xx is believed only on a confirming
      // read-back).
      const domain = current.domain;
      const credential = await decryptEmailDomainToken(context.env, projectId, domain, current);
      const race = { credentialKind: current.credential_kind, credential };
      let result: EmailDomainSetupResult | null = null;
      let engineError: unknown = null;
      try {
        result = await setupEmailDomain(
          {
            row: {
              domain,
              credential_kind: current.credential_kind,
              ...(current.mode === null ? {} : { mode: current.mode }),
              ...(current.relay_worker_name === null
                ? {}
                : { relay_worker_name: current.relay_worker_name }),
              ...(current.zone_id === null ? {} : { zone_id: current.zone_id }),
              ...(current.account_id === null ? {} : { account_id: current.account_id }),
            },
            credential,
            relaySecret,
            proxyOrigin,
          },
          {
            refreshGrant: () => refreshOauthGrantSerialized(tx, context.env, current.id),
            persistProgress: async (progress) => {
              // Capture BEFORE the write: a 23505 throw still needs the
              // checkpoint for compensation below. The savepoint keeps the
              // transaction committable (see tryEmailDomainSavepoint).
              checkpoint = progress;
              const write = await tryEmailDomainSavepoint(tx, 'void_email_deploy_checkpoint', () =>
                applyEmailDomainDeployCheckpoint(tx, current!.id, progress),
              );
              if (!write.ok) {
                throw write.err;
              }
            },
          },
        );
      } catch (err) {
        // The savepoint already rolled the failed statement back, so the
        // transaction can still commit the row and the engine's grant
        // rotations — the compensation outside then refreshes through the
        // row's live chain head.
        engineError = err;
      }
      if (result === null) {
        return { kind: 'engine_failed', err: engineError, race } as const;
      }
      const applied = await tryEmailDomainSavepoint(tx, 'void_email_apply', () =>
        applyEmailDomainSetupResult(tx, current.id, result, relayEnc),
      );
      if (!applied.ok) {
        return { kind: 'apply_failed', err: applied.err, result, race } as const;
      }
      // Mirror AFTER the row is final, and inside the serialized section:
      // an overlapping retry publishes its own setup behind this lock, so
      // hashes land in the same order the secrets were written to the
      // worker.
      await writeEmailDomainMirror(
        context.env.ROUTING,
        applied.value,
        await hashEmailRelaySecret(relaySecret),
      );
      return { kind: 'ok_setup', result, applied: applied.value } as const;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // NO compensation here — the sync branch deployed in place on the
      // row's OWN relay, so the 409 just refuses the live-status flip: a
      // 'failed' row carrying its zone can collide with the winner when
      // sync flips it back to a live status.
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

  if (outcome.kind === 'project_gone') {
    return context.json({ error: 'project not found' }, 404);
  }
  if (outcome.kind === 'project_deleting') {
    return context.json({ error: 'Project is being deleted' }, 409);
  }
  if (outcome.kind === 'row_gone') {
    return context.json({ error: 'email domain not found' }, 404);
  }
  if (outcome.kind === 'engine_failed') {
    const err = outcome.err;
    if (isUniqueViolation(err) && checkpoint !== null) {
      const conflict = await compensateEmailDomainRace(
        context,
        rowId,
        outcome.race,
        checkpoint,
        err,
      );
      return context.json({ error: conflict }, 409);
    }
    // Any other checkpoint failure leaves the deployed relay unreferenced
    // (the savepoint rolled the UPDATE back): compensate from the captured
    // checkpoint before propagating.
    if (checkpoint !== null) {
      await compensateCheckpointDeploy(context, rowId, outcome.race, checkpoint, {
        rowGone: err instanceof EmailDomainRowGoneError,
      });
    }
    if (err instanceof EmailDomainRowGoneError) {
      return context.json({ error: 'project is being deleted' }, 409);
    }
    throw err;
  }
  if (outcome.kind === 'apply_failed') {
    const { err, result } = outcome;
    if (isUniqueViolation(err)) {
      // The concurrent-setup backstop (the schema's partial unique
      // indexes): two setups racing one zone (or one account's relay name)
      // both pass the engine's CF-side reads, so the loser is caught here
      // — a 409, never a falsely-active second row. The row stays in its
      // pre-apply state; the loser's CF-side work is compensated
      // best-effort inside.
      const conflict = await compensateEmailDomainRace(
        context,
        rowId,
        outcome.race,
        {
          zone_id: result.zone_id,
          account_id: result.account_id,
          relay_worker_name: result.relay_worker_name,
        },
        err,
      );
      return context.json({ error: conflict }, 409);
    }
    // A NON-unique apply failure after the engine deployed CF-side: the
    // savepoint makes the apply decisively uncommitted, so the
    // possibly-deployed relay is compensated best-effort — no orphan
    // worker for a zone the row never recorded. Nothing to clean when
    // setup failed before the deploy.
    if (result.relay_worker_name !== null) {
      try {
        // Not a name race — the loser owns its relay, so the compensation
        // runs with the result's OWN account_id (not nulled).
        await removeEmailDomain(
          {
            row: {
              credential_kind: outcome.race.credentialKind,
              account_id: result.account_id,
              relay_worker_name: result.relay_worker_name,
              zone_id: result.zone_id,
            },
            credential: outcome.race.credential,
          },
          {
            // Same single-use refresh doctrine as the race compensation.
            refreshGrant: () => refreshOauthGrantSerialized(context.get('db'), context.env, rowId),
          },
        );
      } catch (compErr) {
        console.error('[email] orphan compensation failed:', compErr);
      }
    }
    throw err;
  }
  if (outcome.kind === 'ok_sync') {
    return context.json(
      {
        ...serializeEmailDomain(outcome.applied, outcome.result.error),
        ...(outcome.result.catch_all === undefined ? {} : { catch_all: outcome.result.catch_all }),
      },
      200,
    );
  }
  const { result, applied: row } = outcome;
  if (requestedMode !== undefined && row.mode !== null && requestedMode !== row.mode) {
    return context.json(
      {
        error: `requested mode ${String(requestedMode)} but ${row.domain} is ${row.mode} on its zone`,
        domain: serializeEmailDomain(row, result.error),
      },
      409,
    );
  }
  return context.json(serializeEmailDomain(row, result.error), created ? 201 : 200);
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
 * Both branches run inside runEmailDomainEngineSerialized, decided on the
 * LOCKED row.
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
  const tokenEnc = await encryptEmailDomainToken(context.env, projectId, domain, credential);
  // Capture the old grant's CURRENT chain head and commit the replacement
  // under one row lock: an interleaved lease refresh between an unlocked
  // capture and the commit would rotate the old grant, the commit would
  // overwrite the rotated head it persisted, and the revoke below would
  // submit the already-consumed token — CF answers 200 either way, so the
  // live chain head would be orphaned with no database handle. After the
  // commit the row holds the NEW credential, so no old-chain rotation can
  // follow.
  let oldGrantRefreshToken: string | null = null;
  type SwapOutcome = 'swapped' | 'project_gone' | 'project_deleting' | 'row_gone';
  const swap: SwapOutcome = await db.transaction(async (tx): Promise<SwapOutcome> => {
    // The PROJECT row lock comes first — teardown's own order — with the
    // 'deleting' verdict re-read under it: a replace admitted on the
    // route's unlocked entry read could otherwise commit a fresh grant
    // AFTER teardown's one-time cleanup enumeration ran, and the cascade
    // would then delete the row with the new grant's only handle.
    const projectRows = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    const lockedProject = projectRows[0];
    if (!lockedProject) {
      return 'project_gone';
    }
    if (lockedProject.status === 'deleting') {
      return 'project_deleting';
    }
    const locked = await tx
      .select({
        credential_kind: emailDomains.credential_kind,
        token_ciphertext: emailDomains.token_ciphertext,
        token_iv: emailDomains.token_iv,
        token_key_version: emailDomains.token_key_version,
      })
      .from(emailDomains)
      .where(eq(emailDomains.id, existing.id))
      .for('update')
      .limit(1);
    const current = locked[0];
    if (!current) {
      return 'row_gone';
    }
    if (current.credential_kind === 'oauth_grant') {
      try {
        oldGrantRefreshToken = await decryptEmailDomainToken(context.env, projectId, domain, {
          token_ciphertext: current.token_ciphertext,
          token_iv: current.token_iv,
          token_key_version: current.token_key_version,
        });
      } catch (err) {
        console.error('[email] old grant decrypt failed; skipping revoke:', err);
      }
    }
    await tx
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
    return 'swapped';
  });
  if (swap !== 'swapped') {
    // Nothing was persisted — the posted grant has no handle. Against a
    // deleting project the holder guard spares a re-pasted grant the row
    // still stores: teardown's cleanup revokes that one itself.
    await revokeRejectedGrant(
      context,
      credentialKind === 'oauth_grant' ? credential : undefined,
      swap === 'project_deleting' ? existing : null,
    );
    return swap === 'project_gone'
      ? context.json({ error: 'project not found' }, 404)
      : swap === 'project_deleting'
        ? context.json({ error: 'Project is being deleted' }, 409)
        : context.json({ error: 'email domain not found' }, 404);
  }

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

  // The branch decision — sync a healthy row, or re-run the full engine
  // on one that never finished setup — is made inside the serialized
  // section on the LOCKED row: two concurrent retries would otherwise run
  // setupEmailDomain outside any lock, upload different relay secrets to
  // the same relay, and apply their rows/mirrors in the opposite order
  // (the worker holding secret B while KV expects A).
  const relaySecret = generateEmailRelaySecret();
  const relayEnc = await encryptEmailDomainRelaySecret(context.env, projectId, domain, relaySecret);
  return await runEmailDomainEngineSerialized(context, projectId, existing.id, proxyOrigin, {
    relaySecret,
    relayEnc,
    requestedMode,
    created: false,
  });
}

/** True when the stored mirror already matches the row + hash exactly. */
async function emailDomainMirrorMatches(
  kv: KVNamespace,
  row: EmailDomain,
  relaySecretSha256: string,
): Promise<boolean> {
  const raw = await kv.get(emailDomainMirrorKey(row.domain));
  if (raw === null) {
    return false;
  }
  try {
    const mirror = JSON.parse(raw) as Partial<EmailDomainMirror>;
    return (
      mirror.projectId === row.project_id &&
      mirror.status === row.status &&
      mirror.relaySecretSha256 === relaySecretSha256 &&
      mirror.relayWorkerName === row.relay_worker_name &&
      mirror.accountId === row.account_id &&
      mirror.zoneId === row.zone_id &&
      mirror.mode === row.mode
    );
  } catch {
    // Unparseable mirror — rewrite.
    return false;
  }
}

/**
 * The status GET's mirror repair — the same read-compare-write self-heal
 * shape as the allowlist listing (`projectAllowlistKvDiffers`): rewrite
 * only on a real difference, so polling never amplifies into KV writes.
 *
 * The write is fenced against project teardown: the mirror is
 * authorization material, and once the cascade takes the row nothing
 * sweeps the key. Holding `SELECT … FOR UPDATE` on the PROJECT row across
 * the KV put gives a total order with teardown's 'deleting' flip and its
 * cascade (both take the same lock): either they committed first — the
 * project reads deleting or gone, or the domain row is cascaded away —
 * and the write is skipped, or this write lands first and teardown's own
 * mirror clear removes it. Without the fence, a status poll admitted
 * before teardown could recreate an active mirror after teardown cleared
 * it, re-authorizing a possibly-stranded relay with no row left to retry
 * from.
 *
 * The payload is derived from the DOMAIN row re-read under FOR UPDATE —
 * in project→domain order, the same order sync takes both — never from
 * the caller's unlocked snapshot. A sync that rotated the relay secret,
 * or a lease that persisted token_revoked, while this poll was between
 * its entry read and this transaction would otherwise have its committed
 * state overwritten by the stale snapshot: the mirror would go back to
 * the pre-rotation hash (inbound rejects every message) or back to
 * active (re-authorizing a revoked credential). The drift check also
 * re-runs against the locked row — the mirror may have converged while
 * this transaction waited on the locks, and the write stays repair-only.
 */
async function repairEmailDomainMirrorIfDrifted(
  db: Db,
  env: Pick<
    ApiEnv['Bindings'],
    'ROUTING' | 'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
  >,
  row: EmailDomain,
): Promise<void> {
  const relaySecretSha256 = await hashEmailRelaySecret(
    await decryptEmailDomainRelaySecret(env, row.project_id, row.domain, row),
  );
  if (await emailDomainMirrorMatches(env.ROUTING, row, relaySecretSha256)) {
    return;
  }
  await db.transaction(async (tx) => {
    const lockedProject = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, row.project_id))
      .for('update')
      .limit(1);
    if (!lockedProject[0] || lockedProject[0].status === 'deleting') {
      return;
    }
    const locked = await tx
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.id, row.id))
      .for('update')
      .limit(1);
    const current = locked[0];
    if (!current) {
      return;
    }
    const currentSha256 = await hashEmailRelaySecret(
      await decryptEmailDomainRelaySecret(env, current.project_id, current.domain, current),
    );
    if (await emailDomainMirrorMatches(env.ROUTING, current, currentSha256)) {
      return;
    }
    await writeEmailDomainMirror(env.ROUTING, current, currentSha256);
  });
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
