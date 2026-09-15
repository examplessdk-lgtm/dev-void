import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { signJwt, verifyJwt } from '../../src/auth/jwt.ts';
import { app } from '../../src/index.ts';
import { operatorEvents, operatorSessions, users } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  vi.restoreAllMocks();
});

function request(path: string, token?: string, body?: unknown, origin = 'http://localhost') {
  return app.fetch(
    new Request(`${origin}/operator/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

describe('operator authentication', () => {
  test('explicit elevation issues a short-lived origin-bound session separate from application auth', async () => {
    const admin = await createTestUser(env.db, 'operator', 'github', undefined, 'free', 'admin');
    const res = await request('/session', admin.jwt, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { token: string; expiresAt: string; user: { id: string } };
    const payload = await verifyJwt(body.token, env.JWT_SECRET, 'operator');
    expect(payload).toMatchObject({
      sub: admin.id,
      aud: 'operator',
      operatorOrigin: 'http://localhost',
    });
    expect(payload!.exp - payload!.iat).toBe(3600);
    expect(body.user.id).toBe(admin.id);
    expect((await request('/session', body.token)).status).toBe(200);
    expect(
      (await request('/session', body.token, undefined, 'https://other.example.com')).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request('http://localhost/me', {
            headers: { Authorization: `Bearer ${body.token}` },
          }),
          env,
        )
      ).status,
    ).toBe(401);
  });

  test('rejects regular users, browser cookies, API tokens and scoped deploy tokens for operations', async () => {
    const user = await createTestUser(env.db);
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    expect((await request('/session', user.jwt, {})).status).toBe(403);
    const deploy = await signJwt(
      { sub: admin.id, login: admin.login, aud: 'deploy', project: 'project' },
      env.JWT_SECRET,
    );
    for (const token of [admin.jwt, admin.adminJwt, deploy]) {
      expect((await request('/session', token)).status).toBe(401);
    }
    expect((await request('/session', deploy, {})).status).toBe(401);
    expect((await request('/session', admin.adminJwt, {})).status).toBe(401);
    const res = await app.fetch(
      new Request('http://localhost/operator/v1/session', {
        headers: { Cookie: `admin_token=${admin.adminJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('Location')).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  test('revokes sessions on logout and enforces current role and suspension', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const token = await createOperatorToken(env.db, admin);
    expect((await request('/session', token)).status).toBe(200);
    await env.db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id));
    expect((await request('/session', token)).status).toBe(403);
    await env.db
      .update(users)
      .set({ role: 'admin', suspended_reason: 'admin' })
      .where(eq(users.id, admin.id));
    expect((await request('/session', token)).status).toBe(403);
    expect((await request('/session', admin.jwt, {})).status).toBe(403);
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, admin.id));
    expect((await request('/session/logout', token, {})).status).toBe(200);
    expect((await request('/session', token)).status).toBe(401);
  });

  test('rejects expired, absent and forged sessions even with a signed operator JWT', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const absent = await signJwt(
      {
        sub: admin.id,
        login: admin.login,
        aud: 'operator',
        jti: 'missing',
        operatorOrigin: 'http://localhost',
      },
      env.JWT_SECRET,
    );
    expect((await request('/session', absent)).status).toBe(401);
    const token = await createOperatorToken(env.db, admin);
    await env.db.update(operatorSessions).set({ expires_at: new Date(0).toISOString() });
    expect((await request('/session', token)).status).toBe(401);
    expect((await request('/session', `${token}forged`)).status).toBe(401);
  });

  test('ignores development browser auth bypass for operator endpoints', async () => {
    await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const res = await app.fetch(new Request('http://localhost/operator/v1/session'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
    });
    expect(res.status).toBe(401);
  });

  test('validates JSON object, body size, and pagination with machine-readable errors', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    for (const body of [null, [], 'string', { dryRun: 'false' }]) {
      const res = await request('/session', admin.jwt, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('message');
    }
    const oversized = await request('/session', admin.jwt, { data: 'a'.repeat(40_000) });
    expect(oversized.status).toBe(413);
    const token = await createOperatorToken(env.db, admin);
    for (const query of ['page=0', 'limit=101', 'page=1x', 'limit=-1', 'page=9007199254740992']) {
      expect((await request(`/system/events?${query}`, token)).status).toBe(400);
    }
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });
});
