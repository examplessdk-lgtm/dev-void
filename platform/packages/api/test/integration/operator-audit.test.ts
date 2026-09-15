import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vite-plus/test';
import { app } from '../../src/index.ts';
import { operatorEvents } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const user = await createTestUser(env.db, 'audit-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, user);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function request(path: string, body?: unknown, bindings: TestEnv = env) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    bindings,
  );
}

function cloudflareWorkerStub(failScript?: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const script = /\/scripts\/([^/]+)/.exec(url)?.[1];
    if (init?.method === 'POST') {
      if (script === failScript) {
        return Response.json(
          { success: false, errors: [{ message: 'Permission denied' }] },
          { status: 403 },
        );
      }
      return Response.json({
        success: true,
        result: { id: 'new-deployment', versions: JSON.parse(String(init.body)).versions },
      });
    }
    if (url.endsWith('/versions')) {
      return Response.json({
        success: true,
        result: { items: [{ id: 'previous' }, { id: 'current' }] },
      });
    }
    if (url.endsWith('/deployments')) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            { id: 'current-deploy', versions: [{ version_id: 'current', percentage: 100 }] },
            { id: 'previous-deploy', versions: [{ version_id: 'previous', percentage: 100 }] },
          ],
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
}

test('previews and reads produce no audit or configuration writes', async () => {
  await env.ROUTING.put('signup:enabled', 'false');
  const res = await request('/signup/restrict', { dryRun: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ dryRun: true, action: 'signup.restrict' });
  expect(await env.ROUTING.get('signup:enabled')).toBe('false');
  expect((await request('/signup')).status).toBe(200);
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
});

test('records actor, target, and success without recording credentials', async () => {
  const res = await request('/signup/restrict', { credential: 'must-not-be-audited' });
  expect(res.status).toBe(200);
  expect(res.headers.get('X-Void-Audit-Id')).toBeTruthy();
  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    login: 'audit-admin',
    action: 'signup/restrict',
    target: JSON.stringify({ restrictionsEnabled: true }),
    status: 'success',
    http_status: 200,
  });
  expect(JSON.stringify(events)).not.toContain(token);
  expect(JSON.stringify(events)).not.toContain('must-not-be-audited');
  const page = await request('/system/events?limit=1');
  expect(await page.json()).toMatchObject({ total: 1, limit: 1, page: 1 });
});

test('records failed validation as a failed mutation attempt', async () => {
  const res = await request('/signup/allow', { type: 'invalid', pattern: 'anything' });
  expect(res.status).toBe(400);
  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    target: JSON.stringify({ type: 'invalid', pattern: 'anything' }),
    status: 'failed',
    http_status: 400,
  });
});

test('records complete and partial 207 mutation outcomes as failed', async () => {
  cloudflareWorkerStub('void-api');
  const failed = await request('/workers/api/rollback', {
    environment: 'production',
    versionId: 'previous',
  });
  expect(failed.status).toBe(207);
  expect(await failed.json()).toMatchObject({ ok: false, partial: false });

  vi.restoreAllMocks();
  cloudflareWorkerStub('void-dashboard-staging');
  const partial = await request('/workers/rollback-all', {
    environment: 'staging',
    versions: {
      dispatch: 'previous',
      dashboard: 'previous',
      api: 'previous',
      tail: 'previous',
      proxy: 'previous',
    },
  });
  expect(partial.status).toBe(207);
  expect(await partial.json()).toMatchObject({ ok: false, partial: true });

  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(2);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'workers/api/rollback',
        status: 'failed',
        http_status: 207,
      }),
      expect.objectContaining({
        action: 'workers/rollback-all',
        status: 'failed',
        http_status: 207,
      }),
    ]),
  );
});

test('records a successful 200 mutation outcome as successful', async () => {
  cloudflareWorkerStub();
  const response = await request('/workers/api/rollback', {
    environment: 'production',
    versionId: 'previous',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, partial: false });
  expect(await env.db.select().from(operatorEvents)).toEqual([
    expect.objectContaining({
      action: 'workers/api/rollback',
      status: 'success',
      http_status: 200,
    }),
  ]);
});

test('records the effective worker environment for implicit and explicit rollbacks', async () => {
  cloudflareWorkerStub();
  const staging = { ...env, PLATFORM_ENV: 'staging' };
  const versions = {
    dispatch: 'previous',
    dashboard: 'previous',
    api: 'previous',
    tail: 'previous',
    proxy: 'previous',
  };

  expect(
    await (await request('/workers/api/rollback', { versionId: 'previous' }, staging)).json(),
  ).toMatchObject({ environment: 'staging' });
  expect(
    await (await request('/workers/rollback-all', { versions }, staging)).json(),
  ).toMatchObject({ environment: 'staging' });
  expect(
    await (
      await request(
        '/workers/api/rollback',
        { environment: 'production', versionId: 'previous' },
        staging,
      )
    ).json(),
  ).toMatchObject({ environment: 'production' });

  const events = await env.db.select().from(operatorEvents);
  expect(events.map((event) => JSON.parse(event.target).environment)).toEqual([
    'staging',
    'staging',
    'production',
  ]);
});

test('records sanitized action targets and change arguments', async () => {
  await request('/signup/allow', {
    type: 'email',
    pattern: 'Alice@Example.com',
    note: 'First cohort',
  });
  await request('/signup/allow', { type: 'email', pattern: 'Bob@Example.com' });
  await env.db.delete(operatorEvents);

  expect(
    (await request('/signup/remove', { type: 'email', pattern: 'Alice@Example.com' })).status,
  ).toBe(200);
  expect(
    (await request('/signup/remove', { type: 'email', pattern: 'Bob@Example.com' })).status,
  ).toBe(200);
  expect(
    (
      await request('/invitations/send', {
        emails: ['Invite-One@Example.com', 'invite-two@example.com'],
      })
    ).status,
  ).toBe(200);

  const user = await createTestUser(env.db, 'audit-target-user');
  expect((await request(`/users/${user.id}/plan`, { plan: 'pro' })).status).toBe(200);
  expect(
    (await request(`/users/${user.id}/suspend`, { reason: 'abuse investigation' })).status,
  ).toBe(200);

  const events = await env.db.select().from(operatorEvents);
  const targets = Object.fromEntries(
    events.map((event) => [event.action, JSON.parse(event.target)]),
  );
  expect(targets).toMatchObject({
    'signup/remove': { type: 'email', pattern: 'bob@example.com' },
    'invitations/send': {
      emails: ['invite-one@example.com', 'invite-two@example.com'],
    },
    [`users/${user.id}/plan`]: { userId: user.id, plan: 'pro' },
    [`users/${user.id}/suspend`]: {
      userId: user.id,
      reason: 'abuse investigation',
    },
  });
  expect(
    events
      .filter((event) => event.action === 'signup/remove')
      .map((event) => JSON.parse(event.target).pattern),
  ).toEqual(['alice@example.com', 'bob@example.com']);
});
