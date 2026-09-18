import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { log } from '@clack/prompts';
import { createPlatformDeploymentManifest, transitionInstallation } from '@void/platform';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import {
  PlatformCloudflareApiError,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';
import { PlatformAccessBlockedError } from '../../src/cli/platform-installer.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';
import {
  listInstallationManifests,
  readPendingInstallationSecrets,
  writePendingInstallationSecrets,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';
import {
  completePlatformSetupDraft,
  isPlatformSetupDraft,
  isPlatformInstallInProgress,
  savePlatformSetupDraft,
} from '../../src/cli/platform-setup-draft.ts';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  open: vi.fn(),
  install: vi.fn(),
  preflight: vi.fn(),
  plan: vi.fn(),
  database: vi.fn(),
  spinner: vi.fn(),
  progress: { start: vi.fn(), stop: vi.fn(), message: vi.fn(), error: vi.fn(), clear: vi.fn() },
}));
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  // These fixtures retain GitHub-only setup; Access choices have their own matrix.
  confirm: (input: { message: string }) =>
    input.message === 'Also protect the platform UI and APIs with Cloudflare Access?'
      ? Promise.resolve(false)
      : mocks.confirm(input),
  multiselect: mocks.multiselect,
  select: mocks.select,
  text: mocks.text,
  password: mocks.password,
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}));
vi.mock('../../src/cli/auth.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/auth.ts')>()),
  openBrowser: mocks.open,
}));
vi.mock('../../src/cli/prompt-password.ts', () => ({ passwordWithPlaceholder: mocks.password }));
vi.mock('../../src/cli/output.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/output.ts')>()),
  createSpinner: mocks.spinner,
}));
vi.mock('../../src/cli/platform-auth.ts', () => ({
  resolvePlatformCloudflareCredential: async () => ({ source: 'oauth', token: 'operator-token' }),
  resolvePlatformCloudflareCredentialWithInput: async (input: () => Promise<unknown>) => ({
    input: await input(),
    credential: { source: 'oauth', token: 'operator-token' },
  }),
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
}));
vi.mock('../../src/cli/platform-cloudflare.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-cloudflare.ts')>()),
  verifyPlatformRuntimeTokenPermissions: mocks.preflight,
}));
vi.mock('../../src/cli/platform-installer.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-installer.ts')>()),
  installPlatform: mocks.install,
  resolveBootstrapGitHubId: async () => '12345',
  readPlatformDatabaseLifecycleManifest: mocks.database,
}));
vi.mock('../../src/cli/platform-plan.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-plan.ts')>()),
  createPlatformInstallPlan: mocks.plan,
}));
let directory: string;
const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const args = [
  'install',
  '--name',
  'test-setup',
  '--account',
  'account',
  '--display-name',
  'Test',
  '--workers-dev',
];
const environment = {
  VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN: 'runtime-secret-value',
  VOID_PLATFORM_ADMIN_GITHUB_LOGIN: 'octocat',
  VOID_PLATFORM_ADMIN_GITHUB_ID: '12345',
  VOID_PLATFORM_DATABASE_URL: 'postgres://user:password@database.example.com/platform',
  VOID_PLATFORM_GITHUB_CLIENT_ID: 'github-id',
  VOID_PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret-value',
  VOID_PLATFORM_R2_ACCESS_KEY_ID: 'r2-id',
  VOID_PLATFORM_R2_SECRET_ACCESS_KEY: 'r2-secret-value',
  VOID_PLATFORM_JWT_SECRET: 'a'.repeat(32),
  VOID_PLATFORM_PROJECT_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.multiselect.mockResolvedValue(['github']);
  directory = mkdtempSync(join(tmpdir(), 'void-credential-flow-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
  vi.stubEnv('VOID_PLATFORM_RECOVERY_KEY', Buffer.alloc(32, 3).toString('base64'));
  vi.stubEnv('DATABASE_URL', '');
  for (const key of [
    ...Object.keys(environment),
    'VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON',
    'VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION',
  ]) {
    vi.stubEnv(key, '');
  }
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PlatformCloudflareClient.prototype, 'listAccounts').mockResolvedValue([
    { id: 'account', name: 'Account' },
  ]);
  mocks.confirm.mockResolvedValue(true);
  mocks.spinner.mockReturnValue(mocks.progress);
  mocks.select.mockImplementation(async ({ message, options }) =>
    message === 'Continue a previous platform install?' ? options[0].value : 'workers-dev',
  );
  mocks.preflight.mockResolvedValue(undefined);
  mocks.plan.mockImplementation(async (_client, input, existing) => {
    const id = existing?.id ?? `${input.installationSlug}-123456abcdef`;
    const deployment = createPlatformDeploymentManifest({
      installationSlug: input.installationSlug,
      displayName: input.displayName,
      application: {
        baseDomain: 'account.workers.dev',
        zoneName: '',
        workersDev: { subdomain: 'account', installationId: id },
      },
      resources: existing?.deployment.resources,
    });
    return {
      account: { id: 'account', name: 'Account' },
      installationId: id,
      actions: [],
      apiUrl: 'https://' + deployment.resources.apiWorker + '.account.workers.dev',
      proxyUrl: 'https://proxy.account.workers.dev',
      workersSubdomain: 'account',
      deployment,
      zone: null,
    };
  });
  mocks.install.mockImplementation(async (_plan, _secrets, manifest) => ({
    manifest,
    waitingForDns: false,
    waitingForSandboxDrain: false,
  }));
  mocks.text.mockImplementation(async ({ message }) =>
    message.startsWith('Initial administrator')
      ? 'octocat'
      : message.startsWith('GitHub OAuth client ID')
        ? 'github-id'
        : message === 'Access Key ID:'
          ? 'r2-id'
          : '',
  );
  mocks.password.mockImplementation(async ({ message }) => {
    if (message.startsWith('Paste runtime')) {
      return environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN;
    }
    if (message.startsWith('PostgreSQL')) {
      return environment.VOID_PLATFORM_DATABASE_URL;
    }
    if (message.startsWith('GitHub OAuth')) {
      return environment.VOID_PLATFORM_GITHUB_CLIENT_SECRET;
    }
    if (message === 'Secret Access Key:') {
      return environment.VOID_PLATFORM_R2_SECRET_ACCESS_KEY;
    }
    if (message.startsWith('JWT')) {
      return environment.VOID_PLATFORM_JWT_SECRET;
    }
    if (message.startsWith('Project encryption')) {
      return environment.VOID_PLATFORM_PROJECT_SECRET_KEY;
    }
    throw new Error('Unexpected prompt: ' + message);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (tty) {
    Object.defineProperty(process.stdin, 'isTTY', tty);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  rmSync(directory, { recursive: true, force: true });
});

async function savedSetup(name = 'test-setup') {
  const plan = await mocks.plan(
    null,
    { installationSlug: name, displayName: `${name} Void` },
    null,
  );
  const draft = savePlatformSetupDraft(plan, '1.0.0');
  writePendingInstallationSecrets(draft, { cloudflareApiToken: 'saved-runtime-token' });
  mocks.plan.mockClear();
  return draft;
}

async function interruptedInstall() {
  const draft = await savedSetup();
  const manifest = transitionInstallation(
    completePlatformSetupDraft(draft),
    'failed',
    new Date().toISOString(),
  );
  writeInstallationManifest(manifest);
  writePendingInstallationSecrets(manifest, {
    cloudflareApiToken: 'saved-runtime-token',
    databaseUrl: environment.VOID_PLATFORM_DATABASE_URL,
    databaseClaimState: 'claimed',
  });
  return manifest;
}

describe('platform credential onboarding', () => {
  it('offers an interrupted install after credential collection and reads its database state', async () => {
    const interrupted = await interruptedInstall();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: interrupted.id })]),
      }),
    );
    expect(mocks.database).toHaveBeenCalledWith(
      environment.VOID_PLATFORM_DATABASE_URL,
      interrupted.id,
      interrupted.ownershipNonce,
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      interrupted,
      expect.anything(),
    );
  });

  it('asks to resume when an existing unfinished name is entered after choosing new', async () => {
    const interrupted = await interruptedInstall();
    mocks.select.mockResolvedValue('new');
    mocks.text.mockResolvedValueOnce('test-setup');
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Resume installation for test-setup Void (test-setup)?',
      initialValue: true,
    });
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      interrupted,
      expect.anything(),
    );
    expect(listInstallationManifests()).toEqual([interrupted]);
  });

  it('lets the user choose another name when they decline resuming the typed name', async () => {
    const previous = await interruptedInstall();
    mocks.select.mockResolvedValue('new');
    mocks.text.mockResolvedValueOnce('test-setup').mockResolvedValueOnce('fresh-install');
    mocks.confirm.mockResolvedValueOnce(false);
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--workers-dev', '--display-name', 'Fresh']),
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'fresh-install' }),
      null,
      expect.anything(),
    );
    expect(listInstallationManifests()).toEqual([previous]);
  });

  it('cancels the typed-name resume confirmation without planning or changing saved state', async () => {
    const previous = await interruptedInstall();
    mocks.select.mockResolvedValue('new');
    mocks.text.mockResolvedValueOnce('test-setup');
    mocks.confirm.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([previous]);
  });

  it('recognizes unfinished phases but excludes completed platforms and maintenance failures', async () => {
    const draft = await savedSetup();
    for (const status of [
      'planned',
      'provisioning',
      'waiting-for-dns',
      'waiting-for-oauth',
      'deploying',
      'verifying',
      'failed',
    ] as const) {
      expect(isPlatformInstallInProgress({ ...draft, status })).toBe(true);
    }
    for (const status of [
      'installed',
      'disabled',
      'disabling',
      'uninstalling',
      'uninstalled',
    ] as const) {
      expect(isPlatformInstallInProgress({ ...draft, status })).toBe(false);
    }
    expect(
      isPlatformInstallInProgress({
        ...draft,
        status: 'failed',
        runtime: { source: 'package', sourceRevision: null, manifestSha256: 'a'.repeat(64) },
      }),
    ).toBe(false);
    expect(
      isPlatformInstallInProgress({ ...draft, status: 'failed', desiredState: 'disabled' }),
    ).toBe(false);
  });

  it('does not offer to reinstall an already completed platform when its name is entered', async () => {
    const draft = await savedSetup();
    writeInstallationManifest({ ...draft, status: 'installed' });
    mocks.text.mockResolvedValueOnce('test-setup');
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan'])),
    ).rejects.toThrow('void platform status');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('stops if the database says a selected installation completed elsewhere', async () => {
    const interrupted = await interruptedInstall();
    mocks.database.mockResolvedValueOnce({
      ...interrupted,
      status: 'installed',
      runtime: {
        source: 'package',
        sourceRevision: null,
        manifestSha256: 'a'.repeat(64),
      },
    });
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'no longer unfinished',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listInstallationManifests()[0]!.status).toBe('installed');
  });

  it('starts installation progress before the installer runs, updates it, and stops on success', async () => {
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    mocks.install.mockImplementation(async (_plan, _secrets, manifest, dependencies) => {
      expect(mocks.progress.start).toHaveBeenCalledWith('Installing the platform');
      dependencies.onProgress('Preparing the platform database');
      return { manifest, waitingForDns: false, waitingForSandboxDrain: false };
    });
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.progress.message).toHaveBeenCalledWith('Preparing the platform database');
    expect(mocks.progress.stop).toHaveBeenCalledWith('Platform installed.');
    expect(mocks.progress.error).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      'Test is installed at https://void-test-setup-api.account.workers.dev/admin.',
    );
    expect(info).toHaveBeenCalledWith('API URL: https://void-test-setup-api.account.workers.dev');
    // Spinner cancellation must not swallow the CLI's cancellation signal.
    const emit = vi.spyOn(process, 'emit').mockReturnValueOnce(true);
    mocks.spinner.mock.calls[0]![0].onCancel();
    expect(emit).toHaveBeenCalledWith('SIGINT');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('test exit');
    });
    emit.mockReturnValueOnce(false);
    expect(() => mocks.spinner.mock.calls[0]![0].onCancel()).toThrow('test exit');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('clears failed progress before printing recovery instructions', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    mocks.install.mockRejectedValueOnce(new Error('checkpoint failed'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'checkpoint failed',
    );
    expect(mocks.progress.error).toHaveBeenCalledWith('Platform installation failed.');
    expect(mocks.progress.stop).not.toHaveBeenCalled();
    const recoveryIndex = info.mock.calls.findIndex(([message]) =>
      message.startsWith('Continue with:'),
    );
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.progress.error.mock.invocationCallOrder[0]).toBeLessThan(
      info.mock.invocationCallOrder[recoveryIndex]!,
    );
  });

  it.each(['void', 'void-dev'])(
    'includes a %s resume command without a duplicate recovery hint',
    async (command) => {
      const originalArgv = process.argv;
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      process.argv = [process.execPath, `/usr/local/bin/${command}`, ...args];
      try {
        mocks.install.mockImplementationOnce(async (plan, _secrets, manifest, dependencies) => {
          expect(dependencies.healthCheckResumeCommand).toBe(
            `${command} platform install --resume --name ${manifest.id}`,
          );
          throw new PlatformAccessBlockedError(plan.apiUrl, {
            accountName: plan.account.name,
            workers: [
              plan.deployment.resources.apiWorker,
              plan.deployment.resources.proxyWorker,
              plan.deployment.resources.dispatchWorker,
            ],
            resumeCommand: dependencies.healthCheckResumeCommand,
          });
        });
        await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
          `${command} platform install --resume --name test-setup-123456abcdef`,
        );
        expect(mocks.progress.error).toHaveBeenCalledWith('Platform installation failed.');
        expect(info.mock.calls.some(([message]) => message.startsWith('Continue with:'))).toBe(
          false,
        );
      } finally {
        process.argv = originalArgv;
      }
    },
  );

  it.each(['waitingForDns', 'waitingForSandboxDrain'] as const)(
    'stops progress when installation pauses for %s',
    async (reason) => {
      mocks.install.mockImplementation(async (_plan, _secrets, manifest) => ({
        manifest,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
        [reason]: true,
      }));
      await runPlatformLifecycleCommand(parsePlatformArgs(args));
      expect(mocks.progress.stop).toHaveBeenCalledWith('Installation paused; progress is saved.');
      expect(mocks.progress.error).not.toHaveBeenCalled();
    },
  );

  it('explains database and key inputs without displaying their values', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'PostgreSQL DATABASE_URL:',
        placeholder: 'postgresql://user:pw@…/database',
      }),
    );
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'JWT signing key:' }),
    );
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Project encryption key:' }),
    );
    expect(mocks.text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Access Key ID:' }));
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Secret Access Key:' }),
    );
    const descriptions = info.mock.calls.map(([message]) => message).join('\n');
    expect(descriptions).toContain(
      'https://void.cloud/guide/self-hosted-platform#platform-database',
    );
    expect(descriptions).toContain('Signs platform login tokens. Run openssl rand -base64 32');
    expect(descriptions).toContain('Encrypts app secrets. Run openssl rand -base64 32 separately');
    expect(descriptions).not.toContain(environment.VOID_PLATFORM_DATABASE_URL);
    expect(descriptions).not.toContain(environment.VOID_PLATFORM_JWT_SECRET);
    expect(descriptions).not.toContain(environment.VOID_PLATFORM_PROJECT_SECRET_KEY);
  });
  it('replaces a revoked saved token during the same continued setup', async () => {
    const draft = await savedSetup();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    mocks.preflight.mockRejectedValueOnce(
      new Error('Preflight failed', {
        cause: new PlatformCloudflareApiError('Authentication error', 403),
      }),
    );
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Cloudflare rejected the saved runtime token. Create a replacement to continue setup.',
    );
    expect(
      mocks.password.mock.calls.filter(([input]) => input.message === 'Paste runtime API token:'),
    ).toHaveLength(1);
    expect(new URL(mocks.open.mock.calls[0]![0]).searchParams.get('to')).toBe(
      '/account/api-tokens',
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudflareApiToken: environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN,
      }),
      expect.objectContaining({ id: draft.id }),
      expect.anything(),
    );
  });

  it('does not retain a rejected cached token if replacement input is cancelled', async () => {
    const draft = await savedSetup();
    mocks.preflight.mockRejectedValueOnce(
      new PlatformCloudflareApiError('Authentication error', 401),
    );
    mocks.password.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBeUndefined();
    expect(mocks.preflight).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('preserves saved credentials and stops on service failures instead of opening replacement pages', async () => {
    const draft = await savedSetup();
    mocks.preflight.mockRejectedValueOnce(
      new PlatformCloudflareApiError('service unavailable', 503),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'service unavailable',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not blame the runtime token when operator authentication fails during AI Gateway replanning', async () => {
    const draft = await savedSetup();
    const original = mocks.plan.getMockImplementation()!;
    mocks.plan
      .mockImplementationOnce(async (...args) => ({
        ...(await original(...args)),
        actions: [
          {
            action: 'inspect',
            id: null,
            key: 'ai-gateway',
            kind: 'ai-gateway',
            name: 'gateway',
            reason: 'Needs runtime-token check.',
          },
        ],
      }))
      .mockRejectedValueOnce(
        new PlatformCloudflareApiError('Operator session expired', 403, '/accounts'),
      );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Operator session expired',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not replace an explicit environment token or clear a different saved token', async () => {
    const draft = await savedSetup();
    vi.stubEnv('VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN', 'environment-token');
    mocks.preflight.mockRejectedValueOnce(
      new PlatformCloudflareApiError('Authentication error', 403),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Authentication error',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('offers a named saved setup and a fresh installation instead of automatically continuing', async () => {
    const draft = await savedSetup();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Continue a previous platform install?',
      options: [
        {
          value: draft.id,
          label: 'Continue setup for test-setup Void (test-setup)',
          hint: 'Account',
        },
        { value: 'new', label: 'Start a new platform install' },
      ],
    });
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'test-setup' }),
      draft,
      expect.anything(),
    );
  });

  it.each([false, true])(
    'starts fresh without reusing saved credentials, including with --name: %s',
    async (named) => {
      const previous = await savedSetup();
      mocks.select.mockResolvedValue('new');
      mocks.text.mockResolvedValue('fresh-install');
      mocks.password.mockResolvedValueOnce(Symbol('cancel'));
      await expect(
        runPlatformLifecycleCommand(
          parsePlatformArgs([
            'install',
            '--workers-dev',
            '--account',
            'account',
            '--display-name',
            'Fresh',
            ...(named ? ['--name', 'test-setup'] : []),
          ]),
        ),
      ).rejects.toThrow('Cancelled');
      const manifests = listInstallationManifests();
      expect(manifests).toHaveLength(2);
      expect(readPendingInstallationSecrets(previous)).toEqual({
        cloudflareApiToken: 'saved-runtime-token',
      });
      const fresh = manifests.find(
        (manifest) => manifest.deployment.installationSlug === 'fresh-install',
      )!;
      expect(readPendingInstallationSecrets(fresh)).toEqual({});
      expect(mocks.password).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Paste runtime API token:' }),
      );
      expect(mocks.preflight).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      const namePrompt = mocks.text.mock.calls.find(
        ([prompt]) => prompt.message === 'Installation name:',
      )![0];
      expect(namePrompt.validate('test-setup')).toBeUndefined();
    },
  );

  it('lets the user select among multiple saved setups', async () => {
    const first = await savedSetup('first');
    const second = await savedSetup('second');
    mocks.select.mockResolvedValue(second.id);
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    const choices = mocks.select.mock.calls[0]![0].options;
    expect(choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: first.id,
          label: 'Continue setup for first Void (first)',
        }),
        expect.objectContaining({
          value: second.id,
          label: 'Continue setup for second Void (second)',
        }),
        { value: 'new', label: 'Start a new platform install' },
      ]),
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'second' }),
      second,
      expect.anything(),
    );
  });

  it('cancels before planning or collecting credentials when the chooser is cancelled', async () => {
    const draft = await savedSetup();
    mocks.select.mockResolvedValue(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(readPendingInstallationSecrets(draft)).toEqual({
      cloudflareApiToken: 'saved-runtime-token',
    });
  });

  it('honors explicit --resume without asking and never auto-resumes in CI', async () => {
    const draft = await savedSetup();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--yes'])),
    ).rejects.toThrow('--resume');
    expect(mocks.plan).not.toHaveBeenCalled();
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', draft.id, '--plan']),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'test-setup' }),
      draft,
      expect.anything(),
    );
  });

  it('does not silently adopt a selected draft that advanced while the chooser was open', async () => {
    const draft = await savedSetup();
    mocks.select.mockImplementation(async () => {
      completePlatformSetupDraft(draft);
      return draft.id;
    });
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Setup advanced in another process',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps real resource names and the callback stable from preview through install and resume', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const actual = await vi.importActual<typeof import('../../src/cli/platform-plan.ts')>(
      '../../src/cli/platform-plan.ts',
    );
    mocks.plan.mockImplementation(actual.createPlatformInstallPlan);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkersSubdomain').mockResolvedValue(
      'void-platform-e2e-test',
    );
    for (const method of [
      'listAiGateways',
      'listKvNamespaces',
      'listR2Buckets',
      'listQueues',
      'listDispatchNamespaces',
      'listHyperdriveConfigs',
      'listWorkerNames',
    ] as const) {
      vi.spyOn(PlatformCloudflareClient.prototype, method).mockResolvedValue([]);
    }
    const normalText = mocks.text.getMockImplementation()!;
    mocks.text.mockImplementation(async (input) =>
      input.message === 'Installation name:'
        ? 'void-e2e'
        : input.message === 'Platform display name:'
          ? 'void-e2e Void'
          : normalText(input),
    );
    const normalPassword = mocks.password.getMockImplementation()!;
    mocks.password.mockImplementation(async (input) =>
      input.message.startsWith('GitHub OAuth') ? Symbol('cancel') : normalPassword(input),
    );
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    const preview = await mocks.plan.mock.results[0]!.value;
    expect(mocks.open).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Optional custom API hostname (leave empty for workers.dev):',
      }),
    );
    const draft = listInstallationManifests()[0]!;
    expect(draft.deployment.installationSlug).toBe('void-e2e');
    expect(draft.deployment.resources.apiWorker).toBe('void-void-e2e-api');
    expect(draft.deployment.resources).toEqual(preview.deployment.resources);
    expect(isPlatformSetupDraft(draft)).toBe(true);
    const callback = `https://${draft.deployment.resources.apiWorker}.void-platform-e2e-test.workers.dev/auth/callback`;
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Redirect URI: ' + callback));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Redirect URI: ' + callback));
    mocks.password.mockImplementation(normalPassword);
    mocks.open.mockClear();
    info.mockClear();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Redirect URI: ' + callback));
    const final = listInstallationManifests()[0]!;
    expect(final.id).toBe(draft.id);
    expect(final.deployment.resources).toEqual(draft.deployment.resources);
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(isPlatformSetupDraft(final)).toBe(false);
  });

  it('stops an interactive install at an existing resource without retrying or opening setup', async () => {
    const actual = await vi.importActual<typeof import('../../src/cli/platform-plan.ts')>(
      '../../src/cli/platform-plan.ts',
    );
    mocks.plan.mockImplementation(actual.createPlatformInstallPlan);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkersSubdomain').mockResolvedValue(
      'account',
    );
    for (const method of [
      'listAiGateways',
      'listKvNamespaces',
      'listR2Buckets',
      'listQueues',
      'listDispatchNamespaces',
      'listHyperdriveConfigs',
    ] as const) {
      vi.spyOn(PlatformCloudflareClient.prototype, method).mockResolvedValue([]);
    }
    vi.spyOn(PlatformCloudflareClient.prototype, 'listWorkerNames').mockResolvedValue([
      'void-test-setup-api',
    ]);
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'Resume the owning installation, or choose another installation name.',
    );
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });

  it('keeps plan mode read-only, with direct links and no browser launches', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
    expect(mocks.spinner).not.toHaveBeenCalled();
  });
  it('does not save a draft or open pages when the plan is declined', async () => {
    mocks.confirm.mockResolvedValue(false);
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(listInstallationManifests()).toEqual([]);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.spinner).not.toHaveBeenCalled();
  });
  it('opens each missing credential page and preserves encrypted progress and callback identity across cancellation', async () => {
    const normalPassword = mocks.password.getMockImplementation()!;
    mocks.password.mockImplementation(async (input) =>
      input.message.startsWith('GitHub OAuth') ? Symbol('cancel') : normalPassword(input),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow('Cancelled');
    const first = listInstallationManifests()[0]!;
    expect(isPlatformSetupDraft(first)).toBe(true);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    const saved = readPendingInstallationSecrets(first)!;
    expect(saved.cloudflareApiToken).toBe(environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN);
    expect(saved.githubClientId).toBeUndefined();
    const serialized = readdirSync(directory, { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.enc'))
      .map((entry) => readFileSync(join(directory, entry), 'utf8'))
      .join('');
    expect(serialized).not.toContain(environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN);
    const initialApi = mocks.plan.mock.results[0]!.value;
    mocks.password.mockImplementation(normalPassword);
    mocks.open.mockClear();
    // A bare invocation resumes only after selecting the named saved setup.
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    const final = listInstallationManifests()[0]!;
    expect(final.deployment.resources).toEqual(first.deployment.resources);
    expect(final.id).toBe(first.id);
    expect(isPlatformSetupDraft(final)).toBe(false);
    expect((await initialApi).apiUrl).toBe((await mocks.plan.mock.results.at(-1)!.value).apiUrl);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(
      mocks.open.mock.calls.map((call) => {
        const url = new URL(String(call[0]));
        return url.searchParams.get('to') ?? url.href;
      }),
    ).toEqual(['https://github.com/settings/applications/new', '/account/r2/api-tokens/create']);
    expect(JSON.stringify(mocks.open.mock.calls)).not.toContain('secret-value');
  });
  it('skips browsers and secret prompts for values supplied through the environment', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(info.mock.calls.map(([message]) => message).join('\n')).not.toContain('openssl rand');
  });
  it('does not persist an invalid signing key or begin provisioning', async () => {
    const normal = mocks.password.getMockImplementation()!;
    mocks.password.mockImplementation(async (input) =>
      input.message.startsWith('JWT') ? 'short' : normal(input),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      '32 random bytes',
    );
    const draft = listInstallationManifests()[0]!;
    expect(isPlatformSetupDraft(draft)).toBe(true);
    expect(readPendingInstallationSecrets(draft)?.jwtSecret).toBeUndefined();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
