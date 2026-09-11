import { describe, expect, it } from 'vite-plus/test';
import { buildManagerNamespace } from '../../src/build-namespace.ts';
import type { ApiEnv } from '../../src/env.ts';

// Two distinct sentinel objects so we can assert WHICH namespace was returned by
// identity. The picker only reads these two fields, so a partial cast is enough.
const BASE = { __which: 'base' } as unknown as DurableObjectNamespace;
const LARGE = { __which: 'large' } as unknown as DurableObjectNamespace;
const env = {
  BUILD_MANAGER: BASE,
  BUILD_MANAGER_LARGE: LARGE,
} as unknown as ApiEnv['Bindings'];

describe('buildManagerNamespace', () => {
  it('routes standard-4 to the large namespace', () => {
    expect(buildManagerNamespace(env, 'standard-4')).toBe(LARGE);
  });

  it('routes the free (standard-3) instance to the base namespace', () => {
    expect(buildManagerNamespace(env, 'standard-3')).toBe(BASE);
  });

  it('routes legacy sizes (standard-1) to the base namespace', () => {
    expect(buildManagerNamespace(env, 'standard-1')).toBe(BASE);
  });

  it('routes null to the base namespace', () => {
    expect(buildManagerNamespace(env, null)).toBe(BASE);
  });

  it('routes undefined to the base namespace', () => {
    expect(buildManagerNamespace(env, undefined)).toBe(BASE);
  });

  it('routes an arbitrary/unknown string to the base namespace', () => {
    expect(buildManagerNamespace(env, 'something-else')).toBe(BASE);
  });
});
