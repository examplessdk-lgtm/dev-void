import type { Env } from './types.ts';

// In-memory cache: worker names are stable (only change on slug rename, which is rare).
const workerNameCache = new Map<string, string>();

/** @internal Exposed for testing only. */
export function clearWorkerNameCache() {
  workerNameCache.clear();
}

/**
 * Resolves a project's worker name via the API service binding.
 * Results are cached in-memory per isolate.
 */
async function resolveWorkerName(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
): Promise<string | null> {
  const cached = workerNameCache.get(projectId);
  if (cached) {
    return cached;
  }

  const token = await hmacSign(projectId, jwtSecret);
  const res = await api.fetch(`https://api/internal/resolve-worker/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-void-internal': token,
    },
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json<{ workerName: string }>();
  workerNameCache.set(projectId, data.workerName);
  return data.workerName;
}

/**
 * Dispatch a binding operation to the user's deployed worker via Workers for Platforms.
 * The user worker handles it via native D1/KV/R2 bindings at the `/__void/*` route.
 *
 * Returns the Response if successful, or null if the worker doesn't support /__void
 * (404 = old deploy without the handler → caller should fall back to REST API).
 */
export async function dispatchToWorker(
  env: Env,
  projectId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response | null> {
  try {
    const workerName = await resolveWorkerName(env.API, env.JWT_SECRET, projectId);
    if (!workerName) {
      return null;
    }

    const proxyToken = await hmacSign(projectId, env.JWT_SECRET);
    const worker = env.DISPATCH.get(workerName);
    const res = await worker.fetch(`https://worker/__void${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-internal': proxyToken,
      },
      body: JSON.stringify(body),
    });

    // 404 means old deploy without /__void handler → fall back
    if (res.status === 404) {
      return null;
    }

    return res;
  } catch {
    // Dispatch failure (worker not found, name resolution failed, etc.) → fall back
    return null;
  }
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
