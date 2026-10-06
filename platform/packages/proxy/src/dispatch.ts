import {
  deriveProxyInternalAuth,
  PROXY_INTERNAL_AUTH_HEADER,
  ProxyTokenStateError,
} from '@voidcloud/api/proxy-token';
import { tenantSendToken } from './proxy-token.ts';
import type { Env } from './types.ts';

type WorkerResolution = Readonly<{
  workerName: string;
  deploymentId: string;
  /** Generation of the token the active Worker holds, when the API reports it. */
  proxyTokenGen?: number;
}>;

type DispatchOptions = Readonly<{
  /** Read-only operations may retry through their REST fallback after a transport failure. */
  fallbackOnDispatchError?: boolean;
}>;

/**
 * Resolve the active deployment's worker through the API service binding.
 *
 * This lookup intentionally runs for every operation. The project id is stable,
 * while rollback changes the active deployment and therefore the worker name.
 */
async function resolveWorker(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
): Promise<WorkerResolution | null> {
  const res = await api.fetch(`https://api/internal/resolve-worker/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(
        jwtSecret,
        'resolve-worker',
        projectId,
      ),
    },
  });

  if (res.status === 404 || res.status === 409) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`worker resolution failed with status ${res.status}`);
  }

  const data = await res.json<Partial<Record<keyof WorkerResolution, unknown>>>();
  if (typeof data.workerName !== 'string' || typeof data.deploymentId !== 'string') {
    throw new Error('worker resolution returned an invalid response');
  }
  const resolution = { workerName: data.workerName, deploymentId: data.deploymentId };
  return isGeneration(data.proxyTokenGen)
    ? { ...resolution, proxyTokenGen: data.proxyTokenGen }
    : resolution;
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
  options: DispatchOptions = {},
): Promise<Response | null> {
  let resolution: WorkerResolution | null;
  try {
    resolution = await resolveWorker(env.API, env.JWT_SECRET, projectId);
  } catch {
    return options.fallbackOnDispatchError
      ? null
      : Response.json({ error: 'active worker resolution failed' }, { status: 502 });
  }
  if (!resolution) {
    return null;
  }

  let token: string;
  try {
    token = await tenantSendToken(env, projectId, resolution.proxyTokenGen);
  } catch (error) {
    if (!(error instanceof ProxyTokenStateError)) {
      throw error;
    }
    console.error('[proxy-token] state unavailable', { projectId, error });
    return options.fallbackOnDispatchError
      ? null
      : Response.json({ error: 'project token state unavailable' }, { status: 502 });
  }

  let worker: Fetcher;
  try {
    worker = env.DISPATCH.get(resolution.workerName);
  } catch {
    return null;
  }

  try {
    // Sent exactly once. The Worker's own middleware runs before its
    // `/__void/*` handler checks the token, so a rejected request is not free
    // to replay.
    const res = await worker.fetch(`https://worker/__void${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-internal': token,
      },
      body: JSON.stringify(body),
    });

    // 404 means old deploy without /__void handler → fall back
    if (res.status === 404) {
      return null;
    }

    return res;
  } catch {
    // A write may already have committed before a response/transport failure.
    // Only explicitly read-only callers may replay through a REST fallback.
    return options.fallbackOnDispatchError
      ? null
      : Response.json(
          { error: 'worker dispatch failed; operation result is unknown' },
          { status: 502 },
        );
  }
}
