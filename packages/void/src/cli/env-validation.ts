/**
 * Shared env-schema validation for CLI commands.
 *
 * Loads the user's `env.ts` (which calls `defineEnv` as a side effect),
 * collects sources of env values (`.env*` files, remote secrets), and
 * validates each declared key against the registered schema.
 *
 * Used by both `void deploy` (hard error on missing prod env) and
 * `void env check` (CI/pre-push validation).
 */
import { join } from 'node:path';
import { findEnvFile } from '../codegen/env-types';
import { loadUserEnvFile } from '../host/load-user-env';
import { voidWarn } from '../log';
import type { EnvValidationReport } from '../runtime/env-public';
import { mergeAndExpand, parseDotenvFile } from '../shared/dotenv';
import type { PlatformClient } from './client';

interface EnvPublicModule {
  _getRegisteredSchema(): Record<string, unknown> | null;
  _hasRegisteredSchema(): boolean;
  _getSchemaDefaults(): Record<string, string>;
  validateAllEnv(values: Record<string, unknown>): Promise<EnvValidationReport>;
}

/**
 * After the user's env.ts has been imported (via `validateProdEnv` or
 * `loadSchema`), read the registered schema's `.default(value)` entries.
 * Returns `{}` if no schema was registered.
 */
export async function getDeployEnvDefaults(root: string): Promise<Record<string, string>> {
  const envFile = findEnvFile(root);
  if (!envFile) {
    return {};
  }
  const mod = await loadSchema(envFile);
  if (!mod) {
    return {};
  }
  return mod._getSchemaDefaults();
}

/** Load the registered schema by importing the user's env.ts. */
async function loadSchema(envFile: string): Promise<EnvPublicModule | null> {
  await loadUserEnvFile(envFile);
  const mod = (await import('../runtime/env-public')) as unknown as EnvPublicModule;
  if (!mod._hasRegisteredSchema()) {
    return null;
  }
  return mod;
}

export interface ValidateProdEnvOptions {
  /** When true (deploy mode), only `.env` + `.env.production` are read. */
  productionOnly: boolean;
  /** Optional remote secret list (names only). Treated as "value present". */
  remoteSecrets?: string[];
}

export interface ProdEnvValidationResult {
  hasSchema: boolean;
  report: EnvValidationReport;
}

function emptyReport(): EnvValidationReport {
  return { valid: true, missing: [], invalid: [], values: new Map() };
}

/**
 * Validate the user's env schema against the union of .env files and
 * remote secret names. Remote secrets are treated as "present" (we can't
 * fetch their values), which is sufficient for the missing-key check.
 */
export async function validateProdEnv(
  root: string,
  options: ValidateProdEnvOptions,
): Promise<ProdEnvValidationResult> {
  const envFile = findEnvFile(root);
  if (!envFile) {
    return { hasSchema: false, report: emptyReport() };
  }
  const mod = await loadSchema(envFile);
  if (!mod) {
    return { hasSchema: false, report: emptyReport() };
  }

  const files = options.productionOnly
    ? ['.env', '.env.production']
    : ['.env', '.env.local', '.env.production', '.env.production.local'];
  // Parse each file with expansion disabled, then merge + expand across the
  // union so that (e.g.) `.env.local` can reference a key declared in `.env`.
  const parsedFiles = files.map((file) => parseDotenvFile(join(root, file), { expand: false }));
  const merged: Record<string, unknown> = mergeAndExpand(parsedFiles, {
    onWarn: (msg) => voidWarn(msg),
  });
  // Treat remote secrets as present (placeholder string).
  for (const name of options.remoteSecrets ?? []) {
    if (merged[name] === undefined) {
      merged[name] = '<remote-secret>';
    }
  }

  return { hasSchema: true, report: await mod.validateAllEnv(merged) };
}

/** Format an EnvValidationReport into a human-readable multi-line string. */
export function formatEnvReport(report: EnvValidationReport): string {
  const lines: string[] = [];
  if (report.missing.length > 0) {
    lines.push('Missing required env vars:');
    for (const key of report.missing) {
      lines.push(`  • ${key}`);
    }
  }
  if (report.invalid.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Invalid env vars:');
    for (const { key, messages } of report.invalid) {
      lines.push(`  • ${key}: ${messages.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/** Convenience: fetch remote secret names from the platform. */
export async function fetchRemoteSecretNames(
  client: PlatformClient,
  projectId: string,
): Promise<string[]> {
  try {
    const secrets = await client.listSecrets(projectId);
    return secrets.map((s) => s.name);
  } catch {
    return [];
  }
}
