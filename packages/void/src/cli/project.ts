import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { normalizeApplicationDomain } from '@void/platform';
import { join, dirname } from 'pathslash';
import {
  hostedPlatformForApiUrl,
  VOID_CLOUD_PLATFORM,
  VOID_CLOUD_STAGING_PLATFORM,
} from './hosted-platform.ts';
import { listPlatformConnections, normalizePlatformApiUrl } from './platform-registry.ts';
import type { DeployTarget } from './types.ts';

export type ProjectConfig = {
  applicationDomain?: string;
  platformUrl?: string;
  proxyUrl?: string;
  projectId: string;
  slug: string;
  voidInternalStaging?: boolean;
};

export type DeploymentPlatform = DeployTarget | 'none';

const PROJECT_FILE = '.void/project.json';

type ProjectConfigFile = {
  applicationDomain?: unknown;
  platform?: unknown;
  platformUrl?: unknown;
  projectId?: unknown;
  proxyUrl?: unknown;
  slug?: unknown;
  voidInternalStaging?: unknown;
};

function readProjectConfigFile(root: string): ProjectConfigFile | null {
  const filePath = join(root, PROJECT_FILE);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return null;
    }
    return config as ProjectConfigFile;
  } catch {
    return null;
  }
}

/**
 * Read the project config from the project root.
 * Returns null if no project.json exists.
 * A file containing only internal metadata is not treated as a linked project.
 */
export function readProjectConfig(root: string): ProjectConfig | null {
  const config = readProjectConfigFile(root);
  if (!config || typeof config.projectId !== 'string' || typeof config.slug !== 'string') {
    return null;
  }
  const result: ProjectConfig = {
    projectId: config.projectId,
    slug: config.slug,
  };
  if (typeof config.platformUrl === 'string') {
    result.platformUrl = normalizePlatformApiUrl(config.platformUrl);
  }
  if (typeof config.applicationDomain === 'string') {
    result.applicationDomain = normalizeApplicationDomain(config.applicationDomain);
  }
  if (typeof config.proxyUrl === 'string') {
    result.proxyUrl = normalizePlatformApiUrl(config.proxyUrl);
  }
  if (config.voidInternalStaging === true) {
    result.voidInternalStaging = true;
  }
  return result;
}

/**
 * Read the deployment platform selected during `void init`.
 *
 * Linked project files created before the platform field existed implicitly
 * target Void. A metadata-only file has no deployment preference.
 */
export function readDeploymentPlatform(root: string): DeploymentPlatform | null {
  const config = readProjectConfigFile(root);
  if (!config) {
    return null;
  }
  if (
    config.platform === 'cloudflare' ||
    config.platform === 'void' ||
    config.platform === 'none'
  ) {
    return config.platform;
  }
  if (typeof config.projectId === 'string' && typeof config.slug === 'string') {
    return 'void';
  }
  return null;
}

/**
 * Persist a deployment preference without discarding an existing Void project
 * link. Keeping the link makes switching back to Void non-destructive.
 */
export function writeDeploymentPlatform(root: string, platform: DeploymentPlatform): void {
  const filePath = join(root, PROJECT_FILE);
  const existing = readProjectConfigFile(root);
  const next: ProjectConfigFile = { platform };
  if (typeof existing?.projectId === 'string') {
    next.projectId = existing.projectId;
  }
  if (typeof existing?.platformUrl === 'string') {
    next.platformUrl = existing.platformUrl;
  }
  if (typeof existing?.applicationDomain === 'string') {
    next.applicationDomain = existing.applicationDomain;
  }
  if (typeof existing?.proxyUrl === 'string') {
    next.proxyUrl = existing.proxyUrl;
  }
  if (typeof existing?.slug === 'string') {
    next.slug = existing.slug;
  }
  if (existing?.voidInternalStaging === true) {
    next.voidInternalStaging = true;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n');
}

/** Select a verified platform without changing an existing project link. */
export function writePlatformSelection(
  root: string,
  connection: { apiUrl: string; applicationDomain: string; proxyUrl: string },
): boolean {
  const existing = readProjectConfigFile(root);
  const linked = readProjectConfig(root);
  const pinnedUrl = isVoidInternalStaging(root)
    ? VOID_CLOUD_STAGING_PLATFORM.apiUrl
    : linked
      ? (linked.platformUrl ?? VOID_CLOUD_PLATFORM.apiUrl)
      : null;
  if (pinnedUrl && pinnedUrl !== connection.apiUrl) {
    return false;
  }
  const filePath = join(root, PROJECT_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        ...existing,
        platform: 'void',
        platformUrl: normalizePlatformApiUrl(connection.apiUrl),
        applicationDomain: normalizeApplicationDomain(connection.applicationDomain),
        proxyUrl: normalizePlatformApiUrl(connection.proxyUrl),
      },
      null,
      2,
    ) + '\n',
  );
  return true;
}

/**
 * Internal-only platform developers' staging switch.
 * This intentionally lives with the project link state, not public void.json.
 */
export function isVoidInternalStaging(root: string): boolean {
  return readProjectConfigFile(root)?.voidInternalStaging === true;
}

export function readProjectPlatformUrl(root: string): string | null {
  const value = readProjectConfigFile(root)?.platformUrl;
  return typeof value === 'string' && value !== '' ? normalizePlatformApiUrl(value) : null;
}

export function readProjectApplicationDomain(root: string): string | null {
  const value = readProjectConfigFile(root)?.applicationDomain;
  return typeof value === 'string' && value !== '' ? normalizeApplicationDomain(value) : null;
}

export function readProjectProxyUrl(root: string): string | null {
  const value = readProjectConfigFile(root)?.proxyUrl;
  return typeof value === 'string' && value !== '' ? normalizePlatformApiUrl(value) : null;
}

/** Resolve the immutable platform identity that every newly linked project records. */
export function attachSelectedPlatform(
  root: string,
  config: Pick<ProjectConfig, 'projectId' | 'slug'>,
  platformApiUrl: string,
): ProjectConfig {
  const apiUrl = normalizePlatformApiUrl(platformApiUrl);
  const hosted = hostedPlatformForApiUrl(apiUrl);
  if (hosted) {
    return {
      ...config,
      applicationDomain: hosted.applicationDomain,
      platformUrl: hosted.apiUrl,
      proxyUrl: hosted.proxyUrl,
      ...(isVoidInternalStaging(root) && hosted.apiUrl === VOID_CLOUD_STAGING_PLATFORM.apiUrl
        ? { voidInternalStaging: true }
        : {}),
    };
  }
  const connection = listPlatformConnections().find((entry) => entry.apiUrl === apiUrl);
  if (connection?.applicationDomain && connection.proxyUrl) {
    return {
      ...config,
      applicationDomain: connection.applicationDomain,
      platformUrl: connection.apiUrl,
      proxyUrl: connection.proxyUrl,
    };
  }
  throw new Error(
    `platform: No verified metadata is registered for ${apiUrl}. Run \`void connect ${apiUrl}\` before linking a project.`,
  );
}

export function isLegacyVoidCloudProject(root: string): boolean {
  const config = readProjectConfigFile(root);
  return (
    typeof config?.projectId === 'string' &&
    typeof config.slug === 'string' &&
    typeof config.platformUrl !== 'string'
  );
}

export function legacyVoidCloudProjectMetadata(): Pick<
  ProjectConfig,
  'applicationDomain' | 'platformUrl' | 'proxyUrl'
> {
  return {
    applicationDomain: VOID_CLOUD_PLATFORM.applicationDomain,
    platformUrl: VOID_CLOUD_PLATFORM.apiUrl,
    proxyUrl: VOID_CLOUD_PLATFORM.proxyUrl,
  };
}

/**
 * Write the project config to the project root.
 */
export function writeProjectConfig(root: string, config: ProjectConfig): void {
  const filePath = join(root, PROJECT_FILE);
  const existing = readProjectConfigFile(root);
  const next: ProjectConfigFile = {
    platform: 'void',
    projectId: config.projectId,
    slug: config.slug,
  };
  if (config.platformUrl) {
    next.platformUrl = normalizePlatformApiUrl(config.platformUrl);
  } else if (typeof existing?.platformUrl === 'string') {
    next.platformUrl = existing.platformUrl;
  }
  if (config.applicationDomain) {
    next.applicationDomain = normalizeApplicationDomain(config.applicationDomain);
  } else if (typeof existing?.applicationDomain === 'string') {
    next.applicationDomain = existing.applicationDomain;
  }
  if (config.proxyUrl) {
    next.proxyUrl = normalizePlatformApiUrl(config.proxyUrl);
  } else if (typeof existing?.proxyUrl === 'string') {
    next.proxyUrl = existing.proxyUrl;
  }
  if (config.voidInternalStaging === true || existing?.voidInternalStaging === true) {
    next.voidInternalStaging = true;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Remove the project config file. Returns true if removed, false if it didn't exist.
 */
export function removeProjectConfig(root: string): boolean {
  const filePath = join(root, PROJECT_FILE);
  try {
    rmSync(filePath);
    return true;
  } catch {
    return false;
  }
}
