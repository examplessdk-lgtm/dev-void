import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'pathe';
import type { SelfHostSchemaFacts, SelfHostSchemaFailureReason } from './env-validation.ts';

/**
 * The self-host `void deploy --backend cloudflare` orchestrator validates the REAL
 * build artifact (`dist/ssr/wrangler.json` `vars`) instead of predicting it. Two
 * pieces still need project code, and BOTH run here — in an ISOLATED SUBPROCESS —
 * because the orchestrator runs in a credential-bearing PARENT (CF Access service
 * token / `CLOUDFLARE_API_TOKEN` in `process.env`) and must NOT evaluate arbitrary
 * project code in-process:
 *
 *   1. `facts` — the env-INSENSITIVE schema facts (required-secret NAMES + the
 *      `.secret()` flags), fixed by env.ts's structure. The child ALSO resolves the
 *      Vite config here purely to read the final `{ envDir, mode }` and reject a
 *      custom `envDir` or a non-`production` build mode (v1 supports neither): the
 *      build generates the auth artifact under the project root while the worker
 *      `vars` come from the build's `envDir`, so a custom `envDir` could validate a
 *      different table set than the worker ships. Resolving the config runs the full
 *      plugin pipeline (arbitrary code, timers/`beforeExit` risk) — safe HERE in the
 *      child (which `process.exit`s), never in the credentialed parent.
 *   2. `validate-emitted` — validate the REAL emitted worker `vars` (post-build
 *      ground truth) against the schema's Standard-Schema validators and return the
 *      FAILING key NAMES only. A required var shipped with an INVALID value (fails
 *      the validator) must fail the deploy closed before any remote mutation, not
 *      only at worker boot.
 *
 * Three hardening rules apply to the child:
 *   - the framed result is written to a DEDICATED file descriptor (fd 3), NOT
 *     stdout, so anything the user's code prints while evaluating can never
 *     truncate or interleave with the result;
 *   - the caller scrubs the FULL wrangler-auth credential set from the child env
 *     (neither derivation needs credentials);
 *   - the parent NEVER captures the child's stdout/stderr — they are IGNORED
 *     (fds 1 + 2), never buffered — so a leaking env.ts / validator cannot print a
 *     raw secret to the terminal or CI log, and every failure surfaces as a stable
 *     classification only.
 */

/** argv[2] sentinel that switches this module from library import to child-process entry. */
const PROBE_MARKER = '__void-deploy-env-schema-probe__';

/** The dedicated fd the child writes its framed result to (see stdio config below). */
const RESULT_FD = 3;

/** The two operations the child can perform, selected by the parent. */
type EnvSchemaProbeOp = 'facts' | 'validate-emitted';

/** Input handed to the child (JSON in argv[3]). Path only — no env values cross here. */
export type EnvSchemaProbeInput = { root: string };

/** Full child input (adds the operation discriminant to {@link EnvSchemaProbeInput}). */
type ChildInput = { op: EnvSchemaProbeOp; root: string };

/** The reason the `facts` probe rejected the app as unsupported (values-free). */
export type EnvSchemaProbeRejectReason = 'custom-envdir' | 'non-production-mode';

/**
 * The structured result of the `facts` operation. `ok` carries the env-insensitive
 * schema facts; `reject` fails the deploy closed pre-account with clear v1-scope
 * guidance; `schema-error` surfaces a values-free env.ts/validator failure.
 *
 * `reject` crosses the process boundary as a FIXED reason CODE only — never the raw
 * resolved `mode` / `envDir` strings. Those are arbitrary Vite-config-derived values
 * (a config could set `envDir`/`mode` from any inherited secret), so echoing them
 * over fd 3 or into a parent log would break the values-free boundary; the parent
 * renders fixed guidance from the code alone.
 */
export type EnvSchemaProbeResult =
  | { kind: 'ok'; facts: SelfHostSchemaFacts }
  | { kind: 'reject'; reason: EnvSchemaProbeRejectReason }
  | { kind: 'schema-error'; reason: SelfHostSchemaFailureReason };

/**
 * The structured result of the `validate-emitted` operation. `invalid-keys` carries
 * the FAILING key NAMES only (never a value); `schema-error` surfaces a values-free
 * env.ts/validator failure.
 */
export type EnvSchemaValidateResult =
  | { kind: 'invalid-keys'; invalidKeys: Array<string> }
  | { kind: 'schema-error'; reason: SelfHostSchemaFailureReason };

/** The full union any child operation can emit — narrowed by the public wrappers. */
type EnvSchemaProbeRawResult = EnvSchemaProbeResult | EnvSchemaValidateResult;

/** Minimal structural shape of a `spawnSync`-style result (injectable in tests). */
export type EnvSchemaProbeSpawnResult = {
  status: number | null;
  /** The fd-3 buffer (the framed result) — dedicated so stdout noise can't truncate it. */
  fd3: string | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
};

export type EnvSchemaProbeSpawn = (
  command: string,
  args: Array<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => EnvSchemaProbeSpawnResult;

/**
 * Default spawner: run THIS module as a child and read ONLY the dedicated fd-3
 * result. stdin is ignored, stdout/stderr are IGNORED (fds 1 + 2) so a broken /
 * leaking env.ts can never print a raw secret to the terminal or a captured CI log,
 * and fd 3 is a pipe carrying the framed JSON result. `spawnSync`'s `output` array
 * is indexed by fd, so `output[3]` is the result channel — isolated from stdout
 * entirely (and unaffected by ignoring fds 1 + 2).
 */
const defaultSpawn: EnvSchemaProbeSpawn = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    encoding: 'utf-8',
  });
  const fd3 = result.output?.[RESULT_FD];
  return {
    status: result.status,
    fd3: typeof fd3 === 'string' ? fd3 : fd3 == null ? null : String(fd3),
    error: result.error ?? null,
    signal: result.signal ?? null,
  };
};

/**
 * Spawn THIS module as a child (`node <self> <marker> <json>`) under the scrubbed
 * `env` for one operation, and return its framed fd-3 result. The child inherits
 * ONLY `env` (the caller scrubs the full wrangler-auth credential set), so the
 * arbitrary project code never sees the parent's credentials. `import.meta.url` is
 * this module's own path — a named build entry (`dist/cli/env-schema-probe.mjs`),
 * stable in source and dist — so the child re-enters here and hits the {@link
 * PROBE_MARKER} branch. Throws (caller fails closed) on a spawn error, a signal-kill,
 * a nonzero exit, or a missing/unparseable result — exactly the cases where the
 * project code itself could not be evaluated. NEVER echoes the child's
 * stdout/stderr (never captured), so no env value the child may have printed can
 * reach the thrown error.
 */
async function spawnEnvSchemaProbe(
  op: EnvSchemaProbeOp,
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn,
): Promise<EnvSchemaProbeRawResult> {
  const childInput: ChildInput = { op, root: input.root };
  const self = fileURLToPath(import.meta.url);
  const result = spawn(process.execPath, [self, PROBE_MARKER, JSON.stringify(childInput)], {
    cwd: input.root,
    env,
  });
  if (result.error) {
    throw new Error(`could not spawn the env-schema probe: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`the env-schema probe was killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    // The child's stdout/stderr is never captured, so there is nothing to echo —
    // only the stable exit code (no env value can ride along).
    throw new Error(`the env-schema probe exited with code ${String(result.status)}.`);
  }
  const parsed = parseProbeResult(result.fd3 ?? '');
  if (!parsed) {
    throw new Error('the env-schema probe produced no parseable result.');
  }
  return parsed;
}

/**
 * PARENT side (`facts`): return the env-insensitive schema facts + the v1 envDir/mode
 * narrowing. Runs pre-build so a custom envDir / non-production mode / broken env.ts
 * fails fast, before any account op.
 */
export async function resolveEnvSchemaFactsViaSubprocess(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn = defaultSpawn,
): Promise<EnvSchemaProbeResult> {
  const result = await spawnEnvSchemaProbe('facts', input, env, spawn);
  if (result.kind === 'invalid-keys') {
    // The `facts` operation never emits invalid-keys; treat it as an infra fault.
    throw new Error('the env-schema probe returned an unexpected result for the facts operation.');
  }
  return result;
}

/**
 * PARENT side (`validate-emitted`): validate the REAL emitted worker `vars` against
 * the schema validators and return the FAILING key NAMES only. Runs post-build so
 * the values validated are exactly what the worker ships.
 */
export async function validateEmittedVarsViaSubprocess(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn = defaultSpawn,
): Promise<EnvSchemaValidateResult> {
  const result = await spawnEnvSchemaProbe('validate-emitted', input, env, spawn);
  if (result.kind === 'ok' || result.kind === 'reject') {
    // The `validate-emitted` operation never emits ok/reject; treat it as infra.
    throw new Error(
      'the env-schema probe returned an unexpected result for the validate-emitted operation.',
    );
  }
  return result;
}

/**
 * Parse the child's framed result from the DEDICATED fd-3 channel. The whole buffer
 * is the JSON result (nothing else writes to fd 3), so no sentinel scan is needed —
 * that is the truncation fix: config/env.ts stdout noise lives on a different fd and
 * can never reach here. Returns undefined on a missing/unparseable/ill-shaped result
 * so the caller fails closed.
 */
function parseProbeResult(fd3: string): EnvSchemaProbeRawResult | undefined {
  const trimmed = fd3.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as {
    kind?: unknown;
    facts?: unknown;
    reason?: unknown;
    invalidKeys?: unknown;
  };
  if (record.kind === 'ok' && isSchemaFacts(record.facts)) {
    return { kind: 'ok', facts: record.facts };
  }
  if (
    record.kind === 'reject' &&
    (record.reason === 'custom-envdir' || record.reason === 'non-production-mode')
  ) {
    return { kind: 'reject', reason: record.reason };
  }
  if (
    record.kind === 'invalid-keys' &&
    Array.isArray(record.invalidKeys) &&
    record.invalidKeys.every((k) => typeof k === 'string')
  ) {
    return { kind: 'invalid-keys', invalidKeys: record.invalidKeys };
  }
  if (
    record.kind === 'schema-error' &&
    (record.reason === 'schema-load-failed' || record.reason === 'schema-validation-error')
  ) {
    return { kind: 'schema-error', reason: record.reason };
  }
  return undefined;
}

/** Structural guard for the values-free facts the child returns. */
function isSchemaFacts(value: unknown): value is SelfHostSchemaFacts {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const f = value as { hasSchema?: unknown; requiredKeys?: unknown; secretKeys?: unknown };
  return (
    typeof f.hasSchema === 'boolean' &&
    Array.isArray(f.requiredKeys) &&
    f.requiredKeys.every((k) => typeof k === 'string') &&
    Array.isArray(f.secretKeys) &&
    f.secretKeys.every((k) => typeof k === 'string')
  );
}

/** Write the framed result to the dedicated fd 3 (synchronous → flushed before exit). */
function emitResult(result: EnvSchemaProbeRawResult): void {
  writeSync(RESULT_FD, JSON.stringify(result));
}

/**
 * Read the RAW (root-relative, unnormalized) envDir the build's worker-vars loader
 * actually uses, straight from the `void:env` config hook's captured value (exposed on
 * that plugin's `api.getVoidDeployBuildConfig`). This is the only faithful input to the
 * build's OWN `join(root, rawEnvDir)` computation: Vite's `resolved.envDir` is already
 * normalized (`path.resolve`), which loses the distinction an absolute-root envDir needs.
 * Returns `undefined` when the hook is absent (a non-void config), which the caller
 * treats as "no custom raw envDir" and falls back to Vite's normalized view.
 */
function readBuildRawEnvDir(
  plugins: ReadonlyArray<{ name: string; api?: unknown }>,
): string | undefined {
  const plugin = plugins.find((p) => p.name === 'void:env');
  const api = plugin?.api as
    | { getVoidDeployBuildConfig?: () => { mode: string; envDir: string | undefined } | undefined }
    | undefined;
  return api?.getVoidDeployBuildConfig?.()?.envDir;
}

/**
 * CHILD side (`facts`): resolve the Vite config HERE (the FULL plugin pipeline the
 * real `vite build` runs, under the scrubbed env — never in the parent) purely to
 * read the effective `{ envDir, mode }` and reject a custom envDir / non-production
 * mode; then, when accepted, import the user's env.ts and derive the env-insensitive
 * schema facts. All heavy imports are DYNAMIC so a plain library import of this
 * module (by the CLI, for the parent-side helper) never pulls Vite / env-validation /
 * the user's env.ts in.
 */
async function runFactsChild(root: string): Promise<void> {
  const { resolveConfig } = await import('vite');
  // The FULL config-hook pipeline (exactly what `vite build` runs) so a top-level
  // `mode`/`envDir` a config file or plugin sets is observed. `resolved.envDir` is
  // `false` (env loading disabled) or the absolute normalized dir; the default
  // equals `resolved.root`.
  const resolved = await resolveConfig({ root }, 'build', 'production', 'production');
  // Reject a custom envDir by the SAME computation the BUILD uses. Vite normalizes
  // `resolved.envDir` via `path.resolve(root, envDir)` (absolute-safe), so an ABSOLUTE
  // envDir equal to the project root collapses to `resolved.root` and would ACCEPT — but
  // the build's worker-vars loader (`index.ts`) uses `join(root, rawEnvDir)`, and
  // `join(root, <absolute root>)` DUPLICATES the path (`/proj/proj`), so the build loads
  // `vars` from the WRONG dir while the auth artifact is generated under the root: the
  // exact vars-vs-auth divergence this guard exists to reject. So derive the build's
  // ACTUAL vars dir from the RAW envDir the `void:env` hook captured and reject unless it
  // equals the root — unset / `'.'` → root → accept; a relative subdir → non-root →
  // reject; an absolute-root → `join` duplicates → non-root → reject. Also keep rejecting
  // Vite's own `envDir === false` (env loading disabled) and its normalized-non-root view
  // (a robust fallback that still catches a custom subdir if the `void:env` hook is absent).
  // NOTE: `index.ts` uses `join` (not Vite's `resolve`) for the raw envDir, so the build
  // itself mishandles an absolute envDir; this guard fails such configs CLOSED here.
  // Switching `index.ts` `join`→`resolve` is a separate build-side follow-up (not done here).
  const rawEnvDir = readBuildRawEnvDir(resolved.plugins);
  const buildVarsDir = rawEnvDir ? join(resolved.root, rawEnvDir) : resolved.root;
  if (
    resolved.envDir === false ||
    resolved.envDir !== resolved.root ||
    buildVarsDir !== resolved.root
  ) {
    // v1 supports only a root-relative envDir. Only the fixed reason code crosses the
    // boundary (never the raw envDir string).
    emitResult({ kind: 'reject', reason: 'custom-envdir' });
    return;
  }
  if (resolved.mode !== 'production') {
    // A non-production build mode selects a different `.env.<mode>` set than the
    // deploy validates — v1 supports only the production build. Fixed reason code only.
    emitResult({ kind: 'reject', reason: 'non-production-mode' });
    return;
  }

  const { deriveSelfHostSchemaFacts, SelfHostSchemaError } = await import('./env-validation.ts');
  try {
    const facts = await deriveSelfHostSchemaFacts(root);
    emitResult({ kind: 'ok', facts });
  } catch (err) {
    if (err instanceof SelfHostSchemaError) {
      emitResult({ kind: 'schema-error', reason: err.reason });
      return;
    }
    throw err;
  }
}

/**
 * CHILD side (`validate-emitted`): read the REAL emitted worker `vars` the build
 * baked into `dist/ssr/wrangler.json` (ground truth), validate them against the
 * schema's validators, and emit the FAILING key NAMES only. The parent already
 * confirmed the artifact exists, so a read failure here is a probe-infrastructure
 * fault → fail closed as a values-free schema error.
 */
async function runValidateEmittedChild(root: string): Promise<void> {
  const { computeInvalidEmittedKeys, readEmittedWorkerVars, SelfHostSchemaError } =
    await import('./env-validation.ts');
  const emitted = readEmittedWorkerVars(root);
  if (!emitted.ok) {
    emitResult({ kind: 'schema-error', reason: 'schema-load-failed' });
    return;
  }
  try {
    const invalidKeys = await computeInvalidEmittedKeys(root, emitted.vars);
    emitResult({ kind: 'invalid-keys', invalidKeys });
  } catch (err) {
    if (err instanceof SelfHostSchemaError) {
      emitResult({ kind: 'schema-error', reason: err.reason });
      return;
    }
    throw err;
  }
}

/** Dispatch the child to the requested operation. */
async function runEnvSchemaProbeChild(rawInput: string): Promise<void> {
  const input = JSON.parse(rawInput) as ChildInput;
  if (input.op === 'validate-emitted') {
    await runValidateEmittedChild(input.root);
    return;
  }
  await runFactsChild(input.root);
}

// Child-process entry: only when invoked as `node <self> <marker> <json>`. A normal
// library import (the CLI loading the parent-side helper) has a different argv[2], so
// this never runs in the parent and never eagerly loads Vite / env-validation / env.ts.
// On ANY unexpected failure the child exits nonzero with NO raw echo — the parent
// fails closed on the exit code alone.
if (process.argv[2] === PROBE_MARKER) {
  runEnvSchemaProbeChild(process.argv[3] ?? 'null').then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
