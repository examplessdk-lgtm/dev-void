import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'pathslash';
import type { DeployTarget } from './types.ts';

export type ProjectConfig = {
  projectId: string;
  slug: string;
  voidInternalStaging?: boolean;
};

export type DeploymentPlatform = DeployTarget | 'none';

const PROJECT_FILE = '.void/project.json';

type ProjectConfigFile = {
  platform?: unknown;
  projectId?: unknown;
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
  if (typeof existing?.slug === 'string') {
    next.slug = existing.slug;
  }
  if (existing?.voidInternalStaging === true) {
    next.voidInternalStaging = true;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Internal-only platform developers' staging switch.
 * This intentionally lives with the project link state, not public void.json.
 */
export function isVoidInternalStaging(root: string): boolean {
  return readProjectConfigFile(root)?.voidInternalStaging === true;
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
