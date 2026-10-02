import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseConnectArgs } from '../../src/cli/connect-args.ts';
import { runConnectCommand } from '../../src/cli/connect.ts';
import { getActivePlatformConnection } from '../../src/cli/platform-registry.ts';

const mocks = vi.hoisted(() => ({
  cloudflare: vi.fn(),
  discover: vi.fn(),
  login: vi.fn(),
  token: vi.fn(),
  client: vi.fn(),
  whoami: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../src/cli/cloudflare-connect.ts', () => ({ connectCloudflare: mocks.cloudflare }));
vi.mock('../../src/cli/auth.ts', () => ({ readPlatformToken: mocks.token }));
vi.mock('../../src/cli/login.ts', () => ({ promptForLoginToken: mocks.login }));
vi.mock('../../src/cli/platform-cmd.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-cmd.ts')>()),
  discoverPlatform: mocks.discover,
}));
vi.mock('../../src/cli/client.ts', () => ({
  isExpiredTokenError: (error: unknown) => error instanceof Error && error.message === 'expired',
  PlatformClient: class {
    constructor(...args: Array<unknown>) {
      mocks.client(...args);
    }
    whoami = mocks.whoami;
  },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  log: { success: vi.fn(), info: vi.fn() },
  select: mocks.select,
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
}));

const discovery = {
  apiUrl: 'https://platform.example.com',
  applicationDomain: 'apps.example.com',
  proxyUrl: 'https://proxy.example.com',
  displayName: 'Company Void',
  installationId: null,
  authenticationProviders: ['github'],
};
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'void-connect-test-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
  vi.stubEnv('VOID_TOKEN', '');
  vi.stubEnv('VOID_API_URL', '');
  mocks.discover.mockResolvedValue(discovery);
  mocks.cloudflare.mockResolvedValue({ id: 'account', name: 'Example' });
  mocks.token.mockReturnValue(null);
  mocks.login.mockResolvedValue('browser-token');
  mocks.whoami.mockResolvedValue({ login: 'developer' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { force: true, recursive: true });
});
function projectFile(): string {
  return join(root, '.void', 'project.json');
}
function seedProject(value: unknown): string {
  mkdirSync(join(root, '.void'), { recursive: true });
  const raw = JSON.stringify(value);
  writeFileSync(projectFile(), raw);
  return raw;
}

describe('connect arguments', () => {
  it.each([
    [[], { url: '', platform: null, noLogin: false }],
    [['https://platform.example.com'], { url: discovery.apiUrl, platform: null, noLogin: false }],
    [['--platform', 'cloudflare'], { url: '', platform: 'cloudflare', noLogin: false }],
    [
      ['--platform', 'void', '--no-login', discovery.apiUrl],
      { url: discovery.apiUrl, platform: 'void', noLogin: true },
    ],
  ])('parses %j', (args, expected) => {
    expect(parseConnectArgs(args as Array<string>)).toEqual(expected);
  });
  it.each([
    ['--platform', 'invalid'],
    ['--platform'],
    ['--unknown'],
    [discovery.apiUrl, 'another'],
    ['--platform', 'cloudflare', discovery.apiUrl],
    ['--platform', 'cloudflare', '--no-login'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parseConnectArgs(args)).toThrow();
  });
});

describe('connect workflow', () => {
  it('authenticates to the discovered origin and saves the project destination', async () => {
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true);
    expect(mocks.login).toHaveBeenCalledWith(root, discovery);
    expect(getActivePlatformConnection()?.apiUrl).toBe(discovery.apiUrl);
    expect(JSON.parse(readFileSync(projectFile(), 'utf8'))).toEqual({
      platform: 'void',
      platformUrl: discovery.apiUrl,
      applicationDomain: discovery.applicationDomain,
      proxyUrl: discovery.proxyUrl,
    });
    expect(mocks.cloudflare).not.toHaveBeenCalled();
  });
  it('preserves a project linked to another platform while logging in to the new one', async () => {
    const original = seedProject({
      platform: 'void',
      projectId: 'old-project',
      slug: 'old',
      platformUrl: 'https://old.example.com',
    });
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true);
    expect(readFileSync(projectFile(), 'utf8')).toBe(original);
    expect(mocks.login).toHaveBeenCalledWith(root, discovery);
    expect(getActivePlatformConnection()?.apiUrl).toBe(discovery.apiUrl);
  });
  it('requires relinking an unscoped legacy project after connecting', async () => {
    seedProject({ projectId: 'old-project', slug: 'old' });
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true);
    const saved = JSON.parse(readFileSync(projectFile(), 'utf8'));
    expect(saved.platformUrl).toBe(discovery.apiUrl);
    expect(saved.projectId).toBeUndefined();
    expect(saved.slug).toBeUndefined();
  });
  it('preserves a project id on the same platform', async () => {
    seedProject({ projectId: 'project', slug: 'app', platformUrl: discovery.apiUrl });
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true);
    expect(JSON.parse(readFileSync(projectFile(), 'utf8'))).toMatchObject({
      projectId: 'project',
      slug: 'app',
      platformUrl: discovery.apiUrl,
    });
  });
  it('verifies an existing origin-scoped session without opening a browser', async () => {
    mocks.token.mockReturnValue('saved-token');
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true);
    expect(mocks.client).toHaveBeenCalledWith('saved-token', {
      apiUrl: discovery.apiUrl,
      checkPlatformVersion: false,
    });
    expect(mocks.whoami).toHaveBeenCalledOnce();
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it('reauthenticates an expired saved session', async () => {
    mocks.token.mockReturnValue('expired-token');
    mocks.whoami.mockRejectedValueOnce(new Error('expired'));
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true);
    expect(mocks.login).toHaveBeenCalledWith(root, discovery);
  });
  it('does not turn a server failure into a login or saved connection', async () => {
    mocks.token.mockReturnValue('saved-token');
    mocks.whoami.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true),
    ).rejects.toThrow('unavailable');
    expect(mocks.login).not.toHaveBeenCalled();
    expect(getActivePlatformConnection()).toBeNull();
    expect(existsSync(projectFile())).toBe(false);
  });
  it('authenticates headless runs using an explicitly scoped environment token', async () => {
    vi.stubEnv('VOID_TOKEN', 'ci-token');
    vi.stubEnv('VOID_API_URL', discovery.apiUrl);
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), false);
    expect(mocks.client).toHaveBeenCalledWith('ci-token', {
      apiUrl: discovery.apiUrl,
      checkPlatformVersion: false,
    });
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it.each(['', 'https://different.example.com'])(
    'never forwards an environment token scoped to %j',
    async (origin) => {
      vi.stubEnv('VOID_TOKEN', 'unrelated-secret');
      vi.stubEnv('VOID_API_URL', origin);
      await expect(
        runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), false),
      ).rejects.toThrow('matching VOID_API_URL');
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.login).not.toHaveBeenCalled();
      expect(getActivePlatformConnection()).toBeNull();
    },
  );
  it('allows explicit registration without login', async () => {
    await runConnectCommand(root, parseConnectArgs([discovery.apiUrl, '--no-login']), false);
    expect(getActivePlatformConnection()?.apiUrl).toBe(discovery.apiUrl);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it('does not change a destination when login fails', async () => {
    mocks.login.mockRejectedValueOnce(new Error('cancelled'));
    await expect(
      runConnectCommand(root, parseConnectArgs([discovery.apiUrl]), true),
    ).rejects.toThrow('cancelled');
    expect(existsSync(projectFile())).toBe(false);
    expect(getActivePlatformConnection()).toBeNull();
  });
  it('saves Cloudflare while retaining an existing Void project link', async () => {
    seedProject({ projectId: 'project', slug: 'app', platformUrl: discovery.apiUrl });
    await runConnectCommand(root, parseConnectArgs(['--platform', 'cloudflare']), true);
    expect(mocks.cloudflare).toHaveBeenCalledWith(root, true);
    expect(JSON.parse(readFileSync(projectFile(), 'utf8'))).toMatchObject({
      platform: 'cloudflare',
      projectId: 'project',
      platformUrl: discovery.apiUrl,
    });
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it('does not change the saved target after Cloudflare authentication fails', async () => {
    const original = seedProject({ platform: 'void' });
    mocks.cloudflare.mockRejectedValueOnce(new Error('cancelled'));
    await expect(
      runConnectCommand(root, parseConnectArgs(['--platform', 'cloudflare']), true),
    ).rejects.toThrow('cancelled');
    expect(readFileSync(projectFile(), 'utf8')).toBe(original);
  });
  it('offers both targets interactively', async () => {
    mocks.select.mockResolvedValueOnce('cloudflare');
    await runConnectCommand(root, parseConnectArgs([]), true);
    expect(
      mocks.select.mock.calls[0][0].options.map((option: { value: string }) => option.value),
    ).toEqual(['cloudflare', 'void']);
    expect(mocks.cloudflare).toHaveBeenCalledOnce();
  });
  it('requires an explicit target in headless mode', async () => {
    await expect(runConnectCommand(root, parseConnectArgs([]), false)).rejects.toThrow(
      'Supply a platform URL',
    );
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
