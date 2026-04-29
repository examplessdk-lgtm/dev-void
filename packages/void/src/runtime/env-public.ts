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

import { isUnmaskActive, redactMessage, type SecretOverride } from '../shared/env-mask.ts';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import { getSecretOverride } from './env-helpers.ts';
import { getRawRuntimeEnv } from './env-raw.ts';
import { getRuntimeEnv } from './env.ts';

interface AnyValidator extends StandardSchemaV1<unknown, unknown> {}
type AnySchema = Record<string, AnyValidator>;

let registeredSchema: AnySchema | null = null;
let hasDefineEnvBeenCalled = false;
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
  // Flip the presence flag once and leave it on — even if a future call
  // swaps in an empty schema, we still know defineEnv was declared.
  hasDefineEnvBeenCalled = true;
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
 *
 * Async lifecycle: this function awaits any async Standard Schema
 * validators (zod `refine`, arktype async narrows, etc.) and seeds the
 * per-key cache with the resolved values. Subsequent reads via `env.X`
 * hit the sync cache — async work only happens here, at boot. If a user
 * accesses `env.X` for a key with an async validator *before* this
 * function has run (e.g. during module-top-level code), the proxy will
 * throw with guidance pointing back to this boot-time pre-validation.
 */
export async function _validateEnvOnce(envValues: unknown): Promise<void> {
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
  const report = await validateAllEnvWithValues(registeredSchema, values);
  if (report.valid) {
    // Seed the sync cache with already-validated values so subsequent
    // `env.X` reads (including ones with async validators) hit the cache
    // instead of re-running validation. The cache key is the current raw
    // runtime env (matches what `readKey` will use). If no runtime env is
    // bound (e.g. called in an isolated test), skip seeding — the validator
    // result is still cached via bootValidationState.
    try {
      const cacheKey = getRawRuntimeEnv() as object;
      let cache = validatedCache.get(cacheKey);
      if (!cache) {
        cache = new Map();
        validatedCache.set(cacheKey, cache);
        cacheList.push(cache);
      }
      for (const [key, value] of report.values) {
        if (!cache.has(key)) {
          cache.set(key, value);
        }
      }
    } catch {
      // No runtime env available — no proxy reads will happen, so no seeding needed.
    }
    bootValidationState = { ok: true };
    return;
  }
  const lines: Array<string> = ['Env validation failed at worker boot:'];
  for (const key of report.missing) {
    lines.push(`  • ${key} is required but missing`);
  }
  for (const { key, messages } of report.invalid) {
    // Messages are already redacted inside validateAllEnvWithValues.
    lines.push(`  • ${key}: ${messages.join('; ')}`);
  }
  const error = new EnvValidationError('__init__', [{ message: lines.join('\n') }]);
  bootValidationState = { ok: false, error };
  throw error;
}

function validatedCacheValues(): Array<Map<string, unknown>> {
  // WeakMap doesn't expose values; we maintain a parallel list for clears.
  return cacheList;
}
const cacheList: Array<Map<string, unknown>> = [];

/** Internal: framework-only access to the registered schema (for plugin/CLI). */
export function _getRegisteredSchema(): AnySchema | null {
  return registeredSchema;
}

/**
 * Internal: returns `true` once `defineEnv()` has been called at least once,
 * regardless of whether the caller passed an empty schema. Gives tooling a
 * reliable signal — `_getRegisteredSchema()` alone can't distinguish
 * `defineEnv({})` (an intentional empty schema) from "never called".
 */
export function _hasRegisteredSchema(): boolean {
  return hasDefineEnvBeenCalled;
}

/**
 * Internal: extract `.default(value)` values from the registered schema as
 * stringified env values. Used by the plugin and deploy CLI to seed worker
 * `vars` so `c.env.X` and `process.env.X` see the same fallback that the
 * typed `env.X` proxy returns.
 *
 * Detection is schema-agnostic: probe each validator with `undefined` and,
 * if it succeeds with a non-undefined value, that value is the default.
 * Works for our built-in `.default(...)` helpers and for any Standard
 * Schema validator with intrinsic default behaviour. Async validators are
 * skipped (we can't get a sync default).
 *
 * Keys with no default — required keys, plain `.optional()` — are omitted
 * from the result so they don't shadow user `.env*` entries with empty
 * strings.
 */
export function _getSchemaDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {};
  if (!registeredSchema) {
    return defaults;
  }
  for (const [key, validator] of Object.entries(registeredSchema)) {
    let result: unknown;
    try {
      result = validator['~standard'].validate(undefined);
    } catch {
      continue;
    }
    if (result instanceof Promise) {
      continue;
    }
    const r = result as { value?: unknown; issues?: unknown };
    if (r.issues) {
      continue;
    }
    if (r.value === undefined || r.value === null) {
      continue;
    }
    defaults[key] = typeof r.value === 'string' ? r.value : String(r.value);
  }
  return defaults;
}

export class EnvValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    // Messages supplied to this constructor are expected to be pre-redacted
    // by the caller (readKey / _validateEnvOnce / validateAllEnvWithValues).
    // We intentionally don't re-scan here — we don't know the raw value at
    // this point in the chain — so the contract is enforced upstream.
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
      `env: Async validator for '${key}' cannot be resolved synchronously. ` +
        `Proxy property access is synchronous, so async Standard Schema ` +
        `validators must be pre-resolved by calling \`_validateEnvOnce(env)\` ` +
        `at worker boot (Void splices this into the generated entry) or by ` +
        `awaiting \`validateAllEnv(env)\` before the first \`env.${key}\` read. ` +
        `Once pre-validated, the resolved value is cached and served synchronously here.`,
    );
  }
  if (result.issues) {
    const unmask = isUnmaskActive();
    const override = getSecretOverride(validator);
    const redactedIssues = result.issues.map((i) => ({
      ...i,
      message: redactMessage(key, rawValue, i.message, { override, unmask }),
    }));
    throw new EnvValidationError(key, redactedIssues);
  }
  cache.set(key, result.value);
  return result.value;
}

/**
 * Typed env proxy. Reads from the runtime env, validating declared keys
 * on first access and passing through bindings / unknown keys unchanged.
 *
 * Sync-only: the `get` trap must be synchronous, so validators that return
 * a `Promise` cannot be awaited here. For async Standard Schema validators,
 * `_validateEnvOnce()` pre-resolves them at worker boot and seeds the
 * per-env cache; property reads then serve the cached value synchronously.
 * If an async validator is encountered here without a prior pre-validation,
 * the trap throws with guidance on how to resolve it.
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
  missing: Array<string>;
  invalid: Array<{ key: string; messages: Array<string> }>;
  /**
   * Resolved values for keys that validated successfully. Used to seed the
   * per-env cache after async pre-validation so sync `env.X` reads hit the
   * cache.
   */
  values: Map<string, unknown>;
}

/**
 * Validate an env record (e.g. merged `.env*` + remote secret list) against
 * the registered schema. Used by the dev plugin (warnings), the deploy CLI
 * (hard error), and `_validateEnvOnce` at worker boot.
 *
 * Async: awaits any validators that return a `Promise` (zod async refines,
 * arktype narrows, etc.). Callers already run in async contexts.
 */
export async function validateAllEnv(
  envValues: Record<string, unknown>,
): Promise<EnvValidationReport> {
  if (!registeredSchema) {
    return { valid: true, missing: [], invalid: [], values: new Map() };
  }
  return await validateAllEnvWithValues(registeredSchema, envValues);
}

/**
 * Internal: shared core that validates a schema against values and also
 * returns the resolved values (for cache seeding).
 */
async function validateAllEnvWithValues(
  schema: AnySchema,
  envValues: Record<string, unknown>,
): Promise<EnvValidationReport> {
  const report: EnvValidationReport = {
    valid: true,
    missing: [],
    invalid: [],
    values: new Map(),
  };
  const unmask = isUnmaskActive();
  for (const [key, validator] of Object.entries(schema)) {
    const raw = envValues[key];
    const resultMaybe = validator['~standard'].validate(raw);
    const result = resultMaybe instanceof Promise ? await resultMaybe : resultMaybe;
    if (result.issues) {
      report.valid = false;
      const isMissing = raw === undefined || raw === null || raw === '';
      if (isMissing) {
        report.missing.push(key);
      } else {
        const override: SecretOverride = getSecretOverride(validator);
        report.invalid.push({
          key,
          messages: result.issues.map((i) =>
            redactMessage(key, raw, i.message, { override, unmask }),
          ),
        });
      }
    } else {
      report.values.set(key, result.value);
    }
  }
  return report;
}

export { string, number, boolean, url, email, oneOf, json, type EnvSchema } from './env-helpers.ts';

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
      SANDBOX: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
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
