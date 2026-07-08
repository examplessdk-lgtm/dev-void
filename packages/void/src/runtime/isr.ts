import { getRawRuntimeEnv } from './env-raw.ts';
import { denormalizeIsrPath, htmlEdgeKey, isrKey, jsonEdgeKey } from './isr-cache.ts';

export type RevalidateOptions = {
  paths?: Array<string>;
  all?: boolean;
};

/**
 * Revalidate ISR-cached pages on demand.
 *
 * On managed Void, calls the platform proxy via service binding which forwards
 * to the API for R2 deletion + edge cache purge. On self-host, purges this
 * worker's own ISR_CACHE (KV) entries plus the caches.default edge variants.
 * When neither is configured (e.g. local dev with no ISR), this is a no-op.
 *
 * @example
 * ```ts
 * import { revalidate } from "void/isr";
 *
 * // Revalidate specific paths
 * await revalidate({ paths: ["/", "/blog/hello"] });
 *
 * // Revalidate all ISR pages
 * await revalidate({ all: true });
 * ```
 */
export async function revalidate(options: RevalidateOptions): Promise<void> {
  const rawEnv = getRawRuntimeEnv();
  const proxy = rawEnv.__VOID_PROXY as Fetcher | undefined;
  if (!proxy) {
    // Self-host — no platform proxy. Purge this worker's own ISR cache: KV
    // entries (global, authoritative) plus the caches.default edge variants.
    // When ISR_CACHE / deployment id are absent (e.g. local dev with no ISR
    // binding), this stays a silent no-op — matching the previous behavior.
    const kv = rawEnv.ISR_CACHE as KVNamespace | undefined;
    const id = rawEnv.__VOID_ISR_DEPLOYMENT_ID as string | undefined;
    if (!kv || !id) {
      return;
    }
    // Cast because this package has both @types/node and @cloudflare/workers-types
    // in scope, and Node's ambient CacheStorage (which lacks `.default`) otherwise
    // shadows the Workers one on the `caches` global — same pattern as isr-cache.ts.
    const cache = (caches as unknown as { default: Cache }).default;
    const host = rawEnv.__VOID_ISR_HOST as string | undefined;
    const purge = async (path: string): Promise<void> => {
      await kv.delete(isrKey(id, path));
      if (host) {
        await cache.delete(htmlEdgeKey(host, path, id));
        await cache.delete(jsonEdgeKey(host, path, id));
      }
    };
    if (options.all) {
      const prefix = `void-isr/${id}/`;
      let cursor: string | undefined;
      do {
        const list = await kv.list({ prefix, cursor });
        for (const key of list.keys) {
          await purge(denormalizeIsrPath(key.name.slice(prefix.length)));
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    } else {
      for (const path of options.paths ?? []) {
        await purge(path);
      }
    }
    return;
  }

  const projectId = rawEnv.__PROJECT_ID as string | undefined;
  const token = rawEnv.__VOID_PROXY_TOKEN as string | undefined;

  if (!projectId || !token) {
    throw new Error('isr: Revalidation requires __PROJECT_ID and __VOID_PROXY_TOKEN bindings.');
  }

  const response = await proxy.fetch('https://proxy/revalidate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, aiToken: token, ...options }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`isr: Revalidation failed with ${response.status}: '${text}'.`);
  }
}
