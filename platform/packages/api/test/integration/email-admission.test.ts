import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { deleteEmailDestination } from '../../src/db.ts';
import {
  emailActionRecipients,
  emailMonthlyUsage,
  emailUnresolvedAttempts,
} from '../../src/email/admission-schema.ts';
import {
  admitEmailAction,
  claimRelayedEmailReceipt,
  completeRelayedEmailReceipt,
  recordEmailReceipt,
  drainProjectEmailAdmissions,
  EmailAdmissionError,
  getProjectEmailLogs,
  getProjectEmailUsage,
  pruneEmailActionHistory,
  resolveEmailUnresolvedAttempt,
  setProjectEmailLimits,
  setProjectEmailSuspended,
  transitionEmailRecipients,
} from '../../src/email/admission.ts';
import {
  emailCredentials,
  emailDomainRoutes,
  emailZoneConnections,
} from '../../src/email/connection-schema.ts';
import { setEmailRecipientPolicy } from '../../src/email/settings.ts';
import { emailDestinations, projects } from '../../src/schema.ts';
import {
  clearTables,
  createTestProject,
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
});

async function fixture() {
  const user = await createTestUser(env.db);
  const project = await createTestProject(env.db, user.id, 'acme');
  await env.db.insert(emailDestinations).values({
    id: `dest_${project.id}`,
    project_id: project.id,
    address: 'one@example.com',
    status: 'verified',
  });
  await env.db.insert(emailDestinations).values({
    id: `dest2_${project.id}`,
    project_id: project.id,
    address: 'two@example.com',
    status: 'verified',
  });
  return project;
}

function input(projectId: string, key: string, recipients = ['one@example.com']) {
  return {
    projectId,
    kind: 'direct' as const,
    key,
    digest: 'a'.repeat(64),
    from: 'acme+news@mail.example.com',
    recipients,
    transport: 'binding' as const,
    sharedSenderDomain: 'mail.example.com',
  };
}

describe('authoritative email admission', () => {
  it('requires verified recipients for shared native forwarding even under an open policy', async () => {
    const project = await fixture();
    await setEmailRecipientPolicy(env.db, env.ROUTING, { mode: 'any', domains: [] });
    const receiptId = 'e'.repeat(64);
    await recordEmailReceipt(env.db, {
      receiptId,
      projectId: project.id,
      status: 'handler_completed',
    });
    const result = await admitEmailAction(env.db, {
      ...input(project.id, 'shared-forward', ['one@example.com', 'unverified@example.net']),
      kind: 'forward',
      transport: 'native_forward',
      receiptId,
    });
    expect(result.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'one@example.com', state: 'reserved' }),
        expect.objectContaining({
          recipient: 'unverified@example.net',
          state: 'rejected',
          errorCode: 'UNVERIFIED_DESTINATION',
        }),
      ]),
    );
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
  });

  it('records unsupported relayed forwarding without charging and retains native verified forwarding', async () => {
    const project = await fixture();
    await env.db.insert(emailCredentials).values({
      id: 'cred',
      installation_id: 'installation',
      managed_by: 'admin',
      kind: 'platform',
      account_id: 'account',
      zone_id: 'zone',
    });
    await env.db.insert(emailZoneConnections).values({
      id: 'connection',
      installation_id: 'installation',
      account_id: 'account',
      zone_id: 'zone',
      zone_name: 'example.com',
      managed_by: 'admin',
      credential_id: 'cred',
      ingress_worker_name: 'gateway',
      secret_ciphertext: 'ciphertext',
      secret_iv: 'iv',
      secret_key_version: 'key',
      management_status: 'healthy',
    });
    await env.db.insert(emailDomainRoutes).values({
      id: 'route',
      domain: 'example.com',
      connection_id: 'connection',
      project_id: project.id,
      addressing: 'custom',
      managed_by: 'admin',
      inbound_status: 'ready',
      outbound_status: 'ready',
    });
    const receiptId = 'f'.repeat(64);
    await recordEmailReceipt(env.db, {
      receiptId,
      projectId: project.id,
      status: 'handler_completed',
    });
    const forward = {
      ...input(project.id, 'relay-forward'),
      kind: 'forward' as const,
      from: 'support@example.com',
      receiptId,
    };
    const unsupported = await admitEmailAction(env.db, { ...forward, transport: 'send_raw' });
    expect(unsupported.recipients).toMatchObject([
      { state: 'rejected', errorCode: 'UNSUPPORTED_ACTION' },
    ]);
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(0);
    const native = await admitEmailAction(env.db, {
      ...forward,
      key: 'native-forward',
      transport: 'native_forward',
      recipients: ['one@example.com', 'unverified@example.net'],
    });
    expect(native.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'one@example.com', state: 'reserved' }),
        expect.objectContaining({
          recipient: 'unverified@example.net',
          state: 'rejected',
          errorCode: 'UNVERIFIED_DESTINATION',
        }),
      ]),
    );
  });

  it('keeps invalid handler actions visible when completing and replaying a receipt', async () => {
    const project = await fixture();
    const identity = {
      receiptId: 'c'.repeat(64),
      payloadDigest: 'd'.repeat(64),
      projectId: project.id,
    };
    await claimRelayedEmailReceipt(env.db, identity);
    await recordEmailReceipt(env.db, { ...identity, status: 'actions_rejected' });
    await completeRelayedEmailReceipt(env.db, { ...identity, reject: false });
    expect(await claimRelayedEmailReceipt(env.db, identity)).toEqual({
      state: 'completed',
      reject: false,
    });
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toEqual([
      expect.objectContaining({
        receiptId: identity.receiptId,
        status: 'actions_rejected',
        errorCode: 'INVALID_ACTIONS',
      }),
    ]);
  });

  it('claims a relay invocation once and replays its completed outcome without rerunning it', async () => {
    const project = await fixture();
    const identity = {
      receiptId: 'a'.repeat(64),
      projectId: project.id,
      payloadDigest: 'b'.repeat(64),
    };
    const claims = await Promise.all(
      Array.from({ length: 3 }, () => claimRelayedEmailReceipt(env.db, identity)),
    );
    expect(claims.filter((claim) => claim.state === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.state === 'in_progress')).toHaveLength(2);
    await expect(
      completeRelayedEmailReceipt(env.db, { ...identity, reject: false }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await recordEmailReceipt(env.db, {
      receiptId: identity.receiptId,
      projectId: project.id,
      status: 'handler_completed',
    });
    await completeRelayedEmailReceipt(env.db, { ...identity, reject: false });
    expect(await claimRelayedEmailReceipt(env.db, identity)).toEqual({
      state: 'completed',
      reject: false,
    });
    await expect(
      claimRelayedEmailReceipt(env.db, { ...identity, payloadDigest: 'c'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      completeRelayedEmailReceipt(env.db, { ...identity, reject: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('fences new starts during deletion, cancels only reserved work, and retains the audit after deletion', async () => {
    const project = await fixture();
    const reserved = await admitEmailAction(env.db, input(project.id, 'reserved'));
    const started = await admitEmailAction(
      env.db,
      input(project.id, 'started', ['two@example.com']),
    );
    await transitionEmailRecipients(
      env.db,
      started.operationId,
      ['two@example.com'],
      'attempt_started',
    );
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await expect(
      transitionEmailRecipients(
        env.db,
        reserved.operationId,
        ['one@example.com'],
        'attempt_started',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 1,
      inFlight: 1,
    });
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
    await transitionEmailRecipients(
      env.db,
      started.operationId,
      ['two@example.com'],
      'outcome_unknown',
    );
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 0,
      inFlight: 0,
    });
    await env.db.delete(projects).where(eq(projects.id, project.id));
    const logs = await getProjectEmailLogs(env.db, project.id);
    expect(logs.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: reserved.operationId, status: 'cancelled' }),
        expect.objectContaining({ operationId: started.operationId, status: 'outcome_unknown' }),
      ]),
    );
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
  });

  it('expires completed unknown metadata but retains a PII-free active-attempt fence', async () => {
    const project = await fixture();
    const active = await admitEmailAction(env.db, input(project.id, 'active'));
    const uncertain = await admitEmailAction(
      env.db,
      input(project.id, 'uncertain', ['two@example.com']),
    );
    await transitionEmailRecipients(
      env.db,
      active.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      uncertain.operationId,
      ['two@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      uncertain.operationId,
      ['two@example.com'],
      'outcome_unknown',
    );
    await pruneEmailActionHistory(env.db, new Date(Date.now() + 60_000));
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toHaveLength(0);
    const tombstones = await env.db.select().from(emailUnresolvedAttempts);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      project_id: project.id,
      sender_domain: 'mail.example.com',
    });
    expect(JSON.stringify(tombstones)).not.toContain('one@example.com');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 0,
      inFlight: 1,
    });
  });

  it('resolves a stopped old attempt without retrying or refunding it', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'crashed'));
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await env.db
      .update(emailUnresolvedAttempts)
      .set({ started_at: old })
      .where(eq(emailUnresolvedAttempts.id, fence!.id));
    await env.db
      .update(emailActionRecipients)
      .set({ attempt_started_at: old })
      .where(eq(emailActionRecipients.id, fence!.id));

    await expect(
      resolveEmailUnresolvedAttempt(env.db, { id: fence!.id, ended: false, reason: 'ended' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      resolveEmailUnresolvedAttempt(env.db, { id: fence!.id, ended: true, reason: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(
      await resolveEmailUnresolvedAttempt(env.db, {
        id: fence!.id,
        ended: true,
        reason: 'Worker execution ended; provider status cannot be verified',
      }),
    ).toMatchObject({ state: 'outcome_unknown', metadataExpired: false, charged: true });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(0);
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toEqual([
      expect.objectContaining({ operationId: action.operationId, status: 'outcome_unknown' }),
    ]);
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
    expect(
      (await admitEmailAction(env.db, input(project.id, 'crashed'))).recipients[0]?.state,
    ).toBe('outcome_unknown');
    await expect(
      transitionEmailRecipients(
        env.db,
        action.operationId,
        ['one@example.com'],
        'provider_accepted',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('requires an old fence even when the operator attests the execution ended', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'recent'));
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    await expect(
      resolveEmailUnresolvedAttempt(env.db, {
        id: fence!.id,
        ended: true,
        reason: 'Worker execution ended',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(1);
    expect((await getProjectEmailLogs(env.db, project.id)).logs[0]?.status).toBe('attempt_started');
  });

  it('releases a PII-free fence after the recipient ledger has expired', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'expired'));
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    await env.db
      .update(emailUnresolvedAttempts)
      .set({ started_at: new Date(Date.now() - 31 * 86_400_000).toISOString() })
      .where(eq(emailUnresolvedAttempts.id, fence!.id));
    await pruneEmailActionHistory(env.db, new Date(Date.now() + 60_000));
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toHaveLength(0);
    expect(
      await resolveEmailUnresolvedAttempt(env.db, {
        id: fence!.id,
        ended: true,
        reason: 'Worker execution ended; delivery record expired',
      }),
    ).toMatchObject({ metadataExpired: true, charged: true });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(0);
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 0,
      inFlight: 0,
    });
  });

  it('replays one operation without a second quota debit and conflicts on changed payload', async () => {
    const project = await fixture();
    const first = await admitEmailAction(env.db, input(project.id, 'same'));
    expect(first.replay).toBe(false);
    expect(first.recipients[0]?.state).toBe('reserved');
    const again = await admitEmailAction(env.db, input(project.id, 'same'));
    expect(again.operationId).toBe(first.operationId);
    expect(again.replay).toBe(true);
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
    await expect(
      admitEmailAction(env.db, { ...input(project.id, 'same'), digest: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<EmailAdmissionError>);
  });

  it('admits a partial batch under atomic recipient quotas and keeps charges after uncertain outcomes', async () => {
    const project = await fixture();
    await setProjectEmailLimits(env.db, project.id, { burst: 1, monthly: 1 });
    const result = await admitEmailAction(
      env.db,
      input(project.id, 'batch', ['one@example.com', 'two@example.com', 'one@example.com']),
    );
    expect(result.recipients).toHaveLength(2);
    expect(Object.fromEntries(result.recipients.map((r) => [r.recipient, r.state]))).toEqual({
      'one@example.com': 'reserved',
      'two@example.com': 'rejected',
    });
    await transitionEmailRecipients(
      env.db,
      result.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      result.operationId,
      ['one@example.com'],
      'outcome_unknown',
      { errorCode: 'OUTCOME_UNKNOWN' },
    );
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
    const replay = await admitEmailAction(
      env.db,
      input(project.id, 'batch', ['one@example.com', 'two@example.com']),
    );
    expect(replay.recipients.find((r) => r.recipient === 'one@example.com')?.state).toBe(
      'outcome_unknown',
    );
    await expect(
      transitionEmailRecipients(env.db, result.operationId, ['one@example.com'], 'attempt_started'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects new attempts after suspension and keeps a rejection in the ledger', async () => {
    const project = await fixture();
    await setProjectEmailSuspended(env.db, project.id, true);
    const result = await admitEmailAction(env.db, input(project.id, 'blocked'));
    expect(result.recipients[0]).toMatchObject({ state: 'rejected', errorCode: 'SUSPENDED' });
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(0);
  });

  it('applies a tightened policy and revoked consent on the next operation', async () => {
    const project = await fixture();
    const kv = { put: async () => {}, get: async () => null } as unknown as KVNamespace;
    await setEmailRecipientPolicy(env.db, kv, { mode: 'any', domains: [] });
    const open = await admitEmailAction(env.db, input(project.id, 'open', ['new@example.net']));
    expect(open.recipients[0]?.state).toBe('reserved');
    await setEmailRecipientPolicy(env.db, kv, { mode: 'verified', domains: [] });
    await deleteEmailDestination(env.db, `dest_${project.id}`);
    const closed = await admitEmailAction(
      env.db,
      input(project.id, 'closed', ['one@example.com', 'new@example.net']),
    );
    expect(closed.recipients.map((r) => r.state)).toEqual(['rejected', 'rejected']);
    expect(closed.recipients.every((r) => r.errorCode === 'UNVERIFIED_DESTINATION')).toBe(true);
  });

  it('holds current-month quota after metadata pruning while removing expired buckets', async () => {
    const project = await fixture();
    await setProjectEmailLimits(env.db, project.id, { monthly: 1, burst: 10 });
    const first = await admitEmailAction(env.db, input(project.id, 'first'));
    await transitionEmailRecipients(
      env.db,
      first.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      first.operationId,
      ['one@example.com'],
      'provider_accepted',
    );
    await env.db.insert(emailMonthlyUsage).values([
      { project_id: project.id, month: '2000-01', recipient_attempts: 1 },
      { project_id: 'deleted-project', month: '2000-01', recipient_attempts: 2 },
    ]);
    await pruneEmailActionHistory(env.db, new Date(Date.now() + 60_000));
    expect(await env.db.select().from(emailMonthlyUsage)).toEqual([
      {
        project_id: project.id,
        month: new Date().toISOString().slice(0, 7),
        recipient_attempts: 1,
      },
    ]);
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toHaveLength(0);
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
    const second = await admitEmailAction(env.db, input(project.id, 'second'));
    expect(second.recipients[0]).toMatchObject({ state: 'rejected', errorCode: 'QUOTA_EXCEEDED' });
    expect(first.operationId).not.toBe(second.operationId);
  });

  it('refunds only cancelled reservations and never restarts an uncertain attempt', async () => {
    const project = await fixture();
    const first = await admitEmailAction(env.db, input(project.id, 'cancel'));
    await transitionEmailRecipients(env.db, first.operationId, ['one@example.com'], 'cancelled');
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(0);
    await expect(
      transitionEmailRecipients(env.db, first.operationId, ['one@example.com'], 'attempt_started'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const second = await admitEmailAction(env.db, input(project.id, 'uncertain'));
    await transitionEmailRecipients(
      env.db,
      second.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      second.operationId,
      ['one@example.com'],
      'outcome_unknown',
    );
    expect(
      (await admitEmailAction(env.db, input(project.id, 'uncertain'))).recipients[0]?.state,
    ).toBe('outcome_unknown');
    await expect(
      transitionEmailRecipients(env.db, second.operationId, ['one@example.com'], 'cancelled'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await getProjectEmailUsage(env.db, project.id)).sent).toBe(1);
  });

  it('enforces direct caller bounds at the authoritative API', async () => {
    const project = await fixture();
    await expect(
      admitEmailAction(env.db, input(project.id, 'x'.repeat(129))),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      admitEmailAction(
        env.db,
        input(
          project.id,
          'many',
          Array.from({ length: 51 }, (_, n) => `user${n}@example.com`),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
