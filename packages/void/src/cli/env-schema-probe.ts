import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findEnvFile } from '../codegen/env-types.ts';
import type { SelfHostSchemaFacts, SelfHostSchemaFailureReason } from './env-validation.ts';

/**
 * The self-host `void deploy --platform cloudflare` orchestrator validates the REAL
 * build artifact (`dist/ssr/wrangler.json` `vars`) instead of predicting it. Two
 * pieces still need project code, and BOTH run here — in an ISOLATED SUBPROCESS —
 * because the orchestrator runs in a credential-bearing PARENT (CF Access service
 * token / `CLOUDFLARE_API_TOKEN` in `process.env`) and must NOT evaluate arbitrary
 * project code in-process:
 *
 *   1. `facts` — the env-INSENSITIVE server and required key names, fixed by
 *      env.ts's structure.
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

/**
 * The structured result of the `facts` operation. `ok` carries the env-insensitive
 * schema facts; `schema-error` surfaces a values-free env.ts/validator failure.
 */
export type EnvSchemaProbeResult =
  | { kind: 'ok'; facts: SelfHostSchemaFacts }
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
 * PARENT side (`facts`): return the env-insensitive schema facts. Runs pre-build so
 * a broken env.ts fails fast, before any account operation.
 */
export async function resolveEnvSchemaFactsViaSubprocess(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn = defaultSpawn,
): Promise<EnvSchemaProbeResult> {
  // File discovery executes no project code. An absent schema has no validators
  // to isolate; use the same resolver as the child, including sourceDir/extensions.
  if (findEnvFile(input.root) === null) {
    return { kind: 'ok', facts: { hasSchema: false, serverKeys: [], requiredKeys: [] } };
  }
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
  if (result.kind === 'ok') {
    // The `validate-emitted` operation never emits ok; treat it as infra.
    throw new Error(
      'the env-schema probe returned an unexpected result for the validate-emitted operation.',
    );
  }
  return result;
}

/**
 * Parse the child's framed result from the DEDICATED fd-3 channel. The whole buffer
 * is the JSON result (nothing else writes to fd 3), so no sentinel scan is needed:
 * config/env.ts stdout noise lives on a different fd and can never reach here. Returns undefined on a missing/unparseable/ill-shaped result
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
  const f = value as { hasSchema?: unknown; serverKeys?: unknown; requiredKeys?: unknown };
  return (
    typeof f.hasSchema === 'boolean' &&
    Array.isArray(f.requiredKeys) &&
    f.requiredKeys.every((k) => typeof k === 'string') &&
    Array.isArray(f.serverKeys) &&
    f.serverKeys.every((k) => typeof k === 'string')
  );
}

/** Write the framed result to the dedicated fd 3 (synchronous → flushed before exit). */
function emitResult(result: EnvSchemaProbeRawResult): void {
  writeSync(RESULT_FD, JSON.stringify(result));
}

/**
 * CHILD side (`facts`): import the user's env.ts and derive its structural schema
 * facts. The import stays isolated because env.ts is arbitrary project code.
 */
async function runFactsChild(root: string): Promise<void> {
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
