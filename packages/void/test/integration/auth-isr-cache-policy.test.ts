import { handleIsr, type IsrCacheEnv } from '@void/isr/runtime';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { createVoidAuthRuntime } from '../../src/runtime/better-auth-shared.ts';

const env = { BETTER_AUTH_SECRET: 'local-test-secret-with-at-least-32-characters' };
const options = { dialect: 'sqlite' as const, providers: null };

function fixture() {
  const database = memoryAdapter({});
  const runtime = createVoidAuthRuntime(
    'sqlite',
    async () => ({ database, dispose: async () => {} }),
    async () => {},
  );
  const app = new Hono();
  app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options));
  return { app, runtime, database };
}

describe('real anonymous Better Auth lookup cache policy', () => {
  it('does not copy the null-session lookup policy onto an ordinary response', async () => {
    const { app, runtime } = fixture();
    const request = new Request('https://app.test/assets/client-abcdefgh.js');
    const { auth, dispose } = await runtime.createVoidAuth(request, env, options);
    try {
      const lookup = await auth.api.getSession({
        headers: request.headers,
        asResponse: false,
        returnHeaders: true,
      });
      expect(lookup.response).toBeNull();
      expect(lookup.headers.get('cache-control')).toBe('no-store');
      expect(lookup.headers.get('pragma')).toBe('no-cache');
      expect(lookup.headers.has('set-cookie')).toBe(false);
    } finally {
      await dispose();
    }
    app.get(
      '/assets/client-abcdefgh.js',
      () =>
        new Response('export const value = 1;', {
          headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        }),
    );
    const response = await app.fetch(request, env);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.has('pragma')).toBe(false);
    await expect(response.text()).resolves.toBe('export const value = 1;');
  });

  it('allows anonymous ISR to populate KV and serve a hit on the next request', async () => {
    const { app } = fixture();
    let renders = 0;
    app.get('/revalidate', (c) => c.html(`<html>render ${++renders}</html>`));
    const records = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
    const cacheEnv: IsrCacheEnv = {
      ISR_CACHE: {
        async getWithMetadata(key: string) {
          return records.get(key) ?? { value: null, metadata: null };
        },
        async put(key: string, value: ArrayBuffer, config: { metadata: unknown }) {
          records.set(key, { value, metadata: config.metadata });
        },
        async list() {
          return { keys: [...records.keys()].map((name) => ({ name })), list_complete: true };
        },
      } as unknown as KVNamespace,
    };
    const request = new Request('https://app.test/revalidate', {
      headers: { 'x-fixture-guard': 'allowed' },
    });
    const tasks: Array<Promise<unknown>> = [];
    const context = {
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const render = async (input: Request): Promise<Response> => app.fetch(input, env);
    const policy = { deploymentId: 'test-deployment', revalidate: { '/revalidate': 60 } };
    const first = await handleIsr(request, cacheEnv, context, policy, render);
    expect(first?.headers.get('x-isr-cache')).toBe('MISS');
    await Promise.all(tasks);
    expect(records.size).toBeGreaterThan(0);
    const second = await handleIsr(request, cacheEnv, context, policy, render);
    expect(second?.headers.get('x-isr-cache')).toBe('HIT');
    expect(renders).toBe(1);
    await expect(second?.text()).resolves.toBe('<html>render 1</html>');
  });

  it('retains the actual auth endpoint no-store and no-cache headers', async () => {
    const { app, runtime } = fixture();
    app.get('/api/auth/get-session', (c) => runtime.handleVoidAuthRequest(c, options));
    const response = await app.request('https://app.test/api/auth/get-session', undefined, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    await expect(response.json()).resolves.toBeNull();
  });
});

describe('real authenticated Better Auth session cache policy', () => {
  async function signedInApp(routeHeaders: Record<string, string>) {
    const database = memoryAdapter({ user: [], session: [], account: [], verification: [] });
    const runtime = createVoidAuthRuntime(
      'sqlite',
      async () => ({ database, dispose: async () => {} }),
      async () => {},
    );
    const app = new Hono();
    app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options));
    app.on(['GET', 'POST'], '/api/auth/*', (c) => runtime.handleVoidAuthRequest(c, options));
    app.get('/api/report', (c) => c.text('report', 200, routeHeaders));
    const signUp = await app.request(
      'https://app.test/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Cache user',
          email: 'cache-user@example.test',
          password: 'correct-horse-battery-staple',
        }),
      },
      env,
    );
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = await app.request(
      'https://app.test/api/auth/get-session',
      { headers: { cookie } },
      env,
    );
    await expect(session.json()).resolves.toMatchObject({
      user: { email: 'cache-user@example.test' },
    });
    return { app, cookie };
  }

  it.each(['private, no-cache', 'private, max-age=60', 'no-store'])(
    'keeps a route policy that already stays out of shared caches: %s',
    async (policy) => {
      const { app, cookie } = await signedInApp({ 'cache-control': policy, etag: 'W/"report-1"' });
      const response = await app.request(
        'https://app.test/api/report',
        { headers: { cookie } },
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(policy);
      expect(response.headers.has('pragma')).toBe(false);
      expect(response.headers.get('etag')).toBe('W/"report-1"');
    },
  );

  it.each([null, 'public, max-age=60', 'no-cache', 'private="set-cookie", max-age=60'])(
    'applies the session lookup no-store to a route policy of %s',
    async (policy) => {
      const { app, cookie } = await signedInApp(policy ? { 'cache-control': policy } : {});
      const response = await app.request(
        'https://app.test/api/report',
        { headers: { cookie } },
        env,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    },
  );
});
