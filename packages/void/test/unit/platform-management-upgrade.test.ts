import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  createPlatformDeploymentManifest,
  parsePlatformAuthenticationSetup,
  createPlatformInstallationManifest,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
  type PlatformInstallationManifest,
} from '@void/platform';
import { getPlatformRuntimeDirectory, resolvePlatformRuntime } from '@void/platform/installer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { printSuccess } from '../../src/cli/output.ts';

const state = vi.hoisted(() => ({
  createSecrets: vi.fn(),
  clientTokens: [] as Array<string>,
  listAccounts: vi.fn(),
  listWorkerNames: vi.fn(),
  request: vi.fn(),
  requiredGatewayToken: '',
  events: [] as Array<string>,
  manifest: undefined as PlatformInstallationManifest | undefined,
  prepareDatabase: vi.fn(),
  readAdministratorSetup: vi.fn(),
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
  printSuccess: vi.fn(),
}));

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), success: vi.fn() },
  note: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
}));

vi.mock('../../src/cli/platform-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-auth.ts')>()),
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
}));

vi.mock('../../src/cli/platform-cloudflare.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-cloudflare.ts')>();
  return {
    ...actual,
    PlatformCloudflareClient: class {
      constructor(private readonly token: string) {
        state.clientTokens.push(token);
      }
      listAccounts = state.listAccounts;
      listWorkerNames = state.listWorkerNames;
      request = state.request;
      async getKvValue() {
        return JSON.stringify(state.manifest);
      }

      async listAiGateways() {
        if (state.requiredGatewayToken && this.token !== state.requiredGatewayToken) {
          throw new actual.PlatformCloudflareApiError(
            'Authentication error',
            403,
            '/accounts/account/ai-gateway/gateways',
          );
        }
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
          readAdministratorSetup: state.readAdministratorSetup,
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
    readPendingInstallationSecrets: vi.fn(),
    resolveInstallationManifest: vi.fn(() => state.manifest),
    writeInstallationManifest: vi.fn(),
    writePendingInstallationSecrets: vi.fn(),
  };
});

import { confirm, log, note } from '@voidzero-dev/vite-plus-prompts';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import { authenticationSetupRequestHash } from '../../src/cli/platform-install-auth.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  installPlatform,
} from '../../src/cli/platform-installer.ts';
import {
  platformLifecycleResumeCommand,
  runInstalledPlatformCommand,
} from '../../src/cli/platform-management.ts';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  readInstallationRecoverySecrets,
  readPendingInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';

const upgrade = (overrides: { plan?: boolean; yes?: boolean } = {}) =>
  runInstalledPlatformCommand({
    subcommand: 'upgrade',
    selector: state.manifest!.id,
    plan: false,
    runtime: '',
    yes: true,
    ...overrides,
  });

describe('installed platform upgrade', () => {
  it('prints an exact rollback resume command with quoted custom runtime paths', () => {
    expect(
      platformLifecycleResumeCommand(
        {
          subcommand: 'rollback',
          selector: '',
          plan: false,
          yes: true,
          runtime: '/tmp/earlier runtime',
          fromRuntime: "/tmp/current's runtime",
        },
        'installation',
      ),
    ).toBe(
      "void platform rollback installation --runtime '/tmp/earlier runtime' --from-runtime '/tmp/current'\\''s runtime' --yes",
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
    vi.stubEnv('CF_API_TOKEN', '');
    state.clientTokens.length = 0;
    state.requiredGatewayToken = '';
    state.listAccounts.mockReset().mockResolvedValue([{ id: 'account', name: 'Account' }]);
    state.listWorkerNames.mockReset().mockResolvedValue([]);
    state.request.mockReset().mockResolvedValue({ name: 'assets' });
    vi.mocked(readInstallationRecoverySecrets).mockReturnValue({
      databaseUrl: 'postgres://database',
    });
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

  it.each([false, true])(
    'plans an upgrade with management authority instead of its runtime token (environment override: %s)',
    async (override) => {
      vi.stubEnv('CLOUDFLARE_API_TOKEN', override ? 'explicit-manager' : '');
      state.requiredGatewayToken = override ? 'explicit-manager' : 'saved-manager';
      vi.mocked(readInstallationRecoverySecrets).mockReturnValue({
        databaseUrl: 'postgres://database',
        managementApiToken: 'saved-manager',
        cloudflareApiToken: 'runtime-without-ai-gateway',
      });
      const original = vi.mocked(createPlatformInstallPlan).getMockImplementation()!;
      vi.mocked(createPlatformInstallPlan).mockImplementationOnce(async (...args) => {
        await args[0].listAiGateways(args[1].accountId);
        return original(...args);
      });
      await upgrade();
      expect(state.clientTokens).toEqual([state.requiredGatewayToken]);
      expect(installPlatform).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ operatorApiToken: state.requiredGatewayToken }),
      );
      expect(state.events).toContain('installer-finish');
      expect(state.createSecrets).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpoint: expect.objectContaining({ managementApiToken: 'saved-manager' }),
        }),
      );
    },
  );

  it.each(['account', 'workers', 'r2'] as const)(
    'rejects denied %s access before taking locks or changing installation state',
    async (resource) => {
      state.manifest = recordInstallationResource(
        state.manifest!,
        {
          configHash: 'hash',
          id: 'assets',
          key: 'assets-r2',
          kind: 'r2-bucket',
          name: 'assets',
          ownership: 'created',
          state: 'ready',
        },
        '2026-09-14T00:00:03.000Z',
      );
      const check =
        resource === 'account'
          ? state.listAccounts
          : resource === 'workers'
            ? state.listWorkerNames
            : state.request;
      check.mockRejectedValueOnce(new PlatformCloudflareApiError('Authentication error', 403));
      await expect(upgrade()).rejects.toThrow('HTTP 403');
      expect(acquirePlatformLifecycleLock).not.toHaveBeenCalled();
      expect(acquirePlatformDatabaseLifecycleLock).not.toHaveBeenCalled();
      expect(writeInstallationManifest).not.toHaveBeenCalled();
      expect(createPlatformInstallPlan).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
      expect(state.progress.start).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalled();
    },
  );

  it('includes shared email configuration when planning an upgrade', async () => {
    vi.stubEnv('VOID_EMAIL_SHARED_ZONE_ID', 'mail-zone');
    vi.stubEnv('VOID_EMAIL_SENDER_DOMAIN', 'mail.example.com');
    await upgrade({ plan: true });
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
    await upgrade();

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
      vi.mocked(printSuccess).mock.invocationCallOrder[0]!,
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

    await expect(upgrade()).rejects.toThrow('migration failed');

    expect(state.events).toEqual([
      'installer-start',
      'prepare:failed',
      'outer-release',
      'local-release',
    ]);
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`void platform upgrade ${state.manifest!.id} --yes`),
      'Recovery',
    );
    expect(state.progress.stop).not.toHaveBeenCalled();
  });

  it('does not start deployment progress for a plan-only run', async () => {
    await upgrade({ plan: true, yes: false });
    expect(state.spinner).not.toHaveBeenCalled();
    expect(installPlatform).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it('does not claim deployment started when credential preparation fails', async () => {
    state.createSecrets.mockImplementationOnce(() => {
      throw new Error('invalid credentials');
    });
    await expect(upgrade()).rejects.toThrow('invalid credentials');
    expect(installPlatform).not.toHaveBeenCalled();
    expect(state.progress.start).not.toHaveBeenCalled();
    expect(state.progress.error).not.toHaveBeenCalled();
    expect(vi.mocked(note).mock.calls).not.toContainEqual([expect.anything(), 'Recovery']);
    expect(state.events).toEqual(['outer-release', 'local-release']);
  });

  it('keeps progress active through final database lock release', async () => {
    state.releaseDatabase.mockImplementationOnce(async () => {
      expect(state.progress.message).toHaveBeenLastCalledWith('Finalizing platform changes');
      expect(state.progress.stop).not.toHaveBeenCalled();
      expect(printSuccess).not.toHaveBeenCalled();
    });
    await upgrade();
    expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith('Platform upgrade complete.');
  });

  it('reports a finalization failure without claiming success and still releases the local lock', async () => {
    state.releaseDatabase.mockRejectedValueOnce(new Error('database release failed'));
    await expect(upgrade()).rejects.toThrow('database release failed');
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(state.progress.stop).not.toHaveBeenCalled();
    expect(printSuccess).not.toHaveBeenCalled();
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
      await upgrade();
      expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith(
        'Platform operation paused; progress is saved.',
      );
      expect(state.progress.error).not.toHaveBeenCalled();
      expect(printSuccess).not.toHaveBeenCalled();
      expect(state.progress.stop.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(note).mock.invocationCallOrder.at(-1)!,
      );
      expect(state.events).toEqual(['outer-release', 'local-release']);
    },
  );

  it('forwards spinner cancellation to coordinated CLI shutdown', async () => {
    await upgrade();
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

  it('reports a completed operation on a disabled installation without claiming enabled traffic', async () => {
    vi.mocked(installPlatform).mockResolvedValueOnce({
      manifest: { ...state.manifest!, desiredState: 'disabled', status: 'disabled' },
      waitingForDns: false,
      waitingForSandboxDrain: false,
      zoneNameServers: [],
    });
    await upgrade();
    expect(log.info).toHaveBeenCalledWith(
      'Application traffic remains paused. Enable the installation when you are ready.',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Traffic is enabled'));
    expect(printSuccess).not.toHaveBeenCalledWith(expect.stringContaining('healthy'));
  });

  it('previews enabling a disabled installation without promising it will stay paused', async () => {
    state.manifest = { ...state.manifest!, desiredState: 'disabled', status: 'disabled' };
    await runInstalledPlatformCommand({
      subcommand: 'enable',
      selector: state.manifest.id,
      plan: true,
      runtime: '',
      yes: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      'Application traffic may pause briefly during a safe cutover.',
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Application traffic will stay paused'),
    );
  });

  describe('repair while first administrator setup is pending', () => {
    const previousCode = 'a'.repeat(64);
    const previousSetup = JSON.stringify(
      parsePlatformAuthenticationSetup({
        connections: [
          {
            configuration: {
              id: 'company',
              kind: 'oidc',
              label: 'Company SSO',
              issuer: 'https://sso.example.com',
              clientId: 'old-client',
            },
            clientSecret: 'old-secret',
          },
        ],
        administratorConnectionId: 'company',
        admission: { mode: 'restricted' },
        protection: null,
        bootstrapCredentialHash: createHash('sha256').update(previousCode).digest('hex'),
      }),
    );
    const recovery = {
      databaseUrl: 'postgres://database',
      authenticationSetupJson: previousSetup,
      authSetupToken: 'b'.repeat(64),
      authBootstrapCode: previousCode,
    };
    let directory: string;
    let authFile: string;
    const repair = (overrides: { authConfig?: string; plan?: boolean; yes?: boolean } = {}) =>
      runInstalledPlatformCommand({
        subcommand: 'repair',
        selector: state.manifest!.id,
        plan: false,
        runtime: '',
        yes: true,
        ...overrides,
      });
    const replacement = () => state.createSecrets.mock.calls.at(-1)![0];

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'void-repair-login-'));
      authFile = join(directory, 'auth.json');
      await writeFile(
        authFile,
        JSON.stringify({
          connections: [
            {
              configuration: {
                id: 'company',
                kind: 'oidc',
                label: 'Company SSO',
                issuer: 'https://sso.example.com',
                clientId: 'new-client',
              },
              clientSecretEnv: 'TEST_REPAIR_LOGIN_SECRET',
            },
          ],
        }),
      );
      vi.stubEnv('TEST_REPAIR_LOGIN_SECRET', 'new-secret');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(readInstallationRecoverySecrets).mockReturnValue(recovery);
      state.readAdministratorSetup.mockReset().mockResolvedValue({
        pending: true,
        usersExist: false,
        requestHash: authenticationSetupRequestHash(previousSetup),
      });
      state.manifest = {
        ...state.manifest!,
        deployment: createPlatformDeploymentManifest({
          ...state.manifest!.deployment,
          authentication: { providers: ['oidc'], configurable: true },
          capabilities: { ...state.manifest!.deployment.capabilities, githubOAuth: false },
        }),
      };
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('sends new login settings with a new setup code and keeps the setup authority', async () => {
      vi.mocked(installPlatform).mockResolvedValueOnce({
        manifest: state.manifest!,
        setupPending: true,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
      });
      await repair({ authConfig: authFile });
      const input = replacement();
      const setup = parsePlatformAuthenticationSetup(JSON.parse(input.authenticationSetupJson));
      expect(setup.resetPending).toBe(true);
      expect(setup.connections[0]).toMatchObject({
        configuration: { clientId: 'new-client' },
        clientSecret: 'new-secret',
      });
      expect(input.authBootstrapCode).toMatch(/^[a-f0-9]{64}$/);
      expect(input.authBootstrapCode).not.toBe(previousCode);
      expect(setup.bootstrapCredentialHash).toBe(
        createHash('sha256').update(input.authBootstrapCode).digest('hex'),
      );
      expect(input).not.toHaveProperty('authSetupToken');
      expect(input.checkpoint).toBe(recovery);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('/auth/callback'));
      expect(log.info).toHaveBeenCalledWith(
        `If sign-in fails, run \`void platform repair ${state.manifest!.id}\` to change the login settings.`,
      );
    });

    it.each([
      [
        'once the first administrator signed in',
        { pending: false, usersExist: true, requestHash: 'accepted' },
        'The first administrator has already signed in. Change login methods with `void platform config auth`.',
      ],
      [
        'when setup was never started',
        { pending: false, usersExist: false, requestHash: null },
        'Administrator setup was never started. Resume the install with `void platform install --resume --name',
      ],
    ])('refuses before any change %s', async (_label, setup, message) => {
      state.readAdministratorSetup.mockResolvedValueOnce(setup);
      await expect(repair({ authConfig: authFile })).rejects.toThrow(message);
      expect(state.createSecrets).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a GitHub-only installation',
        () => {
          state.manifest = {
            ...state.manifest!,
            deployment: createPlatformDeploymentManifest({
              ...state.manifest!.deployment,
              authentication: { providers: ['github'] },
              capabilities: { ...state.manifest!.deployment.capabilities, githubOAuth: true },
            }),
          };
        },
        'Set VOID_PLATFORM_GITHUB_CLIENT_ID and VOID_PLATFORM_GITHUB_CLIENT_SECRET',
      ],
      [
        'a computer without the saved setup authority',
        () => {
          vi.mocked(readInstallationRecoverySecrets).mockReturnValue({
            databaseUrl: 'postgres://database',
          });
        },
        'needs the setup authority saved on the computer that installed the platform',
      ],
    ])('refuses %s before planning', async (_label, arrange, message) => {
      arrange();
      await expect(repair({ authConfig: authFile })).rejects.toThrow(message);
      expect(createPlatformInstallPlan).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
    });

    it('refuses on a disabled platform before planning', async () => {
      state.manifest = { ...state.manifest!, desiredState: 'disabled', status: 'disabled' };
      await expect(repair({ authConfig: authFile })).rejects.toThrow(
        `Run \`void platform enable ${state.manifest.id}\` first`,
      );
      expect(createPlatformInstallPlan).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
    });

    it('checks the file in a plan without reading the database', async () => {
      await repair({ authConfig: authFile, plan: true, yes: false });
      expect(log.info).toHaveBeenCalledWith(
        `Login settings will be replaced from ${authFile}; a new setup code is printed at the end.`,
      );
      expect(acquirePlatformDatabaseLifecycleLock).not.toHaveBeenCalled();
      expect(state.readAdministratorSetup).not.toHaveBeenCalled();
      await writeFile(
        authFile,
        JSON.stringify({ connections: [{ configuration: { kind: 'github', clientId: 'id' } }] }),
      );
      await expect(repair({ authConfig: authFile, plan: true, yes: false })).rejects.toThrow(
        'not which login methods',
      );
    });

    it('asks in a terminal only while setup is pending, and No keeps the saved settings', async () => {
      const tty = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        vi.mocked(confirm).mockResolvedValueOnce(false);
        await repair({ yes: false });
        expect(confirm).toHaveBeenCalledExactlyOnceWith({
          message:
            'First administrator setup is not finished. Change the login settings before continuing?',
          initialValue: false,
        });
        expect(replacement()).not.toHaveProperty('authenticationSetupJson');

        vi.mocked(confirm).mockClear();
        state.progress.stop.mockClear();
        state.readAdministratorSetup.mockResolvedValueOnce({
          pending: false,
          usersExist: true,
          requestHash: 'accepted',
        });
        await repair({ yes: false });
        expect(confirm).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
      }
    });

    it('keeps the saved login settings when the first administrator signs in during repair', async () => {
      const pending = { ...recovery, authenticationSetupJson: 'new', authBootstrapCode: 'new' };
      vi.mocked(readPendingInstallationSecrets).mockReturnValueOnce(pending);
      state.readAdministratorSetup
        .mockResolvedValueOnce({
          pending: true,
          usersExist: false,
          requestHash: authenticationSetupRequestHash(previousSetup),
        })
        .mockResolvedValueOnce({
          pending: false,
          usersExist: true,
          requestHash: authenticationSetupRequestHash(previousSetup),
        });
      vi.mocked(installPlatform).mockRejectedValueOnce(
        new Error('platform: Authentication setup failed (HTTP 409).'),
      );
      await expect(repair({ authConfig: authFile })).rejects.toThrow(
        'The first administrator signed in before the new login settings were applied. Nothing changed.',
      );
      expect(writePendingInstallationSecrets).toHaveBeenCalledExactlyOnceWith(state.manifest, {
        ...pending,
        authenticationSetupJson: previousSetup,
        authBootstrapCode: previousCode,
      });
    });

    it('keeps the new login settings for a retry when the platform has not refused them', async () => {
      vi.mocked(installPlatform).mockRejectedValueOnce(new Error('Worker upload failed'));
      await expect(repair({ authConfig: authFile })).rejects.toThrow('Worker upload failed');
      expect(writePendingInstallationSecrets).not.toHaveBeenCalled();
    });
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
        purgeResources: false,
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
      expect(
        vi
          .mocked(note)
          .mock.calls.map(([message, title]) => [message, stripVTControlCharacters(title ?? '')]),
      ).toContainEqual([expect.any(String), 'Uninstall plan']);
      expect(state.events).toEqual([]);
    });
  });
});
