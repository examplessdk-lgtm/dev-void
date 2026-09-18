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
import { emailDomainRoutes, emailZoneConnections } from '../../src/email/connection-schema.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  CF_ACCOUNT_ID,
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv, operatorToken: string;
const zones = {
  'example.com': { id: 'zone-platform', name: 'example.com', accountId: CF_ACCOUNT_ID },
};
function request(path: string, body?: Record<string, unknown>, token = operatorToken) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    {
      ...env,
      EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
    } as unknown as ApiEnv['Bindings'],
  );
}
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(env.db, 'operator-mail', 'github', undefined, 'free', 'admin');
  operatorToken = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('operator email domain management', () => {
  it('requires operator authentication and validates a project before provider calls', async () => {
    const stub = stubCustomerCf({ zones });
    expect((await request('/email/domains', undefined, 'invalid')).status).toBe(401);
    const bad = await request('/email/domains', { domain: 'mail.example.com', project: 'missing' });
    expect(bad.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it('previews without mutations and then manages one exact route with a platform token', async () => {
    const owner = await createTestUser(env.db, 'managed-owner'),
      project = await createTestProject(env.db, owner.id, 'managed-project');
    const stub = stubCustomerCf({ zones });
    const preview = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { dryRun: boolean }).dryRun).toBe(true);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(0);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(0);
    const add = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
    });
    expect(add.status).toBe(200);
    const payload = (await add.json()) as {
      domain: { operationId: string; readiness: { inbound: { status: string } } };
    };
    expect(payload.domain.operationId).toMatch(/^eop/);
    expect(payload.domain.readiness.inbound.status).toBe('ready');
    expect((await env.db.select().from(emailZoneConnections))[0]?.managed_by).toBe('admin');
    expect((await request('/email/domains/mail.example.com')).status).toBe(200);
    expect((await request('/email/domains/mail.example.com/rotate-secret', {})).status).toBe(200);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
    expect((await request('/email/domains/mail.example.com/remove', {})).status).toBe(200);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('removed');
  });

  it('leaves a foreign catch-all untouched and reports the refusal', async () => {
    const owner = await createTestUser(env.db, 'foreign-owner'),
      project = await createTestProject(env.db, owner.id, 'foreign-project');
    const stub = stubCustomerCf({
      zones,
      catchAllRule: { enabled: true, workerName: 'foreign-worker' },
    });
    const response = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
    });
    expect(response.status).toBe(409);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(0);
  });
});
