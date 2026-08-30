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
import { app } from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
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
    expect(html).toContain('Suspend outbound');
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
    expect(html).toContain('Unsuspend outbound');
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
    expect(observed).toHaveLength(1);
    expect(observed[0]?.written).toEqual(['keep@example.com']);
    // Both rows still there at the moment of the write.
    expect(observed[0]?.rowIds).toContain(doomed.id);
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
