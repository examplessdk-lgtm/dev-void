import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SelfHostSchemaFacts, SelfHostSchemaFailureReason } from './env-validation.ts';

/**
 * The self-host `void deploy --backend cloudflare` orchestrator validates the REAL
 * build artifact (`dist/ssr/wrangler.json` `vars`) instead of predicting it. The one
 * thing it still needs from project code is the env-INSENSITIVE schema facts — the
 * required-secret NAMES and the `.secret()` flags — which are fixed by env.ts's
 * structure and do NOT depend on which `.env` file the build reads. Deriving them
 * means importing env.ts (arbitrary project code), and the orchestrator runs in a
 * credential-bearing PARENT (CF Access service token / `CLOUDFLARE_API_TOKEN` in
 * `process.env`), so it must NOT evaluate that code in-process.
 *
 * This module IS that isolated subprocess. It is DELIBERATELY minimal: it does NOT
 * resolve the Vite config (no plugin pipeline, no timers/`beforeExit` risk) and it
 * does NOT run `loadEnv` — it only imports env.ts and reads the schema's structural
 * facts. Because those facts are env-insensitive, the old probe-vs-build divergence
 * class is gone by construction.
 *
 * Three hardening rules:
 *   - the framed result is written to a DEDICATED file descriptor (fd 3), NOT
 *     stdout, so anything the user's env.ts prints while evaluating can never
 *     truncate or interleave with the result;
 *   - the caller scrubs `CLOUDFLARE_API_TOKEN` + CF Access from the child env (this
 *     derivation needs no credentials);
 *   - the parent NEVER captures or echoes the child's stdout/stderr (they are
 *     inherited, never buffered) — every failure surfaces as a stable classification
 *     only, so no env value the child may have printed can reach a logged error.
 */

/** argv[2] sentinel that switches this module from library import to child-process entry. */
const PROBE_MARKER = '__void-deploy-env-schema-probe__';

/** The dedicated fd the child writes its framed result to (see stdio config below). */
const RESULT_FD = 3;

/** Input handed to the child (JSON in argv[3]). Path only — no env values cross here. */
export type EnvSchemaProbeInput = { root: string };

/**
 * The structured result the child prints. `ok` carries the env-insensitive schema
 * facts; `schema-error` surfaces a values-free env.ts/validator failure.
 */
export type EnvSchemaProbeResult =
  | { kind: 'ok'; facts: SelfHostSchemaFacts }
  | { kind: 'schema-error'; reason: SelfHostSchemaFailureReason };

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
 * result. stdin is ignored, stdout/stderr are INHERITED (a broken env.ts shows its
 * own diagnostic to the user's terminal) but never captured by the parent, and fd 3
 * is a pipe carrying the framed JSON result. `spawnSync`'s `output` array is indexed
 * by fd, so `output[3]` is the result channel — isolated from stdout entirely.
 */
const defaultSpawn: EnvSchemaProbeSpawn = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
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
 * PARENT side: spawn THIS module as a child (`node <self> <marker> <json>`) under
 * the scrubbed `env`, and return the env-insensitive schema facts it derived. The
 * child inherits ONLY `env` (the caller scrubs `CLOUDFLARE_API_TOKEN` + CF Access),
 * so the arbitrary env.ts code never sees the parent's credentials. `import.meta.url`
 * is this module's own path — a named build entry (`dist/cli/env-schema-probe.mjs`),
 * stable in source and dist — so the child re-enters here and hits the {@link
 * PROBE_MARKER} branch. Throws (caller fails closed) on a spawn error, a signal-kill,
 * a nonzero exit, or a missing/unparseable result — exactly the cases where env.ts
 * itself could not be evaluated. NEVER echoes the child's stdout/stderr (never
 * captured), so no env value the child may have printed can reach the thrown error.
 */
export async function resolveEnvSchemaFactsViaSubprocess(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn = defaultSpawn,
): Promise<EnvSchemaProbeResult> {
  const self = fileURLToPath(import.meta.url);
  const result = spawn(process.execPath, [self, PROBE_MARKER, JSON.stringify(input)], {
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
 * Parse the child's framed result from the DEDICATED fd-3 channel. The whole buffer
 * is the JSON result (nothing else writes to fd 3), so no sentinel scan is needed —
 * that is the truncation fix: config/env.ts stdout noise lives on a different fd and
 * can never reach here. Returns undefined on a missing/unparseable/ill-shaped result
 * so the caller fails closed.
 */
function parseProbeResult(fd3: string): EnvSchemaProbeResult | undefined {
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
  const record = parsed as { kind?: unknown; facts?: unknown; reason?: unknown };
  if (record.kind === 'ok' && isSchemaFacts(record.facts)) {
    return { kind: 'ok', facts: record.facts };
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
function emitResult(result: EnvSchemaProbeResult): void {
  writeSync(RESULT_FD, JSON.stringify(result));
}

/**
 * CHILD side: import the user's env.ts and derive the env-insensitive schema facts,
 * then write them to fd 3. All heavy imports are DYNAMIC so a plain library import of
 * this module (by the CLI, for the parent-side helper) never pulls env-validation /
 * the user's env.ts in. `deriveSelfHostSchemaFacts` already runs behind the
 * values-free schema boundary, so any schema-machinery failure is a values-free
 * {@link SelfHostSchemaError} → emitted as a `schema-error` reason. Any OTHER throw
 * (a probe-infrastructure bug) rethrows to the entry handler, which exits nonzero
 * WITHOUT echoing anything.
 */
async function runEnvSchemaProbeChild(rawInput: string): Promise<void> {
  const input = JSON.parse(rawInput) as EnvSchemaProbeInput;
  const { deriveSelfHostSchemaFacts, SelfHostSchemaError } = await import('./env-validation.ts');
  try {
    const facts = await deriveSelfHostSchemaFacts(input.root);
    emitResult({ kind: 'ok', facts });
  } catch (err) {
    if (err instanceof SelfHostSchemaError) {
      emitResult({ kind: 'schema-error', reason: err.reason });
      return;
    }
    throw err;
  }
}

// Child-process entry: only when invoked as `node <self> <marker> <json>`. A normal
// library import (the CLI loading the parent-side helper) has a different argv[2], so
// this never runs in the parent and never eagerly loads env-validation / env.ts. On
// ANY unexpected failure the child exits nonzero with NO raw echo — the parent fails
// closed on the exit code alone.
if (process.argv[2] === PROBE_MARKER) {
  runEnvSchemaProbeChild(process.argv[3] ?? 'null').then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
