import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getRuntimeBinding, getRuntimeEnv, withRuntimeEnv } from '../../src/runtime/env.ts';

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
