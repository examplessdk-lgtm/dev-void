import { memoryAdapter } from 'better-auth/adapters/memory';
import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { createVoidAuthRuntime } from '../../src/runtime/better-auth-shared.ts';

const env = { BETTER_AUTH_SECRET: 'local-test-secret-with-at-least-32-characters' };
const options = { dialect: 'sqlite' as const, providers: null };

function fixture() {
  const database = memoryAdapter({ user: [], session: [], account: [], verification: [] });
  const runtime = createVoidAuthRuntime(
    'sqlite',
    async () => ({ database, dispose: async () => {} }),
    async () => {},
  );
  const app = new Hono();
  app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => runtime.handleVoidAuthRequest(c, options));
  return app;
}

// Better Auth keeps its in-memory limiter for the whole module, so every test
// signs in from its own client address.
function signIn(clientIp: string | null, cf: boolean): Request {
  const request = new Request('https://app.test/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(clientIp ? { 'cf-connecting-ip': clientIp } : {}),
    },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password' }),
  });
  if (cf) {
    Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });
  }
  return request;
}

async function statuses(app: Hono, requests: () => Request, count: number) {
  const result: Array<number> = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    const response = await app.fetch(requests(), env);
    result.push(response.status);
  }
  return result;
}

describe('auth rate limits on deployed Cloudflare requests', () => {
  it('limits repeated sign-in attempts from one client IP', async () => {
    const app = fixture();
    const results = await statuses(app, () => signIn('203.0.113.10', true), 4);
    expect(results.slice(0, 3)).not.toContain(429);
    expect(results[3]).toBe(429);

    const other = await app.fetch(signIn('203.0.113.11', true), env);
    expect(other.status).not.toBe(429);
  });

  it('does not limit requests outside a deployed Worker', async () => {
    const app = fixture();
    const results = await statuses(app, () => signIn('203.0.113.12', false), 5);
    expect(results).not.toContain(429);
  });

  it.each(['127.0.0.1', '::1'])('does not limit a local preview from %s', async (ip) => {
    const app = fixture();
    const results = await statuses(app, () => signIn(ip, true), 5);
    expect(results).not.toContain(429);
  });

  it('does not limit Worker requests without a client IP', async () => {
    const app = fixture();
    const results = await statuses(app, () => signIn(null, true), 5);
    expect(results).not.toContain(429);
  });
});
