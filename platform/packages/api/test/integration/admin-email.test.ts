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
import { app } from '../../src/index.ts';
import { operatorEvents, platformSettings } from '../../src/schema.ts';
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
  test('removes the row and drops an unreferenced CF address', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const destination = await createEmailDestination(
      env.db,
      projectId,
      'ops@example.com',
      'cf-tag-ops',
      'verified',
    );
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([
      'DELETE https://api.cloudflare.com/client/v4/accounts/test-account-id/email/routing/addresses/cf-tag-ops',
    ]);
    expect(await getEmailDestinationsByProjectId(env.db, projectId)).toEqual([]);
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
