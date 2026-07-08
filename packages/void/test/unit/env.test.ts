import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { env } from '../../src/runtime/env-public.ts';
import {
  getRuntimeBinding,
  getRuntimeEnv,
  requireRuntimeBinding,
  withRuntimeEnv,
} from '../../src/runtime/env.ts';

const globalScope = globalThis as {
  __env__?: unknown;
};

const originalNuxtEnv = globalScope.__env__;

describe('runtime env resolution', () => {
  beforeEach(() => {
    delete globalScope.__env__;
  });

  afterAll(() => {
    if (originalNuxtEnv === undefined) {
      delete globalScope.__env__;
    } else {
      globalScope.__env__ = originalNuxtEnv;
    }
  });

  it('reads Nuxt env from global __env__', () => {
    globalScope.__env__ = { DB: { tag: 'nuxt-db' } };
    expect(getRuntimeBinding('DB')).toEqual({ tag: 'nuxt-db' });
  });

  it('ignores pending Nuxt env promises', () => {
    globalScope.__env__ = Promise.resolve({ DB: { tag: 'nuxt-db' } });
    expect(() => getRuntimeEnv()).toThrow('env: Cloudflare env is unavailable');
  });

  it('uses request-scoped context env when provided', () => {
    globalScope.__env__ = { DB: { tag: 'nuxt-db' } };

    const value = withRuntimeEnv({ DB: { tag: 'scoped-db' } }, () => getRuntimeBinding('DB'));
    expect(value).toEqual({ tag: 'scoped-db' });
  });

  it('throws when no runtime env is available', () => {
    expect(() => getRuntimeEnv()).toThrow('env: Cloudflare env is unavailable');
  });
});

// FIX 3: ISR_CACHE is a framework-internal binding with no internal prefix. It
// must be hidden from every public env surface (matching the generated c.env
// filter), while normal bindings pass through.
describe('internal binding filtering — ISR_CACHE (exact-name)', () => {
  it('hides ISR_CACHE from getRuntimeEnv / getRuntimeBinding / requireRuntimeBinding', () => {
    withRuntimeEnv(
      { DB: { tag: 'db' }, ISR_CACHE: { tag: 'isr-kv' }, __VOID_TOKEN: 'secret' },
      () => {
        const filtered = getRuntimeEnv() as Record<string, unknown>;
        // Normal binding still visible.
        expect(filtered.DB).toEqual({ tag: 'db' });
        expect('DB' in filtered).toBe(true);
        // ISR_CACHE hidden by exact name.
        expect(filtered.ISR_CACHE).toBeUndefined();
        expect('ISR_CACHE' in filtered).toBe(false);
        expect(Object.keys(filtered)).not.toContain('ISR_CACHE');
        // Prefixed internal still hidden (regression guard for the prefix path).
        expect('__VOID_TOKEN' in filtered).toBe(false);

        expect(getRuntimeBinding('DB')).toEqual({ tag: 'db' });
        expect(getRuntimeBinding('ISR_CACHE')).toBeUndefined();
        expect(() => requireRuntimeBinding('ISR_CACHE')).toThrow(
          "env: Missing Cloudflare binding 'ISR_CACHE'.",
        );
      },
    );
  });

  it('hides ISR_CACHE from the public `env` proxy (absent + not enumerated), keeps normal bindings', () => {
    withRuntimeEnv({ DB: { tag: 'db' }, ISR_CACHE: { tag: 'isr-kv' } }, () => {
      expect('ISR_CACHE' in env).toBe(false);
      expect('DB' in env).toBe(true);
      expect(Object.keys(env)).not.toContain('ISR_CACHE');
      expect(Object.keys(env)).toContain('DB');
      expect((env as Record<string, unknown>).ISR_CACHE).toBeUndefined();
      expect((env as Record<string, unknown>).DB).toEqual({ tag: 'db' });
    });
  });
});
