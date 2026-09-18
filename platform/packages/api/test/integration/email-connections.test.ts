import { eq } from 'drizzle-orm';
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
import { emailUnresolvedAttempts } from '../../src/email/admission-schema.ts';
import { disableEmailDomainRouteAndDrain } from '../../src/email/admission.ts';
import {
  emailCacheOutbox,
  emailCredentials,
  emailDomainRoutes,
  emailOperationSteps,
  emailOperations,
  emailZoneConnections,
} from '../../src/email/connection-schema.ts';
import {
  ensureSharedEmailConnection,
  flushEmailCacheOutbox,
  getEmailOperation,
  reconcilePendingEmailOperations,
  requestEmailDomainAdd,
  requestEmailDomainRemove,
  requestEmailDomainSync,
  requestEmailSecretRotation,
  resolveEmailDomain,
  resolveEmailIngress,
  runEmailOperation,
} from '../../src/email/connection-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import { projects } from '../../src/schema.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

const zones = {
  'example.com': { id: 'zone-example', name: 'example.com', accountId: 'customer-account' },
};
const TOKEN = 'customer-scoped-token';
let env: TestEnv;
function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
  } as unknown as ApiEnv['Bindings'];
}

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

describe('durable zone email connections', () => {
  it('checks MX and explicit routing conflicts for new assignments on an existing zone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sibling-preflight');
    const routingRules: Array<{ enabled: boolean; addresses: Array<string> }> = [];
    const stub = stubCustomerCf({
      zones,
      routingRules,
      mx: { 'occupied.example.com': ['mx.other.test'] },
    });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'first.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const writes = stub.calls.filter((call) => call.method !== 'GET').length;
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'occupied.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('already has MX');
    routingRules.push({ enabled: true, addresses: ['owner@second.example.com'] });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'second.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('explicit Cloudflare email rules conflict');
    expect(stub.calls.filter((call) => call.method !== 'GET')).toHaveLength(writes);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(1);
  });

  it('returns the same operation for concurrent rotation and sync requests with the same key', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'operation-replay');
    stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'replay.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const { connection } = (await resolveEmailDomain(env.db, 'replay.example.com'))!;
    const rotations = await Promise.all(
      Array.from({ length: 3 }, () =>
        requestEmailSecretRotation(env.db, bindings(), connection.id, actor, 'same-rotation'),
      ),
    );
    expect(new Set(rotations).size).toBe(1);
    await runEmailOperation(env.db, bindings(), rotations[0]);
    const syncs = await Promise.all(
      Array.from({ length: 3 }, () =>
        requestEmailDomainSync(env.db, bindings(), add.routeId, actor, 'same-sync'),
      ),
    );
    expect(new Set(syncs).size).toBe(1);
  });

  it('persists removal behind an unknown setup and resumes after project deletion', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'remove-unknown');
    const failures: { scriptPut?: { message: string; status: number } } = {
      scriptPut: { message: 'lost response', status: 504 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'unknown.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('unknown');
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
      kind: 'system',
    });
    expect((await resolveEmailDomain(env.db, 'unknown.example.com'))?.route.desired_state).toBe(
      'disabled',
    );
    await runEmailOperation(env.db, bindings(), remove);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    await env.db.delete(projects).where(eq(projects.id, project.id));
    delete failures.scriptPut;
    await reconcilePendingEmailOperations(env.db, bindings());
    await reconcilePendingEmailOperations(env.db, bindings());
    // The failed upload cannot be proved by readback, so the removal stays
    // durably queued instead of replaying or deleting a possibly live relay.
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    ).toBe('pending');
    expect((await resolveEmailDomain(env.db, 'unknown.example.com'))?.route.desired_state).toBe(
      'disabled',
    );
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(1);
  });

  it('runs a persisted system removal after its project row is gone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'removed-owner');
    stubCustomerCf({ zones });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'gone.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await env.db.delete(projects).where(eq(projects.id, project.id));
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
      kind: 'system',
    });
    await runEmailOperation(env.db, bindings(), remove);
    expect((await resolveEmailDomain(env.db, 'gone.example.com'))?.route.desired_state).toBe(
      'removed',
    );
  });

  it('keeps ingress while a disabled sibling still owns the connection', async () => {
    const user = await createTestUser(env.db);
    const first = await createTestProject(env.db, user.id, 'disabled-first');
    const second = await createTestProject(env.db, user.id, 'disabled-second');
    const stub = stubCustomerCf({ zones });
    const a = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: first.id,
      domain: 'one.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), a.operationId);
    const b = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: second.id,
      domain: 'two.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), b.operationId);
    await env.db
      .update(emailDomainRoutes)
      .set({ desired_state: 'disabled', inbound_status: 'disabled' })
      .where(eq(emailDomainRoutes.id, b.routeId));
    const remove = await requestEmailDomainRemove(env.db, bindings(), a.routeId, {
      kind: 'owner',
      userId: user.id,
    });
    await runEmailOperation(env.db, bindings(), remove);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    expect((await resolveEmailDomain(env.db, 'two.example.com'))?.route.desired_state).toBe(
      'disabled',
    );
  });

  it('defers destructive removal while an admitted provider attempt is live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'active-send');
    const stub = stubCustomerCf({ zones });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'active.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await env.db.insert(emailUnresolvedAttempts).values({
      id: 'live-provider-test',
      project_id: project.id,
      sender_domain: 'active.example.com',
      started_at: new Date().toISOString(),
    });
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
      kind: 'owner',
      userId: user.id,
    });
    await runEmailOperation(env.db, bindings(), remove);
    expect((await resolveEmailDomain(env.db, 'active.example.com'))?.route.desired_state).toBe(
      'disabled',
    );
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    expect(['pending', 'running']).toContain(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    );
    await env.db
      .delete(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.id, 'live-provider-test'));
    await runEmailOperation(env.db, bindings(), remove);
    expect((await resolveEmailDomain(env.db, 'active.example.com'))?.route.desired_state).toBe(
      'removed',
    );
  });

  it('re-adds a removed last route with a new credential, deployed secret, and cache version', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'readd-mail');
    const stub = stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: user.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'readd.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    const original = (await resolveEmailDomain(env.db, 'readd.example.com'))!;
    const removed = await requestEmailDomainRemove(env.db, bindings(), first.routeId, actor);
    await runEmailOperation(env.db, bindings(), removed);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
    expect(
      (await resolveEmailDomain(env.db, 'readd.example.com'))?.connection.credential_id,
    ).toBeNull();
    expect(await env.db.select().from(emailCredentials)).toHaveLength(0);
    await expect(requestEmailDomainSync(env.db, bindings(), first.routeId, actor)).rejects.toThrow(
      'must be active',
    );
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const cacheBase = `email-cache:route:${first.routeId}`;
    const removedVersion = Number(await env.ROUTING.get(`${cacheBase}:latest`));
    expect(JSON.parse((await env.ROUTING.get(`${cacheBase}:v${removedVersion}`))!).status).toBe(
      'removed',
    );

    const readded = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'readd.example.com',
      actor,
      token: TOKEN,
    });
    expect(readded.routeId).toBe(first.routeId);
    const pending = (await resolveEmailDomain(env.db, 'readd.example.com'))!;
    expect(pending.route.desired_generation).toBeGreaterThan(removedVersion);
    expect(pending.route.inbound_status).toBe('pending');
    expect(pending.route.outbound_status).toBe('pending');
    expect(pending.connection.credential_id).not.toBeNull();
    await runEmailOperation(env.db, bindings(), readded.operationId);
    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, readded.operationId))
      )[0]?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
    expect((await resolveEmailDomain(env.db, 'readd.example.com'))?.route.inbound_status).toBe(
      'ready',
    );
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const activeVersion = Number(await env.ROUTING.get(`${cacheBase}:latest`));
    expect(activeVersion).toBeGreaterThan(removedVersion);
    expect(JSON.parse((await env.ROUTING.get(`${cacheBase}:v${activeVersion}`))!).status).toBe(
      'active',
    );
    expect(original.connection.id).toBe(pending.connection.id);
    expect(await env.db.select().from(emailCacheOutbox)).toHaveLength(3);
  });

  it('retains the credential after an uncertain ingress delete until readback proves cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'unknown-delete');
    const existingScripts: Array<string> = [];
    const failures: { scriptDelete?: { message: string; status: number } } = {};
    const stub = stubCustomerCf({ zones, existingScripts, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'unknown-delete.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const connection = (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))!.connection;
    existingScripts.push(connection.ingress_worker_name);
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, actor);
    failures.scriptDelete = { message: 'response lost', status: 504 };
    await runEmailOperation(env.db, bindings(), remove);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    ).toBe('unknown');
    expect(
      (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))?.connection.credential_id,
    ).not.toBeNull();
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))?.connection.credential_id,
    ).not.toBeNull();
    existingScripts.length = 0;
    delete failures.scriptDelete;
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    ).toBe('completed');
    expect(
      (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))?.connection.credential_id,
    ).toBeNull();
    expect(await env.db.select().from(emailCredentials)).toHaveLength(0);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
  });

  it('transfers only a completed removed assignment and never exposes old operation history', async () => {
    const manager = await createTestUser(env.db, 'transfer-manager');
    const stranger = await createTestUser(env.db, 'transfer-stranger');
    const source = await createTestProject(env.db, manager.id, 'transfer-source');
    const target = await createTestProject(env.db, manager.id, 'transfer-target');
    const foreign = await createTestProject(env.db, stranger.id, 'transfer-foreign');
    stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: manager.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: source.id,
      domain: 'transfer.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: target.id,
        domain: 'transfer.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('assigned to another project');
    const removed = await requestEmailDomainRemove(env.db, bindings(), first.routeId, actor);
    await runEmailOperation(env.db, bindings(), removed);
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const oldHint = await env.ROUTING.get(`email-cache:route:${first.routeId}:latest`);
    expect(oldHint).not.toBeNull();
    expect(
      JSON.parse((await env.ROUTING.get(`email-cache:route:${first.routeId}:v${oldHint}`))!).status,
    ).toBe('removed');
    expect(
      await resolveEmailIngress(env.db, {
        installationId: 'void-hosted',
        accountId: 'customer-account',
        zoneId: 'zone-example',
        ingressName: (await resolveEmailDomain(env.db, 'transfer.example.com'))!.connection
          .ingress_worker_name,
        recipient: 'hello@transfer.example.com',
      }),
    ).toBeNull();
    await env.db.insert(emailUnresolvedAttempts).values({
      id: 'transfer-unresolved',
      project_id: source.id,
      sender_domain: 'transfer.example.com',
      started_at: new Date().toISOString(),
    });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: target.id,
        domain: 'transfer.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('sends are unresolved');
    await env.db
      .delete(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.id, 'transfer-unresolved'));
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: foreign.id,
        domain: 'transfer.example.com',
        actor: { kind: 'owner', userId: stranger.id },
        token: TOKEN,
      }),
    ).rejects.toThrow('manager approval');

    const transfer = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: target.id,
      domain: 'transfer.example.com',
      actor,
      token: TOKEN,
    });
    expect(transfer.routeId).toBe(first.routeId);
    expect((await resolveEmailDomain(env.db, 'transfer.example.com'))?.route.project_id).toBe(
      target.id,
    );
    expect(await getEmailOperation(env.db, target.id, first.operationId)).toBeNull();
    expect(await getEmailOperation(env.db, source.id, transfer.operationId)).toBeNull();
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, first.operationId))
      )[0],
    ).toBeTruthy();
    await runEmailOperation(env.db, bindings(), transfer.operationId);
    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, transfer.operationId))
      )[0]?.status,
    ).toBe('completed');
    const live = await resolveEmailIngress(env.db, {
      installationId: 'void-hosted',
      accountId: 'customer-account',
      zoneId: 'zone-example',
      ingressName: (await resolveEmailDomain(env.db, 'transfer.example.com'))!.connection
        .ingress_worker_name,
      recipient: 'hello@transfer.example.com',
    });
    expect(live?.route.project_id).toBe(target.id);
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const newHint = await env.ROUTING.get(`email-cache:route:${first.routeId}:latest`);
    expect(Number(newHint)).toBeGreaterThan(Number(oldHint));
  });

  it('serializes two sibling removals behind an unresolved connection write', async () => {
    const user = await createTestUser(env.db);
    const aProject = await createTestProject(env.db, user.id, 'queued-a');
    const bProject = await createTestProject(env.db, user.id, 'queued-b');
    stubCustomerCf({ zones });
    const a = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: aProject.id,
      domain: 'queue-a.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), a.operationId);
    const b = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: bProject.id,
      domain: 'queue-b.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), b.operationId);
    await env.db
      .update(emailOperations)
      .set({ status: 'unknown' })
      .where(eq(emailOperations.id, b.operationId));
    const removeA = await requestEmailDomainRemove(env.db, bindings(), a.routeId, {
      kind: 'system',
    });
    const removeB = await requestEmailDomainRemove(env.db, bindings(), b.routeId, {
      kind: 'system',
    });
    const queuedB = (
      await env.db.select().from(emailOperations).where(eq(emailOperations.id, removeB))
    )[0]!;
    expect(queuedB.current_step).toBe(`wait:${removeA}`);
    await runEmailOperation(env.db, bindings(), removeA);
    await runEmailOperation(env.db, bindings(), removeB);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, removeB)))[0]
        ?.status,
    ).toBe('pending');
    // Represent an operator-proven resolution of the earlier ambiguous write.
    await env.db
      .update(emailOperations)
      .set({ status: 'completed' })
      .where(eq(emailOperations.id, b.operationId));
    await runEmailOperation(env.db, bindings(), removeA);
    await runEmailOperation(env.db, bindings(), removeB);
    expect((await resolveEmailDomain(env.db, 'queue-a.example.com'))?.route.desired_state).toBe(
      'removed',
    );
    expect((await resolveEmailDomain(env.db, 'queue-b.example.com'))?.route.desired_state).toBe(
      'removed',
    );
  });
  it('shares one ingress across exact sibling routes and retains it on one removal', async () => {
    const user = await createTestUser(env.db);
    const first = await createTestProject(env.db, user.id, 'first-mail');
    const second = await createTestProject(env.db, user.id, 'second-mail');
    const stub = stubCustomerCf({ zones });
    const a = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: first.id,
      domain: 'hr.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'first-attempt',
    });
    await runEmailOperation(env.db, bindings(), a.operationId);
    const aOp = (
      await env.db.select().from(emailOperations).where(eq(emailOperations.id, a.operationId))
    )[0]!;
    expect(aOp.status).toBe('completed');
    const b = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: second.id,
      domain: 'support.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'second-attempt',
    });
    await runEmailOperation(env.db, bindings(), b.operationId);
    const [aRoute, bRoute, connections] = await Promise.all([
      resolveEmailDomain(env.db, 'hr.example.com'),
      resolveEmailDomain(env.db, 'support.example.com'),
      env.db.select().from(emailZoneConnections),
    ]);
    expect(connections).toHaveLength(1);
    expect(aRoute?.connection.id).toBe(bRoute?.connection.id);
    expect(aRoute?.route.project_id).toBe(first.id);
    expect(bRoute?.route.project_id).toBe(second.id);
    expect(aRoute?.route.outbound_status).toBe('ready');
    expect(bRoute?.route.outbound_status).toBe('ready');
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(1);
    const removed = await requestEmailDomainRemove(env.db, bindings(), a.routeId, {
      kind: 'owner',
      userId: user.id,
    });
    await runEmailOperation(env.db, bindings(), removed);
    expect((await resolveEmailDomain(env.db, 'hr.example.com'))?.route.desired_state).toBe(
      'removed',
    );
    expect((await resolveEmailDomain(env.db, 'support.example.com'))?.route.inbound_status).toBe(
      'ready',
    );
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    expect(
      (await resolveEmailDomain(env.db, 'support.example.com'))?.connection.credential_id,
    ).not.toBeNull();
  });

  it('commits step intent before provider writes and fences an ambiguous result', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uncertain-mail');
    let observedIntent = false;
    const stub = stubCustomerCf({
      zones,
      on: {
        scriptPut: async () => {
          const steps = await env.db.select().from(emailOperationSteps);
          observedIntent = steps.some(
            (step) => step.kind === 'ingress_deploy' && step.status === 'in_flight',
          );
        },
      },
      failOn: { scriptPut: { message: 'upstream timeout', status: 504 } },
    });
    const requested = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'alerts.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'stable-key',
    });
    await runEmailOperation(env.db, bindings(), requested.operationId);
    const op = (
      await env.db
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, requested.operationId))
    )[0]!;
    expect(observedIntent).toBe(true);
    expect(op.status).toBe('unknown');
    const writes = callsByTag(stub.calls, 'scriptPut').length;
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(writes);
    const replay = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'alerts.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'stable-key',
    });
    expect(replay.operationId).toBe(requested.operationId);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'alerts.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: 'different-token',
        attemptId: 'stable-key',
      }),
    ).rejects.toThrow('reused');
  });

  it('does not let a second driver invalidate an in-flight provider result', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'race-mail');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    stubCustomerCf({
      zones,
      on: {
        scriptPut: async () => {
          entered();
          await gate;
        },
      },
    });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'race.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    const first = runEmailOperation(env.db, bindings(), add.operationId);
    await seen;
    await runEmailOperation(env.db, bindings(), add.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('running');
    release();
    await first;
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('completed');
  });

  it('promotes a rotated secret only after the gateway accepts it', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'rotation-mail');
    const failures: { gatewayProbe?: { message: string; status: number } } = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'rotate.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const route = (await resolveEmailDomain(env.db, 'rotate.example.com'))!;
    const before = route.connection.active_secret_generation;
    const operationId = await requestEmailSecretRotation(env.db, bindings(), route.connection.id, {
      kind: 'owner',
      userId: user.id,
    });
    failures.gatewayProbe = { message: 'gateway refused secret', status: 403 };
    await runEmailOperation(env.db, bindings(), operationId);
    const pending = (
      await env.db
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, route.connection.id))
    )[0]!;
    expect(pending.active_secret_generation).toBe(before);
    expect(pending.staged_secret_generation).toBe(before + 1);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId)))[0]
        ?.status,
    ).toBe('unknown');
    delete failures.gatewayProbe;
    await reconcilePendingEmailOperations(env.db, bindings());
    const promoted = (
      await env.db
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, route.connection.id))
    )[0]!;
    expect(promoted.active_secret_generation).toBe(before + 1);
    expect(promoted.staged_secret_generation).toBeNull();
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId)))[0]
        ?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
  });

  it('recovers a lost secret PUT response by proving the staged deployed value', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'lost-rotation');
    const failures: { secretPut?: { message: string; status: number } } = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'lost.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const connection = (await resolveEmailDomain(env.db, 'lost.example.com'))!.connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), connection.id, {
      kind: 'owner',
      userId: user.id,
    });
    failures.secretPut = { message: 'response lost', status: 504 };
    await runEmailOperation(env.db, bindings(), rotation);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('unknown');
    delete failures.secretPut;
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
  });

  it('does not replace a foreign zone catch-all', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'foreign-mail');
    const stub = stubCustomerCf({
      zones,
      catchAllRule: { enabled: true, workerName: 'somebody-else' },
    });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'foreign.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      }),
    ).rejects.toThrow('unrelated catch-all');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
  });

  it('does not install catch-all until the gateway accepts the zone secret', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'gateway-refusal');
    const stub = stubCustomerCf({
      zones,
      failOn: { gatewayProbe: { message: 'refused', status: 403 } },
    });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'refused.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('unknown');
    expect((await resolveEmailDomain(env.db, 'refused.example.com'))?.route.inbound_status).toBe(
      'pending',
    );
    expect(callsByTag(stub.calls, 'relayProbe')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
  });

  it('keeps the installation gateway Worker when a custom sibling is added, synced and removed', async () => {
    const owner = await createTestUser(env.db),
      project = await createTestProject(env.db, owner.id, 'shared-sibling');
    const shared = {
      ...bindings(),
      EMAIL_SENDER_DOMAIN: 'example.com',
      EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      EMAIL_SHARED_ZONE_ID: 'platform-mail-zone',
      EMAIL_SHARED_INGRESS_NAME: 'void-email-gateway',
    } as ApiEnv['Bindings'];
    const stub = stubCustomerCf({
      zones: {
        'example.com': {
          id: 'platform-mail-zone',
          name: 'example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
    });
    const bootstrap = await ensureSharedEmailConnection(env.db, shared);
    expect(bootstrap).toBeTruthy();
    await runEmailOperation(env.db, shared, bootstrap!);
    const added = await requestEmailDomainAdd(env.db, shared, {
      projectId: project.id,
      domain: 'alerts.example.com',
      actor: { kind: 'admin', userId: owner.id },
    });
    await runEmailOperation(env.db, shared, added.operationId);
    const route = await resolveEmailDomain(env.db, 'alerts.example.com');
    expect(route?.route.inbound_status).toBe('ready');
    expect(route?.route.outbound_status).toBe('ready');
    expect(route?.connection.ingress_worker_name).toBe('void-email-gateway');
    const nativeRoute = await resolveEmailIngress(env.db, {
      installationId: 'void-hosted',
      accountId: env.CF_ACCOUNT_ID,
      zoneId: 'platform-mail-zone',
      ingressName: 'void-email-gateway',
      recipient: 'inbox@alerts.example.com',
    });
    expect(nativeRoute?.route.project_id).toBe(project.id);
    expect(nativeRoute?.route.addressing).toBe('custom');
    const sync = await requestEmailDomainSync(env.db, shared, added.routeId, {
      kind: 'admin',
      userId: owner.id,
    });
    await runEmailOperation(env.db, shared, sync);
    await expect(
      requestEmailSecretRotation(env.db, shared, route!.connection.id, {
        kind: 'admin',
        userId: owner.id,
      }),
    ).rejects.toThrow('managed by platform deployment');
    const remove = await requestEmailDomainRemove(env.db, shared, added.routeId, {
      kind: 'admin',
      userId: owner.id,
    });
    await runEmailOperation(env.db, shared, remove);
    const removedRoute = (await resolveEmailDomain(env.db, 'alerts.example.com'))!.route;
    expect(removedRoute.desired_state).toBe('removed');
    expect(await disableEmailDomainRouteAndDrain(env.db, removedRoute.id)).toEqual({
      cancelled: 0,
      inFlight: 0,
    });
    const repeatedRemoval = (await resolveEmailDomain(env.db, 'alerts.example.com'))!.route;
    expect(repeatedRemoval.desired_state).toBe('removed');
    expect(repeatedRemoval.desired_generation).toBe(removedRoute.desired_generation);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    expect((await resolveEmailDomain(env.db, 'example.com'))?.route.desired_state).toBe('active');
  });

  it('requires the zone manager for sibling claims and blocks credential renewal while outcome is unknown', async () => {
    const manager = await createTestUser(env.db, 'zone-manager'),
      other = await createTestUser(env.db, 'zone-other');
    const first = await createTestProject(env.db, manager.id, 'manager-project'),
      second = await createTestProject(env.db, other.id, 'other-project');
    const failures: { secretPut?: { message: string; status: number } } = {};
    stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: first.id,
      domain: 'manager.example.com',
      actor: { kind: 'owner', userId: manager.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: second.id,
        domain: 'other.example.com',
        actor: { kind: 'owner', userId: other.id },
        token: TOKEN,
      }),
    ).rejects.toThrow('manager approval');
    const connection = (await resolveEmailDomain(env.db, 'manager.example.com'))!.connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), connection.id, {
      kind: 'owner',
      userId: manager.id,
    });
    failures.secretPut = { message: 'unknown write', status: 504 };
    await runEmailOperation(env.db, bindings(), rotation);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: first.id,
        domain: 'manager.example.com',
        actor: { kind: 'owner', userId: manager.id },
        token: 'renewed-token',
      }),
    ).rejects.toThrow('unresolved');
  });
});
