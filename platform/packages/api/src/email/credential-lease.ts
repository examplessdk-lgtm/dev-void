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
 * persisted in the SAME transaction. There is no access-token cache on the
 * api side — every lease refreshes. `invalid_grant` marks the row
 * `token_revoked` inside the transaction, before the error travels.
 *
 * Credential material is never logged or interpolated into errors; the
 * lease leaves this module only as the lease route's response body.
 */

import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { emailDomains } from '../schema.ts';
import { OAuthGrantError, refreshOauthGrant } from './cf-customer.ts';
import type { OauthGrantTokens } from './cf-customer.ts';
import { decryptEmailDomainToken, encryptEmailDomainToken } from './domains.ts';
import type { EmailDomain } from './domains.ts';

export type EmailDomainLease =
  | Readonly<{ kind: 'api_token'; token: string }>
  | Readonly<{ kind: 'oauth_grant'; accessToken: string }>;

export type EmailDomainLeaseOutcome =
  | Readonly<{ ok: true; lease: EmailDomainLease }>
  | Readonly<{ ok: false; status: 'token_revoked' | 'failed'; error: string }>;

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
 * included, with the row already marked `token_revoked`. Callers that run
 * the relay engine hand this in as `deps.refreshGrant`; the engine maps
 * `invalid_grant` to the same `token_revoked` outcome, so the persisted
 * status and the engine's result agree. The relay engine's own
 * `rotated_refresh_token` passthrough must NOT be re-persisted by those
 * callers: this function already wrote it under the lock, and a blind
 * second write could overwrite a NEWER rotation a concurrent lease
 * committed in between (killing the chain — see contract 4).
 */
export async function refreshOauthGrantSerialized(
  db: Db,
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
  if (row.credential_kind === 'api_token') {
    const token = await decryptEmailDomainToken(env, row.project_id, row.domain, row);
    return { ok: true, lease: { kind: 'api_token', token } };
  }
  try {
    const tokens = await refreshOauthGrantSerialized(db, env, row.id);
    return { ok: true, lease: { kind: 'oauth_grant', accessToken: tokens.accessToken } };
  } catch (err) {
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
