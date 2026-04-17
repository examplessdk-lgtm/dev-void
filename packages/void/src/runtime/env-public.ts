/**
 * Public env API — `void/env`.
 *
 * Canonical usage:
 *
 * ```ts
 * // env.ts at project root
 * import { defineEnv, string, number, oneOf } from "void/env";
 *
 * export default defineEnv({
 *   STRIPE_KEY: string(),
 *   PORT: number().default(3000),
 *   NODE_ENV: oneOf(["development", "production"]),
 *   VITE_APP_TITLE: string(),
 * });
 *
 * // anywhere else
 * import { env } from "void/env";
 * env.STRIPE_KEY;
 * ```
 *
 * The `env` proxy reads from the underlying runtime env (Cloudflare worker
 * bindings, Node `process.env`, Nuxt globals, etc.) via `getRuntimeEnv()`,
 * and validates each key on first access using the registered schema.
 *
 * Bindings (`DB`, `KV`, `STORAGE`, `AI`, queue handlers) and other env keys
 * not declared in the schema pass through unchanged.
 */
/// <reference types="@cloudflare/workers-types" />

import type { StandardSchemaV1 } from '../standard-schema';
import { getRuntimeEnv } from './env';
import { getRawRuntimeEnv } from './env-raw';

interface AnyValidator extends StandardSchemaV1<unknown, unknown> {}
type AnySchema = Record<string, AnyValidator>;

let registeredSchema: AnySchema | null = null;
const validatedCache = new WeakMap<object, Map<string, unknown>>();

/**
 * Type-only stub for the validated env shape. Augmented by the generated
 * `.void/env.d.ts` so `env.X` is typed per the user's schema. Includes an
 * index signature so untyped property access returns `unknown` (rather than
 * a hard error) for bindings and keys not declared in the schema.
 */
export interface ValidatedEnv {
  readonly [key: string]: unknown;
}

type InferEnv<S extends AnySchema> = {
  readonly [K in keyof S]: StandardSchemaV1.InferOutput<S[K]>;
};

/**
 * Register an env schema and return the typed `env` proxy.
 *
 * Calling `defineEnv` is the only required step — Void auto-discovers
 * `env.ts` at project root, imports it, and uses the schema for runtime
 * validation, type generation, and deploy-time secret checks.
 *
 * The return value is identical to the `env` export from `void/env`.
 * Re-export it from your `env.ts` if you prefer the explicit
 * `import { env } from "~/env"` pattern.
 */
export function defineEnv<S extends AnySchema>(schema: S): InferEnv<S> {
  registeredSchema = schema;
  // Drop any cached entries from a prior schema (HMR / re-import).
  for (const map of validatedCacheValues()) {
    map.clear();
  }
  // Reset boot-time validation state so a re-imported schema is re-checked.
  bootValidationState = null;
  return env as unknown as InferEnv<S>;
}

type BootValidationState = { ok: true } | { ok: false; error: EnvValidationError };
let bootValidationState: BootValidationState | null = null;

/**
 * Internal: validate the entire schema against the worker's actual env on
 * the first request per isolate. Catches bad remote-secret values and
 * post-deploy drift that the deploy CLI can't see (it only knows secret
 * names, not their values).
 *
 * Spliced into the generated worker entry by `compileWorkerEntry`. Cached
 * after the first call so subsequent requests pay no cost.
 */
export function _validateEnvOnce(envValues: unknown): void {
  if (bootValidationState) {
    if (!bootValidationState.ok) {
      throw bootValidationState.error;
    }
    return;
  }
  if (!registeredSchema) {
    bootValidationState = { ok: true };
    return;
  }
  const values = (envValues ?? {}) as Record<string, unknown>;
  const report = validateAllEnv(values);
  if (report.valid) {
    bootValidationState = { ok: true };
    return;
  }
  const lines: string[] = ['Env validation failed at worker boot:'];
  for (const key of report.missing) {
    lines.push(`  • ${key} is required but missing`);
  }
  for (const { key, messages } of report.invalid) {
    lines.push(`  • ${key}: ${messages.join('; ')}`);
  }
  const error = new EnvValidationError('__init__', [{ message: lines.join('\n') }]);
  bootValidationState = { ok: false, error };
  throw error;
}

function validatedCacheValues(): Map<string, unknown>[] {
  // WeakMap doesn't expose values; we maintain a parallel list for clears.
  return cacheList;
}
const cacheList: Map<string, unknown>[] = [];

/** Internal: framework-only access to the registered schema (for plugin/CLI). */
export function _getRegisteredSchema(): AnySchema | null {
  return registeredSchema;
}

export class EnvValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(`Invalid env "${key}": ${issues.map((i) => i.message).join(', ')}`);
    this.name = 'EnvValidationError';
  }
}

function readKey(key: string): unknown {
  // Filtered env hides internal __VOID_*/__PROJECT_* bindings from user code.
  const filtered = getRuntimeEnv() as Record<string, unknown>;
  const rawValue = filtered[key];
  if (!registeredSchema) {
    return rawValue;
  }
  const validator = registeredSchema[key];
  if (!validator) {
    return rawValue;
  }
  // Cache identity must be the underlying env object. `getRuntimeEnv()`
  // returns a fresh Proxy on every call, so keying by it would miss.
  const cacheKey = getRawRuntimeEnv() as object;
  let cache = validatedCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    validatedCache.set(cacheKey, cache);
    cacheList.push(cache);
  }
  if (cache.has(key)) {
    return cache.get(key);
  }
  const result = validator['~standard'].validate(rawValue);
  if (result instanceof Promise) {
    throw new Error(
      `Async env validators are not supported (key "${key}"). Use a synchronous validator.`,
    );
  }
  if (result.issues) {
    throw new EnvValidationError(key, result.issues);
  }
  cache.set(key, result.value);
  return result.value;
}

/**
 * Typed env proxy. Reads from the runtime env, validating declared keys
 * on first access and passing through bindings / unknown keys unchanged.
 */
export const env = new Proxy({} as Record<string, unknown>, {
  get(_target, key) {
    if (typeof key === 'symbol') {
      return undefined;
    }
    return readKey(key);
  },
  has(_target, key) {
    if (typeof key === 'symbol') {
      return false;
    }
    return Reflect.has(getRuntimeEnv() as object, key);
  },
  ownKeys() {
    return Reflect.ownKeys(getRuntimeEnv() as object);
  },
  getOwnPropertyDescriptor(_target, key) {
    if (typeof key === 'symbol') {
      return undefined;
    }
    return {
      enumerable: true,
      configurable: true,
      value: readKey(String(key)),
    };
  },
}) as ValidatedEnv;

/** Aggregate report from validating an entire env object against the schema. */
export interface EnvValidationReport {
  valid: boolean;
  missing: string[];
  invalid: { key: string; messages: string[] }[];
}

/**
 * Validate an env record (e.g. merged `.env*` + remote secret list) against
 * the registered schema. Used by the dev plugin (warnings) and the deploy
 * CLI (hard error).
 */
export function validateAllEnv(envValues: Record<string, unknown>): EnvValidationReport {
  const report: EnvValidationReport = { valid: true, missing: [], invalid: [] };
  if (!registeredSchema) {
    return report;
  }
  for (const [key, validator] of Object.entries(registeredSchema)) {
    const raw = envValues[key];
    const result = validator['~standard'].validate(raw);
    if (result instanceof Promise) {
      report.valid = false;
      report.invalid.push({ key, messages: ['Async validators are not supported'] });
      continue;
    }
    if (result.issues) {
      report.valid = false;
      const isMissing = raw === undefined || raw === null || raw === '';
      if (isMissing) {
        report.missing.push(key);
      } else {
        report.invalid.push({
          key,
          messages: result.issues.map((i) => i.message),
        });
      }
    }
  }
  return report;
}

export { string, number, boolean, url, email, oneOf, json, type EnvSchema } from './env-helpers';

// Preserve ambient Cloudflare.Env declarations from the previous env.d.ts
// so user tsconfigs that include `types: ["void/env"]` continue to expose
// D1/KV/R2 globals plus the auto-inferred Void framework bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV: KVNamespace;
      STORAGE: R2Bucket;
      AI: Ai;
      /** @internal Service binding to proxy worker (AI, revalidation, future features) */
      __VOID_PROXY?: Fetcher;
      /** @internal Custom proxy URL override */
      __VOID_PROXY_URL?: string;
      /** @internal Auth token for HTTP proxy (local dev) */
      __VOID_TOKEN?: string;
      /** @internal Project ID for HTTP proxy (local dev) */
      __VOID_PROJECT_ID?: string;
      /** @internal Staging environment flag */
      __VOID_STAGING?: string;
      /** @internal Project ID (service binding path) */
      __PROJECT_ID?: string;
      /** @internal Proxy token (service binding path) */
      __VOID_PROXY_TOKEN?: string;
      [key: `QUEUE_${string}`]: Queue<unknown> | undefined;
    }
  }
}
