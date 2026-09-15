import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parsePlatformDeploymentManifest } from '@void/platform';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  hostedPlatformForApiUrl,
  readLegacyHostedPlatformSelection,
  VOID_CLOUD_PLATFORM,
} from '../../src/cli/hosted-platform.ts';

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function config(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'void-hosted-platform-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('hosted platform compatibility', () => {
  it('matches the public legacy endpoint without containing account secrets or ids', () => {
    const path = join(process.cwd(), 'platform', 'deployments', 'void-cloud.json');
    const raw = readFileSync(path, 'utf8');
    const manifest = parsePlatformDeploymentManifest(JSON.parse(raw) as unknown);
    expect(manifest.controlPlane.apiHostname).toBe(new URL(VOID_CLOUD_PLATFORM.apiUrl).hostname);
    expect(manifest.application.baseDomain).toBe(VOID_CLOUD_PLATFORM.applicationDomain);
    expect(manifest.displayName).toBe(VOID_CLOUD_PLATFORM.displayName);
    expect(raw).not.toMatch(/account[_-]?id|zone[_-]?id|api[_-]?token|secret/i);
  });

  it('recognizes the production and staging hosted origins', () => {
    expect(hostedPlatformForApiUrl('https://api.void.cloud/')).toMatchObject({
      applicationDomain: 'void.app',
      proxyUrl: 'https://proxy.void.cloud',
    });
    expect(hostedPlatformForApiUrl('https://api.staging.void.cloud')).toMatchObject({
      applicationDomain: 'staging.void.app',
      proxyUrl: 'https://proxy.staging.void.cloud',
    });
  });

  it('resolves only known legacy config selections', () => {
    expect(
      readLegacyHostedPlatformSelection(
        config({ api: 'https://api.void.cloud', token: 'legacy-secret' }),
      ),
    ).toMatchObject({ apiUrl: 'https://api.void.cloud', applicationDomain: 'void.app' });
    expect(
      readLegacyHostedPlatformSelection(
        config({ api: 'https://api.staging.void.cloud', stagingToken: 'legacy-secret' }),
      ),
    ).toMatchObject({
      apiUrl: 'https://api.staging.void.cloud',
      applicationDomain: 'staging.void.app',
    });
    expect(
      readLegacyHostedPlatformSelection(config({ api: 'https://attacker.example' })),
    ).toBeNull();
  });

  it('recognizes token-only configs written by the historical Void Cloud CLI', () => {
    expect(readLegacyHostedPlatformSelection(config({ token: 'legacy-secret' }))).toMatchObject({
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      source: 'legacy-credential',
    });
    expect(
      readLegacyHostedPlatformSelection(config({ stagingToken: 'legacy-secret' })),
    ).toMatchObject({
      apiUrl: 'https://api.staging.void.cloud',
      applicationDomain: 'staging.void.app',
      source: 'legacy-credential',
    });
  });
});
