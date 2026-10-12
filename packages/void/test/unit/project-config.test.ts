import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getApiUrl, getProxyUrl, getSiteDomain } from '../../src/cli/auth.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import {
  attachSelectedPlatform,
  readDeploymentPlatform,
  readProjectConfig,
  writeDeploymentPlatform,
  writePlatformSelection,
  writeProjectConfig,
} from '../../src/cli/project.ts';

const roots: Array<string> = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-config-'));
  roots.push(root);
  return root;
}
function writeProjectJson(root: string, value: unknown): void {
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(join(root, '.void', 'project.json'), JSON.stringify(value));
}
function connection(apiUrl = 'https://platform.example.test') {
  return savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: 'apps.example.test',
    displayName: 'Example',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.example.test',
  });
}
beforeEach(() => {
  process.env.VOID_PLATFORM_REGISTRY_DIR = makeRoot();
});
afterEach(() => {
  delete process.env.VOID_API_URL;
  delete process.env.VOID_PROXY_URL;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('project config', () => {
  it('does not select a destination from the retired staging flag', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });
    expect(readProjectConfig(root)).toBeNull();
    expect(readDeploymentPlatform(root)).toBeNull();
    expect(() => getApiUrl(root)).toThrow('void connect');
  });

  it.each([false, true])(
    'rejects unscoped legacy project links (active connection: %s)',
    (active) => {
      const root = makeRoot();
      writeProjectJson(root, { projectId: 'proj_123', slug: 'demo' });
      if (active) {
        connection();
      }
      expect(readDeploymentPlatform(root)).toBe('void');
      expect(() => getApiUrl(root)).toThrow('project link has no platform URL');
      expect(() => getProxyUrl(root)).toThrow('project link has no platform URL');
      expect(() => getSiteDomain(root)).toThrow('project link has no platform URL');
    },
  );

  it('clears an unscoped project ID when explicitly connecting so it must be relinked', () => {
    const root = makeRoot();
    writeProjectJson(root, {
      projectId: 'retired-project',
      slug: 'old-app',
      voidInternalStaging: true,
    });
    const selected = connection();
    expect(
      writePlatformSelection(root, {
        apiUrl: selected.apiUrl,
        applicationDomain: selected.applicationDomain!,
        proxyUrl: selected.proxyUrl!,
      }),
    ).toBe(true);
    expect(readProjectConfig(root)).toBeNull();
    expect(getApiUrl(root)).toBe(selected.apiUrl);
    expect(JSON.parse(readFileSync(join(root, '.void/project.json'), 'utf8'))).toEqual({
      platform: 'void',
      platformUrl: selected.apiUrl,
      applicationDomain: selected.applicationDomain,
      proxyUrl: selected.proxyUrl,
    });
  });

  it('preserves a project pinned to another platform when connecting', () => {
    const root = makeRoot();
    connection('https://a.example.test');
    writeProjectConfig(root, {
      projectId: 'project-a',
      slug: 'app-a',
      platformUrl: 'https://a.example.test',
    });
    const selected = connection('https://b.example.test');
    expect(
      writePlatformSelection(root, {
        apiUrl: selected.apiUrl,
        applicationDomain: selected.applicationDomain!,
        proxyUrl: selected.proxyUrl!,
      }),
    ).toBe(false);
    expect(getApiUrl(root)).toBe('https://a.example.test');
    expect(readProjectConfig(root)?.projectId).toBe('project-a');
  });

  it('stores a deployment preference without requiring a project link', () => {
    const root = makeRoot();
    writeDeploymentPlatform(root, 'cloudflare');
    expect(readDeploymentPlatform(root)).toBe('cloudflare');
    expect(readProjectConfig(root)).toBeNull();
  });

  it('preserves an explicit project link when changing deployment targets', () => {
    const root = makeRoot();
    const project = {
      projectId: 'proj_123',
      slug: 'demo',
      platformUrl: 'https://platform.example.test',
    };
    writeProjectJson(root, project);
    writeDeploymentPlatform(root, 'none');
    expect(readDeploymentPlatform(root)).toBe('none');
    expect(readProjectConfig(root)).toEqual(project);
  });

  it('stores normalized platform metadata and drops retired staging hints', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });
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
    expect(
      JSON.parse(readFileSync(join(root, '.void/project.json'), 'utf8')).voidInternalStaging,
    ).toBeUndefined();
  });

  it('uses a connected platform even when a retired staging-only flag remains', () => {
    const root = makeRoot();
    connection();
    writeProjectJson(root, { voidInternalStaging: true });
    expect(getApiUrl(root)).toBe('https://platform.example.test');
    expect(getProxyUrl(root)).toBe('https://proxy.example.test');
  });

  it('uses verified connection metadata rather than project-controlled proxy and app domains', () => {
    const root = makeRoot();
    connection();
    writeProjectJson(root, {
      platformUrl: 'https://platform.example.test',
      applicationDomain: 'attacker.example',
      proxyUrl: 'https://attacker.example',
      projectId: 'project',
      slug: 'demo',
    });
    expect(getSiteDomain(root)).toBe('apps.example.test');
    expect(getProxyUrl(root)).toBe('https://proxy.example.test');
  });

  it.each(['https://attacker.example', 'https://api.void.cloud'])(
    'requires a registered connection for %s',
    (platformUrl) => {
      const root = makeRoot();
      writeProjectJson(root, { platformUrl, projectId: 'project', slug: 'demo' });
      expect(() => getApiUrl(root)).toThrow(`void connect ${platformUrl}`);
      expect(() =>
        attachSelectedPlatform({ projectId: 'project', slug: 'demo' }, platformUrl),
      ).toThrow('No verified metadata');
    },
  );

  it('attaches the operation platform instead of the active connection', () => {
    connection('https://b.example.test');
    connection('https://a.example.test');
    expect(
      attachSelectedPlatform({ projectId: 'project-b', slug: 'app-b' }, 'https://b.example.test'),
    ).toEqual({
      applicationDomain: 'apps.example.test',
      platformUrl: 'https://b.example.test',
      proxyUrl: 'https://proxy.example.test',
      projectId: 'project-b',
      slug: 'app-b',
    });
  });
});
