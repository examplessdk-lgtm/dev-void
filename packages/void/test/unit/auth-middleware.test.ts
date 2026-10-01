import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: mocks.betterAuth,
}));

import type { AuthState } from '../../src/runtime/auth.ts';
import {
  createVoidAuthRuntime,
  type VoidAuthRuntimeOptions,
} from '../../src/runtime/better-auth-shared.ts';

const authRuntimeOptions: VoidAuthRuntimeOptions = {
  dialect: 'sqlite',
  providers: null,
};

const runtime = createVoidAuthRuntime(
  'sqlite',
  async () => {
    throw new Error('Unexpected database resolution.');
  },
  async () => {},
);

function createApp(sessionResult: { response: AuthState | null; headers: Headers }): Hono {
  mocks.getSession.mockResolvedValue(sessionResult);
  mocks.betterAuth.mockReturnValue({
    api: { getSession: mocks.getSession },
  });

  const app = new Hono();
  app.use(async (c, next) => {
    await runtime.runVoidAuthMiddleware(c, next, authRuntimeOptions, {} as never);
  });
  return app;
}

beforeEach(() => {
  mocks.betterAuth.mockReset();
  mocks.getSession.mockReset();
});

describe('runVoidAuthMiddleware response headers', () => {
  it('adds auth headers to an immutable response without changing its body or status', async () => {
    const authHeaders = new Headers();
    authHeaders.set('x-auth-refresh', 'refreshed');
    authHeaders.append('set-cookie', 'session=one; Path=/; HttpOnly');
    authHeaders.append('set-cookie', 'csrf=two; Path=/');
    const app = createApp({ response: null, headers: authHeaders });

    app.get('/public', () => fetch('data:text/plain,public%20content'));

    const response = await app.request('http://localhost/public', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-auth-refresh')).toBe('refreshed');
    expect(response.headers.getSetCookie()).toEqual([
      'session=one; Path=/; HttpOnly',
      'csrf=two; Path=/',
    ]);
    await expect(response.text()).resolves.toBe('public content');
  });

  it('appends auth cookies while replacing other response headers', async () => {
    const authHeaders = new Headers();
    authHeaders.set('cache-control', 'private, no-store');
    authHeaders.append('set-cookie', 'session=auth; Path=/; HttpOnly');
    const app = createApp({ response: null, headers: authHeaders });

    app.get(
      '/response',
      () =>
        new Response('ok', {
          status: 202,
          headers: {
            'cache-control': 'public, max-age=60',
            'set-cookie': 'route=existing; Path=/',
          },
        }),
    );

    const response = await app.request('http://localhost/response', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual([
      'route=existing; Path=/',
      'session=auth; Path=/; HttpOnly',
    ]);
    await expect(response.text()).resolves.toBe('ok');
  });

  it.each(['public, max-age=60', 'private', 'no-store', 'no-cache'])(
    'preserves an anonymous application cache policy: %s',
    async (policy) => {
      const app = createApp({
        response: null,
        headers: new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' }),
      });
      app.get('/public', (c) => c.text('content', 200, { 'cache-control': policy }));
      const response = await app.request('http://localhost/public', undefined, {
        BETTER_AUTH_SECRET: 'test-secret',
      });
      expect(response.headers.get('cache-control')).toBe(policy);
      expect(response.headers.has('pragma')).toBe(false);
    },
  );

  it.each(['cookie', 'authorization', 'cf-access-jwt-assertion'])(
    'keeps the session lookup private for requests with %s',
    async (header) => {
      const app = createApp({
        response: null,
        headers: new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' }),
      });
      app.get('/private', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
      const response = await app.request(
        'http://localhost/private',
        { headers: { [header]: 'synthetic-credential' } },
        { BETTER_AUTH_SECRET: 'test-secret' },
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    },
  );

  it('keeps a resolved authenticated session private even without a request credential header', async () => {
    const now = new Date();
    const app = createApp({
      response: {
        user: {
          id: 'local-user',
          name: 'Local user',
          email: 'user@example.test',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        session: {
          id: 'local-session',
          userId: 'local-user',
          token: 'synthetic-token',
          expiresAt: now,
          createdAt: now,
          updatedAt: now,
        },
      },
      headers: new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' }),
    });
    app.get('/private', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
    const response = await app.request('http://localhost/private', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  it('does not allow a cookie rotation without its own cache policy to retain a public response', async () => {
    const app = createApp({
      response: null,
      headers: new Headers({ 'set-cookie': 'session=rotated; Path=/; HttpOnly' }),
    });
    app.get('/refresh', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
    const response = await app.request('http://localhost/refresh', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual(['session=rotated; Path=/; HttpOnly']);
  });
});
