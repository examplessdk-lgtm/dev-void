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
   * `isLikelySecretKey` credential heuristic (`KEY|TOKEN|SECRET|…`).
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
 * WARN unit — determine exactly the keys the BUILD will merge into worker
 * `vars` and classify the secret-looking ones.
 *
 * Mirrors the build's env assembly EXACTLY (envPlugin.config in index.ts):
 * `loadEnv(mode, envDir, '')` → {@link filterLoadedEnv} (drop shell-env
 * pollution) → {@link stripInternalEnvKeys} (drop reserved `__VOID_*` keys).
 * The surviving keys are what lands in `wrangler.json` `vars` as PLAINTEXT on
 * a self-host build.
 *
 * Classification per key: an explicit `.secret()` / `.public()` override on
 * the registered env.ts schema WINS (`.public()` suppresses the warning);
 * otherwise the shared {@link isLikelySecretKey} name heuristic applies.
 *
 * The caller formats/prints. The result contains key names only — values are
 * deliberately unreachable from here so they can never leak into logs.
 */
export async function collectPlaintextVarWarnings(
  root: string,
  options: CollectPlaintextVarWarningsOptions = {},
): Promise<PlaintextVarWarningsResult> {
  const mode = options.mode ?? 'production';
  // Same envDir resolution as envPlugin.config: honour a non-empty string
  // `envDir` relative to root, else fall back to the project root.
  const envDir =
    typeof options.envDir === 'string' && options.envDir.length > 0
      ? join(root, options.envDir)
      : root;
  // loadEnv with prefix "" returns .env-file vars AND all process.env vars;
  // filterLoadedEnv keeps only the .env-file ones, stripInternalEnvKeys drops
  // reserved __VOID_* keys — byte-for-byte the build's assembly.
  const filtered = filterLoadedEnv(loadEnv(mode, envDir, ''));
  const { sanitized } = stripInternalEnvKeys(filtered);

  // Registered schema (if the project has an env.ts) for explicit overrides.
  const envFile = findEnvFile(root);
  const mod = envFile ? await loadSchema(envFile) : null;
  const schema = mod?._getRegisteredSchema() ?? null;

  const secretKeys: Array<PlaintextVarWarning> = [];
  for (const key of Object.keys(sanitized)) {
    const override = schema ? getSecretOverride(schema[key]) : undefined;
    if (override === 'secret') {
      secretKeys.push({ key, reason: 'schema-secret' });
      continue;
    }
    if (override === 'public') {
      continue; // explicit opt-out beats the heuristic
    }
    if (isLikelySecretKey(key)) {
      secretKeys.push({ key, reason: 'heuristic' });
    }
  }
  secretKeys.sort((a, b) => a.key.localeCompare(b.key));
  return { secretKeys, totalVarKeys: Object.keys(sanitized).length };
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
 * Hard failure fetching the remote secret list (spawn error, signal, nonzero
 * exit, timeout, or malformed output). DISTINCT from
 * {@link SelfHostEnvValidationError}: this means "we could not learn what
 * secrets exist" (fail closed), never "a required secret is missing".
 */
export class SelfHostSecretListError extends Error {
  override name = 'SelfHostSecretListError';
}

/**
 * The env schema is not satisfied for a self-host production deploy: required
 * keys are missing (not in `.env`/`.env.production` and not present as remote
 * worker secrets) or local values are invalid. Message lists the offending
 * key NAMES (values are redacted upstream by `formatEnvReport`).
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
   * The Cloudflare account id the deploy targets. When provided, pinned into
   * the spawned wrangler's `CLOUDFLARE_ACCOUNT_ID` so `secret list` can never
   * consult a different ambient account.
   */
  accountId?: string;
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
 * error rather than a false "all secrets present".
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

  const run = options.runWrangler ?? createDefaultSecretListRunner(root, options);
  const remoteSecretNames = await fetchSelfHostSecretNames(run, options.configPath);
  const { report } = await validateProdEnv(root, {
    productionOnly: true,
    remoteSecrets: remoteSecretNames,
  });
  if (!report.valid) {
    throw selfHostEnvError(report);
  }
  return { hasSchema: true, remoteSecretNames };
}

/** Build the hard error for an unsatisfied schema, with secret-put guidance. */
function selfHostEnvError(report: EnvValidationReport): SelfHostEnvValidationError {
  const lines = [formatEnvReport(report)];
  if (report.missing.length > 0) {
    lines.push(
      '',
      'Set each missing production secret with `wrangler secret put <NAME>`, ' +
        'or add a value to .env / .env.production.',
    );
  }
  return new SelfHostEnvValidationError(lines.join('\n'), report);
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
 * Run `wrangler secret list` through the seam and parse STRICTLY, failing
 * CLOSED: any signal, spawn error, nonzero exit, unparseable stdout, or
 * malformed list member throws {@link SelfHostSecretListError}. A failure here
 * is never interpreted as "no secrets exist" — that would let a deploy proceed
 * with required secrets actually missing on the worker.
 */
async function fetchSelfHostSecretNames(
  run: RunSecretList,
  configPath: string,
): Promise<Array<string>> {
  let result: SecretListRunResult;
  try {
    result = await Promise.resolve(run(secretListArgs(configPath)));
  } catch (err) {
    throw new SelfHostSecretListError(
      `env: failed to run \`wrangler secret list\`: ${(err as Error).message}`,
    );
  }
  if (result.error != null && result.error !== '') {
    throw new SelfHostSecretListError(
      `env: \`wrangler secret list\` could not be started: ${result.error}`,
    );
  }
  if (result.signal != null) {
    throw new SelfHostSecretListError(
      `env: \`wrangler secret list\` was terminated by ${result.signal} before completing.` +
        formatStderrTail(result.stderr),
    );
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    throw new SelfHostSecretListError(
      `env: \`wrangler secret list\` exited with status ${String(result.status)}.` +
        formatStderrTail(result.stderr),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new SelfHostSecretListError(
      `env: \`wrangler secret list --format=json\` produced unparseable output` +
        formatSnippet(result.stdout),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SelfHostSecretListError(
      `env: \`wrangler secret list --format=json\` did not return a JSON array` +
        formatSnippet(result.stdout),
    );
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
      throw new SelfHostSecretListError(
        'env: `wrangler secret list --format=json` returned a malformed list member ' +
          '(expected every member to be an object with a non-empty string `name`).',
      );
    }
    names.push(name);
  }
  return names;
}

/** Bounded stderr tail for diagnostics (secret list stderr carries no values). */
function formatStderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const tail = trimmed.length > 2000 ? `…${trimmed.slice(-2000)}` : trimmed;
  return `\n${tail}`;
}

/** Bounded stdout snippet for parse-failure diagnostics. */
function formatSnippet(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return ' (stdout was empty).';
  }
  const snippet = trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
  return `:\n${snippet}`;
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
 */
function secretListEnv(accountId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;
  env.WRANGLER_LOG_SANITIZE = 'true';
  if (accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  return env;
}
