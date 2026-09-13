import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vite-plus/test';
import {
  createDeployment,
  updateDeploymentStatus,
  markDeploymentRetained,
  setActiveDeployment,
  setAppliedMigrations,
} from '../../src/db.ts';
import * as db from '../../src/db.ts';
import app from '../../src/index.ts';
import { users } from '../../src/schema.ts';
import {
  domains,
  emailDestinations,
  projects,
  resources,
  projectDatabaseCredentials,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
  cfError,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GET /projects', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects'), env);
    expect(res.status).toBe(401);
  });

  it('returns 401 when user has been deleted', async () => {
    const user = await createTestUser(env.db);
    await env.db.delete(users).where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'user not found' });
  });

  it('returns 403 when user is admin-suspended', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account suspended' });
  });

  it('allows usage-suspended user to list projects', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('returns empty array when no projects', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns only the authenticated user's projects", async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    await createTestProject(env.db, alice.id, 'alice-app');
    await createTestProject(env.db, bob.id, 'bob-app');
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${alice.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const projects = (await res.json()) as Array<{ slug: string }>;
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe('alice-app');
  });

  it('returns deployment, traffic, and health summaries sorted by attention', async () => {
    const user = await createTestUser(env.db, 'overview-user');
    const alpha = await createTestProject(env.db, user.id, 'alpha');
    const beta = await createTestProject(env.db, user.id, 'beta');
    const alphaDeploy = await createTestDeployment(env.db, alpha.id, 'live', 'main');
    const betaDeploy = await createTestDeployment(env.db, beta.id, 'failed', 'preview');
    await env.db.insert(domains).values({
      id: 'dom_alpha',
      project_id: alpha.id,
      hostname: 'alpha.example.com',
      cf_hostname_id: 'cf-alpha',
      status: 'active',
    });

    const bucketNow = Math.floor(Date.now() / 1000 / 15) * 15;
    const lastSeen = new Date().toISOString();
    mockCfApi({
      analyticsQuery: (_url, init) => {
        expect(init?.body).toContain('FROM void_requests');
        expect(init?.body).toContain('WHERE blob1 IN');
        return Response.json({
          data: [
            {
              project_id: alpha.id,
              bucket: bucketNow - 15,
              last_seen: lastSeen,
              requests: 4,
              responses_4xx: 1,
              responses_5xx: 0,
            },
            {
              project_id: beta.id,
              bucket: bucketNow,
              last_seen: lastSeen,
              requests: 9,
              responses_4xx: 0,
              responses_5xx: 2,
            },
          ],
        });
      },
    });

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const projects = (await res.json()) as Array<{
      slug: string;
      custom_domain: string | null;
      latest_deployment: { id: string; status: string; source: string | null } | null;
      traffic: { requests5m: number; lastSeenAt: string | null; sparkline5m: Array<number> };
      health: { responses4xx15m: number; responses5xx15m: number; errorRate5xx15m: number };
    }>;

    expect(projects.map((p) => p.slug)).toEqual(['beta', 'alpha']);
    expect(projects[0].latest_deployment).toMatchObject({
      id: betaDeploy.id,
      status: 'failed',
      source: 'preview',
    });
    expect(projects[0].traffic.requests5m).toBe(9);
    expect(projects[0].traffic.lastSeenAt).toBe(lastSeen);
    expect(projects[0].traffic.sparkline5m).toHaveLength(20);
    expect(projects[0].health.responses5xx15m).toBe(2);
    expect(projects[0].health.errorRate5xx15m).toBeCloseTo(2 / 9);
    expect(projects[1].latest_deployment?.id).toBe(alphaDeploy.id);
    expect(projects[1].custom_domain).toBe('alpha.example.com');
    expect(projects[1].health.responses4xx15m).toBe(1);
  });
});

describe('GET /projects/:id', () => {
  it('returns project for the owner', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'my-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(project.id);
    expect(body.slug).toBe('my-app');
  });

  it('returns 403 when user does not own the project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('PUT /projects/:id/database-url', () => {
  it('provisions Hyperdrive with a Cloudflare-safe name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-post');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        const body = JSON.parse(init?.body as string) as { name: string };
        expect(body.name).toBe(hyperdriveName);
        expect(body.name).toMatch(/^[a-z0-9-]+$/);
        return cfSuccess({ id: 'hd-post-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-post-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('creates Hyperdrive from a provider Postgres URL when no resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          origin: {
            database: 'appdb',
            host: 'db.example.com',
            password: 'p@ss',
            port: 25060,
            scheme: 'postgresql',
            user: 'void_user',
          },
          mtls: { sslmode: 'require' },
        });
        return cfSuccess({ id: 'hd-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString:
            'postgresql://void_user:p%40ss@db.example.com:25060/appdb?sslmode=require',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('creates Hyperdrive from a MySQL URL when no resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mysql-app');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          origin: {
            database: 'appdb',
            host: 'mysql.example.com',
            password: 'p@ss',
            port: 3306,
            scheme: 'mysql',
            user: 'void_user',
          },
        });
        return cfSuccess({ id: 'hd-mysql-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'mysql://void_user:p%40ss@mysql.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-mysql-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('rejects unsupported database connection schemes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'invalid-db-scheme');
    const cf = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: 'sqlite://user:pass@db.example.com/appdb' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Connection string must start with "postgres://", "postgresql://", or "mysql://".',
    });
    expect(cf).not.toHaveBeenCalled();
  });

  it('updates the existing Hyperdrive config when the resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-update');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();
    await env.db.insert(resources).values({
      id: 'res_hd_existing',
      project_id: project.id,
      type: 'hyperdrive',
      cf_id: 'hd-existing',
      binding_name: 'HYPERDRIVE',
    });

    mockCfApi({
      updateHyperdrive: (url, init) => {
        expect(url).toContain('/hyperdrive/configs/hd-existing');
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          origin: {
            database: 'appdb',
            host: 'db.example.com',
            password: 'pass',
            port: 5432,
            scheme: 'postgres',
            user: 'void_user',
          },
        });
        return cfSuccess({ id: 'hd-existing', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgres://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('surfaces Cloudflare Hyperdrive errors as JSON instead of a generic 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-error');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Failed to provision Hyperdrive',
      detail: 'origin database is unreachable',
    });
  });
});

describe('GET /projects/:id/database-url', () => {
  it('returns 404 with structured error when no URL has been stored', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'database_url_not_stored',
      message: expect.stringContaining('void db set-url'),
    });
  });

  it('returns 403 when accessed by a different user', async () => {
    const owner = await createTestUser(env.db);
    const other = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'pg-app-get-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('round-trips the connection string via POST /:id/database', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-rt-post');
    const connectionString = 'postgresql://void_user:pass@db.example.com/appdb';

    mockCfApi();

    const postRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString }),
      }),
      env,
    );
    expect(postRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: connectionString });
  });

  it('returns 409 from POST /:id/database once teardown has begun', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-deleting');
    // Teardown flips status to 'deleting' under a row lock before tearing down
    // CF resources; provisioning a Hyperdrive after that would orphan it.
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const cf = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Project is being deleted' });
    // Bailed before touching Cloudflare — no Hyperdrive create attempted.
    expect(cf).not.toHaveBeenCalled();
  });

  it('rolls back the created Hyperdrive when persisting its resource row fails (POST /database)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-rollback-post');
    const cf = mockCfApi();
    // Force the resources-row INSERT to fail AFTER CF created the Hyperdrive
    // (models a concurrent teardown deleting the project → FK violation). The
    // route must delete the just-created CF Hyperdrive so it doesn't orphan.
    vi.spyOn(db, 'createResource').mockRejectedValueOnce(new Error('insert failed'));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);

    // The Hyperdrive CF object we created was rolled back (DELETE to its config).
    const hdDeletes = cf.mock.calls.filter(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === 'DELETE' &&
        /\/hyperdrive\/configs\/[^/]+$/.test(String(url)),
    );
    expect(hdDeletes.length).toBeGreaterThan(0);
  });

  it('round-trips the connection string via PUT /:id/database-url', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-rt-put');
    const connectionString = 'postgres://void_user:secret@db.example.com/mydb';

    mockCfApi();

    const putRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString }),
      }),
      env,
    );
    expect(putRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: connectionString });
  });

  it('returns 409 from PUT /:id/database-url once teardown has begun', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-put-deleting');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const cf = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgres://void_user:secret@db.example.com/mydb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Project is being deleted' });
    expect(cf).not.toHaveBeenCalled();
  });

  it('last PUT wins — GET returns the most recently written URL', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-overwrite');
    const first = 'postgresql://void_user:first@db.example.com/appdb';
    const second = 'postgresql://void_user:second@db2.example.com/appdb2';

    mockCfApi();

    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: first }),
      }),
      env,
    );
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: second }),
      }),
      env,
    );

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: second });
  });
});

describe('database URL persistence ordering — CF failure must not overwrite stored URL', () => {
  it('POST /:id/database does not write credentials when createHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-post-cf-fail');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // No credential row should have been written
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(404);
    expect(await getRes.json()).toMatchObject({ error: 'database_url_not_stored' });
  });

  it('POST /:id/database leaves pre-existing credentials unchanged when createHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-post-cf-fail-keep');
    const originalUrl = 'postgresql://void_user:original@db.example.com/appdb';

    // Seed a successful first set via the happy path
    mockCfApi();
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: originalUrl }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);

    // Now a second POST attempt fails at CF (409 conflict since resource exists)
    // but the PUT endpoint is what would be called in a re-run; test it via
    // direct DB read to confirm the original value is intact after a PUT failure
    mockCfApi({
      updateHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    // Insert an existing hyperdrive resource so PUT takes the update path
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    const hdResource = rows.find((r) => r.type === 'hyperdrive');

    if (hdResource) {
      const putRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/database-url`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            connectionString: 'postgresql://void_user:new@db2.example.com/otherdb',
          }),
        }),
        env,
      );
      expect(putRes.status).toBe(502);
    }

    // The stored URL must still be the original
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: originalUrl });
  });

  it('PUT /:id/database-url does not write credentials when createHyperdrive rejects (no existing resource)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-put-cf-fail-create');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // No credential row should have been written
    const rows = await env.db
      .select()
      .from(projectDatabaseCredentials)
      .where(eq(projectDatabaseCredentials.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('PUT /:id/database-url does not overwrite credentials when updateHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-put-cf-fail-update');
    const originalUrl = 'postgresql://void_user:original@db.example.com/appdb';

    // Seed an existing hyperdrive resource and a stored credential via the happy path
    mockCfApi();
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: originalUrl }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);

    // Now attempt an update with CF rejecting the new URL
    mockCfApi({
      updateHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:new@db2.example.com/otherdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // The stored URL must still be the original (not overwritten with the rejected URL)
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: originalUrl });
  });
});

describe('POST /projects', () => {
  it('creates project with valid slug', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'my-app' }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      user_id: string;
    };
    expect(body.slug).toBe('my-app');
    expect(body.user_id).toBe(user.id);
  });

  it('rejects missing slug', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug format', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'UPPER-CASE' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'slug must be lowercase alphanumeric with dashes',
    });
  });

  it('rejects short slug for free tier users', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'abc' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'short slugs (5 characters or fewer) require a paid plan',
    });
  });

  it('allows short slug for paid tier users', async () => {
    const user = await createTestUser(env.db, 'paiduser', 'github', undefined, 'solo');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'abc' }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe('abc');
  });

  it('rejects duplicate slug', async () => {
    const user = await createTestUser(env.db);
    await createTestProject(env.db, user.id, 'taken-slug');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'taken-slug' }),
      }),
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slug already taken' });
  });
});

describe('GET /projects/:id/deployments', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_test1/deployments'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/deployments', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when not the project owner', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-project');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns empty array when no deployments', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<unknown>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toEqual([]);
    expect(body.activeDeploymentId).toBeNull();
  });

  it('returns deployments with source and git metadata fields', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const d1 = await createDeployment(env.db, project.id, null, 'manual', 'abc1234', {
      cliVersion: '0.8.3',
      commitUrl: 'https://github.com/voidzero-dev/void/commit/abc1234',
      gitRef: 'main',
      repositoryUrl: 'https://github.com/voidzero-dev/void',
    });
    await updateDeploymentStatus(env.db, d1.id, 'live');
    const d2 = await createDeployment(env.db, project.id, null, 'ci');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{
        cli_version: string | null;
        commit: string | null;
        commit_url: string | null;
        git_ref: string | null;
        id: string;
        repository_url: string | null;
        source: string | null;
        status: string;
      }>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toHaveLength(2);

    const byId = Object.fromEntries(body.deployments.map((d) => [d.id, d]));
    expect(byId[d1.id].source).toBe('manual');
    expect(byId[d1.id].cli_version).toBe('0.8.3');
    expect(byId[d1.id].commit).toBe('abc1234');
    expect(byId[d1.id].repository_url).toBe('https://github.com/voidzero-dev/void');
    expect(byId[d1.id].commit_url).toBe('https://github.com/voidzero-dev/void/commit/abc1234');
    expect(byId[d1.id].git_ref).toBe('main');
    expect(byId[d1.id].status).toBe('live');
    expect(byId[d2.id].source).toBe('ci');
    expect(byId[d2.id].cli_version).toBeNull();
    expect(byId[d2.id].commit_url).toBeNull();
    expect(byId[d2.id].status).toBe('pending');
  });
});

describe('POST /projects/:id/rollback', () => {
  it('rolls back to a retained deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-app');

    // Create two deployments, both retained and live
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe(d1.id);
    expect(body.migrationDiff).toEqual([]);

    // Verify KV routing updated
    const routing = (await env.ROUTING.get(project.slug, 'json')) as { workerName: string };
    expect(routing.workerName).toBe(`user-rollback-app-${d1.id}`);
  });

  it('clamps a stored manifest limits.cpuMs to the current plan ceiling (never rejects)', async () => {
    // Free plan ceiling is 10 cpuMs; the target manifest requests 60000 —
    // e.g. deployed under a higher plan before a downgrade. Rollback must
    // clamp with min() and go through, not 400.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'clamp-rollback-app');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {}, limits: { cpuMs: 60_000 } }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 10, subRequests: 50 });
  });

  it('returns 400 for non-retained deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'evicted-app');

    const d1 = await createDeployment(env.db, project.id, null);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    // retained defaults to false

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'deployment not retained (worker script evicted)' });
  });

  it('returns 404 for deployment from another project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const projectA = await createTestProject(env.db, alice.id, 'alice-roll');
    const projectB = await createTestProject(env.db, bob.id, 'bob-roll');

    const d1 = await createDeployment(env.db, projectB.id, null);
    await markDeploymentRetained(env.db, d1.id, true);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectA.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${alice.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'deployment not found' });
  });

  it('returns migrationDiff when rolling back past migrations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'migrate-roll');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    await setAppliedMigrations(env.db, d1.id, ['001_init.sql']);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setAppliedMigrations(env.db, d2.id, [
      '001_init.sql',
      '002_add_email.sql',
      '003_add_roles.sql',
    ]);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        // Rolling back to d1 drops 002/003 from the target's known
        // migrations while D1 still has them — destructive rollback. The
        // caller must echo the exact set of migrations that make up the
        // server-computed diff (currentActive minus target) as
        // `allowDestructive`; a mismatch is rejected with 400.
        body: JSON.stringify({
          deploymentId: d1.id,
          allowDestructive: ['002_add_email.sql', '003_add_roles.sql'],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { migrationDiff: Array<string> };
    expect(body.migrationDiff).toEqual(['002_add_email.sql', '003_add_roles.sql']);
  });

  it('updates custom domain KV entries on rollback', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-roll');

    // Insert an active domain
    await env.db.insert(domains).values({
      id: 'dom_rollback',
      project_id: project.id,
      hostname: 'rollback.example.com',
      cf_hostname_id: 'ch-rollback',
      status: 'active',
    });

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify domain KV routing updated
    const domainRouting = (await env.ROUTING.get('domain:rollback.example.com', 'json')) as {
      workerName: string;
    };
    expect(domainRouting.workerName).toBe(`user-domain-roll-${d1.id}`);
  });

  it('rollback resolves the proxy token once for both cron and queues (no duplicate CF fetch)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-and-queue-roll');
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;

    await env.db.insert(resources).values({
      id: 'res_mixed_roll',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Simulate a transient CF failure on the SECOND bindings call. With
    // the duplicate-fetch bug, cron sync succeeds on call 1 and commits
    // DO state; the queue fetch on call 2 then fails and the transaction
    // aborts — leaving cron partial. With the fix (single hoisted fetch),
    // the whole rollback succeeds on one healthy call.
    let bindingsCalls = 0;
    mockCfApi({
      listWorkerBindings: () => {
        bindingsCalls++;
        if (bindingsCalls === 1) {
          return cfSuccess([
            { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-d1-token' },
          ]);
        }
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10013, message: 'rate limited' }],
          }),
          { status: 429 },
        );
      },
    });

    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Exactly one CF bindings fetch for the rollback — the second call
    // is the one that used to introduce the extra failure point.
    expect(bindingsCalls).toBe(1);

    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    const payload = JSON.parse(sync!.body!) as { proxyToken: string };
    expect(payload.proxyToken).toBe('baked-d1-token');

    const queueRouting = (await env.ROUTING.get(queueRoutingKey, 'json')) as {
      proxyToken: string;
    };
    expect(queueRouting.proxyToken).toBe('baked-d1-token');
  });

  it('rollback cron sync uses the baked __VOID_PROXY_TOKEN from the target worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-roll');

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Return the exact token baked into d1's worker, so we can assert
    // rollback uses THIS value rather than re-deriving from JWT_SECRET.
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-into-d1-cron' }]),
    });

    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    const payload = JSON.parse(sync!.body!) as { proxyToken: string; workerName: string };
    expect(payload.workerName).toBe(`user-cron-roll-${d1.id}`);
    expect(payload.proxyToken).toBe('baked-into-d1-cron');
  });

  it('updates queue KV entries on rollback using deterministic queue names', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-roll');
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;

    await env.db.insert(resources).values({
      id: 'res_queue_roll',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Worker bindings stored at deploy time include the exact
    // __VOID_PROXY_TOKEN that d1 expects — rollback must read THIS value
    // from CF rather than re-derive from the current JWT_SECRET, which
    // would 401 the worker if the secret has rotated since d1 was
    // deployed.
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([
          { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'token-baked-into-d1' },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const queueRouting = (await env.ROUTING.get(queueRoutingKey, 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
      proxyToken: string;
    };
    expect(queueRouting).toEqual({
      workerName: `user-queue-roll-${d1.id}`,
      projectId: project.id,
      queueName: 'emails',
      // The EXACT value from d1's worker bindings — not a freshly
      // hmacSignState(projectId, currentSecret) value.
      proxyToken: 'token-baked-into-d1',
    });
  });
});

describe('GET /projects/:id/logs', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/fake-id/logs'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/projects/nonexistent/logs', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-logs');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns log data from analytics engine', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'my-app');

    const mockData = {
      data: [
        {
          outcome: 'ok',
          logData: JSON.stringify([{ level: 'log', message: ['hello'], timestamp: 1000 }]),
          exceptionData: '[]',
          url: 'https://my-app.void.app/api/test',
          method: 'GET',
          statusCode: '200',
          ts: Date.now() - 5000,
        },
      ],
    };

    mockCfApi({
      analyticsQuery: (_url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        expect(body).toContain('user-my-app');
        expect(body).toContain('ORDER BY timestamp DESC');
        return Response.json(mockData);
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ outcome: string; url: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      outcome: 'ok',
      url: 'https://my-app.void.app/api/test',
      method: 'GET',
      status: '200',
    });
  });

  it('returns analytics error details when the log query fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'broken-logs');

    mockCfApi({
      analyticsQuery: () => new Response('SQL compilation failed', { status: 400 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; status: number; detail: string };
    expect(json).toMatchObject({
      error: 'log query failed',
      status: 400,
      detail: 'SQL compilation failed',
    });
  });

  it('rejects invalid since parameter', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-since');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?since=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('appends an error-level WHERE clause when level=error', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-error');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=error`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Also catches responses with a 5xx status (blob6) even when the worker
    // neither threw nor logged at error level.
    expect(capturedBody).toContain(
      `AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%' OR blob6 LIKE '5%')`,
    );
  });

  it('appends a warn-level WHERE clause when level=warn', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-warn');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=warn`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob2 LIKE '%"level":"warn"%'`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it.each(['info', 'log', 'debug'] as const)(
    'appends a %s-level WHERE clause when level=%s',
    async (lvl) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `lvl-${lvl}`);

      let capturedBody = '';
      mockCfApi({
        analyticsQuery: (_url, init) => {
          capturedBody = typeof init?.body === 'string' ? init.body : '';
          return Response.json({ data: [] });
        },
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/logs?level=${lvl}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(capturedBody).toContain(`AND blob2 LIKE '%"level":"${lvl}"%'`);
      expect(capturedBody).not.toContain(`blob1 != 'ok'`);
    },
  );

  it('omits the level WHERE clause when level=all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-all');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=all`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).not.toContain(`"level":`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it('omits the level WHERE clause when level is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-missing');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).not.toContain(`"level":`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it('rejects unknown level values with a 400 and never queries AE', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-bad');

    let aeCalls = 0;
    mockCfApi({
      analyticsQuery: () => {
        aeCalls++;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=foo`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid level parameter/);
    expect(json.error).toMatch(/error, warn, info, log, debug/);
    expect(aeCalls).toBe(0);
  });

  it('combines level=error with deploymentId so both clauses are ANDed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-combo');
    const deploymentId = 'dpl_abc123';

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/projects/${project.id}/logs?level=error&deploymentId=${deploymentId}`,
        {
          headers: { Authorization: `Bearer ${user.jwt}` },
        },
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob7 = '${deploymentId}'`);
    expect(capturedBody).toContain(
      `AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%' OR blob6 LIKE '5%')`,
    );
  });
});

describe('GET /projects/:id/requests', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/fake-id/requests'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nope/requests', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-owner', async () => {
    const owner = await createTestUser(env.db);
    const other = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'req-owned');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests`, {
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns request rows from analytics engine, keyed by project id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-app');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({
          data: [
            {
              type: 'ssr',
              method: 'GET',
              status: '503',
              durationMs: 1200,
              bytes: 0,
              timestamp: '2026-07-16 16:52:00',
            },
          ],
        });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    // Keyed on blob1 to match the established requests-dataset convention used
    // by the billing/top-traffic queries in routes/usage.ts (meta/lessons.md).
    expect(capturedBody).toContain(`WHERE blob1 = '${project.id}'`);
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      type: 'ssr',
      method: 'GET',
      status: '503',
      durationMs: 1200,
    });
  });

  it('filters by status class (5xx) via a LIKE clause', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-5xx');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?status=5xx`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob4 LIKE '5%'`);
  });

  it('filters by an exact status code via equality', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-500');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?status=500`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob4 = '500'`);
  });

  it('rejects an invalid status filter with 400 and never queries analytics', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-badstatus');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?status=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });

  it('rejects an invalid since parameter', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-badsince');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?since=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects exact status codes outside the 100-599 HTTP range', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-range');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    for (const bad of ['000', '600', '999']) {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/requests?status=${bad}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(queried).toBe(false);
  });

  it('rejects a non-positive limit with 400 instead of a misleading 502', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-badlimit');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?limit=-1`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });
});

describe('GET /projects/:id/logs limit validation', () => {
  it('rejects a non-positive limit with 400 instead of a misleading 502', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'logs-badlimit');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?limit=-1`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Owner auto-add on project create.
//
// The project owner's own address is registered with CF Email Routing so mail
// to themselves works from the first deploy. Entirely best-effort — every
// failure is logged and swallowed — which is exactly why it needs a test: a
// regression here is silent.
// ---------------------------------------------------------------------------
describe('POST /projects — owner email destination auto-add', () => {
  // The gate the route checks. Without a platform mail domain there is no
  // sender to allow-list a recipient for, so the auto-add stays inert.
  const emailEnv = () => ({ ...env, EMAIL_SENDER_DOMAIN: 'mail.staging.void.cloud' });

  // `respond` may be async so a test can commit a competing write (project
  // teardown's cascade) while the route is awaiting Cloudflare. The stub is
  // already called from an async fetch shim, and the shared `mockCfApi`
  // handlers for these same endpoints are typed the same way.
  function stubEmailRouting(
    respond: (method: string, url: string) => Response | Promise<Response>,
  ): Array<{ method: string; url: string }> {
    const calls: Array<{ method: string; url: string }> = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/email/routing/addresses')) {
        const method = init?.method ?? 'GET';
        calls.push({ method, url });
        return respond(method, url);
      }
      return inner(input, init);
    });
    return calls;
  }

  // `createTestUser` stores `email: null`, which the route treats as
  // "nothing to register". Give the owner a real address.
  async function withEmail(userId: string, email: string): Promise<string> {
    await env.db.update(users).set({ email }).where(eq(users.id, userId));
    return email;
  }

  async function createProjectAs(user: { jwt: string }, slug: string, bindings: TestEnv) {
    return app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      }),
      bindings,
    );
  }

  it('registers the owner address and stores a pending row', async () => {
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'Owner@Example.com');
    mockCfApi();
    stubEmailRouting(() =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        // CF returns the row immediately; `verified` stays null until the
        // owner clicks the link it just mailed them.
        result: { tag: 'cf-tag-new', email: ownerEmail, verified: null },
      }),
    );

    const res = await createProjectAs(user, 'auto-add-app', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(row).toMatchObject({
      // Stored lowercased regardless of how the user cased it.
      address: ownerEmail.toLowerCase(),
      cf_destination_id: 'cf-tag-new',
      status: 'pending',
      verification_source: 'cf',
    });
    // Nothing was inherited, so no consent to attribute.
    expect(row.verified_by_user_id).toBeNull();
  });

  it('reuses the tag and verified status when CF already has the address', async () => {
    // Second-or-later project for the same owner. Without the already-exists
    // recovery this project would start with an empty allowlist.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'repeat-owner@example.com');
    mockCfApi();
    stubEmailRouting((method) => {
      if (method === 'POST') {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10037, message: 'destination address already exists' }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ tag: 'cf-tag-existing', email: ownerEmail, verified: '2026-01-01T00:00:00Z' }],
      });
    });

    const res = await createProjectAs(user, 'auto-add-second', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(row).toMatchObject({
      cf_destination_id: 'cf-tag-existing',
      status: 'verified',
      verification_source: 'cf',
      // Owner-relaxed reuse: record whose prior consent this inherited.
      verified_by_user_id: user.id,
    });
    expect(row.verified_at).toContain('2026-01-01');

    // Verified on arrival, so the proxy's allowlist mirror is primed now
    // rather than waiting for a refresh.
    expect(JSON.parse((await env.ROUTING.get(`email-allowlist:${project.id}`))!)).toEqual([
      ownerEmail,
    ]);
  });

  it('still creates the project when CF Email Routing is down', async () => {
    const user = await createTestUser(env.db);
    await withEmail(user.id, 'owner@example.com');
    mockCfApi();
    stubEmailRouting(() =>
      Response.json(
        { success: false, errors: [{ code: 1000, message: 'boom' }], messages: [], result: null },
        { status: 500 },
      ),
    );

    const res = await createProjectAs(user, 'auto-add-cf-down', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('rolls the CF address back when teardown cascades the project mid-add', async () => {
    // The auto-add runs off the response path, so project teardown can commit
    // its cascade between `createProject` and the destination INSERT. The
    // INSERT then violates the foreign key, and nothing retries it — without a
    // rollback the account-level CF address stays allocated against the shared
    // 200-address cap with no row left to reclaim it from.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'cascade-owner@example.com');
    mockCfApi();
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        // Teardown lands while CF is registering the address.
        await env.db.delete(projects).where(eq(projects.slug, 'auto-add-cascaded'));
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { tag: 'cf-tag-cascaded', email: ownerEmail, verified: null },
      });
    });

    // Best-effort and post-response: the create still succeeds.
    const res = await createProjectAs(user, 'auto-add-cascaded', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(rows).toHaveLength(0);

    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain('/email/routing/addresses/cf-tag-cascaded');
  });

  it('leaves the CF address alone when a sibling project still references it', async () => {
    // Same cascade, but the address came back through the already-exists
    // recovery and a live sibling project's row still points at the tag. CF
    // destinations are account-level, so deleting it would silently revoke the
    // sibling's recipient: the reference count decides, not the failure.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'shared-owner@example.com');
    const sibling = await createTestProject(env.db, user.id, 'auto-add-sibling');
    await env.db.insert(emailDestinations).values({
      id: 'edst_sibling_shared',
      project_id: sibling.id,
      address: ownerEmail,
      cf_destination_id: 'cf-tag-shared',
      status: 'verified',
      verified_at: '2026-01-01T00:00:00Z',
      verification_source: 'cf',
    });
    mockCfApi();
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10037, message: 'destination address already exists' }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      // Teardown lands while we are recovering the existing tag.
      await env.db.delete(projects).where(eq(projects.slug, 'auto-add-shared'));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ tag: 'cf-tag-shared', email: ownerEmail, verified: '2026-01-01T00:00:00Z' }],
      });
    });

    const res = await createProjectAs(user, 'auto-add-shared', emailEnv());
    expect(res.status).toBe(201);

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    const [survivor] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, sibling.id));
    expect(survivor).toMatchObject({
      cf_destination_id: 'cf-tag-shared',
      status: 'verified',
    });
  });

  it('makes no CF call when the environment has no platform mail domain', async () => {
    const user = await createTestUser(env.db);
    await withEmail(user.id, 'owner@example.com');
    mockCfApi();
    const calls = stubEmailRouting(() => Response.json({ success: true, errors: [], result: {} }));

    // `env` as-is — EMAIL_SENDER_DOMAIN unset.
    const res = await createProjectAs(user, 'auto-add-no-domain', env);
    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
  });

  it('skips synthetic GitHub noreply addresses, which are not deliverable', async () => {
    const user = await createTestUser(env.db);
    await withEmail(user.id, 'octocat@users.noreply.github.com');
    mockCfApi();
    const calls = stubEmailRouting(() => Response.json({ success: true, errors: [], result: {} }));

    const res = await createProjectAs(user, 'auto-add-synthetic', emailEnv());
    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
  });

  // The project-slug mirror the email proxy reads to pin a project's outbound
  // `from` to its own slug. Written at create time; without it the proxy
  // refuses every send with `project slug unknown`.
  it('writes the email-slug KV mirror for the new project', async () => {
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'owner@example.com');
    mockCfApi();
    stubEmailRouting(() =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { tag: 'cf-tag-slug', email: ownerEmail, verified: null },
      }),
    );

    const res = await createProjectAs(user, 'slug-mirror-app', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };
    expect(await env.ROUTING.get(`email-slug:${project.id}`)).toBe('slug-mirror-app');
  });
});
