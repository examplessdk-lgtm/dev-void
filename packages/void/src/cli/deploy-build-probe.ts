import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PlaintextVarWarningsResult, SelfHostEnvContext } from './env-validation.ts';

/**
 * The self-host `void deploy --backend cloudflare` orchestrator must derive its
 * env CONTEXT — the effective build `{ mode, envDir }`, the plaintext-var warnings,
 * and the required-secret gate inputs — WITHOUT running any project code or any
 * project-env `loadEnv` in the credential-bearing PARENT. Resolving the Vite config
 * runs the full user plugin pipeline (arbitrary code that may schedule a timer /
 * `beforeExit` / microtask), and `loadEnv`'s sanitized overlay depends on the
 * ambient env — both leak the parent's CF Access service token if done in-process
 * (a deferred handler reads the RESTORED credentials after an ad-hoc scrub/restore;
 * `loadEnv` merges the parent's credentialed `process.env`).
 *
 * This module IS the isolated build-context probe: spawned as a subprocess under
 * the SAME scrubbed build env the real `vite build` runs with (`buildProjectEnv`),
 * it resolves the config HERE (never in the parent), enforces the v1 narrowing
 * (custom Vite `envDir` / non-`production` build mode are unsupported → REJECT),
 * and — only when accepted — derives the plaintext-var warnings + the required-
 * secret gate inputs under that scrubbed env, returning a STRUCTURED, values-free
 * result. The parent then does ONLY pure work: compare required-secret names to
 * `wrangler secret list` and apply the checked-in migrations to in-memory SQLite.
 *
 * The narrowing makes `root === envDir` and `mode === 'production'` for every
 * supported app, so the auth-schema probe (which derives under `envDir`) and the
 * build's auth generation (which derives under `root`) can never diverge.
 */

/** argv[2] sentinel that switches this module from library import to child-process entry. */
const PROBE_MARKER = '__void-deploy-build-context-probe__';

/**
 * Sentinel prefixing the child's single-line JSON result on stdout, so the parent
 * can extract it even if a config plugin logs to stdout during `resolveConfig`.
 */
const RESULT_SENTINEL = '__void-deploy-build-context-result__:';

/** Input handed to the child (JSON in argv[3]). Paths only — no env values cross here. */
export type DeployBuildContextInput = {
  root: string;
  /** Resolved root wrangler config path (the `-c` target), or null. File read only. */
  configPath: string | null;
};

/** The stable, values-free reason the schema machinery itself failed in the child. */
export type DeployBuildContextSchemaReason = 'schema-load-failed' | 'schema-validation-error';

/**
 * The structured result the child prints. `reject` fails the deploy closed
 * pre-account with clear v1-scope guidance; `schema-error` surfaces a values-free
 * env.ts/validator failure; `ok` carries the derived warnings + gate inputs.
 */
export type DeployBuildContextResult =
  | {
      kind: 'reject';
      reason: 'custom-envdir' | 'non-production-mode';
      mode: string;
      envDir: string | null;
    }
  | { kind: 'schema-error'; reason: DeployBuildContextSchemaReason }
  | {
      kind: 'ok';
      /** Always `'production'` (narrowing rejects any other mode). */
      mode: string;
      /** Plaintext worker-var warnings (key names + reason only). */
      warnings: PlaintextVarWarningsResult;
      /** Values-free required-secret gate inputs for the parent's discharge. */
      envContext: SelfHostEnvContext;
    };

/** Minimal structural shape of a `spawnSync`-style result (injectable in tests). */
export type DeployBuildContextSpawnResult = {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
};

export type DeployBuildContextSpawn = (
  command: string,
  args: Array<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf-8' },
) => DeployBuildContextSpawnResult;

/**
 * PARENT side: spawn THIS module as a child under the scrubbed build `env`
 * (`buildProjectEnv`), and return the structured build context it derived. The
 * child inherits ONLY `env` (CF Access + transport selectors already scrubbed), so
 * neither the resolved config's plugin pipeline nor `loadEnv` ever sees the
 * parent's live credentials. `import.meta.url` is this module's own path — a named
 * build entry (`dist/cli/deploy-build-probe.mjs`), stable in source and dist — so
 * the child re-enters here and hits the {@link PROBE_MARKER} branch. Throws (caller
 * fails closed) on a spawn error, a signal-kill, a nonzero exit, or missing/
 * unparseable output — exactly the cases where the real build would also fail.
 */
export async function resolveDeployBuildContextViaSubprocess(
  input: DeployBuildContextInput,
  env: NodeJS.ProcessEnv,
  spawn: DeployBuildContextSpawn = spawnSync as unknown as DeployBuildContextSpawn,
): Promise<DeployBuildContextResult> {
  const self = fileURLToPath(import.meta.url);
  const result = spawn(process.execPath, [self, PROBE_MARKER, JSON.stringify(input)], {
    cwd: input.root,
    env,
    encoding: 'utf-8',
  });
  if (result.error) {
    throw new Error(`could not spawn the build-context probe: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`the build-context probe was killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim();
    throw new Error(detail || `the build-context probe exited with code ${String(result.status)}`);
  }
  const parsed = parseProbeResult(result.stdout ?? '');
  if (!parsed) {
    throw new Error('the build-context probe produced no parseable result.');
  }
  return parsed;
}

/**
 * Extract the child's single-line JSON result from stdout: everything after the
 * LAST {@link RESULT_SENTINEL} up to the next newline (JSON.stringify emits no
 * newlines, so this survives any leading config-plugin logging). Returns undefined
 * on a missing/unparseable/ill-shaped result so the caller fails closed.
 */
function parseProbeResult(stdout: string): DeployBuildContextResult | undefined {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx === -1) {
    return undefined;
  }
  const after = stdout.slice(idx + RESULT_SENTINEL.length);
  const newlineIdx = after.indexOf('\n');
  const json = (newlineIdx === -1 ? after : after.slice(0, newlineIdx)).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    ((parsed as { kind?: unknown }).kind === 'reject' ||
      (parsed as { kind?: unknown }).kind === 'schema-error' ||
      (parsed as { kind?: unknown }).kind === 'ok')
  ) {
    return parsed as DeployBuildContextResult;
  }
  return undefined;
}

/** Write the structured result to stdout behind the sentinel, then exit 0. */
function emitResult(result: DeployBuildContextResult): void {
  process.stdout.write(`\n${RESULT_SENTINEL}${JSON.stringify(result)}\n`);
}

/**
 * CHILD side: resolve the Vite config (running the user's full plugin pipeline
 * HERE, under the scrubbed build env — never in the parent), read the effective
 * `{ mode, envDir }` the `void:env` hook OBSERVED, enforce the v1 narrowing, and —
 * only when accepted — derive the plaintext-var warnings + required-secret gate
 * inputs under this same scrubbed env. All heavy imports are DYNAMIC so a plain
 * library import of this module (by the CLI, for the parent-side helper) never
 * pulls Vite or the env-validation stack in.
 */
async function runBuildContextProbeChild(rawInput: string): Promise<void> {
  const input = JSON.parse(rawInput) as DeployBuildContextInput;
  const { resolveConfig } = await import('vite');
  // The FULL config-hook pipeline (exactly what `vite build` runs) so a top-level
  // `mode`/`envDir` a config file or plugin sets is observed — the narrowing then
  // rejects anything but root-relative `production`.
  const resolved = await resolveConfig({ root: input.root }, 'build', 'production', 'production');
  const envPlugin = resolved.plugins.find((p) => p.name === 'void:env');
  const captured = (
    envPlugin?.api as
      | {
          getVoidDeployBuildConfig?: () => { mode: string; envDir: string | undefined } | undefined;
        }
      | undefined
  )?.getVoidDeployBuildConfig?.();
  if (!captured) {
    throw new Error(
      "the build config did not expose the void:env hook's mode/envDir — is voidPlugin() in your vite.config?",
    );
  }

  // v1 narrowing (enforced HERE, inside the safe subprocess). A custom `envDir`
  // makes the build read `.env*` from a non-root dir, which the auth-schema probe
  // honours but the build's auth generation (root-relative) does not — they would
  // validate different schemas. A non-`production` build mode selects a different
  // `.env.<mode>` set than the deploy validates. Reject both; the parent turns the
  // signal into clear pre-account guidance.
  const envDir = captured.envDir && captured.envDir.length > 0 ? captured.envDir : undefined;
  if (envDir !== undefined) {
    emitResult({ kind: 'reject', reason: 'custom-envdir', mode: captured.mode, envDir });
    return;
  }
  if (captured.mode !== 'production') {
    emitResult({
      kind: 'reject',
      reason: 'non-production-mode',
      mode: captured.mode,
      envDir: null,
    });
    return;
  }

  // Accepted: `envDir === root`, `mode === 'production'`. Derive under THIS
  // process's env — which IS `buildProjectEnv`, the exact env the real `vite build`
  // runs with — so the plaintext overlay + gate map are byte-for-byte the vars the
  // build ships, never the parent's ambient/credentialed env.
  const { collectPlaintextVarWarnings, deriveSelfHostEnvContext, SelfHostSchemaError } =
    await import('./env-validation.ts');
  const configPath = input.configPath ?? undefined;
  try {
    const warnings = await collectPlaintextVarWarnings(input.root, {
      configPath,
      mode: 'production',
    });
    const envContext = await deriveSelfHostEnvContext(input.root, {
      configPath,
      mode: 'production',
    });
    emitResult({ kind: 'ok', mode: 'production', warnings, envContext });
  } catch (err) {
    // A values-free schema-machinery failure (env.ts threw, or a validator
    // threw/rejected) crosses as a structural reason — never the original message.
    if (err instanceof SelfHostSchemaError) {
      emitResult({ kind: 'schema-error', reason: err.reason });
      return;
    }
    throw err;
  }
}

// Child-process entry: only when invoked as `node <self> <marker> <json>`. A normal
// library import (the CLI loading the parent-side helper) has a different argv[2],
// so this never runs in the parent and never eagerly loads Vite / env-validation.
if (process.argv[2] === PROBE_MARKER) {
  runBuildContextProbeChild(process.argv[3] ?? 'null').then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
