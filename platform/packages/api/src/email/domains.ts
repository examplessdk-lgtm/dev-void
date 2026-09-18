/**
 * Row helpers for `email_domains` — custom sender/recipient domains on the
 * customer's own Cloudflare zone (design doc 0078, "Custom domains on
 * Cloudflare").
 *
 * Two secrets per row, both encrypted with `encryptProjectSecret` under the
 * project's envelope key. A project secret's AAD is `${projectId}:${name}`
 * and the names are FIXED per row, so each ciphertext is bound to the
 * project AND the domain:
 *   - `email-domain-token:<domain>` — the customer's credential: the OAuth
 *     grant's refresh token, or the pasted API token on the fallback path.
 *     Only the api decrypts it (probes, relay deploys, the OAuth refresh
 *     chain); the proxy leases short-lived credentials from the api instead
 *     of holding it.
 *   - `email-domain-relay:<domain>` — the relay secret, a random 32-byte
 *     base64url string generated here at add time. The relay worker
 *     presents it as a bearer on every POST /email/relay; ROUTING KV only
 *     ever holds its sha256, so the mirror proves knowledge without
 *     carrying anything reusable.
 *
 * Neither plaintext is ever logged, returned from an API route, or written
 * to a manifest; the one worker the relay secret reaches is the relay
 * itself, deployed into the customer's account with only its own domain's
 * secret.
 */

import { eq, sql, type InferSelectModel } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { decryptProjectSecret, encryptProjectSecret } from '../project-secrets.ts';
import { emailDomains } from '../schema.ts';

export type EmailDomain = InferSelectModel<typeof emailDomains>;

type EmailDomainSecretBindings = Pick<
  ApiEnv['Bindings'],
  'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
>;

const encoder = new TextEncoder();

/**
 * The JSON mirrored to ROUTING KV at `email-domain:<domain>` on every
 * email_domains create/update. The proxy has no database access — this
 * mirror is its ONLY view of the row, so the shape is a wire contract:
 * `status` must be 'active' before the proxy trusts anything else in it,
 * and `relaySecretSha256` is what a presented relay secret's sha256 is
 * constant-time compared against.
 */
export type EmailDomainMirror = {
  projectId: string;
  status: EmailDomain['status'];
  relaySecretSha256: string;
  relayWorkerName: string | null;
  accountId: string | null;
  zoneId: string | null;
  mode: EmailDomain['mode'];
};

function emailDomainTokenAadName(domain: string): string {
  return `email-domain-token:${domain}`;
}

function emailDomainRelayAadName(domain: string): string {
  return `email-domain-relay:${domain}`;
}

/**
 * The one place this key is spelled — writer, clearer, and the tests share
 * it, so a rename cannot leave the proxy reading a key nobody writes.
 */
function emailDomainMirrorKey(domain: string): string {
  return `email-domain:${domain}`;
}

/**
 * Encrypt the customer's credential (grant refresh token or pasted API
 * token) for storage in the row's `token_*` triple.
 */
export function encryptEmailDomainToken(
  env: EmailDomainSecretBindings,
  projectId: string,
  domain: string,
  token: string,
): Promise<{ ciphertext: string; iv: string; keyVersion: string }> {
  return encryptProjectSecret(env, projectId, emailDomainTokenAadName(domain), token);
}

export type PlatformCredentialBindings = Pick<ApiEnv['Bindings'], 'CF_API_TOKEN'>;

/**
 * The one place a row's credential is resolved. `platform` rows (an
 * administrator's, design doc 0078 "Administrator-managed domains") hold
 * no credential and resolve to the platform's own runtime token, which is
 * never written to the row, a mirror or a log; every other kind decrypts
 * the stored triple.
 */
export async function decryptEmailDomainToken(
  env: EmailDomainSecretBindings & Partial<PlatformCredentialBindings>,
  projectId: string,
  domain: string,
  row: Pick<EmailDomain, 'credential_kind' | 'token_ciphertext' | 'token_iv' | 'token_key_version'>,
): Promise<string> {
  if (row.credential_kind === 'platform') {
    if (!env.CF_API_TOKEN) {
      throw new Error('platform credential unavailable: CF_API_TOKEN is not configured');
    }
    return env.CF_API_TOKEN;
  }
  if (row.token_ciphertext === null || row.token_iv === null || row.token_key_version === null) {
    throw new Error('email_domains row is missing its stored credential');
  }
  return decryptProjectSecret(env, projectId, {
    name: emailDomainTokenAadName(domain),
    ciphertext: row.token_ciphertext,
    iv: row.token_iv,
    key_version: row.token_key_version,
  });
}

/**
 * Encrypt the relay secret for storage in the row's `relay_*` triple. The
 * plaintext is also handed to the relay worker as the `VOID_RELAY_SECRET`
 * worker secret at deploy/rotation time.
 */
export function encryptEmailDomainRelaySecret(
  env: EmailDomainSecretBindings,
  projectId: string,
  domain: string,
  relaySecret: string,
): Promise<{ ciphertext: string; iv: string; keyVersion: string }> {
  return encryptProjectSecret(env, projectId, emailDomainRelayAadName(domain), relaySecret);
}

export function decryptEmailDomainRelaySecret(
  env: EmailDomainSecretBindings,
  projectId: string,
  domain: string,
  row: Pick<EmailDomain, 'relay_ciphertext' | 'relay_iv' | 'relay_key_version'>,
): Promise<string> {
  return decryptProjectSecret(env, projectId, {
    name: emailDomainRelayAadName(domain),
    ciphertext: row.relay_ciphertext,
    iv: row.relay_iv,
    key_version: row.relay_key_version,
  });
}

/**
 * Generate a domain's relay secret: 32 random bytes, base64url without
 * padding (43 chars). Generated at add time and rotated on `sync` —
 * rotation is overwrite, never read-compare (worker secrets are
 * write-only).
 */
export function generateEmailRelaySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * sha256 of a relay secret as lowercase hex — the only form of the secret
 * that reaches ROUTING KV. The proxy hashes the presented bearer the same
 * way and constant-time compares.
 */
export async function hashEmailRelaySecret(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
  let hex = '';
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Write `email-domain:<domain>` in ROUTING KV from the row, on every
 * create/update. The payload carries the sha256 of the relay secret, never
 * the secret itself. KV failures propagate: strict-vs-best-effort is the
 * call site's choice, same as the email-allowlist mirror.
 */
export async function writeEmailDomainMirror(
  kv: KVNamespace,
  row: Pick<
    EmailDomain,
    'domain' | 'project_id' | 'status' | 'relay_worker_name' | 'account_id' | 'zone_id' | 'mode'
  >,
  relaySecretSha256: string,
): Promise<void> {
  const mirror: EmailDomainMirror = {
    projectId: row.project_id,
    status: row.status,
    relaySecretSha256,
    relayWorkerName: row.relay_worker_name,
    accountId: row.account_id,
    zoneId: row.zone_id,
    mode: row.mode,
  };
  await kv.put(emailDomainMirrorKey(row.domain), JSON.stringify(mirror));
}

/**
 * Delete `email-domain:<domain>` from ROUTING KV, on row delete and on
 * project delete (one call per domain the project held).
 */
export async function clearEmailDomainMirror(kv: KVNamespace, domain: string): Promise<void> {
  await kv.delete(emailDomainMirrorKey(domain));
}

/** The row vanished mid-setup — project teardown's cascade beat the checkpoint write. */
export class EmailDomainRowGoneError extends Error {
  constructor() {
    super('email_domains row vanished mid-setup');
    this.name = 'EmailDomainRowGoneError';
  }
}

/**
 * Mid-setup progress write, fired ONCE after the relay deploy + secret PUT
 * and BEFORE the catch-all write. Its real job is racing: the partial
 * unique index on emailDomains (one live row per zone) makes a concurrent
 * loser throw 23505 HERE, before it ever writes its catch-all rule —
 * closing the last-write-wins window structurally. (The relay-name
 * index's loser now throws EARLIER, at the engine's pre-upload
 * claimRelayName; on a fresh setup this write's relay_worker_name and
 * account_id are same-value no-ops.) Status, setup_state, relay_version,
 * and the credential columns stay untouched; the final apply owns those.
 */
export async function applyEmailDomainDeployCheckpoint(
  db: DbOrTx,
  rowId: string,
  progress: Readonly<{
    zone_id: string | null;
    account_id: string | null;
    mode: 'apex' | 'subdomain' | null;
    relay_worker_name: string;
  }>,
): Promise<EmailDomain> {
  const updated = await db
    .update(emailDomains)
    .set({
      zone_id: progress.zone_id,
      account_id: progress.account_id,
      ...(progress.mode === null ? {} : { mode: progress.mode }),
      relay_worker_name: progress.relay_worker_name,
      updated_at: sql`now()`,
    })
    .where(eq(emailDomains.id, rowId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new EmailDomainRowGoneError();
  }
  return row;
}

/**
 * The DELETE route's keep-row marker: when CF-side cleanup fails the row
 * is KEPT so the owner can retry (or force), and this records which steps
 * failed. The status GET suppresses mirror repair while
 * `failed_step === 'remove'`.
 */
export async function markEmailDomainRemovalFailed(
  db: DbOrTx,
  rowId: string,
  failedSteps: ReadonlyArray<string>,
): Promise<void> {
  await db
    .update(emailDomains)
    .set({
      setup_state: sql`jsonb_set(jsonb_set(coalesce(${emailDomains.setup_state}, '{}'::jsonb), '{failed_step}', '"remove"'), '{removal_failed_steps}', ${JSON.stringify([...failedSteps])}::jsonb)`,
      updated_at: sql`now()`,
    })
    .where(eq(emailDomains.id, rowId));
}
