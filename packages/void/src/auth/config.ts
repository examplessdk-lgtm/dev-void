import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'pathe';
import type { VoidAuthConfig } from '../runtime/auth.ts';

const AUTH_CONFIG_CANDIDATES = [
  'auth.ts',
  'auth.mts',
  'auth.js',
  'auth.mjs',
  'auth.cts',
  'auth.cjs',
];

function isVoidAuthConfigSource(code: string): boolean {
  return /\bfrom\s+["']void\/auth["']/.test(code);
}

export function findVoidAuthConfig(root: string): string | null {
  for (const file of AUTH_CONFIG_CANDIDATES) {
    const absPath = join(root, file);
    if (!existsSync(absPath)) {
      continue;
    }
    const code = readFileSync(absPath, 'utf-8');
    if (isVoidAuthConfigSource(code)) {
      return absPath;
    }
  }
  return null;
}

export async function loadVoidAuthConfig(
  configPath: string | null,
): Promise<VoidAuthConfig | undefined> {
  if (!configPath) {
    return undefined;
  }
  const mod = await import(pathToFileURL(configPath).href);
  return (mod.default ?? mod.auth ?? mod.config) as VoidAuthConfig | undefined;
}
