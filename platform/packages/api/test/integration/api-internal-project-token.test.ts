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
import { signJwt } from '../../src/auth/jwt.ts';
import { createResource } from '../../src/db.ts';
import app from '../../src/index.ts';
import { deriveProxyToken } from '../../src/proxy-token.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  mockCfApi,
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

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A login JWT signs `header.body` with the same key and algorithm as the
 * project token, so its parts look like a project id and its token.
 */
async function loginJwtAsProjectToken(): Promise<{ projectId: string; token: string }> {
  const jwt = await signJwt({ sub: 'user_attacker', login: 'attacker', aud: 'api' }, JWT_SECRET);
  const [header, body, signature] = jwt.split('.');
  const projectId = `${header}.${body}`;
  expect(await hmacSignState(projectId, JWT_SECRET)).toBe(signature);
  return { projectId, token: signature };
}

async function internalRequest(
  route: string,
  projectId: string,
  token: string,
  body: unknown = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/internal/${route}/${projectId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-void-internal': token },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function clearProxyTokenStateCache(): Promise<void> {
  const moduleUrl = new URL('../../../proxy/src/proxy-token.ts', import.meta.url).href;
  const proxyToken = (await import(/* @vite-ignore */ moduleUrl)) as {
    clearProxyTokenStateCache(): void;
  };
  proxyToken.clearProxyTokenStateCache();
}

async function proxyRequest(projectId: string, aiToken: string) {
  const proxyModuleUrl = new URL('../../../proxy/src/index.ts', import.meta.url).href;
  const proxyWorker = (
    (await import(/* @vite-ignore */ proxyModuleUrl)) as {
      default: { fetch(request: Request, env: unknown): Promise<Response> };
    }
  ).default;
  const run = vi.fn(async () => ({ response: 'ok' }));
  const response = await proxyWorker.fetch(
    new Request('https://proxy.example.com/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, aiToken, model: 'test-model', inputs: {} }),
    }),
    {
      ...env,
      AI: {
        run,
        models: vi.fn(async () => []),
        toMarkdown: vi.fn(async () => ({ markdown: '' })),
        gateway: vi.fn(),
      },
    } as never,
  );
  return { response, run };
}

describe('per-project token checks', () => {
  it('rejects a login JWT presented as a project id and token at the proxy', async () => {
    const forged = await loginJwtAsProjectToken();
    const { response, run } = await proxyRequest(forged.projectId, forged.token);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid project token' });
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts a generated project id with its token at the proxy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const { response, run } = await proxyRequest(
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
    );
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['revalidate', 'resolve-resource', 'resolve-worker', 'verify-prerender-build'])(
    'rejects a login JWT presented as a project id and token at /internal/%s',
    async (route) => {
      const forged = await loginJwtAsProjectToken();
      const response = await internalRequest(route, forged.projectId, forged.token);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid internal auth' });
    },
  );

  it('accepts a generated project id with its token at every internal route', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await createResource(env.db, project.id, 'kv', 'cf-kv-id', 'CACHE');
    await env.ROUTING.put(project.slug, JSON.stringify({ version: deployment.id }));
    mockCfApi();
    const token = await hmacSignState(project.id, JWT_SECRET);

    const revalidated = await internalRequest('revalidate', project.id, token, {
      paths: ['/about'],
    });
    expect(revalidated.status).toBe(200);

    const resource = await internalRequest('resolve-resource', project.id, token, {
      type: 'kv',
      binding: 'CACHE',
    });
    expect(resource.status).toBe(200);
    expect(await resource.json()).toEqual({ cf_id: 'cf-kv-id' });

    const worker = await internalRequest('resolve-worker', project.id, token);
    expect(worker.status).toBe(200);
    expect(await worker.json()).toEqual({
      workerName: `user-${project.slug}-${deployment.id}`,
      deploymentId: deployment.id,
    });

    const prerender = await internalRequest('verify-prerender-build', project.id, token, {
      userId: user.id,
    });
    expect(prerender.status).toBe(200);
    expect(await prerender.json()).toEqual({ ok: true });
  });
});

describe('project token generations', () => {
  async function liveProject() {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.ROUTING.put(project.slug, JSON.stringify({ version: deployment.id }));
    mockCfApi();
    return project;
  }

  async function setFloor(projectId: string, value: string) {
    await env.ROUTING.put(`proxy-token:${projectId}`, value);
  }

  beforeEach(async () => {
    await clearProxyTokenStateCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('accepts tokens at or above the floor at the proxy and rejects the legacy token', async () => {
    const project = await liveProject();
    await setFloor(project.id, '{"gen":1}');
    for (const gen of [1, 2]) {
      const { response } = await proxyRequest(
        project.id,
        await deriveProxyToken(JWT_SECRET, project.id, gen),
      );
      expect(response.status).toBe(200);
    }
    const { response, run } = await proxyRequest(
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid project token' });
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts the legacy and v2 tokens at /internal/revalidate while no floor is set', async () => {
    const project = await liveProject();
    for (const gen of [0, 1]) {
      const response = await internalRequest(
        'revalidate',
        project.id,
        await deriveProxyToken(JWT_SECRET, project.id, gen),
        { paths: ['/about'] },
      );
      expect(response.status).toBe(200);
    }
  });

  it('applies the floor at /internal/revalidate', async () => {
    const project = await liveProject();
    await setFloor(project.id, '{"gen":1}');
    for (const gen of [1, 2]) {
      const response = await internalRequest(
        'revalidate',
        project.id,
        await deriveProxyToken(JWT_SECRET, project.id, gen),
        { paths: ['/about'] },
      );
      expect(response.status).toBe(200);
    }
    const legacy = await internalRequest(
      'revalidate',
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
      { paths: ['/about'] },
    );
    expect(legacy.status).toBe(403);
    expect(await legacy.json()).toEqual({ error: 'invalid internal auth' });
  });

  it('fails closed at /internal/revalidate when the floor is malformed', async () => {
    const project = await liveProject();
    await setFloor(project.id, 'not json');
    const response = await internalRequest(
      'revalidate',
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
      { paths: ['/about'] },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'project token state unavailable' });
  });
});
