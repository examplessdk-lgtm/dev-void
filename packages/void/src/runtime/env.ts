/**
 * Public runtime env API — exposed via "void/_env".
 *
 * All exports from this module are accessible to user code.
 * Internal platform bindings (__VOID_*, __PROJECT_*) are filtered
 * from getRuntimeEnv() and blocked in getRuntimeBinding().
 */
import {
  envContext,
  asEnv,
  getRawRuntimeEnv,
  INTERNAL_BINDING_PREFIXES,
  type RuntimeEnv,
} from './env-raw.ts';

export type { RuntimeEnv };

export function withRuntimeEnv<T>(env: unknown, fn: () => T): T {
  const resolved = asEnv(env);
  if (!resolved) {
    return fn();
  }
  return envContext.run(resolved, fn);
}

function isInternalBinding(name: string): boolean {
  return INTERNAL_BINDING_PREFIXES.some((p) => name.startsWith(p));
}

function filterEnvProxy(env: RuntimeEnv): RuntimeEnv {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && isInternalBinding(prop)) {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && isInternalBinding(prop)) {
        return false;
      }
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        (key) => typeof key !== 'string' || !isInternalBinding(key),
      );
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && isInternalBinding(prop)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/** Returns the runtime env with internal platform bindings hidden. */
export function getRuntimeEnv(): RuntimeEnv {
  return filterEnvProxy(getRawRuntimeEnv());
}

export function getRuntimeBinding<T = unknown>(name: string): T | undefined {
  if (isInternalBinding(name)) {
    return undefined;
  }
  return getRawRuntimeEnv()[name] as T | undefined;
}

export function requireRuntimeBinding<T = unknown>(name: string): T {
  const value = getRuntimeBinding<T>(name);
  if (value !== undefined && value !== null) {
    return value;
  }
  throw new Error(`env: Missing Cloudflare binding '${name}'.`);
}
