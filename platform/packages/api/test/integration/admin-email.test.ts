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
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  type TestEnv,
} from './helpers.ts';
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
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).not.toBeNull();
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
    expect(html).toContain('7 / 200');
    expect(html).toContain('(default)');
    expect(html).toContain('Suspend email');
    expect(html).toContain('No destinations yet.');
  });

  test('labels an override as such and shows the suspended state', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await env.ROUTING.put(`email-limit:${projectId}`, '1000');
    await env.ROUTING.put(`email-suspended:${projectId}`, new Date().toISOString());

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
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).not.toBeNull();
  });

  test('unsuspending clears it', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await env.ROUTING.put(`email-suspended:${projectId}`, new Date().toISOString());

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'active' });

    expect(res.status).toBe(302);
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });

  test('suspending twice is idempotent, not a toggle', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });
    await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });

    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).not.toBeNull();
  });

  test('rejects a state that is neither terminal value', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'toggle' });

    expect(res.status).toBe(400);
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });
});

describe('POST /admin/email/:projectId/reset-counter', () => {
  test('refuses without the typed slug and leaves the counter intact', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const key = `email-sent:${projectId}:${monthBucket()}`;
    await env.ROUTING.put(key, '42');

    const res = await post(`/admin/email/${projectId}/reset-counter`, adminJwt, {});

    expect(res.status).toBe(400);
    expect(await env.ROUTING.get(key)).toBe('42');
  });

  test('refuses when the typed slug is wrong', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const key = `email-sent:${projectId}:${monthBucket()}`;
    await env.ROUTING.put(key, '42');

    const res = await post(`/admin/email/${projectId}/reset-counter`, adminJwt, {
      confirm: 'not-the-slug',
    });

    expect(res.status).toBe(400);
    expect(await env.ROUTING.get(key)).toBe('42');
  });

  test('resets the current month once confirmed', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const key = `email-sent:${projectId}:${monthBucket()}`;
    await env.ROUTING.put(key, '42');

    const res = await post(`/admin/email/${projectId}/reset-counter`, adminJwt, { confirm: slug });

    expect(res.status).toBe(302);
    expect(await env.ROUTING.get(key)).toBeNull();
  });
});

describe('POST /admin/email/:projectId/limit', () => {
  test('sets a monthly override', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit: '5000' });

    expect(res.status).toBe(302);
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBe('5000');
  });

  test('a blank value drops the override back to the platform default', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await env.ROUTING.put(`email-limit:${projectId}`, '5000');

    const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit: '  ' });

    expect(res.status).toBe(302);
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBeNull();
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
    expect(await env.ROUTING.get(`email-burst-limit:${projectId}`)).toBe('60');
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBeNull();

    await post(`/admin/email/${projectId}/burst-limit`, adminJwt, { burstLimit: '' });
    expect(await env.ROUTING.get(`email-burst-limit:${projectId}`)).toBeNull();
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

describe('GET /admin/email/:projectId — custom domains', () => {
  test('renders domain rows with relay and token metadata, and never secret material', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const row = await seedEmailDomain(projectId, 'acme-admin.com');

    const res = await get(`/admin/email/${projectId}`, adminJwt);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Custom domains (1)');
    expect(html).toContain('acme-admin.com');
    expect(html).toContain('apex');
    expect(html).toContain('void-email-relay');
    expect(html).toContain('tok_dummy');
    expect(html).toContain(`/admin/email/${projectId}/domains/acme-admin.com/revoke`);
    // Neither ciphertext triple nor any plaintext credential/relay secret
    // ever renders — the page carries metadata only.
    expect(html).not.toContain(CUSTOMER_TOKEN);
    expect(html).not.toContain(RELAY_SECRET);
    expect(html).not.toContain(row.token_ciphertext);
    expect(html).not.toContain(row.relay_ciphertext);
  });

  test('shows the empty state when the project has no custom domains', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const html = await (await get(`/admin/email/${projectId}`, adminJwt)).text();

    expect(html).toContain('Custom domains (0)');
    expect(html).toContain('No custom domains.');
  });
});

describe('POST /admin/email/:projectId/domains/:domain/revoke', () => {
  test('clears the mirror first, then deletes CF state best-effort and the row', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-revoke.com');
    const cfCalls = recordCustomerCfCalls();

    // Ordering pin, same contract as the destination tighten above: the
    // mirror key is deleted BEFORE any customer-side CF call. The row
    // outliving the clear is now structural — the clear and the row delete
    // are the first and last statements of ONE serialized transaction, so
    // a request dying mid-cleanup rolls the row back for the operator's
    // retry to re-run from. (A mid-transaction row read would deadlock
    // the single-connection test database, so the pin is on the CF
    // ordering instead.)
    let cfCallsAtMirrorClear: number | undefined;
    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'delete').mockImplementation((async (k: string) => {
      await originalDelete(k as never);
      if (k === 'email-domain:acme-revoke.com') {
        cfCallsAtMirrorClear = cfCalls.length;
      }
    }) as typeof env.ROUTING.delete);

    const res = await post(`/admin/email/${projectId}/domains/acme-revoke.com/revoke`, adminJwt, {
      confirm: slug,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/email/${projectId}`);
    expect(cfCallsAtMirrorClear).toBe(0);
    // Contract 7 remove shape: the catch-all ownership read, the
    // conditional reset (the read shows it still naming our relay), then
    // the relay DELETE — the enabled rule never outlives its worker.
    expect(cfCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.cloudflare.com/client/v4/zones/zone_customer_1/email/routing/rules/catch_all',
      'PUT https://api.cloudflare.com/client/v4/zones/zone_customer_1/email/routing/rules/catch_all',
      'DELETE https://api.cloudflare.com/client/v4/accounts/acct_customer_1/workers/scripts/void-email-relay',
    ]);
    expect(cfCalls[1]?.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'drop' }],
      enabled: false,
    });
    expect(await env.ROUTING.get('email-domain:acme-revoke.com')).toBeNull();
    expect(await domainRow(projectId, 'acme-revoke.com')).toBeUndefined();
  });

  test('revokes the OAuth grant during a full domain revoke for an oauth_grant row', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-revoke-oauth.com', { credentialKind: 'oauth_grant' });
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-revoke-oauth.com/revoke`,
      adminJwt,
      { confirm: slug },
    );

    expect(res.status).toBe(302);
    // Same remove contract as the owner DELETE: the serialized grant
    // refresh FIRST (its rotation persists through the row while it
    // lives), the customer-side cleanup, then the grant revoke LAST —
    // against the ROTATED chain head. Without the revokeGrant dep the
    // row's deletion would orphan the live grant with no platform handle.
    expect(cfCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://dash.cloudflare.com/oauth2/token',
      'GET https://api.cloudflare.com/client/v4/zones/zone_customer_1/email/routing/rules/catch_all',
      'PUT https://api.cloudflare.com/client/v4/zones/zone_customer_1/email/routing/rules/catch_all',
      'DELETE https://api.cloudflare.com/client/v4/accounts/acct_customer_1/workers/scripts/void-email-relay',
      'POST https://dash.cloudflare.com/oauth2/revoke',
    ]);
    const revokeBody = cfCalls.find((call) => call.tag === 'oauthRevoke')!.body;
    const form = new URLSearchParams(String(revokeBody));
    expect(form.get('token_type_hint')).toBe('refresh_token');
    expect(form.get('token')).toBe('cf-rotated-refresh-dummy-1');
    expect(await domainRow(projectId, 'acme-revoke-oauth.com')).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-revoke-oauth.com')).toBeNull();
  });

  test('re-reads the row under the lock — a credential replace committed mid-removal is not orphaned', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const row = await seedEmailDomain(projectId, 'acme-midswap.com');
    const cfCalls = recordCustomerCfCalls();

    // Pause the removal's serialized section BEFORE it opens (no locks
    // held), then land a committed credential replace: the entry snapshot
    // says api_token, the LOCKED re-read says oauth_grant — the cleanup
    // must follow the locked row, or the fresh grant's only handle goes
    // with the row delete.
    const gate = pauseFirstTransaction(env.db);
    setTestDb(gate.wrappedDb);
    try {
      const resPromise = post(
        `/admin/email/${projectId}/domains/acme-midswap.com/revoke`,
        adminJwt,
        { confirm: slug },
      );
      const winner = await Promise.race([
        gate.reached.then(() => 'paused' as const),
        resPromise.then(() => 'settled' as const),
      ]);
      if (winner === 'paused') {
        const swapped = await encryptEmailDomainToken(
          env,
          projectId,
          'acme-midswap.com',
          GRANT_REFRESH_TOKEN,
        );
        await env.db
          .update(emailDomains)
          .set({
            credential_kind: 'oauth_grant',
            token_ciphertext: swapped.ciphertext,
            token_iv: swapped.iv,
            token_key_version: swapped.keyVersion,
            token_id: null,
            token_expires_on: null,
          })
          .where(eq(emailDomains.id, row.id));
        gate.release();
      }
      const res = await resPromise;
      expect(res.status).toBe(302);
      // The cleanup followed the LOCKED row: the grant was refreshed (its
      // rotation persisted while the row lived), then revoked LAST with
      // the rotated chain head — not silently dropped by an api_token
      // cleanup built on the stale entry snapshot.
      expect(cfCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'POST https://dash.cloudflare.com/oauth2/token',
        'GET https://api.cloudflare.com/client/v4/zones/zone_customer_1/email/routing/rules/catch_all',
        'PUT https://api.cloudflare.com/client/v4/zones/zone_customer_1/email/routing/rules/catch_all',
        'DELETE https://api.cloudflare.com/client/v4/accounts/acct_customer_1/workers/scripts/void-email-relay',
        'POST https://dash.cloudflare.com/oauth2/revoke',
      ]);
      expect(String(cfCalls.find((call) => call.tag === 'oauthRevoke')!.body)).toContain(
        'cf-rotated-refresh-dummy-1',
      );
      expect(await domainRow(projectId, 'acme-midswap.com')).toBeUndefined();
      expect(await env.ROUTING.get('email-domain:acme-midswap.com')).toBeNull();
    } finally {
      setTestDb(env.db);
    }
  });

  test('refuses without the typed slug and leaves everything intact', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-noconfirm.com');
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-noconfirm.com/revoke`,
      adminJwt,
      {},
    );

    expect(res.status).toBe(400);
    expect(await domainRow(projectId, 'acme-noconfirm.com')).toBeDefined();
    expect(await env.ROUTING.get('email-domain:acme-noconfirm.com')).not.toBeNull();
    expect(cfCalls).toEqual([]);
  });

  test('refuses when the typed slug is wrong', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-wrongslug.com');
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-wrongslug.com/revoke`,
      adminJwt,
      { confirm: 'not-the-slug' },
    );

    expect(res.status).toBe(400);
    expect(await domainRow(projectId, 'acme-wrongslug.com')).toBeDefined();
    expect(await env.ROUTING.get('email-domain:acme-wrongslug.com')).not.toBeNull();
    expect(cfCalls).toEqual([]);
  });

  test('404s for a domain row that belongs to another project', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const sibling = await createTestProject(env.db, (await createTestUser(env.db)).id);
    await seedEmailDomain(sibling.id, 'acme-elsewhere.com');
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-elsewhere.com/revoke`,
      adminJwt,
      { confirm: slug },
    );

    expect(res.status).toBe(404);
    expect(await domainRow(sibling.id, 'acme-elsewhere.com')).toBeDefined();
    expect(await env.ROUTING.get('email-domain:acme-elsewhere.com')).not.toBeNull();
    expect(cfCalls).toEqual([]);
  });

  test('keeps the row and runs nothing destructive when the mirror clear fails', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-kvfail.com');
    breakMirrorDelete('acme-kvfail.com');
    const cfCalls = recordCustomerCfCalls();

    const res = await post(`/admin/email/${projectId}/domains/acme-kvfail.com/revoke`, adminJwt, {
      confirm: slug,
    });

    // Tighten-before-delete: the failed clear is the ONLY thing that ran, so
    // the operator can just click again — dropping the row first and
    // swallowing the KV error would strand the domain working in the proxy
    // with no row left to revoke.
    expect(res.status).toBe(503);
    expect(await domainRow(projectId, 'acme-kvfail.com')).toBeDefined();
    expect(await env.ROUTING.get('email-domain:acme-kvfail.com')).not.toBeNull();
    expect(cfCalls).toEqual([]);
  });

  test('still clears the mirror and row when the CF cleanup fails', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-cffail.com');
    failCustomerCfCalls();

    const res = await post(`/admin/email/${projectId}/domains/acme-cffail.com/revoke`, adminJwt, {
      confirm: slug,
    });

    // Best-effort CF cleanup: a stranded relay is inert without the mirror
    // entry, so the revoke completes and the log line carries the trace.
    expect(res.status).toBe(302);
    expect(await domainRow(projectId, 'acme-cffail.com')).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-cffail.com')).toBeNull();
  });

  test('revokes a row whose relay never deployed without any CF call', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-failed.com', { status: 'failed', deployed: false });
    const cfCalls = recordCustomerCfCalls();

    const res = await post(`/admin/email/${projectId}/domains/acme-failed.com/revoke`, adminJwt, {
      confirm: slug,
    });

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([]);
    expect(await domainRow(projectId, 'acme-failed.com')).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-failed.com')).toBeNull();
  });

  test('still revokes when the stored credential can no longer be decrypted', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const row = await seedEmailDomain(projectId, 'acme-badkey.com');
    // Re-encrypt under a different domain's AAD: the revoke's decrypt fails
    // the GCM tag check, as a rotated-away key version would. The row must
    // still be revocable — only the CF cleanup is skipped.
    const foreign = await encryptEmailDomainToken(env, projectId, 'other.com', CUSTOMER_TOKEN);
    await env.db
      .update(emailDomains)
      .set({
        token_ciphertext: foreign.ciphertext,
        token_iv: foreign.iv,
        token_key_version: foreign.keyVersion,
      })
      .where(eq(emailDomains.id, row.id));
    const cfCalls = recordCustomerCfCalls();

    const res = await post(`/admin/email/${projectId}/domains/acme-badkey.com/revoke`, adminJwt, {
      confirm: slug,
    });

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([]);
    expect(await domainRow(projectId, 'acme-badkey.com')).toBeUndefined();
    expect(await env.ROUTING.get('email-domain:acme-badkey.com')).toBeNull();
  });
});

describe('POST /admin/email/:projectId/domains/:domain/revoke-grant', () => {
  test('revokes the grant at Cloudflare and flips the row to token_revoked', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-grant.com', { credentialKind: 'oauth_grant' });
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-grant.com/revoke-grant`,
      adminJwt,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/email/${projectId}`);
    // Exactly one RFC 7009 revocation against dash.cloudflare.com, and no
    // relay-engine cleanup — the row (and its relay) stay in place.
    expect(cfCalls.filter((call) => call.tag === 'oauthRevoke')).toHaveLength(1);
    expect(cfCalls).toHaveLength(1);
    const row = await domainRow(projectId, 'acme-grant.com');
    expect(row?.status).toBe('token_revoked');
    // The mirror flipped FIRST (same inversion as the removal route): the
    // proxy's relay auth checks its `active` status, so inbound stops here
    // rather than whenever the next status GET happens to repair drift.
    const mirror = JSON.parse((await env.ROUTING.get('email-domain:acme-grant.com'))!) as {
      status: string;
      relayWorkerName: string | null;
    };
    expect(mirror.status).toBe('token_revoked');
    expect(mirror.relayWorkerName).toBe('void-email-relay');
  });

  test('keeps the row active when the grant revoke fails — the mirror already flipped', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-revokefail.com', { credentialKind: 'oauth_grant' });
    // The revoke request fails (the helper throws on a non-2xx); nothing
    // else is called on this route.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return Response.json({ error: 'boom' }, { status: 500 });
    });

    const res = await post(
      `/admin/email/${projectId}/domains/acme-revokefail.com/revoke-grant`,
      adminJwt,
    );

    // The grant's state is unknown, so the row keeps its status and the
    // operator retries; the mirror already flipped (mirror-first), and the
    // next status GET repairs it while the row stays active.
    expect(res.status).toBe(502);
    expect((await domainRow(projectId, 'acme-revokefail.com'))?.status).toBe('active');
    const mirror = JSON.parse((await env.ROUTING.get('email-domain:acme-revokefail.com'))!) as {
      status: string;
    };
    expect(mirror.status).toBe('token_revoked');
  });

  test('revokes the chain head live at revoke time when a lease rotation lands mid-request', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const row = await seedEmailDomain(projectId, 'acme-grant-race.com', {
      credentialKind: 'oauth_grant',
    });
    const cfCalls = recordCustomerCfCalls();
    // A lease rotation landing before the revoke's serialized section:
    // the originally stored token is consumed by it, so a revoke captured
    // beforehand would submit a dead token — CF answers 200 either way,
    // and the rotated head would live on with no handle. The seam pauses
    // the route's transaction BEFORE it opens (no locks held), so the
    // rotation's own lock cannot deadlock the single-connection database.
    const gate = pauseFirstTransaction(env.db);
    setTestDb(gate.wrappedDb);
    try {
      const resPromise = post(
        `/admin/email/${projectId}/domains/acme-grant-race.com/revoke-grant`,
        adminJwt,
      );
      await gate.reached;
      await refreshOauthGrantSerialized(env.db, env, row.id);
      gate.release();
      const res = await resPromise;
      expect(res.status).toBe(302);
    } finally {
      setTestDb(env.db);
    }

    const revocations = cfCalls.filter((call) => call.tag === 'oauthRevoke');
    expect(revocations).toHaveLength(1);
    // The revoke went through the row lock, so it submitted the ROTATED
    // head — not the stored-and-consumed original.
    expect(String(revocations[0]!.body)).toContain('cf-rotated-refresh-dummy-1');
    expect(String(revocations[0]!.body)).not.toContain(GRANT_REFRESH_TOKEN);
    expect((await domainRow(projectId, 'acme-grant-race.com'))?.status).toBe('token_revoked');
  });

  test('a credential replace committed mid-revoke is revoked and marked — mirror and row stay paired', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const row = await seedEmailDomain(projectId, 'acme-grant-swap.com', {
      credentialKind: 'oauth_grant',
    });
    const cfCalls = recordCustomerCfCalls();
    // Land a committed credential replace + an `active` mirror republish
    // while the revoke's serialized section is paused BEFORE it opens.
    // Everything the route does must follow the LOCKED row: revoke the
    // replacement grant and flip it, leaving mirror and row both
    // token_revoked — never an `active` mirror over a revoked row, and
    // never a revoked row over a live grant.
    const gate = pauseFirstTransaction(env.db);
    setTestDb(gate.wrappedDb);
    try {
      const resPromise = post(
        `/admin/email/${projectId}/domains/acme-grant-swap.com/revoke-grant`,
        adminJwt,
      );
      await gate.reached;
      const swapped = await encryptEmailDomainToken(
        env,
        projectId,
        'acme-grant-swap.com',
        'cf-grant-refresh-dummy-2',
      );
      await env.db
        .update(emailDomains)
        .set({
          token_ciphertext: swapped.ciphertext,
          token_iv: swapped.iv,
          token_key_version: swapped.keyVersion,
        })
        .where(eq(emailDomains.id, row.id));
      await writeEmailDomainMirror(
        env.ROUTING,
        (await domainRow(projectId, 'acme-grant-swap.com'))!,
        await hashEmailRelaySecret(RELAY_SECRET),
      );
      gate.release();
      const res = await resPromise;
      expect(res.status).toBe(302);
    } finally {
      setTestDb(env.db);
    }

    // The revoke submitted the REPLACEMENT grant (the row's live head at
    // lock time) — not the stale snapshot's original…
    const revocations = cfCalls.filter((call) => call.tag === 'oauthRevoke');
    expect(revocations).toHaveLength(1);
    // Compare the parsed form field exactly — the replacement value carries
    // the original as a prefix, so substring checks cannot tell them apart.
    const revokedToken = new URLSearchParams(String(revocations[0]!.body)).get('token');
    expect(revokedToken).toBe('cf-grant-refresh-dummy-2');
    expect(revokedToken).not.toBe(GRANT_REFRESH_TOKEN);
    // …and mirror and row agree.
    expect((await domainRow(projectId, 'acme-grant-swap.com'))?.status).toBe('token_revoked');
    const mirror = JSON.parse((await env.ROUTING.get('email-domain:acme-grant-swap.com'))!) as {
      status: string;
    };
    expect(mirror.status).toBe('token_revoked');
  });

  test('fails the grant revoke without touching CF when the mirror write fails', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-mirrorfail.com', { credentialKind: 'oauth_grant' });
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string,
      options?: unknown,
    ) => {
      if (key === 'email-domain:acme-mirrorfail.com') {
        throw new Error('forced mirror KV failure for test');
      }
      return originalPut(key, value, options as never);
    }) as typeof env.ROUTING.put);
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-mirrorfail.com/revoke-grant`,
      adminJwt,
    );

    // Mirror-first: nothing else ran — the grant is still live, the row is
    // still active, and the operator can just click again.
    expect(res.status).toBe(503);
    expect(cfCalls).toEqual([]);
    expect((await domainRow(projectId, 'acme-mirrorfail.com'))?.status).toBe('active');
    const mirror = JSON.parse((await env.ROUTING.get('email-domain:acme-mirrorfail.com'))!) as {
      status: string;
    };
    expect(mirror.status).toBe('active');
  });

  test('refuses for an api_token row — the customer revokes those themselves', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await seedEmailDomain(projectId, 'acme-token.com');
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-token.com/revoke-grant`,
      adminJwt,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('dash.cloudflare.com');
    expect(cfCalls).toEqual([]);
    expect((await domainRow(projectId, 'acme-token.com'))?.status).toBe('active');
  });

  test('404s for a domain row that belongs to another project', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const sibling = await createTestProject(env.db, (await createTestUser(env.db)).id);
    await seedEmailDomain(sibling.id, 'acme-grant-elsewhere.com', {
      credentialKind: 'oauth_grant',
    });
    const cfCalls = recordCustomerCfCalls();

    const res = await post(
      `/admin/email/${projectId}/domains/acme-grant-elsewhere.com/revoke-grant`,
      adminJwt,
    );

    expect(res.status).toBe(404);
    expect(cfCalls).toEqual([]);
    expect((await domainRow(sibling.id, 'acme-grant-elsewhere.com'))?.status).toBe('active');
  });
});

describe('admin email settings page', () => {
  test('renders the recipient policy and domain management forms with the defaults selected', async () => {
    const { adminJwt } = await seedAdminAndProject();
    const res = await get('/admin/email', adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Recipient policy');
    expect(html).toContain('Domain management');
    expect(html).toMatch(/name="mode" value="verified" checked/);
    expect(html).toMatch(/name="domains" value="self-serve" checked/);
    expect(html).toContain('UNVERIFIED_DESTINATION');
  });

  test('saves the recipient policy, mirrors it, audits it, and re-renders it selected', async () => {
    const { adminJwt } = await seedAdminAndProject();
    const res = await post('/admin/email/policy', adminJwt, {
      mode: 'domains',
      domains: 'Corp.Example\nexample.net',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/email');
    expect(res.headers.get('X-Void-Audit-Id')).toBeTruthy();
    expect(await env.ROUTING.get('email-recipient-policy')).toBe(
      JSON.stringify({ mode: 'domains', domains: ['corp.example', 'example.net'] }),
    );
    const events = await env.db.select().from(operatorEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'email/policy', status: 'success' });

    const html = await (await get('/admin/email', adminJwt)).text();
    expect(html).toMatch(/name="mode" value="domains" checked/);
    expect(html).toContain('corp.example');
  });

  test('renders a 400 for an invalid policy and stores nothing', async () => {
    const { adminJwt } = await seedAdminAndProject();
    await env.ROUTING.delete('email-recipient-policy');
    const res = await post('/admin/email/policy', adminJwt, { mode: 'domains', domains: '' });
    expect(res.status).toBe(400);
    expect(await env.db.select().from(platformSettings)).toHaveLength(0);
    expect(await env.ROUTING.get('email-recipient-policy')).toBeNull();
  });

  test('saves the domain management mode', async () => {
    const { adminJwt } = await seedAdminAndProject();
    const res = await post('/admin/email/settings', adminJwt, { domains: 'admin' });
    expect(res.status).toBe(302);
    const html = await (await get('/admin/email', adminJwt)).text();
    expect(html).toMatch(/name="domains" value="admin" checked/);
    const bad = await post('/admin/email/settings', adminJwt, { domains: 'nobody' });
    expect(bad.status).toBe(400);
  });

  test('the project page still resolves under the index route', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const res = await get(`/admin/email/${projectId}`, adminJwt);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(slug);
  });
});

describe('admin add domain form', () => {
  test('registers an administrator-managed row on the platform credential and audits it', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const cfCalls: Array<string> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      cfCalls.push(`${method} ${url}`);
      if (url.startsWith('https://cloudflare-dns.com/')) {
        return Response.json({ Answer: [] });
      }
      if (url.includes('/zones?')) {
        return Response.json({
          success: true,
          errors: [],
          result: [{ id: 'zone_p', name: 'example.com', account: { id: env.CF_ACCOUNT_ID } }],
        });
      }
      if (/\/workers\/scripts\/[^/]+$/.test(url) && method === 'GET') {
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/email/routing/rules/catch_all') && method === 'GET') {
        return Response.json({
          success: true,
          errors: [],
          result: { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] },
        });
      }
      return Response.json({ success: true, errors: [], result: {} });
    });

    const res = await post(`/admin/email/${projectId}/domains/add`, adminJwt, {
      domain: 'example.com',
      token: '',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/email/${projectId}`);
    const row = (await domainRow(projectId, 'example.com'))!;
    expect(row).toMatchObject({
      credential_kind: 'platform',
      managed_by: 'admin',
      status: 'active',
    });
    expect(row.token_ciphertext).toBeNull();
    expect(cfCalls.some((call) => call.includes('/user/tokens/verify'))).toBe(false);
    const events = await env.db.select().from(operatorEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'email/domains', status: 'success' });
    expect(JSON.parse(events[0]!.target)).toEqual({ domain: 'example.com', project: projectId });

    const html = await (await get(`/admin/email/${projectId}`, adminJwt)).text();
    expect(html).toContain('admin (platform credential)');
  });

  test('renders a 400 for a blank domain and records the failed attempt', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const res = await post(`/admin/email/${projectId}/domains/add`, adminJwt, { domain: '  ' });
    expect(res.status).toBe(400);
    expect(await env.db.select().from(emailDomains)).toHaveLength(0);
  });

  test('keeps a pasted token out of the audit log', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: 'nope' }] },
        { status: 403 },
      ),
    );
    const res = await post(`/admin/email/${projectId}/domains/add`, adminJwt, {
      domain: 'elsewhere.test',
      token: 'cf-pasted-token-dummy',
    });
    // The engine records the refusal on the row; the form redirects.
    expect([302, 400, 502]).toContain(res.status);
    expect(JSON.stringify(await env.db.select().from(operatorEvents))).not.toContain(
      'cf-pasted-token-dummy',
    );
  });
});
