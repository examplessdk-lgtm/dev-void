/**
 * Raw runtime env resolution — framework-internal only.
 *
 * This module is NOT exported in package.json, so it cannot be imported
 * via "void/..." subpaths. Only framework modules can import it by relative path.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type RuntimeEnv = Record<string, unknown>;

/** Prefixes for platform-internal bindings that must be hidden from user code. */
export const INTERNAL_BINDING_PREFIXES = ['__VOID_', '__PROJECT_'] as const;

/**
 * Exact binding names that must be hidden from user code even though they carry
 * no internal prefix. `ISR_CACHE` (the self-host ISR KV namespace) is a plain
 * binding name, but it is a framework internal — route handlers read the ISR
 * cache through `handleIsr`/`revalidate()` on the raw env, never via `c.env` or
 * the public `void/env` API. Single source of truth shared by the generated
 * `c.env` filter (`router/compile.ts`) and the runtime `env` filter (`env.ts`).
 *
 * Unlike the prefix internals, these are hidden ONLY when ISR is active for the
 * isolate (see {@link isIsrActive}). In a non-ISR app, `ISR_CACHE` is an
 * ordinary user binding and stays visible everywhere — matching the build-time
 * `isr` gate on the generated `c.env` filter.
 */
export const INTERNAL_BINDING_EXACT_NAMES = ['ISR_CACHE'] as const;

/**
 * ISR is active for this isolate iff the framework has stamped the compile-time
 * deployment id onto the raw env (`__VOID_ISR_DEPLOYMENT_ID`). The generated
 * worker entry stamps it at the top of `fetch()` (and in cron/queue handlers)
 * only for ISR-emitting builds, so its presence is a reliable runtime signal
 * that `ISR_CACHE` should be treated as a framework internal. The id itself is a
 * `__VOID_`-prefixed binding that is always hidden and framework-controlled, so
 * a user cannot forge it.
 */
export function isIsrActive(rawEnv: RuntimeEnv): boolean {
  return rawEnv.__VOID_ISR_DEPLOYMENT_ID != null;
}

export const envContext: AsyncLocalStorage<RuntimeEnv> = new AsyncLocalStorage<RuntimeEnv>();

let cloudflareEnv: RuntimeEnv | undefined;

// Synchronous detection: navigator.userAgent is "Cloudflare-Workers" in workerd
// (default since compat date 2022-03-21). Only attempt the dynamic import when
// we know we're in workerd — avoids silent .catch() on Node/Bun/Deno.
// Built-in module imports resolve before the runtime dispatches its first request,
// so cloudflareEnv is guaranteed to be set by the time any handler runs.
const isWorkerd = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

if (isWorkerd) {
  import('cloudflare:workers')
    .then((mod) => {
      cloudflareEnv = asEnv((mod as { env?: unknown }).env) ?? undefined;
    })
    .catch(() => {});
}

function asEnv(value: unknown): RuntimeEnv | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if ('then' in value && typeof (value as { then?: unknown }).then === 'function') {
    return null;
  }
  return value as RuntimeEnv;
}

function getNuxtEnv(): RuntimeEnv | null {
  return asEnv((globalThis as RuntimeEnv & { __env__?: unknown }).__env__);
}

/** Resolve raw env from AsyncLocalStorage, Nuxt globals, or CF module env. */
export function getRawRuntimeEnv(): RuntimeEnv {
  return (
    envContext.getStore() ??
    getNuxtEnv() ??
    cloudflareEnv ??
    (() => {
      throw new Error(
        'env: Cloudflare env is unavailable. Use void runtime bindings inside Nuxt/SvelteKit/Analog server request handlers or Worker handlers.',
      );
    })()
  );
}

export { asEnv };
