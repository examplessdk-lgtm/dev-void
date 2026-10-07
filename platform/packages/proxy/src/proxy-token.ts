import {
  createProxyTokenStateCache,
  deriveProxyToken,
  ProxyTokenStateError,
  verifyProxyToken,
} from '@voidcloud/api/proxy-token';
import type { Env } from './types.ts';

// One floor cache per isolate, shared by every request it serves.
const stateCache = createProxyTokenStateCache();

/** @internal Exposed for testing only. */
export function clearProxyTokenStateCache() {
  stateCache.clear();
}

/**
 * Checks a tenant's project token against its accept floor. A floor that
 * cannot be read or is malformed is `'unavailable'`, never accepted.
 */
export async function verifyTenantProxyToken(
  env: Pick<Env, 'ROUTING' | 'JWT_SECRET'>,
  projectId: string,
  token: string,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  try {
    const valid = await verifyProxyToken({
      jwtSecret: env.JWT_SECRET,
      projectId,
      token,
      readState: () => stateCache.read(env.ROUTING, projectId),
    });
    return valid ? 'ok' : 'invalid';
  } catch (error) {
    if (error instanceof ProxyTokenStateError) {
      console.error('[proxy-token] state unavailable', { projectId, error });
      return 'unavailable';
    }
    throw error;
  }
}

/**
 * The one token to present to a tenant Worker. Without the issued generation,
 * sends for the cached floor, which throws `ProxyTokenStateError` when the
 * floor cannot be read.
 */
export async function tenantSendToken(
  env: Pick<Env, 'ROUTING' | 'JWT_SECRET'>,
  projectId: string,
  issueGen: number | undefined,
): Promise<string> {
  const gen = issueGen ?? (await stateCache.read(env.ROUTING, projectId)).gen;
  return deriveProxyToken(env.JWT_SECRET, projectId, gen);
}
