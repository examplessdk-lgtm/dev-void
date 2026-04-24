import { getRawRuntimeEnv } from './env-raw';

export interface RevalidateOptions {
  paths?: Array<string>;
  all?: boolean;
}

/**
 * Revalidate ISR-cached pages on demand.
 *
 * In production, calls the platform proxy via service binding which forwards
 * to the API for R2 deletion + edge cache purge. In local dev, this is a
 * no-op (no ISR cache to purge).
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
    // Local dev — no ISR cache to purge, no-op
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
