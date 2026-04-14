import { ProxyClient } from './client';
import { ProxyD1Database } from './d1';
import { ProxyKVNamespace } from './kv';
import { ProxyR2Bucket } from './r2';

/**
 * Replace local D1/KV/R2 bindings with proxy-backed versions.
 * Called from the generated worker entry point when `__VOID_REMOTE` is set.
 */
export function createRemoteEnv(env: Record<string, unknown>): Record<string, unknown> {
  const client = new ProxyClient(
    env.__VOID_PROXY_URL as string,
    env.__VOID_TOKEN as string,
    env.__VOID_PROJECT_ID as string,
  );
  return {
    ...env,
    ...(env.DB != null && { DB: new ProxyD1Database(client, 'DB') }),
    ...(env.KV != null && { KV: new ProxyKVNamespace(client, 'KV') }),
    ...(env.STORAGE != null && { STORAGE: new ProxyR2Bucket(client, 'STORAGE') }),
  };
}
