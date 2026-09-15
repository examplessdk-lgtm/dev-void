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

    constructor(_service: string, account: string) {
      this.account = account;
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
