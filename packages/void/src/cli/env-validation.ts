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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { join } from 'pathe';
import { findEnvFile } from '../codegen/env-types.ts';
import { loadUserEnvFile } from '../host/load-user-env.ts';
import { voidWarn } from '../log.ts';
import { getSecretOverride } from '../runtime/env-helpers.ts';
import type { EnvValidationReport } from '../runtime/env-public.ts';
import { mergeAndExpand, parseDotenvFile } from '../shared/dotenv.ts';
import { isLikelySecretKey } from '../shared/env-mask.ts';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import type { PlatformClient } from './client.ts';
import { resolveWranglerArgv } from './preset.ts';

type EnvPublicModule = {
  _getRegisteredSchema(): Record<string, unknown> | null;
  _hasRegisteredSchema(): boolean;
  _getSchemaDefaults(): Record<string, string>;
  validateAllEnv(values: Record<string, unknown>): Promise<EnvValidationReport>;
};

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
  const mod = (await import('../runtime/env-public.ts')) as unknown as EnvPublicModule;
  if (!mod._hasRegisteredSchema()) {
    return null;
  }
  return mod;
}

export type ValidateProdEnvOptions = {
  /** When true (deploy mode), only `.env` + `.env.production` are read. */
  productionOnly: boolean;
  /** Optional remote secret list (names only). Treated as "value present". */
  remoteSecrets?: Array<string>;
};

export type ProdEnvValidationResult = {
  hasSchema: boolean;
  report: EnvValidationReport;
};

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

  const report = await mod.validateAllEnv(merged);
  // Remote secrets are present on the deployed worker but not readable here,
  // so we can't run the user's validator against the real value. Treat any
  // schema key that is only "missing locally" but "present remotely" as OK —
  // the boot-time `_validateEnvOnce` will validate the real value per isolate.
  const remoteSet = new Set(options.remoteSecrets ?? []);
  if (remoteSet.size > 0 && report.missing.length > 0) {
    report.missing = report.missing.filter((key) => !remoteSet.has(key));
    if (report.missing.length === 0 && report.invalid.length === 0) {
      report.valid = true;
    }
  }
  return { hasSchema: true, report };
}

/** Format an EnvValidationReport into a human-readable multi-line string. */
export function formatEnvReport(report: EnvValidationReport): string {
  const lines: Array<string> = [];
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
): Promise<Array<string>> {
  try {
    const secrets = await client.listSecrets(projectId);
    return secrets.map((s) => s.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Self-host (`void deploy --backend cloudflare`) secrets preflight units.
//
// The managed platform path gates secrets via `assertEnvSchemaValid` (deploy.ts)
// against the platform's secret store. The self-host path bypasses the platform
// entirely, so it needs its own safety units over the REAL build artifact
// (`dist/ssr/wrangler.json` `vars`), defined further below:
//   1. `collectPlaintextVarWarningsFromVars` — WARN: the build bakes worker
//      `vars` verbatim into the uploaded config (plaintext); report which of the
//      emitted keys look like secrets so the caller can warn.
//   2. `deriveSelfHostEnvContextFromVars` + `dischargeSelfHostEnvContext` — GATE:
//      the platform-free analogue of `assertEnvSchemaValid`, sourcing remote
//      secret names from `wrangler secret list` instead of the platform API.
// Both consume ground truth (the emitted map), never a pre-build facsimile.
// ---------------------------------------------------------------------------

/** One worker-vars key that looks like a secret, with why it was flagged. */
export type PlaintextVarWarning = {
  key: string;
  /**
   * `schema-secret` — the user's env.ts flags this key `.secret()` (explicit,
   * always wins). `heuristic` — the key NAME matches the shared
   * `isLikelySecretKey` credential heuristic (`KEY|TOKEN|SECRET|…`). An explicit
   * `.public()` does NOT suppress the heuristic here (it only means "not a
   * schema secret"): the value still ships as PLAINTEXT in the worker config,
   * so a secret-looking public key is still worth flagging.
   */
  reason: 'schema-secret' | 'heuristic';
};

/**
 * Result of {@link collectPlaintextVarWarningsFromVars}. Carries KEY NAMES ONLY —
 * never values — so nothing here can leak a secret into logs, no matter how
 * the caller formats it.
 */
export type PlaintextVarWarningsResult = {
  /** Secret-looking keys the build will bake into worker `vars`, sorted by key. */
  secretKeys: Array<PlaintextVarWarning>;
  /** Total number of keys the build will merge into worker `vars`. */
  totalVarKeys: number;
};

/** Minimal structural view of a Standard Schema validator's probe entrypoint. */
type SchemaProbe = StandardSchemaV1<unknown, unknown>['~standard'];

/**
 * The required-key set, derived independently of how any validator treats
 * the empty string. A key is required iff its validator REJECTS the ABSENT
 * value (probe with `undefined`) — the SAME notion of "required" the managed
 * gate uses (a key lands in `validateAllEnv().missing` when its absent value
 * yields issues; `_getSchemaDefaults` probes `undefined` the exact same way).
 * Requiredness is NEVER inferred from whether `""` validates, so a schema that
 * ACCEPTS `""` (e.g. a bare Zod `z.string()`) is still correctly required.
 *
 * Runs the user's validators (arbitrary code), so callers MUST invoke this
 * inside {@link withSchemaBoundary}: a validator that THROWS synchronously or
 * REJECTS (async) on the probe surfaces as a values-free structural error, and
 * the awaited async probe can never float as an unhandled rejection carrying a
 * value. A NORMAL rejection (an `{ issues }` Result, not a thrown/rejected
 * error) simply marks the key required.
 */
async function requiredSchemaKeys(schema: Record<string, unknown>): Promise<Set<string>> {
  const required = new Set<string>();
  for (const [key, validator] of Object.entries(schema)) {
    const probe = (validator as { '~standard': SchemaProbe })['~standard'];
    const resultMaybe = probe.validate(undefined);
    const result = resultMaybe instanceof Promise ? await resultMaybe : resultMaybe;
    if ((result as { issues?: unknown }).issues) {
      required.add(key);
    }
  }
  return required;
}

/**
 * The values-free provenance of a var's WINNING value. The self-host gate reads
 * ground truth — the REAL worker `vars` the build emitted into
 * `dist/ssr/wrangler.json` — so every present key's source is `emitted`. Only the
 * KIND is ever surfaced (never a value), so a configured-empty error can name the
 * source without echoing anything sensitive.
 */
export type VarSource = { kind: 'emitted' };

/**
 * Result of one `wrangler secret list` invocation. Same structured-provenance
 * contract as the provisioner's `RunWranglerResult` (cli/provision.ts): a
 * non-null `signal` or a present `error` means the child did NOT run to
 * completion, so its buffered output is unreliable and must NEVER be read as
 * "no secrets exist" — only `status === 0` with clean provenance may be parsed.
 */
export type SecretListRunResult = {
  stdout: string;
  stderr: string;
  status: number;
  /** Non-null ONLY when the child was terminated by a signal — a HARD failure. */
  signal?: NodeJS.Signals | null;
  /** The spawn-error message when the child could not start — a HARD failure. */
  error?: string | null;
};

/**
 * Injectable seam over spawning `wrangler secret list` — same pattern as the
 * provisioner's `RunWrangler`. The default ({@link createDefaultSecretListRunner})
 * spawns the real wrangler CLI; unit tests inject a stub so no real wrangler
 * and no network runs. Sync stubs are fine — the caller `Promise.resolve`s.
 */
export type RunSecretList = (
  args: Array<string>,
) => SecretListRunResult | Promise<SecretListRunResult>;

/**
 * The stable, values-free classification of a hard secret-list failure.
 * The child inherits `process.env`, so a wrangler/OS/config diagnostic can
 * embed an env value; the raw rejection/stderr/stdout text is therefore used
 * only INTERNALLY (worker-not-found classification) and NEVER copied into a
 * thrown error. Every {@link SelfHostSecretListError} instead carries one of
 * these codes plus safe scalars (exit code / signal name), so neither the
 * message, the attached fields, nor the JSON serialization can echo a value.
 *   - `spawn-error`      — the child could not be launched (runner threw, or
 *                          reported a spawn `error`).
 *   - `nonzero-exit`     — clean nonzero exit (wrangler's own error).
 *   - `signal`           — terminated by a signal (includes the timeout SIGKILL).
 *   - `malformed-output` — exit 0 but stdout was not the expected JSON array of
 *                          `{ name }` secret objects.
 *   - `account-mismatch` — config-vs-requested account gate (thrown before any
 *                          spawn; its message names the account IDs, which are
 *                          caller/config identifiers, not wrangler output).
 */
export type SecretListFailureReason =
  | 'spawn-error'
  | 'nonzero-exit'
  | 'signal'
  | 'malformed-output'
  | 'account-mismatch';

/** Wrangler-run failure reasons (excludes the pre-spawn `account-mismatch`). */
type SecretListRunFailureReason = Exclude<SecretListFailureReason, 'account-mismatch'>;

/** Safe scalars attached to a {@link SelfHostSecretListError} — never wrangler output. */
export type SecretListFailureDetail = {
  /** The child's exit code, when it exited (nonzero-exit). */
  exitCode?: number;
  /** The terminating signal name, when killed (signal). */
  signal?: string;
};

/**
 * Hard failure fetching the remote secret list (spawn error, signal, nonzero
 * exit, timeout, or malformed output). DISTINCT from
 * {@link SelfHostEnvValidationError}: this means "we could not learn what
 * secrets exist" (fail closed), never "a required secret is missing".
 *
 * The message and attached fields are values-free by construction: only
 * the structural {@link SecretListFailureReason} code and safe scalars
 * ({@link SecretListFailureDetail}) are exposed. Raw wrangler output (stderr,
 * stdout, rejection/spawn-error text) is NEVER stored here, so no env value the
 * child may have echoed can reach `Error.message`, the `reason`/`detail`
 * fields, or their JSON serialization — even under `VOID_ENV_UNMASK`.
 */
export class SelfHostSecretListError extends Error {
  override name = 'SelfHostSecretListError';
  /** Stable, values-free failure classification. */
  readonly reason: SecretListFailureReason;
  /** Safe scalars (exit code / signal name) — never contain wrangler output. */
  readonly detail: SecretListFailureDetail;
  // Explicit fields (not TS parameter properties) so this module type-strips under
  // plain Node — the build-context probe imports it in a subprocess.
  constructor(
    message: string,
    reason: SecretListFailureReason,
    detail: SecretListFailureDetail = {},
  ) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * FIRST-DEPLOY specialization of {@link SelfHostSecretListError}: the remote
 * secret list could not be fetched because the worker has NOT been deployed
 * yet. wrangler 4.107's `secret list` catches the API worker-not-found error
 * (codes 10007 / 10090 — `WORKER_NOT_FOUND` / `WORKER_LEGACY_ENVIRONMENT_NOT_FOUND`,
 * per `isWorkerNotFoundError` in wrangler-dist/cli.js) and rethrows a `UserError`
 * ("… not found. If this is a new Worker, run `wrangler deploy` first to create
 * it."), exiting nonzero. Rather than surface that circular "deploy first" dead
 * end, this carries the still-unsatisfied required key NAMES plus a
 * worker-not-found flag so the deploy orchestrator can render actionable
 * `wrangler secret put <NAME>` bootstrap guidance (wrangler can `secret put` to
 * a draft worker). Still a HARD, fail-closed error — subclassing keeps existing
 * `instanceof SelfHostSecretListError` fail-closed handling intact.
 */
export class SelfHostFirstDeployError extends SelfHostSecretListError {
  override name = 'SelfHostFirstDeployError';
  /** Always true — distinguishes this from a generic list failure structurally. */
  readonly workerNotFound = true;
  /** Required schema key NAMES still unsatisfied locally (values-free). */
  readonly missingKeys: Array<string>;
  constructor(message: string, missingKeys: Array<string>, exitCode?: number) {
    // Structurally still a nonzero-exit; `message` is the values-free
    // first-deploy guidance and `missingKeys` carries the names.
    super(message, 'nonzero-exit', { exitCode });
    this.missingKeys = missingKeys;
  }
}

/**
 * The env schema is not satisfied for a self-host production deploy: required
 * keys are missing (not in `.env`/`.env.production` and not present as remote
 * worker secrets), local values are invalid, or an EMPTY local assignment would
 * shadow a remote secret. The message and the attached `report` carry the
 * offending key NAMES plus stable, values-free reason codes only — never raw
 * input, never resolved values — so nothing on this path can echo a secret
 * (see {@link selfHostEnvError}), even under `VOID_ENV_UNMASK`.
 */
export class SelfHostEnvValidationError extends Error {
  override name = 'SelfHostEnvValidationError';
  readonly report: EnvValidationReport;
  constructor(message: string, report: EnvValidationReport) {
    super(message);
    this.report = report;
  }
}

/**
 * The stable, values-free classification of a self-host schema failure.
 * env.ts evaluation and Standard-Schema validators run ARBITRARY user code that
 * can embed an env value in a thrown/rejected error (its `message`, `stack`, or
 * `cause`), and `VOID_ENV_UNMASK` disables redaction — so the original error is
 * never surfaced. Every {@link SelfHostSchemaError} instead carries only one of
 * these codes plus fixed text, so neither its message, its `reason` field, nor
 * its JSON serialization can echo a value.
 *   - `schema-load-failed`      — importing/evaluating the user's env.ts threw.
 *   - `schema-validation-error` — a registered validator threw or rejected while
 *                                 checking a production value.
 */
export type SelfHostSchemaFailureReason = 'schema-load-failed' | 'schema-validation-error';

/**
 * A self-host schema evaluation/validation step threw. DISTINCT from
 * {@link SelfHostEnvValidationError} (which means "a required value is missing
 * or invalid", carrying key names): this means the schema machinery itself
 * raised — env.ts failed to evaluate, or a validator threw/rejected rather than
 * returning issues. Values-free by construction: the original error's
 * message/stack/cause are DROPPED at the boundary and only the structural
 * {@link SelfHostSchemaFailureReason} code + fixed guidance survive, so no env
 * value the user's code may have embedded can reach the thrown error, even
 * under `VOID_ENV_UNMASK`.
 */
export class SelfHostSchemaError extends Error {
  override name = 'SelfHostSchemaError';
  /** Stable, values-free failure classification. */
  readonly reason: SelfHostSchemaFailureReason;
  constructor(message: string, reason: SelfHostSchemaFailureReason) {
    super(message);
    this.reason = reason;
  }
}

/** The fixed, values-free message for each schema-failure reason. */
export function selfHostSchemaFailureMessage(reason: SelfHostSchemaFailureReason): string {
  switch (reason) {
    case 'schema-load-failed':
      return (
        'env: the project env schema could not be loaded (reason: schema-load-failed). ' +
        'Check that env.ts evaluates without error, then run the deploy again.'
      );
    case 'schema-validation-error':
      return (
        'env: an env schema validator raised an error while checking production values ' +
        '(reason: schema-validation-error). Re-run the validator locally to see its own diagnostics.'
      );
  }
}

/**
 * Values-free boundary around EVERY self-host schema evaluation +
 * validation step. `loadSchema` evaluates the user's env.ts and each
 * `validateProdEnv` / `validateAllEnv` pass runs the registered validators —
 * all arbitrary code that can throw/reject an error EMBEDDING an env value in
 * its message, stack, or cause (and `VOID_ENV_UNMASK` disables redaction). Any
 * throw/reject from `fn` is caught, its original message/stack/cause DROPPED,
 * and a fixed structural {@link SelfHostSchemaError} rethrown in its place. The
 * managed `validateProdEnv` itself is NEVER wrapped — only the self-host CALL
 * SITES pass through here, so the managed path is byte-identical.
 */
async function withSchemaBoundary<T>(
  reason: SelfHostSchemaFailureReason,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch {
    // Drop the caught error entirely (message/stack/cause) — it may carry a
    // value — and rethrow only the structural, values-free classification.
    throw new SelfHostSchemaError(selfHostSchemaFailureMessage(reason), reason);
  }
}

/**
 * The structured, VALUES-FREE outcome of the self-host env DERIVATION — everything
 * decidable from the effective build var map + schema WITHOUT a network round-trip,
 * so the derivation can run in the isolated build-context subprocess (under the
 * scrubbed build env, where the user's env.ts + `loadEnv` never see the parent's
 * credentials) and the parent discharges it with only pure work + one `wrangler
 * secret list`. Carries KEY NAMES + source kinds/filenames + the fixed invalid
 * reason ONLY — never a value — so it crosses the process boundary as safe JSON.
 */
export type SelfHostEnvContext = {
  /** Whether the project registered an env schema at all (no schema → nothing to gate). */
  hasSchema: boolean;
  /**
   * Required keys the effective build map assigns an EMPTY string (`K=""`). The build
   * bakes these as plaintext `vars` that win over a same-named remote secret, so they
   * FAIL CLOSED unconditionally — the parent throws before any wrangler spawn.
   */
  presentEmptyRequired: Array<string>;
  /** Per-empty-key WINNING source (kind + filename) so the parent names it — never a value. */
  presentEmptySources: Record<string, VarSource>;
  /** Required keys the effective build map does NOT set — the only state a remote secret discharges. */
  absentRequired: Array<string>;
  /** Present-non-empty keys the schema REJECTED — malformed, never dischargeable by a secret. */
  invalidKeys: Array<string>;
};

export type SelfHostProdEnvResult = {
  hasSchema: boolean;
  /**
   * Remote secret names consulted via `wrangler secret list`, or `null` when
   * wrangler was never invoked (no schema, or the effective build map already
   * satisfied every required key present-and-non-empty).
   */
  remoteSecretNames: Array<string> | null;
};

/** A no-schema {@link SelfHostEnvContext} — nothing to gate. */
function emptyEnvContext(): SelfHostEnvContext {
  return {
    hasSchema: false,
    presentEmptyRequired: [],
    presentEmptySources: {},
    absentRequired: [],
    invalidKeys: [],
  };
}

// ---------------------------------------------------------------------------
// Post-build ground-truth self-host units.
//
// The redesigned `void deploy --backend cloudflare` gate validates the REAL
// build artifact the build emits — `dist/ssr/wrangler.json` `vars` (the plaintext
// worker vars) — instead of a pre-build `loadEnv` facsimile. It needs only ONE
// piece of project-derived data: the env-INSENSITIVE schema facts (required key
// names + `.secret()` flags), which do NOT depend on which `.env` file the build
// reads. Those are derived once in an isolated subprocess; everything else is pure
// parent work over the emitted map.
// ---------------------------------------------------------------------------

/**
 * The env-INSENSITIVE structural facts the self-host secret gate needs from the
 * project's env schema: whether a schema is registered, the REQUIRED key names (a
 * validator that rejects the ABSENT value — {@link requiredSchemaKeys}), and the
 * keys the schema flags `.secret()` ({@link getSecretOverride} === 'secret').
 * NONE of these depend on which `.env` file the build reads — they are fixed by
 * env.ts's structure — so this needs no `loadEnv` and no build env, and the result
 * is the SAME regardless of the build's mode/envDir. That is precisely why the old
 * probe-vs-build divergence class is gone: nothing derived here can diverge from
 * the build over which `.env*` set was loaded.
 */
export type SelfHostSchemaFacts = {
  /** Whether the project registered an env schema at all (no schema → nothing to gate). */
  hasSchema: boolean;
  /** Required key NAMES — validator rejects `undefined`. Values-free. */
  requiredKeys: Array<string>;
  /** Keys the schema flags `.secret()`. Values-free. */
  secretKeys: Array<string>;
};

/**
 * Derive the {@link SelfHostSchemaFacts} by importing the user's env.ts. Runs
 * ARBITRARY project code (env.ts evaluation) + the registered validators' probes,
 * so the caller MUST run this in an ISOLATED SUBPROCESS ({@link
 * ../cli/env-schema-probe.ts}) under a scrubbed env. Throws only a values-free
 * {@link SelfHostSchemaError} (via {@link withSchemaBoundary}) when the schema
 * machinery itself fails; the derived names/flags are returned as values-free data.
 */
export async function deriveSelfHostSchemaFacts(root: string): Promise<SelfHostSchemaFacts> {
  const envFile = findEnvFile(root);
  if (envFile == null) {
    return { hasSchema: false, requiredKeys: [], secretKeys: [] };
  }
  const mod = await withSchemaBoundary('schema-load-failed', () => loadSchema(envFile));
  if (!mod) {
    return { hasSchema: false, requiredKeys: [], secretKeys: [] };
  }
  const schema = mod._getRegisteredSchema() ?? {};
  const requiredKeys = await withSchemaBoundary('schema-validation-error', () =>
    requiredSchemaKeys(schema),
  );
  // `.secret()` is a STATIC flag on the validator (getSecretOverride) — no value
  // read, no env dependency.
  const secretKeys = Object.keys(schema).filter(
    (key) => getSecretOverride(schema[key]) === 'secret',
  );
  return { hasSchema: true, requiredKeys: [...requiredKeys], secretKeys };
}

/**
 * Build the values-free {@link SelfHostEnvContext} from the REAL worker `vars` the
 * build emitted into `dist/ssr/wrangler.json` (ground truth — never a facsimile)
 * plus the env-insensitive {@link SelfHostSchemaFacts}. PURE (no project code, no
 * I/O): the parent runs this AFTER the build with the real emitted map, so the
 * gate reads exactly what the worker ships.
 *   - a required key EMPTY in the emitted vars (`K=""`) → SHADOWS a same-named
 *     remote secret → fail closed ALWAYS (`presentEmptyRequired`).
 *   - a required key ABSENT from the emitted vars → the only state a remote secret
 *     can discharge (`absentRequired`).
 * `invalidKeys` is empty: value validity is enforced at worker boot
 * (`_validateEnvOnce`, per isolate), not re-derived here — the redesigned gate is
 * scoped to the empty-shadow + missing concerns over ground truth.
 */
export function deriveSelfHostEnvContextFromVars(
  emittedVars: Record<string, unknown>,
  facts: SelfHostSchemaFacts,
): SelfHostEnvContext {
  if (!facts.hasSchema) {
    return emptyEnvContext();
  }
  const presentEmptyRequired = facts.requiredKeys.filter(
    (key) => Object.hasOwn(emittedVars, key) && emittedVars[key] === '',
  );
  const absentRequired = facts.requiredKeys.filter((key) => !Object.hasOwn(emittedVars, key));
  const presentEmptySources: Record<string, VarSource> = {};
  for (const key of presentEmptyRequired) {
    presentEmptySources[key] = { kind: 'emitted' };
  }
  return {
    hasSchema: true,
    presentEmptyRequired,
    presentEmptySources,
    absentRequired,
    invalidKeys: [],
  };
}

/**
 * Classify the secret-looking keys among the REAL worker `vars` the build baked
 * into `dist/ssr/wrangler.json` (ground truth). PURE: for each emitted var key, a
 * `.secret()`-flagged key ({@link SelfHostSchemaFacts.secretKeys}) is
 * `schema-secret`; otherwise the shared {@link isLikelySecretKey} name heuristic
 * applies (so a secret-looking key ships plaintext regardless of any schema, and
 * heuristic classification still works with no env.ts at all). KEYS ONLY leave
 * here — the emitted values are never read.
 */
export function collectPlaintextVarWarningsFromVars(
  emittedVars: Record<string, unknown>,
  secretFlaggedKeys: Array<string>,
): PlaintextVarWarningsResult {
  const flagged = new Set(secretFlaggedKeys);
  const keys = Object.keys(emittedVars);
  const secretKeys: Array<PlaintextVarWarning> = [];
  for (const key of keys) {
    if (flagged.has(key)) {
      secretKeys.push({ key, reason: 'schema-secret' });
      continue;
    }
    if (isLikelySecretKey(key)) {
      secretKeys.push({ key, reason: 'heuristic' });
    }
  }
  secretKeys.sort((a, b) => a.key.localeCompare(b.key));
  return { secretKeys, totalVarKeys: keys.length };
}

/** Build a values-free invalid {@link EnvValidationReport} from key names only. */
function invalidEnvReport(missing: Array<string>, invalidKeys: Array<string>): EnvValidationReport {
  return {
    valid: false,
    missing,
    invalid: invalidKeys.map((key) => ({ key, messages: [SELF_HOST_INVALID_REASON] })),
    values: new Map(),
  };
}

/**
 * DISCHARGE half of the self-host gate — PURE parent work over the values-free
 * {@link SelfHostEnvContext} the subprocess derived, plus at most one `wrangler
 * secret list`. Runs NO project code, NO `loadEnv`, and imports NO env.ts, so the
 * parent never evaluates arbitrary code with live credentials in scope. Applies
 * the three fences unchanged:
 *   - a PRESENT-EMPTY required key fails closed ALWAYS, before any wrangler spawn;
 *   - the target account is reconciled against the config's `account_id` BEFORE
 *     `secret list` is spawned;
 *   - an ABSENT required key is discharged only by a same-named remote secret,
 *     else fails closed ({@link SelfHostFirstDeployError} on a not-yet-deployed
 *     worker, carrying the missing names + `wrangler secret put` guidance).
 */
export async function dischargeSelfHostEnvContext(
  context: SelfHostEnvContext,
  options: {
    root: string;
    configPath: string;
    accountId?: string;
    runWrangler?: RunSecretList;
    timeoutMs?: number;
  },
): Promise<SelfHostProdEnvResult> {
  if (!context.hasSchema) {
    return { hasSchema: false, remoteSecretNames: null };
  }

  // PRESENT-and-EMPTY required keys fail closed ALWAYS — remote membership is
  // irrelevant. Names the key + its actual source, never a value.
  if (context.presentEmptyRequired.length > 0) {
    throw emptyAssignmentError(context.presentEmptyRequired, context.presentEmptySources);
  }

  const invalidKeys = context.invalidKeys;
  if (context.absentRequired.length === 0) {
    // Every required key is present-and-non-empty; a remote secret could not
    // change the outcome — no wrangler call. Invalid local values still fail closed.
    if (invalidKeys.length > 0) {
      throw selfHostEnvError(invalidEnvReport([], invalidKeys));
    }
    return { hasSchema: true, remoteSecretNames: null };
  }

  // Reconcile the effective account BEFORE any wrangler spawn (config `account_id`
  // wins over CLOUDFLARE_ACCOUNT_ID, so a mismatch could list a different account).
  const effectiveAccountId = reconcileSelfHostAccount(options.configPath, options.accountId);

  const run =
    options.runWrangler ??
    createDefaultSecretListRunner(options.root, {
      accountId: effectiveAccountId,
      timeoutMs: options.timeoutMs,
    });
  const remoteSecretNames = await fetchSelfHostSecretNames(
    run,
    options.configPath,
    context.absentRequired,
  );

  const remoteSet = new Set(remoteSecretNames);
  const stillMissing = context.absentRequired.filter((key) => !remoteSet.has(key));
  if (stillMissing.length > 0 || invalidKeys.length > 0) {
    throw selfHostEnvError(invalidEnvReport(stillMissing, invalidKeys));
  }
  return { hasSchema: true, remoteSecretNames };
}

/**
 * Read the pinned config's top-level `account_id` and reconcile it with
 * the caller's requested account, mirroring the provisioner's account gate
 * (provision.ts `provisionCloudflareResourcesLocked`). wrangler 4.107 gives the
 * config's `account_id` PRECEDENCE over `CLOUDFLARE_ACCOUNT_ID`, so a real
 * config-vs-requested mismatch is a fail-closed error (thrown BEFORE any spawn).
 * Returns the ONE effective account to pin (config wins, else requested), or
 * undefined when neither is set (wrangler then resolves it as it normally would).
 */
function reconcileSelfHostAccount(
  configPath: string,
  requestedAccountId: string | undefined,
): string | undefined {
  const configAccountId = readConfigAccountId(configPath);
  if (configAccountId && requestedAccountId && configAccountId !== requestedAccountId) {
    throw new SelfHostSecretListError(
      `env: Cloudflare account mismatch — "${configPath}" pins account_id ` +
        `${JSON.stringify(configAccountId)} but the deploy targets ` +
        `${JSON.stringify(requestedAccountId)}. wrangler resolves the config's account_id before ` +
        `CLOUDFLARE_ACCOUNT_ID, so \`wrangler secret list\` would consult ` +
        `${JSON.stringify(configAccountId)} while the deploy expects ` +
        `${JSON.stringify(requestedAccountId)} — a same-named secret there could falsely pass this ` +
        `preflight. Reconcile them (correct or remove the config's account_id, or deploy to the ` +
        `pinned account) and retry.`,
      'account-mismatch',
    );
  }
  return configAccountId ?? requestedAccountId;
}

/** UTF-8 BOM, stripped before JSONC parsing (matches provision.ts readRootConfig). */
const UTF8_BOM = '﻿';

/** True when `value` is a non-array object (JSONC-parsed config record). */
function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the resolved root wrangler config (`-c` target) into a top-level record,
 * mirroring the provisioner's `readRootConfig` (jsonc-parser, BOM-stripped,
 * trailing commas allowed). We read the SAME file the deploy pins via `-c` and
 * force top-level via `--env=`, so its top-level fields are exactly what
 * wrangler's `secret list` and the build both resolve. An unreadable/malformed
 * config yields undefined — callers then fall back safely (no account gate / no
 * root-wrangler var layer), and wrangler itself later fails on a truly broken
 * config with a distinct fail-closed {@link SelfHostSecretListError}.
 */
function parseRootConfig(configPath: string): Record<string, unknown> | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return undefined;
  }
  const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isConfigRecord(parsed)) {
    return undefined;
  }
  return parsed;
}

/**
 * Read the top-level `account_id` string from the resolved wrangler config
 * (`-c` target). Same file/parse as {@link parseRootConfig}; this is exactly the
 * account wrangler's `secret list` will resolve. An unreadable/malformed config
 * yields undefined (no reconciliation gate).
 */
function readConfigAccountId(configPath: string): string | undefined {
  const parsed = parseRootConfig(configPath);
  if (!parsed) {
    return undefined;
  }
  const accountId = parsed.account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

/**
 * Stable, values-free reason code stamped on every invalid key on the
 * self-host path. The raw validator message (e.g. `Expected a number, got
 * "not-a-number"`) can EMBED the offending input, and redaction preserves
 * benign values / can be disabled via `VOID_ENV_UNMASK`, so the message text is
 * never surfaced here — only the key name and this fixed code.
 */
const SELF_HOST_INVALID_REASON = 'failed schema validation';

/**
 * Build the hard error for an unsatisfied schema from KEY NAMES + the
 * stable {@link SELF_HOST_INVALID_REASON} code ONLY. It never reads
 * `report.invalid[].messages` (which can embed raw input) and never resolved
 * `report.values`, and it attaches a freshly-sanitized report of the same
 * shape — so neither the thrown message, the attached report, nor its JSON
 * serialization can echo a value, even with `VOID_ENV_UNMASK` set.
 */
function selfHostEnvError(report: EnvValidationReport): SelfHostEnvValidationError {
  const sortNames = (names: Array<string>): Array<string> =>
    [...names].sort((a, b) => a.localeCompare(b));
  const missing = sortNames(report.missing);
  const invalidKeys = sortNames(report.invalid.map((i) => i.key));

  const lines: Array<string> = [];
  if (missing.length > 0) {
    lines.push('Missing required env vars:');
    for (const key of missing) {
      lines.push(`  • ${key}`);
    }
  }
  if (invalidKeys.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Invalid env vars:');
    for (const key of invalidKeys) {
      lines.push(`  • ${key} (${SELF_HOST_INVALID_REASON})`);
    }
  }
  if (missing.length > 0) {
    lines.push(
      '',
      'Set each missing production secret with `wrangler secret put <NAME>`, ' +
        'or add a value to .env / .env.production.',
    );
  }
  // Sanitized report: key names + the fixed reason code, no messages, no values.
  const safeReport: EnvValidationReport = {
    valid: report.valid,
    missing: report.missing,
    invalid: report.invalid.map((i) => ({ key: i.key, messages: [SELF_HOST_INVALID_REASON] })),
    values: new Map(),
  };
  return new SelfHostEnvValidationError(lines.join('\n'), safeReport);
}

/**
 * The values-free description of a var's WINNING source, used to name the
 * ACTUAL origin of a configured-empty key in the remediation. Only the source
 * KIND is ever surfaced — never a value. The self-host gate reads ground truth
 * (`dist/ssr/wrangler.json` `vars`), so every present key's source is `emitted`.
 */
function describeVarSource(source: VarSource | undefined): string {
  switch (source?.kind) {
    case 'emitted':
      return 'the built worker config (`dist/ssr/wrangler.json` `vars`)';
    default:
      // Unreachable — a present key always has a recorded source. Fall back to a
      // generic, values-free phrasing rather than naming a wrong source.
      return 'your build env configuration';
  }
}

/**
 * The hard error for a REQUIRED key set to an EMPTY value (`FOO=""`) in
 * the effective build map. Values-free (key names + source KIND/filename only),
 * thrown ALWAYS — independent of whether the key exists as a remote secret. The
 * build bakes the empty string into plaintext `vars`, and wrangler 4.107 gives a
 * config var precedence over a same-named remote secret (`checkRemoteSecretsOverride`
 * in wrangler-dist/cli.js warns "… will replace these remote secrets with the
 * configuration values"), so shipping this would ship an empty value for a
 * required secret (overwriting a remote one if it exists). The fix is to REMOVE
 * the empty assignment, not `secret put`.
 *
 * The empty value can come from ANY of the four build layers, so the
 * remediation names each key's ACTUAL source (its {@link VarSource} provenance)
 * — a dotenv file / `void.json` `worker.vars` / root `wrangler.jsonc` `vars` —
 * instead of misdirecting the user to `.env` files.
 */
function emptyAssignmentError(
  keys: Array<string>,
  sources: Record<string, VarSource>,
): SelfHostEnvValidationError {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const lines = [
    'Empty value for a required env var:',
    ...sorted.map((key) => `  • ${key} (from ${describeVarSource(sources[key])})`),
    '',
    'These keys are REQUIRED by your env schema but assigned an EMPTY value in the source noted ' +
      'above. The build bakes the empty value into the worker config as a plaintext var, and ' +
      'Cloudflare gives a config var precedence over any same-named remote secret — so the deploy ' +
      'would ship an empty value for a required secret (overwriting a remote secret if one exists).',
    '',
    'Remove the empty assignment (so a remote secret can take effect), or set a real value:',
    ...sorted.map((key) => `  • ${key} — from ${describeVarSource(sources[key])}`),
  ];
  const safeReport: EnvValidationReport = {
    valid: false,
    missing: sorted,
    invalid: [],
    values: new Map(),
  };
  return new SelfHostEnvValidationError(lines.join('\n'), safeReport);
}

/**
 * Actionable, values-free bootstrap guidance for the FIRST-DEPLOY case:
 * the worker does not exist yet, so its remote secrets can't be listed. Lists
 * the still-unsatisfied required key NAMES and the `wrangler secret put <NAME>`
 * command that bootstraps each on the draft worker (wrangler can `secret put`
 * before a worker's first deploy). Key names only — no values.
 */
function firstDeployMessage(missingKeys: Array<string>): string {
  const sorted = [...missingKeys].sort((a, b) => a.localeCompare(b));
  const names = sorted.length > 0 ? sorted : ['<NAME>'];
  return [
    'This Worker has not been deployed yet, so its remote secrets could not be listed.',
    '',
    'Required production secrets still unset locally:',
    ...sorted.map((key) => `  • ${key}`),
    '',
    'Bootstrap them on the draft Worker before deploying:',
    ...names.map((key) => `  wrangler secret put ${key}`),
    '',
    'or add a value to .env / .env.production, then run the deploy again.',
  ].join('\n');
}

/**
 * The exact `wrangler secret list` argv. Verified against the wrangler 4.107.0
 * bundle (`wrangler-dist/cli.js`, `secretListCommand`):
 *   - `secret list` accepts `--format` with choices `json`/`pretty`; `json` is
 *     the default AND suppresses the banner (`printBanner` is format==='pretty'),
 *     printing `JSON.stringify(secrets, null, '  ')` — an array of secret
 *     objects (each with a string `name`, per `fetchSecrets` →
 *     `GET /accounts/{id}/workers/scripts/{name}/secrets`). Pinned explicitly
 *     so a future default change can't silently switch us to `pretty`.
 *   - the worker name resolves from the config's `name` (`getLegacyScriptName`:
 *     `args.name ?? config.name` — we pass no `--name`, the pinned config is
 *     the single source of truth).
 *   - `-c <configPath>` (global `--config` alias) pins the ONE resolved config;
 *     `--env=` (explicit EMPTY environment) forces the top-level config env so
 *     a project dotenv exporting `CLOUDFLARE_ENV` can never reselect a named
 *     `env.*` block — same rationale as the provisioner's wranglerConfigArgs.
 */
function secretListArgs(configPath: string): Array<string> {
  return ['secret', 'list', '--format=json', '-c', configPath, '--env='];
}

/**
 * wrangler 4.107's `secret list` worker-not-found signal. When the worker has
 * never been deployed, `fetchSecrets` throws the API worker-not-found error and
 * `secretListCommand.handler` — ONLY when `isWorkerNotFoundError(e)` is true
 * (`e.code === 10007` WORKER_NOT_FOUND or `10090`
 * WORKER_LEGACY_ENVIRONMENT_NOT_FOUND, per wrangler-dist/cli.js) — rethrows a
 * `UserError` with this exact fixed diagnostic block:
 *
 *   Worker "<name>"[ (env: <env>)] not found.
 *
 *   If this is a new Worker, run `wrangler deploy` first to create it.
 *   Otherwise, check that the Worker name is correct and you're logged into the right account.
 *
 * The API code itself is caught and never printed, so the child's stderr
 * carries this MESSAGE, not `10007`/`10090`. Matching only the bare lead-in
 * `If this is a new Worker` misclassifies any unrelated status-1
 * diagnostic that merely contains that fragment. So we require the COMPLETE
 * structured block — the `… not found.` lead AND both fixed sentences of the
 * guidance — after normalizing whitespace (wrangler may wrap/indent the
 * multi-line UserError when it prints). The block carries no secret content, so
 * it survives `WRANGLER_LOG_SANITIZE=true`; the combined output is inspected
 * INTERNALLY only and never copied into any thrown error.
 */
function isWorkerNotFoundOutput(output: string): boolean {
  // Collapse whitespace runs so wrapped/indented multi-line printing still
  // matches the fixed sentences below.
  const normalized = output.replace(/\s+/g, ' ');
  return (
    /Worker ".*?"(?: \(env: [^)]*\))? not found\./.test(normalized) &&
    normalized.includes('If this is a new Worker, run `wrangler deploy` first to create it.') &&
    normalized.includes(
      "Otherwise, check that the Worker name is correct and you're logged into the right account.",
    )
  );
}

/**
 * Build the THROWN message for a wrangler-run failure from the structural
 * reason code + safe scalars ONLY. It NEVER interpolates `result.stderr`,
 * `result.stdout`, a spawn-error string, or a rejection message — those are
 * unconstrained (the child inherits `process.env`) and could embed an env
 * value. Where wrangler's own diagnostics would help, the message tells the
 * user to re-run wrangler themselves rather than echoing its output here.
 */
function secretListFailureMessage(
  reason: SecretListRunFailureReason,
  detail: SecretListFailureDetail,
): string {
  const base = 'env: `wrangler secret list` could not confirm the remote secrets';
  switch (reason) {
    case 'spawn-error':
      return (
        `${base} (reason: spawn-error) — the wrangler process could not be started. ` +
        'Check that wrangler is installed and the pinned config path is valid.'
      );
    case 'signal':
      return (
        `${base} (reason: signal) — the process was terminated by ` +
        `${detail.signal ?? 'a signal'} before completing.`
      );
    case 'nonzero-exit':
      return (
        `${base} (reason: nonzero-exit, status ${detail.exitCode ?? 'unknown'}). ` +
        'Re-run `wrangler secret list -c <config>` to see wrangler’s own diagnostics.'
      );
    case 'malformed-output':
      return (
        `${base} (reason: malformed-output) — \`wrangler secret list --format=json\` ` +
        'did not return the expected JSON array of secret objects.'
      );
  }
}

/** Construct a values-free {@link SelfHostSecretListError} for a run failure. */
function secretListError(
  reason: SecretListRunFailureReason,
  detail: SecretListFailureDetail = {},
): SelfHostSecretListError {
  return new SelfHostSecretListError(secretListFailureMessage(reason, detail), reason, detail);
}

/**
 * Run `wrangler secret list` through the seam and parse STRICTLY, failing
 * CLOSED: any signal, spawn error, nonzero exit, unparseable stdout, or
 * malformed list member throws {@link SelfHostSecretListError}. A failure here
 * is never interpreted as "no secrets exist" — that would let a deploy proceed
 * with required secrets actually missing on the worker.
 *
 * A nonzero exit whose output carries wrangler's worker-not-found signal is a
 * DISTINCT, structured {@link SelfHostFirstDeployError} carrying the still
 * unsatisfied required `missingKeys` + `wrangler secret put` bootstrap guidance,
 * instead of the generic "list exited nonzero" dead end.
 *
 * Raw child output (stderr/stdout, spawn-error text, rejection messages)
 * is used ONLY internally: for worker-not-found classification the combined
 * output is matched to a boolean that never leaves this function. Every THROWN
 * error carries only a structural {@link SecretListFailureReason} code and safe
 * scalars (exit code / signal name), so no env value the child may have echoed
 * can reach the error's message, fields, or JSON — even under `VOID_ENV_UNMASK`.
 */
async function fetchSelfHostSecretNames(
  run: RunSecretList,
  configPath: string,
  missingKeys: Array<string>,
): Promise<Array<string>> {
  let result: SecretListRunResult;
  try {
    result = await Promise.resolve(run(secretListArgs(configPath)));
  } catch {
    // The runner threw — the child produced no usable result. The rejection
    // message is unconstrained (could embed a value), so it is DROPPED; only
    // the structural code survives.
    throw secretListError('spawn-error');
  }
  if (result.error != null && result.error !== '') {
    // Spawn-error string is unconstrained wrangler/OS text — dropped.
    throw secretListError('spawn-error');
  }
  if (result.signal != null) {
    // Signal name is a safe scalar; stderr is NOT surfaced.
    throw secretListError('signal', { signal: String(result.signal) });
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    const exitCode = typeof result.status === 'number' ? result.status : undefined;
    // A not-yet-deployed worker: classify from the child's combined output
    // INTERNALLY (the match result is a boolean that never leaves), then surface
    // the missing key names + bootstrap guidance rather than the circular
    // "deploy first" list failure. Only a clean nonzero exit reaches here
    // (signal/spawn-error handled above), exactly how wrangler's worker-not-found
    // UserError surfaces. The output itself is NOT copied into the thrown error.
    if (isWorkerNotFoundOutput(`${result.stdout}\n${result.stderr}`)) {
      throw new SelfHostFirstDeployError(firstDeployMessage(missingKeys), missingKeys, exitCode);
    }
    throw secretListError('nonzero-exit', { exitCode });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // The unparseable stdout is NOT echoed (it could embed a value).
    throw secretListError('malformed-output');
  }
  if (!Array.isArray(parsed)) {
    throw secretListError('malformed-output');
  }
  const names: Array<string> = [];
  for (const member of parsed) {
    // Whole-list validation: ANY malformed member fails the entire call. A
    // partially-parsed list could vouch for secrets we never actually saw.
    const name =
      member !== null && typeof member === 'object' && !Array.isArray(member)
        ? (member as { name?: unknown }).name
        : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      throw secretListError('malformed-output');
    }
    names.push(name);
  }
  return names;
}

/**
 * Hard timeout for one `wrangler secret list` invocation — same bound as the
 * provisioner's per-command timeout. A hung wrangler must never hang the
 * whole deploy preflight.
 */
const SECRET_LIST_TIMEOUT_MS = 120_000;

/**
 * Default {@link RunSecretList}: resolves wrangler's REAL CLI entry
 * (`wrangler-dist/cli.js`, not the signal-swallowing `bin` wrapper) via
 * {@link resolveWranglerArgv} and spawns it ASYNC with `shell: false`, so every
 * argv element is passed literally (no shell → no metacharacter injection) and
 * the event loop stays free. A hard timeout SIGKILLs a hung child; the result
 * carries `{status, signal, error}` provenance so the caller fails closed on
 * anything but a clean exit 0.
 *
 * Deliberately simpler than the provisioner's runner: this is a ONE-SHOT
 * READ-ONLY query outside the provision lock — no lock heartbeat to protect,
 * nothing a lingering child could mutate — so the group-kill/quarantine
 * machinery is unnecessary. If the SIGKILL cannot be confirmed (close never
 * fires), a bounded fallback settles the call as a HARD failure anyway.
 */
export function createDefaultSecretListRunner(
  root: string,
  options?: {
    /** Pinned into the child's `CLOUDFLARE_ACCOUNT_ID` when provided. */
    accountId?: string;
    /** Test seam — the argv launcher. Defaults to the real wrangler CLI entry. */
    launcher?: Array<string>;
    /** Test seam — the hard timeout. Defaults to {@link SECRET_LIST_TIMEOUT_MS}. */
    timeoutMs?: number;
  },
): RunSecretList {
  const launcher = options?.launcher ?? resolveWranglerArgv(root);
  const timeoutMs = options?.timeoutMs ?? SECRET_LIST_TIMEOUT_MS;
  const [command, ...prefix] = launcher;
  return (args) =>
    new Promise<SecretListRunResult>((resolvePromise) => {
      const child = spawn(command as string, [...prefix, ...args], {
        cwd: root,
        shell: false,
        env: secretListEnv(options?.accountId),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let killFallbackTimer: ReturnType<typeof setTimeout> | undefined;
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const settle = (result: SecretListRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        clearTimeout(killFallbackTimer);
        resolvePromise(result);
      };
      const timeoutNote = `env: wrangler secret list exceeded the ${timeoutMs}ms timeout`;
      // REFERENCED timers (no unref): the outcome must keep the event loop
      // alive until it is known; both are cleared in settle().
      const commandTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // fall through to the fallback timer — settle as a hard failure below
        }
        // Fail-safe: if `close` never fires (kill failed / unkillable child),
        // settle as a HARD failure — never leave the preflight hanging, and
        // never read the partial output as a result.
        killFallbackTimer = setTimeout(() => {
          settle({
            stdout,
            stderr: [stderr, timeoutNote].filter(Boolean).join('\n'),
            status: -1,
            signal: 'SIGKILL',
            error: 'timed out and termination could not be confirmed',
          });
        }, 5_000);
      }, timeoutMs);
      child.on('error', (error: Error) => {
        settle({ stdout, stderr, status: -1, signal: null, error: error.message });
      });
      child.on('close', (code, signal) => {
        settle({
          stdout,
          stderr: timedOut ? [stderr, timeoutNote].filter(Boolean).join('\n') : stderr,
          // A signal-killed child reports `code: null` — normalize to a
          // nonzero status AND carry the signal, so no path reads it as clean.
          status: typeof code === 'number' ? code : -1,
          signal: signal ?? (timedOut ? 'SIGKILL' : null),
        });
      });
    });
}

/**
 * Child env for the spawned `wrangler secret list`. Mirrors deploy.ts's
 * `buildEnv` (not imported — deploy.ts imports this module): the CF Access
 * service-token pair is for the Void platform API client only and must never
 * leak into a spawned wrangler. Pins `WRANGLER_LOG_SANITIZE=true` (same as the
 * provisioner) and the caller's account id when provided. Unlike the
 * provisioner's `provisionEnv`, ambient transport env (`CLOUDFLARE_API_BASE_URL`
 * etc.) is left untouched: this preflight has no second transport to keep in
 * lockstep, and scrubbing would silently redirect a staging/FedRAMP user's
 * `secret list` at the production endpoint.
 *
 * Windows environment keys are CASE-INSENSITIVE (same hazard `provisionEnv`
 * guards): an ambient mixed-case spelling (`Cloudflare_Account_Id`) could
 * shadow an exact-case pin, so on win32 every case-variant of a scrubbed or
 * pinned key is removed first. Exported (with a platform seam) for direct
 * unit testing of that case rule; production callers pass no platform.
 */
export function secretListEnv(accountId?: string, platform?: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const caseInsensitive = (platform ?? process.platform) === 'win32';
  const scrub = (name: string): void => {
    if (!caseInsensitive) {
      delete env[name];
      return;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === lower) {
        delete env[key];
      }
    }
  };
  scrub('CF_ACCESS_CLIENT_ID');
  scrub('CF_ACCESS_CLIENT_SECRET');
  scrub('WRANGLER_LOG_SANITIZE');
  env.WRANGLER_LOG_SANITIZE = 'true';
  if (accountId) {
    scrub('CLOUDFLARE_ACCOUNT_ID');
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  return env;
}
