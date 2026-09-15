import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getApiUrl, getProxyUrl, getSiteDomain } from '../../src/cli/auth.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import {
  attachSelectedPlatform,
  isVoidInternalStaging,
  readDeploymentPlatform,
  readProjectConfig,
  writeDeploymentPlatform,
  writeProjectConfig,
} from '../../src/cli/project.ts';

const roots: Array<string> = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-config-'));
  roots.push(root);
  return root;
}

function writeProjectJson(root: string, value: unknown): void {
  const voidDir = join(root, '.void');
  mkdirSync(voidDir, { recursive: true });
  writeFileSync(join(voidDir, 'project.json'), JSON.stringify(value, null, 2) + '\n');
}

describe('project config', () => {
  afterEach(() => {
    delete process.env.VOID_API_URL;
    delete process.env.VOID_PROXY_URL;
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('does not treat an internal staging-only file as a linked project', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    expect(readProjectConfig(root)).toBeNull();
    expect(isVoidInternalStaging(root)).toBe(true);
    expect(readDeploymentPlatform(root)).toBeNull();
  });

  it('infers Void for legacy linked project files', () => {
    const root = makeRoot();
    writeProjectJson(root, { projectId: 'proj_123', slug: 'demo' });

    expect(readDeploymentPlatform(root)).toBe('void');
    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getProxyUrl(root)).toBe('https://proxy.void.cloud');
  });

  it('keeps legacy Void Cloud projects pinned when another platform is active', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    writeProjectJson(root, { projectId: 'proj_123', slug: 'demo' });
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });

    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getSiteDomain(root)).toBe('void.app');
    expect(getProxyUrl(root)).toBe('https://proxy.void.cloud');
  });

  it('stores a platform without requiring a Void project link', () => {
    const root = makeRoot();

    writeDeploymentPlatform(root, 'cloudflare');

    expect(readDeploymentPlatform(root)).toBe('cloudflare');
    expect(readProjectConfig(root)).toBeNull();
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      platform: 'cloudflare',
    });
  });

  it('preserves an existing Void project link when changing platforms', () => {
    const root = makeRoot();
    writeProjectJson(root, {
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });

    writeDeploymentPlatform(root, 'none');

    expect(readDeploymentPlatform(root)).toBe('none');
    expect(readProjectConfig(root)).toEqual({
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
  });

  it('preserves the internal staging flag when linking a project', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    writeProjectConfig(root, { projectId: 'proj_123', slug: 'demo' });

    expect(readProjectConfig(root)).toEqual({
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      platform: 'void',
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
  });

  it('stores the linked platform origin and application domain', () => {
    const root = makeRoot();
    writeProjectConfig(root, {
      applicationDomain: 'Apps.Example.com.',
      platformUrl: 'https://platform.example.com/',
      projectId: 'proj_123',
      slug: 'demo',
    });

    expect(readProjectConfig(root)).toEqual({
      applicationDomain: 'apps.example.com',
      platformUrl: 'https://platform.example.com',
      projectId: 'proj_123',
      slug: 'demo',
    });
  });

  it('uses the staging API from the internal project flag unless explicitly overridden', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    expect(getApiUrl(root)).toBe('https://api.staging.void.cloud');

    process.env.VOID_API_URL = 'https://api.example.test';
    expect(getApiUrl(root)).toBe('https://api.example.test');
  });

  it('uses an active platform connection but keeps internal staging isolated', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    expect(getApiUrl(root)).toBe('https://platform.example.test');
    expect(getProxyUrl(root)).toBe('https://proxy.example.test');

    writeProjectJson(root, { voidInternalStaging: true });
    expect(getApiUrl(root)).toBe('https://api.staging.void.cloud');
    expect(getProxyUrl(root)).toBe('https://proxy.staging.void.cloud');
  });

  it('does not trust a project proxy origin to receive platform credentials', () => {
    const root = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = makeRoot();
    writeProjectJson(root, {
      applicationDomain: 'void.app',
      platformUrl: 'https://api.void.cloud',
      projectId: 'proj_123',
      proxyUrl: 'https://attacker.example',
      slug: 'demo',
    });

    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getProxyUrl(root)).toBe('https://proxy.void.cloud');
  });

  it('does not trust an unregistered project API origin to receive platform credentials', () => {
    const root = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = makeRoot();
    writeProjectJson(root, {
      platformUrl: 'https://attacker.example',
      projectId: 'proj_123',
      proxyUrl: 'https://attacker.example',
      slug: 'demo',
    });

    expect(() => getApiUrl(root)).toThrow('selected unverified platform');
    expect(() => getProxyUrl(root)).toThrow('selected unverified platform');

    process.env.VOID_API_URL = 'https://operator.example';
    process.env.VOID_PROXY_URL = 'https://operator-proxy.example';
    expect(getApiUrl(root)).toBe('https://operator.example');
    expect(getProxyUrl(root)).toBe('https://operator-proxy.example');
  });

  it('pairs a VOID_API_URL override with its verified proxy', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    writeProjectJson(root, {
      platformUrl: 'https://api.void.cloud',
      projectId: 'proj_123',
      proxyUrl: 'https://attacker.example',
      slug: 'demo',
    });
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });

    process.env.VOID_API_URL = 'https://platform.example.test';
    expect(getProxyUrl(root)).toBe('https://proxy.example.test');

    process.env.VOID_API_URL = 'https://api.staging.void.cloud';
    expect(getProxyUrl(root)).toBe('https://proxy.staging.void.cloud');

    process.env.VOID_API_URL = 'https://unregistered.example.test';
    expect(() => getProxyUrl(root)).toThrow('No verified proxy is registered');

    process.env.VOID_PROXY_URL = 'https://operator-proxy.example.test';
    expect(getProxyUrl(root)).toBe('https://operator-proxy.example.test');
  });

  it('requires a selected platform before creating a new project link', () => {
    const root = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = makeRoot();
    expect(() =>
      attachSelectedPlatform(
        root,
        { projectId: 'proj_new', slug: 'new-app' },
        'https://platform.example.test',
      ),
    ).toThrow('No verified metadata is registered');
  });

  it('preserves Void Cloud when relinking a legacy project without a registry connection', () => {
    const root = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = makeRoot();
    writeProjectJson(root, { projectId: 'proj_legacy', slug: 'legacy-app' });

    expect(
      attachSelectedPlatform(
        root,
        { projectId: 'proj_new', slug: 'new-app' },
        'https://api.void.cloud',
      ),
    ).toEqual({
      applicationDomain: 'void.app',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
      projectId: 'proj_new',
      slug: 'new-app',
    });
  });

  it('attaches the selected platform identity to a new project link', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    expect(
      attachSelectedPlatform(
        root,
        { projectId: 'proj_new', slug: 'new-app' },
        'https://platform.example.test',
      ),
    ).toEqual({
      applicationDomain: 'apps.example.test',
      platformUrl: 'https://platform.example.test',
      proxyUrl: 'https://proxy.example.test',
      projectId: 'proj_new',
      slug: 'new-app',
    });
  });

  it('attaches the API operation platform instead of the active connection', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://b.example.test',
      applicationDomain: 'apps.b.example.test',
      displayName: 'Platform B',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.b.example.test',
    });
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://a.example.test',
      applicationDomain: 'apps.a.example.test',
      displayName: 'Platform A',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.a.example.test',
    });

    expect(
      attachSelectedPlatform(
        root,
        { projectId: 'project-from-b', slug: 'app-b' },
        'https://b.example.test',
      ),
    ).toMatchObject({
      applicationDomain: 'apps.b.example.test',
      platformUrl: 'https://b.example.test',
      proxyUrl: 'https://proxy.b.example.test',
    });
  });
});
