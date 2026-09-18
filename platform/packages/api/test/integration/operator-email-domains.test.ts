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
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  encryptEmailDomainRelaySecret,
  encryptEmailDomainToken,
  type EmailDomain,
} from '../../src/email/domains.ts';
import { RELAY_WORKER_BASE_NAME } from '../../src/email/relay-engine.ts';
import { RELAY_VERSION } from '../../src/email/relay-worker.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { emailDomains, operatorEvents } from '../../src/schema.ts';
import { callsByTag, stubCustomerCf, tags } from './email-domain-cf-stub.ts';
import {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;

// Dummy stand-ins — never real token material.
const CUSTOMER_TOKEN = 'cf-customer-token-dummy';
const RELAY_SECRET = 'relay-secret-dummy';
/** A zone in the platform's own account — what the platform credential may register. */
const PLATFORM_ZONE = { id: 'zone_platform', name: 'example.com', accountId: CF_ACCOUNT_ID };
/** A zone in a customer's account — refused on the platform credential. */
const FOREIGN_ZONE = { id: 'zone_foreign', name: 'elsewhere.test', accountId: 'acct_customer' };

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const mirrors = await env.ROUTING.list({ prefix: 'email-domain:' });
  await Promise.all(mirrors.keys.map((key) => env.ROUTING.delete(key.name)));
  const admin = await createTestUser(env.db, 'domain-admin', 'github', undefined, 'free', 'admin');
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

async function rowFor(domain: string): Promise<EmailDomain | undefined> {
  const rows = await env.db.select().from(emailDomains).where(eq(emailDomains.domain, domain));
  return rows[0];
}

async function events() {
  return env.db.select().from(operatorEvents);
}

async function seedOwnerDomain(projectId: string, domain: string): Promise<EmailDomain> {
  const tokenEnc = await encryptEmailDomainToken(env, projectId, domain, CUSTOMER_TOKEN);
  const relayEnc = await encryptEmailDomainRelaySecret(env, projectId, domain, RELAY_SECRET);
  await env.db.insert(emailDomains).values({
    id: `edom_owner_${domain.replace(/[^a-z0-9]/g, '')}`,
    project_id: projectId,
    domain,
    zone_id: FOREIGN_ZONE.id,
    account_id: FOREIGN_ZONE.accountId,
    mode: 'apex',
    status: 'active',
    credential_kind: 'api_token',
    managed_by: 'owner',
    token_ciphertext: tokenEnc.ciphertext,
    token_iv: tokenEnc.iv,
    token_key_version: tokenEnc.keyVersion,
    relay_ciphertext: relayEnc.ciphertext,
    relay_iv: relayEnc.iv,
    relay_key_version: relayEnc.keyVersion,
    relay_worker_name: RELAY_WORKER_BASE_NAME,
    relay_version: RELAY_VERSION,
  });
  return (await rowFor(domain))!;
}

async function seedProject(slug = 'hr-portal') {
  const owner = await createTestUser(env.db, `${slug}-owner`);
  return createTestProject(env.db, owner.id, slug);
}

describe('operator email domain-add', () => {
  test('previews without any Cloudflare call, then registers on the platform credential', async () => {
    const project = await seedProject();
    const stub = stubCustomerCf({ zones: { 'example.com': PLATFORM_ZONE } });

    const preview = await req('/email/domains', {
      domain: 'Example.COM',
      project: project.slug,
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.domain.add',
      target: {
        domain: 'example.com',
        projectId: project.id,
        slug: project.slug,
        credentialKind: 'platform',
      },
      existing: null,
      plan: 'setup',
      mx: 'apex',
    });
    // Public DNS only — the credential is never spent on a preview.
    expect(tags(stub.calls)).toEqual(['mxLookup']);
    expect(await rowFor('example.com')).toBeUndefined();
    expect(await events()).toHaveLength(0);

    const response = await req('/email/domains', { domain: 'example.com', project: project.id });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { action: string; domain: Record<string, unknown> };
    expect(body.action).toBe('email.domain.add');
    expect(body.domain).toMatchObject({
      domain: 'example.com',
      status: 'active',
      credential_kind: 'platform',
      managed_by: 'admin',
      relay_worker_name: RELAY_WORKER_BASE_NAME,
    });
    const row = (await rowFor('example.com'))!;
    expect(row.credential_kind).toBe('platform');
    expect(row.managed_by).toBe('admin');
    expect(row.token_ciphertext).toBeNull();
    expect(row.token_iv).toBeNull();
    expect(row.token_key_version).toBeNull();
    expect(row.account_id).toBe(CF_ACCOUNT_ID);
    // No user-token verify: the runtime token is not a user token.
    expect(callsByTag(stub.calls, 'verifyToken')).toHaveLength(0);
    // Every customer-account call went out with the runtime token.
    for (const call of stub.fn.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth) {
        expect(auth).toBe(`Bearer ${CF_API_TOKEN}`);
      }
    }
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/domains', status: 'success' });
    expect(JSON.parse(recorded[0]!.target)).toEqual({
      domain: 'example.com',
      project: project.id,
    });
  });

  test('refuses a zone outside the platform account before any write', async () => {
    const project = await seedProject();
    const stub = stubCustomerCf({ zones: { 'elsewhere.test': FOREIGN_ZONE } });
    const response = await req('/email/domains', { domain: 'elsewhere.test', project: project.id });
    // The engine records the failure on the row; the operator answers 200
    // with the row's error like the owner route does.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { domain: Record<string, unknown> };
    expect(body.domain).toMatchObject({
      status: 'failed',
      setup_state: { failed_step: 'zone_lookup' },
    });
    expect(String(body.domain.error)).toContain(FOREIGN_ZONE.accountId);
    expect(String(body.domain.error)).toContain(CF_ACCOUNT_ID);
    expect(String(body.domain.error)).toContain('--token-stdin');
    // Zone lookup only — nothing was enabled, deployed or written to the zone.
    expect(new Set(tags(stub.calls))).toEqual(new Set(['zones']));
    expect((await rowFor('elsewhere.test'))?.status).toBe('failed');
  });

  test('a pasted token registers a zone elsewhere as an api_token admin row', async () => {
    const project = await seedProject();
    const stub = stubCustomerCf({ zones: { 'elsewhere.test': FOREIGN_ZONE } });
    const preview = await req('/email/domains', {
      domain: 'elsewhere.test',
      project: project.id,
      apiToken: CUSTOMER_TOKEN,
      dryRun: true,
    });
    expect(await preview.json()).toMatchObject({ target: { credentialKind: 'api_token' } });

    const response = await req('/email/domains', {
      domain: 'elsewhere.test',
      project: project.id,
      apiToken: CUSTOMER_TOKEN,
    });
    expect(response.status).toBe(200);
    const row = (await rowFor('elsewhere.test'))!;
    expect(row).toMatchObject({
      credential_kind: 'api_token',
      managed_by: 'admin',
      status: 'active',
      account_id: FOREIGN_ZONE.accountId,
    });
    expect(row.token_ciphertext).not.toBeNull();
    expect(callsByTag(stub.calls, 'verifyToken')).toHaveLength(1);
    const recorded = await events();
    expect(JSON.stringify(recorded)).not.toContain(CUSTOMER_TOKEN);
  });

  test('does not take over a row the project owner registered', async () => {
    const project = await seedProject();
    await seedOwnerDomain(project.id, 'owned.test');
    const stub = stubCustomerCf({ zones: { 'owned.test': FOREIGN_ZONE } });
    const response = await req('/email/domains', { domain: 'owned.test', project: project.id });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('registered by its project owner'),
    });
    expect(stub.calls).toEqual([]);
    expect((await rowFor('owned.test'))?.managed_by).toBe('owner');
  });

  test('refuses a domain registered to another project', async () => {
    const project = await seedProject();
    const other = await seedProject('other-app');
    await seedOwnerDomain(other.id, 'taken.test');
    const response = await req('/email/domains', { domain: 'taken.test', project: project.id });
    expect(response.status).toBe(409);
  });

  test.each([
    ['an unknown project', { domain: 'example.com', project: 'nope' }, 404],
    ['an invalid domain', { domain: 'not a domain', project: 'hr-portal' }, 400],
    ['a missing project', { domain: 'example.com' }, 400],
  ])('rejects %s', async (_label, body, status) => {
    await seedProject();
    const response = await req('/email/domains', body);
    expect(response.status).toBe(status);
  });

  test('answers 503 when the platform has no runtime token', async () => {
    const project = await seedProject();
    stubCustomerCf({ zones: { 'example.com': PLATFORM_ZONE } });
    const response = await req(
      '/email/domains',
      { domain: 'example.com', project: project.id },
      { CF_API_TOKEN: '' },
    );
    expect(response.status).toBe(503);
    expect(await rowFor('example.com')).toBeUndefined();
  });
});

describe('operator email domain list, status, sync and remove', () => {
  async function addPlatformDomain(projectId: string, domain = 'example.com') {
    const stub = stubCustomerCf({ zones: { [domain]: { ...PLATFORM_ZONE, name: domain } } });
    const response = await req('/email/domains', { domain, project: projectId });
    expect(response.status).toBe(200);
    return stub;
  }

  test("lists every row with its project, or one project's rows", async () => {
    const project = await seedProject();
    const other = await seedProject('other-app');
    await addPlatformDomain(project.id);
    await seedOwnerDomain(other.id, 'owned.test');

    const all = (await (await req('/email/domains')).json()) as {
      domains: Array<{ domain: string; managed_by: string; project: { slug: string } }>;
    };
    expect(all.domains.map((d) => [d.domain, d.managed_by, d.project.slug])).toEqual([
      ['example.com', 'admin', project.slug],
      ['owned.test', 'owner', other.slug],
    ]);
    const filtered = (await (await req(`/email/domains?project=${other.slug}`)).json()) as {
      domains: Array<{ domain: string }>;
    };
    expect(filtered.domains.map((d) => d.domain)).toEqual(['owned.test']);
    expect((await req('/email/domains?project=missing')).status).toBe(404);
  });

  test('status probes a platform row with a zone-scoped read, never token verify', async () => {
    const project = await seedProject();
    await addPlatformDomain(project.id);
    const stub = stubCustomerCf({ zones: { 'example.com': PLATFORM_ZONE } });
    const response = await req('/email/domains/example.com');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      domain: 'example.com',
      credential_kind: 'platform',
      managed_by: 'admin',
      credential_status: 'active',
      project: { id: project.id, slug: project.slug },
    });
    expect(callsByTag(stub.calls, 'verifyToken')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'routingSettingsGet').length).toBeGreaterThan(0);
  });

  test('status reports probe_failed, not revoked, when the runtime token is refused', async () => {
    const project = await seedProject();
    await addPlatformDomain(project.id);
    stubCustomerCf({
      zones: { 'example.com': PLATFORM_ZONE },
      failOn: { routingSettingsGet: { message: 'forbidden', status: 403 } },
    });
    const body = (await (await req('/email/domains/example.com')).json()) as Record<
      string,
      unknown
    >;
    expect(body.credential_status).toBe('probe_failed');
    expect(body.status).toBe('active');
    expect((await rowFor('example.com'))?.status).toBe('active');
  });

  test('sync previews, then redeploys the relay and rotates its secret', async () => {
    const project = await seedProject();
    await addPlatformDomain(project.id);
    const before = (await rowFor('example.com'))!;
    const stub = stubCustomerCf({ zones: { 'example.com': PLATFORM_ZONE } });

    const preview = await req('/email/domains/example.com/sync', { dryRun: true });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.domain.sync',
      target: { domain: 'example.com', projectId: project.id },
    });
    expect(stub.calls).toEqual([]);

    const response = await req('/email/domains/example.com/sync', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'email.domain.sync' });
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(1);
    const after = (await rowFor('example.com'))!;
    expect(after.relay_ciphertext).not.toBe(before.relay_ciphertext);
    expect(after.credential_kind).toBe('platform');
    const recorded = await events();
    expect(recorded.map((event) => event.action)).toEqual([
      'email/domains',
      'email/domains/example.com/sync',
    ]);
    expect(JSON.parse(recorded[1]!.target)).toEqual({ domain: 'example.com' });
  });

  test('remove resets the catch-all, deletes the relay and drops the row', async () => {
    const project = await seedProject();
    await addPlatformDomain(project.id);
    const stub = stubCustomerCf({
      zones: { 'example.com': PLATFORM_ZONE },
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const preview = await req('/email/domains/example.com/remove', { dryRun: true });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.domain.remove',
      target: { domain: 'example.com', force: false },
      managed_by: 'admin',
    });
    const response = await req('/email/domains/example.com/remove', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'email.domain.remove',
      domain: { ok: true, removed: true },
    });
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
    expect(await rowFor('example.com')).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:example.com')).toBeNull();
    const recorded = await events();
    expect(JSON.parse(recorded.at(-1)!.target)).toEqual({ domain: 'example.com', force: false });
  });

  test('remove --force is a JSON boolean and drops the row past a failed relay delete', async () => {
    const project = await seedProject();
    await addPlatformDomain(project.id);
    stubCustomerCf({
      zones: { 'example.com': PLATFORM_ZONE },
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { scriptDelete: { message: 'boom', status: 500 } },
    });
    expect((await req('/email/domains/example.com/remove', { force: 'yes' })).status).toBe(400);
    const response = await req('/email/domains/example.com/remove', { force: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      domain: { ok: true, removed: true, forced: true },
    });
    expect(await rowFor('example.com')).toBeUndefined();
  });

  test('status, sync and remove answer 404 for an unknown domain', async () => {
    expect((await req('/email/domains/nope.test')).status).toBe(404);
    expect((await req('/email/domains/nope.test/sync', {})).status).toBe(404);
    expect((await req('/email/domains/nope.test/remove', {})).status).toBe(404);
  });

  test('the proxy leases the runtime token for a platform row', async () => {
    const project = await seedProject();
    await addPlatformDomain(project.id);
    const response = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-void-internal': await hmacSignState('example.com', JWT_SECRET),
        },
        body: JSON.stringify({ domain: 'example.com' }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'api_token', token: CF_API_TOKEN });
  });
});
