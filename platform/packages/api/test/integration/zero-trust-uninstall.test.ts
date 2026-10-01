import pg from 'pg';
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
import {
  assertProjectZeroTrustAllowsUninstall,
  lockPlatformProjectZeroTrustConnection,
  readPlatformProjectZeroTrustStateConnection,
} from '../../../../../packages/void/src/cli/platform-zero-trust-uninstall.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { readZeroTrustConfigurationStrict } from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import { lockZeroTrustConfiguration } from '../../src/zero-trust/lock.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// The platform uninstall check in the CLI reads and locks this database
// directly, so these tests run it against the API's real schema and writers.

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
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
  } as unknown as ApiEnv['Bindings'];
}

const configureInput = {
  apiToken: 'access-token',
  identityProviderIds: ['idp-1'],
  policyIds: ['policy-1'],
  protectNewProjects: true,
  existingProjects: 'public' as const,
};

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1' } });
    }
    if (path === 'policies/policy-1') {
      return Response.json({
        success: true,
        result: {
          id: 'policy-1',
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        },
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = `app-${nextApplication++}`;
      const application = { ...body, id, aud: `aud-${id}` };
      applications.set(id, application);
      return Response.json({ success: true, result: application });
    }
    if (path === 'apps') {
      return Response.json({ success: true, result: [...applications.values()] });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match) {
      const id = match[1]!;
      const previous = applications.get(id);
      if (!previous) {
        return Response.json(
          { success: false, errors: [{ message: 'application not found' }] },
          { status: 404 },
        );
      }
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const application = { ...body, id, aud: previous.aud };
        applications.set(id, application);
        return Response.json({ success: true, result: application });
      }
      if (init?.method === 'DELETE') {
        applications.delete(id);
        return Response.json({ success: true, result: { id } });
      }
      return Response.json({ success: true, result: previous });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

async function settleOperation(platform: ApiEnv['Bindings']): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await readZeroTrustConfigurationStrict(env.db))!.operation) {
      return;
    }
    await reconcilePlatformZeroTrust(platform, env.db);
  }
  throw new Error('The Zero Trust operation did not finish within its expected batches');
}

type QueryConnection = Parameters<typeof readPlatformProjectZeroTrustStateConnection>[0];

describe('platform uninstall check against the API database', () => {
  it('lets uninstall proceed once a project deletion that stopped partway is rerun', async () => {
    const owner = await createTestUser(env.db, 'stopped-deletion-owner');
    const project = await createTestProject(env.db, owner.id, 'stopped-deletion');
    await env.ROUTING.put(project.slug, JSON.stringify({ projectId: project.id }));
    const cloudflare = accessApi();
    const provider = mockCfApi() as unknown as typeof fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      new URL(input.toString()).pathname.includes('/access/')
        ? cloudflare.fetcher(input, init)
        : provider(input, init),
    );
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configureInput);
    await settleOperation(platform);
    const bypass = (await getProjectZeroTrustState(env.db, project.id))!;
    expect(cloudflare.applications.has(bypass.bypass_application_id!)).toBe(true);
    const deleteProject = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${owner.jwt}` },
        }),
        platform,
      );

    // Teardown marks the project deleting, then fails before Access cleanup.
    const deleteRoute = env.ROUTING.delete.bind(env.ROUTING);
    const routeDelete = vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      if (key === project.slug) {
        throw new Error('temporary KV failure');
      }
      return deleteRoute(key);
    });
    expect((await deleteProject()).status).toBe(500);
    routeDelete.mockRestore();

    // Disable and hourly maintenance both skip the deleting project.
    await disablePlatformZeroTrust(platform, env.db);
    await settleOperation(platform);
    await reconcilePendingProjectZeroTrust(platform, env.db);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      operation: null,
    });
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      bypass_application_id: bypass.bypass_application_id,
    });

    const connection = (env.db as unknown as { $client: QueryConnection }).$client;
    const check = () =>
      assertProjectZeroTrustAllowsUninstall(() =>
        readPlatformProjectZeroTrustStateConnection(connection),
      );
    const refusal = await check().catch((error: unknown) => error as Error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal!.message).toContain('Deletion of project stopped-deletion stopped');
    expect(refusal!.message).toContain('`void project delete <name>`');

    // The operator follows the dashboard hint first, then reruns the deletion.
    cloudflare.applications.delete(bypass.bypass_application_id!);
    expect((await deleteProject()).status).toBe(200);
    await expect(check()).resolves.toBeUndefined();
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'holds off Zero Trust writers while uninstall holds the configuration lock',
    async () => {
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      const platform = bindings();
      const session = new pg.Client({ connectionString: process.env.VOID_TEST_DATABASE_URL });
      await session.connect();
      try {
        const unlock = await lockPlatformProjectZeroTrustConnection(session);
        const check = () => readPlatformProjectZeroTrustStateConnection(session);
        expect(await check()).toMatchObject({ active: false, applications: [] });

        const events: Array<string> = [];
        const configure = configurePlatformZeroTrust(platform, env.db, configureInput).then(() =>
          events.push('configure'),
        );
        // Project protection changes and deployments take the shared side.
        const projectWriter = env.db.transaction(async (tx) => {
          await lockZeroTrustConfiguration(tx, 'shared');
          events.push('project write');
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(events).toEqual([]);
        expect(cloudflare.applications.size).toBe(0);
        expect(await check()).toMatchObject({ active: false, applications: [] });

        events.push('traffic disabled');
        await unlock();
        await Promise.all([configure, projectWriter]);
        expect(events[0]).toBe('traffic disabled');
        expect(events).toContain('configure');
        expect(await check()).toMatchObject({ active: true });
      } finally {
        await session.end();
      }
    },
  );
});
