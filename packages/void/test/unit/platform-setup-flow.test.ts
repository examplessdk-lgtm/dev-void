import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDeploymentManifest } from '@void/platform';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';
import {
  listInstallationManifests,
  readPendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';
import { isPlatformSetupDraft } from '../../src/cli/platform-setup-draft.ts';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  open: vi.fn(),
  install: vi.fn(),
  preflight: vi.fn(),
  plan: vi.fn(),
  database: vi.fn(),
}));
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  confirm: mocks.confirm,
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
vi.mock('../../src/cli/platform-auth.ts', () => ({
  resolvePlatformCloudflareCredential: async () => ({ source: 'oauth', token: 'operator-token' }),
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
  mocks.preflight.mockResolvedValue(undefined);
  mocks.plan.mockImplementation(async (_client, input, existing, options) => {
    const id = existing?.id ?? 'test-setup-123456abcdef';
    const deployment = createPlatformDeploymentManifest({
      installationSlug: input.installationSlug,
      displayName: input.displayName,
      application: {
        baseDomain: 'account.workers.dev',
        zoneName: '',
        workersDev: { subdomain: 'account', installationId: id },
      },
      resources: existing?.deployment.resources ?? {
        apiWorker: 'api-' + (options.provisioningSuffix ?? 'preview'),
      },
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
        : message.startsWith('R2 access')
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
    if (message.startsWith('R2 secret')) {
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

describe('platform credential onboarding', () => {
  it('keeps plan mode read-only, with direct links and no browser launches', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });
  it('does not save a draft or open pages when the plan is declined', async () => {
    mocks.confirm.mockResolvedValue(false);
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(listInstallationManifests()).toEqual([]);
    expect(mocks.open).not.toHaveBeenCalled();
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
    // With only one untouched draft, a bare invocation resumes its setup.
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
    ).toEqual(['https://github.com/settings/applications/new', '/account/r2/api-tokens']);
    expect(JSON.stringify(mocks.open.mock.calls)).not.toContain('secret-value');
  });
  it('skips browsers and secret prompts for values supplied through the environment', async () => {
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
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
