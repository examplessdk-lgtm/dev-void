/**
 * Credential lease + OAuth refresh chain for `email_domains` (design doc
 * 0078, contract 4). The proxy never holds a domain's stored credential —
 * it leases a short-lived one from the api (`POST
 * /internal/email/domain-credential`, routes/internal-email.ts):
 *
 *   api_token   → the stored token itself, decrypted (it is long-lived;
 *                 the proxy caches it ≤ 45 min).
 *   oauth_grant → a fresh access token from ONE refresh round-trip.
 *
 * Grant refresh tokens are single-use and rotate, so the refresh chain is
 * SERIALIZED PER ROW: a `SELECT … FOR UPDATE` on the domain row (the same
 * row-level pattern the deploy/build claims use in db.ts) held across the
 * token-endpoint call, with the rotated refresh token re-encrypted and
 * persisted in the SAME transaction. Revocations take the same lock so they
 * always target the live chain head (`revokeOauthGrantSerialized`), and the
 * relay-secret rotation serializes on it too (`withEmailDomainRowLock`).
 * There is no access-token cache on the
 * api side — every lease refreshes. `invalid_grant` marks the row
 * `token_revoked` inside the transaction, before the error travels.
 *
 * Credential material is never logged or interpolated into errors; the
 * lease leaves this module only as the lease route's response body.
 */

import { eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx, Tx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { emailDomains } from '../schema.ts';
import { OAuthGrantError, refreshOauthGrant, revokeOauthGrant } from './cf-customer.ts';
import type { OauthGrantTokens } from './cf-customer.ts';
import { decryptEmailDomainToken, encryptEmailDomainToken } from './domains.ts';
import type { EmailDomain } from './domains.ts';

export type EmailDomainLease =
  | Readonly<{ kind: 'api_token'; token: string }>
  | Readonly<{ kind: 'oauth_grant'; accessToken: string }>;

export type EmailDomainLeaseOutcome =
  | Readonly<{ ok: true; lease: EmailDomainLease }>
  | Readonly<{ ok: false; status: 'token_revoked' | 'failed'; error: string }>;

/**
 * The row's stored credential kind changed under the caller — a
 * concurrent `domain add` (replace) committed a different credential
 * before the row lock was acquired. Thrown by the serialized helpers
 * INSTEAD of operating on the wrong credential: submitting a fresh API
 * token to the grant endpoint would answer invalid_grant, and the
 * refresh's token_revoked flip would then disable the replacement.
 * Nothing is written; the caller re-reads the row and retries (or fails
 * the operation as transient).
 */
export class EmailDomainCredentialChangedError extends Error {
  constructor(rowId: string) {
    super(`email_domains row ${rowId} changed credential kind mid-operation`);
    this.name = 'EmailDomainCredentialChangedError';
  }
}

type SecretBindings = Pick<
  ApiEnv['Bindings'],
  'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One refresh round-trip under the row lock. Returns the fresh tokens with
 * the rotated refresh token already persisted (re-encrypted under the
 * row's fixed AAD name) in the same transaction that held the lock.
 *
 * Throws OAuthGrantError on a token-endpoint failure — `invalid_grant`
 * included, with the row already marked `token_revoked`. That flip runs
 * only against a row confirmed `oauth_grant` under this lock: a
 * credential kind changed by a concurrent replace throws
 * EmailDomainCredentialChangedError instead, with nothing written.
 * Callers that run
 * the relay engine hand this in as `deps.refreshGrant`; the engine maps
 * `invalid_grant` to the same `token_revoked` outcome, so the persisted
 * status and the engine's result agree. The relay engine's own
 * `rotated_refresh_token` passthrough must NOT be re-persisted by those
 * callers: this function already wrote it under the lock, and a blind
 * second write could overwrite a NEWER rotation a concurrent lease
 * committed in between (killing the chain — see contract 4).
 */
export async function refreshOauthGrantSerialized(
  db: DbOrTx,
  env: SecretBindings,
  rowId: string,
): Promise<OauthGrantTokens> {
  // `invalid_grant` must COMMIT its status flip — an error thrown from the
  // callback rolls the transaction back, so the revocation outcome travels
  // out of the transaction and is thrown only after the commit.
  const outcome = await db.transaction(
    async (
      tx,
    ): Promise<
      { ok: true; tokens: OauthGrantTokens } | { ok: false; revoked: OAuthGrantError }
    > => {
      const rows = await tx
        .select({
          id: emailDomains.id,
          project_id: emailDomains.project_id,
          domain: emailDomains.domain,
          credential_kind: emailDomains.credential_kind,
          token_ciphertext: emailDomains.token_ciphertext,
          token_iv: emailDomains.token_iv,
          token_key_version: emailDomains.token_key_version,
        })
        .from(emailDomains)
        .where(eq(emailDomains.id, rowId))
        .for('update')
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error(`email_domains row ${rowId} vanished mid-refresh`);
      }
      if (row.credential_kind !== 'oauth_grant') {
        // A replace committed a different credential before this lock.
        // Decrypting it as a grant would submit an API token to the token
        // endpoint, and the invalid_grant answer would mark the FRESH
        // credential revoked. Thrown inside the transaction: nothing is
        // written.
        throw new EmailDomainCredentialChangedError(rowId);
      }

      const refreshToken = await decryptEmailDomainToken(env, row.project_id, row.domain, {
        token_ciphertext: row.token_ciphertext,
        token_iv: row.token_iv,
        token_key_version: row.token_key_version,
      });

      let tokens: OauthGrantTokens;
      try {
        tokens = await refreshOauthGrant(refreshToken);
      } catch (err) {
        if (err instanceof OAuthGrantError && err.code === 'invalid_grant') {
          await tx
            .update(emailDomains)
            .set({ status: 'token_revoked', updated_at: sql`now()` })
            .where(eq(emailDomains.id, rowId));
          return { ok: false, revoked: err };
        }
        // Transient failure — the transaction rolls back with nothing
        // written; the row keeps its current status and credential.
        throw err;
      }

      const rotated = await encryptEmailDomainToken(
        env,
        row.project_id,
        row.domain,
        tokens.refreshToken,
      );
      await tx
        .update(emailDomains)
        .set({
          token_ciphertext: rotated.ciphertext,
          token_iv: rotated.iv,
          token_key_version: rotated.keyVersion,
          updated_at: sql`now()`,
        })
        .where(eq(emailDomains.id, rowId));
      return { ok: true, tokens };
    },
  );
  if (!outcome.ok) {
    throw outcome.revoked;
  }
  return outcome.tokens;
}

/**
 * Revoke the row's CURRENT chain head under the same per-row lock the
 * refresh uses. A revocation must target the live head: a token captured
 * earlier may already be consumed by an interleaved lease refresh, and CF
 * answers 200 whether the presented token was live or dead — so only a
 * capture under the lock makes the 200 mean the chain is dead. The lock is
 * held across the revocation call, exactly like the refresh. A gone row
 * (teardown's cascade won) has nothing left to revoke; a row whose
 * credential kind changed under the caller (a replace committed first)
 * throws EmailDomainCredentialChangedError rather than submitting the
 * replacement credential. Throws on a network or non-2xx failure — the
 * caller decides what that means (failed_steps, a 502, …). No status flip
 * here: the caller owns the row's fate.
 */
export async function revokeOauthGrantSerialized(
  db: DbOrTx,
  env: SecretBindings,
  rowId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: emailDomains.id,
        project_id: emailDomains.project_id,
        domain: emailDomains.domain,
        credential_kind: emailDomains.credential_kind,
        token_ciphertext: emailDomains.token_ciphertext,
        token_iv: emailDomains.token_iv,
        token_key_version: emailDomains.token_key_version,
      })
      .from(emailDomains)
      .where(eq(emailDomains.id, rowId))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) {
      return;
    }
    if (row.credential_kind !== 'oauth_grant') {
      // A replace committed a different credential before this lock:
      // revoking must not submit the NEW credential to the grant
      // endpoint, whose answers-200-for-anything semantics would read as
      // success to the caller.
      throw new EmailDomainCredentialChangedError(rowId);
    }
    const head = await decryptEmailDomainToken(env, row.project_id, row.domain, {
      token_ciphertext: row.token_ciphertext,
      token_iv: row.token_iv,
      token_key_version: row.token_key_version,
    });
    await revokeOauthGrant(head);
  });
}

/**
 * The per-row lock behind the refresh chain, generalized: `fn` runs inside
 * a transaction holding `SELECT … FOR UPDATE` on the domain row. The relay
 * secret rotation (sync) is serialized this way — two overlapping syncs
 * would otherwise interleave the worker secret PUT and the row/mirror
 * persist, leaving the worker holding a secret the row no longer knows.
 * The lock is held across the CF calls, exactly like the refresh holds it
 * across the token round-trip; the KV mirror write stays AFTER the commit
 * (KV is not transactional).
 */
export async function withEmailDomainRowLock<T>(
  db: Db,
  rowId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: emailDomains.id })
      .from(emailDomains)
      .where(eq(emailDomains.id, rowId))
      .for('update')
      .limit(1);
    return fn(tx);
  });
}

/**
 * Lease a send credential for one domain row. The caller (the internal
 * lease route) has already authenticated the request and checked the row
 * is `active`. `token_revoked` outcomes are persisted here; the caller owns
 * the ROUTING KV mirror update that must follow.
 */
export async function leaseEmailDomainCredential(
  db: Db,
  env: SecretBindings,
  row: EmailDomain,
): Promise<EmailDomainLeaseOutcome> {
  // The caller's row snapshot is unlocked; a replace can commit between
  // its read and the refresh's lock. One re-read converges on what the
  // row NOW holds — a second mid-lease change fails as transient.
  let current = row;
  for (let attempt = 0; ; attempt++) {
    if (current.credential_kind === 'api_token') {
      const token = await decryptEmailDomainToken(env, current.project_id, current.domain, current);
      return { ok: true, lease: { kind: 'api_token', token } };
    }
    try {
      const tokens = await refreshOauthGrantSerialized(db, env, current.id);
      return { ok: true, lease: { kind: 'oauth_grant', accessToken: tokens.accessToken } };
    } catch (err) {
      if (err instanceof EmailDomainCredentialChangedError && attempt === 0) {
        const fresh = await db
          .select()
          .from(emailDomains)
          .where(eq(emailDomains.id, current.id))
          .limit(1);
        if (fresh[0]) {
          current = fresh[0];
          continue;
        }
        return { ok: false, status: 'failed', error: 'email domain row vanished mid-lease' };
      }
      if (err instanceof OAuthGrantError && err.code === 'invalid_grant') {
        return {
          ok: false,
          status: 'token_revoked',
          error: 'the Cloudflare OAuth grant was revoked',
        };
      }
      return { ok: false, status: 'failed', error: errorMessage(err) };
    }
  }
}
