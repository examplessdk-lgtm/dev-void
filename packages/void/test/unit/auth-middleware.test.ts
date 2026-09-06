import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: mocks.betterAuth,
}));

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

function createApp(sessionResult: { response: null; headers: Headers }): Hono {
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

    const response = await app.request('http://localhost/public', undefined, {});

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

    const response = await app.request('http://localhost/response', undefined, {});

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual([
      'route=existing; Path=/',
      'session=auth; Path=/; HttpOnly',
    ]);
    await expect(response.text()).resolves.toBe('ok');
  });
});
