import { eq, and } from 'drizzle-orm';
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
import { markDeploymentRetained } from '../../src/db.ts';
import app from '../../src/index.ts';
import { deployments, projects, resources } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  readAllEvents,
  type TestEnv,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// Integration tests for the per-deploy sandbox architecture (post-#46/#47).
//
// Each sandbox deploy creates its own user worker `user-{slug}-{deployId}`
// that owns its own `Sandbox` Durable Object class via the Worker upload
// metadata (`bindings + containers + migrations`). The deploy then POSTs a
// fresh container application named
// `${projectId}-${deploymentId}-${containerName}` (lowercased, `_`→`-`)
// bound to the freshly-minted DO namespace.
//
// There is NO host script (`do-host-{slug}` is gone), NO cross-script DO
// binding, and NO `provisionSandboxHost` step. Cross-script bindings into a
// dispatch namespace are rejected by CF (the mock guards this); the
// regression test asserts the rejection still fires.
//
// Worker bytes are stored in R2 at
// `worker-bundles/{projectId}/{deploymentId}/{path}` so future rollbacks
// can re-PUT them. `deployments.bundle_stored=true` after R2 puts succeed.
// Retention deletes the per-deploy container app + R2 bundle objects when
// evicting; project teardown deletes ALL retained deployments' container
// apps via the orphan-recovery enumeration in `cleanup.ts`.
// ---------------------------------------------------------------------------

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SANDBOX_IMAGE_V1 = 'registry.cloudflare.com/sandbox:1.0.0';

function buildSandboxManifest(overrides?: {
  image?: string;
  containerName?: string;
}): Record<string, unknown> {
  return {
    version: 3,
    bindings: {},
    sandbox: {
      bindingName: 'SANDBOX',
      className: 'Sandbox',
      containerName: overrides?.containerName ?? 'void-sandbox',
      image: overrides?.image ?? SANDBOX_IMAGE_V1,
      instanceType: 'lite',
      maxInstances: 20,
      migrations: [{ tag: 'sandbox-v1', newSqliteClasses: ['Sandbox'] }],
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function deploy(
  projectId: string,
  jwt: string,
  manifest?: Record<string, unknown>,
  workers?: Record<string, string>,
): Promise<Response> {
  const baseManifest = manifest ?? buildSandboxManifest();
  const workerSources = workers ?? {
    'index.js': "export default { fetch() { return new Response('ok'); } }",
  };
  const workerFiles: Record<string, string> = {};
  for (const [name, content] of Object.entries(workerSources)) {
    workerFiles[name] = bytesToBase64(new TextEncoder().encode(content));
  }

  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: { assetManifestVersion: 2, ...baseManifest },
        assetManifest: {},
        source: null,
        commit: null,
        repositoryUrl: null,
        commitUrl: null,
        gitRef: null,
        preflight: null,
        workerFiles,
      }),
    }),
    env,
  );
}

function getDoneEvent(events: Array<unknown>): { event: string; deployment: string } | undefined {
  return events.find(
    (e): e is { event: string; deployment: string } =>
      typeof e === 'object' && e !== null && (e as { event?: unknown }).event === 'done',
  );
}

async function listR2Keys(prefix: string): Promise<Array<string>> {
  const list = await env.STATIC_ASSETS_R2.list({ prefix });
  return list.objects.map((o) => o.key);
}

describe('per-deploy sandbox integration', () => {
  // ----------------------------------------------------------------------
  // 1. First sandbox deploy
  // ----------------------------------------------------------------------
  it('first sandbox deploy: PUT user worker with same-script DO binding + containers + migrations; POST per-deploy container app; NO resources row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-first');
    const cf = mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = getDoneEvent(events);
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    // No host script `do-host-{slug}` should exist.
    expect(cf.state.hostScripts.has(`do-host-${project.slug}`)).toBe(false);

    // The dispatch namespace contains exactly the per-deploy user worker.
    const userWorkerName = `user-${project.slug}-${deployId}`;
    const userWorker = cf.state.hostScripts.get(userWorkerName);
    expect(userWorker).toBeDefined();

    // User worker owns the Sandbox DO class (mock minted a namespace_id for
    // it because metadata.migrations declared `new_sqlite_classes: ['Sandbox']`).
    expect(userWorker!.classes.get('Sandbox')).toBeTruthy();
    const namespaceId = userWorker!.classes.get('Sandbox')!;

    // Same-script DO binding: no `script_name`, with the resolved `namespace_id`.
    const sandboxBinding = userWorker!.bindings.find(
      (b) => b.type === 'durable_object_namespace' && b.name === 'SANDBOX',
    );
    expect(sandboxBinding).toBeDefined();
    expect(sandboxBinding!.script_name).toBeUndefined();
    expect(sandboxBinding!.class_name).toBe('Sandbox');
    expect(sandboxBinding!.namespace_id).toBe(namespaceId);

    // Metadata declares Sandbox as a container-enabled class on the user worker.
    const containers = (userWorker!.metadata as { containers?: Array<unknown> }).containers;
    expect(containers).toEqual([{ class_name: 'Sandbox' }]);

    // Migrations include `new_sqlite_classes: ['Sandbox']` so CF mints + sticks
    // a fresh DO namespace to this user worker.
    const migrations = userWorker!.metadata.migrations as {
      new_tag?: string;
      steps?: Array<{ new_sqlite_classes?: Array<string> }>;
    };
    expect(migrations).toBeDefined();
    expect(migrations.steps?.some((s) => s.new_sqlite_classes?.includes('Sandbox'))).toBe(true);

    // Per-deploy container app exists: `${projectId}-${deployId}-void-sandbox`
    // (lowercased, `_`→`-`), bound to the user worker's namespace_id.
    const containerAppName = `${project.id}-${deployId}-void-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');
    const containerApp = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === containerAppName,
    );
    expect(containerApp).toBeDefined();
    expect(containerApp!.durable_objects.namespace_id).toBe(namespaceId);
    expect(containerApp!.configuration.image).toBe(SANDBOX_IMAGE_V1);

    // Per-deploy containers do NOT write a `resources` row (no DB pointer —
    // teardown finds them via orphan-recovery enumeration).
    const resRows = await env.db
      .select()
      .from(resources)
      .where(and(eq(resources.project_id, project.id), eq(resources.type, 'container')));
    expect(resRows).toHaveLength(0);
  });

  // ----------------------------------------------------------------------
  // 2. Sandbox redeploy creates fresh user worker + container with NEW namespace
  // ----------------------------------------------------------------------
  it('sandbox redeploy: brand-new user worker name, brand-new namespace_id, brand-new container app (no namespace preservation across deploys)', async () => {
    const user = await createTestUser(env.db, 'sb-rd-user', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'sb-redeploy');
    const cf = mockCfApi();

    // Deploy v1.
    const res1 = await deploy(project.id, user.jwt);
    expect(res1.status).toBe(200);
    const done1 = getDoneEvent(await readAllEvents(res1));
    expect(done1).toBeDefined();
    const v1Id = done1!.deployment;

    const v1WorkerName = `user-${project.slug}-${v1Id}`;
    const v1Namespace = cf.state.hostScripts.get(v1WorkerName)!.classes.get('Sandbox')!;
    const v1ContainerName = `${project.id}-${v1Id}-void-sandbox`.toLowerCase().replaceAll('_', '-');

    // Deploy v2 with the same manifest.
    const res2 = await deploy(project.id, user.jwt);
    expect(res2.status).toBe(200);
    const done2 = getDoneEvent(await readAllEvents(res2));
    expect(done2).toBeDefined();
    const v2Id = done2!.deployment;

    expect(v2Id).not.toBe(v1Id);

    // Brand-new user worker.
    const v2WorkerName = `user-${project.slug}-${v2Id}`;
    expect(v2WorkerName).not.toBe(v1WorkerName);
    const v2Worker = cf.state.hostScripts.get(v2WorkerName);
    expect(v2Worker).toBeDefined();

    // Brand-new namespace_id (per-deploy, NOT preserved across deploys).
    const v2Namespace = v2Worker!.classes.get('Sandbox')!;
    expect(v2Namespace).toBeTruthy();
    expect(v2Namespace).not.toBe(v1Namespace);

    // Brand-new container app bound to the new namespace.
    const v2ContainerName = `${project.id}-${v2Id}-void-sandbox`.toLowerCase().replaceAll('_', '-');
    expect(v2ContainerName).not.toBe(v1ContainerName);
    const v2App = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === v2ContainerName,
    );
    expect(v2App).toBeDefined();
    expect(v2App!.durable_objects.namespace_id).toBe(v2Namespace);
  });

  // ----------------------------------------------------------------------
  // 3. R2 bundle write
  // ----------------------------------------------------------------------
  it('successful sandbox deploy persists worker bundle to R2 and flips bundle_stored=true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-bundle');
    mockCfApi();

    const workerSource = "export default { fetch() { return new Response('hi'); } }";
    const res = await deploy(project.id, user.jwt, buildSandboxManifest(), {
      'index.js': workerSource,
    });
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    // R2 has at least one object under `worker-bundles/{projectId}/{deploymentId}/`.
    const bundleKeys = await listR2Keys(`worker-bundles/${project.id}/${deployId}/`);
    expect(bundleKeys.length).toBeGreaterThan(0);
    expect(bundleKeys).toContain(`worker-bundles/${project.id}/${deployId}/index.js`);

    // bundle_stored flipped to true.
    const [row] = await env.db.select().from(deployments).where(eq(deployments.id, deployId));
    expect(row!.bundle_stored).toBe(true);
  });

  // ----------------------------------------------------------------------
  // 4. Static-only deploy doesn't write bundle
  // ----------------------------------------------------------------------
  it('static-only deploy does NOT write a worker bundle (bundle_stored stays false, no R2 objects)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-static');
    mockCfApi();

    // Pre-upload the asset to R2 — direct-to-R2 deploys verify R2 has the
    // declared bytes before flipping routing.
    const indexBytes = new TextEncoder().encode('<html>hello</html>');
    const indexHash = (await import('../../src/assets.ts')).computeAssetHash(
      indexBytes.buffer.slice(
        indexBytes.byteOffset,
        indexBytes.byteOffset + indexBytes.byteLength,
      ) as ArrayBuffer,
      '/index.html',
    );
    await env.STATIC_ASSETS_R2.put(
      `assets/${project.id}/${indexHash}`,
      indexBytes as unknown as ArrayBuffer,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            type: 'static',
            assetConfig: { not_found_handling: 'none' },
          },
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: indexHash, size: indexBytes.byteLength },
          },
          source: null,
          commit: null,
          repositoryUrl: null,
          commitUrl: null,
          gitRef: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    // No bundle objects under `worker-bundles/{projectId}/{deploymentId}/`.
    const bundleKeys = await listR2Keys(`worker-bundles/${project.id}/${deployId}/`);
    expect(bundleKeys).toHaveLength(0);

    // bundle_stored stays false.
    const [row] = await env.db.select().from(deployments).where(eq(deployments.id, deployId));
    expect(row!.bundle_stored).toBe(false);
  });

  // ----------------------------------------------------------------------
  // 5. Retention eviction
  // ----------------------------------------------------------------------
  it('retention eviction: oldest sandbox deploy has its user worker, container app, AND R2 bundle deleted when retention limit is exceeded', async () => {
    // Free plan: retainedDeployments=1 — second deploy evicts the first.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-evict');
    const cf = mockCfApi();

    // Deploy v1.
    const res1 = await deploy(project.id, user.jwt);
    expect(res1.status).toBe(200);
    const done1 = getDoneEvent(await readAllEvents(res1));
    expect(done1).toBeDefined();
    const v1Id = done1!.deployment;
    const v1WorkerName = `user-${project.slug}-${v1Id}`;
    const v1ContainerName = `${project.id}-${v1Id}-void-sandbox`.toLowerCase().replaceAll('_', '-');

    // Sanity: v1 state is in place.
    expect(cf.state.hostScripts.has(v1WorkerName)).toBe(true);
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(true);
    expect((await listR2Keys(`worker-bundles/${project.id}/${v1Id}/`)).length).toBeGreaterThan(0);

    // Deploy v2 — retention sweep should evict v1.
    const res2 = await deploy(project.id, user.jwt);
    expect(res2.status).toBe(200);
    const done2 = getDoneEvent(await readAllEvents(res2));
    expect(done2).toBeDefined();

    // v1's user worker is gone.
    expect(cf.state.hostScripts.has(v1WorkerName)).toBe(false);

    // v1's container app is gone.
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(false);

    // v1's bundle objects are gone from R2.
    expect(await listR2Keys(`worker-bundles/${project.id}/${v1Id}/`)).toHaveLength(0);

    // v1's retained flag flipped false in DB.
    const [v1Row] = await env.db.select().from(deployments).where(eq(deployments.id, v1Id));
    expect(v1Row!.retained).toBe(false);
  });

  // ----------------------------------------------------------------------
  // 6. Pre-routing failure: catch deletes user worker AND container
  // ----------------------------------------------------------------------
  it('pre-routing failure: outer catch deletes the user worker AND the per-deploy container app (no orphans)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-prefail');

    // Make CF reject the worker secret PUT to fail BETWEEN the user worker
    // PUT (and container POST) AND routing flip. This forces the
    // `routingSwitched=false` cleanup branch.
    //
    // Actually, an easier approach: stub `c.env.DISPATCH.get(...)` so the
    // readiness probe times out / fails. But the readiness probe only runs
    // when there are migrations (`manifest.migrations.pending > 0`). For a
    // sandbox-only deploy, the failure point we need is between the
    // container POST and the routing flip. Make `setWorkerSecret` fail —
    // it runs as part of secret upload AFTER the user worker PUT and
    // sandbox container POST. (No, that runs BEFORE worker PUT.)
    //
    // Simpler: make the slug ROUTING.put fail. We spy on env.ROUTING.put
    // and reject when key === project.slug, which is exactly the routing
    // flip step (`routingSwitched` is set true RIGHT AFTER that put, so a
    // failing put aborts before `routingSwitched=true`).
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      if (key === project.slug) {
        throw new Error('forced ROUTING.put failure for test');
      }
      return originalPut(key, value as never, options as never);
    }) as typeof env.ROUTING.put);

    const cf = mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = getDoneEvent(events);
    expect(done).toBeUndefined();

    const errorEvent = events.find(
      (e): e is { event: string; message: string } =>
        typeof e === 'object' && e !== null && (e as { event?: unknown }).event === 'error',
    );
    expect(errorEvent).toBeDefined();

    putSpy.mockRestore();

    // The user worker PUT is recorded in cf.state.hostScripts (mock state),
    // and the catch path issues a DELETE — so the script should NOT be present
    // anymore.
    const userWorkerKey = Array.from(cf.state.hostScripts.keys()).find((k) =>
      k.startsWith(`user-${project.slug}-`),
    );
    expect(userWorkerKey).toBeUndefined();

    // The per-deploy container app should also be gone.
    const sandboxApps = Array.from(cf.state.containerApps.values()).filter((a) =>
      a.name.endsWith('-void-sandbox'),
    );
    expect(sandboxApps).toHaveLength(0);

    // The deploy was recorded as a DELETE on the worker script and a DELETE
    // on the container app.
    const workerDeletes = cf.state.recordedCalls.filter(
      (c) =>
        c.method === 'DELETE' &&
        c.url.includes('/workers/dispatch/') &&
        c.url.includes(`/scripts/user-${project.slug}-`),
    );
    expect(workerDeletes.length).toBeGreaterThanOrEqual(1);
    const containerDeletes = cf.state.recordedCalls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
    );
    expect(containerDeletes.length).toBeGreaterThanOrEqual(1);
  });

  // ----------------------------------------------------------------------
  // 7. Post-routing teardown race: rollback branch deletes the container app
  // ----------------------------------------------------------------------
  it('post-routing teardown race: when status flips to deleting after the slug routing PUT, the rollback branch deletes the user worker AND the per-deploy container app', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sb-teardown-race');
    const cf = mockCfApi();

    // Hook: AFTER the slug ROUTING.put commits (routingSwitched=true), flip
    // projects.status='deleting' so the very next FOR UPDATE check throws
    // PROJECT_DELETING_ERROR_MESSAGE — which lands in the teardownRaceLost
    // branch of the outer catch.
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      const result = await originalPut(key, value as never, options as never);
      if (key === project.slug) {
        // Flip status='deleting' AFTER the slug routing flips. The next
        // FOR UPDATE re-check inside deploy.ts will throw and trigger the
        // teardownRaceLost branch.
        await env.db
          .update(projects)
          .set({ status: 'deleting' })
          .where(eq(projects.id, project.id));
      }
      return result;
    }) as typeof env.ROUTING.put);

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);

    // No `done` event — deploy hit the teardown-race branch and emitted error.
    const done = getDoneEvent(events);
    expect(done).toBeUndefined();
    const errorEvent = events.find(
      (e): e is { event: string; message: string } =>
        typeof e === 'object' && e !== null && (e as { event?: unknown }).event === 'error',
    );
    expect(errorEvent).toBeDefined();

    putSpy.mockRestore();

    // Both the user worker and the container app are deleted by the
    // teardown-race rollback branch.
    const userWorkerKey = Array.from(cf.state.hostScripts.keys()).find((k) =>
      k.startsWith(`user-${project.slug}-`),
    );
    expect(userWorkerKey).toBeUndefined();

    const sandboxApps = Array.from(cf.state.containerApps.values()).filter((a) =>
      a.name.endsWith('-void-sandbox'),
    );
    expect(sandboxApps).toHaveLength(0);

    // The recorded calls include a DELETE on the user worker AND a DELETE
    // on the per-deploy container app from the teardownRaceLost branch.
    const workerDeletes = cf.state.recordedCalls.filter(
      (c) =>
        c.method === 'DELETE' &&
        c.url.includes('/workers/dispatch/') &&
        c.url.includes(`/scripts/user-${project.slug}-`),
    );
    expect(workerDeletes.length).toBeGreaterThanOrEqual(1);
    const containerDeletes = cf.state.recordedCalls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
    );
    expect(containerDeletes.length).toBeGreaterThanOrEqual(1);
  });

  // ----------------------------------------------------------------------
  // 8. Mock regression: cross-script DO binding to non-existent script
  // ----------------------------------------------------------------------
  it('mock regression: cross-script DO binding referencing a non-existent dispatch-namespace script returns CF error (validates the architectural constraint)', async () => {
    mockCfApi();

    // Hand-craft a user-worker PUT with a cross-script DO binding to a
    // dispatch script that does NOT exist. The mock's uploadWorker validator
    // rejects this — same rejection the real CF API issues, which is the
    // architectural reason per-deploy avoids cross-script bindings.
    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2024-01-01',
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          script_name: 'no-such-host', // not seeded
        },
      ],
    };

    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append(
      'index.js',
      new Blob(['export default {}'], { type: 'application/javascript+module' }),
    );

    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/workers/dispatch/namespaces/void-users/scripts/user-some-test-dpl_test',
      { method: 'PUT', headers: { Authorization: 'Bearer test' }, body: formData },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      errors: Array<{ code: number; message: string }>;
    };
    expect(body.success).toBe(false);
    expect(body.errors[0]!.code).toBe(10061);
    expect(body.errors[0]!.message).toMatch(/Cannot create binding for class in script/);
  });

  // ----------------------------------------------------------------------
  // 8b. Mock regression: cross-script DO binding to an EXISTING dispatch
  // script is also rejected. CF rejects ALL cross-script DO bindings between
  // dispatch namespace scripts; the mock used to allow this when the target
  // existed (and was container-enabled), letting some bad architectures slip
  // through tests. The unconditional rejection is the closest analog to real
  // CF behavior.
  // ----------------------------------------------------------------------
  it('mock regression: cross-script DO binding to an EXISTING dispatch-namespace script is also rejected with 10061', async () => {
    const cf = mockCfApi();

    cf.seedHostScript({
      scriptName: 'do-host-existing',
      classes: { Sandbox: 'ns_seeded' },
      migrationTag: 'sandbox-v1',
      metadata: {
        containers: [{ class_name: 'Sandbox' }],
      },
    });

    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2024-01-01',
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          script_name: 'do-host-existing',
        },
      ],
    };

    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append(
      'index.js',
      new Blob(['export default {}'], { type: 'application/javascript+module' }),
    );

    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/workers/dispatch/namespaces/void-users/scripts/user-x-dpl_test',
      { method: 'PUT', headers: { Authorization: 'Bearer test' }, body: formData },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      errors: Array<{ code: number; message: string }>;
    };
    expect(body.success).toBe(false);
    expect(body.errors[0]!.code).toBe(10061);
    expect(body.errors[0]!.message).toMatch(/do-host-existing/);
  });

  // ----------------------------------------------------------------------
  // 9. Mock regression: 2nd container POST for same namespace_id returns 1608
  // ----------------------------------------------------------------------
  it('mock regression: 2nd container POST for the same namespace_id returns CF code 1608 DURABLE_OBJECT_ALREADY_HAS_APPLICATION', async () => {
    const cf = mockCfApi();

    cf.seedContainerApp({
      name: 'first-app',
      namespaceId: 'ns_shared',
      image: SANDBOX_IMAGE_V1,
      maxInstances: 20,
    });

    const res = await fetch(
      'https://api.cloudflare.com/client/v4/test-account-id/containers/applications',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'second-app',
          scheduling_policy: 'default',
          configuration: { image: SANDBOX_IMAGE_V1, instance_type: 'lite' },
          max_instances: 20,
          durable_objects: { namespace_id: 'ns_shared' },
        }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; errors: Array<{ code: number }> };
    expect(body.success).toBe(false);
    expect(body.errors[0]!.code).toBe(1608);
  });

  // ----------------------------------------------------------------------
  // 10. Project teardown deletes all retained deployments' container apps
  // ----------------------------------------------------------------------
  it('project teardown deletes per-deploy container apps for ALL retained deployments via deterministic-name orphan recovery', async () => {
    // Solo plan: retainedDeployments=5 — both v1 and v2 stay retained.
    const user = await createTestUser(env.db, 'sb-td-user', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'sb-teardown');
    const cf = mockCfApi();

    // Deploy v1.
    const res1 = await deploy(project.id, user.jwt);
    expect(res1.status).toBe(200);
    const done1 = getDoneEvent(await readAllEvents(res1));
    expect(done1).toBeDefined();
    const v1Id = done1!.deployment;
    const v1ContainerName = `${project.id}-${v1Id}-void-sandbox`.toLowerCase().replaceAll('_', '-');

    // Deploy v2.
    const res2 = await deploy(project.id, user.jwt);
    expect(res2.status).toBe(200);
    const done2 = getDoneEvent(await readAllEvents(res2));
    expect(done2).toBeDefined();
    const v2Id = done2!.deployment;
    const v2ContainerName = `${project.id}-${v2Id}-void-sandbox`.toLowerCase().replaceAll('_', '-');

    // Both retention-keepable container apps exist before teardown.
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(true);
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v2ContainerName),
    ).toBe(true);

    // Tear down the project.
    const delRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(delRes.status).toBe(200);

    // Both per-deploy container apps are gone.
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v1ContainerName),
    ).toBe(false);
    expect(
      Array.from(cf.state.containerApps.values()).some((a) => a.name === v2ContainerName),
    ).toBe(false);

    // DB cascaded.
    const remainingResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(remainingResources).toHaveLength(0);
    const [proj] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj).toBeUndefined();
  });

  // ----------------------------------------------------------------------
  // deploy-pipeline integration — sandbox-using user worker uploads
  // include the platform queue + identity bindings, and the routing-switch
  // step writes the per-project `{userId, plan}` entry the proxy's sandbox
  // gate reads (packages/proxy/src/sandbox.ts).
  // ----------------------------------------------------------------------
  it('sandbox deploy injects USAGE_EVENTS_QUEUE + __VOID_USER_ID/__VOID_PROJECT_SLUG and a single __VOID_PROXY', async () => {
    const user = await createTestUser(env.db, 'sb-p6-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-p6');
    const cf = mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();
    const deployId = done!.deployment;

    const userWorker = cf.state.hostScripts.get(`user-${project.slug}-${deployId}`);
    expect(userWorker).toBeDefined();
    const bindings = userWorker!.bindings;

    // Queue producer for the framework's container-runtime metering path.
    const queueBindings = bindings.filter(
      (b) => b.type === 'queue' && b.name === 'USAGE_EVENTS_QUEUE',
    );
    expect(queueBindings).toHaveLength(1);
    expect(queueBindings[0].queue_name).toBe('void-usage-events');

    // `__VOID_PROXY` is injected once by `provisionBindings` (AI / revalidation
    // / sandbox gate all share the same service binding).
    const proxyBindings = bindings.filter((b) => b.type === 'service' && b.name === '__VOID_PROXY');
    expect(proxyBindings).toHaveLength(1);

    // Identity plain-text bindings the framework's sandbox runtime reads
    // before publishing to USAGE_EVENTS_QUEUE. Project id is sourced from
    // the shared `__PROJECT_ID` slot injected by `provisionBindings`.
    const userIdBinding = bindings.find((b) => b.name === '__VOID_USER_ID');
    expect(userIdBinding).toBeDefined();
    expect(userIdBinding!.type).toBe('plain_text');
    expect((userIdBinding as { text?: string }).text).toBe(user.id);

    const projectIdBinding = bindings.find((b) => b.name === '__PROJECT_ID');
    expect(projectIdBinding).toBeDefined();
    expect(projectIdBinding!.type).toBe('plain_text');
    expect((projectIdBinding as { text?: string }).text).toBe(project.id);

    const slugBinding = bindings.find((b) => b.name === '__VOID_PROJECT_SLUG');
    expect(slugBinding).toBeDefined();
    expect(slugBinding!.type).toBe('plain_text');
    expect((slugBinding as { text?: string }).text).toBe(project.slug);
  });

  it('sandbox deploy writes `project:{projectId}` routing entry with { userId, plan } shape', async () => {
    const user = await createTestUser(env.db, 'sb-p6-kv-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-p6-kv');
    mockCfApi();

    const res = await deploy(project.id, user.jwt);
    expect(res.status).toBe(200);
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();

    const raw = await env.ROUTING.get(`project:${project.id}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ userId: user.id, plan: 'pro' });
  });

  it('non-sandbox WfP deploy still writes `project:{projectId}` (entry tracks user plan, not sandbox usage)', async () => {
    const user = await createTestUser(env.db, 'sb-p6-nosb-user', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'sb-p6-nosb');
    mockCfApi();

    const workerSource = "export default { fetch() { return new Response('ok'); } }";
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
          assetManifest: {},
          source: null,
          commit: null,
          repositoryUrl: null,
          commitUrl: null,
          gitRef: null,
          preflight: null,
          workerFiles: {
            'index.js': bytesToBase64(new TextEncoder().encode(workerSource)),
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Drain the NDJSON stream so the deploy pipeline runs to completion
    // (routing-switch + DB finalize). Without this the assertion below races
    // the pipeline and reads KV before `ROUTING.put` ever fires.
    const done = getDoneEvent(await readAllEvents(res));
    expect(done).toBeDefined();

    const raw = await env.ROUTING.get(`project:${project.id}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ userId: user.id, plan: 'solo' });
  });

  it('rejects manifest.sandbox for static/spa deployments at validation time', async () => {
    const user = await createTestUser(env.db, 'sb-p6-static-user', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'sb-p6-static');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            type: 'static',
            sandbox: {
              bindingName: 'SANDBOX',
              className: 'Sandbox',
              containerName: 'void-sandbox',
              image: SANDBOX_IMAGE_V1,
            },
          },
          assetManifest: {},
          source: null,
          commit: null,
          repositoryUrl: null,
          commitUrl: null,
          gitRef: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { event: string; message: string };
    expect(body.event).toBe('error');
    expect(body.message).toContain('sandbox is not supported for static/spa deployments');
  });
});
