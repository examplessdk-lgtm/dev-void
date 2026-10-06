import { eq, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  createDeployment,
  deleteUser,
  markDeploymentRetained,
  setActiveDeployment,
  updateDeploymentStatus,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../../src/naming.ts';
import { reconcileProjectCleanupJobs } from '../../src/provisioning/cleanup.ts';
import {
  advanceProxyTokenRotation,
  PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS,
  PROXY_TOKEN_ROTATION_WAIT_MS,
  proxyTokenRotationStuckWarning,
  proxyTokenRotationTarget,
  proxyTokenRotationWarnings,
  reconcileProxyTokenRotations,
  requestBulkProxyTokenRotations,
  requestProxyTokenRotation,
  requestRotationIfReplacingUntrustedCode,
  type ProjectRotationOutcome,
  type ProxyTokenRotationEnv,
  type ProxyTokenRotationReason,
} from '../../src/proxy-token-rotation.ts';
import {
  deriveProxyInternalAuth,
  deriveProxyToken,
  PROXY_INTERNAL_AUTH_HEADER,
  proxyTokenStateKey,
  type ProxyInternalRoute,
} from '../../src/proxy-token.ts';
import {
  deployments,
  projectCleanupJobs,
  projectMembers,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
import {
  captureQueries,
  capturedQueryCount,
  cfError,
  cfSuccess,
  clearTables,
  createCronSchedulerMock,
  createTestDeployment,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  MemoryKVNamespace,
  mockCfApi,
  readAllEvents,
  setupEnv,
  teardownEnv,
  type CfApiMocks,
  type MockCfApiHandle,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

const MANIFEST = {
  version: 3,
  bindings: {},
  schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
  queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
};

/** Ordered log of Cloudflare calls (`GET <script>` / `PATCH <script>`) and KV puts. */
let events: Array<string>;
let routing: MemoryKVNamespace;
let cron: ReturnType<typeof createCronSchedulerMock>;
let testEnv: TestEnv & ProxyTokenRotationEnv;
/** Per-test interception points. */
let hooks: {
  fetch?: (method: string, script: string) => Response | Promise<Response | undefined> | undefined;
  kvPut?: (key: string) => void | Promise<void>;
};
let patches: Array<{ script: string; bindings: Array<Record<string, string>> }>;

beforeEach(async () => {
  await clearTables(env.db);
  events = [];
  patches = [];
  hooks = {};
  routing = new MemoryKVNamespace();
  const put = routing.put.bind(routing);
  routing.put = async (key, value, options) => {
    events.push(`kv ${key}`);
    await hooks.kvPut?.(key);
    return put(key, value, options);
  };
  cron = createCronSchedulerMock();
  testEnv = {
    ...env,
    ROUTING: routing as unknown as KVNamespace,
    CRON_SCHEDULER: cron.namespace,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const scriptNameOf = (url: string): string =>
  decodeURIComponent(/\/scripts\/([^/?#]+)/.exec(url)?.[1] ?? '');

/**
 * Stateful Cloudflare mock: script bindings come from the seeded scripts (a
 * missing script is a 404) and settings PATCHes apply `inherit`. Every call to
 * a dispatch script is logged in `events`.
 */
function cfApi(overrides: Partial<CfApiMocks> = {}): MockCfApiHandle {
  const handle: MockCfApiHandle = mockCfApi({
    listWorkerBindings: (url) => {
      const script = handle.state.hostScripts.get(scriptNameOf(url));
      return script
        ? cfSuccess(script.bindings)
        : cfError('workers.api.error.script_not_found', 404, 10007);
    },
    ...overrides,
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (url.includes('/workers/dispatch/') && /\/(bindings|settings)$/.test(url)) {
      const script = scriptNameOf(url);
      events.push(`${method} ${script}`);
      if (method === 'PATCH' && init?.body instanceof FormData) {
        const part = init.body.get('settings') as Blob;
        const body = JSON.parse(await part.text()) as {
          bindings: Array<Record<string, string>>;
        };
        patches.push({ script, bindings: body.bindings });
      }
      const hooked = await hooks.fetch?.(method, script);
      if (hooked) {
        return hooked;
      }
    }
    return (handle as unknown as typeof fetch)(input, init);
  });
  return handle;
}

function workerBindings(token: string): Array<Record<string, unknown>> {
  return [
    { type: 'd1', name: 'DB', id: 'd1-database-id' },
    { type: 'service', name: '__VOID_PROXY', service: 'void-proxy' },
    { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: token },
    { type: 'secret_text', name: 'API_KEY' },
  ];
}

const tok = (projectId: string, gen: number) => deriveProxyToken(JWT_SECRET, projectId, gen);

type Fixture = {
  projectId: string;
  slug: string;
  ownerId: string;
  ownerJwt: string;
  active: string;
  retained: Array<string>;
  worker: (deploymentId: string) => string;
  queueKey: string;
  legacy: string;
};

async function addDeployment(
  projectId: string,
  options: Readonly<{ manifest?: object | null; retained?: boolean; active?: boolean }> = {},
): Promise<string> {
  const deployment = await createDeployment(
    env.db,
    projectId,
    JSON.stringify(options.manifest === undefined ? MANIFEST : (options.manifest ?? {})),
  );
  // Rows created in the same clock tick would be walked in id order; keep
  // creation order instead so tests can name the Nth Worker.
  await env.db.execute(sql`UPDATE deployments SET created_at = (
      SELECT max(created_at) + interval '1 millisecond' FROM deployments
      WHERE project_id = ${projectId}
    ) WHERE id = ${deployment.id}`);
  await updateDeploymentStatus(env.db, deployment.id, 'live');
  if (options.retained ?? true) {
    await markDeploymentRetained(env.db, deployment.id, true);
  }
  if (options.active) {
    await setActiveDeployment(env.db, projectId, deployment.id);
  }
  return deployment.id;
}

/**
 * A project with `retained` retained Workers, optionally a retained static
 * row with no script, and an active Worker (created last) with a queue and a
 * cron schedule. Every script holds the legacy token.
 */
async function setupProject(
  cf: MockCfApiHandle,
  options: Readonly<{
    retained?: number;
    staticRetained?: boolean;
    manifest?: object | null;
    type?: 'void' | 'static';
    activeScript?: boolean;
  }> = {},
): Promise<Fixture> {
  const owner = await createTestUser(env.db);
  const { id: projectId, slug } = await createTestProject(env.db, owner.id);
  if (options.type) {
    await env.db.update(projects).set({ type: options.type }).where(eq(projects.id, projectId));
  }
  const legacy = await tok(projectId, 0);
  const worker = (deploymentId: string) => getProjectDeploymentWorkerName(slug, deploymentId);
  const retained: Array<string> = [];
  for (let index = 0; index < (options.retained ?? 2); index++) {
    const id = await addDeployment(projectId, { manifest: options.manifest });
    cf.seedHostScript({ scriptName: worker(id), bindings: workerBindings(legacy) });
    retained.push(id);
  }
  if (options.staticRetained) {
    retained.push(await addDeployment(projectId, { manifest: { version: 3, type: 'static' } }));
  }
  const active = await addDeployment(projectId, { manifest: options.manifest, active: true });
  if (options.activeScript ?? true) {
    cf.seedHostScript({ scriptName: worker(active), bindings: workerBindings(legacy) });
  }
  const queueKey = `queue:${getProjectQueueName(projectId, 'emails')}`;
  await routing.put(
    queueKey,
    JSON.stringify({
      workerName: worker(active),
      projectId,
      queueName: 'emails',
      proxyToken: legacy,
    }),
  );
  cron.states.set(projectId, {
    workerName: worker(active),
    schedules: [{ name: 'crons/tick.ts', cron: '*/5 * * * *' }],
    proxyToken: legacy,
  });
  events.length = 0;
  return {
    projectId,
    slug,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    active,
    retained,
    worker,
    queueKey,
    legacy,
  };
}

const freshBudget = () => ({ cfCallsRemaining: 1000, deadline: Date.now() + 60_000 });

function advance(
  projectId: string,
  options: Readonly<{
    waitMs?: number;
    budget?: { cfCallsRemaining: number; deadline: number };
  }> = {},
): Promise<ProjectRotationOutcome> {
  return advanceProxyTokenRotation(env.db, testEnv, projectId, options.budget ?? freshBudget(), {
    waitMs: options.waitMs ?? 0,
  });
}

function request(
  projectId: string,
  mode: 'member' | 'operator' = 'operator',
  reason: ProxyTokenRotationReason = mode === 'member' ? 'member-removed' : 'operator',
): Promise<void> {
  return requestProxyTokenRotation(env.db, projectId, reason, mode);
}

async function job(projectId: string) {
  const [row] = await env.db
    .select()
    .from(projectCleanupJobs)
    .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
  return row;
}

async function issued(projectId: string): Promise<number> {
  const [row] = await env.db
    .select({ gen: projects.proxy_token_gen })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row!.gen;
}

async function floor(projectId: string): Promise<unknown> {
  return routing.get(proxyTokenStateKey(projectId), 'json');
}

/** Moves the stored waits back by `seconds` and makes the job due. */
async function shiftBack(projectId: string, seconds = 3600): Promise<void> {
  const shifted = (field: string) => sql`CASE WHEN payload->>${field} IS NOT NULL
    THEN jsonb_build_object(${field}::text, to_char(((payload->>${field})::timestamptz
      - ${seconds}::integer * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    ELSE '{}'::jsonb END`;
  await env.db.execute(sql`UPDATE project_cleanup_jobs
    SET next_attempt_at = now(),
      payload = payload || ${shifted('waitUntil')} || ${shifted('lastPatchAt')}
    WHERE target = ${proxyTokenRotationTarget(projectId)}`);
}

async function kick(projectId: string): Promise<void> {
  await env.db
    .update(projectCleanupJobs)
    .set({ next_attempt_at: sql`now()` })
    .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
}

/** One more step past the current wait, with real waits. */
async function step(projectId: string): Promise<ProjectRotationOutcome> {
  await shiftBack(projectId);
  return advance(projectId, { waitMs: 60_000 });
}

function scriptToken(cf: MockCfApiHandle, script: string): unknown {
  return cf.state.hostScripts.get(script)?.bindings.find((b) => b.name === '__VOID_PROXY_TOKEN')
    ?.text;
}

const patchedScripts = () =>
  events.filter((event) => event.startsWith('PATCH ')).map((event) => event.slice(6));

describe('proxy token rotation', () => {
  it('moves every Worker to the next generation before raising the floor', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { staticRetained: true });
    const token = await tok(fx.projectId, 1);
    const before = new Map(
      [...cf.state.hostScripts].map(([name, script]) => [name, structuredClone(script.bindings)]),
    );

    await request(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });

    expect(await issued(fx.projectId)).toBe(1);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    const floorAt = events.indexOf(`kv ${proxyTokenStateKey(fx.projectId)}`);
    const lastPatchAt = events.map((event) => event.startsWith('PATCH ')).lastIndexOf(true);
    expect(floorAt).toBeGreaterThan(lastPatchAt);

    const workers = [...fx.retained.slice(0, 2), fx.active].map(fx.worker);
    expect(patchedScripts()).toEqual(workers);
    // The static row has no script: one GET, no PATCH.
    expect(events).toContain(`GET ${fx.worker(fx.retained[2]!)}`);
    for (const patch of patches) {
      expect(patch.bindings).toEqual([
        { type: 'inherit', name: 'DB' },
        { type: 'inherit', name: '__VOID_PROXY' },
        { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: token },
        { type: 'inherit', name: 'API_KEY' },
      ]);
    }
    for (const worker of workers) {
      const stored = cf.state.hostScripts.get(worker)!.bindings;
      expect(stored.map((binding) => [binding.name, binding.type])).toEqual(
        before.get(worker)!.map((binding) => [binding.name, binding.type]),
      );
      expect(scriptToken(cf, worker)).toBe(token);
    }

    expect(cron.states.get(fx.projectId)).toEqual({
      workerName: fx.worker(fx.active),
      schedules: [{ name: 'crons/tick.ts', cron: '*/5 * * * *' }],
      proxyToken: token,
    });
    expect(await routing.get(fx.queueKey, 'json')).toEqual({
      workerName: fx.worker(fx.active),
      projectId: fx.projectId,
      queueName: 'emails',
      proxyToken: token,
    });
    expect(await job(fx.projectId)).toBeUndefined();
  });

  it('turns old tokens off on the proxy metadata routes', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db.insert(resources).values({
      id: 'res_rotation_db',
      project_id: fx.projectId,
      type: 'd1',
      cf_id: 'd1-database-id',
      binding_name: 'DB',
    });
    const routes: Array<[ProxyInternalRoute, unknown]> = [
      ['resolve-worker', {}],
      ['resolve-resource', { type: 'd1', binding: 'DB' }],
      ['verify-prerender-build', { userId: fx.ownerId }],
    ];
    const statuses = async (
      headers: (route: ProxyInternalRoute) => Promise<Record<string, string>>,
    ) =>
      Promise.all(
        routes.map(async ([route, body]) => {
          const response = await app.fetch(
            new Request(`http://localhost/internal/${route}/${fx.projectId}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(await headers(route)) },
              body: JSON.stringify(body),
            }),
            testEnv,
          );
          return response.status;
        }),
      );
    const legacy = async () => ({
      'x-void-internal': await hmacSignState(fx.projectId, JWT_SECRET),
    });
    const tenant = (gen: number) => async () => ({
      'x-void-internal': await tok(fx.projectId, gen),
    });
    const proxy = async (route: ProxyInternalRoute) => ({
      [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(JWT_SECRET, route, fx.projectId),
    });

    expect(await statuses(legacy)).toEqual([200, 200, 200]);

    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    // A member loses access after START: one more generation follows.
    await request(fx.projectId, 'member');
    expect((await job(fx.projectId))!.payload.again).toBe('1');
    await step(fx.projectId);
    await step(fx.projectId);
    expect((await job(fx.projectId))!.payload.phase).toBe('settle');
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });

    expect(await statuses(legacy)).toEqual([403, 403, 403]);
    expect(await statuses(proxy)).toEqual([200, 200, 200]);

    for (let index = 0; index < 4 && (await job(fx.projectId)); index++) {
      await step(fx.projectId);
    }
    expect(await job(fx.projectId)).toBeUndefined();
    expect(await issued(fx.projectId)).toBe(2);
    expect(await statuses(tenant(1))).toEqual([403, 403, 403]);
    expect(await statuses(tenant(2))).toEqual([200, 200, 200]);
    expect(await statuses(proxy)).toEqual([200, 200, 200]);
  });

  it('keeps both tokens on the queue entry and cron scheduler until the floor rises', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const token = await tok(fx.projectId, 1);
    const copies = async () => ({
      queue: (await routing.get(fx.queueKey, 'json')) as Record<string, unknown>,
      cron: cron.states.get(fx.projectId) as Record<string, unknown>,
    });
    const tokens = (proxyToken: string, proxyTokenFallback?: string) => {
      const fields = { proxyToken, ...(proxyTokenFallback ? { proxyTokenFallback } : {}) };
      return {
        queue: {
          workerName: fx.worker(fx.active),
          projectId: fx.projectId,
          queueName: 'emails',
          ...fields,
        },
        cron: {
          workerName: fx.worker(fx.active),
          schedules: [{ name: 'crons/tick.ts', cron: '*/5 * * * *' }],
          ...fields,
        },
      };
    };
    let atStart: Awaited<ReturnType<typeof copies>> | undefined;
    hooks.fetch = async () => {
      atStart ??= structuredClone(await copies());
      return undefined;
    };

    await request(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'patch',
      reason: 'waiting',
    });
    // Nothing outside Postgres changed before COPIES made its first call.
    expect(atStart).toEqual(tokens(fx.legacy));
    expect(await copies()).toEqual(tokens(fx.legacy, token));

    await step(fx.projectId);
    expect(scriptToken(cf, fx.worker(fx.active))).toBe(token);
    expect(await copies()).toEqual(tokens(token, fx.legacy));

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    expect(await copies()).toEqual(tokens(token));
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
  });

  it('honors waits even when the job is kicked', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    const first = await advance(fx.projectId, { waitMs: 60_000 });
    expect(first).toMatchObject({ status: 'pending', phase: 'patch', reason: 'waiting' });
    expect(first.status === 'pending' && first.retryAfterSeconds).toBeGreaterThan(50);
    expect(patchedScripts()).toEqual([]);

    await kick(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      reason: 'waiting',
    });
    expect(patchedScripts()).toEqual([]);

    await step(fx.projectId);
    expect(patchedScripts()).toHaveLength(3);
  });

  it('commits the new generation before writing any copy', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    hooks.kvPut = (key) => {
      if (key === fx.queueKey) {
        throw new Error('queue routing write failed');
      }
    };
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'copies' });
    expect(await issued(fx.projectId)).toBe(1);
    expect((await job(fx.projectId))!.payload.phase).toBe('copies');
    expect(cron.states.get(fx.projectId)!.proxyTokenFallback).toBe(await tok(fx.projectId, 1));

    await request(fx.projectId, 'member');
    expect((await job(fx.projectId))!.payload.again).toBe('1');
    hooks.kvPut = undefined;
    await kick(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 2 });
    const token = await tok(fx.projectId, 2);
    for (const id of [...fx.retained, fx.active]) {
      expect(scriptToken(cf, fx.worker(id))).toBe(token);
    }
  });

  it('makes no outside call when START does not commit', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const cronCalls = cron.calls.length;
    await env.db.execute(sql`CREATE FUNCTION fail_rotation_start() RETURNS trigger AS $$
      BEGIN
        IF NEW.payload->>'phase' = 'copies' THEN RAISE EXCEPTION 'injected start failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await env.db
      .execute(sql`CREATE TRIGGER fail_rotation_start BEFORE UPDATE ON project_cleanup_jobs
      FOR EACH ROW EXECUTE FUNCTION fail_rotation_start()`);
    try {
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'requested' });
    } finally {
      await env.db.execute(sql`DROP TRIGGER fail_rotation_start ON project_cleanup_jobs`);
      await env.db.execute(sql`DROP FUNCTION fail_rotation_start()`);
    }
    expect(await issued(fx.projectId)).toBe(0);
    expect(events).toEqual([]);
    expect(cf.mock.calls).toHaveLength(0);
    expect(cron.calls.length).toBe(cronCalls);
    expect((await job(fx.projectId))!.attempts).toBe(1);
  });

  it('starts the wait after the floor write, not at the start of the step', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    let putDoneAt = 0;
    hooks.kvPut = async (key) => {
      if (key === proxyTokenStateKey(fx.projectId)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        putDoneAt = Date.now();
      }
    };
    const run = async () => {
      await shiftBack(fx.projectId);
      return advance(fx.projectId, { waitMs: PROXY_TOKEN_ROTATION_WAIT_MS });
    };
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: PROXY_TOKEN_ROTATION_WAIT_MS });
    await run();
    await run();
    const payload = (await job(fx.projectId))!.payload;
    expect(payload.phase).toBe('settle');
    expect(putDoneAt).toBeGreaterThan(0);
    expect(Date.parse(payload.waitUntil!)).toBeGreaterThanOrEqual(
      putDoneAt + PROXY_TOKEN_ROTATION_WAIT_MS,
    );
  });

  it('does not restart the wait for a deploy that already holds the new token', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    await step(fx.projectId);
    expect((await job(fx.projectId))!.payload.phase).toBe('revoke');

    // A deploy admitted after START bakes tok(1) and becomes active.
    const deployed = await addDeployment(fx.projectId, { active: true });
    cf.seedHostScript({
      scriptName: fx.worker(deployed),
      bindings: workerBindings(await tok(fx.projectId, 1)),
    });
    events.length = 0;
    // The original wait has passed; the walk must not start a new one.
    await shiftBack(fx.projectId, 61);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'settle',
    });
    expect(events).toContain(`GET ${fx.worker(deployed)}`);
    expect(patchedScripts()).toEqual([]);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('patches a Worker created after the walk passed before raising the floor', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const token = await tok(fx.projectId, 1);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    await step(fx.projectId);
    expect((await job(fx.projectId))!.payload.phase).toBe('revoke');

    // The active Worker already holds the new token; only the later row does not.
    const later = await addDeployment(fx.projectId);
    cf.seedHostScript({ scriptName: fx.worker(later), bindings: workerBindings(fx.legacy) });
    events.length = 0;
    expect(await step(fx.projectId)).toMatchObject({ status: 'pending', phase: 'revoke' });
    expect(patchedScripts()).toEqual([fx.worker(later)]);
    expect(scriptToken(cf, fx.worker(later))).toBe(token);
    expect(await floor(fx.projectId)).toBeNull();

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    expect(events.indexOf(`kv ${proxyTokenStateKey(fx.projectId)}`)).toBeGreaterThan(
      events.indexOf(`PATCH ${fx.worker(later)}`),
    );
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
  });

  it('never raises the floor while a Worker is unpatched', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let patchCount = 0;
    hooks.fetch = (method) =>
      method === 'PATCH' && ++patchCount === 2 ? cfError('internal error', 500) : undefined;

    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({
      status: 'failed',
      phase: 'patch',
      workerName: fx.worker(fx.retained[1]!),
    });
    const failed = (await job(fx.projectId))!;
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toContain('internal error');
    expect(await floor(fx.projectId)).toBeNull();
    const token = await tok(fx.projectId, 1);
    expect(await routing.get(fx.queueKey, 'json')).toMatchObject({
      proxyToken: fx.legacy,
      proxyTokenFallback: token,
    });
    expect(cron.states.get(fx.projectId)).toMatchObject({
      proxyToken: fx.legacy,
      proxyTokenFallback: token,
    });

    const log = errors.mock.calls
      .map((call) => call.join(' '))
      .find((line) => line.includes('FAILED'));
    expect(log).toContain(`[proxy-token-rotation] FAILED ${fx.projectId} phase=patch attempts=1`);
    expect(log).not.toContain(fx.legacy);
    expect(log).not.toContain(token);

    hooks.fetch = undefined;
    events.length = 0;
    await kick(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(patchedScripts()).toEqual([fx.worker(fx.retained[1]!), fx.worker(fx.active)]);
    expect((await job(fx.projectId)) ?? null).toBeNull();
  });

  it('lets a second runner continue from the phase the first one left', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    expect(
      await advance(fx.projectId, {
        budget: { cfCallsRemaining: 0, deadline: Date.now() + 60_000 },
      }),
    ).toMatchObject({ status: 'pending', phase: 'copies', reason: 'budget' });
    expect(await issued(fx.projectId)).toBe(1);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(await issued(fx.projectId)).toBe(1);
  });

  it('patches a retained Worker a rollback made active during the rotation', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db.insert(resources).values({
      id: 'res_rotation_queue',
      project_id: fx.projectId,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });
    const token = await tok(fx.projectId, 1);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });

    const target = fx.retained[0]!;
    const response = await app.fetch(
      new Request(`http://localhost/projects/${fx.projectId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fx.ownerJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: target }),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(await routing.get(fx.queueKey, 'json')).toMatchObject({
      workerName: fx.worker(target),
      proxyToken: fx.legacy,
      proxyTokenFallback: token,
    });

    await step(fx.projectId);
    expect(scriptToken(cf, fx.worker(target))).toBe(token);
    expect(await routing.get(fx.queueKey, 'json')).toMatchObject({
      workerName: fx.worker(target),
      proxyToken: token,
      proxyTokenFallback: fx.legacy,
    });
    await step(fx.projectId);
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('walks the Workers again when the active Worker still has the old token at REVOKE', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const active = fx.worker(fx.active);
    let activeGets = 0;
    hooks.fetch = (method, script) => {
      if (method === 'GET' && script === active && ++activeGets === 3) {
        return cfSuccess(workerBindings(fx.legacy));
      }
      return undefined;
    };
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    // COPIES, PATCH, REVOKE (old token reported), re-walk GET, REVOKE again.
    expect(activeGets).toBe(5);
    expect(events.filter((event) => event === `GET ${fx.worker(fx.retained[0]!)}`)).toHaveLength(2);
  });

  it('waits while a deployment is in flight', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await createDeployment(env.db, fx.projectId, JSON.stringify(MANIFEST));
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({
      status: 'pending',
      phase: 'requested',
      reason: 'busy',
      retryAfterSeconds: 120,
    });
    expect(events).toEqual([]);
    expect(cf.mock.calls).toHaveLength(0);
    expect(await issued(fx.projectId)).toBe(0);
    expect((await job(fx.projectId))!.attempts).toBe(0);
  });

  it('fails until a project with an unrecorded active deployment is normalized', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, fx.projectId));
    await request(fx.projectId);
    const outcome = await advance(fx.projectId);
    expect(outcome).toMatchObject({ status: 'failed', phase: 'requested' });
    expect(outcome.status === 'failed' && outcome.error).toContain(
      'void platform project normalize',
    );
    expect(await issued(fx.projectId)).toBe(0);
  });

  describe('Workers that cannot or need not be patched', () => {
    it('skips a retained Worker without a proxy token binding', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      cf.state.hostScripts.get(fx.worker(fx.retained[0]!))!.bindings = [
        { type: 'd1', name: 'DB', id: 'd1-database-id' },
      ];
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
      expect(patchedScripts()).toEqual([fx.worker(fx.retained[1]!), fx.worker(fx.active)]);
    });

    it('fails when the active Worker of a Worker project has no script', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf, { activeScript: false });
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({
        status: 'failed',
        phase: 'patch',
        workerName: fx.worker(fx.active),
      });
      expect(await floor(fx.projectId)).toBeNull();
    });

    it('fails on a proxy token binding that is not plain text', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      cf.state.hostScripts.get(fx.worker(fx.retained[0]!))!.bindings = [
        { type: 'secret_text', name: '__VOID_PROXY_TOKEN' },
      ];
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
      expect(patchedScripts()).toEqual([]);
    });

    it('fails without a re-walk when the active script disappears before REVOKE', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      await request(fx.projectId);
      await advance(fx.projectId, { waitMs: 60_000 });
      await step(fx.projectId);
      cf.state.hostScripts.delete(fx.worker(fx.active));
      events.length = 0;
      expect(await step(fx.projectId)).toMatchObject({
        status: 'failed',
        phase: 'revoke',
        workerName: fx.worker(fx.active),
      });
      expect(events).toEqual([`GET ${fx.worker(fx.active)}`]);
      expect((await job(fx.projectId))!.attempts).toBe(1);
      expect((await job(fx.projectId))!.payload.phase).toBe('revoke');
      expect(await floor(fx.projectId)).toBeNull();
    });

    it('finishes a static project whose deployments have no script', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf, {
        type: 'static',
        retained: 0,
        activeScript: false,
        manifest: { version: 3, type: 'static' },
      });
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
      expect(events.filter((event) => event.startsWith('GET '))).toEqual([
        `GET ${fx.worker(fx.active)}`,
        `GET ${fx.worker(fx.active)}`,
      ]);
      expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    });

    it('patches Worker rows whose manifest looks static', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf, { retained: 1, manifest: null });
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
      expect(patchedScripts()).toEqual([fx.worker(fx.retained[0]!), fx.worker(fx.active)]);
      expect(events.filter((event) => event === `GET ${fx.worker(fx.active)}`)).toHaveLength(2);
    });
  });

  it('patches again when a PATCH did not take', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 0 });
    let first = true;
    hooks.fetch = (method, script) => {
      if (method === 'PATCH' && first) {
        first = false;
        return cfSuccess({ bindings: cf.state.hostScripts.get(script)!.bindings });
      }
      return undefined;
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
    await kick(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(patchedScripts()).toEqual([fx.worker(fx.active), fx.worker(fx.active)]);
  });

  it('stops the tick on a rate limit without counting a failure', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const other = await setupProject(cf);
    hooks.fetch = (method) =>
      method === 'PATCH'
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })
        : undefined;
    await request(fx.projectId);
    await request(other.projectId);

    expect(await reconcileProxyTokenRotations(env.db, testEnv, { waitMs: 0 })).toEqual({
      done: 0,
      pending: 1,
      failed: 0,
      retryAfterSeconds: 120,
    });
    const limited = (await job(fx.projectId))!;
    expect(limited.attempts).toBe(0);
    expect(limited.payload.cursor).toBe('');
    const [due] = await env.db
      .execute<{ inWindow: boolean }>(
        sql`SELECT next_attempt_at BETWEEN now() + interval '100 seconds' AND now() + interval '140 seconds' AS "inWindow"
        FROM project_cleanup_jobs WHERE target = ${proxyTokenRotationTarget(fx.projectId)}`,
      )
      .then((result) => result.rows);
    expect(due!.inWindow).toBe(true);
    // The step's transaction rolled back: the project row is free.
    await env.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${fx.projectId} FOR UPDATE NOWAIT`);
    });
    expect((await job(other.projectId))!.payload.phase).toBe('requested');
  });

  it('cuts a run at the Cloudflare call budget without counting a failure', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 12 });
    await request(fx.projectId);
    let runs = 0;
    for (; runs < 10 && (await job(fx.projectId)); runs++) {
      const before = patchedScripts().length;
      const summary = await reconcileProxyTokenRotations(env.db, testEnv, {
        maxCfCalls: 7,
        waitMs: 0,
      });
      expect(patchedScripts().length - before).toBeLessThanOrEqual(3);
      const row = await job(fx.projectId);
      if (!row) {
        expect(summary).toMatchObject({ done: 1, pending: 0 });
        break;
      }
      expect(summary).toMatchObject({ done: 0, pending: 1, failed: 0 });
      expect(row.attempts).toBe(0);
      expect(await floor(fx.projectId)).toBeNull();
      const [due] = (
        await env.db.execute<{ due: boolean }>(
          sql`SELECT next_attempt_at <= now() AS due FROM project_cleanup_jobs
            WHERE target = ${proxyTokenRotationTarget(fx.projectId)}`,
        )
      ).rows;
      expect(due!.due).toBe(true);
    }
    expect(patchedScripts()).toHaveLength(13);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('runs one more generation for a request after START, not before', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId, 'member');
    await request(fx.projectId, 'member');
    expect((await job(fx.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'member-removed',
    });

    await advance(fx.projectId, { waitMs: 60_000 });
    await request(fx.projectId, 'member', 'member-role-changed');
    expect((await job(fx.projectId))!.payload.again).toBe('1');
    await shiftBack(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 2 });
    const token = await tok(fx.projectId, 2);
    for (const id of [...fx.retained, fx.active]) {
      expect(scriptToken(cf, fx.worker(id))).toBe(token);
    }
    expect(await floor(fx.projectId)).toEqual({ gen: 2 });
  });

  it('drops the job when the project is being deleted', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, fx.projectId));
    events.length = 0;
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(await job(fx.projectId)).toBeUndefined();
    expect(events).toEqual([]);
    expect(await floor(fx.projectId)).toBeNull();
  });

  it('raises the floor of a project without deployments', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    await request(project.id);
    expect(await advance(project.id)).toEqual({ status: 'done', gen: 1 });
    expect(await floor(project.id)).toEqual({ gen: 1 });
  });

  it('queues bulk requests by scope', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const legacy = await createTestProject(env.db, owner.id);
    const rotated = await createTestProject(env.db, owner.id);
    await env.db.update(projects).set({ proxy_token_gen: 1 }).where(eq(projects.id, rotated.id));

    expect(await requestBulkProxyTokenRotations(env.db, 'legacy')).toBe(1);
    expect(await requestBulkProxyTokenRotations(env.db, 'legacy')).toBe(0);
    expect(await job(rotated.id)).toBeUndefined();

    await advance(legacy.id, { waitMs: 60_000 });
    expect(await requestBulkProxyTokenRotations(env.db, 'all')).toBe(2);
    expect((await job(legacy.id))!.payload.again).toBe('1');
    expect((await job(rotated.id))!.payload).toEqual({
      phase: 'requested',
      reason: 'operator-bulk',
    });
  });

  it('is never claimed by the generic cleanup runner', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    await request(project.id);
    await reconcileProjectCleanupJobs(env.db, testEnv as never);
    expect(await job(project.id)).toMatchObject({
      attempts: 0,
      payload: { phase: 'requested', reason: 'operator' },
    });
  });

  it('locks the project row before each step that calls Cloudflare', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    let queriesBeforeFirstCall: number | undefined;
    hooks.fetch = () => {
      queriesBeforeFirstCall ??= capturedQueryCount(env.db);
      return undefined;
    };
    await request(fx.projectId);
    const { result, queries } = await captureQueries(env.db, () => advance(fx.projectId));
    expect(result).toEqual({ status: 'done', gen: 1 });
    const projectLock = (query: string) => /from "projects".* for update/i.test(query);
    expect(queries.slice(0, queriesBeforeFirstCall).some(projectLock)).toBe(true);
    // START, COPIES, one per Worker, walk end, REVOKE.
    expect(queries.filter(projectLock).length).toBeGreaterThanOrEqual(3 + 4);
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'keeps a secret written during a PATCH step (lost secret race)',
    async () => {
      const cf = cfApi({
        setWorkerSecret: async (url, init) => {
          const body = JSON.parse(String(init?.body)) as { name: string };
          events.push(`secret ${body.name}`);
          cf.state.hostScripts.get(scriptNameOf(url))!.bindings.push({
            type: 'secret_text',
            name: body.name,
          });
          return cfSuccess({});
        },
      });
      const fx = await setupProject(cf, { retained: 0 });
      await request(fx.projectId);
      await advance(fx.projectId, { waitMs: 60_000 });
      await shiftBack(fx.projectId);
      let secretWrite: Promise<Response> | undefined;
      // Give the secret write time to land inside the step; the project lock
      // must hold it until the step finishes.
      hooks.fetch = async (method, script) => {
        if (method === 'GET' && script === fx.worker(fx.active) && !secretWrite) {
          secretWrite = Promise.resolve(
            app.fetch(
              new Request(`http://localhost/projects/${fx.projectId}/secrets/RACE_SECRET`, {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${fx.ownerJwt}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ value: 'race-value' }),
              }),
              testEnv,
            ),
          );
          await Promise.race([secretWrite, new Promise((resolve) => setTimeout(resolve, 500))]);
        }
        return undefined;
      };
      const [first, second] = await Promise.all([
        advance(fx.projectId, { waitMs: 0 }),
        advance(fx.projectId, { waitMs: 0 }),
      ]);
      expect((await secretWrite!).status).toBe(200);
      expect([first.status, second.status]).toContain('done');
      for (let index = 0; index < 5 && (await job(fx.projectId)); index++) {
        await kick(fx.projectId);
        await advance(fx.projectId);
      }
      expect(await issued(fx.projectId)).toBe(1);
      const patchAt = events.indexOf(`PATCH ${fx.worker(fx.active)}`);
      expect(patchAt).toBeGreaterThan(-1);
      expect(events.indexOf('secret RACE_SECRET')).toBeGreaterThan(patchAt);
      const stored = cf.state.hostScripts.get(fx.worker(fx.active))!.bindings;
      expect(stored.map((binding) => binding.name)).toContain('RACE_SECRET');
      expect(scriptToken(cf, fx.worker(fx.active))).toBe(await tok(fx.projectId, 1));
    },
  );
});

describe('rotation after code from a user who lost deploy access is replaced', () => {
  type Team = Readonly<{
    projectId: string;
    owner: Awaited<ReturnType<typeof createTestUser>>;
    collaborator: Awaited<ReturnType<typeof createTestUser>>;
    worker: (deploymentId: string) => string;
  }>;

  let deployCount = 0;

  async function setupTeam(): Promise<Team> {
    const owner = await createTestUser(env.db);
    const collaborator = await createTestUser(env.db);
    // Keep earlier Workers for rollback and for the walk.
    await env.db.update(users).set({ plan: 'pro' }).where(eq(users.id, owner.id));
    const { id: projectId, slug } = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: projectId,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    return {
      projectId,
      owner,
      collaborator,
      worker: (deploymentId) => getProjectDeploymentWorkerName(slug, deploymentId),
    };
  }

  /** A Worker deploy through the API; returns the deployment id from the `done` event. */
  async function deploy(projectId: string, jwt: string): Promise<string> {
    const code = `export default { fetch() { return new Response('${++deployCount}'); } }`;
    const response = await app.fetch(
      new Request(`http://localhost/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
          assetManifest: {},
          workerFiles: { 'index.js': btoa(code) },
        }),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    const events = (await readAllEvents(response)) as Array<{
      event: string;
      deployment?: string;
      message?: string;
    }>;
    const done = events.find((event) => event.event === 'done');
    expect(done, JSON.stringify(events.at(-1))).toBeDefined();
    return done!.deployment!;
  }

  async function rollback(projectId: string, jwt: string, deploymentId: string): Promise<void> {
    const response = await app.fetch(
      new Request(`http://localhost/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId }),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
  }

  async function removeCollaborator(team: Team): Promise<void> {
    const response = await app.fetch(
      new Request(`http://localhost/projects/${team.projectId}/members/${team.collaborator.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${team.owner.jwt}` },
      }),
      testEnv,
    );
    expect(response.status).toBe(204);
  }

  /** Runs the job past every wait until it is gone. */
  async function finish(projectId: string): Promise<ProjectRotationOutcome> {
    await shiftBack(projectId);
    const outcome = await advance(projectId);
    expect(await job(projectId)).toBeUndefined();
    return outcome;
  }

  async function expectWorkersOn(
    cf: MockCfApiHandle,
    team: Team,
    deploymentIds: ReadonlyArray<string>,
    gen: number,
  ): Promise<void> {
    const token = await tok(team.projectId, gen);
    for (const id of deploymentIds) {
      expect(scriptToken(cf, team.worker(id))).toBe(token);
    }
  }

  it("rotates again when the owner replaces a removed collaborator's code", async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    expect((await job(team.projectId))!.payload.reason).toBe('member-removed');
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 1 });

    const trusted = await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'untrusted-deploy-replaced',
    });
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });
    expect(await issued(team.projectId)).toBe(2);
    await expectWorkersOn(cf, team, [untrusted, trusted], 2);

    // The code being replaced now is the owner's: nothing more to rotate.
    await deploy(team.projectId, team.owner.jwt);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it('runs one more generation when the replacement lands after START', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    await advance(team.projectId, { waitMs: 60_000 });
    expect((await job(team.projectId))!.payload.phase).toBe('patch');

    const trusted = await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.again).toBe('1');
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });
    await expectWorkersOn(cf, team, [untrusted, trusted], 2);
  });

  it('needs no extra generation when the replacement lands before START', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);

    const trusted = await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'member-removed',
    });
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 1 });
    await expectWorkersOn(cf, team, [untrusted, trusted], 1);
  });

  it('rotates when the next deploy finishes an interrupted cutover over the code', async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 1 });

    // The owner's deploy stopped after the cutover became ready.
    const interrupted = await createTestDeployment(env.db, team.projectId, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, interrupted.id));
    const marker = JSON.stringify({
      projectId: team.projectId,
      ownerId: 'interrupted-owner',
      buildId: null,
    });
    await routing.put(`cutover-intent:${interrupted.id}`, marker);
    await routing.put(`cutover-ready:${interrupted.id}`, marker);

    await deploy(team.projectId, team.owner.jwt);
    const [recovered] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, interrupted.id));
    expect(recovered!.status).toBe('live');
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'untrusted-deploy-replaced',
    });
  });

  it('rotates on a rollback away from the code, not on a rollback to it', async () => {
    cfApi();
    const team = await setupTeam();
    const trusted = await deploy(team.projectId, team.owner.jwt);
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    await finish(team.projectId);

    await rollback(team.projectId, team.owner.jwt, trusted);
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'untrusted-deploy-replaced',
    });
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });

    await rollback(team.projectId, team.owner.jwt, untrusted);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it("rotates when the code's author was changed to reader", async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    const changed = await app.fetch(
      new Request(`http://localhost/projects/${team.projectId}/members/${team.collaborator.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${team.owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader' }),
      }),
      testEnv,
    );
    expect(changed.status).toBe(200);
    await finish(team.projectId);

    await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  it("rotates when the code's author account was deleted", async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    await deleteUser(env.db, team.collaborator.id);
    expect((await job(team.projectId))!.payload.reason).toBe('user-deleted');
    await finish(team.projectId);

    await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  it('does not rotate for code with no recorded author', async () => {
    cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await env.db
      .update(deployments)
      .set({ initiated_by_user_id: null })
      .where(eq(deployments.id, untrusted));
    await removeCollaborator(team);
    await finish(team.projectId);

    await deploy(team.projectId, team.owner.jwt);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it('does not treat a suspended owner as lost deploy access', async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, team.owner.id));
    const next = await createDeployment(env.db, team.projectId, JSON.stringify(MANIFEST));

    const requested = await env.db.transaction((tx) =>
      requestRotationIfReplacingUntrustedCode(tx, team.projectId, next.id),
    );
    expect(requested).toBe(false);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it("rotates when the code's author is suspended by an admin", async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    const replace = async () => {
      const next = await createDeployment(env.db, team.projectId, JSON.stringify(MANIFEST));
      return env.db.transaction((tx) =>
        requestRotationIfReplacingUntrustedCode(tx, team.projectId, next.id),
      );
    };

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, team.collaborator.id));
    expect(await replace()).toBe(false);
    expect(await job(team.projectId)).toBeUndefined();

    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, team.collaborator.id));
    expect(await replace()).toBe(true);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  it('does not rotate when a failed deploy leaves the code in place', async () => {
    cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    await finish(team.projectId);

    hooks.kvPut = (key) => {
      if (key.startsWith('cutover-ready:')) {
        throw new Error('injected post-routing failure');
      }
    };
    const response = await app.fetch(
      new Request(`http://localhost/projects/${team.projectId}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${team.owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
          assetManifest: {},
          workerFiles: {
            'index.js': btoa("export default { fetch() { return new Response('x'); } }"),
          },
        }),
      }),
      testEnv,
    );
    const events = (await readAllEvents(response)) as Array<{ event: string }>;
    expect(events.at(-1)).toMatchObject({ event: 'error' });
    const [project] = await env.db
      .select({ active: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, team.projectId));
    expect(project!.active).toBe(untrusted);
    expect(await job(team.projectId)).toBeUndefined();
  });
});

describe('owner warning for a stuck rotation', () => {
  async function setAttempts(projectId: string, attempts: number): Promise<void> {
    await env.db
      .update(projectCleanupJobs)
      .set({ attempts })
      .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
  }

  const warnings = (
    projectId: string,
    role: 'reader' | 'collaborator' | 'admin' | 'owner' = 'owner',
    deployScoped = false,
  ) => proxyTokenRotationWarnings(env.db, projectId, role, deployScoped);

  it('warns owners and admins once a rotation has failed four times in a row', async () => {
    const owner = await createTestUser(env.db);
    const { id: projectId } = await createTestProject(env.db, owner.id);
    expect(await warnings(projectId)).toEqual([]);

    await request(projectId);
    await setAttempts(projectId, PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS - 1);
    expect(await warnings(projectId)).toEqual([]);

    await setAttempts(projectId, PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS);
    expect(await warnings(projectId)).toEqual([proxyTokenRotationStuckWarning(projectId)]);
    expect(await warnings(projectId, 'admin')).toEqual([proxyTokenRotationStuckWarning(projectId)]);
    expect(proxyTokenRotationStuckWarning(projectId)).toContain(projectId);
  });

  it('never warns readers, collaborators or deploy tokens', async () => {
    const owner = await createTestUser(env.db);
    const { id: projectId } = await createTestProject(env.db, owner.id);
    await request(projectId);
    await setAttempts(projectId, 10);
    expect(await warnings(projectId, 'reader')).toEqual([]);
    expect(await warnings(projectId, 'collaborator')).toEqual([]);
    expect(await warnings(projectId, 'owner', true)).toEqual([]);
  });

  it('shows while steps keep failing and clears after a good step', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.fetch = (method) => (method === 'PATCH' ? cfError('internal error', 500) : undefined);

    await request(fx.projectId);
    for (let run = 1; run <= PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS; run++) {
      expect(await warnings(fx.projectId)).toEqual([]);
      await kick(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
    }
    expect((await job(fx.projectId))!.attempts).toBe(PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS);
    expect(await warnings(fx.projectId)).toEqual([proxyTokenRotationStuckWarning(fx.projectId)]);

    hooks.fetch = undefined;
    await kick(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
      reason: 'waiting',
    });
    expect((await job(fx.projectId))!.attempts).toBe(0);
    expect(await warnings(fx.projectId)).toEqual([]);
  });
});
