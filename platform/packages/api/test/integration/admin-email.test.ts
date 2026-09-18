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
import { createEmailDestination, getEmailDestinationsByProjectId } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { emailProjectControls } from '../../src/email/admission-schema.ts';
import { setProjectEmailLimits, setProjectEmailSuspended } from '../../src/email/admission.ts';
import { emailDomainRoutes, emailZoneConnections } from '../../src/email/connection-schema.ts';
import { refreshOauthGrantSerialized } from '../../src/email/credential-lease.ts';
import {
  encryptEmailDomainRelaySecret,
  encryptEmailDomainToken,
  hashEmailRelaySecret,
  writeEmailDomainMirror,
  type EmailDomain,
} from '../../src/email/domains.ts';
import { app } from '../../src/index.ts';
import { emailDomains, operatorEvents, platformSettings } from '../../src/schema.ts';
import { stubCustomerCf, callsByTag } from './email-domain-cf-stub.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  type TestEnv,
} from './helpers.ts';
import { CF_ACCOUNT_ID } from './helpers.ts';
import { setTestDb } from './setup.ts';

let env: TestEnv;

/**
 * Pause the app's FIRST `db.transaction` until released — the seam for
 * landing a committed write (a credential replace) between a route's
 * unlocked entry checks and its serialized section. PGlite's single
 * connection forbids touching the db from inside an open transaction, so
 * the write must happen BEFORE the tx starts: the proxy pauses prior to
 * delegating, the test writes through the unwrapped `realDb`, then
 * releases. Same pattern as api-email-domains.test.ts.
 */
function pauseFirstTransaction(realDb: Db): {
  wrappedDb: Db;
  reached: Promise<void>;
  release: () => void;
} {
  const realTransaction = realDb.transaction.bind(realDb);
  let releaseFn: (() => void) | undefined;
  let reachedFn: (() => void) | undefined;
  const reached = new Promise<void>((r) => {
    reachedFn = r;
  });
  let fired = false;
  const wrappedDb = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (async (fn: never) => {
          if (!fired) {
            fired = true;
            reachedFn?.();
            await new Promise<void>((r) => {
              releaseFn = r;
            });
          }
          return realTransaction(fn);
        }) as unknown as typeof realDb.transaction;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  return { wrappedDb, reached, release: () => releaseFn?.() };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  Object.assign(env, { EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Records the Cloudflare Email Routing calls the route makes and answers each
 * one with a success envelope, so a test can assert whether the account-level
 * destination was deleted upstream.
 */
function recordCfCalls(): Array<string> {
  const calls: Array<string> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return Response.json({ success: true, errors: [], result: { tag: 'cf-tag' } });
  });
  return calls;
}

/**
 * Fail this project's allowlist mirror write (both branches — the `put` and
 * the delete-on-empty), leaving every other KV op intact. Restored by the
 * file-level `vi.restoreAllMocks()`.
 */
function breakAllowlistWrites(projectId: string): void {
  const key = `email-allowlist:${projectId}`;
  const originalPut = env.ROUTING.put.bind(env.ROUTING);
  const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
  vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
    k: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ) => {
    if (k === key) {
      throw new Error('forced allowlist KV failure for test');
    }
    return originalPut(k, value as never, options as never);
  }) as typeof env.ROUTING.put);
  vi.spyOn(env.ROUTING, 'delete').mockImplementation((async (k: string) => {
    if (k === key) {
      throw new Error('forced allowlist KV failure for test');
    }
    return originalDelete(k as never);
  }) as typeof env.ROUTING.delete);
}

/** UTC `YYYY-MM`, the bucket `admin/routes/email.tsx` and the proxy both use. */
function monthBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function get(path: string, cookie: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Cookie: `admin_token=${cookie}` },
      redirect: 'manual',
    }),
    env,
  );
}

/**
 * A same-origin admin form post. `Origin` is what a real browser sends and what
 * the admin auth middleware checks, so every legitimate write in these tests
 * carries it — the cross-origin cases below build their requests by hand.
 */
async function post(
  path: string,
  cookie: string,
  fields: Record<string, string> = {},
  origin: string | null = 'http://localhost',
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: `admin_token=${cookie}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (origin !== null) {
    headers.Origin = origin;
  }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    env,
  );
}

async function seedAdminAndProject(): Promise<{
  adminJwt: string;
  projectId: string;
  slug: string;
}> {
  const admin = await createTestUser(env.db, 'admin-email', 'github', undefined, 'free', 'admin');
  const owner = await createTestUser(env.db, 'email-owner');
  const project = await createTestProject(env.db, owner.id);
  return { adminJwt: admin.adminJwt, projectId: project.id, slug: project.slug };
}

describe('admin write guard (cross-origin)', () => {
  test('rejects a write with no Origin and no Referer', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(
      `/admin/email/${projectId}/suspend`,
      adminJwt,
      { state: 'suspended' },
      null,
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'cross-site request blocked',
    });
    // The guard must run before the handler, not merely alongside it.
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });

  test('rejects a write whose Origin is another site', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(
      `/admin/email/${projectId}/suspend`,
      adminJwt,
      { state: 'suspended' },
      'https://evil.example.com',
    );

    expect(res.status).toBe(403);
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });

  test('accepts a write whose Referer is same-origin (no Origin header)', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await app.fetch(
      new Request(`http://localhost/admin/email/${projectId}/suspend`, {
        method: 'POST',
        headers: {
          Cookie: `admin_token=${adminJwt}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `http://localhost/admin/email/${projectId}`,
        },
        body: 'state=suspended',
        redirect: 'manual',
      }),
      env,
    );

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).not.toBeNull();
  });

  test('leaves reads alone', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await get(`/admin/email/${projectId}`, adminJwt);

    expect(res.status).toBe(200);
  });
});

describe('GET /admin/email/:projectId', () => {
  test('renders usage, the platform defaults, and the destination list', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const month = monthBucket();
    await env.ROUTING.put(`email-sent:${projectId}:${month}`, '7');
    await env.ROUTING.put(`email-recv:${projectId}:${month}`, '3');

    const res = await get(`/admin/email/${projectId}`, adminJwt);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(slug);
    expect(html).toContain('0 / 200');
    expect(html).toContain('(default)');
    expect(html).toContain('Suspend email');
    expect(html).toContain('No destinations yet.');
  });

  test('labels an override as such and shows the suspended state', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await setProjectEmailLimits(env.db, projectId, { monthly: 1000 });
    await setProjectEmailSuspended(env.db, projectId, true);

    const html = await (await get(`/admin/email/${projectId}`, adminJwt)).text();

    expect(html).toContain('0 / 1000');
    expect(html).toContain('(override)');
    expect(html).toContain('SUSPENDED');
    expect(html).toContain('Unsuspend email');
  });

  test('404s for an unknown project', async () => {
    const admin = await createTestUser(env.db, 'admin-404', 'github', undefined, 'free', 'admin');

    const res = await get('/admin/email/proj_does_not_exist', admin.adminJwt);

    expect(res.status).toBe(404);
  });
});

describe('POST /admin/email/:projectId/suspend', () => {
  test('suspending sets the kill-switch key', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/email/${projectId}`);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).not.toBeNull();
  });

  test('unsuspending clears it', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await setProjectEmailSuspended(env.db, projectId, true);

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'active' });

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).toBeNull();
  });

  test('suspending twice is idempotent, not a toggle', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });
    await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });

    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).not.toBeNull();
  });

  test('rejects a state that is neither terminal value', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'toggle' });

    expect(res.status).toBe(400);
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });
});

describe('POST /admin/email/:projectId/limit', () => {
  test('sets a monthly override', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit: '5000' });

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.monthly_limit,
    ).toBe(5000);
  });

  test('a blank value drops the override back to the platform default', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await setProjectEmailLimits(env.db, projectId, { monthly: 5000 });

    const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit: '  ' });

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.monthly_limit,
    ).toBe(200);
  });

  test('rejects a value the proxy would not honour', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    for (const limit of ['0', '-5', 'lots']) {
      const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit });
      expect(res.status).toBe(400);
    }
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBeNull();
  });

  test('sets and clears the burst override on its own key', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    await post(`/admin/email/${projectId}/burst-limit`, adminJwt, { burstLimit: '60' });
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.burst_limit,
    ).toBe(60);
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBeNull();

    await post(`/admin/email/${projectId}/burst-limit`, adminJwt, { burstLimit: '' });
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.burst_limit,
    ).toBe(10);
  });
});

describe('POST /admin/email/:projectId/destinations/:destId/delete', () => {
  test('removes the row, drops the CF address, and re-syncs the allowlist', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const destination = await createEmailDestination(
      env.db,
      projectId,
      'ops@example.com',
      'cf-tag-ops',
      'verified',
    );
    await env.ROUTING.put(`email-allowlist:${projectId}`, JSON.stringify(['ops@example.com']));
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([
      'DELETE https://api.cloudflare.com/client/v4/accounts/test-account-id/email/routing/addresses/cf-tag-ops',
    ]);
    // Last verified row gone, so the proxy's allowlist key is removed rather
    // than left holding an address the project may no longer send to.
    expect(await env.ROUTING.get(`email-allowlist:${projectId}`)).toBeNull();
  });

  test('leaves the CF address alone while another project still references it', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const sibling = await createTestProject(env.db, (await createTestUser(env.db)).id);
    const destination = await createEmailDestination(
      env.db,
      projectId,
      'shared@example.com',
      'cf-tag-shared',
      'verified',
    );
    await createEmailDestination(
      env.db,
      sibling.id,
      'shared@example.com',
      'cf-tag-shared',
      'verified',
    );
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([]);
  });

  test('tightens the mirror while the revoked row is still present', async () => {
    // Same ordering contract as the user-facing revoke in `routes/email.ts`.
    // The mirror is what the proxy enforces and the row is what a retry
    // re-derives it from, so the write lands FIRST and must already exclude
    // the row being revoked — it is still `verified` at that instant.
    const { adminJwt, projectId } = await seedAdminAndProject();
    await createEmailDestination(env.db, projectId, 'keep@example.com', 'cf-tag-keep', 'verified');
    const doomed = await createEmailDestination(
      env.db,
      projectId,
      'gone@example.com',
      'cf-tag-gone',
      'verified',
    );

    const observed: Array<{ written: Array<string>; rowIds: Array<string> }> = [];
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      k: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      await originalPut(k, value as never, options as never);
      if (k === `email-allowlist:${projectId}`) {
        const rows = await getEmailDestinationsByProjectId(env.db, projectId);
        observed.push({
          written: JSON.parse(String(value)) as Array<string>,
          rowIds: rows.map((r) => r.id).sort(),
        });
      }
    }) as typeof env.ROUTING.put);

    const res = await post(`/admin/email/${projectId}/destinations/${doomed.id}/delete`, adminJwt);

    expect(res.status).toBe(302);
    // Two writes: the tighten with both rows still present, then the
    // re-derive after the delete (a confirm click can promote a row between
    // the snapshot and the delete; deriving afterwards cannot include it).
    expect(observed).toHaveLength(2);
    expect(observed[0]?.written).toEqual(['keep@example.com']);
    // Both rows still there at the moment of the first write.
    expect(observed[0]?.rowIds).toContain(doomed.id);
    expect(observed[1]?.written).toEqual(['keep@example.com']);
    expect(observed[1]?.rowIds).not.toContain(doomed.id);
    expect(await env.ROUTING.get(`email-allowlist:${projectId}`)).toBe(
      JSON.stringify(['keep@example.com']),
    );
  });

  test('keeps the row and fails the revoke when the mirror write fails', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const destination = await createEmailDestination(
      env.db,
      projectId,
      'gone@example.com',
      'cf-tag-gone',
      'verified',
    );
    await env.ROUTING.put(`email-allowlist:${projectId}`, JSON.stringify(['gone@example.com']));
    breakAllowlistWrites(projectId);
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    // Nothing destructive ran, so the operator can just click again. Dropping
    // the row first and swallowing the KV error would strand the revoked
    // address in the allowlist with no row left to re-derive it from.
    expect(res.status).toBe(503);
    expect(await getEmailDestinationsByProjectId(env.db, projectId)).toHaveLength(1);
    expect(await env.ROUTING.get(`email-allowlist:${projectId}`)).toBe(
      JSON.stringify(['gone@example.com']),
    );
    expect(cfCalls).toEqual([]);
  });

  test('404s for a destination that belongs to another project', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const sibling = await createTestProject(env.db, (await createTestUser(env.db)).id);
    const destination = await createEmailDestination(
      env.db,
      sibling.id,
      'elsewhere@example.com',
      'cf-tag-elsewhere',
      'verified',
    );
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(404);
    expect(cfCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Custom email domains (design doc 0078). The admin page lists the project's
// email_domains rows; the revoke route clears the ROUTING mirror, best-effort
// deletes the relay + catch-all in the customer's account via the relay
// engine, then drops the row. All credential-shaped strings are dummy
// stand-ins, and no assertion may contain one — the page and the error
// bodies must never render them.
// ---------------------------------------------------------------------------

// Dummy stand-ins — never real token/secret material.
const CUSTOMER_TOKEN = 'cf-customer-token-dummy';
const GRANT_REFRESH_TOKEN = 'cf-grant-refresh-dummy';
const RELAY_SECRET = 'admin-relay-secret-dummy';

/**
 * Seed an email_domains row directly (no orchestration), always with its
 * ROUTING mirror — the revoke's first job is clearing that key. `deployed:
 * false` seeds a row whose setup failed before the relay deploy, so there is
 * nothing in the customer account to clean up. Domains must be unique per
 * test: ROUTING is file-scoped here and the mirror key is domain-scoped.
 */
async function seedEmailDomain(
  projectId: string,
  domain: string,
  options: {
    status?: EmailDomain['status'];
    deployed?: boolean;
    credentialKind?: EmailDomain['credential_kind'];
  } = {},
): Promise<EmailDomain> {
  const deployed = options.deployed ?? true;
  const credentialKind = options.credentialKind ?? 'api_token';
  // The stored credential is the pasted API token, or the grant's refresh
  // token on the oauth_grant path.
  const tokenEnc = await encryptEmailDomainToken(
    env,
    projectId,
    domain,
    credentialKind === 'oauth_grant' ? GRANT_REFRESH_TOKEN : CUSTOMER_TOKEN,
  );
  const relayEnc = await encryptEmailDomainRelaySecret(env, projectId, domain, RELAY_SECRET);
  await env.db.insert(emailDomains).values({
    id: `edom_admin_${domain.replace(/[^a-z0-9]/g, '')}`,
    project_id: projectId,
    domain,
    zone_id: deployed ? 'zone_customer_1' : null,
    account_id: deployed ? 'acct_customer_1' : null,
    mode: deployed ? 'apex' : null,
    status: options.status ?? 'active',
    credential_kind: credentialKind,
    token_ciphertext: tokenEnc.ciphertext,
    token_iv: tokenEnc.iv,
    token_key_version: tokenEnc.keyVersion,
    relay_ciphertext: relayEnc.ciphertext,
    relay_iv: relayEnc.iv,
    relay_key_version: relayEnc.keyVersion,
    relay_worker_name: deployed ? 'void-email-relay' : null,
    relay_version: deployed ? 1 : null,
    token_id: deployed ? 'tok_dummy' : null,
    token_expires_on: null,
    setup_state: deployed ? null : { failed_step: 'zone_lookup' },
  });
  const row = (await domainRow(projectId, domain))!;
  await writeEmailDomainMirror(env.ROUTING, row, await hashEmailRelaySecret(RELAY_SECRET));
  return row;
}

async function domainRow(projectId: string, domain: string): Promise<EmailDomain | undefined> {
  const rows = await env.db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.project_id, projectId));
  return rows.find((row) => row.domain === domain);
}

/**
 * Record the customer-account CF calls the relay engine makes (method, url,
 * parsed JSON body) and answer each with a success envelope. The remove path
 * DELETEs the relay script and resets the catch-all — but only after an
 * ownership read, so the catch-all GET answers with a rule naming this
 * row's relay. The OAuth grant revoke (dash.cloudflare.com — NOT
 * api.cloudflare.com) is tagged `oauthRevoke` so a test can assert it fired.
 */
function recordCustomerCfCalls(): Array<{
  method: string;
  url: string;
  body?: unknown;
  tag?: 'oauthRevoke' | 'oauthToken';
}> {
  const calls: Array<{
    method: string;
    url: string;
    body?: unknown;
    tag?: 'oauthRevoke' | 'oauthToken';
  }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    const method = init?.method ?? 'GET';
    const isTokenEndpoint = url.startsWith('https://dash.cloudflare.com/oauth2/token');
    calls.push({
      method,
      url,
      body,
      ...(isTokenEndpoint ? { tag: 'oauthToken' as const } : {}),
      ...(url.startsWith('https://dash.cloudflare.com/oauth2/revoke')
        ? { tag: 'oauthRevoke' as const }
        : {}),
    });
    if (isTokenEndpoint) {
      // Grant refresh tokens rotate on every use; the caller persists this
      // replacement and revokes the chain HEAD, not the presented token.
      return Response.json({
        access_token: 'cf-access-dummy-1',
        refresh_token: 'cf-rotated-refresh-dummy-1',
        expires_in: 3600,
      });
    }
    if (method === 'GET' && url.includes('/email/routing/rules/catch_all')) {
      return Response.json({
        success: true,
        errors: [],
        result: {
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: ['void-email-relay'] }],
        },
      });
    }
    return Response.json({ success: true, errors: [], result: {} });
  });
  return calls;
}

/** Every CF call fails — the revoke must still complete (cleanup is best-effort). */
function failCustomerCfCalls(): Array<string> {
  const calls: Array<string> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return Response.json({ success: false, errors: [{ message: 'boom' }] }, { status: 500 });
  });
  return calls;
}

/** Fail one domain's mirror-key delete, leaving every other KV op intact. */
function breakMirrorDelete(domain: string): void {
  const key = `email-domain:${domain}`;
  const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
  vi.spyOn(env.ROUTING, 'delete').mockImplementation((async (k: string) => {
    if (k === key) {
      throw new Error('forced mirror KV failure for test');
    }
    return originalDelete(k as never);
  }) as typeof env.ROUTING.delete);
}

describe('admin email domain controls', () => {
  test('registers, rotates and removes an exact route without exposing credential material', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const stub = stubCustomerCf({
      zones: {
        'example.com': { id: 'zone-platform', name: 'example.com', accountId: CF_ACCOUNT_ID },
      },
    });
    const add = await post(`/admin/email/${projectId}/domains/add`, adminJwt, {
      domain: 'mail.example.com',
    });
    expect(add.status).toBe(302);
    const html = await (await get(`/admin/email/${projectId}`, adminJwt)).text();
    expect(html).toContain('mail.example.com');
    expect(html).toContain('rotate secret');
    expect(html).not.toContain(env.CF_API_TOKEN);
    expect(await env.db.select().from(emailZoneConnections)).toHaveLength(1);
    const rotate = await post(
      `/admin/email/${projectId}/domains/mail.example.com/rotate-secret`,
      adminJwt,
    );
    expect(rotate.status).toBe(302);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
    const unconfirmed = await post(
      `/admin/email/${projectId}/domains/mail.example.com/revoke`,
      adminJwt,
      { confirm: 'wrong' },
    );
    expect(unconfirmed.status).toBe(400);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('active');
    const removed = await post(
      `/admin/email/${projectId}/domains/mail.example.com/revoke`,
      adminJwt,
      { confirm: slug },
    );
    expect(removed.status).toBe(302);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('removed');
  });
});
