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
import { createBuild, getDeployment } from '../../src/db.ts';
import { app } from '../../src/index.ts';
import { deployments, platformEvents } from '../../src/schema.ts';
import { BUILD_INSTANCE_LARGE } from '../../src/tiers.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;
let ownerId: string;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await env.db.delete(platformEvents);
  await clearTables(env.db);
  delete env.PLATFORM_INSTALLATION_ID;
  delete env.PLATFORM_CAPABILITIES;
  const user = await createTestUser(env.db, 'operator', 'github', undefined, 'free', 'admin');
  ownerId = user.id;
  token = await createOperatorToken(env.db, user);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function req(path: string, body?: Record<string, unknown>, extraEnv?: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { ...env, ...extraEnv },
  );
}
function namespace(payload: unknown, status = 200) {
  const fetch = vi.fn(async (_input: unknown) => Response.json(payload, { status }));
  return {
    fetch,
    ns: {
      idFromName: (id: string) => id,
      get: () => ({ fetch }),
    } as unknown as DurableObjectNamespace,
  };
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

describe('operator deployment operations', () => {
  test('filters and paginates deployment rows with matching totals', async () => {
    const project = await createTestProject(env.db, ownerId, 'alpha');
    await createTestDeployment(env.db, project.id, 'pending');
    await createTestDeployment(env.db, project.id, 'live');
    const response = await req('/deployments?project=alpha&status=pending&limit=1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployments: Array<{ project_id: string; status: string }>;
    };
    expect(body).toMatchObject({ page: 1, limit: 1, total: 1 });
    expect(body.deployments[0]).toMatchObject({ project_id: project.id, status: 'pending' });
    expect((await req('/deployments?status=unknown')).status).toBe(400);
    expect((await req('/deployments?limit=-1')).status).toBe(400);
  });
  test('previews cancellation without writes then requests two-phase cancellation', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    const preview = await req(`/deployments/${deployment.id}/cancel`, { dryRun: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ dryRun: true, target: deployment.id });
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('pending');
    expect((await req(`/deployments/${deployment.id}/cancel`, {})).status).toBe(200);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('canceling');
  });
  test.each(['live', 'cutover', 'compensating'] as const)(
    'rejects preview and cancellation of %s deployment',
    async (status) => {
      const project = await createTestProject(env.db, ownerId);
      const deployment = await createTestDeployment(env.db, project.id, 'pending');
      await env.db.update(deployments).set({ status }).where(eq(deployments.id, deployment.id));
      expect((await req(`/deployments/${deployment.id}/cancel`, { dryRun: true })).status).toBe(
        409,
      );
      expect((await req(`/deployments/${deployment.id}/cancel`, {})).status).toBe(409);
      expect((await getDeployment(env.db, deployment.id))?.status).toBe(status);
    },
  );
  test('log pages keep equal-timestamp rows and continue the same fixed window', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const row = {
      ts: Date.now() - 1000,
      timestamp: new Date(Date.now() - 500).toISOString(),
      outcome: 'ok',
      logData: '[]',
      exceptionData: '[]',
      url: '/a',
      method: 'GET',
      statusCode: '200',
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ data: [row, { ...row, url: '/b' }, { ...row, url: '/c' }] }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ ...row, url: '/c' }] }));
    const first = await req(`/deployments/${deployment.id}/logs?limit=2`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: Array<unknown>;
      nextCursor: string;
      watermark: string;
    };
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await req(
      `/deployments/${deployment.id}/logs?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
    const last = (await second.json()) as { data: Array<unknown> };
    expect(last).toMatchObject({ nextCursor: null, watermark: page.watermark });
    expect(last.data).toHaveLength(1);
    expect(fetch.mock.calls[0][1]?.body).toContain('ORDER BY double1 ASC, timestamp ASC');
    expect(fetch.mock.calls[0][1]?.body).toMatch(/double1 >= \d+ AND double1 < \d+/);
    expect(fetch.mock.calls[1][1]?.body).toContain('OFFSET 2');
    expect((await req(`/deployments/${deployment.id}/logs?cursor=garbage`)).status).toBe(400);
    expect((await req(`/deployments/${deployment.id}/logs?limit=-1`)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('follow windows use ingestion time with bounded overlap after the initial history', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    vi.spyOn(Date, 'now').mockReturnValue(600_000);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          {
            ts: 120_000,
            timestamp: '1970-01-01 00:09:00',
            outcome: 'ok',
            logData: '[]',
            exceptionData: '[]',
            url: '/completed-late',
            method: 'GET',
            statusCode: '200',
          },
        ],
      }),
    );

    const response = await req(`/deployments/${deployment.id}/logs?after=480000`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [
        {
          timestamp: 120_000,
          ingestedAt: 540_000,
          url: '/completed-late',
        },
      ],
      watermark: '600000',
    });
    const query = String(fetch.mock.calls[0][1]?.body);
    expect(query).toContain(
      "timestamp >= toDateTime('1970-01-01 00:03:00') AND timestamp < toDateTime('1970-01-01 00:10:00')",
    );
    expect(query).toContain('ORDER BY timestamp ASC, double1 ASC');
    expect(query).not.toContain('double1 >= 480000');
    expect((await req(`/deployments/${deployment.id}/logs?after=garbage`)).status).toBe(400);
    expect((await req(`/deployments/${deployment.id}/logs?after=600001`)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('operator build operations', () => {
  test('preserves log cursor, DO terminal status, and the recorded build size', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
      instanceType: BUILD_INSTANCE_LARGE,
    });
    const base = namespace({ lines: [], lastSeq: 0 });
    const large = namespace({
      lines: [{ seq: 11, line: 'finished' }],
      lastSeq: 11,
      terminal: true,
      status: 'failed',
      logsComplete: true,
    });
    const response = await req(`/builds/${build.id}/logs?since=10`, undefined, {
      BUILD_MANAGER: base.ns,
      BUILD_MANAGER_LARGE: large.ns,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lastSeq: 11,
      terminal: true,
      status: 'failed',
      logsComplete: true,
    });
    expect(large.fetch).toHaveBeenCalledWith('http://manager/logs?since=10');
    expect(base.fetch).not.toHaveBeenCalled();
    expect((await req(`/builds/${build.id}/logs?since=-1`)).status).toBe(400);
  });
  test('bounded build pages advance only past returned lines and retain buffered terminal logs', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
    });
    const logs = namespace({
      lines: [
        { seq: 4, line: 'a' },
        { seq: 5, line: 'b' },
        { seq: 6, line: 'c' },
      ],
      lastSeq: 6,
      terminal: true,
      status: 'complete',
      logsComplete: false,
    });
    const response = await req(`/builds/${build.id}/logs?since=3&limit=2`, undefined, {
      BUILD_MANAGER: logs.ns,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lines: [{ seq: 4 }, { seq: 5 }],
      lastSeq: 5,
      hasMore: true,
      terminal: true,
      logsComplete: false,
    });
    expect((await req(`/builds/${build.id}/logs?limit=501`)).status).toBe(400);
    expect(logs.fetch).toHaveBeenCalledTimes(1);
  });
  test('disabled managed builds fail before resolving or calling a DO', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
    });
    const logs = namespace({});
    const capabilities = Object.fromEntries(
      [
        'ai',
        'customDomains',
        'email',
        'githubActions',
        'githubOAuth',
        'googleOAuth',
        'managedBuilds',
        'sandbox',
      ].map((name) => [name, false]),
    );
    const response = await req(`/builds/${build.id}/logs`, undefined, {
      PLATFORM_CAPABILITIES: JSON.stringify(capabilities),
      BUILD_MANAGER: logs.ns,
    });
    expect(response.status).toBe(501);
    expect(logs.fetch).not.toHaveBeenCalled();
  });
  test('returns external build URLs without accessing container services', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'github_actions',
      logsUrl: 'https://github.com/example/actions/runs/1',
    });
    const ns = namespace({});
    const response = await req(`/builds/${build.id}/logs?since=7`, undefined, {
      BUILD_MANAGER: ns.ns,
      BUILD_MANAGER_LARGE: ns.ns,
    });
    expect(await response.json()).toMatchObject({
      lastSeq: 7,
      lines: [],
      external: 'https://github.com/example/actions/runs/1',
    });
    expect(ns.fetch).not.toHaveBeenCalled();
  });
  test('does not mask a failed log service as success', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
    });
    const ns = namespace({ error: 'Unavailable' }, 503);
    expect(
      (await req(`/builds/${build.id}/logs`, undefined, { BUILD_MANAGER: ns.ns })).status,
    ).toBe(502);
  });
});

describe('operator installation-aware system and worker operations', () => {
  test('health uses configured installed proxy and authenticated dispatch probe, without a dashboard', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    const response = await req('/system/health', undefined, {
      PLATFORM_INSTALLATION_ID: 'installation',
      PROXY_URL: 'https://my-proxy.example',
      SITE_DOMAIN: 'apps.example',
      PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allOk: true });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      'https://my-proxy.example/health',
      'https://test.apps.example/health',
    ]);
    expect(fetch.mock.calls[1][1]?.headers).toEqual({ 'X-Void-Platform-Probe': 'probe' });
  });
  test('every worker route rejects installed platforms before external calls', async () => {
    const fetch = cloudflareWorkerStub();
    const installation = { PLATFORM_INSTALLATION_ID: 'installation' };
    for (const path of ['/workers', '/workers/api', '/workers/events', '/workers/events/batch']) {
      expect((await req(path, undefined, installation)).status).toBe(501);
    }
    expect(
      (await req('/workers/api/rollback', { versionId: 'previous', dryRun: true }, installation))
        .status,
    ).toBe(501);
    expect((await req('/workers/rollback-all', { dryRun: true }, installation)).status).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('worker reads preserve available data and report Cloudflare failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/scripts/void-api/deployments')) {
        return Response.json(
          { success: false, errors: [{ message: 'Permission denied' }] },
          { status: 403 },
        );
      }
      if (url.endsWith('/versions')) {
        return Response.json({ success: true, result: { items: [{ id: 'current' }] } });
      }
      if (url.endsWith('/deployments')) {
        return Response.json({
          success: true,
          result: {
            deployments: [
              { id: 'current-deploy', versions: [{ version_id: 'current', percentage: 100 }] },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const detail = await req('/workers/api');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      ok: false,
      partial: true,
      versions: [{ id: 'current' }],
      error: 'Cloudflare API error: Permission denied',
    });

    const list = await req('/workers');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      ok: false,
      partial: true,
      workers: expect.arrayContaining([
        expect.objectContaining({
          worker: expect.objectContaining({ name: 'api' }),
          error: 'Cloudflare API error: Permission denied',
        }),
        expect.objectContaining({
          worker: expect.objectContaining({ name: 'dashboard' }),
          deployment: expect.objectContaining({ id: 'current-deploy' }),
        }),
      ]),
    });

    const preview = await req('/workers/rollback-all', { dryRun: true });
    expect(preview.status).toBe(502);
    expect(await preview.json()).toMatchObject({ error: 'worker_read_failed' });
  });
  test('worker previews validate versions without POST calls or audit-event mutations', async () => {
    const fetch = cloudflareWorkerStub();
    expect(
      (await req('/workers/api/rollback', { versionId: 'unknown', dryRun: true })).status,
    ).toBe(404);
    const response = await req('/workers/rollback-all', { dryRun: true, environment: 'staging' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      versions: {
        proxy: 'previous',
        tail: 'previous',
        api: 'previous',
        dashboard: 'previous',
        dispatch: 'previous',
      },
    });
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    expect(await env.db.select().from(platformEvents)).toEqual([]);
    expect((await req('/workers/rollback-all', {})).status).toBe(400);
  });
  test('bulk rollback pins reviewed targets, stops after failure, and persists partial outcomes', async () => {
    const fetch = cloudflareWorkerStub('void-dashboard-staging');
    const versions = {
      dispatch: 'previous',
      dashboard: 'previous',
      api: 'previous',
      tail: 'previous',
      proxy: 'previous',
    };
    const response = await req('/workers/rollback-all', { environment: 'staging', versions });
    expect(response.status).toBe(207);
    const result = (await response.json()) as { events: Array<{ status: string }> };
    expect(result).toMatchObject({ ok: false, partial: true, environment: 'staging' });
    expect(result.events.map((event: { status: string }) => event.status)).toEqual([
      'success',
      'failed',
      'skipped',
      'skipped',
      'skipped',
    ]);
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toContain('void-dispatch-staging');
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({
      versions: [{ version_id: 'previous', percentage: 100 }],
    });
    const persisted = await env.db.select().from(platformEvents);
    expect(persisted.filter((event) => event.status === 'skipped')).toHaveLength(3);
  });
  test('queue backfill preview reads all targets without writing or returning tokens', async () => {
    await env.ROUTING.put(
      'queue:operator-test',
      JSON.stringify({ workerName: 'user-test', projectId: 'test' }),
    );
    const put = vi.spyOn(env.ROUTING, 'put');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        success: true,
        result: [{ name: '__VOID_PROXY_TOKEN', type: 'plain_text', text: 'private-token' }],
      }),
    );
    const response = await req('/system/backfill-queue-tokens', { dryRun: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployments: Array<{ project_id: string; status: string }>;
    };
    expect(body).toMatchObject({ dryRun: true, wouldUpdate: 1, updated: 0 });
    expect(JSON.stringify(body)).not.toContain('private-token');
    expect(put).not.toHaveBeenCalled();
    await env.ROUTING.delete('queue:operator-test');
  });
});
