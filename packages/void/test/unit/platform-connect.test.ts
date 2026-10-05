import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { discoverPlatform, runPlatformCommand } from '../../src/cli/platform-cmd.ts';
import { writeInstallationManifest } from '../../src/cli/platform-registry.ts';

const document = {
  apiUrl: 'https://api.example.com',
  applicationDomain: 'apps.example.com',
  authenticationProviders: ['github'],
  capabilities: {
    ai: true,
    customDomains: false,
    email: false,
    githubActions: false,
    githubOAuth: true,
    googleOAuth: false,
    managedBuilds: false,
    sandbox: false,
  },
  displayName: 'Example',
  installationId: 'example-a1b2c3d4',
  platformVersion: '1.0.0',
  proxyUrl: 'https://proxy.example.com',
  schemaVersion: 1,
};

afterEach(() => {
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
  delete process.env.CF_ACCESS_TOKEN;
  delete process.env.VOID_ACCESS_ORIGIN;
});

describe('platform discovery', () => {
  it('shows saved lifecycle progress when live discovery is blocked by maintenance', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-status-'));
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Platform disabled', { status: 503 })),
    );
    try {
      const timestamp = '2026-10-05T00:00:00.000Z';
      const manifest = createPlatformInstallationManifest({
        account: { id: 'account', name: 'Account' },
        createdAt: timestamp,
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
          displayName: 'Example',
          installationSlug: 'example',
        }),
        id: 'status-installation',
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        platformVersion: '1.0.0',
      });
      writeInstallationManifest({
        ...manifest,
        status: 'verifying',
        endpoints: { apiUrl: 'https://api.example.com', dashboardUrl: null, proxyUrl: null },
        operation: {
          id: 'upgrade',
          action: 'upgrade',
          fromVersion: '1.0.0',
          toVersion: '2.0.0',
          phase: 'verifying',
          startedAt: timestamp,
          updatedAt: timestamp,
        },
      });
      await expect(
        runPlatformCommand('.', { subcommand: 'status', selector: manifest.id }),
      ).rejects.toThrow('503');
      expect(output).toHaveBeenCalledWith('Saved operation: upgrade — verifying');
      expect(output).toHaveBeenCalledWith('Runtime: 1.0.0 → 2.0.0');
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('is reachable'));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reports a disabled platform and how to enable it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-status-'));
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn(async () =>
      Response.json({ error: 'Platform disabled' }, { status: 503 }),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const timestamp = '2026-10-05T00:00:00.000Z';
      const manifest = createPlatformInstallationManifest({
        account: { id: 'account', name: 'Account' },
        createdAt: timestamp,
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
          displayName: 'Example',
          installationSlug: 'example',
        }),
        id: 'disabled-installation',
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        platformVersion: '1.0.0',
      });
      writeInstallationManifest({
        ...manifest,
        status: 'disabled',
        endpoints: { apiUrl: 'https://api.example.com', dashboardUrl: null, proxyUrl: null },
      });
      await expect(
        runPlatformCommand('.', { subcommand: 'status', selector: manifest.id }),
      ).resolves.toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        'Platform: disabled (API and application traffic are paused).',
      );
      expect(output).toHaveBeenCalledWith('Enable it: void platform enable disabled-installation');
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('is reachable'));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reports an upgrade or repair, not a disabled platform, while maintenance pauses traffic', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-status-'));
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'Platform disabled', reason: 'maintenance' }, { status: 503 }),
      ),
    );
    try {
      const manifest = createPlatformInstallationManifest({
        account: { id: 'account', name: 'Account' },
        createdAt: '2026-10-05T00:00:00.000Z',
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
          displayName: 'Example',
          installationSlug: 'example',
        }),
        id: 'maintenance-installation',
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        platformVersion: '1.0.0',
      });
      writeInstallationManifest({
        ...manifest,
        status: 'verifying',
        endpoints: { apiUrl: 'https://api.example.com', dashboardUrl: null, proxyUrl: null },
      });
      await expect(
        runPlatformCommand('.', { subcommand: 'status', selector: manifest.id }),
      ).rejects.toThrow('upgrade or repair');
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('disabled'));
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('void platform enable'));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('accepts a valid document from its declared origin', async () => {
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });
    await expect(
      discoverPlatform('https://api.example.com', async () => response),
    ).resolves.toMatchObject({ displayName: 'Example' });
  });

  it('requires a proxy origin even for former hosted discovery documents', async () => {
    const legacyHosted = { ...document, apiUrl: 'https://api.void.cloud' } as Record<
      string,
      unknown
    >;
    delete legacyHosted.proxyUrl;
    const response = new Response(JSON.stringify(legacyHosted));
    Object.defineProperty(response, 'url', {
      value: 'https://api.void.cloud/.well-known/void-platform',
    });

    await expect(discoverPlatform('https://api.void.cloud', async () => response)).rejects.toThrow(
      'proxyUrl',
    );
  });

  it('rejects custom discovery documents without a proxy origin', async () => {
    const incomplete = { ...document } as Record<string, unknown>;
    delete incomplete.proxyUrl;
    const response = new Response(JSON.stringify(incomplete));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });

    await expect(discoverPlatform('https://api.example.com', async () => response)).rejects.toThrow(
      'proxyUrl',
    );
  });

  it('rejects discovery documents that claim a different origin', async () => {
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://evil.example/.well-known/void-platform',
    });
    await expect(discoverPlatform('https://api.example.com', async () => response)).rejects.toThrow(
      'origin mismatch',
    );
  });

  it('authenticates discovery for Access-gated Void Cloud staging', async () => {
    process.env.CF_ACCESS_CLIENT_ID = 'client-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'client-secret';
    process.env.VOID_ACCESS_ORIGIN = 'https://api.staging.void.cloud';
    const stagingDocument = {
      ...document,
      apiUrl: 'https://api.staging.void.cloud',
      proxyUrl: 'https://proxy.staging.void.cloud',
    };
    const response = new Response(JSON.stringify(stagingDocument));
    Object.defineProperty(response, 'url', {
      value: 'https://api.staging.void.cloud/.well-known/void-platform',
    });
    let request: RequestInit | undefined;

    await discoverPlatform('https://api.staging.void.cloud', async (_input, init) => {
      request = init;
      return response;
    });

    expect(request?.headers).toMatchObject({
      'CF-Access-Client-Id': 'client-id',
      'CF-Access-Client-Secret': 'client-secret',
    });
    expect(request?.redirect).toBe('manual');
  });

  it('does not forward hosted Access credentials to a user platform origin', async () => {
    process.env.CF_ACCESS_CLIENT_ID = 'client-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'client-secret';
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });
    let request: RequestInit | undefined;

    await discoverPlatform('https://api.example.com', async (_input, init) => {
      request = init;
      return response;
    });

    expect(request?.headers).toEqual({ Accept: 'application/json' });
    expect(request?.redirect).toBe('manual');
  });
});
