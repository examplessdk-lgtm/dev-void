// In-memory cache: resource mappings are stable (only change on deploy).
// Persists across requests within the same CF worker isolate.
const cache = new Map<string, string>();

/** @internal Exposed for testing only. */
export function clearResolveCache() {
  cache.clear();
}

/**
 * Resolves a project's binding to its Cloudflare resource ID via the API service binding.
 * Results are cached in-memory per isolate — the first call per binding hits the API,
 * subsequent calls return instantly.
 */
export async function resolveResource(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
  type: 'd1' | 'kv' | 'r2',
  bindingName: string,
): Promise<string> {
  const cacheKey = `${projectId}:${type}:${bindingName}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const token = await hmacSign(projectId, jwtSecret);
  const res = await api.fetch(`https://api/internal/resolve-resource/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-void-internal': token,
    },
    body: JSON.stringify({ type, binding: bindingName }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Resource resolution failed (${res.status}): ${text}`);
  }

  const data = await res.json<{ cf_id: string }>();
  cache.set(cacheKey, data.cf_id);
  return data.cf_id;
}

/**
 * Verifies that an actor still has deploy-equivalent project access through
 * the API service binding. The endpoint keeps its legacy name during rollout.
 */
export async function verifyProjectDeployAccess(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
  userId: string,
  jwt?: string,
  accessAssertion?: string,
  proxyOrigin?: string,
): Promise<boolean> {
  try {
    if (!proxyOrigin || new URL(proxyOrigin).origin !== proxyOrigin) {
      return false;
    }
    const token = await hmacSign(ownerVerificationMessage(projectId, proxyOrigin), jwtSecret);
    const res = await api.fetch(`https://api/internal/verify-owner/${projectId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-internal': token,
      },
      body: JSON.stringify({
        userId,
        ...(jwt ? { jwt } : {}),
        ...(accessAssertion ? { accessAssertion } : {}),
        proxyOrigin,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function ownerVerificationMessage(projectId: string, proxyOrigin: string): string {
  return `void-proxy-owner-v2\n${projectId}\n${proxyOrigin}`;
}

/** Revalidate the authority from which a scoped prerender credential was derived. */
export async function verifyPrerenderAuthority(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
  userId: string,
  provenance: { buildId?: string; credentialId?: string },
): Promise<boolean> {
  try {
    const token = await hmacSign(projectId, jwtSecret);
    const res = await api.fetch(`https://api/internal/verify-prerender-build/${projectId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-internal': token,
      },
      body: JSON.stringify({ userId, ...provenance }),
    });
    return res.ok;
  } catch {
    // Project-data access fails closed if the revocation authority is
    // unavailable. A build can retry without widening its credential.
    return false;
  }
}

// --- HMAC signing (mirrors packages/api/src/auth/hmac.ts) ---

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
