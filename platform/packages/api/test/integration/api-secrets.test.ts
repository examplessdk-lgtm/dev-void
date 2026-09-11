import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import app from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  createTestProjectSecret,
  cfError,
  mockCfApi,
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

describe('project secrets API', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/secrets/API_KEY', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'secret' }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('sets a secret for owned project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'top-secret' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'API_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists secrets for owned project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-list-app');
    await createTestProjectSecret(env.db, env, project.id, 'BETTER_AUTH_SECRET', 'auth-secret');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'top-secret');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets`, {
        headers: {
          Authorization: `Bearer ${user.jwt}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'API_KEY' }, { name: 'BETTER_AUTH_SECRET' }]);
  });

  it('propagates secret updates to the active versioned worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-live-app');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'top-secret' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'API_KEY' });

    const call = fetchMock.mock.calls.find((c) => {
      const method = (c[1] as RequestInit | undefined)?.method;
      const url = typeof c[0] === 'string' ? c[0] : String(c[0]);
      return (
        method === 'PUT' && url.includes(`/scripts/user-${project.slug}-${deployment.id}/secrets`)
      );
    });
    expect(call).toBeDefined();
  });

  it('returns 502 when live secret propagation fails after storing the value', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-fail-app');
    await createTestDeployment(env.db, project.id, 'live');
    mockCfApi({
      setWorkerSecret: () => cfError('boom', 500),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'top-secret' }),
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: 'secret stored but live propagation failed',
        name: 'API_KEY',
        liveUpdated: false,
      }),
    );

    const listRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets`, {
        headers: {
          Authorization: `Bearer ${user.jwt}`,
        },
      }),
      env,
    );
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([{ name: 'API_KEY' }]);
  });

  it('deletes a secret for owned project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-delete-app');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'top-secret');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'API_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates secret deletes to the active versioned worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-delete-live-app');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'top-secret');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'API_KEY' });

    const call = fetchMock.mock.calls.find((c) => {
      const method = (c[1] as RequestInit | undefined)?.method;
      const url = typeof c[0] === 'string' ? c[0] : String(c[0]);
      return (
        method === 'DELETE' &&
        url.includes(`/scripts/user-${project.slug}-${deployment.id}/secrets/API_KEY`)
      );
    });
    expect(call).toBeDefined();
  });

  it('returns 403 for non-owner', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-secret-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${bob.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'nope' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('validates secret name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'secret-name-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/not-valid`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'x' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid secret name' });
  });
});
