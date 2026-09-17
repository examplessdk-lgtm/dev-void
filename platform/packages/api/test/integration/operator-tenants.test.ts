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
  acceptInvitationByEmail,
  createInvitation,
  getInvitation,
  getUser,
  revokeInvitation,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import {
  builds,
  deployments,
  invitations,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginRevisions,
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
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
let operatorAdminId: string;

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
  operatorAdminId = admin.id;
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

function captureUsageCounter(
  calls: Array<{ ownerId: string; path: string; body: Record<string, unknown> }>,
  failPath?: string,
) {
  return {
    idFromName: (name: string) => name,
    get: (ownerId: string) => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        calls.push({ ownerId, path, body });
        return path === failPath
          ? new Response('counter unavailable', { status: 500 })
          : Response.json({ ok: true });
      },
    }),
  } as unknown as DurableObjectNamespace;
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
  test('previews ownership transfer details without writes or external calls', async () => {
    const owner = await createTestUser(env.db, 'transfer-preview-owner');
    const target = await createTestUser(
      env.db,
      'transfer-preview-target',
      'github',
      undefined,
      'pro',
    );
    await env.db
      .update(users)
      .set({ suspended_reason: 'operator_review' })
      .where(eq(users.id, target.id));
    const project = await createTestProject(env.db, owner.id, 'transfer-preview-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: target.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    await env.db.insert(projectInvitations).values({
      id: 'pinv_transfer_target',
      project_id: project.id,
      target_user_id: target.id,
      target_email_snapshot: 'transfer-target@example.com',
      role: 'admin',
      invited_by_user_id: owner.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    const putSpy = vi.spyOn(env.ROUTING, 'put');
    const doGet = vi.fn();

    const response = await req(
      `/projects/${project.id}/owner`,
      { userId: target.id, dryRun: true },
      {
        USAGE_COUNTER: {
          idFromName: (name: string) => name,
          get: doGet,
        } as unknown as DurableObjectNamespace,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      action: 'project.owner',
      target: { id: project.id, slug: project.slug, userId: target.id },
      previousOwner: { id: owner.id, plan: 'free', suspended: false },
      newOwner: {
        id: target.id,
        plan: 'pro',
        suspended: true,
        suspendedReason: 'operator_review',
      },
      formerOwnerRole: 'admin',
      targetPreviousRole: 'collaborator',
      blockers: [{ kind: 'deployment', id: deployment.id, status: 'pending' }],
      counterUpdates: { detachUserId: owner.id, attachUserId: target.id },
      usageTransfer: 'non-retroactive',
    });
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ user_id: owner.id });
    expect(await env.db.select().from(projectOwnershipPeriods)).toEqual([]);
    expect(
      await env.db.select().from(projectMembers).where(eq(projectMembers.project_id, project.id)),
    ).toMatchObject([{ user_id: target.id, role: 'collaborator' }]);
    expect(
      await env.db
        .select()
        .from(projectInvitations)
        .where(eq(projectInvitations.id, 'pinv_transfer_target')),
    ).toMatchObject([{ status: 'pending' }]);
    expect(putSpy).not.toHaveBeenCalled();
    expect(doGet).not.toHaveBeenCalled();
  });

  test('transfers ownership atomically and converges counters and routing idempotently', async () => {
    const owner = await createTestUser(env.db, 'transfer-owner');
    const target = await createTestUser(env.db, 'transfer-target', 'github', undefined, 'pro');
    await env.db
      .update(users)
      .set({ suspended_reason: 'operator_review' })
      .where(eq(users.id, target.id));
    const project = await createTestProject(env.db, owner.id, 'transfer-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: target.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    await env.db.insert(projectInvitations).values({
      id: 'pinv_transfer_target',
      project_id: project.id,
      target_user_id: target.id,
      target_email_snapshot: 'transfer-target@example.com',
      role: 'admin',
      invited_by_user_id: owner.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id, userId: owner.id }),
    );
    const counterCalls: Array<{
      ownerId: string;
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const USAGE_COUNTER = captureUsageCounter(counterCalls);

    const response = await req(
      `/projects/${project.id}/owner`,
      { userId: target.id },
      { USAGE_COUNTER },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'project.owner',
      changed: true,
      previousOwner: { id: owner.id },
      newOwner: { id: target.id },
      formerOwnerRole: 'admin',
      convergence: { countersComplete: true, routingComplete: true },
    });
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ user_id: target.id });
    expect(
      await env.db.select().from(projectMembers).where(eq(projectMembers.project_id, project.id)),
    ).toMatchObject([{ user_id: owner.id, role: 'admin', added_by_user_id: operatorAdminId }]);
    expect(
      await env.db
        .select()
        .from(projectInvitations)
        .where(eq(projectInvitations.id, 'pinv_transfer_target')),
    ).toMatchObject([
      {
        status: 'revoked',
        revoked_by_user_id: operatorAdminId,
        revoked_at: expect.any(String),
      },
    ]);
    const periods = await env.db
      .select()
      .from(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    expect(periods).toHaveLength(2);
    const former = periods.find((period) => period.owner_user_id === owner.id)!;
    const current = periods.find((period) => period.owner_user_id === target.id)!;
    expect(former.ends_at).toBe(current.starts_at);
    expect(current).toMatchObject({ ends_at: null, changed_by_user_id: operatorAdminId });
    expect(counterCalls).toEqual([
      {
        ownerId: owner.id,
        path: '/detach-project',
        body: {
          projectId: project.id,
          userId: owner.id,
          ownershipStartedAt: former.starts_at,
          ownershipEndedAt: current.starts_at,
        },
      },
      {
        ownerId: target.id,
        path: '/attach-project',
        body: expect.objectContaining({
          projectId: project.id,
          userId: target.id,
          slug: project.slug,
          ownershipStartedAt: current.starts_at,
          plan: 'pro',
        }),
      },
    ]);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      projectId: project.id,
      userId: target.id,
      suspended: 'operator_review',
    });
    expect(JSON.parse((await env.ROUTING.get(`project:${project.id}`))!)).toEqual({
      userId: target.id,
      plan: 'pro',
    });

    counterCalls.length = 0;
    const retry = await req(
      `/projects/${project.id}/owner`,
      { userId: target.id },
      { USAGE_COUNTER },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ changed: false, newOwner: { id: target.id } });
    expect(
      await env.db
        .select()
        .from(projectOwnershipPeriods)
        .where(eq(projectOwnershipPeriods.project_id, project.id)),
    ).toHaveLength(2);
    expect(counterCalls.map((call) => call.path)).toEqual(['/detach-project', '/attach-project']);
  });

  test('rejects unknown owners and deleting, deploy, rollback, and build work', async () => {
    const owner = await createTestUser(env.db, 'blocked-transfer-owner');
    const target = await createTestUser(env.db, 'blocked-transfer-target');
    const project = await createTestProject(env.db, owner.id, 'blocked-transfer-project');

    expect(
      (await req(`/projects/${project.id}/owner`, { userId: 'user_missing', dryRun: true })).status,
    ).toBe(404);

    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    const deleting = await req(`/projects/${project.id}/owner`, { userId: target.id });
    expect(deleting.status).toBe(409);
    expect(await deleting.json()).toMatchObject({
      error: 'ownership_transfer_blocked',
      details: { blockers: [{ kind: 'deletion', id: project.id, status: 'deleting' }] },
    });
    await env.db.update(projects).set({ status: 'active' }).where(eq(projects.id, project.id));

    const deployment = await createTestDeployment(env.db, project.id, 'uploading');
    const deploying = await req(`/projects/${project.id}/owner`, { userId: target.id });
    expect(deploying.status).toBe(409);
    expect(await deploying.json()).toMatchObject({
      details: { blockers: [{ kind: 'deployment', id: deployment.id, status: 'uploading' }] },
    });
    await env.db
      .update(deployments)
      .set({ status: 'failed' })
      .where(eq(deployments.id, deployment.id));

    const rollback = await createTestDeployment(env.db, project.id, 'pending', 'rollback-lease');
    const rollingBack = await req(`/projects/${project.id}/owner`, { userId: target.id });
    expect(rollingBack.status).toBe(409);
    expect(await rollingBack.json()).toMatchObject({
      details: { blockers: [{ kind: 'rollback', id: rollback.id, status: 'pending' }] },
    });
    await env.db
      .update(deployments)
      .set({ status: 'canceled' })
      .where(eq(deployments.id, rollback.id));

    await env.db.insert(builds).values({
      id: 'build_transfer_blocker',
      project_id: project.id,
      user_id: owner.id,
      status: 'queued',
    });
    for (const status of ['queued', 'building'] as const) {
      await env.db.update(builds).set({ status }).where(eq(builds.id, 'build_transfer_blocker'));
      const building = await req(`/projects/${project.id}/owner`, { userId: target.id });
      expect(building.status).toBe(409);
      expect(await building.json()).toMatchObject({
        details: {
          blockers: [{ kind: 'build', id: 'build_transfer_blocker', status }],
        },
      });
    }
  });

  test('reports post-commit counter failure and resumes convergence on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const owner = await createTestUser(env.db, 'partial-transfer-owner');
    const target = await createTestUser(env.db, 'partial-transfer-target');
    const project = await createTestProject(env.db, owner.id, 'partial-transfer-project');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id, userId: owner.id }),
    );
    const failedCalls: Array<{
      ownerId: string;
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const failed = await req(
      `/projects/${project.id}/owner`,
      { userId: target.id },
      { USAGE_COUNTER: captureUsageCounter(failedCalls, '/attach-project') },
    );

    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      error: 'partial_failure',
      details: {
        partial: true,
        ownershipTransferred: true,
        previousOwner: { id: owner.id },
        newOwner: { id: target.id },
        convergence: { countersComplete: false, routingComplete: false },
      },
    });
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ user_id: target.id });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({ userId: owner.id });

    const retryCalls: Array<{
      ownerId: string;
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const retry = await req(
      `/projects/${project.id}/owner`,
      { userId: target.id },
      { USAGE_COUNTER: captureUsageCounter(retryCalls) },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      changed: false,
      convergence: { countersComplete: true, routingComplete: true },
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({ userId: target.id });
  });

  test('reports a routing partial failure after counters converge', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const owner = await createTestUser(env.db, 'routing-partial-owner');
    const target = await createTestUser(env.db, 'routing-partial-target');
    const project = await createTestProject(env.db, owner.id, 'routing-partial-project');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id, userId: owner.id }),
    );
    const counterCalls: Array<{
      ownerId: string;
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const failingRouting = {
      get: (key: string) => env.ROUTING.get(key),
      put: async () => {
        throw new Error('KV unavailable');
      },
      delete: (key: string) => env.ROUTING.delete(key),
    } as unknown as KVNamespace;

    const response = await req(
      `/projects/${project.id}/owner`,
      { userId: target.id },
      { ROUTING: failingRouting, USAGE_COUNTER: captureUsageCounter(counterCalls) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'partial_failure',
      details: {
        ownershipTransferred: true,
        convergence: { countersComplete: true, routingComplete: false },
      },
    });
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ user_id: target.id });
    expect(counterCalls.map((call) => call.path)).toEqual(['/detach-project', '/attach-project']);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({ userId: owner.id });
  });

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

  test('deletes invitation actors while preserving invitation history and revoking sessions', async () => {
    const inviter = await createTestUser(
      env.db,
      'inviting-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const revoker = await createTestUser(
      env.db,
      'revoking-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const invited = await createTestUser(env.db, 'invited-user');
    const inviterToken = await createOperatorToken(env.db, inviter);
    const revokerToken = await createOperatorToken(env.db, revoker);

    const accepted = await createInvitation(env.db, 'accepted@example.com', inviter.id);
    await acceptInvitationByEmail(env.db, accepted.email, invited.id);
    const revoked = await createInvitation(env.db, 'revoked@example.com', inviter.id);
    expect(await revokeInvitation(env.db, revoked.id, revoker.id)).toBe(true);

    const project = await createTestProject(env.db, invited.id, 'invited-project');
    await env.db.insert(resources).values({
      id: 'res_invited_user_d1',
      project_id: project.id,
      type: 'd1',
      cf_id: 'd1-invited-user',
      binding_name: 'DB',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id }),
    );
    const cf = mockCfApi();

    const deleteInvited = await req(`/users/${invited.id}/delete`, {});
    expect(deleteInvited.status).toBe(200);
    expect(await deleteInvited.json()).toMatchObject({
      deleted: true,
      deletedProjects: [project.id],
      warnings: [],
    });
    expect(await getUser(env.db, invited.id)).toBeNull();
    expect(
      await env.db.select().from(resources).where(eq(resources.project_id, project.id)),
    ).toEqual([]);
    expect(await env.ROUTING.get(project.slug)).toBeNull();
    expect(
      cf.mock.calls.some(
        ([input, init]) =>
          (init as RequestInit | undefined)?.method === 'DELETE' &&
          String(input).includes('/d1/database/d1-invited-user'),
      ),
    ).toBe(true);
    const staleUserSession = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${invited.jwt}` },
      }),
      env,
    );
    expect(staleUserSession.status).toBe(401);

    expect((await req(`/users/${inviter.id}/delete`, {})).status).toBe(200);
    expect((await req(`/users/${revoker.id}/delete`, {})).status).toBe(200);
    for (const staleToken of [inviterToken, revokerToken]) {
      const staleAdminSession = await app.fetch(
        new Request('http://localhost/operator/v1/session', {
          headers: { Authorization: `Bearer ${staleToken}` },
        }),
        env,
      );
      expect(staleAdminSession.status).toBe(401);
    }

    expect(await getInvitation(env.db, accepted.id)).toMatchObject({
      id: accepted.id,
      status: 'accepted',
      invited_by: inviter.id,
      accepted_by: invited.id,
    });
    expect(await getInvitation(env.db, revoked.id)).toMatchObject({
      id: revoked.id,
      status: 'revoked',
      invited_by: inviter.id,
      revoked_by: revoker.id,
    });
    const history = (await (await req('/invitations?limit=100')).json()) as {
      invitations: Array<Record<string, unknown>>;
    };
    expect(history.invitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: accepted.id,
          invited_by: inviter.id,
          accepted_by: invited.id,
          invited_by_login: null,
        }),
        expect.objectContaining({
          id: revoked.id,
          invited_by: inviter.id,
          revoked_by: revoker.id,
          invited_by_login: null,
          revoked_by_login: null,
        }),
      ]),
    );
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

  test('manages exact connection-and-subject grants and validates their connection', async () => {
    expect(
      (
        await req('/signup/allow', {
          type: 'identity',
          connectionId: 'missing',
          subject: 'Employee-42',
          dryRun: true,
        })
      ).status,
    ).toBe(400);
    await env.db.insert(platformLoginConnections).values({
      id: 'company',
      kind: 'oidc',
      revision: 1,
    });
    await env.db.insert(platformLoginRevisions).values({
      connection_id: 'company',
      revision: 1,
      configuration: {
        id: 'company',
        kind: 'oidc',
        label: 'Company SSO',
        clientId: 'client',
        issuer: 'https://identity.example.com',
        allowedDomains: [],
        requiredGroups: [],
      },
      secret: { ciphertext: 'unused', iv: 'unused', keyVersion: 'unused' },
    });
    const entry = {
      type: 'identity',
      connectionId: 'company',
      subject: 'Employee-42',
      note: 'No verified email',
    } as const;
    expect((await req('/signup/allow', { ...entry, dryRun: true })).status).toBe(200);
    expect((await req('/signup/allow', entry)).status).toBe(200);
    expect(await getAllowlist(env.ROUTING)).toEqual([entry]);
    expect(
      (
        await req('/signup/disallow', {
          type: 'identity',
          connectionId: 'company',
          subject: 'employee-42',
        })
      ).status,
    ).toBe(404);

    const admitted = await createTestUser(env.db, 'subject-user', 'oidc:company', 'Employee-42');
    await env.db.insert(platformLoginIdentities).values({
      id: crypto.randomUUID(),
      user_id: admitted.id,
      connection_id: 'company',
      issuer: 'https://identity.example.com',
      subject: 'Employee-42',
    });
    const project = await createTestProject(env.db, admitted.id, 'identity-grant-project');
    await createTestDeployment(env.db, project.id, 'live');
    expect(await (await req('/signup')).json()).toMatchObject({
      connections: [{ id: 'company', kind: 'oidc', label: 'Company SSO' }],
      entries: [{ ...entry, accepted: true, deployed: true }],
    });
    expect((await req('/signup/disallow', entry)).status).toBe(200);
    expect(await getAllowlist(env.ROUTING)).toEqual([]);
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
