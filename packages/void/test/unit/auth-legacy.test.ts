import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({
  home: '',
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
      return state.passwords.get(this.account) ?? null;
    }

    setPassword(password: string) {
      state.passwords.set(this.account, password);
    }
  },
}));

const directories: Array<string> = [];

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'void-auth-legacy-home-'));
  directories.push(state.home);
  state.passwords.clear();
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

describe('legacy Void Cloud authentication', () => {
  it.each([
    { account: 'token', apiUrl: 'https://api.void.cloud' },
    { account: 'stagingToken', apiUrl: 'https://api.staging.void.cloud' },
  ])(
    'keeps legacy $account keychain login available for account invitation commands',
    async ({ account, apiUrl }) => {
      state.passwords.set(`dev.void.cli:${account}`, 'legacy-account-token');
      const { getAccountCredential } = await import('../../src/cli/auth.ts');
      const { platformCredentialAccount } = await import('../../src/cli/platform-registry.ts');

      expect(getAccountCredential()).toEqual({ apiUrl, token: 'legacy-account-token' });
      expect(state.passwords.get(`dev.void.cli:${platformCredentialAccount(apiUrl)}`)).toBe(
        'legacy-account-token',
      );
    },
  );

  it.each([
    { account: 'token', apiUrl: 'https://api.void.cloud' },
    { account: 'stagingToken', apiUrl: 'https://api.staging.void.cloud' },
    { account: 'token', apiUrl: 'https://legacy-platform.example.test' },
  ])(
    'migrates legacy file login for account invitation commands at $apiUrl',
    async ({ account, apiUrl }) => {
      const configDirectory = join(state.home, '.void');
      mkdirSync(configDirectory, { recursive: true });
      const configPath = join(configDirectory, 'config.json');
      writeFileSync(configPath, JSON.stringify({ api: apiUrl, [account]: 'legacy-account-token' }));
      const { getAccountCredential } = await import('../../src/cli/auth.ts');

      expect(getAccountCredential()).toEqual({ apiUrl, token: 'legacy-account-token' });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ api: apiUrl });
    },
  );

  it('does not migrate a legacy credential for another active platform', async () => {
    const configDirectory = join(state.home, '.void');
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, 'config.json'),
      JSON.stringify({ token: 'cloud-only-token' }),
    );
    const { savePlatformConnection } = await import('../../src/cli/platform-registry.ts');
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: null,
      displayName: 'Platform',
      installationId: null,
      kind: 'connected',
      proxyUrl: null,
    });
    const { getAccountCredential } = await import('../../src/cli/auth.ts');

    expect(getAccountCredential()).toEqual({
      apiUrl: 'https://platform.example.test',
      token: null,
    });
    expect(state.passwords.size).toBe(0);
  });

  it('preserves token-only Void Cloud CI on clean runners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-legacy-ci-'));
    directories.push(root);
    process.env.VOID_TOKEN = 'ci-token';
    const { getApiUrl, getProxyUrl, getSiteDomain, getToken } =
      await import('../../src/cli/auth.ts');

    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getProxyUrl(root)).toBe('https://proxy.void.cloud');
    expect(getSiteDomain(root)).toBe('void.app');
    expect(getToken(root)).toBe('ci-token');
  });

  it('preserves a token-only platform selection while migrating to the keychain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-legacy-project-'));
    directories.push(root);
    const configDirectory = join(state.home, '.void');
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'config.json');
    writeFileSync(configPath, JSON.stringify({ token: 'legacy-token' }));
    const { getApiUrl, getToken } = await import('../../src/cli/auth.ts');
    const { attachSelectedPlatform } = await import('../../src/cli/project.ts');

    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getToken(root)).toBe('legacy-token');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      api: 'https://api.void.cloud',
    });
    expect(
      attachSelectedPlatform(root, { projectId: 'project', slug: 'app' }, 'https://api.void.cloud'),
    ).toMatchObject({
      applicationDomain: 'void.app',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
    });
    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getToken(root)).toBe('legacy-token');
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
    const { getApiUrl, getSiteDomain } = await import('../../src/cli/auth.ts');
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
      const { runAuthCommand } = await import('../../src/cli/auth-cmd.ts');
      const fetcher = vi.spyOn(globalThis, 'fetch');
      try {
        expect(getApiUrl(root)).toBe(origin);
        expect(() => getToken(root)).toThrow('VOID_TOKEN is not bound');
        await expect(runAuthCommand(root, { subcommand: 'whoami' })).rejects.toThrow(
          'VOID_TOKEN is not bound',
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
      .mockResolvedValue(Response.json({ login: 'operator', plan: 'free' }));
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
    expect(() => getToken(root)).toThrow('VOID_TOKEN is not bound');
    process.env.VOID_API_URL = 'https://api.staging.void.cloud';
    expect(getToken(root)).toBe('production-token');
  });
});
