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
  createTestProjectSecret,
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function buildDeployRequest(projectId: string, jwt: string, manifest: object): Request {
  const workerSrc = "export default { fetch() { return new Response('ok'); } }";
  return new Request(`http://localhost/projects/${projectId}/deploy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      manifest: { assetManifestVersion: 2, ...manifest },
      assetManifest: {},
      source: null,
      commit: null,
      repositoryUrl: null,
      commitUrl: null,
      gitRef: null,
      preflight: null,
      workerFiles: { 'index.js': bytesToBase64(new TextEncoder().encode(workerSrc)) },
    }),
  });
}

describe('manifest var / secret collision warning', () => {
  it('logs warning when manifest vars collide with project secrets', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'collision-app');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'secret-value');
    mockCfApi();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.fetch(
      buildDeployRequest(project.id, user.jwt, {
        version: 3,
        bindings: {},
        vars: { API_KEY: 'from-manifest' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    await res.text();

    // Logger emits a structured JSON line via console.warn; the relevant
    // record carries `msg: 'var_secret_collisions'` and the colliding name
    // in `collisions`.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('var_secret_collisions'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API_KEY'));
  });
});
