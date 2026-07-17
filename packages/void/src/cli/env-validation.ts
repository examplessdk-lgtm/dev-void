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
import { loadEnv } from 'vite';
import { findEnvFile } from '../codegen/env-types.ts';
import { loadUserEnvFile } from '../host/load-user-env.ts';
import { voidWarn } from '../log.ts';
import { getSecretOverride } from '../runtime/env-helpers.ts';
import type { EnvValidationReport } from '../runtime/env-public.ts';
import { mergeAndExpand, parseDotenvFile } from '../shared/dotenv.ts';
import { isLikelySecretKey } from '../shared/env-mask.ts';
import { filterLoadedEnv, stripInternalEnvKeys } from '../shared/env.ts';
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
// entirely, so it needs its own two safety units, called by the self-host deploy
// orchestrator BEFORE build/deploy:
//   1. `collectPlaintextVarWarnings` — WARN: the build bakes `.env*` values
//      verbatim into worker `vars` (plaintext in the uploaded config); report
//      which of those keys look like secrets so the caller can warn.
//   2. `validateSelfHostProdEnv` — GATE: the platform-free analogue of
//      `assertEnvSchemaValid`, sourcing remote secret names from
//      `wrangler secret list` instead of the platform API.
// Both are pure additions — every existing platform caller of
// `validateProdEnv` is unaffected.
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
 * Result of {@link collectPlaintextVarWarnings}. Carries KEY NAMES ONLY —
 * never values — so nothing here can leak a secret into logs, no matter how
 * the caller formats it.
 */
export type PlaintextVarWarningsResult = {
  /** Secret-looking keys the build will bake into worker `vars`, sorted by key. */
  secretKeys: Array<PlaintextVarWarning>;
  /** Total number of keys the build will merge into worker `vars`. */
  totalVarKeys: number;
};

export type CollectPlaintextVarWarningsOptions = {
  /**
   * The user's Vite `envDir` config value, passed RAW (exactly as
   * `envPlugin.config` receives `userConfig.envDir`). Resolved the same way
   * the build does: non-empty string → `join(root, envDir)`, else `root`.
   */
  envDir?: string;
  /** Vite mode the build runs under. Deploy builds use `'production'` (default). */
  mode?: string;
};

/**
 * The EXACT sanitized worker-vars map the BUILD assembles from `.env*` files,
 * mirroring `envPlugin.config` in index.ts byte-for-byte: `loadEnv(mode, envDir,
 * '')` (all `.env*` files for the mode + process.env) → {@link filterLoadedEnv}
 * (drop shell-env pollution, keep only `.env`-file keys) → {@link
 * stripInternalEnvKeys} (drop reserved `__VOID_*` keys). Returns the surviving
 * `sanitized` map — the values baked into `wrangler.json` `vars` as PLAINTEXT.
 *
 * Shared by the WARN unit ({@link collectPlaintextVarWarnings}) and the GATE's
 * F2 empty-collision fence ({@link validateSelfHostProdEnv}) so the two units
 * can NEVER diverge on which keys/values the build actually ships. `envDir`
 * resolution matches `envPlugin.config` exactly: a non-empty string `envDir` is
 * joined to `root`, else `root`; `mode` defaults to the deploy build's
 * `'production'`. Callers that only need emptiness (F2) inspect values locally
 * and never let one escape.
 */
function loadSanitizedBuildEnv(
  root: string,
  options: { envDir?: string; mode?: string },
): Record<string, string> {
  const mode = options.mode ?? 'production';
  const envDir =
    typeof options.envDir === 'string' && options.envDir.length > 0
      ? join(root, options.envDir)
      : root;
  const filtered = filterLoadedEnv(loadEnv(mode, envDir, ''));
  const { sanitized } = stripInternalEnvKeys(filtered);
  return sanitized;
}

/**
 * WARN unit — determine exactly the keys the BUILD will merge into worker
 * `vars` and classify the secret-looking ones.
 *
 * Mirrors the build's env assembly EXACTLY. The build lands TWO sources into
 * `wrangler.json` `vars` as PLAINTEXT on a self-host build:
 *   1. `.env*` file values (envPlugin.config in index.ts): `loadEnv(mode,
 *      envDir, '')` → {@link filterLoadedEnv} (drop shell-env pollution) →
 *      {@link stripInternalEnvKeys} (drop reserved `__VOID_*` keys).
 *   2. Registered schema DEFAULTS (`applySchemaDefaultsToWorkerVars` in
 *      index.ts): every `.default(value)` key the dotenv did not already set is
 *      baked into `vars` too. A secret-valued default with no dotenv entry
 *      still ships plaintext, so it MUST be classified.
 * The complete var key set is the UNION of (1)'s sanitized keys and (2)'s
 * default keys — reusing the schema's `_getSchemaDefaults()` for KEY NAMES ONLY
 * (values are never read here).
 *
 * Classification per key: `schema-secret` when the registered env.ts schema
 * flags it `.secret()` (explicit, always wins); OTHERWISE the shared
 * {@link isLikelySecretKey} name heuristic. `.public()` does NOT suppress the
 * heuristic — it only means "not a schema secret"; the value still ships as
 * plaintext, so a secret-looking public key is still flagged.
 *
 * The caller formats/prints. The result contains key names only — values are
 * deliberately unreachable from here so they can never leak into logs.
 */
export async function collectPlaintextVarWarnings(
  root: string,
  options: CollectPlaintextVarWarningsOptions = {},
): Promise<PlaintextVarWarningsResult> {
  // The build's exact plaintext var map (loadEnv → filterLoadedEnv →
  // stripInternalEnvKeys), reused verbatim by the F2 empty-collision fence.
  const sanitized = loadSanitizedBuildEnv(root, options);

  // Registered schema (if the project has an env.ts) for explicit overrides
  // AND its registered defaults — the build merges BOTH into workerConfig.vars.
  const envFile = findEnvFile(root);
  const mod = envFile ? await loadSchema(envFile) : null;
  const schema = mod?._getRegisteredSchema() ?? null;

  // The COMPLETE key-only var set the build assembles: sanitized dotenv keys
  // UNION registered-default keys (keys only — `_getSchemaDefaults` values are
  // never read). `applySchemaDefaultsToWorkerVars` fills a default key only
  // when the dotenv left it unset, so the resulting key set is exactly this
  // union either way.
  const varKeys = new Set<string>(Object.keys(sanitized));
  if (mod) {
    for (const key of Object.keys(mod._getSchemaDefaults())) {
      varKeys.add(key);
    }
  }

  const secretKeys: Array<PlaintextVarWarning> = [];
  for (const key of varKeys) {
    // Explicit `.secret()` is the ONLY override that changes classification.
    // `.public()` means "not a schema secret" — it does NOT suppress the name
    // heuristic (the value still ships plaintext), so fall through to it.
    const override = schema ? getSecretOverride(schema[key]) : undefined;
    if (override === 'secret') {
      secretKeys.push({ key, reason: 'schema-secret' });
      continue;
    }
    if (isLikelySecretKey(key)) {
      secretKeys.push({ key, reason: 'heuristic' });
    }
  }
  secretKeys.sort((a, b) => a.key.localeCompare(b.key));
  return { secretKeys, totalVarKeys: varKeys.size };
}

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
 * F5 — the STABLE, values-free classification of a hard secret-list failure.
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
 *   - `account-mismatch` — F3 config-vs-requested account gate (thrown before any
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
 * F5 — the message and attached fields are values-free by construction: only
 * the structural {@link SecretListFailureReason} code and safe scalars
 * ({@link SecretListFailureDetail}) are exposed. Raw wrangler output (stderr,
 * stdout, rejection/spawn-error text) is NEVER stored here, so no env value the
 * child may have echoed can reach `Error.message`, the `reason`/`detail`
 * fields, or their JSON serialization — even under `VOID_ENV_UNMASK`.
 */
export class SelfHostSecretListError extends Error {
  override name = 'SelfHostSecretListError';
  constructor(
    message: string,
    /** Stable, values-free failure classification. */
    public readonly reason: SecretListFailureReason,
    /** Safe scalars (exit code / signal name) — never contain wrangler output. */
    public readonly detail: SecretListFailureDetail = {},
  ) {
    super(message);
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
  constructor(
    message: string,
    /** Required schema key NAMES still unsatisfied locally (values-free). */
    public readonly missingKeys: Array<string>,
    /** The clean nonzero exit code wrangler surfaced (safe scalar). */
    exitCode?: number,
  ) {
    // Structurally still a nonzero-exit; `message` is the values-free
    // first-deploy guidance and `missingKeys` carries the names.
    super(message, 'nonzero-exit', { exitCode });
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
  constructor(
    message: string,
    public readonly report: EnvValidationReport,
  ) {
    super(message);
  }
}

export type ValidateSelfHostProdEnvOptions = {
  /**
   * Absolute path to the resolved root wrangler config — pinned onto every
   * wrangler argv via `-c` so discovery reads the exact config the deploy
   * will use (worker name comes from its `name` field).
   */
  configPath: string;
  /**
   * The Cloudflare account id the deploy targets. Reconciled against the pinned
   * config's top-level `account_id` BEFORE any wrangler spawn (F3): wrangler
   * resolves the config's `account_id` with PRECEDENCE over
   * `CLOUDFLARE_ACCOUNT_ID`, so a config pinning a different account is a hard,
   * fail-closed mismatch (naming both). The reconciled effective account is
   * then pinned into the spawned wrangler's `CLOUDFLARE_ACCOUNT_ID` so
   * `secret list` can never consult a different ambient account.
   */
  accountId?: string;
  /**
   * The user's Vite `envDir`, passed RAW — MUST be the same value handed to
   * {@link collectPlaintextVarWarnings} and the build. Used only to reconstruct
   * the EXACT sanitized build var map for the F2 empty-collision fence (via
   * {@link loadSanitizedBuildEnv}), so the gate sees precisely the `.env*`
   * sources the build bakes (incl. `.env.local` / a custom envDir). Resolved
   * the same way the build does: non-empty string → `join(root, envDir)`, else
   * `root`.
   */
  envDir?: string;
  /**
   * The Vite mode the build runs under — MUST match the build / WARN unit.
   * Deploy builds use `'production'` (default). Selects the `.env.<mode>` files
   * the F2 build-map fence reads.
   */
  mode?: string;
  /** Test seam — injectable wrangler runner. Defaults to the real spawn-based runner. */
  runWrangler?: RunSecretList;
  /** Test seam — hard timeout for the default runner (ms). */
  timeoutMs?: number;
};

export type SelfHostProdEnvResult = {
  hasSchema: boolean;
  /**
   * Remote secret names consulted via `wrangler secret list`, or `null` when
   * wrangler was never invoked (no schema, or local `.env`/`.env.production`
   * already satisfied every required key).
   */
  remoteSecretNames: Array<string> | null;
};

/**
 * GATE unit — the platform-free analogue of deploy.ts's `assertEnvSchemaValid`
 * for `void deploy --backend cloudflare`.
 *
 * Derives required secret names from the registered env.ts schema exactly the
 * way {@link validateProdEnv} does (productionOnly: `.env` + `.env.production`).
 * When local files leave required keys unfilled, fetches the REMOTE secret
 * names via `wrangler secret list` and feeds them into `validateProdEnv`'s
 * existing `remoteSecrets` hook. Still-missing keys → throws
 * {@link SelfHostEnvValidationError} with `wrangler secret put <NAME>` guidance.
 *
 * wrangler is only invoked when remote secrets could change the outcome
 * (remote names can only satisfy MISSING keys, never fix an invalid local
 * value). This keeps first deploys working: a locally-satisfied schema never
 * requires the worker to already exist, while a genuinely missing key on a
 * fresh worker fails the wrangler call (worker not found) — a hard, fail-closed
 * {@link SelfHostFirstDeployError} carrying the missing key names + bootstrap
 * guidance (F4), rather than a false "all secrets present".
 *
 * Two build-fidelity fences guard the discharge (F2/F3):
 *   - A required key that is PRESENT-but-EMPTY locally (`FOO=`) is NOT
 *     discharged by a same-named remote secret — the build still bakes the
 *     empty value into plaintext `vars`, which wrangler 4.107 gives precedence
 *     over the remote secret, so the deploy would ship empty OVER the secret.
 *   - The target account is reconciled against the config's `account_id` BEFORE
 *     spawning wrangler, so `secret list` can never consult a different account.
 */
export async function validateSelfHostProdEnv(
  root: string,
  options: ValidateSelfHostProdEnvOptions,
): Promise<SelfHostProdEnvResult> {
  // Skip the wrangler round-trip when the project has no typed env schema
  // (mirrors assertEnvSchemaValid's findEnvFile fast path).
  if (findEnvFile(root) == null) {
    return { hasSchema: false, remoteSecretNames: null };
  }

  const local = await validateProdEnv(root, { productionOnly: true });
  if (!local.hasSchema) {
    return { hasSchema: false, remoteSecretNames: null };
  }
  if (local.report.valid) {
    // Every required key is satisfied by .env/.env.production — remote names
    // could only ADD presence, so the outcome cannot change. No wrangler call.
    return { hasSchema: true, remoteSecretNames: null };
  }
  if (local.report.missing.length === 0) {
    // Only INVALID local values — a remote secret can never fix those.
    throw selfHostEnvError(local.report);
  }

  // F3 — reconcile the effective account BEFORE any wrangler spawn. wrangler
  // 4.107 resolves the config's top-level `account_id` with precedence over
  // CLOUDFLARE_ACCOUNT_ID, so a config pinning account X while options.accountId
  // requests Y would list X's secrets; a same-named secret in X could then
  // falsely satisfy Y's preflight. Fail closed (naming both) here, before the
  // runner is created or invoked, and pin the ONE reconciled account.
  const effectiveAccountId = reconcileSelfHostAccount(options.configPath, options.accountId);

  // F2 — reconstruct the EXACT sanitized var map the BUILD will bake
  // (loadEnv → filterLoadedEnv → stripInternalEnvKeys over the FULL build file
  // set: `.env` + `.env.local` + `.env.<mode>` + `.env.<mode>.local`, honouring
  // a custom `envDir`), reusing {@link loadSanitizedBuildEnv} — the SAME
  // assembly the WARN unit uses, so the two units can never diverge on which
  // empty assignments the build ships. `validateProdEnv` above sees only
  // `.env` + `.env.production`, so a key emptied in `.env.local` (or a custom
  // envDir) reads as genuinely ABSENT there and would be wrongly discharged by
  // a remote secret; this fuller map is what catches that. Only emptiness is
  // inspected here — no value leaves this function or reaches any error/log.
  const buildEnv = loadSanitizedBuildEnv(root, { envDir: options.envDir, mode: options.mode });

  const run =
    options.runWrangler ??
    createDefaultSecretListRunner(root, {
      accountId: effectiveAccountId,
      timeoutMs: options.timeoutMs,
    });
  const remoteSecretNames = await fetchSelfHostSecretNames(
    run,
    options.configPath,
    local.report.missing,
  );

  // F2 — a required key that is present-and-EMPTY in ANY build-loaded source
  // AND exists as a remote secret is a shadow collision: the empty plaintext
  // var would overwrite the secret (wrangler gives a config var precedence over
  // a same-named remote secret). Fail closed naming those keys (never discharge
  // them) with guidance to remove the empty assignment.
  const remoteSet = new Set(remoteSecretNames);
  const emptyOverrides = local.report.missing.filter(
    (key) => remoteSet.has(key) && Object.hasOwn(buildEnv, key) && buildEnv[key] === '',
  );
  if (emptyOverrides.length > 0) {
    throw emptyAssignmentError(emptyOverrides);
  }

  const { report } = await validateProdEnv(root, {
    productionOnly: true,
    remoteSecrets: remoteSecretNames,
  });
  if (!report.valid) {
    throw selfHostEnvError(report);
  }
  return { hasSchema: true, remoteSecretNames };
}

/**
 * F3 — read the pinned config's top-level `account_id` and reconcile it with
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
 * Read the top-level `account_id` string from the resolved wrangler config
 * (`-c` target), mirroring the provisioner's `readRootConfig` (jsonc-parser,
 * BOM-stripped, trailing commas allowed). We read the SAME file the deploy pins
 * via `-c` and force top-level via `--env=`, so this is exactly the account
 * wrangler's `secret list` will resolve. An unreadable/malformed config yields
 * undefined (no reconciliation gate) — wrangler itself then fails on it, and
 * that nonzero exit is a distinct fail-closed {@link SelfHostSecretListError}.
 */
function readConfigAccountId(configPath: string): string | undefined {
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
  const accountId = parsed.account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

/**
 * F5 — stable, values-free reason code stamped on every invalid key on the
 * self-host path. The raw validator message (e.g. `Expected a number, got
 * "not-a-number"`) can EMBED the offending input, and redaction preserves
 * benign values / can be disabled via `VOID_ENV_UNMASK`, so the message text is
 * never surfaced here — only the key name and this fixed code.
 */
const SELF_HOST_INVALID_REASON = 'failed schema validation';

/**
 * F5 — build the hard error for an unsatisfied schema from KEY NAMES + the
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
 * F2 — the hard error for EMPTY local assignments (`FOO=`) that would shadow a
 * same-named remote secret. Values-free (key names only). The build bakes the
 * empty string into plaintext `vars`, and wrangler 4.107 gives a config var
 * precedence over the remote secret (`checkRemoteSecretsOverride` in
 * wrangler-dist/cli.js warns "… will replace these remote secrets with the
 * configuration values"), so shipping this would overwrite the secret with
 * empty. The fix is to REMOVE the empty assignment, not `secret put`.
 */
function emptyAssignmentError(keys: Array<string>): SelfHostEnvValidationError {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const lines = [
    'Empty env assignment would shadow a remote secret:',
    ...sorted.map((key) => `  • ${key}`),
    '',
    'These keys are set to an EMPTY value in one of your build-loaded .env files (.env, ' +
      '.env.local, .env.production, .env.production.local, or your configured envDir) but also ' +
      'exist as remote worker secrets. The build bakes the empty value into the worker config as a ' +
      'plaintext var, and Cloudflare gives a config var precedence over the remote secret — so the ' +
      'deploy would overwrite the secret with an empty value.',
    '',
    `Remove the empty assignment (${sorted
      .map((key) => `\`${key}=\``)
      .join(', ')}) from your .env files so the remote secret takes effect, or set a real value.`,
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
 * F4 — actionable, values-free bootstrap guidance for the FIRST-DEPLOY case:
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
 * never been deployed, `fetchSecrets` throws the API worker-not-found error
 * (codes 10007 / 10090) and `secretListCommand.handler` rethrows a `UserError`
 * whose message begins "… not found." and contains this UNIQUE lead-in phrase
 * (verified against wrangler-dist/cli.js — it appears exactly once, in that
 * handler). The phrase carries no secret content, so it survives
 * `WRANGLER_LOG_SANITIZE=true`. Matched against the child's combined output.
 */
function isWorkerNotFoundOutput(output: string): boolean {
  return /If this is a new Worker/i.test(output);
}

/**
 * F5 — build the THROWN message for a wrangler-run failure from the structural
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
 * DISTINCT, structured {@link SelfHostFirstDeployError} (F4) carrying the still
 * unsatisfied required `missingKeys` + `wrangler secret put` bootstrap guidance,
 * instead of the generic "list exited nonzero" dead end.
 *
 * F5 — raw child output (stderr/stdout, spawn-error text, rejection messages)
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
    // F4 — a not-yet-deployed worker: classify from the child's combined output
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
