import type { ApiEnv } from './env.ts';
import {
  PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
  ProxyTokenStateError,
  readProxyTokenState,
  verifyProxyToken,
} from './proxy-token.ts';

/**
 * Checks a tenant project token forwarded by the proxy against the project's
 * accept floor. A floor that cannot be read or is malformed is
 * `'unavailable'`, never accepted.
 */
export async function checkTenantProxyToken(
  env: Pick<ApiEnv['Bindings'], 'ROUTING' | 'JWT_SECRET'>,
  projectId: string,
  token: string,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  try {
    const valid = await verifyProxyToken({
      jwtSecret: env.JWT_SECRET,
      projectId,
      token,
      readState: () =>
        readProxyTokenState(env.ROUTING, projectId, {
          cacheTtl: PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
        }),
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
