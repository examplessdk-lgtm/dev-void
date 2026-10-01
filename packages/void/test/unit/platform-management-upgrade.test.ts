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
  readAuthenticationState: vi.fn(),
  readPlanZeroTrust: vi.fn(),
  readProjectZeroTrust: vi.fn(),
  releaseDatabase: vi.fn(),
  spinner: vi.fn(),
  progress: { start: vi.fn(), message: vi.fn(), stop: vi.fn(), error: vi.fn(), clear: vi.fn() },
  runtime: undefined as ReturnType<typeof resolvePlatformRuntime> | undefined,
}));

vi.mock('../../src/cli/output.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/output.ts')>()),
  createSpinner: state.spinner,
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

      async putKvValue(_account: string, _namespace: string, key: string) {
        state.events.push(`put:${key}`);
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
          await state.releaseDatabase();
          state.events.push('outer-release');
        },
        {
          authoritativeManifest: state.manifest,
          checkpoint: vi.fn(),
          prepareDatabase: state.prepareDatabase,
          readAuthenticationState: state.readAuthenticationState,
          readProjectZeroTrust: state.readProjectZeroTrust,
        },
      );
      return release;
    }),
    createPlatformInstallationSecrets: state.createSecrets,
    installPlatform: vi.fn(async (...args: Parameters<typeof actual.installPlatform>) => {
      expect(state.progress.start).toHaveBeenCalled();
      expect(state.progress.stop).not.toHaveBeenCalled();
      const existing = args[2];
      const dependencies = args[3];
      const borrowed = await dependencies.acquireDatabaseLifecycleLock(
        'postgres://database',
        existing!.id,
        existing!.ownershipNonce,
      );
      expect(borrowed.prepareDatabase).toBe(state.prepareDatabase);
      expect(borrowed.readAuthenticationState).toBe(state.readAuthenticationState);
      await borrowed.readAuthenticationState!();
      state.events.push('installer-start');
      dependencies.onProgress?.('Deploying the api service');
      await borrowed.prepareDatabase!(
        state.runtime!.directory,
        state.runtime!.manifest.database,
        existing!.platformVersion,
        false,
      );
      state.events.push('installer-finish');
      dependencies.onProgress?.('Verifying the enabled platform');
      await borrowed();
      return {
        manifest: existing!,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
      };
    }),
    loadPlatformRuntime: vi.fn(() => state.runtime),
    readPlatformProjectZeroTrustState: state.readPlanZeroTrust,
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

import { log, note } from '@clack/prompts';
import {
  acquirePlatformDatabaseLifecycleLock,
  installPlatform,
} from '../../src/cli/platform-installer.ts';
import { runInstalledPlatformCommand } from '../../src/cli/platform-management.ts';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';

describe('installed platform upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.spinner.mockReturnValue(state.progress);
    state.releaseDatabase.mockReset().mockResolvedValue(undefined);
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
    state.readAuthenticationState.mockReset().mockResolvedValue(null);
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION;
    delete process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON;
  });

  it('includes shared email configuration when planning an upgrade', async () => {
    vi.stubEnv('VOID_EMAIL_SHARED_ZONE_ID', 'mail-zone');
    vi.stubEnv('VOID_EMAIL_SENDER_DOMAIN', 'mail.example.com');
    await runInstalledPlatformCommand({
      plan: true,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'upgrade',
      yes: true,
    });
    expect(createPlatformInstallPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        emailSharedZoneId: 'mail-zone',
        emailSenderDomain: 'mail.example.com',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each(['upgrade', 'repair'] as const)(
    'passes an explicitly configured dashboard origin through %s planning',
    async (subcommand) => {
      await runInstalledPlatformCommand({
        subcommand,
        selector: state.manifest!.id,
        plan: true,
        runtime: '',
        yes: true,
        dashboardUrl: 'https://dash.example.org:8443',
      });
      expect(createPlatformInstallPlan).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dashboardUrl: 'https://dash.example.org:8443' }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

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
    expect(state.progress.start).toHaveBeenCalledWith('Upgrading the platform');
    expect(state.progress.message).toHaveBeenCalledWith('Deploying the api service');
    expect(state.progress.message).toHaveBeenCalledWith('Verifying the enabled platform');
    expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith('Platform upgrade complete.');
    expect(state.progress.error).not.toHaveBeenCalled();
    expect(state.progress.stop.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(log.success).mock.invocationCallOrder[0]!,
    );
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
    expect(state.progress.start).toHaveBeenCalledWith('Repairing the platform');
  });

  it('forwards the dedicated email key and recorded capability during maintenance', async () => {
    const emailSigningSecret = 'restored-email-signing-secret-material';
    vi.stubEnv('VOID_PLATFORM_EMAIL_SIGNING_SECRET', emailSigningSecret);
    state.manifest = {
      ...state.manifest!,
      deployment: createPlatformDeploymentManifest({
        ...state.manifest!.deployment,
        capabilities: { ...state.manifest!.deployment.capabilities, email: true },
        emailSenderDomain: 'mail.example.com',
        emailSharedZoneId: 'mail-zone',
      }),
    };

    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest.id,
      subcommand: 'repair',
      yes: true,
    });

    expect(state.createSecrets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emailEnabled: true,
        emailSigningSecret,
        existingEmailEnabled: true,
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
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(state.progress.stop).not.toHaveBeenCalled();
  });

  it('does not start deployment progress for a plan-only run', async () => {
    await runInstalledPlatformCommand({
      plan: true,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'upgrade',
      yes: false,
    });
    expect(state.spinner).not.toHaveBeenCalled();
    expect(installPlatform).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it('stops progress when preparation fails before deployment starts', async () => {
    state.createSecrets.mockImplementationOnce(() => {
      throw new Error('invalid credentials');
    });
    await expect(
      runInstalledPlatformCommand({
        plan: false,
        runtime: '',
        selector: state.manifest!.id,
        subcommand: 'upgrade',
        yes: true,
      }),
    ).rejects.toThrow('invalid credentials');
    expect(installPlatform).not.toHaveBeenCalled();
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(state.events).toEqual(['outer-release', 'local-release']);
  });

  it('keeps progress active through final database lock release', async () => {
    state.releaseDatabase.mockImplementationOnce(async () => {
      expect(state.progress.message).toHaveBeenLastCalledWith('Finalizing platform changes');
      expect(state.progress.stop).not.toHaveBeenCalled();
      expect(log.success).not.toHaveBeenCalled();
    });
    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'upgrade',
      yes: true,
    });
    expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith('Platform upgrade complete.');
  });

  it('reports a finalization failure without claiming success and still releases the local lock', async () => {
    state.releaseDatabase.mockRejectedValueOnce(new Error('database release failed'));
    await expect(
      runInstalledPlatformCommand({
        plan: false,
        runtime: '',
        selector: state.manifest!.id,
        subcommand: 'upgrade',
        yes: true,
      }),
    ).rejects.toThrow('database release failed');
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(state.progress.stop).not.toHaveBeenCalled();
    expect(log.success).not.toHaveBeenCalled();
    expect(state.events.at(-1)).toBe('local-release');
  });

  it.each(['waitingForDns', 'waitingForSandboxDrain'] as const)(
    'stops progress before explaining a %s pause',
    async (reason) => {
      vi.mocked(installPlatform).mockResolvedValueOnce({
        manifest: state.manifest!,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
        [reason]: true,
      });
      await runInstalledPlatformCommand({
        plan: false,
        runtime: '',
        selector: state.manifest!.id,
        subcommand: 'upgrade',
        yes: true,
      });
      expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith(
        'Platform operation paused; progress is saved.',
      );
      expect(state.progress.error).not.toHaveBeenCalled();
      expect(log.success).not.toHaveBeenCalled();
      expect(state.progress.stop.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(note).mock.invocationCallOrder.at(-1)!,
      );
      expect(state.events).toEqual(['outer-release', 'local-release']);
    },
  );

  it('forwards spinner cancellation to coordinated CLI shutdown', async () => {
    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'upgrade',
      yes: true,
    });
    const onCancel = state.spinner.mock.calls[0]![0].onCancel;
    const emit = vi.spyOn(process, 'emit').mockReturnValueOnce(true);
    onCancel();
    expect(emit).toHaveBeenCalledWith('SIGINT');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('test exit');
    });
    emit.mockReturnValueOnce(false);
    expect(onCancel).toThrow('test exit');
    expect(exit).toHaveBeenCalledWith(130);
  });

  describe('uninstall with project Zero Trust', () => {
    const enabled = {
      active: true,
      destinations: ['*.apps.example.com'],
      applications: [{ role: 'shared project application', id: 'app', name: 'void-app' }],
      unfinishedDeletions: [],
    };
    const uninstall = (plan: boolean) =>
      runInstalledPlatformCommand({
        deleteZone: null,
        plan,
        purgeData: true,
        selector: state.manifest!.id,
        subcommand: 'uninstall',
        yes: true,
      });

    it('reads the state under the held lifecycle lock and refuses before disabling traffic', async () => {
      state.readProjectZeroTrust.mockResolvedValueOnce(enabled);
      await expect(uninstall(false)).rejects.toThrow(
        'Refusing to uninstall while project Zero Trust is enabled',
      );
      expect(state.readProjectZeroTrust).toHaveBeenCalledOnce();
      expect(state.readPlanZeroTrust).not.toHaveBeenCalled();
      expect(state.events).toEqual(['outer-release', 'local-release']);
    });

    it('refuses when the held lock cannot read the state', async () => {
      state.readProjectZeroTrust.mockRejectedValueOnce(new Error('relation is locked'));
      await expect(uninstall(false)).rejects.toThrow(
        'could not be read from the platform database: relation is locked',
      );
      expect(state.events).toEqual(['outer-release', 'local-release']);
    });

    it('reads the state for a plan without taking the lifecycle lock', async () => {
      state.readPlanZeroTrust.mockResolvedValueOnce(enabled);
      await expect(uninstall(true)).rejects.toThrow(
        'Refusing to uninstall while project Zero Trust is enabled',
      );
      expect(state.readPlanZeroTrust).toHaveBeenCalledExactlyOnceWith(
        'postgres://database',
        state.manifest!.id,
        state.manifest!.ownershipNonce,
      );
      expect(acquirePlatformDatabaseLifecycleLock).not.toHaveBeenCalled();
      expect(state.events).toEqual([]);
    });

    it('plans the uninstall when Zero Trust owns nothing', async () => {
      state.readPlanZeroTrust.mockResolvedValueOnce({
        active: false,
        destinations: [],
        applications: [],
      });
      await uninstall(true);
      expect(note).toHaveBeenCalledWith(expect.any(String), 'Uninstall plan');
      expect(state.events).toEqual([]);
    });
  });
});
