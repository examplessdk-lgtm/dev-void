import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
  type PlatformInstallationManifest,
} from '@void/platform';
import { getPlatformRuntimeDirectory, resolvePlatformRuntime } from '@void/platform/installer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({
  createSecrets: vi.fn(),
  events: [] as Array<string>,
  manifest: undefined as PlatformInstallationManifest | undefined,
  prepareDatabase: vi.fn(),
  runtime: undefined as ReturnType<typeof resolvePlatformRuntime> | undefined,
}));

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), success: vi.fn() },
  note: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
}));

vi.mock('../../src/cli/platform-auth.ts', () => ({
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
  resolvePlatformCloudflareCredential: async () => ({ token: 'token' }),
}));

vi.mock('../../src/cli/platform-cloudflare.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-cloudflare.ts')>();
  return {
    ...actual,
    PlatformCloudflareClient: class {
      async getKvValue() {
        return JSON.stringify(state.manifest);
      }

      async listAiGateways() {
        return [];
      }

      async listDispatchNamespaces() {
        return [];
      }

      async listHyperdriveConfigs() {
        return [];
      }

      async listKvNamespaces() {
        const routing = state.manifest?.resources.find((resource) => resource.key === 'routing-kv');
        return routing ? [{ id: routing.id, name: routing.name }] : [];
      }

      async listR2Buckets() {
        return [];
      }

      async listWorkerNames() {
        return [];
      }
    },
  };
});

vi.mock('../../src/cli/platform-installer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-installer.ts')>();
  return {
    ...actual,
    acquirePlatformDatabaseLifecycleLock: vi.fn(async () => {
      const release = Object.assign(
        async () => {
          state.events.push('outer-release');
        },
        {
          authoritativeManifest: state.manifest,
          checkpoint: vi.fn(),
          prepareDatabase: state.prepareDatabase,
        },
      );
      return release;
    }),
    createPlatformInstallationSecrets: state.createSecrets,
    installPlatform: vi.fn(async (...args: Parameters<typeof actual.installPlatform>) => {
      const existing = args[2];
      const dependencies = args[3];
      const borrowed = await dependencies.acquireDatabaseLifecycleLock(
        'postgres://database',
        existing!.id,
        existing!.ownershipNonce,
      );
      expect(borrowed.prepareDatabase).toBe(state.prepareDatabase);
      state.events.push('installer-start');
      await borrowed.prepareDatabase!(
        state.runtime!.directory,
        state.runtime!.manifest.database,
        existing!.platformVersion,
        false,
      );
      state.events.push('installer-finish');
      await borrowed();
      return {
        manifest: existing!,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
      };
    }),
    loadPlatformRuntime: vi.fn(() => state.runtime),
    resolveBootstrapGitHubId: vi.fn(),
  };
});

vi.mock('../../src/cli/platform-lifecycle.ts', () => ({
  assertNoninteractivePlatformMutationAcknowledged: vi.fn(),
  resolvePlatformInstallDatabaseUrl: () => 'postgres://database',
}));

vi.mock('../../src/cli/platform-plan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-plan.ts')>();
  return {
    ...actual,
    createPlatformInstallPlan: vi.fn(async () => ({
      account: state.manifest!.account,
      actions: [
        {
          action: 'reuse',
          id: 'routing-kv-id',
          key: 'routing-kv',
          kind: 'kv-namespace',
          name: 'routing-kv',
          reason: 'already installed',
        },
      ],
      apiUrl: 'https://api.example.com',
      deployment: state.manifest!.deployment,
      installationId: state.manifest!.id,
      proxyUrl: 'https://proxy.example.com',
      workersSubdomain: 'workers.dev',
      zone: null,
    })),
    formatPlatformInstallPlan: vi.fn(() => 'upgrade plan'),
    revalidatePlatformInstallAction: vi.fn(),
  };
});

vi.mock('../../src/cli/platform-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-registry.ts')>();
  return {
    ...actual,
    acquirePlatformLifecycleLock: vi.fn(() => () => state.events.push('local-release')),
    listInstallationManifests: vi.fn(() => [state.manifest]),
    readInstallationRecoverySecrets: vi.fn(() => ({ databaseUrl: 'postgres://database' })),
    resolveInstallationManifest: vi.fn(() => state.manifest),
    writeInstallationManifest: vi.fn(),
  };
});

import { runInstalledPlatformCommand } from '../../src/cli/platform-management.ts';

describe('installed platform upgrade', () => {
  beforeEach(() => {
    state.createSecrets.mockReset().mockReturnValue({});
    state.events.length = 0;
    state.prepareDatabase.mockReset().mockImplementation(async (_directory, database) => {
      state.events.push(`prepare:${database.schemaDigest}`);
      return {
        appliedMigrations: 1,
        previousSchemaDigest: 'old-schema',
        schemaDigest: database.schemaDigest,
      };
    });
    state.runtime = resolvePlatformRuntime(getPlatformRuntimeDirectory());
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'routing-kv-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'routing-kv',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'database-schema:old-schema',
        resultHash: 'old-schema',
      },
      '2026-09-14T00:00:01.000Z',
    );
    for (const status of [
      'planned',
      'provisioning',
      'deploying',
      'verifying',
      'installed',
    ] as const) {
      manifest = transitionInstallation(manifest, status, '2026-09-14T00:00:02.000Z');
    }
    state.manifest = manifest;
  });

  afterEach(() => {
    delete process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION;
    delete process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON;
  });

  it('borrows database preparation from the held lifecycle lock', async () => {
    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'upgrade',
      yes: true,
    });

    expect(state.prepareDatabase).toHaveBeenCalledWith(
      state.runtime!.directory,
      state.runtime!.manifest.database,
      '1.0.0',
      false,
    );
    expect(state.events).toEqual([
      'installer-start',
      `prepare:${state.runtime!.manifest.database.schemaDigest}`,
      'installer-finish',
      'outer-release',
      'local-release',
    ]);
  });

  it('forwards an explicitly restored complete project-secret keyring during repair', async () => {
    const keysJson = JSON.stringify({
      v1: Buffer.alloc(32, 1).toString('base64'),
      v2: Buffer.alloc(32, 2).toString('base64'),
    });
    process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION = 'v2';
    process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON = keysJson;

    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'repair',
      yes: true,
    });

    expect(state.createSecrets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectSecretActiveKeyVersion: 'v2',
        projectSecretKeysJson: keysJson,
      }),
    );
  });

  it('releases the held lifecycle lock when database preparation fails', async () => {
    state.prepareDatabase.mockImplementationOnce(async () => {
      state.events.push('prepare:failed');
      throw new Error('migration failed');
    });

    await expect(
      runInstalledPlatformCommand({
        plan: false,
        runtime: '',
        selector: state.manifest!.id,
        subcommand: 'upgrade',
        yes: true,
      }),
    ).rejects.toThrow('migration failed');

    expect(state.events).toEqual([
      'installer-start',
      'prepare:failed',
      'outer-release',
      'local-release',
    ]);
  });
});
