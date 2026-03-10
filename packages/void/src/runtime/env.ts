import { AsyncLocalStorage } from "node:async_hooks";

export type RuntimeEnv = Record<string, unknown>;

const envContext: AsyncLocalStorage<RuntimeEnv> = new AsyncLocalStorage<RuntimeEnv>();

let cloudflareEnv: RuntimeEnv | undefined;
// Don't await this import during module evaluation. Cloudflare validates
// worker startup and rejects bundles with unsettled top-level await.
void import("cloudflare:workers")
  .then((mod) => {
    const maybeEnv = asEnv((mod as { env?: unknown }).env);
    if (maybeEnv) {
      cloudflareEnv = maybeEnv;
    }
  })
  .catch(() => {
    // Not running in workerd.
  });

function asEnv(value: unknown): RuntimeEnv | null {
  if (typeof value !== "object" || value === null) return null;
  // Nuxt dev sets globalThis.__env__ to a Promise before resolving to env.
  if ("then" in value && typeof (value as { then?: unknown }).then === "function") return null;
  return value as RuntimeEnv;
}

function getNuxtEnv(): RuntimeEnv | null {
  return asEnv((globalThis as RuntimeEnv & { __env__?: unknown }).__env__);
}

export function withRuntimeEnv<T>(env: unknown, fn: () => T): T {
  const resolved = asEnv(env);
  if (!resolved) return fn();
  return envContext.run(resolved, fn);
}

export function getRuntimeEnv(): RuntimeEnv {
  return (
    envContext.getStore() ??
    getNuxtEnv() ??
    cloudflareEnv ??
    (() => {
      throw new Error(
        "Cloudflare env is unavailable. Use void runtime bindings inside Nuxt/SvelteKit server request handlers or Worker handlers.",
      );
    })()
  );
}

export function getRuntimeBinding<T = unknown>(name: string): T | undefined {
  return getRuntimeEnv()[name] as T | undefined;
}

export function requireRuntimeBinding<T = unknown>(name: string): T {
  const value = getRuntimeBinding<T>(name);
  if (value !== undefined && value !== null) return value;
  throw new Error(`Missing Cloudflare binding "${name}".`);
}
