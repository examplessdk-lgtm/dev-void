import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Workers that report the platform version: the API (discovery and the
 * operator system overview) and the email gateway (health).
 */
const PLATFORM_VERSION_WORKER_DIRECTORIES = new Set(
  ['api', 'email-gateway'].map((name) =>
    fileURLToPath(new URL(`../packages/${name}`, import.meta.url)),
  ),
);

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The release version of this checkout. Installed platforms report the same
 * version, which the installer reads from the packaged runtime.
 */
export function readPlatformReleaseVersion(): string {
  const { version } = JSON.parse(
    readFileSync(new URL('../../packages/platform/package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) {
    throw new Error(`packages/platform/package.json has no release version: ${String(version)}`);
  }
  return version;
}

/**
 * Wrangler arguments that make a hosted deploy report its release version, so
 * the CLI's minimum platform version check applies to hosted platforms too.
 * Deploys with their own config (such as the GitHub webhook ingress) and other
 * Workers get none.
 */
export function platformVersionDeployArgs(
  workerDirectory: string,
  customConfig: boolean,
  version: string = readPlatformReleaseVersion(),
): Array<string> {
  if (customConfig || !PLATFORM_VERSION_WORKER_DIRECTORIES.has(workerDirectory)) {
    return [];
  }
  return ['--var', `PLATFORM_VERSION:${version}`];
}
