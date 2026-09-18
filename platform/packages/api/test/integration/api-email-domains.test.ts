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
import { hmacSignState } from '../../src/auth/hmac.ts';
import { emailCredentials, emailOperations } from '../../src/email/connection-schema.ts';
import app from '../../src/index.ts';
import { stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
const token = 'customer-scoped-token';
const zones = {
  'example.com': { id: 'zone-example', name: 'example.com', accountId: 'customer-account' },
};
function runtime() {
  return { ...env, EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test' } as typeof env;
}
function call(projectId: string, jwt: string, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    runtime(),
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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('project email domain authority', () => {
  it('rejects unauthenticated, foreign-owner, malformed and OAuth requests before Cloudflare writes', async () => {
    const owner = await createTestUser(env.db, 'domain-owner'),
      other = await createTestUser(env.db, 'domain-other');
    const project = await createTestProject(env.db, owner.id, 'owned-mail');
    const stub = stubCustomerCf({ zones });
    expect((await call(project.id, '', 'GET', '/domains')).status).toBe(401);
    expect(
      (
        await call(project.id, other.jwt, 'POST', '/domains', {
          domain: 'mail.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'bad domain',
          apiToken: token,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'mail.example.com',
          refreshToken: 'oauth-grant',
        })
      ).status,
    ).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it('stores connection-scoped token ciphertext and returns operation/readiness without secret material', async () => {
    const owner = await createTestUser(env.db, 'registered-owner');
    const project = await createTestProject(env.db, owner.id, 'registered-mail');
    stubCustomerCf({ zones });
    const response = await call(project.id, owner.jwt, 'POST', '/domains', {
      domain: 'Mail.Example.COM',
      apiToken: token,
      attemptId: 'stable-add',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      operationId: string;
      attemptId: string;
      readiness: { inbound: { status: string } };
      domain: string;
    };
    expect(body.domain).toBe('mail.example.com');
    expect(body.attemptId).toBe('stable-add');
    expect(body.operationId).toMatch(/^eop/);
    expect(body.readiness.inbound.status).toBe('ready');
    expect(JSON.stringify(body)).not.toContain(token);
    const credential = (await env.db.select().from(emailCredentials))[0]!;
    expect(credential.kind).toBe('api_token');
    expect(credential.ciphertext).not.toContain(token);
    expect(credential.account_id).toBe('customer-account');
    const status = await call(project.id, owner.jwt, 'GET', '/operations/stable-add');
    expect(status.status).toBe(200);
    expect(((await status.json()) as { operationId: string }).operationId).toBe(body.operationId);
    const replay = await call(project.id, owner.jwt, 'POST', '/domains', {
      domain: 'mail.example.com',
      apiToken: token,
      attemptId: 'stable-add',
    });
    expect(((await replay.json()) as { operationId: string }).operationId).toBe(body.operationId);
    const conflict = await call(project.id, owner.jwt, 'POST', '/domains', {
      domain: 'mail.example.com',
      apiToken: 'another-token',
      attemptId: 'stable-add',
    });
    expect(conflict.status).toBe(409);
    expect(await env.db.select().from(emailOperations)).toHaveLength(1);
  });

  it('leases only an exact active route for the signed owning project', async () => {
    const owner = await createTestUser(env.db, 'lease-owner'),
      other = await createTestUser(env.db, 'lease-other');
    const project = await createTestProject(env.db, owner.id, 'lease-mail');
    const foreign = await createTestProject(env.db, other.id, 'foreign-mail');
    stubCustomerCf({ zones });
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'lease.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
    const lease = async (projectId: string, domain: string, signatureDomain = domain) =>
      app.fetch(
        new Request('http://localhost/internal/email/domain-credential', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-void-internal': await hmacSignState(
              `email-lease-v1\n${projectId}\n${signatureDomain}`,
              JWT_SECRET,
            ),
          },
          body: JSON.stringify({ domain, projectId }),
        }),
        runtime(),
      );
    const valid = await lease(project.id, 'lease.example.com');
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      kind: 'api_token',
      token,
      accountId: 'customer-account',
    });
    expect((await lease(foreign.id, 'lease.example.com')).status).toBe(404);
    expect((await lease(project.id, 'lease.example.com', 'other.example.com')).status).toBe(403);
    const signed = await hmacSignState(
      `email-lease-v1\n${project.id}\nlease.example.com`,
      JWT_SECRET,
    );
    const oversized = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-void-internal': signed },
        body: JSON.stringify({
          domain: 'lease.example.com',
          projectId: project.id,
          padding: 'x'.repeat(5000),
        }),
      }),
      runtime(),
    );
    expect(oversized.status).toBe(413);
    const malformed = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-void-internal': signed },
        body: 'null',
      }),
      runtime(),
    );
    expect(malformed.status).toBe(400);
    const unsigned = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      }),
      runtime(),
    );
    expect(unsigned.status).toBe(403);
    const list = await call(project.id, other.jwt, 'GET', '/domains');
    expect(list.status).toBe(403);
  });
});
