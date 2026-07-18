import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'pathe';
import type { VoidAuthProvider } from '../auth/providers.ts';

/**
 * F5 — deriving the REQUIRED Better Auth schema means loading the app's auth config, which is
 * ARBITRARY project code (a dynamic `import()` of `auth.config.ts`, whose exported function may
 * run anything). The self-host `void deploy --backend cloudflare` orchestrator runs in the
 * credential-bearing PARENT process (CF Access service token in `process.env`), so it must NOT
 * evaluate that code in-process — exactly the reason the build spawns `vite build` / drizzle-kit
 * in a CHILD under a scrubbed env. This module IS that child for the auth schema: spawned as a
 * subprocess under the same scrubbed build env, it loads the user's auth config, resolves the
 * migration schema under the build's EFFECTIVE mode (`loadEnv(mode, envDir)`), and prints the
 * required tables/columns as JSON. The parent then applies the checked-in migrations to an
 * in-memory SQLite DB (safe — SQL, not JS) and validates. No arbitrary project code runs in the
 * parent with live creds.
 */

/** argv[2] sentinel that switches this module from library import to child-process entry. */
const PROBE_MARKER = '__void-auth-schema-probe__';

/** Input handed to the child (JSON in argv[3]). */
export type AuthSchemaProbeInput = {
  root: string;
  /** The `auth.config.ts` path (`findVoidAuthConfig`), resolved in the PARENT (file read only). */
  authConfigPath: string | null;
  dialect: 'sqlite' | 'postgresql';
  providers: Array<string> | null;
  /** The build's EFFECTIVE mode + raw root-relative envDir (from the void:env hook resolver). */
  mode: string;
  envDir: string | undefined;
};

/** The required schema the child prints (tables + their required columns). */
export type RequiredAuthSchema = Array<{ table: string; columns: Array<string> }>;

/** Minimal structural shape of a `spawnSync`-style result (injectable in tests). */
export type AuthSchemaProbeSpawnResult = {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
};

export type AuthSchemaProbeSpawn = (
  command: string,
  args: Array<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf-8' },
) => AuthSchemaProbeSpawnResult;

/**
 * PARENT side: spawn THIS module as a child (`node <self> <marker> <json>`) under the scrubbed
 * build `env`, and return the required auth schema it derived. The child inherits ONLY `env`
 * (CF Access + transport selectors already scrubbed by the caller), so the arbitrary auth-config
 * code never sees the parent's live credentials. `import.meta.url` is this module's own path — a
 * named build entry (`dist/cli/auth-schema-probe.mjs`), stable in both source and dist — so the
 * child re-enters here and hits the {@link PROBE_MARKER} branch. Throws (caller fails closed) on
 * a spawn error, a signal-kill, a nonzero exit, or unparseable output.
 */
export async function resolveRequiredAuthSchemaViaSubprocess(
  input: AuthSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: AuthSchemaProbeSpawn = spawnSync as unknown as AuthSchemaProbeSpawn,
): Promise<RequiredAuthSchema> {
  const self = fileURLToPath(import.meta.url);
  const result = spawn(process.execPath, [self, PROBE_MARKER, JSON.stringify(input)], {
    cwd: input.root,
    env,
    encoding: 'utf-8',
  });
  if (result.error) {
    throw new Error(`could not spawn the auth-schema probe: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`the auth-schema probe was killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim();
    throw new Error(detail || `the auth-schema probe exited with code ${String(result.status)}`);
  }
  let parsed: { tables?: unknown };
  try {
    parsed = JSON.parse((result.stdout ?? '').trim()) as { tables?: unknown };
  } catch {
    throw new Error('the auth-schema probe produced unparseable output.');
  }
  if (!Array.isArray(parsed.tables)) {
    throw new Error('the auth-schema probe produced no tables.');
  }
  return parsed.tables as RequiredAuthSchema;
}

/**
 * CHILD side: load the user's auth config and resolve the required Better Auth schema under the
 * build's effective mode, then print it as JSON. Uses the SAME `resolveVoidAuthMigrationSchema`
 * resolver the runtime `/__void/migrate/auth` path uses (so configured RENAMES + plugin tables
 * are included), and the SAME `loadEnv(mode, envDir)` the build's `void:env` hook uses, so an
 * env-conditioned auth config is derived exactly as the deployed worker would see it. The `id`
 * column is the implicit PRIMARY KEY (not a field), so it is prepended to each table's columns.
 * All auth imports are DYNAMIC so a plain library import of this module (by the CLI) never pulls
 * Better Auth in.
 */
async function runAuthSchemaProbeChild(rawInput: string): Promise<void> {
  const input = JSON.parse(rawInput) as AuthSchemaProbeInput;
  const [{ loadVoidAuthConfig }, { resolveVoidAuthMigrationSchema }, { loadEnv }] =
    await Promise.all([import('../auth/config.ts'), import('../auth/drizzle.ts'), import('vite')]);
  const userConfig = await loadVoidAuthConfig(input.authConfigPath);
  const envDir = input.envDir ? join(input.root, input.envDir) : input.root;
  const env = loadEnv(input.mode, envDir, '') as Record<string, unknown>;
  const schema = resolveVoidAuthMigrationSchema(
    // `providers` crosses a JSON process boundary as strings; the config layer already validated
    // them against the provider union before they were serialized.
    {
      dialect: input.dialect,
      providers: input.providers as Array<VoidAuthProvider> | null,
      userConfig,
    },
    env,
  );
  const tables: RequiredAuthSchema = schema.tables.map((table) => ({
    table: table.name,
    columns: ['id', ...Object.keys(table.fields)],
  }));
  process.stdout.write(JSON.stringify({ tables }));
}

// Child-process entry: only when invoked as `node <self> <marker> <json>`. A normal library
// import (the CLI loading the parent-side helper) has a different argv[2] (the subcommand), so
// this never runs in the parent and never eagerly loads Better Auth.
if (process.argv[2] === PROBE_MARKER) {
  runAuthSchemaProbeChild(process.argv[3] ?? 'null').then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
