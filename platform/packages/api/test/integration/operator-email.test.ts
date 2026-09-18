import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import {
  EMAIL_DOMAIN_MANAGEMENT_SETTING,
  EMAIL_RECIPIENT_POLICY_MIRROR_KEY,
  EMAIL_RECIPIENT_POLICY_SETTING,
} from '../../src/email/settings.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { operatorEvents, platformSettings } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
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
  await env.ROUTING.delete(EMAIL_RECIPIENT_POLICY_MIRROR_KEY);
  const admin = await createTestUser(env.db, 'email-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function req(
  path: string,
  body?: Record<string, unknown>,
  overrides?: Partial<ApiEnv['Bindings']>,
) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { ...env, ...overrides },
  );
}

async function setting(key: string): Promise<unknown> {
  const rows = await env.db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  return rows[0]?.value ?? null;
}

async function events() {
  return env.db.select().from(operatorEvents);
}

describe('operator email recipient policy', () => {
  test('defaults to verified-only and repairs a missing mirror on read', async () => {
    const response = await req('/email/policy');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policy: { mode: 'verified', domains: [] } });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'verified', domains: [] }),
    );
  });

  test('previews without writing, then applies to the database and the KV mirror', async () => {
    const preview = await req('/email/policy', {
      mode: 'domains',
      domains: 'Corp.Example, example.net corp.example',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.policy.set',
      target: { mode: 'domains', domains: ['corp.example', 'example.net'] },
      previous: { mode: 'verified', domains: [] },
    });
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toBeNull();
    expect(await events()).toHaveLength(0);

    const response = await req('/email/policy', {
      mode: 'domains',
      domains: 'Corp.Example, example.net corp.example',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'email.policy.set',
      policy: { mode: 'domains', domains: ['corp.example', 'example.net'] },
    });
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({
      mode: 'domains',
      domains: ['corp.example', 'example.net'],
    });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'domains', domains: ['corp.example', 'example.net'] }),
    );
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/policy', status: 'success' });
    expect(JSON.parse(recorded[0]!.target)).toEqual({
      mode: 'domains',
      domains: 'corp.example, example.net corp.example',
    });

    const read = await req('/email/policy');
    expect(await read.json()).toEqual({
      policy: { mode: 'domains', domains: ['corp.example', 'example.net'] },
    });
  });

  test('`any` and `verified` drop the domain list', async () => {
    await req('/email/policy', { mode: 'domains', domains: 'corp.example' });
    const response = await req('/email/policy', { mode: 'any', domains: 'ignored.example' });
    expect(response.status).toBe(200);
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({ mode: 'any', domains: [] });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'any', domains: [] }),
    );
  });

  test.each([
    ['an unknown mode', { mode: 'open' }],
    ['`domains` without any domain', { mode: 'domains' }],
    ['`domains` with an invalid domain', { mode: 'domains', domains: 'not a domain' }],
  ])('rejects %s with 400 and records a failed event', async (_label, body) => {
    const response = await req('/email/policy', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_argument' });
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toBeNull();
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBeNull();
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/policy', status: 'failed' });
  });

  test('a mirror write failure commits the policy but leaves the proxy closed until republished', async () => {
    await req('/email/policy', { mode: 'domains', domains: 'corp.example' });
    const put = vi.spyOn(env.ROUTING, 'put').mockRejectedValueOnce(new Error('kv down'));
    const response = await req('/email/policy', { mode: 'any' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'mirror_failed' });
    // The database holds the new policy; the mirror was cleared before the
    // failed put, so the proxy reads `verified` — never a policy the
    // database does not hold, and never the stale one.
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({ mode: 'any', domains: [] });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBeNull();
    put.mockRestore();
    // The next read republishes the committed policy.
    await req('/email/policy');
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'any', domains: [] }),
    );
  });

  test('tightening from `any` never leaves the looser mirror behind on a KV failure', async () => {
    await req('/email/policy', { mode: 'any' });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'any', domains: [] }),
    );
    const put = vi.spyOn(env.ROUTING, 'put').mockRejectedValueOnce(new Error('kv down'));
    const response = await req('/email/policy', { mode: 'verified' });
    expect(response.status).toBe(503);
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({
      mode: 'verified',
      domains: [],
    });
    // Absent reads as verified at the proxy: closed, not the stale `any`.
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBeNull();
    put.mockRestore();
  });

  test('a failed mirror clear changes nothing', async () => {
    await req('/email/policy', { mode: 'domains', domains: 'corp.example' });
    const del = vi.spyOn(env.ROUTING, 'delete').mockRejectedValueOnce(new Error('kv down'));
    const response = await req('/email/policy', { mode: 'any' });
    expect(response.status).toBe(503);
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({
      mode: 'domains',
      domains: ['corp.example'],
    });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'domains', domains: ['corp.example'] }),
    );
    del.mockRestore();
  });

  test('is unavailable when the platform does not enable email', async () => {
    const response = await req('/email/policy', undefined, {
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: true,
        email: false,
        githubActions: true,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      }),
    });
    expect(response.status).toBe(501);
  });
});

describe('operator email settings', () => {
  test('defaults to self-serve domain management', async () => {
    const response = await req('/email/settings');
    expect(await response.json()).toEqual({ domains: { management: 'self-serve' } });
  });

  test('previews and applies the admin mode', async () => {
    const preview = await req('/email/settings', { domains: 'admin', dryRun: true });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.settings.set',
      target: { domains: 'admin' },
      previous: { domains: 'self-serve' },
    });
    expect(await setting(EMAIL_DOMAIN_MANAGEMENT_SETTING)).toBeNull();

    const response = await req('/email/settings', { domains: 'admin' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ domains: { management: 'admin' } });
    expect(await setting(EMAIL_DOMAIN_MANAGEMENT_SETTING)).toBe('admin');
    expect(await (await req('/email/settings')).json()).toEqual({
      domains: { management: 'admin' },
    });
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/settings', status: 'success' });
    expect(JSON.parse(recorded[0]!.target)).toEqual({ domains: 'admin' });
  });

  test('rejects an unknown management mode', async () => {
    const response = await req('/email/settings', { domains: 'nobody' });
    expect(response.status).toBe(400);
    expect(await setting(EMAIL_DOMAIN_MANAGEMENT_SETTING)).toBeNull();
  });
});

describe('operator email limits', () => {
  test('sets both caps by project slug and reports the previous overrides', async () => {
    const owner = await createTestUser(env.db, 'limit-owner');
    const project = await createTestProject(env.db, owner.id, 'limit-project');
    await env.ROUTING.put(`email-limit:${project.id}`, '500');

    const preview = await req(`/email/projects/${project.slug}/limit`, {
      monthly: '1000',
      burst: '25',
      dryRun: true,
    });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.limit.set',
      target: { projectId: project.id, slug: project.slug, monthly: 1000, burst: 25 },
      previous: { monthly: 500, burst: null },
    });
    expect(await env.ROUTING.get(`email-limit:${project.id}`)).toBe('500');
    expect(await env.ROUTING.get(`email-burst-limit:${project.id}`)).toBeNull();

    const response = await req(`/email/projects/${project.slug}/limit`, {
      monthly: '1000',
      burst: '25',
    });
    expect(response.status).toBe(200);
    expect(await env.ROUTING.get(`email-limit:${project.id}`)).toBe('1000');
    expect(await env.ROUTING.get(`email-burst-limit:${project.id}`)).toBe('25');
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!.target)).toEqual({
      project: project.slug,
      monthly: '1000',
      burst: '25',
    });
  });

  test('sets one cap by project id and leaves the other override untouched', async () => {
    const owner = await createTestUser(env.db, 'limit-owner-2');
    const project = await createTestProject(env.db, owner.id, 'limit-project-2');
    await env.ROUTING.put(`email-burst-limit:${project.id}`, '3');
    const response = await req(`/email/projects/${project.id}/limit`, { monthly: '42' });
    expect(response.status).toBe(200);
    expect(await env.ROUTING.get(`email-limit:${project.id}`)).toBe('42');
    expect(await env.ROUTING.get(`email-burst-limit:${project.id}`)).toBe('3');
  });

  test.each([
    ['neither cap', {}],
    ['zero', { monthly: '0' }],
    ['a non-integer', { burst: '1.5' }],
    ['a negative', { monthly: '-5' }],
    ['a value over the cap', { monthly: '1000001' }],
  ])('rejects %s with 400', async (_label, body) => {
    const owner = await createTestUser(env.db, 'limit-owner-3');
    const project = await createTestProject(env.db, owner.id, 'limit-project-3');
    const response = await req(`/email/projects/${project.id}/limit`, body);
    expect(response.status).toBe(400);
    expect(await env.ROUTING.get(`email-limit:${project.id}`)).toBeNull();
    expect(await env.ROUTING.get(`email-burst-limit:${project.id}`)).toBeNull();
  });

  test('answers 404 for an unknown project', async () => {
    const response = await req('/email/projects/no-such-project/limit', { monthly: '10' });
    expect(response.status).toBe(404);
  });
});
