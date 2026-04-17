/**
 * Client-side variant of `void/env`.
 *
 * Selected via the `browser` export condition. Only `VITE_*` env keys are
 * accessible — Vite already strips non-prefixed keys from the client bundle,
 * so reaching for one here would silently return `undefined`. Instead we
 * throw a clear error pointing at the fix.
 *
 * Schema builders (`string`, `number`, …) and `defineEnv` are re-exported
 * unchanged so that `env.ts` can be imported into any module without
 * tripping bundler errors.
 */

interface ImportMetaEnvLike {
  readonly env?: Record<string, unknown>;
}

function readClientKey(key: string): unknown {
  if (!key.startsWith('VITE_')) {
    throw new Error(
      `Server-only env "${key}" was accessed from client code. ` +
        `Add the VITE_ prefix to expose it to the browser, or move the usage to a server module.`,
    );
  }
  const meta = import.meta as unknown as ImportMetaEnvLike;
  return meta.env?.[key];
}

export const env = new Proxy({} as Record<string, unknown>, {
  get(_target, key) {
    if (typeof key === 'symbol') {
      return undefined;
    }
    return readClientKey(String(key));
  },
  has(_target, key) {
    if (typeof key !== 'string') {
      return false;
    }
    if (!key.startsWith('VITE_')) {
      return false;
    }
    const meta = import.meta as unknown as ImportMetaEnvLike;
    return meta.env ? key in meta.env : false;
  },
  ownKeys() {
    const meta = import.meta as unknown as ImportMetaEnvLike;
    if (!meta.env) {
      return [];
    }
    return Object.keys(meta.env).filter((k) => k.startsWith('VITE_'));
  },
  getOwnPropertyDescriptor(_target, key) {
    if (typeof key !== 'string') {
      return undefined;
    }
    if (!key.startsWith('VITE_')) {
      return undefined;
    }
    return {
      enumerable: true,
      configurable: true,
      value: readClientKey(key),
    };
  },
}) as Record<string, unknown>;

/**
 * In client builds `defineEnv` is a no-op identity function — schema
 * registration only happens server-side. We still return the `env` proxy so
 * t3-style `export const env = defineEnv({...})` keeps working in shared
 * modules.
 */
export function defineEnv<S>(_schema: S): typeof env {
  return env;
}

export class EnvValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly issues: ReadonlyArray<{ message: string }>,
  ) {
    super(`Invalid env "${key}": ${issues.map((i) => i.message).join(', ')}`);
    this.name = 'EnvValidationError';
  }
}

export { string, number, boolean, url, email, oneOf, json, type EnvSchema } from './env-helpers';
