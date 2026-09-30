import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformInstallationManifest } from '@void/platform';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { hyperdriveOriginFromConnectionString } from '../../src/cli/platform-cloudflare.ts';
import {
  createPlatformInstallationSecrets,
  installPlatform,
} from '../../src/cli/platform-installer.ts';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import { listInstallationManifests } from '../../src/cli/platform-registry.ts';
import type { RunWrangler } from '../../src/cli/provision.ts';

// Runs the real Worker deploy, cutover checkpoint, and pre-traffic verification
// against a stateful in-memory Cloudflare account. Only the Wrangler process is
// replaced; the guarded create still goes through the conditional-create proxy.
const wrangler = vi.hoisted(() => ({ run: null as RunWrangler | null }));
vi.mock('../../src/cli/provision.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/provision.ts')>()),
  createDefaultRunWrangler: () => (args: Array<string>, opts: Parameters<RunWrangler>[1]) =>
    wrangler.run!(args, opts),
}));

const TEST_PLATFORM_JWT_SECRET = 'test-only-platform-jwt-secret-material';
const TEST_PLATFORM_PROJECT_SECRET_KEY = Buffer.alloc(32, 5).toString('base64');
const directories: Array<string> = [];
const servers: Array<Server> = [];

beforeEach(() => {
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-install-cutover-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
});

afterEach(async () => {
  wrangler.run = null;
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

type FakeVersion = {
  annotations: Record<string, string>;
  id: string;
  resources: {
    bindings: Array<{ name: string; text: string; type: string }>;
    script_runtime?: { migration_tag: string };
  };
};
type FakeDeployment = {
  created_on: string;
  id: string;
  versions: Array<{ percentage: number; version_id: string }>;
};

async function createFakeCloudflare() {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"errors":[],"result":{}}');
    });
  });
  servers.push(upstream);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const apiBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/client/v4`;
  const workers = new Map<
    string,
    { deployments: Array<FakeDeployment>; versions: Map<string, FakeVersion> }
  >();
  const kv = new Map<string, string>();
  const r2 = new Map<string, string>();
  const named = new Map<string, Map<string, string>>();
  const commands: Array<{ args: Array<string>; worker: string | null }> = [];
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  let failBlockedCreate: string | null = null;
  let failUpload: string | null = null;

  const flag = (args: Array<string>, ...names: Array<string>) => {
    const index = args.findIndex((arg) => names.includes(arg));
    return index === -1 ? undefined : args[index + 1];
  };
  const configOf = (args: Array<string>): Record<string, unknown> | null => {
    const path = flag(args, '--config', '-c');
    return path ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
  };
  const workerOf = (args: Array<string>) =>
    flag(args, '--name') ?? (configOf(args)?.name as string | undefined) ?? null;
  const ok = (stdout = '') => ({ status: 0, stderr: '', stdout });
  const failed = (stderr: string) => ({ status: 1, stderr, stdout: '' });
  const storeVersion = (name: string, args: Array<string>): FakeVersion => {
    const config = configOf(args)!;
    const vars = (config.vars ?? {}) as Record<string, string>;
    const migrations = Array.isArray(config.migrations) ? config.migrations : [];
    const tag = (migrations.at(-1) as { tag?: string } | undefined)?.tag;
    const version: FakeVersion = {
      annotations: { 'workers/message': flag(args, '--message') ?? '' },
      id: randomUUID(),
      resources: {
        bindings: [
          {
            name: 'PLATFORM_OWNERSHIP_MARKER',
            text: vars.PLATFORM_OWNERSHIP_MARKER ?? '',
            type: 'plain_text',
          },
        ],
        ...(tag ? { script_runtime: { migration_tag: tag } } : {}),
      },
    };
    const worker = workers.get(name) ?? { deployments: [], versions: new Map() };
    worker.versions.set(version.id, version);
    workers.set(name, worker);
    return version;
  };
  const activate = (name: string, versionId: string) => {
    workers.get(name)!.deployments.unshift({
      created_on: new Date((clock += 1000)).toISOString(),
      id: randomUUID(),
      versions: [{ percentage: 100, version_id: versionId }],
    });
  };

  wrangler.run = async (args, opts) => {
    const worker = workerOf(args);
    commands.push({ args, worker });
    const command = `${args[0]} ${args[1] ?? ''}`.trim();
    if (args[0] === 'deploy') {
      const base = `${opts.apiBaseUrl}/accounts/${opts.accountId}/workers/scripts/${worker}`;
      if (failBlockedCreate === worker) {
        failBlockedCreate = null;
        await fetch(`${base}/unexpected-mutation`, { method: 'POST' });
        return failed('Mutation blocked until conditional Worker creation succeeds');
      }
      const created = await fetch(`${base}?excludeScript=true`, { method: 'PUT', body: '{}' });
      if (!created.ok) {
        return failed(`create failed (${created.status})`);
      }
      const version = storeVersion(worker!, args);
      activate(worker!, version.id);
      return ok(`Uploaded ${worker}\nCurrent Version ID: ${version.id}`);
    }
    if (command === 'versions upload') {
      if (failUpload === worker) {
        failUpload = null;
        return failed('upload failed');
      }
      const version = storeVersion(worker!, args);
      return ok(`Worker Version ID: ${version.id}`);
    }
    if (command === 'versions deploy') {
      const targets = args.slice(2).filter((arg) => /@\d+$/.test(arg));
      const entry = workers.get(worker!)!;
      entry.deployments.unshift({
        created_on: new Date((clock += 1000)).toISOString(),
        id: randomUUID(),
        versions: targets.map((target) => {
          const [versionId, percentage] = target.split('@');
          return { percentage: Number(percentage), version_id: versionId! };
        }),
      });
      return ok();
    }
    if (command === 'deployments list') {
      const entry = workers.get(worker!);
      return entry ? ok(JSON.stringify(entry.deployments)) : failed('Worker not found');
    }
    if (command === 'deployments status') {
      const latest = workers.get(worker!)?.deployments[0];
      return latest ? ok(JSON.stringify({ versions: latest.versions })) : failed('not found');
    }
    if (command === 'versions view') {
      const version = workers.get(worker!)?.versions.get(args[2]!);
      return version ? ok(JSON.stringify(version)) : failed('version not found');
    }
    if (command === 'triggers deploy') {
      return ok();
    }
    throw new Error(`Unexpected Wrangler command: ${args.join(' ')}`);
  };

  const create =
    (kind: string) =>
    async (_account: string, name: string, ..._rest: Array<unknown>) => {
      const resources = named.get(kind) ?? new Map<string, string>();
      named.set(kind, resources);
      // AI Gateways are addressed by name.
      const id =
        resources.get(name) ?? (kind === 'ai-gateway' ? name : `${kind}-${resources.size}`);
      resources.set(name, id);
      return {
        id,
        name,
        ...(kind === 'r2' ? { fingerprint: '2026-10-01T00:00:00.000Z' } : {}),
      };
    };
  const list = (kind: string, name?: string) =>
    [...(named.get(kind) ?? new Map<string, string>())]
      .filter(([entry]) => name === undefined || entry === name)
      .map(([entry, id]) => ({
        id,
        name: entry,
        ...(kind === 'r2' ? { fingerprint: '2026-10-01T00:00:00.000Z' } : {}),
      }));
  const plainTextBindings = async (_account: string, name: string) => {
    const entry = workers.get(name);
    const active = entry?.deployments[0]?.versions[0]?.version_id;
    const version = active ? entry!.versions.get(active) : undefined;
    return Object.fromEntries(
      (version?.resources.bindings ?? []).map((binding) => [binding.name, binding.text]),
    );
  };

  const client = {
    apiBaseUrl,
    createAiGateway: create('ai-gateway'),
    createDispatchNamespace: create('dispatch'),
    createDnsRecord: async (): Promise<never> => {
      throw new Error('No DNS expected');
    },
    createHyperdrive: create('hyperdrive'),
    createKvNamespace: create('kv'),
    createQueue: create('queue'),
    createR2Bucket: create('r2'),
    createZone: async (): Promise<never> => {
      throw new Error('No zone expected');
    },
    deleteKvValue: async (_account: string, namespace: string, key: string) => {
      kv.delete(`${namespace}/${key}`);
    },
    disableHyperdriveCaching: async () => {},
    getHyperdriveConfig: async (_account: string, id: string) => ({
      cachingDisabled: true,
      id,
      name: list('hyperdrive').find((entry) => entry.id === id)!.name,
      origin: hyperdriveOriginFromConnectionString(DATABASE_URL),
    }),
    getWorkerPlainTextBindings: plainTextBindings,
    listWorkerDomains: async () => [],
    listWorkerNames: async () => [...workers.keys()],
    listWorkerRoutes: async () => [],
    listWorkerServiceRoutes: async () => [],
    publishWorkerCustomDomainsSafely: async () => {},
    publishWorkerRoutesSafely: async () => {},
    putKvValue: async (_account: string, namespace: string, key: string, value: string) => {
      kv.set(`${namespace}/${key}`, value);
    },
    putR2Object: async (_account: string, bucket: string, key: string, value: string) => {
      r2.set(`${bucket}/${key}`, value);
    },
    removeRoutes: async () => {},
  };
  const planningClient = {
    findZone: async (): Promise<never> => {
      throw new Error('No zone expected');
    },
    findZoneForHostname: async () => null,
    getKvValue: async (_account: string, namespace: string, key: string) =>
      kv.get(`${namespace}/${key}`) ?? null,
    getR2Object: async (_account: string, bucket: string, key: string) =>
      r2.get(`${bucket}/${key}`) ?? null,
    getWorkerPlainTextBindings: plainTextBindings,
    getWorkersSubdomain: async () => 'workers-subdomain',
    hasActiveCertificateForHostname: async () => true,
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    listAiGateways: async () => list('ai-gateway'),
    listDispatchNamespaces: async () => list('dispatch'),
    listDnsRecords: async () => [],
    listHyperdriveConfigs: async () => list('hyperdrive'),
    listKvNamespaces: async (_account: string, title?: string) => list('kv', title),
    listQueues: async (_account: string, name: string) => list('queue', name),
    listR2Buckets: async () => list('r2'),
    listWorkerDomains: async () => [],
    listWorkerNames: async () => [...workers.keys()],
    listWorkerRoutes: async () => [],
  };
  return {
    client,
    commands,
    failBlockedCreate: (worker: string) => {
      failBlockedCreate = worker;
    },
    failUpload: (worker: string) => {
      failUpload = worker;
    },
    kv,
    planningClient,
  };
}

const DATABASE_URL = 'postgres://user:password@db.example.com/testing';

function installationSecrets() {
  return createPlatformInstallationSecrets({
    bootstrapGitHubId: '583231',
    bootstrapGitHubLogin: 'octocat',
    cloudflareApiToken: 'test-token',
    databaseUrl: DATABASE_URL,
    githubClientId: 'id',
    githubClientSecret: 'secret',
    jwtSecret: TEST_PLATFORM_JWT_SECRET,
    projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
    r2AccessKeyId: 'id',
    r2SecretAccessKey: 'secret',
  });
}

function planInstallation(
  cloud: Awaited<ReturnType<typeof createFakeCloudflare>>,
  existing: PlatformInstallationManifest | null,
) {
  return createPlatformInstallPlan(
    cloud.planningClient,
    {
      accountId: 'account',
      applicationDomain: '',
      controlPlaneDomain: '',
      dedicatedZone: false,
      displayName: 'Testing',
      installationSlug: 'testing',
      workersDev: true,
      zoneName: '',
    },
    existing,
  );
}

async function runInstall(
  cloud: Awaited<ReturnType<typeof createFakeCloudflare>>,
  existing: PlatformInstallationManifest | null,
) {
  const plan = await planInstallation(cloud, existing);
  return installPlatform(plan, installationSecrets(), existing, {
    acquireDatabaseLifecycleLock: async () =>
      Object.assign(async () => {}, {
        prepareSandboxDrain: async () => ({
          admissionProtocol: 3 as const,
          generation: 'generation-1',
          mirrorValue: JSON.stringify({
            completedAt: '2026-10-01T00:00:00.000Z',
            generation: 'generation-1',
            startedAt: '2026-10-01T00:00:00.000Z',
            state: 'complete',
            updatedAt: '2026-10-01T00:00:00.000Z',
            version: 1,
          }),
          state: 'complete' as const,
        }),
      }),
    claimDatabase: async () => {},
    client: cloud.client,
    migrateDatabase: async () => {},
    revalidateBeforeWorkerDeploy: async () => {},
    verifyHealth: async () => {},
  });
}

function currentManifest(): PlatformInstallationManifest {
  return listInstallationManifests(process.env.VOID_PLATFORM_REGISTRY_DIR!)[0]!;
}

function workerStepKeys(manifest: PlatformInstallationManifest) {
  return manifest.steps.map((step) => step.key).filter((key) => key.startsWith('worker-'));
}

const WORKER_KEYS = ['api', 'proxy', 'emailGateway', 'tail', 'dispatch'];

function stagedKeys(manifest: PlatformInstallationManifest, generation: number) {
  const prefix = `worker-cutover:${generation}:staged:`;
  return workerStepKeys(manifest)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

it('stages a fresh immutable version of every Worker before enabling a fresh install', async () => {
  const cloud = await createFakeCloudflare();

  const result = await runInstall(cloud, null);

  expect(result.manifest.status).toBe('installed');
  expect(stagedKeys(result.manifest, 1)).toEqual([...WORKER_KEYS].sort());
  expect(stagedKeys(result.manifest, 2)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(result.manifest)).toContain('worker-cutover:2:committed');
  // The tail Worker config is identical in both generations, yet it is still restaged.
  const tail = result.manifest.deployment.resources.tailWorker;
  expect(
    cloud.commands
      .filter((command) => command.worker === tail)
      .map((command) => command.args.slice(0, 2).join(' '))
      .filter((command) => command.startsWith('deploy ') || command === 'versions upload'),
  ).toEqual(['deploy --config', 'versions upload']);
});

it('enables traffic when resuming after the first Worker create was refused', async () => {
  const cloud = await createFakeCloudflare();
  const plan = await planInstallation(cloud, null);
  cloud.failBlockedCreate(plan.deployment.resources.apiWorker);

  await expect(runInstall(cloud, null)).rejects.toThrow('unexpected mutation');
  const failed = currentManifest();
  expect(failed.status).toBe('failed');
  expect(workerStepKeys(failed)).toEqual([]);

  const resumed = await runInstall(cloud, failed);

  expect(resumed.manifest.status).toBe('installed');
  expect(stagedKeys(resumed.manifest, 1)).toEqual([...WORKER_KEYS].sort());
  expect(stagedKeys(resumed.manifest, 2)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(resumed.manifest)).toContain('worker-cutover:2:committed');
});

it('retries a restored enabling generation with every Worker restaged', async () => {
  const cloud = await createFakeCloudflare();
  const plan = await planInstallation(cloud, null);
  // The tail Worker is created with a guarded deploy, so its first version
  // upload is the enabling generation. Failing it leaves that generation restored.
  cloud.failUpload(plan.deployment.resources.tailWorker);

  await expect(runInstall(cloud, null)).rejects.toThrow('upload failed');
  const failed = currentManifest();
  expect(failed.status).toBe('failed');
  expect(workerStepKeys(failed)).toEqual(
    expect.arrayContaining(['worker-cutover:1:committed', 'worker-cutover:2:restored']),
  );
  expect(stagedKeys(failed, 2)).not.toContain('tail');

  const retried = await runInstall(cloud, failed);

  expect(retried.manifest.status).toBe('installed');
  // The staging generation still reuses an unchanged Worker version.
  expect(stagedKeys(retried.manifest, 3)).not.toContain('tail');
  expect(stagedKeys(retried.manifest, 4)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(retried.manifest)).toContain('worker-cutover:4:committed');
});
