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
import { getInvitation, getUser } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { invitations, users } from '../../src/schema.ts';
import { getAllowlist } from '../../src/signup-allowlist.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
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
  await env.ROUTING.delete('signup:enabled');
  await env.ROUTING.delete('signup:allowlist');
  const admin = await createTestUser(
    env.db,
    'operator-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe('operator tenant reads', () => {
  test('paginates filtered users without truncating the total to the page size', async () => {
    for (const login of ['find-a', 'find-b', 'find-c', 'unrelated']) {
      await createTestUser(env.db, login);
    }
    const first = (await (await req('/users?search=find-&limit=2')).json()) as {
      users: Array<{ id: string }>;
    };
    const second = (await (await req('/users?search=find-&limit=2&page=2')).json()) as {
      users: Array<{ id: string }>;
    };
    expect(first).toMatchObject({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(first.users).toHaveLength(2);
    expect(second.users).toHaveLength(1);
    expect(
      new Set([...first.users, ...second.users].map((user: { id: string }) => user.id)).size,
    ).toBe(3);
  });

  test('combines project owner and search filters and exposes the latest deployment', async () => {
    const owner = await createTestUser(env.db, 'project-owner');
    const other = await createTestUser(env.db, 'other-owner');
    const project = await createTestProject(env.db, owner.id, 'matching-project');
    await createTestProject(env.db, other.id, 'matching-other');
    await createTestProject(env.db, owner.id, 'different');
    const deploy = await createTestDeployment(env.db, project.id, 'live');
    const response = await req(`/projects?user=${owner.id}&search=matching`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; projects: Array<unknown> };
    expect(body.total).toBe(1);
    expect(body.projects).toMatchObject([
      { id: project.id, owner_login: owner.login, last_deploy_id: deploy.id },
    ]);
    const detail = await (await req(`/projects/${project.id}`)).json();
    expect(detail).toMatchObject({
      project: { id: project.id },
      owner: { id: owner.id },
      deployments: [{ id: deploy.id }],
      domains: [],
      resources: [],
      builds: [],
    });
  });

  test('reports user details with the same usage data as the dashboard', async () => {
    const owner = await createTestUser(env.db, 'usage-owner');
    const project = await createTestProject(env.db, owner.id, 'usage-project');
    await createTestDeployment(env.db, project.id, 'live');
    mockCfApi();
    const response = await req(`/users/${owner.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      user: { id: owner.id },
      projects: [{ id: project.id }],
      deploysToday: 1,
      usage: { totalRequests: 0, totalBandwidth: 0 },
    });
  });

  test('rejects invalid pagination and missing detail targets', async () => {
    for (const query of ['limit=101', 'page=0', 'page=2abc', 'limit=-1']) {
      expect((await req(`/users?${query}`)).status).toBe(400);
    }
    expect((await req('/users/missing')).status).toBe(404);
    expect((await req('/projects/missing')).status).toBe(404);
  });
});

describe('operator tenant mutations', () => {
  test('previews every user mutation and project deletion without changing data or calling services', async () => {
    const user = await createTestUser(env.db, 'preview-user');
    const project = await createTestProject(env.db, user.id, 'preview-project');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const putSpy = vi.spyOn(env.ROUTING, 'put');
    const deleteSpy = vi.spyOn(env.ROUTING, 'delete');
    const doSpy = vi.spyOn(env.USAGE_COUNTER, 'get');
    for (const [path, body] of [
      [`/users/${user.id}/plan`, { plan: 'pro' }],
      [`/users/${user.id}/suspend`, { reason: 'review' }],
      [`/users/${user.id}/restore`, {}],
      [`/users/${user.id}/delete`, {}],
      [`/projects/${project.id}/delete`, {}],
    ] as const) {
      const response = await req(path, { ...body, dryRun: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        dryRun: true,
        target: { id: path.includes('/projects/') ? project.id : user.id },
      });
    }
    expect(await getUser(env.db, user.id)).toMatchObject({ plan: 'free', suspended_reason: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(doSpy).not.toHaveBeenCalled();
    expect((await req(`/projects/${project.id}`)).status).toBe(200);
  });

  test('validates real targets and reserved reasons before returning previews', async () => {
    const user = await createTestUser(env.db, 'validation-user');
    for (const plan of ['invalid', '__proto__', 'constructor']) {
      expect((await req(`/users/${user.id}/plan`, { plan, dryRun: true })).status).toBe(400);
    }
    expect(
      (await req(`/users/${user.id}/suspend`, { reason: 'requests_exceeded', dryRun: true }))
        .status,
    ).toBe(400);
    expect((await req(`/users/missing/delete`, { dryRun: true })).status).toBe(404);
    expect((await req(`/users/${user.id}/delete`, { dryRun: 'true' })).status).toBe(400);
  });

  test('suspends edge traffic, keeps admin suspension during plan changes, then restores it', async () => {
    const user = await createTestUser(env.db, 'suspended-user');
    const project = await createTestProject(env.db, user.id, 'suspended-project');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id }),
    );
    expect((await req(`/users/${user.id}/suspend`, { reason: 'operator_review' })).status).toBe(
      200,
    );
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBe('operator_review');
    expect((await req(`/users/${user.id}/plan`, { plan: 'pro' })).status).toBe(200);
    expect(await getUser(env.db, user.id)).toMatchObject({
      plan: 'pro',
      suspended_reason: 'operator_review',
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBe('operator_review');
    expect((await req(`/users/${user.id}/restore`, {})).status).toBe(200);
    expect(await getUser(env.db, user.id)).toMatchObject({ suspended_reason: null });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBeUndefined();
  });

  test('reports persisted plan changes and preserves suspension on failed restore cleanup', async () => {
    const user = await createTestUser(env.db, 'cleanup-user');
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));
    const failingDo = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response('failed', { status: 500 }) }),
    } as unknown as DurableObjectNamespace;
    const plan = await req(`/users/${user.id}/plan`, { plan: 'pro' }, { USAGE_COUNTER: failingDo });
    expect(plan.status).toBe(500);
    expect(await plan.json()).toMatchObject({
      error: 'partial_failure',
      details: { partial: true, plan: 'pro', cleanupComplete: false },
    });
    expect(await getUser(env.db, user.id)).toMatchObject({
      plan: 'pro',
      suspended_reason: 'admin_suspended',
    });
    const restore = await req(`/users/${user.id}/restore`, {}, { USAGE_COUNTER: failingDo });
    expect(restore.status).toBe(500);
    expect(await restore.json()).toMatchObject({
      error: 'partial_failure',
      details: { cleanupComplete: false },
    });
    expect(await getUser(env.db, user.id)).toMatchObject({ suspended_reason: 'admin_suspended' });
  });

  test('deletes a user and its projects with structured teardown results', async () => {
    const user = await createTestUser(env.db, 'deleted-user');
    const project = await createTestProject(env.db, user.id, 'deleted-project');
    mockCfApi();
    const response = await req(`/users/${user.id}/delete`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deleted: true,
      deletedProjects: [project.id],
      warnings: [],
    });
    expect(await getUser(env.db, user.id)).toBeNull();
    expect((await req(`/projects/${project.id}`)).status).toBe(404);
  });
});

describe('operator signup access and invitations', () => {
  test('previews signup changes without KV writes and uses stable entry identities', async () => {
    const putSpy = vi.spyOn(env.ROUTING, 'put');
    expect((await req('/signup/restrict', { dryRun: true })).status).toBe(200);
    expect((await req('/signup/open', { dryRun: true })).status).toBe(200);
    expect(
      (await req('/signup/allow', { type: 'email', pattern: '*@example.com', dryRun: true }))
        .status,
    ).toBe(200);
    expect(putSpy).not.toHaveBeenCalled();
    expect((await req('/signup/restrict', {})).status).toBe(200);
    expect(await (await req('/signup')).json()).toMatchObject({ enabled: true, entries: [] });
    await req('/signup/allow', { type: 'email', pattern: '*@Example.com', note: 'Team' });
    await req('/signup/allow', { type: 'github', pattern: 'NewUser' });
    const preview = await req('/signup/remove', {
      type: 'email',
      pattern: '*@EXAMPLE.COM',
      dryRun: true,
    });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      removed: [{ type: 'email', pattern: '*@example.com' }],
    });
    expect(await getAllowlist(env.ROUTING)).toHaveLength(2);
    expect((await req('/signup/remove', { type: 'email', pattern: '*@example.com' })).status).toBe(
      200,
    );
    expect(await getAllowlist(env.ROUTING)).toEqual([{ type: 'github', pattern: 'newuser' }]);
    expect(
      (await req('/signup/remove', { type: 'email', pattern: '*@example.com', dryRun: true }))
        .status,
    ).toBe(404);
    await req('/signup/open', {});
    expect(await env.ROUTING.get('signup:enabled')).toBe('false');
  });

  test('previews invitations without email or writes, sends a normalized batch, and revokes access', async () => {
    const send = vi.fn(async () => {});
    const EMAIL = { send } as unknown as SendEmail;
    const emailEnv = {
      EMAIL,
      EMAIL_FROM: 'Example Platform <platform@example.com>',
      AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
      PLATFORM_DISPLAY_NAME: 'Example Platform',
      PLATFORM_INSTALLATION_ID: 'example-installation',
    };
    const body = { emails: ['One@Example.com', 'two@example.com', 'one@example.com'] };
    const preview = await req('/invitations/send', { ...body, dryRun: true }, emailEnv);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      target: { emails: ['one@example.com', 'two@example.com'] },
    });
    expect(send).not.toHaveBeenCalled();
    expect(await env.db.select().from(invitations)).toEqual([]);
    expect(await getAllowlist(env.ROUTING)).toEqual([]);
    const response = await req('/invitations/send', body, emailEnv);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      invitations: Array<{ id: string }>;
      warnings: Array<string>;
    };
    expect(result.invitations).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Example Platform <platform@example.com>',
        subject: "You're invited to Example Platform",
        text: expect.stringContaining("void connect 'https://api.example.com'"),
      }),
    );
    const listed = (await (await req('/invitations?limit=1')).json()) as {
      invitations: Array<unknown>;
    };
    expect(listed).toMatchObject({ total: 2, limit: 1, totalPages: 2 });
    expect(listed.invitations).toHaveLength(1);
    const id = result.invitations[0].id;
    expect((await req(`/invitations/${id}/revoke`, { dryRun: true })).status).toBe(200);
    expect(await getInvitation(env.db, id)).toMatchObject({ status: 'pending' });
    expect(await getAllowlist(env.ROUTING)).toHaveLength(2);
    expect((await req(`/invitations/${id}/revoke`, {})).status).toBe(200);
    expect(await getInvitation(env.db, id)).toMatchObject({ status: 'revoked' });
    expect(await getAllowlist(env.ROUTING)).toHaveLength(1);
    expect((await req(`/invitations/${id}/revoke`, { dryRun: true })).status).toBe(409);
  });

  test('surfaces email delivery failures without hiding committed invitations', async () => {
    const EMAIL = {
      send: vi.fn(async () => {
        throw new Error('email service unavailable');
      }),
    } as unknown as SendEmail;
    const response = await req(
      '/invitations/send',
      { emails: ['delivery@example.com'] },
      { EMAIL },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emailDelivery: [{ email: 'delivery@example.com', status: 'failed' }],
      invitations: [{ email: 'delivery@example.com' }],
      warnings: ['Email failed: delivery@example.com. Signup access was granted.'],
    });
    expect(await getAllowlist(env.ROUTING)).toHaveLength(1);
  });

  test('reports invitations committed before an allowlist failure, and sends no emails', async () => {
    const send = vi.fn(async () => {});
    vi.spyOn(env.ROUTING, 'put').mockRejectedValue(new Error('KV unavailable'));
    const response = await req(
      '/invitations/send',
      { emails: ['partial@example.com'] },
      { EMAIL: { send } as unknown as SendEmail },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'partial_failure',
      details: {
        partial: true,
        invitations: [{ email: 'partial@example.com' }],
        emailDelivery: 'not_attempted',
        allowlistConfirmed: false,
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(await env.db.select().from(invitations)).toHaveLength(1);
  });

  test('rejects malformed and conflicting invitations before preview', async () => {
    for (const emails of [
      [],
      ['bad'],
      ['a@example.com\nother@example.com'],
      'a@example.com',
      [42],
    ]) {
      expect((await req('/invitations/send', { emails, dryRun: true })).status).toBe(400);
    }
    await req('/invitations/send', { emails: ['existing@example.com'] });
    expect(
      (
        await req('/invitations/send', {
          emails: ['existing@example.com', 'new@example.com'],
          dryRun: true,
        })
      ).status,
    ).toBe(400);
    expect(await env.db.select().from(invitations)).toHaveLength(1);
  });
});
