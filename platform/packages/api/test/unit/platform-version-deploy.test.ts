import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  platformVersionDeployArgs,
  readPlatformReleaseVersion,
} from '../../../../scripts/platform-version.ts';

const workerDirectory = (name: string) =>
  fileURLToPath(new URL(`../../../${name}`, import.meta.url));

describe('hosted platform version', () => {
  it('reads the release version of packages/platform', () => {
    const { version } = JSON.parse(
      readFileSync(
        new URL('../../../../../packages/platform/package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string };
    expect(readPlatformReleaseVersion()).toBe(version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(['api', 'email-gateway'])('sets PLATFORM_VERSION on the %s deploy', (name) => {
    expect(platformVersionDeployArgs(workerDirectory(name), false, '0.23.0')).toEqual([
      '--var',
      'PLATFORM_VERSION:0.23.0',
    ]);
  });

  it('defaults to the release version of this checkout', () => {
    expect(platformVersionDeployArgs(workerDirectory('api'), false)).toEqual([
      '--var',
      `PLATFORM_VERSION:${readPlatformReleaseVersion()}`,
    ]);
  });

  it.each(['dispatch', 'proxy', 'tail', 'dashboard'])('leaves the %s deploy unchanged', (name) => {
    expect(platformVersionDeployArgs(workerDirectory(name), false, '0.23.0')).toEqual([]);
  });

  it('leaves a deploy with its own config unchanged', () => {
    expect(platformVersionDeployArgs(workerDirectory('api'), true, '0.23.0')).toEqual([]);
  });
});
