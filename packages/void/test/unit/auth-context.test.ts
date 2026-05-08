import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  authContext,
  getSession,
  getUser,
  type AuthState,
  type AuthUser,
} from '../../src/runtime/auth.ts';

const AUTH_CONTEXT_SYMBOL = Symbol.for('void.authContext.v1');

describe('authContext', () => {
  it('runs callback with provided store and exposes it via getUser/getSession', () => {
    const user = {
      id: 'u1',
      email: 'a@b.c',
      emailVerified: false,
      name: 'A',
      image: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } satisfies AuthUser;
    const state = {
      user,
      session: {
        id: 's1',
        token: 't1',
        userId: user.id,
        expiresAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    } satisfies AuthState;

    expect(getUser()).toBeNull();
    expect(getSession()).toBeNull();

    authContext.run({ user, state }, () => {
      expect(getUser()).toBe(user);
      expect(getSession()).toBe(state);
    });

    expect(getUser()).toBeNull();
    expect(getSession()).toBeNull();
  });

  it('is registered on globalThis under Symbol.for("void.authContext.v1")', () => {
    const stored = (globalThis as Record<symbol, unknown>)[AUTH_CONTEXT_SYMBOL];
    expect(stored).toBe(authContext);
    expect(stored).toBeInstanceOf(AsyncLocalStorage);
  });

  it('returns the same ALS instance across module re-evaluations', async () => {
    // Regression guard for the original bug: when auth.ts is loaded twice
    // (e.g. once by void's bundled runtime, once by Vite's SSR module runner
    // resolving `void/auth` for user code), both evaluations must share one
    // AsyncLocalStorage. Otherwise middleware writes to one instance and
    // user-land getUser() reads another, always returning null.
    //
    // vi.resetModules() drops the module cache so the next dynamic import
    // re-evaluates auth.ts top-to-bottom — exactly the dual-load scenario.
    vi.resetModules();
    const first = await import('../../src/runtime/auth.ts');
    vi.resetModules();
    const second = await import('../../src/runtime/auth.ts');

    expect(first.authContext).toBe(second.authContext);

    // And the statically-imported binding at the top of this file is the same
    // instance as both re-evaluated copies — covers user-land import paths.
    expect(authContext).toBe(first.authContext);
  });

  it('propagates store across a re-evaluated import boundary', async () => {
    // Tightens the previous test: the bug only surfaces when one side writes
    // and the other reads. Write through the statically-imported authContext,
    // read through a re-evaluated copy of getUser.
    vi.resetModules();
    const fresh = await import('../../src/runtime/auth.ts');

    const user = {
      id: 'u2',
      email: 'c@d.e',
      emailVerified: false,
      name: 'B',
      image: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } satisfies AuthUser;
    const state = {
      user,
      session: {
        id: 's2',
        token: 't2',
        userId: user.id,
        expiresAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    } satisfies AuthState;

    authContext.run({ user, state }, () => {
      expect(fresh.getUser()).toBe(user);
      expect(fresh.getSession()).toBe(state);
    });
  });
});
