import { existsSync } from 'node:fs';
import { join } from 'pathslash';
import type { FrameworkPreset } from './preset.ts';

/**
 * Resolve the top-level build output directory: the first segment of a
 * framework preset's `workerDir`, or `dist` for a Void app.
 */
export function resolveDistDir(
  root: string,
  fwPreset?: FrameworkPreset,
  buildCommand?: string,
): string {
  if (fwPreset) {
    const topDir = fwPreset.workerDir.split('/')[0];
    const distDir = join(root, topDir);
    if (!existsSync(distDir)) {
      throw new Error(
        `deploy: Build output directory '${topDir}' not found. Run '${buildCommand ?? fwPreset.buildCommand}' first.`,
      );
    }
    return distDir;
  }
  return join(root, 'dist');
}

/**
 * Resolve the worker output subdirectory within the build dir: the rest of a
 * framework preset's `workerDir`, or the first known Void output that exists.
 */
export function resolveWorkerDirName(
  distDir: string,
  fwPreset?: FrameworkPreset,
  buildCommand?: string,
): string {
  if (fwPreset) {
    const subDir = fwPreset.workerDir.split('/').slice(1).join('/');
    if (!existsSync(join(distDir, subDir))) {
      throw new Error(
        `deploy: Worker output '${fwPreset.workerDir}' not found. Run '${buildCommand ?? fwPreset.buildCommand}' first.`,
      );
    }
    return subDir;
  }

  for (const name of ['ssr', 'rsc', 'server']) {
    if (existsSync(join(distDir, name))) {
      return name;
    }
  }
  throw new Error('deploy: Worker output not found. Expected dist/ssr/ or dist/rsc/.');
}
