import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathslash';

export type HostedPlatform = Readonly<{
  apiUrl: string;
  applicationDomain: string;
  displayName: string;
  proxyUrl: string;
}>;

export type HostedPlatformSelection = HostedPlatform &
  Readonly<{ source: 'configured-api' | 'legacy-credential' }>;

export const VOID_CLOUD_PLATFORM: HostedPlatform = Object.freeze({
  apiUrl: 'https://api.void.cloud',
  applicationDomain: 'void.app',
  displayName: 'Void Cloud',
  proxyUrl: 'https://proxy.void.cloud',
});

export const VOID_CLOUD_STAGING_PLATFORM: HostedPlatform = Object.freeze({
  apiUrl: 'https://api.staging.void.cloud',
  applicationDomain: 'staging.void.app',
  displayName: 'Void Cloud staging',
  proxyUrl: 'https://proxy.staging.void.cloud',
});

const HOSTED_PLATFORMS: ReadonlyArray<HostedPlatform> = [
  VOID_CLOUD_PLATFORM,
  VOID_CLOUD_STAGING_PLATFORM,
];

export function hostedPlatformForApiUrl(apiUrl: unknown): HostedPlatform | null {
  if (typeof apiUrl !== 'string') {
    return null;
  }
  let normalized: string;
  try {
    const parsed = new URL(apiUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '')
    ) {
      return null;
    }
    normalized = parsed.origin;
  } catch {
    return null;
  }
  return HOSTED_PLATFORMS.find((platform) => platform.apiUrl === normalized) ?? null;
}

/** Resolve an old ~/.void/config.json selection without returning credential values. */
export function readLegacyHostedPlatformSelection(
  configPath: string = join(homedir(), '.void', 'config.json'),
): HostedPlatformSelection | null {
  let value: { api?: unknown; stagingToken?: unknown; token?: unknown } = {};
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8')) as typeof value;
  } catch {
    return null;
  }
  if (value.api !== undefined) {
    const platform = hostedPlatformForApiUrl(value.api);
    return platform ? { ...platform, source: 'configured-api' } : null;
  }
  if (typeof value.token === 'string' && value.token !== '') {
    return { ...VOID_CLOUD_PLATFORM, source: 'legacy-credential' };
  }
  if (typeof value.stagingToken === 'string' && value.stagingToken !== '') {
    return { ...VOID_CLOUD_STAGING_PLATFORM, source: 'legacy-credential' };
  }
  return null;
}
