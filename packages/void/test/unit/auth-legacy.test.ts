import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const state = vi.hoisted(() => ({
  home: '',
  keyringUnavailable: false,
  passwords: new Map<string, string>(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => state.home,
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    readonly account: string;

    constructor(service: string, account: string) {
      this.account = `${service}:${account}`;
    }

    deletePassword() {
      return state.passwords.delete(this.account);
    }

    getPassword() {
      if (state.keyringUnavailable) {
        throw new Error('Keychain unavailable');
      }
      return state.passwords.get(this.account) ?? null;
    }

    setPassword(password: string) {
      if (state.keyringUnavailable) {
        throw new Error('Keychain unavailable');
      }
      state.passwords.set(this.account, password);
    }
  },
}));

const directories: Array<string> = [];

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'void-auth-legacy-home-'));
  directories.push(state.home);
  state.passwords.clear();
  state.keyringUnavailable = false;
  process.env.VOID_PLATFORM_REGISTRY_DIR = join(state.home, 'registry');
  vi.resetModules();
});

afterEach(() => {
  delete process.env.VOID_API_URL;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  delete process.env.VOID_PROXY_URL;
  delete process.env.VOID_TOKEN;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function connect(apiUrl: string) {
  const { savePlatformConnection } = await import('../../src/cli/platform-registry.ts');
  savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: 'apps.example.test',
    displayName: 'Example',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.example.test',
  });
}

describe('retired unscoped credentials', () => {
  it('rejects an environment URL and token before a connection, without contacting the platform', async () => {
    process.env.VOID_API_URL = 'https://platform.example.test';
    process.env.VOID_TOKEN = 'ci-token';
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const { getApiUrl, getToken, getAccountCredential } = await import('../../src/cli/auth.ts');
    expect(() => getApiUrl(state.home)).toThrow('void connect https://platform.example.test');
    expect(() => getToken(state.home)).toThrow('void connect');
    expect(() => getAccountCredential()).toThrow('void connect');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
    await connect(process.env.VOID_API_URL);
    expect(getApiUrl(state.home)).toBe('https://platform.example.test');
    expect(getToken(state.home)).toBe('ci-token');
  });
  it.each([
    { account: 'token', apiUrl: 'https://api.void.cloud' },
    { account: 'stagingToken', apiUrl: 'https://api.staging.void.cloud' },
  ])(
    'ignores the $account keychain destination until explicitly connected',
    async ({ account, apiUrl }) => {
      const root = mkdtempSync(join(tmpdir(), 'void-auth-retired-project-'));
      directories.push(root);
      state.passwords.set(`dev.void.cli:${account}`, 'retired-token');
      const { getAccountCredential, getApiUrl, getToken } = await import('../../src/cli/auth.ts');

      expect(() => getAccountCredential()).toThrow('void connect');
      expect(() => getApiUrl(root)).toThrow('void connect');
      expect(getToken(root)).toBeNull();
      expect(state.passwords).toEqual(new Map([[`dev.void.cli:${account}`, 'retired-token']]));
    },
  );

  it.each([
    { account: 'token', apiUrl: 'https://api.void.cloud' },
    { account: 'stagingToken', apiUrl: 'https://api.staging.void.cloud' },
    { account: 'token', apiUrl: 'https://legacy-platform.example.test' },
  ])('ignores the old file credential and $apiUrl selection', async ({ account, apiUrl }) => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-retired-project-'));
    directories.push(root);
    const configDirectory = join(state.home, '.void');
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'config.json');
    const config = { api: apiUrl, [account]: 'retired-token' };
    writeFileSync(configPath, JSON.stringify(config));
    const { getAccountCredential, getApiUrl, getToken } = await import('../../src/cli/auth.ts');

    expect(() => getAccountCredential()).toThrow('void connect');
    expect(() => getApiUrl(root)).toThrow('void connect');
    expect(getToken(root)).toBeNull();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(config);
    expect(state.passwords.size).toBe(0);
  });

  it.each([
    { account: 'token', apiUrl: 'https://api.void.cloud' },
    { account: 'stagingToken', apiUrl: 'https://api.staging.void.cloud' },
  ])('ignores token-only file destination $apiUrl', async ({ account, apiUrl }) => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-retired-project-'));
    directories.push(root);
    mkdirSync(join(state.home, '.void'));
    writeFileSync(
      join(state.home, '.void', 'config.json'),
      JSON.stringify({ [account]: 'retired-token' }),
    );
    const { getAccountCredential, getApiUrl, getToken } = await import('../../src/cli/auth.ts');
    expect(() => getAccountCredential()).toThrow('void connect');
    expect(() => getApiUrl(root)).toThrow('void connect');
    expect(getToken(root)).toBeNull();
  });

  it('uses and removes only the modern credential for the selected origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-retired-project-'));
    directories.push(root);
    const apiUrl = 'https://api.staging.void.cloud';
    process.env.VOID_API_URL = apiUrl;
    await connect(apiUrl);
    const { platformCredentialAccount } = await import('../../src/cli/platform-registry.ts');
    const account = `dev.void.cli:${platformCredentialAccount(apiUrl)}`;
    const productionAccount = `dev.void.cli:${platformCredentialAccount('https://api.void.cloud')}`;
    state.passwords.set(account, 'current-token');
    state.passwords.set(productionAccount, 'production-token');
    state.passwords.set('dev.void.cli:stagingToken', 'retired-token');
    const { getToken, removeToken } = await import('../../src/cli/auth.ts');
    expect(getToken(root)).toBe('current-token');
    expect(removeToken(root)).toBe(true);
    expect(getToken(root)).toBeNull();
    expect(state.passwords.get(productionAccount)).toBe('production-token');
    expect(state.passwords.get('dev.void.cli:stagingToken')).toBe('retired-token');
  });

  it('rejects token-only CI on clean runners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-legacy-ci-'));
    directories.push(root);
    process.env.VOID_TOKEN = 'ci-token';
    const { getApiUrl, getProxyUrl, getSiteDomain, getToken } =
      await import('../../src/cli/auth.ts');

    expect(() => getApiUrl(root)).toThrow('void connect');
    expect(() => getProxyUrl(root)).toThrow('void connect');
    expect(() => getSiteDomain(root)).toThrow('void connect');
    expect(() => getToken(root)).toThrow('void connect');
  });

  it('keeps origin-scoped file fallback when the keychain is unavailable', async () => {
    const apiUrl = 'https://platform.example.test';
    process.env.VOID_API_URL = apiUrl;
    await connect(apiUrl);
    mkdirSync(join(state.home, '.void'));
    const configPath = join(state.home, '.void', 'config.json');
    const config = {
      tokens: { [apiUrl]: 'origin-file-token', 'https://other.example.test': 'other-token' },
    };
    writeFileSync(configPath, JSON.stringify(config));
    state.keyringUnavailable = true;
    const { getAccountCredential, readPlatformToken, removeToken } =
      await import('../../src/cli/auth.ts');

    expect(getAccountCredential()).toEqual({ apiUrl, token: 'origin-file-token' });
    expect(readPlatformToken(apiUrl)).toBe('origin-file-token');
    expect(readPlatformToken('https://unknown.example.test')).toBeNull();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(config);
    expect(removeToken()).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      tokens: { 'https://other.example.test': 'other-token' },
    });
  });

  it('reads and migrates an origin-scoped config token without project context', async () => {
    const origin = 'https://platform.example.test';
    const configDirectory = join(state.home, '.void');
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'config.json');
    writeFileSync(configPath, JSON.stringify({ tokens: { [origin]: 'origin-file-token' } }));
    const { readPlatformToken } = await import('../../src/cli/auth.ts');
    const { platformCredentialAccount } = await import('../../src/cli/platform-registry.ts');

    expect(readPlatformToken(`${origin}/`)).toBe('origin-file-token');
    expect(state.passwords.get(`dev.void.cli:${platformCredentialAccount(origin)}`)).toBe(
      'origin-file-token',
    );
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({});
    expect(readPlatformToken(origin)).toBe('origin-file-token');
  });

  it('lets an explicit platform connection supersede a legacy hosted selection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-platform-selection-'));
    directories.push(root);
    const configDirectory = join(state.home, '.void');
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, 'config.json'),
      JSON.stringify({ api: 'https://api.void.cloud', token: 'legacy-token' }),
    );
    const { getAccountCredential, getApiUrl, getSiteDomain } =
      await import('../../src/cli/auth.ts');
    const { attachSelectedPlatform } = await import('../../src/cli/project.ts');
    const { savePlatformConnection } = await import('../../src/cli/platform-registry.ts');
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Company Void',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });

    expect(getApiUrl(root)).toBe('https://platform.example.test');
    expect(getSiteDomain(root)).toBe('apps.example.test');
    expect(getAccountCredential()).toEqual({
      apiUrl: 'https://platform.example.test',
      token: null,
    });
    expect(state.passwords.size).toBe(0);
    expect(
      attachSelectedPlatform(root, { projectId: 'project', slug: 'app' }, getApiUrl(root)),
    ).toMatchObject({
      applicationDomain: 'apps.example.test',
      platformUrl: 'https://platform.example.test',
      proxyUrl: 'https://proxy.example.test',
    });
  });
});

describe('environment token destinations', () => {
  async function connectedProject(withProject: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-origin-'));
    directories.push(root);
    const origin = 'https://other-platform.example.test';
    const { savePlatformConnection, platformCredentialAccount } =
      await import('../../src/cli/platform-registry.ts');
    savePlatformConnection({
      accountId: null,
      apiUrl: origin,
      applicationDomain: 'apps.example.test',
      displayName: 'Other platform',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    state.passwords.set(
      `dev.void.cli:${platformCredentialAccount(origin)}`,
      'other-platform-saved-token',
    );
    if (withProject) {
      mkdirSync(join(root, '.void'));
      writeFileSync(
        join(root, '.void', 'project.json'),
        JSON.stringify({
          projectId: 'project',
          slug: 'app',
          platform: 'void',
          platformUrl: origin,
        }),
      );
    }
    return { root, origin };
  }

  it.each([true, false])(
    'never forwards an ambient token to a selected custom platform (project=%s)',
    async (withProject) => {
      const { root, origin } = await connectedProject(withProject);
      process.env.VOID_TOKEN = 'legacy-cloud-token';
      const { getApiUrl, getToken } = await import('../../src/cli/auth.ts');
      const { runAccountCommand } = await import('../../src/cli/account-cmd.ts');
      const fetcher = vi.spyOn(globalThis, 'fetch');
      try {
        expect(getApiUrl(root)).toBe(origin);
        expect(() => getToken(root)).toThrow('Set VOID_API_URL alongside VOID_TOKEN');
        await expect(runAccountCommand(root, { subcommand: 'whoami' })).rejects.toThrow(
          'Set VOID_API_URL alongside VOID_TOKEN',
        );
        expect(fetcher).not.toHaveBeenCalled();
        delete process.env.VOID_TOKEN;
        expect(getToken(root)).toBe('other-platform-saved-token');
      } finally {
        fetcher.mockRestore();
      }
    },
  );

  it('uses an explicitly bound custom-platform token and normalized origin', async () => {
    const { root, origin } = await connectedProject(true);
    process.env.VOID_TOKEN = 'custom-platform-ci-token';
    process.env.VOID_API_URL = origin + '/';
    const { getApiUrl, getToken } = await import('../../src/cli/auth.ts');
    const { PlatformClient } = await import('../../src/cli/client.ts');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        withPlatformDiscovery(async () => Response.json({ login: 'operator', plan: 'free' })),
      );
    try {
      await new PlatformClient(getToken(root)!, { root }).whoami();
      expect(getApiUrl(root)).toBe(origin);
      expect(fetcher).toHaveBeenCalledWith(
        origin + '/me',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer custom-platform-ci-token' }),
        }),
      );
    } finally {
      fetcher.mockRestore();
    }
  });

  it('does not send an unscoped production token to a staging project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-staging-origin-'));
    directories.push(root);
    mkdirSync(join(root, '.void'));
    writeFileSync(
      join(root, '.void', 'project.json'),
      JSON.stringify({ voidInternalStaging: true }),
    );
    process.env.VOID_TOKEN = 'production-token';
    const { getToken } = await import('../../src/cli/auth.ts');
    expect(() => getToken(root)).toThrow('void connect');
    process.env.VOID_API_URL = 'https://api.staging.void.cloud';
    expect(() => getToken(root)).toThrow('void connect');
    await connect(process.env.VOID_API_URL);
    expect(getToken(root)).toBe('production-token');
  });
});
