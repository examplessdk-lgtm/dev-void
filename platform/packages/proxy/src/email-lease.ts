/** Lease a customer API token from the platform for a custom-domain send. */

import type { Env } from './types.ts';

export type EmailDomainLease = { kind: 'api_token'; token: string; accountId: string };

/** The bearer value for the send_raw Authorization header. */
export function leaseBearer(lease: EmailDomainLease): string {
  return lease.token;
}

/**
 * Lease a send credential for a registered domain from the api. Returns
 * null on any failure; the caller maps that to a retryable upstream error.
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
