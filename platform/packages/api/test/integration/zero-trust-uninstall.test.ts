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
  lockPlatformProjectZeroTrustConnection,
  readPlatformProjectZeroTrustStateConnection,
} from '../../../../../packages/void/src/cli/platform-zero-trust-uninstall.ts';
import type { ApiEnv } from '../../src/env.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { lockZeroTrustConfiguration } from '../../src/zero-trust/lock.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

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

describe('platform uninstall check against the API database', () => {
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
