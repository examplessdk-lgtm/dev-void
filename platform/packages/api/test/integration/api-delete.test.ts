import { eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { createBuild } from '../../src/db.ts';
import * as db from '../../src/db.ts';
import { encryptEmailDomainToken } from '../../src/email/domains.ts';
import { RELAY_WORKER_BASE_NAME } from '../../src/email/relay-engine.ts';
import app from '../../src/index.ts';
import {
  resources,
  projects,
  deployments,
  builds,
  emailDestinations,
  emailDomains,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfError,
  cfSuccess,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

// A BUILD_MANAGER stand-in that records which build ids received a `cancelBuild`
// RPC (the DO name is the build id). Mirrors the helper in api-webhooks.test.ts /
// api-github.test.ts: teardown's container-build cleanup calls `cancelBuild` on
// BuildManager, so we assert it was invoked rather than touching a real DO.
function recordingBuildManager(): {
  namespace: DurableObjectNamespace;
  cancelledIds: ReadonlyArray<string>;
} {
  const cancelledIds: Array<string> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      cancelBuild: async (_reason?: string) => {
        cancelledIds.push(id.toString());
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, cancelledIds };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // The orphan sweep waits two seconds for real Cloudflare writes to settle.
  // This fixture's provider is synchronous and in-memory: keep both sweeps,
  // but schedule that delay immediately instead of paying it in every case.
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    schedule(callback, delay === 2000 ? 0 : delay, ...args),
  );
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function addResource(
  projectId: string,
  type: 'd1' | 'kv' | 'r2' | 'queue',
  cfId: string,
  bindingName: string,
): Promise<void> {
  await env.db.insert(resources).values({
    id: `res_${type}_${cfId}`,
    project_id: projectId,
    type,
    cf_id: cfId,
    binding_name: bindingName,
  });
}

describe('DELETE /projects/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake', {
        method: 'DELETE',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found' });
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('returns 409 while a rollback lease protects external compensation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-leased-delete');
    await env.db.insert(deployments).values({
      id: 'dpl_rollback_lease',
      project_id: project.id,
      status: 'pending',
      source: 'rollback-lease',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'project operation in progress' });
    expect(await db.getProject(env.db, project.id)).not.toBeNull();
  });

  it('deletes project with no resources', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'empty-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; slug: string };
    expect(body).toEqual({ ok: true, id: project.id, slug: 'empty-app' });

    // Verify project is gone from DB
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
  });

  it('deletes project with resources, assets, and routing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'full-app');
    mockCfApi();

    // Add resources
    await addResource(project.id, 'd1', 'd1-uuid-123', 'DB');
    await addResource(project.id, 'kv', 'kv-id-456', 'KV');
    await addResource(project.id, 'r2', 'r2-bucket-789', 'STORAGE');

    // Add a deployment
    await env.db.insert(deployments).values({
      id: 'dpl_test1',
      project_id: project.id,
      status: 'live',
    });

    // Add KV routing entry
    await env.ROUTING.put(
      'full-app',
      JSON.stringify({ workerName: 'user-full-app', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; slug: string };
    expect(body).toEqual({ ok: true, id: project.id, slug: 'full-app' });

    // Verify DB records are gone
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();

    const dbResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(dbResources).toHaveLength(0);

    const dbDeployments = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dbDeployments).toHaveLength(0);

    // Verify KV routing removed
    const routing = await env.ROUTING.get('full-app');
    expect(routing).toBeNull();
  });

  it('terminalizes in-flight builds and tears down their container DOs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'building-app');
    mockCfApi();

    // Two in-flight builds: a container build (has a live DO) and a
    // github_actions build (no DO — token revoked purely by terminalizing the
    // row). Both must be gone after delete, and the container DO torn down.
    const containerBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const actionsBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // The container build's DO got a cancelBuild RPC; github_actions has no DO.
    expect(cancelledIds).toContain(containerBuild.id);
    expect(cancelledIds).not.toContain(actionsBuild.id);

    // Both build rows are gone — their deploy tokens are dead (the auth guard
    // rejects any token whose bound build row is missing / not ACTIVE).
    const remaining = await env.db.select().from(builds).where(eq(builds.project_id, project.id));
    expect(remaining).toHaveLength(0);
  });

  it('deletes the CF object for a resource that raced the teardown snapshot', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'race-orphan-app');
    // A real D1 resource row exists at cascade time.
    await addResource(project.id, 'd1', 'd1-raced-uuid', 'DB');

    const cf = mockCfApi();
    // Simulate the orphan-on-concurrent-create race: teardown's one-time resource
    // snapshot MISSES this row (modelled here as a row inserted after the snapshot
    // read). With getProjectResources returning [], cleanupBestEffortResources
    // cleans nothing — so the ONLY path that can delete the CF D1 object is the
    // post-cascade race-window sweep (deleteProjectCascade RETURNs the row →
    // cleanupRaceWindowResourceOrphans).
    vi.spyOn(db, 'getProjectResources').mockResolvedValue([]);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // The race-window sweep deleted the CF D1 object behind the missed row.
    const d1Deletes = cf.mock.calls.filter(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === 'DELETE' &&
        String(url).includes('/d1/database/d1-raced-uuid'),
    );
    expect(d1Deletes.length).toBeGreaterThan(0);

    // And the row is gone.
    const remaining = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(remaining).toHaveLength(0);
  });

  it('returns warnings on CF resource deletion failure', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'warn-app');
    mockCfApi({
      deleteD1: () => cfError('database not found', 404),
    });

    await addResource(project.id, 'd1', 'd1-gone', 'DB');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: Array<string> };
    expect(body.ok).toBe(true);
    expect(body.warnings).toBeDefined();
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings![0]).toContain('d1');

    // Project should still be deleted from DB despite warnings
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
  });

  it('does not warn when worker 404s (static project)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-app');
    // Set type to spa (static project — no worker deployed)
    await env.db.update(projects).set({ type: 'spa' }).where(eq(projects.id, project.id));
    mockCfApi({
      deleteWorker: () => new Response('not found', { status: 404 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: Array<string> };
    expect(body).toEqual({ ok: true, id: project.id, slug: 'static-app' });
    expect(body.warnings).toBeUndefined();
  });

  it('deletes queue resources and routing KV entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-app');
    const fetchMock = mockCfApi();
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-demo-queue`;

    // Add a queue resource
    await addResource(project.id, 'queue', '25832cb0ce3d4f60b1e538911a4629f4', 'demo-queue');
    await env.db.insert(deployments).values([
      {
        id: 'dpl_active',
        project_id: project.id,
        status: 'live',
      },
      {
        id: 'dpl_failed',
        project_id: project.id,
        status: 'failed',
      },
    ]);
    await env.db
      .update(projects)
      .set({ active_deployment_id: 'dpl_active' })
      .where(eq(projects.id, project.id));

    // Add queue routing KV entry (as deploy would)
    await env.ROUTING.put(
      queueRoutingKey,
      JSON.stringify({
        workerName: 'user-queue-app-dpl_active',
        projectId: project.id,
        queueName: 'demo-queue',
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify deleteQueue CF API was called
    const deleteQueueCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/queues/25832cb0ce3d4f60b1e538911a4629f4') &&
        (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(deleteQueueCall).toBeDefined();

    const workerDeleteCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'DELETE';
    });
    const deletedWorkers = workerDeleteCalls.map((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.split('/scripts/')[1];
    });
    expect(deletedWorkers).toEqual(
      expect.arrayContaining([
        'user-queue-app',
        'user-queue-app-dpl_active',
        'user-queue-app-dpl_failed',
      ]),
    );

    const queueDeleteIndex = fetchMock.mock.calls.findIndex((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/queues/25832cb0ce3d4f60b1e538911a4629f4') &&
        (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    for (const workerName of ['user-queue-app-dpl_active', 'user-queue-app-dpl_failed']) {
      const workerDeleteIndex = fetchMock.mock.calls.findIndex((call: Array<unknown>) => {
        const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
        return (
          url.includes(`/scripts/${workerName}`) && (call[1] as RequestInit)?.method === 'DELETE'
        );
      });
      expect(workerDeleteIndex).toBeGreaterThanOrEqual(0);
      expect(workerDeleteIndex).toBeLessThan(queueDeleteIndex);
    }

    // Verify queue routing KV entry is removed
    const routing = await env.ROUTING.get(queueRoutingKey);
    expect(routing).toBeNull();

    // Verify DB records are gone
    const dbResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(dbResources).toHaveLength(0);
  });

  it('deletes the legacy worker name for older projects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-del');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Find the legacy worker delete call
    const deleteWorkerCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/workers/dispatch/') &&
        url.includes('user-worker-del') &&
        (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(deleteWorkerCall).toBeDefined();
  });

  // Regression for direct-to-R2 orphan accumulation: bytes uploaded via the
  // direct-to-R2 presigned PUTs that never finalized into a live deploy (e.g.
  // upload-urls / teardown TOCTOU race, abandoned upload) live durably under
  // `assets/{projectId}/{blake3}` keys. Retention cleanup only walks hashes
  // referenced by retained manifests, so without a teardown sweep these would
  // leak permanently. Project teardown must clear the entire prefix.
  it('sweeps R2 assets/{projectId}/* on teardown', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'asset-sweep');
    mockCfApi();

    const ownKeys = [
      `assets/${project.id}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      `assets/${project.id}/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      `assets/${project.id}/cccccccccccccccccccccccccccccccc`,
    ];
    for (const key of ownKeys) {
      await env.STATIC_ASSETS_R2.put(key, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    }
    // Sibling project's bytes must NOT be touched.
    const otherKey = 'assets/proj_otherproject/dddddddddddddddddddddddddddddddd';
    await env.STATIC_ASSETS_R2.put(otherKey, new Uint8Array([4, 5, 6]).buffer as ArrayBuffer);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    for (const key of ownKeys) {
      expect(await env.STATIC_ASSETS_R2.head(key)).toBeNull();
    }
    expect(await env.STATIC_ASSETS_R2.head(otherKey)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CF Email Routing destination cleanup.
//
// Destinations are ACCOUNT-level on Cloudflare: one address added for project
// A is a valid `send_email` recipient for every worker in the account. The
// `email_destinations` rows are the only thing that maps them back to
// projects, and `deleteProjectCascade` deletes those rows — so the cleanup
// MUST run before the cascade. If it runs after (or not at all) the
// destination leaks onto the account forever with nothing left to compute the
// reference count from. These tests fail if the call is dropped or reordered.
// ---------------------------------------------------------------------------

/**
 * Wrap the fetch stub `mockCfApi()` installed so `/email/routing/addresses`
 * calls are recorded and answered here. Kept local rather than pushed into
 * `mockCfApi` — the only thing under test is which destinations teardown
 * decides to delete.
 */
function captureEmailRoutingCalls(): Array<{ method: string; url: string }> {
  const calls: Array<{ method: string; url: string }> = [];
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/email/routing/addresses')) {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const tag = url.split('/').pop()?.split('?')[0] ?? 'unknown';
      return Response.json({ success: true, errors: [], messages: [], result: { tag } });
    }
    return inner(input, init);
  });
  return calls;
}

async function addEmailDestination(
  projectId: string,
  address: string,
  cfDestinationId: string,
): Promise<void> {
  await env.db.insert(emailDestinations).values({
    id: `edst_${projectId}_${cfDestinationId}`,
    project_id: projectId,
    address,
    status: 'verified',
    cf_destination_id: cfDestinationId,
  });
}

describe('DELETE /projects/:id — CF email destination cleanup', () => {
  it('DELETEs a destination this project is the only referent of', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-solo');
    mockCfApi();
    const emailCalls = captureEmailRoutingCalls();

    await addEmailDestination(project.id, 'owner@example.com', 'cf-tag-solo');
    await env.ROUTING.put(`email-allowlist:${project.id}`, JSON.stringify(['owner@example.com']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // The whole point: the account-level address is gone from Cloudflare.
    // A cleanup that ran AFTER `deleteProjectCascade` would see no rows and
    // make no call here.
    expect(emailCalls).toEqual([
      {
        method: 'DELETE',
        url: expect.stringContaining('/email/routing/addresses/cf-tag-solo') as unknown as string,
      },
    ]);

    // Proxy read-caches for the dead project are dropped too.
    expect(await env.ROUTING.get(`email-allowlist:${project.id}`)).toBeNull();
    expect(await env.ROUTING.get(`email-slug:${project.id}`)).toBeNull();
  });

  it('leaves a destination another project still references on the account', async () => {
    const user = await createTestUser(env.db);
    const doomed = await createTestProject(env.db, user.id, 'mail-shared-a');
    const survivor = await createTestProject(env.db, user.id, 'mail-shared-b');
    mockCfApi();
    const emailCalls = captureEmailRoutingCalls();

    // Same CF tag on both projects — deleting it would silently break the
    // surviving project's ability to mail that recipient.
    await addEmailDestination(doomed.id, 'shared@example.com', 'cf-tag-shared');
    await addEmailDestination(survivor.id, 'shared@example.com', 'cf-tag-shared');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${doomed.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(emailCalls).toEqual([]);

    // The survivor keeps its row.
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, survivor.id));
    expect(rows).toHaveLength(1);
  });

  it('still deletes the project when Cloudflare refuses the destination delete', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-cf-down');
    mockCfApi();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/email/routing/addresses')) {
        return Response.json(
          { success: false, errors: [{ code: 1000, message: 'boom' }], messages: [], result: null },
          { status: 500 },
        );
      }
      return inner(input, init);
    });

    await addEmailDestination(project.id, 'owner@example.com', 'cf-tag-down');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    // A CF orphan is recoverable by a sweep; a half-torn-down project is not.
    expect(res.status).toBe(200);
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The proxy authorizes `/email/send` with `__VOID_PROXY_TOKEN`, an HMAC of the
// project id that never expires and that the tenant's own worker code can
// read. After teardown the ONLY things that stop that token from sending are
// the `email-slug:<projectId>` and `email-allowlist:<projectId>` KV mirrors
// (a missing slug mirror is a 502, a missing allowlist denies every
// recipient) — the proxy reads a missing routing blob as "not suspended".
// Once the cascade has run there is no row left to retry the deletes from
// and nothing sweeps them, so a mirror that outlives the project keeps a
// dead tenant sendable forever. Teardown therefore fails closed on those two
// deletes, exactly as the destination revoke paths do on their mirror write.
// ---------------------------------------------------------------------------

describe('DELETE /projects/:id — email send authorization outlives nothing', () => {
  it('keeps the project when the email mirrors cannot be deleted, and a retry finishes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-kv-down');
    mockCfApi();
    await env.ROUTING.put(`email-slug:${project.id}`, project.slug);
    await env.ROUTING.put(`email-allowlist:${project.id}`, JSON.stringify(['owner@example.com']));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-mail-kv-down', projectId: project.id }),
    );

    // KV refuses ONLY the two email mirror deletes. Every other delete —
    // the routing entry included — goes through, which is the exact
    // permutation that used to leave the stale mirrors authorizing sends
    // for a project whose routing entry (and row) were already gone.
    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    const failing = vi.spyOn(env.ROUTING, 'delete').mockImplementation((async (k: string) => {
      if (k === `email-slug:${project.id}` || k === `email-allowlist:${project.id}`) {
        throw new Error('forced KV failure for test');
      }
      return originalDelete(k as never);
    }) as typeof env.ROUTING.delete);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/try again/);

    // The row is the retry handle: it stays, marked deleting, with the
    // mirrors it will delete on the next attempt still in place.
    const [kept] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(kept?.status).toBe('deleting');
    expect(await env.ROUTING.get(`email-slug:${project.id}`)).toBe(project.slug);
    expect(await env.ROUTING.get(`email-allowlist:${project.id}`)).not.toBeNull();

    failing.mockRestore();
    const retry = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(retry.status).toBe(200);
    const [gone] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(gone).toBeUndefined();
    expect(await env.ROUTING.get(`email-slug:${project.id}`)).toBeNull();
    expect(await env.ROUTING.get(`email-allowlist:${project.id}`)).toBeNull();
    expect(await env.ROUTING.get(project.slug)).toBeNull();
  });

  it('revokes the slug mirror before the allowlist mirror', async () => {
    // The slug mirror is the stronger gate — without it the proxy answers
    // 502 whatever the allowlist says — so it goes first: if the second
    // delete is the one that fails, the send path is already closed while
    // the row waits for the retry.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-slug-first');
    mockCfApi();
    await env.ROUTING.put(`email-slug:${project.id}`, project.slug);
    await env.ROUTING.put(`email-allowlist:${project.id}`, JSON.stringify(['owner@example.com']));

    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'delete').mockImplementation((async (k: string) => {
      if (k === `email-allowlist:${project.id}`) {
        throw new Error('forced KV failure for test');
      }
      return originalDelete(k as never);
    }) as typeof env.ROUTING.delete);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(503);
    expect(await env.ROUTING.get(`email-slug:${project.id}`)).toBeNull();
    const [kept] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(kept?.status).toBe('deleting');
  });
});

// ---------------------------------------------------------------------------
// The inbound lane has the same shape: a registered domain's relay secret
// never expires, and the `email-domain:<domain>` mirror is what the proxy's
// /email/relay proves it against. The FK cascade destroys the email_domains
// rows — after it, the set of mirror keys is unrecoverable and nothing
// sweeps them — so teardown clears them fail-closed BEFORE the cascade,
// alongside the send mirrors.
// ---------------------------------------------------------------------------

describe('DELETE /projects/:id — email domain mirrors outlive nothing', () => {
  async function seedDomainMirror(projectId: string, domain: string): Promise<void> {
    await env.db.insert(emailDomains).values({
      id: `edom_${domain.replace(/[^a-z0-9]/g, '')}`,
      project_id: projectId,
      domain,
      status: 'active',
      credential_kind: 'api_token',
      token_ciphertext: 'dummy-ct',
      token_iv: 'dummy-iv',
      token_key_version: 'v1',
      relay_ciphertext: 'dummy-ct',
      relay_iv: 'dummy-iv',
      relay_key_version: 'v1',
    });
    await env.ROUTING.put(
      `email-domain:${domain}`,
      JSON.stringify({
        projectId,
        status: 'active',
        relaySecretSha256: '00'.repeat(32),
        relayWorkerName: 'void-email-relay',
        accountId: 'acct_1',
        zoneId: 'zone_1',
        mode: 'apex',
      }),
    );
  }

  it('clears the email-domain mirror of every registered domain before the cascade', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-domain-mirror');
    mockCfApi();
    await seedDomainMirror(project.id, 'acme.com');
    await seedDomainMirror(project.id, 'mail.acme.example');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme.com')).toBeNull();
    expect(await env.ROUTING.get('email-domain:mail.acme.example')).toBeNull();
  });

  it('keeps the project when an email-domain mirror cannot be deleted, and a retry finishes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-domain-kv-down');
    mockCfApi();
    await seedDomainMirror(project.id, 'acme.com');

    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    const failing = vi.spyOn(env.ROUTING, 'delete').mockImplementation((async (k: string) => {
      if (k === 'email-domain:acme.com') {
        throw new Error('forced KV failure for test');
      }
      return originalDelete(k as never);
    }) as typeof env.ROUTING.delete);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/try again/);

    // The row is the retry handle: it stays, marked deleting, with the
    // domain row and mirror it will delete on the next attempt in place.
    const [kept] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(kept?.status).toBe('deleting');
    expect(await env.ROUTING.get('email-domain:acme.com')).not.toBeNull();
    const [domainRow] = await env.db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.project_id, project.id));
    expect(domainRow?.domain).toBe('acme.com');

    failing.mockRestore();
    const retry = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(retry.status).toBe(200);
    const [gone] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(gone).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The customer-side half of email domain teardown. The KV mirrors above are
// revoked fail-closed; the relay worker and the zone catch-all live in the
// CUSTOMER's Cloudflare account, so `cleanupProjectEmailDomains` removes them
// best-effort (a stranded relay is already denied by the proxy) and never
// throws. These tests pin the `removeEmailDomain` contract teardown relies
// on: ownership read -> conditional drop-and-disable reset -> relay DELETE,
// a failed read skips the DELETE (the rule and its relay stay a consistent
// pair), and a row whose relay never deployed gets no customer call at all.
// ---------------------------------------------------------------------------

type CustomerEmailCleanupCall = {
  tag: 'catchAllGet' | 'catchAll' | 'scriptDelete' | 'oauthToken' | 'oauthRevoke';
  method: string;
  url: string;
  body?: unknown;
  /** OAuth endpoint form fields (dash.cloudflare.com) — dummy fixtures only. */
  form?: Record<string, string>;
};

/**
 * Wrap the fetch stub `mockCfApi()` installed so the CUSTOMER-account email
 * endpoints (the zone catch-all rule GET/PUT, the relay script DELETE) and
 * the OAuth grant endpoints (dash.cloudflare.com oauth2/token + oauth2/revoke
 * — a DIFFERENT host than api.cloudflare.com) are recorded and answered here
 * — the platform-wide mock does not know them. Same tag names and response
 * shapes as `stubCustomerCf` in api-email-domains.test.ts, kept local: only
 * teardown's remove contract is under test.
 */
function captureCustomerEmailCleanup(
  config: {
    /** The zone's current catch-all; absent → 404 (no rule). */
    catchAllRule?: { enabled: boolean; workerName: string | null };
    failOn?: Partial<Record<CustomerEmailCleanupCall['tag'], { message: string; status: number }>>;
  } = {},
): Array<CustomerEmailCleanupCall> {
  const calls: Array<CustomerEmailCleanupCall> = [];
  const fail = (tag: CustomerEmailCleanupCall['tag']): Response | null => {
    const failure = config.failOn?.[tag];
    return failure ? cfError(failure.message, failure.status) : null;
  };
  const readForm = (init?: RequestInit): Record<string, string> => {
    const form: Record<string, string> = {};
    if (typeof init?.body === 'string') {
      for (const [key, value] of new URLSearchParams(init.body)) {
        form[key] = value;
      }
    }
    return form;
  };
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';

    if (url.startsWith('https://dash.cloudflare.com/oauth2/token')) {
      calls.push({ tag: 'oauthToken', method, url, form: readForm(init) });
      const failure = fail('oauthToken');
      if (failure) {
        return failure;
      }
      // Grant refresh tokens rotate on every use; the caller persists this
      // replacement and revokes the chain HEAD, not the presented token.
      return Response.json({
        access_token: 'cf-access-dummy-1',
        refresh_token: 'cf-rotated-refresh-dummy-1',
        expires_in: 3600,
      });
    }
    if (url.startsWith('https://dash.cloudflare.com/oauth2/revoke')) {
      calls.push({ tag: 'oauthRevoke', method, url, form: readForm(init) });
      // RFC 7009 answers 200 whether the token was revoked or already
      // invalid; the body is ignored.
      return fail('oauthRevoke') ?? new Response(null, { status: 200 });
    }

    if (url.includes('/email/routing/rules/catch_all') && method === 'GET') {
      calls.push({ tag: 'catchAllGet', method, url });
      const failure = fail('catchAllGet');
      if (failure) {
        return failure;
      }
      if (!config.catchAllRule) {
        return cfError('rule not found', 404);
      }
      return cfSuccess({
        enabled: config.catchAllRule.enabled,
        matchers: [{ type: 'all' }],
        actions:
          config.catchAllRule.workerName === null
            ? [{ type: 'drop', value: [] }]
            : [{ type: 'worker', value: [config.catchAllRule.workerName] }],
      });
    }
    if (url.includes('/email/routing/rules/catch_all') && method === 'PUT') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ tag: 'catchAll', method, url, body });
      return fail('catchAll') ?? cfSuccess({});
    }
    if (/\/accounts\/[^/]+\/workers\/scripts\/[^/?#]+$/.test(new URL(url).pathname)) {
      if (method === 'DELETE') {
        calls.push({ tag: 'scriptDelete', method, url });
        return fail('scriptDelete') ?? cfSuccess({});
      }
    }
    return inner(input, init);
  });
  return calls;
}

describe('DELETE /projects/:id — customer-side email domain cleanup', () => {
  // The CUSTOMER's zone/account — deliberately distinct from the platform's
  // CF_ACCOUNT_ID/CF_ZONE_ID so a teardown that billed the platform account
  // would not match these stubs.
  const CUSTOMER_ZONE_ID = 'zone_customer_1';
  const CUSTOMER_ACCOUNT_ID = 'acct_customer_1';
  const DOMAIN_API_TOKEN = 'cf-api-token-dummy';
  const DOMAIN_REFRESH_TOKEN = 'cf-refresh-token-dummy';

  async function seedCustomerEmailDomain(
    projectId: string,
    domain: string,
    options: {
      status?: 'active' | 'failed';
      relayWorkerName?: string | null;
      credentialKind?: 'api_token' | 'oauth_grant';
    } = {},
  ): Promise<void> {
    const status = options.status ?? 'active';
    const relayWorkerName =
      options.relayWorkerName === undefined ? RELAY_WORKER_BASE_NAME : options.relayWorkerName;
    const credentialKind = options.credentialKind ?? 'api_token';
    // The token triple must really decrypt — teardown decrypts it to build
    // the customer CF client (the grant's refresh token on the oauth_grant
    // path). The relay triple is never read on this path (dummy stand-ins,
    // as in seedDomainMirror above).
    const tokenEnc = await encryptEmailDomainToken(
      env,
      projectId,
      domain,
      credentialKind === 'oauth_grant' ? DOMAIN_REFRESH_TOKEN : DOMAIN_API_TOKEN,
    );
    await env.db.insert(emailDomains).values({
      id: `edom_${domain.replace(/[^a-z0-9]/g, '')}`,
      project_id: projectId,
      domain,
      zone_id: CUSTOMER_ZONE_ID,
      account_id: CUSTOMER_ACCOUNT_ID,
      mode: 'apex',
      status,
      credential_kind: credentialKind,
      token_ciphertext: tokenEnc.ciphertext,
      token_iv: tokenEnc.iv,
      token_key_version: tokenEnc.keyVersion,
      relay_ciphertext: 'dummy-ct',
      relay_iv: 'dummy-iv',
      relay_key_version: 'v1',
      relay_worker_name: relayWorkerName,
    });
    await env.ROUTING.put(
      `email-domain:${domain}`,
      JSON.stringify({
        projectId,
        status,
        relaySecretSha256: '00'.repeat(32),
        relayWorkerName,
        accountId: CUSTOMER_ACCOUNT_ID,
        zoneId: CUSTOMER_ZONE_ID,
        mode: 'apex',
      }),
    );
  }

  it('deletes the customer-side relay and catch-all for each registered email domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-cleanup');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    await seedCustomerEmailDomain(project.id, 'acme-relay.example');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // removeEmailDomain's order: ownership read, conditional drop-and-disable
    // reset, relay DELETE — all against the customer zone/account.
    expect(customerCalls.map((call) => call.tag)).toEqual([
      'catchAllGet',
      'catchAll',
      'scriptDelete',
    ]);
    expect(customerCalls[0]!.url).toContain(
      `/zones/${CUSTOMER_ZONE_ID}/email/routing/rules/catch_all`,
    );
    expect(customerCalls[1]!.url).toContain(
      `/zones/${CUSTOMER_ZONE_ID}/email/routing/rules/catch_all`,
    );
    expect(customerCalls[1]!.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'drop' }],
      enabled: false,
    });
    expect(customerCalls[2]!.url).toContain(
      `/accounts/${CUSTOMER_ACCOUNT_ID}/workers/scripts/${RELAY_WORKER_BASE_NAME}`,
    );
    // api_token rows never touch the OAuth endpoints — there is no grant to
    // refresh or revoke (the exact tag list above already pins this).
    expect(customerCalls.some((call) => call.tag === 'oauthRevoke')).toBe(false);

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay.example')).toBeNull();
  });

  it('revokes the OAuth grant during teardown for an oauth_grant domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-oauth');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    await seedCustomerEmailDomain(project.id, 'acme-relay-oauth.example', {
      credentialKind: 'oauth_grant',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // removeEmailDomain's oauth order: the serialized refresh FIRST (its
    // rotation persists through the row's chain while the row still exists),
    // then the customer-side cleanup, then the grant revoke LAST — against
    // the ROTATED refresh token, the live chain head.
    expect(customerCalls.map((call) => call.tag)).toEqual([
      'oauthToken',
      'catchAllGet',
      'catchAll',
      'scriptDelete',
      'oauthRevoke',
    ]);
    expect(customerCalls[4]!.form).toMatchObject({
      token_type_hint: 'refresh_token',
      token: 'cf-rotated-refresh-dummy-1',
    });

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay-oauth.example')).toBeNull();
  });

  it('still deletes the project when the grant revoke fails — revoke_grant lands in failed_steps', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-revoke-down');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { oauthRevoke: { message: 'boom', status: 500 } },
    });
    await seedCustomerEmailDomain(project.id, 'acme-relay-revoke-down.example', {
      credentialKind: 'oauth_grant',
    });
    // revokeOauthGrant THROWS on the 500 (a silent return would make the
    // engine's revoke_grant failed_step unreachable); the warn spy catches
    // the residue report, the error spy silences the helper's own log.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    // Best-effort: the customer-side cleanup all ran; only the terminal
    // revoke failed, and teardown proceeds regardless.
    expect(res.status).toBe(200);
    expect(customerCalls.map((call) => call.tag)).toEqual([
      'oauthToken',
      'catchAllGet',
      'catchAll',
      'scriptDelete',
      'oauthRevoke',
    ]);
    // The revoke targeted the ROTATED chain head, as on the happy path.
    expect(customerCalls[4]!.form).toMatchObject({
      token_type_hint: 'refresh_token',
      token: 'cf-rotated-refresh-dummy-1',
    });
    expect(
      warnSpy.mock.calls.some(
        (call) =>
          String(call[0]).includes('teardown left CF-side residue') &&
          JSON.stringify(call[1]).includes('revoke_grant'),
      ),
    ).toBe(true);

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay-revoke-down.example')).toBeNull();
  });

  it('still deletes the project when the grant refresh fails transiently — and revokes the stored token', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-oauth-down');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { oauthToken: { message: 'boom', status: 500 } },
    });
    await seedCustomerEmailDomain(project.id, 'acme-relay-oauth-down.example', {
      credentialKind: 'oauth_grant',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    // Best-effort: the failed refresh strands the relay and catch-all
    // (failed_steps — logged, never surfaced), so deletion proceeds; the
    // mirrors are already gone and the proxy denies the stranded relay.
    expect(res.status).toBe(200);

    // A transient refresh failure still revokes the ORIGINAL stored
    // credential: it may still be live, and the row holding it is about to
    // disappear. No customer-zone call is attempted without an access token.
    expect(customerCalls.map((call) => call.tag)).toEqual(['oauthToken', 'oauthRevoke']);
    expect(customerCalls[1]!.form).toMatchObject({
      token_type_hint: 'refresh_token',
      token: DOMAIN_REFRESH_TOKEN,
    });

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay-oauth-down.example')).toBeNull();
  });

  it('still deletes the project when customer-side email cleanup fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-cf-down');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { catchAllGet: { message: 'boom', status: 500 } },
    });
    await seedCustomerEmailDomain(project.id, 'acme-relay-down.example');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    // Best-effort: the failure is logged, not surfaced — the mirrors are
    // already gone, so the stranded relay is denied by the proxy.
    expect(res.status).toBe(200);

    // The ownership read failed, so the consistent-pair rule skipped both
    // the reset and the relay DELETE: an enabled catch-all must never be
    // left pointing at a deleted worker.
    expect(customerCalls.map((call) => call.tag)).toEqual(['catchAllGet']);

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay-down.example')).toBeNull();
  });

  it('does not touch the customer account for a domain that never deployed a relay', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-never-deployed');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    // A row that failed before the relay deploy has no customer-side state:
    // null relay_worker_name is the skip key (zone/account may be known).
    await seedCustomerEmailDomain(project.id, 'acme-relay-never.example', {
      status: 'failed',
      relayWorkerName: null,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(customerCalls).toEqual([]);

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay-never.example')).toBeNull();
  });

  it('still revokes the grant for an oauth_grant domain whose relay never deployed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-relay-never-oauth');
    mockCfApi();
    const customerCalls = captureCustomerEmailCleanup({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    // A relay-less OAUTH row has no relay or rule to clean, but it owns a
    // live customer-side grant — skipping it wholesale would orphan that
    // grant with no platform handle once the cascade takes the row.
    await seedCustomerEmailDomain(project.id, 'acme-relay-never-oauth.example', {
      status: 'failed',
      relayWorkerName: null,
      credentialKind: 'oauth_grant',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Refresh (chain head persisted), no zone/account calls without a
    // relay, then the revoke LAST against the rotated head.
    expect(customerCalls.map((call) => call.tag)).toEqual(['oauthToken', 'oauthRevoke']);
    expect(customerCalls[1]!.form).toMatchObject({
      token_type_hint: 'refresh_token',
      token: 'cf-rotated-refresh-dummy-1',
    });

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-relay-never-oauth.example')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The other side of the same ordering problem: a destination POST that LOSES
// the race to teardown.
//
// The POST route's `status === 'deleting'` guard is an unlocked read, so the
// cascade can commit while the route is out at Cloudflare registering the
// address. The CF destination is account-level and already created by then,
// and `email_destinations` rows are the only thing that maps one back to a
// project — the cascade removed them all, teardown's cleanup already ran off
// the rows that existed, and there is no sweep. So the route has to hand the
// address back itself.
//
// NOT fixed here: the unlocked guard itself. That is the pre-existing
// orphan-on-concurrent-create class from design doc 0067, which three sibling
// provisioning routes ship with today.
// ---------------------------------------------------------------------------

describe('POST /projects/:id/email/destinations — losing the teardown race', () => {
  function addDestinationRequest(projectId: string, jwt: string, address: string): Request {
    return new Request(`http://localhost/projects/${projectId}/email/destinations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
  }

  function cfDeleteCalls(fetchMock: ReturnType<typeof mockCfApi>): Array<string> {
    return (fetchMock.mock.calls as Array<Array<unknown>>)
      .filter((call) => {
        const init = call[1] as RequestInit | undefined;
        const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
        return init?.method === 'DELETE' && url.includes('/email/routing/addresses');
      })
      .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])));
  }

  it('deletes the CF destination it created and returns the not-inserted status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-race');

    const fetchMock = mockCfApi({
      // Teardown commits its cascade while we are out at CF. The project row
      // — and, by ON DELETE CASCADE, every email_destinations row — is gone
      // before the INSERT below runs, so the FK has nothing to point at.
      addEmailDestination: async (_url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        await db.deleteProjectCascade(env.db, project.id);
        return cfSuccess({
          tag: 'cf-tag-race',
          email: body.email,
          verified: null,
          created: '2026-04-27T00:00:00Z',
          modified: '2026-04-27T00:00:00Z',
        });
      },
    });

    const res = await app.fetch(
      addDestinationRequest(project.id, user.jwt, 'racer@example.com'),
      env,
    );

    // The INSERT raised `23503`. Uncaught it reaches the app's `onError` as a
    // generic 500 — this is the same "not inserted" answer the sibling-DELETE
    // race already gives, not a new code.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'destination concurrently modified, try again' });

    // And the account-level address is handed back rather than burning a slot
    // of the shared 200-destination cap forever.
    expect(cfDeleteCalls(fetchMock)).toEqual([
      expect.stringContaining('/email/routing/addresses/cf-tag-race') as unknown as string,
    ]);
  });

  it('leaves a CF destination a surviving project still references', async () => {
    // Same race, but the tag came from the already-exists recovery and a live
    // sibling project points at it. The count must be ZERO to delete — our own
    // row does not exist, so `<= 1` would revoke the sibling's recipient.
    const user = await createTestUser(env.db);
    const doomed = await createTestProject(env.db, user.id, 'mail-race-shared');
    const survivor = await createTestProject(env.db, user.id, 'mail-race-survivor');
    await addEmailDestination(survivor.id, 'shared@example.com', 'cf-tag-shared');

    const fetchMock = mockCfApi({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: async () => {
        await db.deleteProjectCascade(env.db, doomed.id);
        return cfSuccess([
          {
            tag: 'cf-tag-shared',
            email: 'shared@example.com',
            verified: '2026-04-26T00:00:00Z',
            created: '2026-04-25T00:00:00Z',
            modified: '2026-04-26T00:00:00Z',
          },
        ]);
      },
    });

    const res = await app.fetch(
      addDestinationRequest(doomed.id, user.jwt, 'shared@example.com'),
      env,
    );

    expect(res.status).toBe(409);
    expect(cfDeleteCalls(fetchMock)).toEqual([]);

    // The survivor keeps both its row and its recipient.
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, survivor.id));
    expect(rows).toHaveLength(1);
  });
});
