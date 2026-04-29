import { describe, it, expect } from 'vitest';
import {
  getRuntimeBinding,
  getRuntimeEnv,
  withRuntimeEnv,
  requireRuntimeBinding,
} from '../../src/runtime/env.ts';

describe('internal binding filtering (real implementation)', () => {
  const testEnv = {
    DB: 'd1-binding',
    KV: 'kv-binding',
    __VOID_PROXY_TOKEN: 'secret-token',
    __VOID_PROXY: { fetch: () => {} },
    __PROJECT_ID: 'proj_123',
    MY_VAR: 'hello',
  };

  it('getRuntimeBinding blocks __VOID_PROXY_TOKEN', () => {
    const result = withRuntimeEnv(testEnv, () => getRuntimeBinding('__VOID_PROXY_TOKEN'));
    expect(result).toBeUndefined();
  });

  it('getRuntimeBinding blocks __VOID_PROXY', () => {
    const result = withRuntimeEnv(testEnv, () => getRuntimeBinding('__VOID_PROXY'));
    expect(result).toBeUndefined();
  });

  it('getRuntimeBinding blocks __PROJECT_ID', () => {
    const result = withRuntimeEnv(testEnv, () => getRuntimeBinding('__PROJECT_ID'));
    expect(result).toBeUndefined();
  });

  it('getRuntimeBinding allows user bindings', () => {
    const db = withRuntimeEnv(testEnv, () => getRuntimeBinding('DB'));
    expect(db).toBe('d1-binding');
    const kv = withRuntimeEnv(testEnv, () => getRuntimeBinding('KV'));
    expect(kv).toBe('kv-binding');
  });

  it('requireRuntimeBinding throws for __VOID_ prefixed names', () => {
    expect(() =>
      withRuntimeEnv(testEnv, () => requireRuntimeBinding('__VOID_PROXY_TOKEN')),
    ).toThrow("env: Missing Cloudflare binding '__VOID_PROXY_TOKEN'");
  });

  it('getRuntimeEnv hides __VOID_ keys from property access', () => {
    const env = withRuntimeEnv(testEnv, () => getRuntimeEnv());
    expect(env.__VOID_PROXY_TOKEN).toBeUndefined();
    expect(env.__VOID_PROXY).toBeUndefined();
    expect(env.__PROJECT_ID).toBeUndefined();
    expect(env.DB).toBe('d1-binding');
  });

  it('getRuntimeEnv hides internal keys from Object.keys', () => {
    const env = withRuntimeEnv(testEnv, () => getRuntimeEnv());
    const keys = Object.keys(env);
    expect(keys).toContain('DB');
    expect(keys).toContain('KV');
    expect(keys).toContain('MY_VAR');
    expect(keys).not.toContain('__VOID_PROXY_TOKEN');
    expect(keys).not.toContain('__VOID_PROXY');
    expect(keys).not.toContain('__PROJECT_ID');
  });

  it("getRuntimeEnv hides internal keys from 'in' operator", () => {
    const env = withRuntimeEnv(testEnv, () => getRuntimeEnv());
    expect('DB' in env).toBe(true);
    expect('__VOID_PROXY_TOKEN' in env).toBe(false);
  });
});
