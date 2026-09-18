/**
 * Custom email domains on the customer's own Cloudflare zone — the
 * orchestration around `relay-engine.ts` (design doc 0078, "Custom domains
 * on Cloudflare" and "Administrator-managed domains").
 *
 * Two surfaces call into this module and must never diverge: the owner
 * routes (`routes/email.ts`, guarded by project ownership) and the operator
 * API + admin UI (an administrator acting on any project). Everything that
 * touches the `email_domains` row, its encrypted triples, the ROUTING KV
 * mirror the proxy reads, or the customer's Cloudflare account lives here,
 * so the serialized sections, checkpoints and compensations documented in
 * the design record have exactly one implementation.
 *
 * Functions keep the Hono `Context` because their results are the owner
 * routes' responses; the operator layer reads those responses back and
 * re-shapes them.
 */

import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db, DbOrTx, Tx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { isUniqueViolation, uniqueViolationConstraintName } from '../pg-errors.ts';
import { emailDomains, projects, type EmailDomainSetupState } from '../schema.ts';
import type { Project } from '../types.ts';
import { OAuthGrantError, createCfCustomerClient, revokeOauthGrant } from './cf-customer.ts';
import type { CfCustomerClient } from './cf-customer.ts';
import {
  EmailDomainCredentialChangedError,
  refreshOauthGrantSerialized,
  revokeOauthGrantSerialized,
  withEmailDomainRowLock,
} from './credential-lease.ts';
import { MAX_DOMAIN_LENGTH, isValidEmailDomain, normalizeEmailDomain } from './domain-name.ts';
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
} from './domains.ts';
import {
  ROUTING_SUBDOMAIN_STEP,
  SENDING_ONBOARDING_STEP,
  domainHasRoutingMx,
  removeEmailDomain,
  sendingOnboardedReadback,
  setupEmailDomain,
  syncEmailDomain,
  type EmailDomainSetupResult,
} from './relay-engine.ts';
import { RELAY_VERSION } from './relay-worker.ts';

/**
 * Cap for a posted credential, checked on the RAW string before any
 * normalization (the domain cap is `MAX_DOMAIN_LENGTH`). Generous for either
 * kind (a pasted API token is ~50 chars; an OAuth refresh token a few
 * hundred) and exists only to bound the encrypt + CF call work.
 */
export const MAX_CREDENTIAL_LENGTH = 2048;

export type EmailDomainAddInput = Readonly<{
  /** The raw domain as posted; normalized and validated here. */
  domain: string;
  mode?: unknown;
  refreshToken?: string;
  apiToken?: string;
  attemptId?: unknown;
  /**
   * Who is registering. An `admin` caller may omit both credentials, in
   * which case the row runs on the platform's runtime token
   * (`credential_kind: 'platform'`) and the zone must be in the platform's
   * own Cloudflare account.
   */
  managedBy: EmailDomain['managed_by'];
}>;

/** The administrator command an owner is pointed at when a row is not theirs to change. */
export function adminEmailDomainCommand(
  verb: 'add' | 'sync' | 'remove',
  domain: string,
  slug?: string,
): string {
  const base = `void platform email domain-${verb} ${domain}`;
  return verb === 'add' && slug ? `${base} --project ${slug}` : base;
}

/**
 * Who may change a row. An owner touching an administrator's row is pointed
 * at the operator command (403) for every verb — the row runs on the
 * platform's credential. An administrator may sync or remove an owner's
 * row (the ownership table's maintenance powers) but never re-`add` it: a
 * takeover would revoke the owner's grant and flip the row (409). `null`
 * when allowed. Callers run this on the unlocked read for the message and
 * AGAIN on the locked row, because either side can commit in between.
 */
function refuseCrossOwnership(
  context: Context<ApiEnv>,
  row: Pick<EmailDomain, 'managed_by' | 'domain'>,
  actor: EmailDomain['managed_by'],
  slug: string,
  verb: 'add' | 'sync' | 'remove' = 'add',
): Response | null {
  if (row.managed_by === actor) {
    return null;
  }
  if (actor === 'owner') {
    return context.json(
      {
        error: 'this email domain is managed by the platform administrator',
        adminCommand: adminEmailDomainCommand(verb, row.domain, slug),
      },
      403,
    );
  }
  if (verb !== 'add') {
    return null;
  }
  return context.json(
    { error: 'this email domain was registered by its project owner; ask them to remove it first' },
    409,
  );
}

/**
 * A `platform` row may only act on a zone in the platform's own account.
 * A row that has not learned its account yet passes — the engine's zone
 * lookup pins it before any write.
 */
function platformAccountAllows(
  context: Context<ApiEnv>,
  row: Pick<EmailDomain, 'account_id'>,
): boolean {
  return row.account_id === null || row.account_id === context.env.CF_ACCOUNT_ID;
}

/**
 * The proxy origin baked into the relay worker as VOID_PROXY_ORIGIN — the
 * same resolution the platform discovery document uses.
 */
export function proxyOriginForEmail(env: ApiEnv['Bindings']): string {
  const origin =
    env.PROXY_URL ??
    (env.PLATFORM_ENV === 'staging'
      ? 'https://proxy.staging.void.cloud'
      : 'https://proxy.void.cloud');
  return origin.replace(/\/+$/, '');
}

/**
 * The mirror key spelling is owned by `src/email/domains.ts` (the writer —
 * frozen for this phase); the status route's read-compare repair reads the
 * same key. A rename there must move this spelling with it.
 */
export function emailDomainMirrorKey(domain: string): string {
  return `email-domain:${domain}`;
}

export async function getEmailDomainRow(
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

export async function getEmailDomainRowById(db: DbOrTx, id: string): Promise<EmailDomain | null> {
  const rows = await db.select().from(emailDomains).where(eq(emailDomains.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Cross-project lookup: a domain is globally unique across projects
 * (`email_domains_domain_uq`), because one domain produces exactly one
 * `email-domain:<domain>` mirror key and one relay secret.
 */
export async function getEmailDomainRowByDomain(
  db: Db,
  domain: string,
): Promise<EmailDomain | null> {
  const rows = await db.select().from(emailDomains).where(eq(emailDomains.domain, domain)).limit(1);
  return rows[0] ?? null;
}

/**
 * The public shape of an email_domains row — metadata only. Neither
 * ciphertext triple nor any plaintext secret ever appears here.
 */
export function serializeEmailDomain(row: EmailDomain, error?: string) {
  return {
    id: row.id,
    domain: row.domain,
    mode: row.mode,
    status: row.status,
    credential_kind: row.credential_kind,
    managed_by: row.managed_by,
    relay_worker_name: row.relay_worker_name,
    relay_version: row.relay_version,
    token_id: row.token_id,
    token_expires_on: row.token_expires_on,
    // Always present (null when the row predates attempt identity): key
    // presence is how a reconciling CLI detects an api that stamps it.
    attemptId: row.attempt_id ?? null,
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
 * The relay-NAME branch is a safety net, not a live path: fresh setups
 * CLAIM the name on their own row (the claimRelayName dep) BEFORE any
 * upload, so a checkpoint-time relay-name 23505 is no longer reachable
 * from the setup flow — the claim itself is the only relay-name 23505
 * left, and the walk absorbs it as 'taken'. The branch stays for rows
 * written before the claim existed and as defense in depth.
 *
 * Works from what the engine RETURNED or checkpointed (the loser's row
 * still holds nulls — a claimed name is undone before this runs). A
 * relay-NAME conflict never deletes the worker —
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
export async function revokeRejectedGrant(
  context: Context<ApiEnv>,
  refreshToken: string | undefined,
  holder?: EmailDomain | null,
): Promise<void> {
  if (refreshToken === undefined) {
    return;
  }
  // A holder on the platform's credential stored no grant; nothing to
  // compare against, so the posted grant is revoked like any rejection.
  if (holder && holder.credential_kind !== 'platform') {
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
export async function syncEmailDomainAndApply(
  context: Context<ApiEnv>,
  projectId: string,
  rowId: string,
  proxyOrigin: string,
  /** Who asked; authorization runs on the locked row, where it cannot be raced. */
  actor: Readonly<{ managedBy: EmailDomain['managed_by']; projectSlug: string }>,
): Promise<Response> {
  const db = context.get('db');
  let outcome:
    | Readonly<{
        kind: 'ok';
        result: Awaited<ReturnType<typeof syncEmailDomain>>;
        applied: EmailDomain;
      }>
    | Readonly<{ kind: 'project_gone' }>
    | Readonly<{ kind: 'project_deleting' }>
    | Readonly<{ kind: 'refused'; response: Response }>;
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
      const refused =
        refuseCrossOwnership(context, current, actor.managedBy, actor.projectSlug, 'sync') ??
        refusePlatformCredentialOffAccount(context, current);
      if (refused) {
        return { kind: 'refused', response: refused } as const;
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
  if (outcome.kind === 'refused') {
    return outcome.response;
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
 * A `platform` row whose recorded account is not the platform's must not be
 * synced or re-run: that would send the runtime token to a customer account.
 * Such a row can only come from a pasted-token registration later re-added
 * on the platform credential, which the add path already refuses; this is
 * the locked-row backstop.
 */
function refusePlatformCredentialOffAccount(
  context: Context<ApiEnv>,
  row: Pick<EmailDomain, 'credential_kind' | 'account_id' | 'domain'>,
): Response | null {
  if (row.credential_kind !== 'platform') {
    return null;
  }
  // Without the runtime token there is nothing to sync with; say so rather
  // than let the credential seam's throw surface as a 500.
  if (!context.env.CF_API_TOKEN) {
    return context.json({ error: 'platform credential unavailable' }, 503);
  }
  if (platformAccountAllows(context, row)) {
    return null;
  }
  return context.json(
    {
      error: `the zone for ${row.domain} is in Cloudflare account ${row.account_id}, not the platform's; re-add it with --token-stdin and a token for that account`,
    },
    409,
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
export async function runEmailDomainEngineSerialized(
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
  // Set when the engine's name-walk claimed a relay name on the row, so
  // an engine throw can restore the row's locked pre-engine values — the
  // claim commits with this transaction even when the checkpoint's
  // savepoint rolls back, and a leaked entry would park the name while
  // pointing the row at a worker the compensation may have deleted.
  let relayNameClaimed = false;
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
    | Readonly<{ kind: 'refused'; response: Response }>
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
        const refused = refusePlatformCredentialOffAccount(context, current);
        if (refused) {
          return { kind: 'refused', response: refused } as const;
        }
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
            // The platform's own token must never be pointed at a customer
            // zone: a platform row may only register a zone in this account.
            ...(current.credential_kind === 'platform'
              ? { requireAccountId: context.env.CF_ACCOUNT_ID }
              : {}),
          },
          {
            refreshGrant: () => refreshOauthGrantSerialized(tx, context.env, current.id),
            claimRelayName: async (accountId, candidate) => {
              // Reserve (account_id, candidate) on THIS row BEFORE any CF
              // upload — first-to-claim turns the relay race into a walk
              // skip: a concurrent setup's claim of the same name blocks
              // on this uncommitted UPDATE, then 23505s past the winner's
              // commit ('taken' → the walk advances) or proceeds past its
              // rollback. The savepoint keeps a contested claim from
              // poisoning the transaction (same machinery as the
              // checkpoint).
              const claim = await tryEmailDomainSavepoint(tx, 'void_email_relay_claim', () =>
                tx
                  .update(emailDomains)
                  .set({ account_id: accountId, relay_worker_name: candidate })
                  .where(eq(emailDomains.id, current!.id)),
              );
              if (claim.ok) {
                relayNameClaimed = true;
                return 'claimed' as const;
              }
              if (isUniqueViolation(claim.err)) {
                return 'taken' as const;
              }
              throw claim.err;
            },
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
        // The engine threw AFTER a successful claim (the checkpoint's
        // 23505 or a non-race failure): restore the row's locked
        // pre-engine values so the claim doesn't outlive the setup it
        // belonged to. Before the claim existed, the checkpoint's
        // savepoint rollback left the row exactly this way.
        if (relayNameClaimed) {
          await tx
            .update(emailDomains)
            .set({
              account_id: current.account_id,
              relay_worker_name: current.relay_worker_name,
            })
            .where(eq(emailDomains.id, current.id));
        }
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
  if (outcome.kind === 'refused') {
    return outcome.response;
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
      // indexes): two setups racing one zone both pass the engine's
      // CF-side reads, so the loser is caught here — a 409, never a
      // falsely-active second row. (A relay-NAME 23505 is no longer
      // reachable from a fresh setup — the pre-upload claim absorbs it —
      // but the mapping stays as a safety net.) The row stays in its
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
  /** `null` only for the platform's own credential, which the row does not store. */
  credential: string | null,
  proxyOrigin: string,
  requestedMode: unknown,
  attemptId: string | undefined,
  managedBy: EmailDomain['managed_by'],
  projectSlug: string,
): Promise<Response> {
  const db = context.get('db');
  const domain = existing.domain;
  const tokenEnc =
    credential === null
      ? null
      : await encryptEmailDomainToken(context.env, projectId, domain, credential);
  // Capture the old grant's CURRENT chain head and commit the replacement
  // under one row lock: an interleaved lease refresh between an unlocked
  // capture and the commit would rotate the old grant, the commit would
  // overwrite the rotated head it persisted, and the revoke below would
  // submit the already-consumed token — CF answers 200 either way, so the
  // live chain head would be orphaned with no database handle. After the
  // commit the row holds the NEW credential, so no old-chain rotation can
  // follow.
  let oldGrantRefreshToken: string | null = null;
  type SwapOutcome =
    | 'swapped'
    | 'project_gone'
    | 'project_deleting'
    | 'row_gone'
    | Readonly<{ refused: Response }>;
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
        managed_by: emailDomains.managed_by,
        account_id: emailDomains.account_id,
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
    // The unlocked checks in addEmailDomainForProject again, on the locked
    // row: the other side may have committed its own add in between.
    const refused = refuseCrossOwnership(context, { ...current, domain }, managedBy, projectSlug);
    if (refused) {
      return { refused };
    }
    if (credentialKind === 'platform' && !platformAccountAllows(context, current)) {
      return {
        refused: context.json(
          {
            error: `the zone for ${domain} is in Cloudflare account ${current.account_id}, not the platform's; re-add it with --token-stdin and a token for that account`,
          },
          409,
        ),
      };
    }
    if (current.credential_kind === 'oauth_grant') {
      try {
        oldGrantRefreshToken = await decryptEmailDomainToken(context.env, projectId, domain, {
          credential_kind: current.credential_kind,
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
        token_ciphertext: tokenEnc?.ciphertext ?? null,
        token_iv: tokenEnc?.iv ?? null,
        token_key_version: tokenEnc?.keyVersion ?? null,
        managed_by: managedBy,
        // Re-derived by the engine for api_token; grants carry neither.
        token_id: null,
        token_expires_on: null,
        attempt_id: attemptId ?? null,
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
      credentialKind === 'oauth_grant' && credential !== null ? credential : undefined,
      swap === 'project_deleting' ? existing : null,
    );
    if (typeof swap === 'object') {
      return swap.refused;
    }
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
export async function repairEmailDomainMirrorIfDrifted(
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

// ---------------------------------------------------------------------------
// The four operations, shared by the owner routes and the operator surfaces.
// Callers have already resolved and guarded the project (ownership for
// owners; any project for an administrator). Every rejection of an add that
// carried an OAuth grant revokes it first — the CLI mints a fresh user-wide
// grant per attempt and drops its only copy on any error response.
// ---------------------------------------------------------------------------

export async function addEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  input: EmailDomainAddInput,
): Promise<Response> {
  const projectId = project.id;
  const postedRefreshToken =
    typeof input.refreshToken === 'string' && input.refreshToken.length > 0
      ? input.refreshToken
      : undefined;
  // Same teardown guard the destinations POST uses — after the parse, so it
  // too can revoke the stranded grant.
  if (project.status === 'deleting') {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'Project is being deleted' }, 409);
  }
  // Length is checked on the RAW string before any normalization — same
  // reason as the destinations route's address cap: the 400 costs nothing,
  // the normalization and regex never run on attacker-sized input.
  if (typeof input.domain !== 'string' || input.domain.length > MAX_DOMAIN_LENGTH) {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'invalid domain' }, 400);
  }
  const domain = normalizeEmailDomain(input.domain);
  if (!isValidEmailDomain(domain)) {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'invalid domain' }, 400);
  }
  if (input.mode !== undefined && input.mode !== 'apex' && input.mode !== 'subdomain') {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'invalid mode' }, 400);
  }
  // Optional attempt identity from the CLI: when present it is stamped on
  // the row so a CLI that lost this POST's answer can recognize its own
  // commit.
  if (
    input.attemptId !== undefined &&
    (typeof input.attemptId !== 'string' ||
      input.attemptId.length < 1 ||
      input.attemptId.length > 128)
  ) {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'invalid attemptId' }, 400);
  }
  const attemptId = input.attemptId as string | undefined;
  const refreshToken = postedRefreshToken;
  const apiToken =
    typeof input.apiToken === 'string' && input.apiToken.length > 0 ? input.apiToken : undefined;
  if (refreshToken !== undefined && apiToken !== undefined) {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'exactly one of refreshToken or apiToken is required' }, 400);
  }
  // An owner must bring a credential. An administrator who brings none
  // registers the zone on the platform's own runtime token — valid only for
  // a zone in the platform's account, which the engine enforces.
  let credentialKind: EmailDomain['credential_kind'];
  let credential: string | null;
  if (refreshToken !== undefined) {
    credentialKind = 'oauth_grant';
    credential = refreshToken;
  } else if (apiToken !== undefined) {
    credentialKind = 'api_token';
    credential = apiToken;
  } else if (input.managedBy === 'admin') {
    if (!context.env.CF_API_TOKEN) {
      return context.json({ error: 'platform credential unavailable' }, 503);
    }
    credentialKind = 'platform';
    credential = null;
  } else {
    return context.json({ error: 'exactly one of refreshToken or apiToken is required' }, 400);
  }
  if (credential !== null && credential.length > MAX_CREDENTIAL_LENGTH) {
    await revokeRejectedGrant(context, postedRefreshToken);
    return context.json({ error: 'invalid credential' }, 400);
  }
  const db = context.get('db');
  const proxyOrigin = proxyOriginForEmail(context.env);

  const existing = await getEmailDomainRow(db, projectId, domain);
  if (existing) {
    // Neither side re-runs the other's row. An administrator's row runs on
    // the platform's credential, which a replace would swap for the owner's
    // grant; an owner's row holds the owner's credential, which an
    // administrator's re-add would revoke while flipping the row to admin.
    // Both are re-checked under the row lock in replaceEmailDomainCredential.
    const refused = refuseCrossOwnership(context, existing, input.managedBy, project.slug);
    if (refused) {
      await revokeRejectedGrant(context, postedRefreshToken);
      return refused;
    }
    // The platform's own token must never be pointed at a customer zone: a
    // row that learned a foreign account (registered with a pasted token)
    // cannot be re-run on the platform credential, and refusing here keeps
    // the stored token in place.
    if (credentialKind === 'platform' && !platformAccountAllows(context, existing)) {
      return context.json(
        {
          error: `the zone for ${domain} is in Cloudflare account ${existing.account_id}, not the platform's; re-add it with --token-stdin and a token for that account`,
        },
        409,
      );
    }
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
      input.mode,
      attemptId,
      input.managedBy,
      project.slug,
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
  const tokenEnc =
    credential === null
      ? null
      : await encryptEmailDomainToken(context.env, projectId, domain, credential);
  const relayEnc = await encryptEmailDomainRelaySecret(context.env, projectId, domain, relaySecret);
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
        managed_by: input.managedBy,
        attempt_id: attemptId ?? null,
        token_ciphertext: tokenEnc?.ciphertext ?? null,
        token_iv: tokenEnc?.iv ?? null,
        token_key_version: tokenEnc?.keyVersion ?? null,
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
    requestedMode: input.mode,
    created: true,
  });
}

export async function getEmailDomainStatusForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
): Promise<Response> {
  const projectId = project.id;
  const domain = normalizeEmailDomain(rawDomain);
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
  if (row.credential_kind === 'platform') {
    // The runtime token is not a user token, so /user/tokens/verify does
    // not describe it; the probe is a zone-scoped read the token needs for
    // every later step. A refusal reads probe_failed — never token_revoked
    // or token_expired, which describe a stored credential's lifecycle.
    try {
      const client = createCfCustomerClient(
        await decryptEmailDomainToken(context.env, projectId, row.domain, row),
      );
      if (row.zone_id !== null) {
        await client.getRoutingSettings(row.zone_id);
      } else if ((await client.findZone(row.domain)) === null) {
        throw new Error(`the platform credential cannot see a zone for ${row.domain}`);
      }
      credentialStatus = 'active';
      probeClient = client;
    } catch (err) {
      console.error('[email] platform credential probe failed:', err);
      credentialStatus = 'probe_failed';
    }
  } else if (row.credential_kind === 'api_token') {
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
          // A platform row stores no ciphertext; `= NULL` would never match.
          row.token_ciphertext === null
            ? isNull(emailDomains.token_ciphertext)
            : eq(emailDomains.token_ciphertext, row.token_ciphertext),
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
    if (pendingSteps.includes(ROUTING_SUBDOMAIN_STEP) && (await domainHasRoutingMx(fresh.domain))) {
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
  let catchAll: 'points_here' | 'points_elsewhere' | 'missing' | 'disabled' | 'unknown' = 'unknown';
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
}

export async function syncEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  /** Who asked: an owner may not touch an administrator's row, and vice versa. */
  actor: EmailDomain['managed_by'],
): Promise<Response> {
  const projectId = project.id;
  // Sync mutates CF state and the row — same teardown guard as add/remove.
  if (project.status === 'deleting') {
    return context.json({ error: 'Project is being deleted' }, 409);
  }
  const domain = normalizeEmailDomain(rawDomain);
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
  return syncEmailDomainAndApply(context, projectId, row.id, proxyOriginForEmail(context.env), {
    managedBy: actor,
    projectSlug: project.slug,
  });
}

export async function removeEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  force: boolean,
  /** Who asked: an owner may not touch an administrator's row, and vice versa. */
  actor: EmailDomain['managed_by'],
): Promise<Response> {
  const projectId = project.id;
  if (project.status === 'deleting') {
    return context.json({ error: 'Project is being deleted' }, 409);
  }
  const domain = normalizeEmailDomain(rawDomain);
  const db = context.get('db');
  const row = await getEmailDomainRow(db, projectId, domain);
  if (!row) {
    return context.json({ error: 'email domain not found' }, 404);
  }
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
    | Readonly<{ kind: 'vanished' }>
    | Readonly<{ kind: 'refused'; response: Response }>;
  const removal: Removal = await withEmailDomainRowLock(db, row.id, async (tx) => {
    const locked = await tx.select().from(emailDomains).where(eq(emailDomains.id, row.id)).limit(1);
    const current = locked[0];
    if (!current) {
      // Teardown's cascade can take the row mid-request — the
      // idempotent delete branch below proceeds.
      return { kind: 'vanished' };
    }
    // Authorization on the LOCKED row: the other side may have committed
    // its own add between this request's entry read and the lock.
    const refused = refuseCrossOwnership(context, current, actor, project.slug, 'remove');
    if (refused) {
      return { kind: 'refused', response: refused };
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

  if (removal.kind === 'refused') {
    return removal.response;
  }
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
}
