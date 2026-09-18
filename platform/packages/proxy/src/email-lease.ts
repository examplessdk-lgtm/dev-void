/**
 * Credential lease client for custom sender domains (design doc 0078,
 * "Custom domains on Cloudflare").
 *
 * The proxy never decrypts a domain's stored credential — the OAuth grant's
 * refresh token or the pasted API token lives encrypted on the api's
 * `email_domains` row and only the api reads it. When a send's from-domain
 * is a registered custom domain, the proxy LEASES a short-lived credential
 * from the api instead:
 *
 *   POST {API}/internal/email/domain-credential    { domain }
 *   → { kind: 'api_token', token } | { kind: 'oauth_grant', accessToken }
 *
 * The call uses the platform-internal auth pattern the proxy already uses
 * to call the api (`resolve.ts`, the revalidation bridge): an HMAC under
 * JWT_SECRET in the `x-void-internal` header. The signed value is the
 * domain — the one value both sides of this call already hold.
 *
 * The api owns the OAuth refresh chain (serialized per row, the rotated
 * refresh token persisted atomically with it) and returns a fresh access
 * token on every lease — there is no access-token cache on the api side.
 * The proxy requests a fresh lease for every provider submission so a
 * revoked or rotated credential cannot be reused from an isolate cache.
 *
 * A leased credential is a customer secret: it is never logged, never
 * interpolated into an error message, and never leaves this module except
 * as the `Authorization: Bearer` value of the send_raw call.
 */

import type { Env } from './types.ts';

export type EmailDomainLease =
  | { kind: 'api_token'; token: string; accountId: string }
  | { kind: 'oauth_grant'; accessToken: string; accountId: string };

/** @internal Exposed for testing only. */
export function clearEmailDomainLeaseCache(): void {}

/**
 * Drop one cached lease. Called when Cloudflare refused the credential
 * (401/403 from send_raw) so the next send re-leases instead of replaying a
 * credential the api may already have marked revoked.
 */
export function dropEmailDomainLease(_domain: string): void {}

/** The bearer value for the send_raw Authorization header. */
export function leaseBearer(lease: EmailDomainLease): string {
  return lease.kind === 'api_token' ? lease.token : lease.accessToken;
}

/**
 * Lease a send credential for a registered domain from the api. Returns
 * null on any failure — the caller maps that to a retryable UPSTREAM_ERROR;
 * the api owns the row's status transitions (`token_revoked`, …) on real
 * credential failures, via its own refresh path.
 */
export async function leaseEmailDomainCredential(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  domain: string,
  projectId: string,
): Promise<EmailDomainLease | null> {
  let res: Response;
  try {
    const token = await hmacSign(
      `email-lease-v1\n${projectId}\n${domain.toLowerCase()}`,
      env.JWT_SECRET,
    );
    res = await env.API.fetch('https://api/internal/email/domain-credential', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-internal': token,
      },
      body: JSON.stringify({ domain, projectId }),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const lease = parseLease(data);
  if (!lease) {
    return null;
  }
  return lease;
}

function parseLease(data: unknown): EmailDomainLease | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const kind = (data as { kind?: unknown }).kind;
  const accountId = (data as { accountId?: unknown }).accountId;
  if (typeof accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) {
    return null;
  }
  if (kind === 'api_token') {
    const token = (data as { token?: unknown }).token;
    return typeof token === 'string' && token.length > 0 ? { kind, token, accountId } : null;
  }
  if (kind === 'oauth_grant') {
    const accessToken = (data as { accessToken?: unknown }).accessToken;
    return typeof accessToken === 'string' && accessToken.length > 0
      ? { kind, accessToken, accountId }
      : null;
  }
  return null;
}

// --- HMAC signing (mirrors resolve.ts) ---

const encoder = new TextEncoder();
let cachedSignKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getSignKey(secret: string): Promise<CryptoKey> {
  if (cachedSignKey && cachedKeySecret === secret) {
    return cachedSignKey;
  }
  cachedSignKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKeySecret = secret;
  return cachedSignKey;
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await getSignKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
