import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { parse, type ParseError } from 'jsonc-parser';
import { basename, dirname, join, resolve } from 'pathe';
import lockfile from 'proper-lockfile';
import { voidLog, voidWarn } from '../log.ts';
import { resolveWranglerArgv } from './preset.ts';
import {
  assertNoDuplicateMembers,
  readProvisionedBindingEntry,
  writeProvisionedWranglerConfig,
  type WriteProvisionedWranglerResult,
} from './wrangler.ts';

/**
 * The set of Cloudflare resources an app needs, computed by the deploy
 * orchestrator (Task 6) from inferred bindings + config. The provisioner
 * consumes this as-is; it never computes the set itself.
 *
 * `binding` values are the pre-validated uppercase names the app already uses
 * (`DB`, `KV`, `ISR_CACHE`, `STORAGE`, `HYPERDRIVE`) and are passed to wrangler
 * verbatim.
 */
export interface DesiredResourceSet {
  /** D1 database — `{ binding: 'DB', name: 'myapp-db' }`. */
  d1?: { binding: string; name: string };
  /** KV namespaces (app KV + `ISR_CACHE`). Titles are NOT account-unique. */
  kvNamespaces: Array<{ binding: string; title: string }>;
  /** R2 bucket — bucket names ARE account-unique. */
  r2?: { binding: string; bucketName: string };
  /** Queue resource NAMES to ensure exist (account-unique). */
  queues: Array<string>;
  /** Hyperdrive config — a connection string is required only to CREATE one. */
  hyperdrive?: { binding: string; name: string; connectionString: string };
}

/**
 * Result of one `runWrangler` invocation, carrying STRUCTURED PROVENANCE so a
 * signal-killed or unspawnable child is never mistaken for a clean exit. The
 * single rule ({@link isHardFailure}) every classifier defers to: a result with a
 * non-null `signal` or a `error` did NOT run to completion, so its buffered
 * status/stdout/stderr is unreliable and must NEVER be read as "absent" or
 * "success".
 */
export type RunWranglerResult = {
  stdout: string;
  stderr: string;
  status: number;
  /**
   * Non-null ONLY when the child was terminated by a signal — a HARD failure.
   * (Optional so injected test stubs may omit it, meaning "clean".)
   */
  signal?: NodeJS.Signals | null;
  /** The spawn-error message when the child could not be started — a HARD failure. */
  error?: string | null;
};

/**
 * Seam over shelling out to the project's `wrangler`. The default implementation
 * ({@link createDefaultRunWrangler}) wraps `spawnSync` with `shell: false`; unit
 * tests inject a stub so no real wrangler runs.
 *
 * `args` is the wrangler ARGV after the launcher — one array element per token,
 * e.g. `['d1', 'list', '--json']` or
 * `['hyperdrive', 'create', name, '--connection-string=' + conn, ...]`. Every
 * untrusted value (resource name, connection string, config path) is its OWN
 * array element and is passed literally to the process (no shell), so shell
 * metacharacters (`&`, `$`, `;`, spaces) can never split, inject, or drop args.
 */
/**
 * F1 — the transport context threaded into EVERY wrangler invocation (default AND
 * injected). Its `accountId` is the ONE reconciled effective account this whole
 * provision is pinned to: the default runner uses it to pin the spawned wrangler's
 * env (`CLOUDFLARE_ACCOUNT_ID` + the top-level `--env=` on every argv), and an
 * injected seam MUST bind its own transport to the SAME account (so it can never
 * query account B while the config pins A and write a same-name B result into A).
 */
export interface WranglerCallContext {
  /** The reconciled effective Cloudflare account (never empty for a real call). */
  accountId: string;
  /**
   * F1 — the ONE pinned Cloudflare API base URL this provision resolved (mirroring
   * wrangler's own `getCloudflareApiBaseUrl`), threaded so the default runner can pin the
   * spawned wrangler's `CLOUDFLARE_API_BASE_URL` to the SAME endpoint the Hyperdrive REST
   * lister uses. An injected seam may ignore it (it owns its own transport).
   */
  apiBaseUrl?: string;
  cwd?: string;
  captureJson?: boolean;
}

/**
 * F1 — the seam returns a Promise (or a plain value, which the choke point coerces
 * with `Promise.resolve`). The default runner is ASYNC (`spawn`, awaited) so a slow
 * wrangler call NEVER blocks the event loop, which keeps `proper-lockfile`'s heartbeat
 * timer firing (a synchronous `spawnSync` would freeze the loop, so the heartbeat could
 * not refresh the mutex mtime and another process could steal a lock we still hold).
 * Injected unit-test stubs may stay synchronous (returning a plain `RunWranglerResult`)
 * — `Promise.resolve` at the choke point wraps them transparently.
 */
export type RunWrangler = (
  args: Array<string>,
  opts: WranglerCallContext,
) => RunWranglerResult | Promise<RunWranglerResult>;

/** A Cloudflare Hyperdrive config as returned by the account-list existence check. */
export interface HyperdriveConfig {
  id: string;
  name: string;
}

/**
 * Seam over listing the account's Hyperdrive configs (wrangler 4.107 has NO
 * machine-readable `hyperdrive list` and no get-by-name, so existence is checked
 * via the Cloudflare REST API). The default implementation
 * ({@link createDefaultListHyperdriveConfigs}) calls
 * `GET /accounts/{id}/hyperdrive/configs`; unit tests inject a stub so no real
 * network call runs.
 *
 * F1 — the lister receives the reconciled `accountId` AND the pinned `apiBaseUrl` as an
 * explicit transport context (never a closure-only binding), so an injected lister can
 * never query a DIFFERENT account/endpoint than the one wrangler + the config are pinned
 * to. The default lister builds its REST URL from `apiBaseUrl` instead of hardcoding prod.
 */
export type ListHyperdriveConfigs = (ctx: {
  accountId: string;
  apiBaseUrl: string;
  /**
   * F4 — the abort signal enforcing the caller's OVERALL lister deadline. The default lister
   * threads it into EVERY paginated `fetch`; an injected seam SHOULD honor it too. The caller
   * ALSO races the whole call against the same deadline, so even a seam that ignores the signal
   * cannot hold the whole-provision lock past the deadline.
   */
  signal: AbortSignal;
}) => Promise<Array<HyperdriveConfig>>;

/** Per-resource outcome, so the orchestrator can log what happened. */
export interface ProvisionOutcome {
  kind: 'd1' | 'kv' | 'r2' | 'hyperdrive' | 'queue';
  /** Binding name (absent for queue resources, which are not bindings here). */
  binding?: string;
  /** Resource name / KV title / bucket name / queue name. */
  name: string;
  action: 'created' | 'reused' | 'adopted' | 'skipped';
  /** Real resource id captured on adopt (and reuse, when known). */
  id?: string;
  /** Reason, set only when `action === 'skipped'`. */
  reason?: string;
}

export interface ProvisionResult {
  resources: Array<ProvisionOutcome>;
  /** The root wrangler config the writer/wrangler operated on. */
  configPath: string;
  /** True when top-level `account_id` was written from `opts.accountId`. */
  accountIdWritten: boolean;
}

export interface ProvisionLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Where Void keeps D1 migrations — written as `migrations_dir` on the D1 entry. */
const D1_MIGRATIONS_DIR = './db/migrations';

/** UTF-8 byte-order mark. Node's utf-8 read preserves a leading one. */
const UTF8_BOM = '﻿';

// --- F6 (round 12): per-resource local-dev PLACEHOLDER metadata -----------------
// Exactly what `syncWranglerBindings` (wrangler.ts) writes for a not-yet-provisioned
// binding — a D1 entry gets `database_id: 'local'`, a KV entry `id: 'local'`, an R2
// entry `bucket_name: 'default'`. Each placeholder belongs to ITS OWN field only: the
// shared "reject both `local` and `default` everywhere" check this replaces falsely
// treated a stored R2 bucket_name of `local` — a grammar-valid, legitimately usable
// bucket name that is NOT Void's R2 placeholder — as unprovisioned, bypassing the
// stored-name contradiction gate (silent rewrite) and failing the create postcondition
// for a bucket genuinely named `default`. Placeholder rules are judged ONLY where
// read-first identity is resolved (and the R2 create postcondition's probe fallback);
// Hyperdrive has no placeholder (its 32-hex format alone excludes these words).
const D1_ID_PLACEHOLDER = 'local';
const KV_ID_PLACEHOLDER = 'local';
const R2_BUCKET_NAME_PLACEHOLDER = 'default';

// --- F4: resource-SPECIFIC real-id format validators --------------------------
// A merely non-empty string — `" "`, `"xyz"` — must never satisfy read-first reuse or
// the create postcondition, else a resource could be reported provisioned with no valid
// identifier and NO discovery. Each id class has a FIXED Cloudflare format (verified
// 2026-07 against wrangler 4.107 + live account resources):
//   - D1 `database_id`:  a hyphenated UUID (e.g. `52b3bbc7-c473-4b26-9486-1345f5de61c4`).
//   - KV namespace `id`: 32 lowercase-hex chars, no hyphens (e.g. `7c07b54c…153aa11a`).
//   - Hyperdrive `id`:   32 lowercase-hex chars, no hyphens (e.g. `a8097c6a…34ad195c`) —
//                        NOT a hyphenated UUID (confirmed from a live config).
//   - R2 identity IS the `bucket_name` (see {@link R2_BUCKET_NAME_RE}).
// These gate read-first reuse, discovery/adoption results, adoption writes, AND create
// postconditions — so a placeholder OR a malformed id fails closed (→ discovery, or a
// hard error) instead of being recorded as a real resource.
const D1_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_ID_RE = /^[0-9a-f]{32}$/i;
/** R2 bucket names ARE the identity: wrangler 4.107's `isValidR2BucketName`. */
const R2_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** A D1 `database_id` that is a real (non-placeholder) hyphenated UUID. */
function isRealD1Id(value: unknown): value is string {
  return typeof value === 'string' && value !== D1_ID_PLACEHOLDER && D1_ID_RE.test(value);
}
/** A KV namespace `id` that is a real (non-placeholder) 32-hex string. */
function isRealKvId(value: unknown): value is string {
  return typeof value === 'string' && value !== KV_ID_PLACEHOLDER && HEX32_ID_RE.test(value);
}
/** A Hyperdrive config `id` that is a real 32-hex string (no placeholder exists). */
function isRealHyperdriveId(value: unknown): value is string {
  return typeof value === 'string' && HEX32_ID_RE.test(value);
}
/** An R2 `bucket_name` satisfying wrangler's bucket-name GRAMMAR (format only). */
function isValidR2BucketNameFormat(value: unknown): value is string {
  return typeof value === 'string' && R2_BUCKET_NAME_RE.test(value);
}
/**
 * F6 — a STORED R2 `bucket_name` that names a REAL bucket, i.e. any non-empty string
 * that is not R2's own placeholder (`default`). `local` IS a real name here. Grammar is
 * deliberately not required: a grammar-invalid stored name that contradicts the desired
 * bucket must still fail closed as a contradiction, never be silently rewritten.
 */
function isRealStoredR2BucketName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== R2_BUCKET_NAME_PLACEHOLDER;
}

const defaultLogger: ProvisionLogger = {
  info: (msg) => voidLog(msg),
  warn: (msg) => voidWarn(msg),
};

/**
 * F1 — the transport-redirecting env vars wrangler 4.107 honors. Each can point
 * wrangler's authenticated API transport at a DIFFERENT endpoint (or select a
 * different env-block/account) than the ONE this provision pinned:
 *   - `CLOUDFLARE_API_BASE_URL` / `CF_API_BASE_URL` — override the API base URL directly
 *     (`getCloudflareApiBaseUrlFromEnv`).
 *   - `WRANGLER_API_ENVIRONMENT=staging` — routes to `api.staging.cloudflare.com`.
 *   - `CLOUDFLARE_COMPLIANCE_REGION=fedramp_high` — routes to `api.fed.cloudflare.com`.
 *   - `CLOUDFLARE_ENV` — selects a named `env.*` config block (different account/bindings).
 * We pin ONE resolved base explicitly (see {@link provisionEnv}) and fail closed when a
 * project dotenv would reselect one (see {@link assertNoTransportRedirectInProjectDotenv}).
 */
const TRANSPORT_REDIRECT_ENV_VARS = [
  'CLOUDFLARE_API_BASE_URL',
  'CF_API_BASE_URL',
  'WRANGLER_API_ENVIRONMENT',
  'CLOUDFLARE_COMPLIANCE_REGION',
  'CLOUDFLARE_ENV',
] as const;

/**
 * F4 — wrangler 4.107's diagnostic-output sinks that would PERSIST the raw provisioning
 * argv (including a Hyperdrive connection string, password and all) to disk:
 *   - `WRANGLER_OUTPUT_FILE_PATH` / `WRANGLER_OUTPUT_FILE_DIRECTORY` — when either is set
 *     (`getOutputFilePathFromEnv`/`getOutputFileDirectoryFromEnv`), wrangler's startup
 *     middleware appends a `wrangler-session` entry with the VERBATIM
 *     `command_line_args: argv` to that file (`writeOutput` in wrangler-dist/cli.js) — so
 *     `hyperdrive create --connection-string=postgres://user:PASSWORD@…` lands on disk.
 * They are scrubbed from every provisioner child env ({@link provisionEnv}) and fenced in
 * the project dotenv ({@link assertNoTransportRedirectInProjectDotenv}) — wrangler reloads
 * dotenv into `process.env` BEFORE writing the session entry, so a dotenv-declared sink
 * would resurrect the leak. `WRANGLER_LOG_SANITIZE` (`getSanitizeLogs`, default true) is
 * PINNED to `true` instead: a truthy ambient value survives wrangler's dotenv reload
 * (dotenv-expand keeps an already-set truthy `process.env` value), so the pin cannot be
 * overridden into unsanitized logging of the secret-bearing API request.
 */
const OUTPUT_FILE_ENV_VARS = ['WRANGLER_OUTPUT_FILE_PATH', 'WRANGLER_OUTPUT_FILE_DIRECTORY'] as const;

/**
 * F1 — resolve the ONE Cloudflare API base URL this provision is pinned to, mirroring
 * wrangler 4.107's `getCloudflareApiBaseUrl` EXACTLY (wrangler-dist/cli.js) so the
 * Hyperdrive REST lister and the spawned wrangler agree on the endpoint:
 *
 *   getCloudflareApiBaseUrl = (complianceConfig) =>
 *     getCloudflareApiBaseUrlFromEnv() ??
 *     `https://api${getComplianceRegionSubdomain(complianceConfig)}${getStagingSubdomain()}.cloudflare.com/client/v4`
 *
 * Order + semantics mirrored exactly:
 *   1. The DIRECT base override is evaluated FIRST, by PRESENCE (wrangler's env factory
 *      checks `variableName in process.env`), with `CLOUDFLARE_API_BASE_URL` taking
 *      precedence over the deprecated `CF_API_BASE_URL`. A present-but-EMPTY override is
 *      returned AS-IS: `"" ?? derived` keeps the empty string (NULLISH, not falsy,
 *      coalescing), so wrangler pins the empty base (its API calls then fail on the
 *      unparsable URL) — we mirror that instead of silently substituting an endpoint.
 *   2. Only on the DERIVED branch are the staging/compliance selectors read — wrangler's
 *      `??` short-circuits past `getComplianceRegionSubdomain`/`getStagingSubdomain` when a
 *      direct base is present, so a direct base + conflicting compliance settings resolves
 *      to the direct base in wrangler (NO conflict error) and must not be rejected here.
 *   3. On the derived branch both env selectors are choice-VALIDATED (wrangler's
 *      `getProcessEnv` → `assertOneOf` throws on any present value outside the choices,
 *      e.g. `WRANGLER_API_ENVIRONMENT=stagng` or an empty string), so an invalid selector
 *      FAILS CLOSED instead of silently pinning public production.
 *   4. The config's own `compliance_region` VALUE is validated UNCONDITIONALLY — wrangler's
 *      config validation (`isOneOf("public", "fedramp_high")` on the `compliance_region`
 *      field) rejects an invalid config value for every command regardless of which branch
 *      resolves the base.
 * Read ONCE from the REAL ambient `process.env` (which does NOT include the project `.env`
 * — Node never auto-loads it), so an ambient/CI pin is honored while a project dotenv
 * redirect is rejected up front by {@link assertNoTransportRedirectInProjectDotenv}.
 */
export function resolvePinnedApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  configComplianceRegion?: string,
): string {
  // (4) — validate the config's compliance_region value unconditionally, like wrangler's
  // config validation (a PRESENT empty string is invalid there too).
  const configRegion =
    configComplianceRegion !== undefined
      ? assertComplianceChoice(configComplianceRegion, 'the wrangler config "compliance_region"')
      : undefined;
  // (1) — presence (not truthiness) of the direct override wins, CLOUDFLARE_* first.
  const direct =
    env.CLOUDFLARE_API_BASE_URL !== undefined
      ? env.CLOUDFLARE_API_BASE_URL
      : env.CF_API_BASE_URL;
  if (direct !== undefined) {
    return direct;
  }
  // (2)+(3) — derived branch only: validate the selectors, reconcile the region.
  const region = resolveComplianceRegion(env, configRegion);
  const fed = region === 'fedramp_high' ? '.fed' : '';
  const staging = resolveApiEnvironment(env) === 'staging' ? '.staging' : '';
  return `https://api${fed}${staging}.cloudflare.com/client/v4`;
}

/**
 * F1 — mirror wrangler 4.107's `getCloudflareApiEnvironmentFromEnv` (env factory with
 * `choices: ["production", "staging"]`, default `"production"`): an ABSENT variable
 * defaults to production; a PRESENT value outside the choices — `"stagng"`, an empty
 * string — makes wrangler's `assertOneOf` throw, so we fail closed identically instead of
 * silently pinning public production where wrangler stops.
 */
function resolveApiEnvironment(env: NodeJS.ProcessEnv): 'production' | 'staging' {
  const raw = env.WRANGLER_API_ENVIRONMENT;
  if (raw === undefined) {
    return 'production';
  }
  if (raw !== 'production' && raw !== 'staging') {
    throw new Error(
      `provision: the WRANGLER_API_ENVIRONMENT environment variable must be one of ` +
        `"production" or "staging", got ${JSON.stringify(raw)}. wrangler rejects this value, so ` +
        `provisioning refuses to guess an endpoint; fix or unset it and retry.`,
    );
  }
  return raw;
}

/** F1 — the compliance-region choices wrangler 4.107 accepts (`getCloudflareComplianceRegionFromEnv`). */
const COMPLIANCE_REGIONS = ['public', 'fedramp_high'] as const;
type ComplianceRegion = (typeof COMPLIANCE_REGIONS)[number];

function assertComplianceChoice(value: string, source: string): ComplianceRegion {
  if (value !== 'public' && value !== 'fedramp_high') {
    throw new Error(
      `provision: ${source} must be one of ${COMPLIANCE_REGIONS.map((c) => JSON.stringify(c)).join(
        ' or ',
      )}, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * F1 — reconcile the effective Cloudflare compliance region, mirroring wrangler 4.107's
 * `getCloudflareComplianceRegion(complianceConfig)` EXACTLY (evaluated only on the
 * DERIVED-base branch — with a direct base override wrangler never calls it):
 *   - reads `CLOUDFLARE_COMPLIANCE_REGION` by PRESENCE and validates it against the
 *     `public`/`fedramp_high` choices (wrangler's `getProcessEnv` → `assertOneOf`, which
 *     throws on ANY present out-of-choices value — an empty string included);
 *   - when BOTH the env var AND the (already-validated) config region are set to
 *     DIFFERENT values, THROWS (fail closed) — wrangler raises a `UserError` for exactly
 *     this conflict, so we must not paper over it by pinning one endpoint while the config
 *     declares the other region;
 *   - otherwise returns `env || config || "public"` (both values are validated choices by
 *     now, so wrangler's falsy-coalescing is equivalent to nullish here).
 */
function resolveComplianceRegion(
  env: NodeJS.ProcessEnv,
  configRegion: ComplianceRegion | undefined,
): ComplianceRegion {
  const rawEnv = env.CLOUDFLARE_COMPLIANCE_REGION;
  const envRegion =
    rawEnv !== undefined
      ? assertComplianceChoice(rawEnv, 'the CLOUDFLARE_COMPLIANCE_REGION environment variable')
      : undefined;
  if (envRegion !== undefined && configRegion !== undefined && envRegion !== configRegion) {
    throw new Error(
      `provision: the Cloudflare compliance region is set to conflicting values — the ` +
        `CLOUDFLARE_COMPLIANCE_REGION environment variable is ${JSON.stringify(envRegion)} but the ` +
        `wrangler config "compliance_region" is ${JSON.stringify(configRegion)}. wrangler refuses to ` +
        `run with a mismatched compliance region; reconcile them (remove one, or set them equal) and ` +
        `retry.`,
    );
  }
  return envRegion ?? configRegion ?? 'public';
}

/**
 * F6 — wrangler 4.107's bundled `dotenv` LINE regex (verbatim), used ONLY to detect the
 * declared KEYS wrangler would load — including the OPTIONAL `export ` prefix, the `KEY: val`
 * form, and single/double/backtick quoting — so our transport-redirect fence sees exactly
 * what wrangler's per-command dotenv reload would. We read keys, never values.
 */
const WRANGLER_DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** F6 — the set of declared dotenv KEYS in `filePath`, parsed the way wrangler does. */
function scanWranglerDotenvKeys(filePath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(filePath)) {
    return keys;
  }
  const content = readFileSync(filePath, 'utf-8');
  WRANGLER_DOTENV_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WRANGLER_DOTENV_LINE.exec(content)) !== null) {
    if (match[1]) {
      keys.add(match[1]);
    }
    // Guard against a zero-width match wedging the loop.
    if (match.index === WRANGLER_DOTENV_LINE.lastIndex) {
      WRANGLER_DOTENV_LINE.lastIndex++;
    }
  }
  return keys;
}

/**
 * F6 — mirror wrangler 4.107's `getDefaultEnvFiles(env)`: base `.env`/`.env.local`, then —
 * when the environment argument is DEFINED (we always pass `--env=`, so wrangler sees
 * `args.env === ""`, which is `!== undefined`) — the per-env pair `.env.${env}`/`.env.${env}.local`.
 * With the empty environment those are the empty-env filenames `.env.` and `.env..local`.
 */
function defaultWranglerEnvFiles(env: string): Array<string> {
  return ['.env', '.env.local', `.env.${env}`, `.env.${env}.local`];
}

/**
 * F1 — FAIL CLOSED when the project's dotenv files declare a transport-redirecting
 * variable. wrangler 4.107 reloads `.env`/`.env.local` (and the dev-vars files) from the
 * project root into `process.env` on EVERY command with `override: true`, so a repo `.env`
 * setting `CLOUDFLARE_API_BASE_URL` / `WRANGLER_API_ENVIRONMENT` /
 * `CLOUDFLARE_COMPLIANCE_REGION` / `CLOUDFLARE_ENV` would redirect wrangler's authenticated
 * transport (and credentials) to a staging / FedRAMP / arbitrary endpoint AFTER we resolved
 * the pinned base — while the Hyperdrive existence check runs against the pinned base.
 * Single-account/single-endpoint provisioning cannot reason about a transport redirected
 * out from under it, so we refuse. The fix is to export the variable in the shell/CI
 * environment (which we DO honor, pinning both wrangler and the lister to it) instead of
 * the project dotenv.
 *
 * Exported for direct unit testing of the file-set and the Windows case rule; production
 * always calls it with the real `process.platform`.
 */
export function assertNoTransportRedirectInProjectDotenv(
  root: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // F5 (round 11) — scan the EXACT file sets wrangler 4.107 loads for the provisioner's
  // `--env=` (EMPTY environment string), using a KEY scanner that mirrors wrangler's own
  // dotenv parser (accepts the optional `export ` prefix + quoting):
  //   - the per-command `process.env` reload (startup middleware) uses
  //     `getDefaultEnvFiles("")` = [".env", ".env.local", ".env.", ".env..local"];
  //   - the dev-vars loader `loadDotDevDotVars(envPath, env)` probes
  //     `${envPath}.${env}` FIRST when env is defined — `.dev.vars.` for the empty env —
  //     then falls back to `.dev.vars`. It NEVER loads `.dev.vars.local`, so that file is
  //     deliberately NOT fenced (blocking it rejected configs wrangler never reads).
  // We do NOT expand — presence of the KEY is the signal.
  const files = [...defaultWranglerEnvFiles(''), '.dev.vars.', '.dev.vars'];
  // F5 — wrangler's dotenv environment is CASE-INSENSITIVE on Windows: `loadDotEnv` loads
  // into `caseInsensitiveEnv()` when `process.platform === "win32"` — a Proxy that
  // canonicalizes property names via `toLowerCase` — so a `cloudflare_api_base_url=` line
  // redirects the transport there. Compare keys case-insensitively on win32, exactly
  // elsewhere (POSIX env vars are case-sensitive).
  const caseInsensitive = platform === 'win32';
  for (const file of files) {
    const keys = scanWranglerDotenvKeys(join(root, file));
    const lowerKeys = caseInsensitive
      ? new Set([...keys].map((key) => key.toLowerCase()))
      : undefined;
    const declares = (name: string): boolean =>
      lowerKeys !== undefined ? lowerKeys.has(name.toLowerCase()) : keys.has(name);
    const offenders = TRANSPORT_REDIRECT_ENV_VARS.filter(declares);
    if (offenders.length > 0) {
      throw new Error(
        `provision: refusing to provision — the project file "${file}" sets ` +
          `${offenders.join(', ')}, which wrangler reloads on every command and would redirect its ` +
          `authenticated Cloudflare API transport (and credentials) to a different endpoint/account ` +
          `than this provision is pinned to (the Hyperdrive existence check would then run against a ` +
          `DIFFERENT endpoint, risking cross-environment writes or duplicate resources). Remove ` +
          `${offenders.join(', ')} from "${file}" and, if you truly need a non-default endpoint, ` +
          `export it in your shell/CI environment instead — that pin IS honored for both wrangler and ` +
          `the existence check.`,
      );
    }
    // F4 — wrangler's session-output sinks are fenced too: wrangler reloads this dotenv
    // into `process.env` BEFORE writing its `wrangler-session` output entry, whose
    // `command_line_args` is the VERBATIM argv — including a Hyperdrive connection
    // string's password — so a dotenv-declared sink would resurrect the leak the child-env
    // scrub (see provisionEnv) just closed.
    const outputOffenders = OUTPUT_FILE_ENV_VARS.filter(declares);
    if (outputOffenders.length > 0) {
      throw new Error(
        `provision: refusing to provision — the project file "${file}" sets ` +
          `${outputOffenders.join(', ')}, which wrangler reloads on every command and which makes ` +
          `wrangler persist its session diagnostics — including the verbatim command line, where a ` +
          `Hyperdrive connection string's password would appear — to that output file. Remove ` +
          `${outputOffenders.join(', ')} from "${file}" (set it in your shell only for ` +
          `non-provisioning wrangler commands if you need session output).`,
      );
    }
  }
}

/**
 * Child-process env with the CF Access service-token PAIR scrubbed. Mirrors
 * `buildEnv` in `deploy.ts`: a shared, long-lived Access token is needed only by
 * this CLI's own API client and must never leak into the spawned wrangler
 * process (which may in turn run user hooks). The cloudflared `CF_ACCESS_TOKEN`
 * JWT (dev path) is left untouched.
 *
 * F1 — pins ONE transport context: scrubs every {@link TRANSPORT_REDIRECT_ENV_VARS}
 * from the child env, then re-sets `CLOUDFLARE_API_BASE_URL` to the SINGLE resolved
 * `apiBaseUrl` so the spawned wrangler and the Hyperdrive REST lister hit the exact same
 * endpoint. Scrubbing the compliance/staging/env selectors makes the explicit base
 * authoritative (they can no longer re-derive a different base). Combined with
 * {@link assertNoTransportRedirectInProjectDotenv} (which blocks a project dotenv from
 * repopulating any of them via wrangler's per-command reload), the pin cannot be moved.
 */
export function provisionEnv(ctx?: {
  accountId?: string;
  apiBaseUrl?: string;
  /** Test seam for the win32 case rule; production always uses the real platform. */
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // F3 (round 12) — Windows environment keys are CASE-INSENSITIVE: the spawned child's
  // `process.env` resolves `WRANGLER_OUTPUT_FILE_PATH` from an ambient
  // `Wrangler_Output_File_Path` too, so an exact-case `delete` left every scrub below
  // bypassable by a mixed-case spelling (wrangler would then see the sink var and
  // persist the raw argv — Hyperdrive password included — to disk). Scrub EVERY
  // case-insensitive spelling of EVERY scrubbed/pinned key on win32; exact-case
  // elsewhere (POSIX env vars are case-sensitive, so other spellings are genuinely
  // different variables).
  const caseInsensitive = (ctx?.platform ?? process.platform) === 'win32';
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
  // Scrub EVERY transport-redirecting selector (CLOUDFLARE_ENV, the API-base overrides,
  // WRANGLER_API_ENVIRONMENT, CLOUDFLARE_COMPLIANCE_REGION). CLOUDFLARE_ENV would select a
  // named env-block whose account_id/bindings differ; the others would re-derive a
  // different API base. We fold their effect into the ONE explicit base below.
  for (const name of TRANSPORT_REDIRECT_ENV_VARS) {
    scrub(name);
  }
  // F4 — scrub wrangler's session-output sinks (they would persist the raw argv —
  // a Hyperdrive connection string's password included — to disk) and PIN sanitized
  // logging: never pass through an ambient `WRANGLER_LOG_SANITIZE=false` for a
  // secret-bearing invocation. A truthy pinned value also survives wrangler's
  // per-command dotenv reload (dotenv-expand keeps a set truthy process.env value).
  // The pinned keys' case-variants are scrubbed FIRST (F3) so the canonical spelling
  // below is the ONLY one the child sees — a mixed-case ambient value must never
  // shadow a pin on win32.
  for (const name of OUTPUT_FILE_ENV_VARS) {
    scrub(name);
  }
  scrub('WRANGLER_LOG_SANITIZE');
  env.WRANGLER_LOG_SANITIZE = 'true';
  // Pin the ONE resolved API base so wrangler's `getCloudflareApiBaseUrlFromEnv()` returns
  // exactly the endpoint the Hyperdrive REST lister uses (no staging/FedRAMP/arbitrary
  // split-brain). The explicit `--env=` on every argv still forces the top-level config
  // env even if a stray CLOUDFLARE_ENV survived elsewhere. Pinned by PRESENCE (F1): a
  // resolved EMPTY base (a present-but-empty ambient override, which wrangler honors via
  // its `in process.env` + nullish coalescing) is pinned as empty too, so the child
  // wrangler fails on it exactly as the ambient environment would — never silently
  // re-derived into a different endpoint than the lister uses.
  if (ctx?.apiBaseUrl !== undefined) {
    env.CLOUDFLARE_API_BASE_URL = ctx.apiBaseUrl;
  }
  // Pin the target account non-interactively (CI-safe) when known, so
  // `wrangler <res> list/create` never prompts for disambiguation AND never falls
  // back to a DIFFERENT ambient account than the one we resolved + persisted.
  // F3 — case-variants scrubbed first so the pin is unambiguous on win32.
  if (ctx?.accountId) {
    scrub('CLOUDFLARE_ACCOUNT_ID');
    env.CLOUDFLARE_ACCOUNT_ID = ctx.accountId;
  }
  return env;
}

/**
 * Hard per-command timeout for a single wrangler invocation. A hung wrangler must
 * NEVER hang the whole provision, so the default runner SIGKILLs a child that runs
 * past this and reports a HARD failure (a non-null signal — see
 * {@link normalizeRunWranglerResult}). With the ASYNC runner this bound is
 * INDEPENDENT of {@link LOCK_STALE_MS}: awaiting the child keeps the event loop free,
 * so `proper-lockfile`'s heartbeat refreshes the mutex throughout — the timeout only
 * bounds a hang, it is not load-bearing for lock safety.
 */
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * F3/F2 — after a timeout SIGKILL, how long to keep confirming the child is ACTUALLY gone —
 * BOTH its `close` event AND whole-group disappearance (`kill(-pid, 0)` → ESRCH) — before
 * giving up. SIGKILL is uncatchable, so a healthy kernel reaps the group within
 * milliseconds; this generous bound only guards a pathological uninterruptible-sleep child.
 * The runner NEVER settles a timeout as "done" until both facts are confirmed; an expiry
 * (or a failed kill) REJECTS with a {@link WranglerQuarantineError} instead, so the
 * whole-provision lock — released only after a CONFIRMED settle — is intentionally
 * retained while the real wrangler CLI may still be creating resources.
 */
const CONFIRM_KILL_GRACE_MS = 5_000;
/** F3 — the pid-poll interval while confirming post-SIGKILL termination. */
const CONFIRM_KILL_POLL_MS = 20;

/**
 * F3 — classify a process-group kill error. `ESRCH` means the group ALREADY exited (there was
 * nothing left to kill) → success. ANY other code (`EPERM`, …) is a REAL kill failure: the
 * child may still be running, so it must be surfaced, never swallowed. Exported for direct
 * unit testing of the classification the timeout/cancel paths rely on.
 */
export function isAlreadyGoneKillError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
}

/**
 * F2 (round 11) — a QUARANTINE failure: the runner could NOT confirm that a spawned
 * wrangler child (and its whole process group) is dead — the group kill failed for a
 * non-ESRCH reason (EPERM, …), or the post-SIGKILL confirmation window expired with the
 * group still (possibly) alive. The child may STILL be creating resources / writing
 * config, so the whole-provision mutex must be INTENTIONALLY RETAINED — never released —
 * and this error surfaces with manual-recovery guidance naming the surviving pid.
 * {@link provisionCloudflareResources} detects it via {@link isQuarantineError} and calls
 * `lock.quarantine()` instead of `lock.release()`.
 */
export class WranglerQuarantineError extends Error {
  readonly quarantine = true as const;
  readonly pid: number | undefined;
  constructor(pid: number | undefined, detail: string) {
    const pidLabel = pid !== undefined ? ` (pid ${pid})` : '';
    super(
      `provision: the spawned wrangler could not be confirmed terminated${pidLabel} — ${detail}. ` +
        `It may still be running and creating resources, so the cross-process provision lock is ` +
        `intentionally RETAINED (not released) and its owner is recorded in a quarantine sidecar ` +
        `("<wrangler config>.void-provision.lock.quarantine.json") that blocks concurrent ` +
        `provisions. Recovery: verify the process${pidLabel} is dead (e.g. \`kill -0 <pid>\`; ` +
        `terminate it if not) — the NEXT provision then confirms the recorded group is gone and ` +
        `clears the quarantine automatically. To clear it manually instead, remove the sidecar ` +
        `and the "<wrangler config>.void-provision.lock.lock" directory, then re-run.`,
    );
    this.name = 'WranglerQuarantineError';
    this.pid = pid;
  }
}

/**
 * F2 (round 12) — the owner metadata a quarantine records: the unconfirmed wrangler
 * child's pid (on POSIX the child is spawned `detached`, so its pid IS its process-GROUP
 * id) and a human-readable reason. Persisted in the quarantine sidecar next to the lock
 * (see {@link acquireProvisionLock}) so EVERY later acquisition can probe the recorded
 * group before the mutex could otherwise be stolen by the mtime-stale path.
 */
export interface QuarantineInfo {
  pid?: number;
  reason: string;
}

/**
 * F1/F2 (round 12) — before-death quarantine hooks. When the parent process is about to
 * DIE re-raising a forwarded SIGINT/SIGTERM while a spawned wrangler child's teardown
 * could NOT be confirmed, proper-lockfile's signal-exit sweep would remove every
 * still-TRACKED provision mutex — releasing the lock under a possibly-live child.
 * {@link provisionCloudflareResources} registers its lock's `quarantine` here for the
 * duration of the provision; the default runner's signal path invokes every hook
 * SYNCHRONOUSLY (the async quarantine rejection alone might never be observed by a
 * dying event loop) BEFORE re-raising, so the mutex directory + sidecar outlive the
 * process. Conservative on purpose: with multiple concurrent provisions in one process,
 * ALL their locks are retained at signal death (each has in-flight children of its own);
 * a needlessly-retained lock self-heals once its recorded group is confirmed dead.
 */
const quarantineBeforeDeathHooks = new Set<(info: QuarantineInfo) => void>();

function runQuarantineBeforeDeathHooks(info: QuarantineInfo): void {
  for (const hook of [...quarantineBeforeDeathHooks]) {
    try {
      hook(info);
    } catch {
      // Never let a failing hook block the re-raise; retention is best-effort here and
      // the async quarantine rejection still surfaces the failure where possible.
    }
  }
}

/** F2 — true when `error` is a quarantine failure whose provision lock must stay retained. */
export function isQuarantineError(error: unknown): error is WranglerQuarantineError {
  return (
    error instanceof WranglerQuarantineError ||
    (error as { quarantine?: boolean } | null)?.quarantine === true
  );
}

/**
 * Default `runWrangler`: resolves the project-local wrangler as an ARGV launcher
 * via Task 2's {@link resolveWranglerArgv} and runs it with `spawn` and
 * `shell: false`, so every argument is passed literally (no shell parsing → no
 * injection). Captures stdout (for `--json` parsing) and stderr (for
 * error/collision detection). Never called in unit tests — those inject a stub.
 *
 * F1 — ASYNC (returns a Promise). `spawn` + `await` (vs. the old blocking
 * `spawnSync`) keeps the Node event loop free while wrangler runs, so
 * `proper-lockfile`'s update timer keeps refreshing the mutex mtime for the WHOLE
 * provision — no wrangler call, however slow, can freeze the loop long enough for
 * another process to see the lock stale and steal it while we still hold it. A
 * {@link COMMAND_TIMEOUT_MS} SIGKILL guards against a hung child.
 */
export function createDefaultRunWrangler(
  root: string,
  options?: {
    /** F2 test seam — the argv launcher. Defaults to the real wrangler CLI entry. */
    launcher?: Array<string>;
    /** F2 test seam — the per-command timeout. Defaults to {@link COMMAND_TIMEOUT_MS}. */
    timeoutMs?: number;
    /**
     * F3 test seam — the process-GROUP signaller (`target` is the value passed to
     * `process.kill`: a NEGATIVE pid for the group). Defaults to `process.kill`. Tests inject
     * it to exercise the ESRCH-already-gone and real-kill-failure branches.
     */
    killProcessGroup?: (target: number, signal: NodeJS.Signals) => void;
    /**
     * F2 test seam — the post-kill termination-confirmation window. Defaults to
     * {@link CONFIRM_KILL_GRACE_MS}. Tests shrink it to exercise the quarantine expiry.
     */
    confirmKillGraceMs?: number;
  },
): RunWrangler {
  // F2 — `resolveWranglerArgv` now yields wrangler's REAL CLI entry
  // (`wrangler-dist/cli.js`), NOT the `bin.wrangler` wrapper, so a SIGKILL from the
  // timeout below hits the real process (the wrapper could neither relay the kill nor
  // be trusted to report the exit code — see `resolveWranglerArgv`).
  const launcher = options?.launcher ?? resolveWranglerArgv(root);
  const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const confirmGraceMs = options?.confirmKillGraceMs ?? CONFIRM_KILL_GRACE_MS;
  const killProcessGroup =
    options?.killProcessGroup ??
    ((target: number, signal: NodeJS.Signals) => process.kill(target, signal));
  const [command, ...prefix] = launcher;
  // POSIX: spawn the child as its OWN process-group leader (`detached`) so the timeout
  // can SIGKILL the WHOLE group (`process.kill(-pid, …)`) — reaping any grandchildren
  // (e.g. an esbuild service) that would otherwise linger holding the inherited pipes.
  // Windows has no process groups here; the direct (wrapper-free) CLI has no grandchild
  // to strand, so a plain `child.kill` suffices.
  const isWindows = process.platform === 'win32';
  return (args, opts) =>
    new Promise<RunWranglerResult>((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...prefix, ...args], {
        cwd: opts.cwd ?? root,
        shell: false,
        // F1 — pin the account + API base PER CALL from the transport context, so the
        // spawned wrangler targets the SAME reconciled account + endpoint the config +
        // Hyperdrive REST path use (no split-brain between the config pin and the
        // ambient/dotenv env).
        env: provisionEnv({ accountId: opts.accountId, apiBaseUrl: opts.apiBaseUrl }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      // F1 (round 12) — ONE termination state machine for EVERY spawned-child outcome
      // (normal close, timeout, parent signal, kill failure). The TWO facts every path
      // must confirm before the promise may settle — and before a forwarded parent
      // signal may be re-raised:
      //   `closed`    — the child's `close` event fired (process exited + stdio drained);
      //   `groupGone` — the whole process GROUP is confirmed gone (`kill(-pid, 0)` → ESRCH;
      //                 trivially true where no group exists: Windows, or no pid).
      // NO path settles-and-releases (or re-raises) without BOTH; an unconfirmable
      // teardown instead QUARANTINES — rejects with a {@link WranglerQuarantineError}
      // (lock intentionally retained; on the signal path the before-death hooks retain
      // it synchronously first).
      let closed = false;
      let groupGone = false;
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // F3 — signal the child's WHOLE process group (it is `detached`, so its own group leader).
      // Returns a STRUCTURED outcome so the caller distinguishes ESRCH ("already gone" →
      // success) from a REAL kill failure (EPERM/… → the child may still be running → surface).
      const signalGroup = (signal: NodeJS.Signals): 'signaled' | 'gone' | { error: Error } => {
        try {
          if (!isWindows && typeof child.pid === 'number') {
            killProcessGroup(-child.pid, signal); // negative pid → the whole group
          } else {
            child.kill(signal);
          }
          return 'signaled';
        } catch (error) {
          return isAlreadyGoneKillError(error) ? 'gone' : { error: error as Error };
        }
      };

      /** True when the whole process group no longer exists (`kill(-pid, 0)` → ESRCH). */
      const probeGroupGone = (): boolean => {
        if (groupGone) {
          return true;
        }
        if (isWindows || typeof child.pid !== 'number') {
          // No process-group concept — `close` is the only (and sufficient) confirmation.
          groupGone = true;
          return true;
        }
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            groupGone = true;
          }
          // EPERM → some group member exists but we cannot signal it — treat as ALIVE
          // (fail safe: never confirm on a probe we could not perform).
        }
        return groupGone;
      };

      const timeoutStderr = (extra?: string): string =>
        [stderr, `provision: wrangler exceeded the ${timeoutMs}ms command timeout`, extra]
          .filter(Boolean)
          .join('\n');

      const detachSignals = (): void => {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
      };

      const finish = (result: RunWranglerResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        detachSignals();
        resolvePromise(result);
      };

      // F2 — settle by REJECTING with a quarantine error: the child could not be confirmed
      // dead, so the caller must retain the whole-provision lock (never release it under a
      // possibly-live child) and surface manual-recovery guidance.
      const quarantine = (detail: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        detachSignals();
        rejectPromise(new WranglerQuarantineError(child.pid, detail));
      };

      // F1 (round 12) — the ONE bounded both-facts confirmation loop, shared by the
      // settle side (normal close + timeout) and the parent-signal side. Polls until
      // BOTH facts hold, then `onConfirmed`; at `confirmGraceMs` unconfirmed,
      // `onExpiry`. `close` nudges every active poll for promptness. Poll timers are
      // REFERENCED (no unref): confirmation must keep the event loop alive until the
      // outcome is known — an unref'd timer would let the process exit mid-confirm
      // (status 0, exit hooks sweeping the mutex). A settle-side poll self-terminates
      // once the promise settled (≤ one 20ms tick later); the signal-side poll must
      // keep going regardless (it still has a fatal signal to re-raise).
      const confirmPollNudges: Array<() => void> = [];
      const nudgeConfirmPolls = (): void => {
        for (const poll of [...confirmPollNudges]) {
          poll();
        }
      };
      const awaitConfirmedDead = (handlers: {
        stopWhenSettled: boolean;
        onConfirmed: () => void;
        onExpiry: () => void;
      }): void => {
        const deadline = Date.now() + confirmGraceMs;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const poll = (): void => {
          clearTimeout(pollTimer); // idempotent under an external nudge
          if (handlers.stopWhenSettled && settled) {
            return;
          }
          if (closed && probeGroupGone()) {
            handlers.onConfirmed();
            return;
          }
          if (Date.now() >= deadline) {
            handlers.onExpiry();
            return;
          }
          pollTimer = setTimeout(poll, CONFIRM_KILL_POLL_MS);
        };
        confirmPollNudges.push(poll);
        poll();
      };

      // Settle side of the machine: confirm BOTH facts, then resolve with `makeResult`;
      // an unconfirmed window QUARANTINES (rejects; lock retained) — never a silent
      // settle-and-release while the real CLI (or a group member) may still be running.
      const confirmThenSettle = (makeResult: () => RunWranglerResult, what: string): void => {
        awaitConfirmedDead({
          stopWhenSettled: true,
          onConfirmed: () => finish(makeResult()),
          onExpiry: () =>
            quarantine(
              `the process group could not be confirmed terminated within ${confirmGraceMs}ms ` +
                `of ${what}`,
            ),
        });
      };

      // F3/F2 — forward a parent SIGINT/SIGTERM to the child's process GROUP so a Ctrl-C /
      // termination tears the DETACHED child (+ grandchildren) down instead of orphaning it.
      // After forwarding, AWAIT confirmed (bounded) teardown — BOTH facts — BEFORE
      // re-raising the signal on the parent: re-raising kills the parent, whose
      // proper-lockfile exit hook removes the whole-provision mutex while the child may
      // STILL be creating resources.
      // F1 (round 12): an UNCONFIRMED teardown (kill failure OR grace expiry) FIRST
      // transitions to quarantine — the before-death hooks retain every active provision
      // mutex SYNCHRONOUSLY (writing the F2 sidecar) and the promise rejects with a
      // {@link WranglerQuarantineError} — and only THEN warns + re-raises. It never
      // re-raises straight over a possibly-live child.
      const forwardSignal = (signal: NodeJS.Signals) => (): void => {
        // Detach first so the re-raise takes Node's default exit-on-signal action.
        detachSignals();
        const reRaise = (): void => {
          process.kill(process.pid, signal);
          // Signals are delivered asynchronously: if the event loop has drained by now,
          // the process would exit NORMALLY (status 0) before the pending signal lands.
          // A short REFERENCED no-op keeps the loop alive so the re-raised signal's
          // default action terminates the process (it fires within milliseconds; the
          // timer is only a bounded fallback if something else swallowed the signal).
          setTimeout(() => {}, 2_000);
        };
        const quarantineThenReRaise = (detail: string): void => {
          runQuarantineBeforeDeathHooks({
            pid: child.pid,
            reason:
              `the spawned wrangler could not be confirmed terminated after a forwarded ` +
              `${signal} — ${detail}`,
          });
          process.stderr.write(
            `provision: warning — the wrangler child process group` +
              `${typeof child.pid === 'number' ? ` (pid ${child.pid})` : ''} could not be ` +
              `confirmed terminated after ${signal} (${detail}). It may still be running; the ` +
              `provision lock is retained (quarantined) — verify the process is dead before ` +
              `re-running provision.\n`,
          );
          quarantine(detail);
          reRaise();
        };
        const outcome = signalGroup(signal);
        if (typeof outcome === 'object') {
          quarantineThenReRaise(
            `the process group could not be signalled: ${outcome.error.message}`,
          );
          return;
        }
        if (outcome === 'gone') {
          // ESRCH ⇒ the whole group already exited — only `close` remains to be seen.
          groupGone = true;
        }
        awaitConfirmedDead({
          stopWhenSettled: false,
          onConfirmed: reRaise,
          onExpiry: () =>
            quarantineThenReRaise(
              `the process group did not terminate within ${confirmGraceMs}ms of the ` +
                `forwarded ${signal}`,
            ),
        });
      };
      const onSigint = forwardSignal('SIGINT');
      const onSigterm = forwardSignal('SIGTERM');
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);

      // Hard timeout: SIGKILL the whole group, then AWAIT CONFIRMED termination before
      // settling — so the whole-provision lock (released only after this promise settles)
      // can NEVER be released while the real wrangler CLI is still alive. A kill FAILURE is
      // a QUARANTINE (rejects; lock retained), never a settle-and-release.
      const commandTimer = setTimeout(() => {
        timedOut = true;
        const outcome = signalGroup('SIGKILL');
        if (typeof outcome === 'object') {
          // A REAL kill failure (not ESRCH). The child MAY still be running — QUARANTINE.
          quarantine(`the process group could not be killed: ${outcome.error.message}`);
          return;
        }
        if (outcome === 'gone') {
          groupGone = true;
        }
        confirmThenSettle(
          () =>
            normalizeRunWranglerResult({
              stdout,
              stderr: timeoutStderr(),
              status: null,
              signal: 'SIGKILL',
            }),
          `the timeout SIGKILL (${timeoutStderr()})`,
        );
      }, timeoutMs);
      // REFERENCED (no unref): if every other handle unrefs (pipes closed by a child that
      // never exits), an unref'd deadline would let the event loop drain and the process
      // exit 0 mid-command. It is cleared in finish/quarantine, so a completed call never
      // holds the loop open.

      // A spawn error (ENOENT, EACCES) may fire `error` WITHOUT a later `close`, so
      // settle here too — a HARD failure (never mistaken for a clean/absent exit). The
      // child never RAN (no live pid/group), so there is nothing to confirm dead — the
      // one deliberate carve-out from the both-facts rule.
      child.on('error', (error: Error) => {
        finish(normalizeRunWranglerResult({ stdout, stderr, status: null, signal: null, error }));
      });
      child.on('close', (code, signal) => {
        closed = true;
        if (timedOut) {
          // The timeout path's confirm poll settles once the group is ALSO confirmed
          // gone (both facts). Nudge every active poll now for promptness.
          nudgeConfirmPolls();
          return;
        }
        // The command itself is DONE — the hard timeout no longer applies; only group
        // confirmation remains (bounded by its own grace window below).
        clearTimeout(commandTimer);
        // F1 (round 12) — `close` alone is NOT sufficient to settle: a same-group
        // grandchild with its OWN stdio survives the leader (so `close` fires with the
        // group still alive) and could keep creating resources after the provision lock
        // is released. Resolve ONLY once the whole group is confirmed gone; if members
        // linger, SIGKILL the group (exactly like the timeout path) and confirm within
        // the bounded window — an unconfirmable group QUARANTINES.
        const makeResult = (): RunWranglerResult =>
          normalizeRunWranglerResult({ stdout, stderr, status: code, signal });
        if (probeGroupGone()) {
          finish(makeResult());
          return;
        }
        const outcome = signalGroup('SIGKILL');
        if (typeof outcome === 'object') {
          quarantine(
            `the child exited (status ${String(code)}) but its process group is still alive ` +
              `and could not be killed: ${outcome.error.message}`,
          );
          return;
        }
        if (outcome === 'gone') {
          groupGone = true;
        }
        confirmThenSettle(
          makeResult,
          `the child's exit (status ${String(code)}; surviving process-group members were ` +
            `SIGKILLed)`,
        );
        // Let the signal-side poll (if any) observe `closed` promptly too.
        nudgeConfirmPolls();
      });
    });
}

/**
 * Normalize a `spawnSync` result into a {@link RunWranglerResult}, treating a
 * signal-killed child or a spawn error as a FAILURE — never success.
 *
 * The naive `status ?? (error ? 1 : 0)` collapses a SIGTERM'd child (which
 * returns `status: null`, a non-null `signal`, and NO `error`) to `0`, so a
 * killed `create` would be recorded as `created` though nothing happened. So we
 * fail on ANY non-numeric `status`, a non-null `signal`, or a present `error`,
 * and surface the signal/spawn-error text in `stderr` for diagnostics.
 */
export function normalizeRunWranglerResult(result: {
  stdout?: string | null;
  stderr?: string | null;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}): RunWranglerResult {
  const stdout = result.stdout ?? '';
  const notes: Array<string> = [];
  if (result.signal != null) {
    notes.push(`provision: wrangler was terminated by signal ${result.signal}`);
  }
  if (result.error != null) {
    notes.push(`provision: wrangler could not be spawned: ${result.error.message}`);
  }
  const failed = typeof result.status !== 'number' || result.signal != null || result.error != null;
  // A failure must be non-zero. Keep a genuine non-zero exit code when present;
  // otherwise synthesize `1` (a null/absent status under a signal/spawn error).
  const status = failed
    ? typeof result.status === 'number' && result.status !== 0
      ? result.status
      : 1
    : (result.status as number);
  const baseStderr = result.stderr ?? '';
  const stderr = notes.length > 0 ? [baseStderr, ...notes].filter(Boolean).join('\n') : baseStderr;
  // Preserve the provenance STRUCTURALLY (not just folded into stderr text) so
  // downstream classifiers can distinguish a clean non-zero exit (which MAY carry
  // a not-found signal) from a kill/spawn-error (which never may).
  return {
    stdout,
    stderr,
    status,
    signal: result.signal ?? null,
    error: result.error != null ? result.error.message : null,
  };
}

/**
 * THE single provenance rule. A result is a HARD failure when the child was
 * signal-killed or could not be spawned: it did not run to completion, so its
 * buffered status/stdout/stderr is unreliable and must NEVER be read as "absent"
 * or "success". Every success/absence/adopt classifier below defers to this.
 */
function isHardFailure(result: RunWranglerResult): boolean {
  return result.signal != null || result.error != null;
}

/** The child ran to completion and reported SUCCESS (a clean numeric exit 0). */
function isCleanSuccess(result: RunWranglerResult): boolean {
  return !isHardFailure(result) && result.status === 0;
}

/**
 * The child ran to completion and reported a FAILURE status (a numeric non-zero
 * exit, no signal, no spawn error) — the ONLY case whose stdout/stderr may be
 * classified for a resource-specific not-found signal.
 */
function isCleanFailure(result: RunWranglerResult): boolean {
  return !isHardFailure(result) && typeof result.status === 'number' && result.status !== 0;
}

/**
 * F4 — the OVERALL deadline for the Hyperdrive existence lister (across ALL its paginated
 * requests). A stalled body or a never-settling injected seam must never hold the
 * whole-provision lock (whose heartbeat keeps refreshing while the loop is free) forever, so
 * the caller fails closed at this bound.
 */
const HYPERDRIVE_LIST_TIMEOUT_MS = 60_000;

/**
 * F4 — run a lister call under an OVERALL deadline. Builds one `AbortController`, hands its
 * signal to `start` (threaded into every paginated `fetch`), and races the returned promise
 * against a timer that ABORTS the signal AND rejects — so even a seam that ignores the signal
 * (never settling) can NOT hold the caller (and thus the provision lock) past `ms`.
 */
function withListerDeadline<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the existence check exceeded the ${ms}ms deadline`));
    }, ms);
    // F3 (round 11) — the deadline timer stays REFERENCED until the lister settles (both
    // settle arms below clear it). An unref'd timer let a real CLI process EXIT 0 before
    // the deadline fired: with a never-settling lister nothing else holds the loop —
    // proper-lockfile's heartbeat is unref'd too — so the loop drained and the process
    // exited mid-provision reporting success. Vitest's own handles masked this in-worker;
    // the child-process regression test spawns a real node process to prove it.
    // Defer `start` into the promise chain so a synchronous throw is captured as a rejection.
    Promise.resolve()
      .then(() => start(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Default Hyperdrive existence check: `GET /accounts/{id}/hyperdrive/configs`
 * with the CF API token, matched by name in the caller. Returns `undefined` when
 * it cannot be built (no account id / no token) — the caller then fails closed
 * before any blind create. Never called in unit tests — those inject a stub.
 */
function createDefaultListHyperdriveConfigs(apiToken?: string): ListHyperdriveConfigs | undefined {
  const token = apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return undefined;
  }
  // F1 — the account AND the pinned API base come from the per-call transport context
  // (not a closure), so this default REST lister always targets the reconciled effective
  // account at the SAME endpoint the spawned wrangler uses (never a hardcoded prod base
  // while wrangler was redirected to staging/FedRAMP/an arbitrary endpoint).
  return async ({ accountId, apiBaseUrl, signal }) => {
    // F4 (round 12) — build every request URL with wrangler 4.107's EXACT concatenation
    // semantics. wrangler's `performApiFetchBase` (wrangler-dist/cli.js) fetches
    //   `${getCloudflareApiBaseUrl(complianceConfig)}${resource}${queryString}`
    // where the pinned base is used VERBATIM (a direct CLOUDFLARE_API_BASE_URL override
    // is returned as-is by `getCloudflareApiBaseUrlFromEnv() ?? …` — never trimmed or
    // normalized) and its hyperdrive `listConfigs` resource interpolates the account id
    // RAW: `/accounts/${accountId}/hyperdrive/configs`. The old one-sided
    // trailing-slash strip made this lister and the spawned wrangler hit DIFFERENT
    // endpoints on a custom base ending in `/` (`…/api/accounts/…` vs
    // `…/api//accounts/…`), so the existence check could disagree with the create.
    // Mirror the concatenation byte-for-byte instead — no trimming, no encoding.
    const perPage = 100;
    const listUrl = (page: number): string =>
      `${apiBaseUrl}/accounts/${accountId}/hyperdrive/configs?page=${page}&per_page=${perPage}`;
    // Fetch ALL pages (Hyperdrive names are NOT unique — paid accounts allow
    // ~25 configs, paginated) and FAIL CLOSED on any non-2xx, `success !== true`,
    // or a malformed entry. Never coerce a malformed envelope/entry to "absence":
    // that would mint a duplicate config on a re-run.
    //
    // Completeness is PROVEN, not assumed: we require consistent pagination
    // metadata (`result_info.total_count`) and keep going until the DISTINCT
    // config count equals it. Any of — missing metadata, an empty page before all
    // configs are seen, a repeated/duplicate id, an inconsistent total, or an
    // overshoot — throws (fail closed) rather than silently declaring the list
    // complete (which could miss a same-named config on an unread page and mint a
    // duplicate).
    const byId = new Map<string, HyperdriveConfig>();
    let expectedTotal: number | undefined;
    for (let page = 1; ; page++) {
      const res = await fetch(
        listUrl(page),
        // F4 — apply the caller's deadline signal to EVERY paginated request, so a stalled
        // body / never-settling page is aborted rather than holding the provision lock forever.
        { headers: { Authorization: `Bearer ${token}` }, signal },
      );
      if (!res.ok) {
        throw new Error(`Cloudflare API returned HTTP ${res.status} listing Hyperdrive configs`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (!isRecord(body) || body.success !== true || !Array.isArray(body.result)) {
        throw new Error(
          'Cloudflare API returned an unsuccessful or malformed Hyperdrive configs payload',
        );
      }
      // Pagination metadata is REQUIRED to prove completeness. Its absence means
      // we cannot know whether more pages exist → fail closed.
      const info = body.result_info;
      const totalCount =
        isRecord(info) && typeof info.total_count === 'number' && Number.isInteger(info.total_count)
          ? info.total_count
          : undefined;
      if (totalCount === undefined || totalCount < 0) {
        throw new Error(
          'Cloudflare API returned Hyperdrive configs without valid pagination metadata ' +
            '(result_info.total_count); cannot prove the list is complete',
        );
      }
      if (expectedTotal === undefined) {
        expectedTotal = totalCount;
      } else if (totalCount !== expectedTotal) {
        throw new Error(
          'Cloudflare API returned inconsistent Hyperdrive pagination totals across pages; ' +
            'cannot prove the list is complete',
        );
      }
      // An empty page before we have gathered every config is premature truncation.
      if (body.result.length === 0 && byId.size < expectedTotal) {
        throw new Error(
          'Cloudflare API returned an empty Hyperdrive page before all configs were listed; ' +
            'cannot prove the list is complete',
        );
      }
      for (const entry of body.result) {
        if (
          !isRecord(entry) ||
          typeof entry.id !== 'string' ||
          entry.id.length === 0 ||
          typeof entry.name !== 'string' ||
          entry.name.length === 0
        ) {
          throw new Error(
            'Cloudflare API returned a malformed Hyperdrive config entry (missing id/name)',
          );
        }
        if (byId.has(entry.id)) {
          throw new Error(
            'Cloudflare API returned a duplicate Hyperdrive config id across pages; ' +
              'cannot prove the list is complete',
          );
        }
        byId.set(entry.id, { id: entry.id, name: entry.name });
      }
      if (byId.size > expectedTotal) {
        throw new Error(
          'Cloudflare API returned more Hyperdrive configs than result_info.total_count; ' +
            'cannot prove the list is complete',
        );
      }
      // Done ONLY when the distinct count matches the proven total. Each remaining
      // iteration adds ≥1 distinct id (a duplicate or empty page threw above), so
      // this loop is bounded by `expectedTotal`.
      if (byId.size === expectedTotal) {
        break;
      }
    }
    // NOTE: the per-entry id/name + duplicate-id checks above are needed for this REST
    // path's pagination-completeness PROOF (the `byId` map). They are NOT the adoption
    // gate: `selectHyperdriveMatch` at the CALLER is the single authoritative validator
    // that covers BOTH this default path AND any injected lister (F3).
    return [...byId.values()];
  };
}

/**
 * F3/F4 — the ONE strict Hyperdrive-list validator, applied at the CALLER after EITHER
 * lister returns (the default fetch OR an injected seam), so validation can never live
 * only inside the default fetch. Validates EVERY member up front — BEFORE any name
 * filtering: rejects any non-object member, empty/non-string `name`, and duplicate `id`,
 * AND (F4) requires every member's `id` to be a REAL 32-hex Hyperdrive id (not merely
 * non-empty). A malformed id on ANY member means the list is untrustworthy, so we fail
 * closed rather than skip that member and mistake the target for absent. Then requires
 * EXACTLY 0 or 1 exact-name match (>1 is ambiguous — Hyperdrive names are NOT
 * account-unique — and fails closed) BEFORE any match/write. Returns the single
 * exact-name match, or `undefined` when none matches.
 */
function selectHyperdriveMatch(
  configs: Array<unknown>,
  name: string,
  configPath: string,
): HyperdriveConfig | undefined {
  const seenIds = new Set<string>();
  const validated: Array<HyperdriveConfig> = [];
  for (const config of configs) {
    if (
      !isRecord(config) ||
      typeof config.id !== 'string' ||
      config.id.length === 0 ||
      typeof config.name !== 'string' ||
      config.name.length === 0
    ) {
      throw new Error(
        `provision: the Hyperdrive existence check returned a malformed config entry (each must be ` +
          `an object with a non-empty string id and name). Cannot verify whether ` +
          `${JSON.stringify(name)} already exists; refusing to create a possible duplicate.`,
      );
    }
    // F4 — EVERY member's id must be a real 32-hex Hyperdrive id, checked BEFORE name
    // filtering. A non-empty-but-malformed id (`" "`, `"xyz"`) on any member means the
    // list is untrustworthy → fail closed (never skip it and mistake the target for
    // absent, which would mint a duplicate config).
    if (!isRealHyperdriveId(config.id)) {
      throw new Error(
        `provision: the Hyperdrive existence check returned a config ` +
          `${JSON.stringify(config.name)} with a malformed id ${JSON.stringify(config.id)} ` +
          `(expected a 32-character hex Hyperdrive id). Cannot verify whether ` +
          `${JSON.stringify(name)} already exists; refusing to create a possible duplicate.`,
      );
    }
    if (seenIds.has(config.id)) {
      throw new Error(
        `provision: the Hyperdrive existence check returned a duplicate config id ` +
          `${JSON.stringify(config.id)}. Cannot verify existing configs; refusing to create a ` +
          `possible duplicate.`,
      );
    }
    seenIds.add(config.id);
    validated.push({ id: config.id, name: config.name });
  }
  const named = validated.filter((c) => c.name === name);
  if (named.length > 1) {
    throw new Error(
      `provision: cannot adopt Hyperdrive config ${JSON.stringify(name)} — ${named.length} configs ` +
        `in this account share that name (ids: ${named.map((c) => c.id).join(', ')}). Hyperdrive ` +
        `names are not account-unique; remove the duplicates or pin the id in "${configPath}", then ` +
        `retry.`,
    );
  }
  return named[0];
}

// --- F1/F2: whole-provision cross-process lock (proper-lockfile) ----------------
// TWO independent races must be serialized across processes, so ONE lock is held for
// the WHOLE provision (acquired before the first config read, released in `finally`):
//   1. Account reconciliation (F1). A first-run provision READS → RECONCILES → PERSISTS
//      one effective `account_id`. Two first-run processes for accounts A and B could
//      otherwise both see no `account_id`, overwrite each other, and then write an
//      A-side result into a now-B-pinned config. Under the lock the second process
//      re-reads the persisted account and FAILS CLOSED on mismatch (or reuses).
//   2. Hyperdrive list→create (round 6). Hyperdrive is unguarded and its names are NOT
//      account-unique, so two concurrent provisions could both see "no match" and both
//      create a permanent orphaned duplicate. Under the lock the second run's
//      read-first sees the id the first wrote and SKIPS.
// The hand-rolled O_EXCL lock this replaces had classic protocol bugs (a freshly
// created file is visible before its metadata is written; age-only expiry ignoring a
// live owner; a check-then-unlink stale-takeover race; an ownerless release that could
// remove a successor's lock). `proper-lockfile` does atomic `mkdir`-based acquisition,
// mtime-refresh so a live owner never expires by age, stale-compromise detection, and
// ownership-scoped release.

interface ProvisionLock {
  /**
   * Drop the mutex. F2 — REJECTS on a genuine (non-`onCompromised`) unlock failure so a
   * LEAKED lock is surfaced, never hidden behind a "successful" provision. Idempotent:
   * repeated calls return the SAME settled promise.
   */
  release: () => Promise<void>;
  /**
   * F2 (round 11) — RETAIN the mutex intentionally (quarantine): a spawned wrangler child
   * could not be confirmed dead, so the on-disk mutex directory must OUTLIVE this process
   * to keep blocking concurrent provisions. `proper-lockfile` registers a signal-exit
   * sweep that `rmdirSync`s every still-TRACKED lock on process exit, so simply "not
   * releasing" is not enough — this detaches the lock from the library's internal
   * tracking (stopping the mtime heartbeat too), leaving the mutex directory on disk.
   *
   * F2 (round 12) — it ALSO persists the quarantine OWNER METADATA (`info`: the
   * unconfirmed child's pid/pgid + reason + timestamp) in an atomically-written sidecar
   * next to the lock (`<lock>.quarantine.json`). The retained mutex is NO LONGER
   * released by mere age: every later acquisition gates on the sidecar first (see
   * {@link acquireProvisionLock}) — it proceeds only after probing the recorded group
   * dead (ESRCH), clearing the sidecar + stale mutex itself; while the group may live
   * (or the probe fails) it FAILS CLOSED. Idempotent; a later `release()` becomes a
   * no-op (`ERELEASED` → success) and never removes the retained directory.
   */
  quarantine: (info: QuarantineInfo) => void;
}

/** F2 (round 12) — the quarantine sidecar path for a lock target. */
function quarantineSidecarPath(lockTarget: string): string {
  return `${lockTarget}.quarantine.json`;
}

/**
 * F2 (round 12) — atomically persist the quarantine owner metadata: write a temp file,
 * then `rename` over the final path, so a concurrent acquisition gate can never read
 * partial JSON. On POSIX the spawned wrangler child is `detached` (its own process-group
 * leader), so the recorded `pgid` IS its pid; Windows has no process groups (the gate
 * probes the pid directly there).
 */
function writeQuarantineSidecar(sidecarPath: string, info: QuarantineInfo): void {
  const payload = JSON.stringify(
    {
      pid: info.pid ?? null,
      pgid: process.platform === 'win32' ? null : (info.pid ?? null),
      reason: info.reason,
      quarantinedAt: new Date().toISOString(),
      quarantinedBy: process.pid,
    },
    null,
    2,
  );
  const tmpPath = `${sidecarPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, payload);
  renameSync(tmpPath, sidecarPath);
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * F2 (round 12) — the quarantine acquisition GATE. Every provision acquires its mutex
 * through {@link acquireProvisionLock} (the single choke point — grep-proven: no other
 * code calls `lockfile.lock`), and this gate runs BEFORE proper-lockfile is even
 * consulted, so a QUARANTINED mutex can never be stolen by the mtime-stale path while
 * the recorded wrangler process group may still be alive:
 *   - no sidecar → nothing quarantined → proceed to normal acquisition;
 *   - sidecar present → probe the recorded group (`kill(-pgid, 0)`; the plain pid where
 *     no group exists): ESRCH (confirmed dead) → clear the sidecar and proceed; still
 *     alive OR the probe fails (EPERM, no recorded pid, unreadable sidecar) → FAIL
 *     CLOSED with the recorded metadata + manual-recovery guidance. PID reuse can make
 *     a dead group probe "alive" — that keeps failing closed (the safe direction; the
 *     guidance covers manual clearance).
 * Clearing touches ONLY the sidecar (unlink, ENOENT-tolerant — concurrent clearers are
 * fine). The retained mutex DIRECTORY is deliberately NOT removed by hand: its
 * heartbeat stopped at quarantine, so proper-lockfile's own stale lifecycle reclaims it
 * during the acquisition below — a manual rmdir here could race a concurrent acquirer's
 * fresh mutex (remove-then-acquire is not atomic across processes) and let two
 * provisions hold the lock at once.
 */
function assertQuarantineClearedOrClear(lockTarget: string): void {
  const sidecarPath = quarantineSidecarPath(lockTarget);
  if (!existsSync(sidecarPath)) {
    return;
  }
  let recorded: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    recorded = isRecord(parsed) ? parsed : undefined;
  } catch {
    recorded = undefined;
  }
  const pid = readPositiveInt(recorded?.pid);
  const pgid = readPositiveInt(recorded?.pgid);
  const reason = typeof recorded?.reason === 'string' ? recorded.reason : undefined;
  const quarantinedAt =
    typeof recorded?.quarantinedAt === 'string' ? recorded.quarantinedAt : undefined;
  // Prefer the recorded GROUP (negative-pid probe); fall back to the plain pid where no
  // group was recorded (Windows). No probe target at all → cannot verify → fail closed.
  const probeTarget = pgid !== undefined ? -pgid : pid;
  let confirmedDead = false;
  if (probeTarget !== undefined) {
    try {
      process.kill(probeTarget, 0);
      // Signal 0 succeeded — some member of the recorded group still exists → alive.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        confirmedDead = true;
      }
      // EPERM/other — the probe could not be performed → treat as possibly alive.
    }
  }
  if (!confirmedDead) {
    const who =
      pid !== undefined || pgid !== undefined
        ? `process group ${String(pgid ?? pid)}`
        : 'an unrecorded process';
    throw new Error(
      `provision: refusing to provision — a previous provision QUARANTINED this config's lock ` +
        `because a spawned wrangler child could not be confirmed terminated (${who}` +
        `${quarantinedAt ? `, quarantined at ${quarantinedAt}` : ''}` +
        `${reason ? `; reason: ${reason}` : ''}). It may still be creating resources. Verify the ` +
        `process is dead (e.g. \`kill -0 ${String(pid ?? '<pid>')}\`; terminate it if not) and ` +
        `re-run — the quarantine then clears automatically. If you are CERTAIN the recorded ` +
        `process is unrelated (pid reuse) or gone, remove "${sidecarPath}" and the ` +
        `"${lockTarget}.lock" directory manually, then retry.`,
    );
  }
  // Confirmed dead → clear the sidecar ONLY (see the doc comment: the retained mutex
  // directory is reclaimed by proper-lockfile's stale lifecycle, never by hand).
  try {
    unlinkSync(sidecarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // Another acquirer cleared it concurrently — proceed to normal acquisition.
  }
}

/**
 * F2 — `proper-lockfile`'s INTERNAL lock registry, used ONLY by {@link ProvisionLock.quarantine}
 * to detach a retained lock from the library's exit sweep (`onExit` → `rmdirSync` of every
 * tracked mutex) and stop its mtime-refresh heartbeat. `getLocks` is exported by
 * `proper-lockfile/lib/lockfile.js` (not re-exported from the package root). Loaded lazily
 * and defensively: if a future proper-lockfile reshapes its internals, quarantine degrades
 * to "retained until process exit" instead of crashing.
 */
type ProperLockfileInternals = {
  getLocks?: () => Record<
    string,
    { updateTimeout?: ReturnType<typeof setTimeout>; released?: boolean }
  >;
};

function loadProperLockfileInternals(): ProperLockfileInternals | undefined {
  try {
    return createRequire(import.meta.url)('proper-lockfile/lib/lockfile.js') as
      ProperLockfileInternals;
  } catch {
    return undefined;
  }
}

/**
 * F3 — canonicalize an already-absolute config path via `realpath` so the lock identity
 * and every read/write/`-c` key on the REAL file, not a lexical symlink alias. When the
 * config file EXISTS, its own realpath is returned (a symlink resolves to its target).
 * When it does NOT yet exist, `realpath` would throw (ENOENT), so we canonicalize the
 * PARENT directory (which normally exists — the project root) and rejoin the basename, so
 * two aliases to the same not-yet-created config still resolve to one identity. If neither
 * the file nor its parent can be canonicalized, the lexical path is returned unchanged (no
 * worse than before, and the common case — an existing project dir — is always canonical).
 */
function canonicalizeConfigPath(absoluteConfigPath: string, depth = 0): string {
  try {
    return realpathSync(absoluteConfigPath);
  } catch (error) {
    // ONLY ENOENT (a path component does not exist yet) is the benign "not created yet" case
    // we handle below. Any OTHER realpath error (EACCES, ELOOP for a real symlink cycle,
    // ENOTDIR) means the path is genuinely unresolvable — RETHROW so it is never swallowed
    // into a bogus lexical fallback that both aliases and the target could disagree on.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  // ENOENT: the FINAL path component may itself be a DANGLING SYMLINK — it exists as a link,
  // but its target does not exist YET (a not-yet-created config). If so, resolve the link to
  // its intended target and canonicalize THAT, so an alias and its target share ONE lock
  // identity (both writes hit the same real file). `lstatSync` does NOT follow the link, so it
  // reports the link itself.
  let linkStat: ReturnType<typeof lstatSync> | undefined;
  try {
    linkStat = lstatSync(absoluteConfigPath);
  } catch {
    // The final component is genuinely absent (not even a link) — fall through to the
    // parent-dir fallback below.
    linkStat = undefined;
  }
  if (linkStat?.isSymbolicLink()) {
    // Bound the walk so a pathological chain of dangling links (that `realpathSync` did not
    // already reject as ELOOP) cannot recurse forever — surface it as an ELOOP instead.
    if (depth >= 40) {
      throw Object.assign(
        new Error(`ELOOP: too many symbolic links while resolving "${absoluteConfigPath}"`),
        { code: 'ELOOP' },
      );
    }
    const target = readlinkSync(absoluteConfigPath);
    return canonicalizeConfigPath(resolve(dirname(absoluteConfigPath), target), depth + 1);
  }
  // Genuinely absent, NON-symlink file — canonicalize the PARENT dir (normally the project
  // root, which exists) + rejoin the real basename, so two lexical aliases to the same
  // not-yet-created config still resolve to one identity.
  const dir = dirname(absoluteConfigPath);
  try {
    return join(realpathSync(dir), basename(absoluteConfigPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return absoluteConfigPath;
  }
}

/**
 * Overridable `proper-lockfile` knobs — production uses the module defaults; unit tests
 * pass a SHORT `stale`/`update` (to exercise heartbeat freshness under a slow call) or a
 * failing `fs` (to exercise a leaked-mutex unlock failure). `fs` is `proper-lockfile`'s
 * callback-style filesystem seam (mkdir/stat/utimes/rmdir/realpath).
 */
export interface ProvisionLockOptions {
  stale?: number;
  update?: number;
  retries?: number | { retries: number; factor?: number; minTimeout?: number; maxTimeout?: number };
  fs?: unknown;
}

/**
 * A lock whose owner has not refreshed it within this window is treated as abandoned
 * (crashed) and may be compromised/stolen, so a crashed provision cannot wedge every
 * future one. A LIVE owner refreshes the mutex mtime every {@link LOCK_UPDATE_MS}
 * (strictly less than this), so it never expires by age. Generous vs. a real
 * provision's duration.
 *
 * F1 CORRECTNESS — this heartbeat is a `setTimeout` on the Node event loop, so it only
 * fires while the loop is FREE. The default runner is ASYNC (`spawn`, awaited), so no
 * wrangler call blocks the loop; between/`during` every `await` the pending update timer
 * runs and refreshes the mtime. Fast synchronous bookkeeping (JSON parse, small config
 * reads) is « `LOCK_UPDATE_MS`, so the mtime is continuously refreshed and NO other
 * process ever sees this lock stale → it can never be stolen while we hold it. (The old
 * blocking `spawnSync` could freeze the loop past `LOCK_STALE_MS`, starving the
 * heartbeat AND `onCompromised`, which is exactly the race F1 closes.)
 */
const LOCK_STALE_MS = 120_000;
/** Refresh interval keeping a live owner's lock fresh (must be < {@link LOCK_STALE_MS}). */
const LOCK_UPDATE_MS = 20_000;
/**
 * Backoff budget while waiting for a held (non-stale) lock. Polls with jittered backoff
 * for roughly a minute before giving up, so a concurrent provision blocks (not spins)
 * until the holder releases, then proceeds.
 */
const LOCK_RETRIES = { retries: 100, factor: 1.5, minTimeout: 200, maxTimeout: 2_000 } as const;

/**
 * Acquire the cross-process provision lock over the resolved config path via
 * `proper-lockfile` (an atomic `mkdir`-based mutex at `<configPath>.void-provision.lock.lock`).
 * `proper-lockfile` requires the locked pathname to EXIST, so we lock a DEDICATED
 * adjacent marker file (`<configPath>.void-provision.lock`), creating it if absent —
 * never the real config, so the writer's missing-vs-empty config semantics stay
 * untouched. Returns a handle whose `release()` drops the mutex; ALWAYS call it in a
 * `finally` so an interruption never leaks the lock.
 *
 * `onCompromised` FAILS CLOSED (re-throws): if the lock is ever detected stolen (its
 * mtime changed, or the mutex vanished under a live owner), provisioning must NEVER
 * continue — a compromised lock means another process may be racing the same config.
 */
export async function acquireProvisionLock(
  configPath: string,
  lockOptions?: ProvisionLockOptions,
): Promise<ProvisionLock> {
  const lockTarget = `${configPath}.void-provision.lock`;
  // F2 (round 12) — the quarantine gate runs FIRST, before proper-lockfile is even
  // consulted. This function is the single acquisition choke point for every provision,
  // so a quarantined mutex can never be reached via the mtime-stale path while the
  // recorded wrangler process group may still be alive.
  assertQuarantineClearedOrClear(lockTarget);
  if (!existsSync(lockTarget)) {
    writeFileSync(lockTarget, '');
  }
  const staleMs = lockOptions?.stale ?? LOCK_STALE_MS;
  const release = await lockfile.lock(lockTarget, {
    stale: staleMs,
    update: lockOptions?.update ?? LOCK_UPDATE_MS,
    retries: lockOptions?.retries ?? LOCK_RETRIES,
    // `proper-lockfile`'s callback-style fs seam — overridable so a test can force an
    // unlock failure. Production uses the library default (graceful-fs).
    ...(lockOptions?.fs !== undefined ? { fs: lockOptions.fs as never } : {}),
    onCompromised: (error) => {
      throw error;
    },
  });
  // F2 — cache ONE shared release promise so a double-release is idempotent (the SAME
  // settled promise is returned, never a second `proper-lockfile` unlock), and PROPAGATE
  // a genuine unlock failure instead of swallowing it. `proper-lockfile` drops its own
  // ownership state (`released = true`, `delete locks[file]`) BEFORE it rmdir's the mutex
  // dir, so an EACCES/EBUSY/I/O rmdir failure leaves the `.lock` directory on disk — a
  // LEAKED cross-process mutex that blocks future provisions until it goes stale — while
  // the old code resolved "released" and reported the provision a success. We now surface
  // it: the caller fails the provision. (Because that same drop-before-rmdir ordering
  // makes `proper-lockfile`'s own release non-retryable — a second call returns
  // `ERELEASED` without re-attempting the rmdir — we do NOT retry via a manual dir sweep,
  // which could race a successor; the leaked mutex self-heals for future runs after the
  // stale window.) An `ERELEASED` error means the lock was ALREADY dropped (e.g. by an
  // `onCompromised` sweep, whose re-throw is the authority) — not a leak we caused — so
  // it is treated as success.
  let releasePromise: Promise<void> | undefined;
  const doRelease = async (): Promise<void> => {
    try {
      await release();
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ERELEASED') {
        return;
      }
      throw new Error(
        `provision: failed to release the cross-process provision lock "${lockTarget}.lock" ` +
          `(${(error as Error).message}). The mutex directory may still exist and will block ` +
          `future provisions until it goes stale (~${Math.round(staleMs / 1000)}s). Remove it ` +
          `manually if it persists, then retry.`,
      );
    }
  };
  return {
    release: () => (releasePromise ??= doRelease()),
    // F2 (round 11) — quarantine: detach this lock from proper-lockfile's internal
    // tracking WITHOUT removing the on-disk mutex directory, so:
    //   1. the library's signal-exit sweep (which rmdirSync's every tracked lock on
    //      process exit) no longer removes it — the retained mutex OUTLIVES this process
    //      and keeps blocking concurrent provisions while the unconfirmed child may live;
    //   2. the mtime heartbeat stops; the F2 (round 12) sidecar below then guards the
    //      retained mutex — the acquisition gate probes the recorded group and fails
    //      closed while it may live, and clears the quarantine once it is confirmed
    //      dead (so a permanent wedge is impossible, but mere age no longer suffices);
    //   3. any late release() gets ERELEASED (untracked) → treated as success, never an
    //      rmdir of the retained directory.
    // Prevent a compromise-callback race too: mark it released before detaching.
    quarantine: (info: QuarantineInfo) => {
      // A no-op after a successful release (nothing to retain).
      if (releasePromise !== undefined) {
        return;
      }
      releasePromise = Promise.resolve(); // any later release() is a settled no-op
      // F2 (round 12) — persist the quarantine owner metadata (atomic write) BEFORE
      // detaching, so the acquisition gate can probe the recorded group. Best-effort:
      // if the sidecar cannot be written, retention still happens via the detach below
      // (the stale window then applies) — surface the degradation without failing.
      try {
        writeQuarantineSidecar(quarantineSidecarPath(lockTarget), info);
      } catch (error) {
        process.stderr.write(
          `provision: warning — could not persist quarantine metadata to ` +
            `"${quarantineSidecarPath(lockTarget)}" (${(error as Error).message}); the retained ` +
            `lock is then only protected by its stale window.\n`,
        );
      }
      const internals = loadProperLockfileInternals();
      const locks = internals?.getLocks?.();
      if (!locks) {
        return; // degraded: retained only until process exit (internals unavailable)
      }
      // proper-lockfile keys its registry on the REALPATH of the locked marker file.
      let key: string;
      try {
        key = realpathSync(lockTarget);
      } catch {
        key = resolve(lockTarget);
      }
      const tracked = locks[key];
      if (tracked) {
        tracked.released = true;
        if (tracked.updateTimeout !== undefined) {
          clearTimeout(tracked.updateTimeout);
        }
        delete locks[key];
      }
    },
  };
}

/**
 * Parse a wrangler `--json` stdout into an array, distinguishing a VALID JSON
 * array (returns it, possibly empty) from unparseable/non-array output (returns
 * `undefined`). Members are returned UNFILTERED — a malformed member (e.g. a
 * `null`) is preserved, NOT silently dropped, so {@link validateResourceList}
 * can fail closed on it (a dropped malformed member could BE the target and look
 * like "absent", minting a duplicate). Used everywhere an empty list must mean
 * "authoritatively absent" and garbage must NOT be coerced to "absent".
 */
function parseJsonArrayStrict(stdout: string): Array<unknown> | undefined {
  const value = parseJsonLoose(stdout);
  return Array.isArray(value) ? value : undefined;
}

/** Parse a wrangler `--json` stdout into an object, tolerating noise/failure. */
function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const value = parseJsonLoose(stdout);
  return isRecord(value) ? value : undefined;
}

/**
 * wrangler may print human banners before the JSON payload; slice from the
 * first `{`/`[` so a leading banner does not break `JSON.parse`.
 */
function parseJsonLoose(stdout: string): unknown {
  const trimmed = stdout.trim();
  const start = trimmed.search(/[[{]/);
  if (start === -1) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * F5 — read the single provisioned binding entry for `field`/`binding` from the resolved
 * config, delegating to the STRICT canonical reader in `wrangler.ts`
 * ({@link readProvisionedBindingEntry}). Unlike the old loose first-match `.find()`, this
 * validates the target field's outer shape, fails closed on a DUPLICATE binding, and runs
 * the worker-wide CROSS-TYPE collision check (reusing the Task-3 collector) — so a
 * duplicate/collision config can never be reported `reused` or pass a create postcondition.
 */
function readBindingEntry(
  configPath: string,
  field: string,
  binding: string,
): Record<string, unknown> | undefined {
  return readProvisionedBindingEntry(readRootConfig(configPath), field, binding, configPath);
}

/**
 * Read + parse the root wrangler config (fresh each call — wrangler mutates it).
 * BOM-aware (wrangler + the Task 3 writer strip a leading BOM before parsing, so
 * we must too, else a BOM-prefixed config would look unparseable). FAILS CLOSED
 * on a genuine parse error or a non-object root: never silently treat a real
 * config as `{}`, which would miss existing ids (re-provision/orphan) and mask a
 * corrupt file. A missing file is fine (nothing to read-first → `{}`).
 */
function readRootConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, 'utf-8');
  const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const errors: Array<ParseError> = [];
  const parsed = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `provision: cannot read "${configPath}" — it is not valid JSON/JSONC. Fix the file and retry.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`provision: "${configPath}" must be a JSON object.`);
  }
  return parsed;
}

// --- Shared fail-closed discovery gates (one place per class of check) --------
// The three helpers below are the SINGLE decision points every resource path
// routes through, so no sibling path can drift into a per-path bug again:
//   1. assertDiscoverySucceeded — a discovery/list/info result is only trusted
//      when it exited cleanly (numeric status 0). Called BEFORE any stdout parse.
//   2. validateResourceList     — a `--json` list is rejected WHOLE if ANY member
//      is malformed (never silently filtered — a malformed member could BE the
//      target and look "absent", minting a duplicate).
//   3. isConfirmedAbsent        — a NON-zero `<res> info`-by-name probe means
//      "absent" (→ create) ONLY on wrangler's EXACT, name-aware not-found signal;
//      a signal/spawn failure or any other nonzero is NEVER absence.

/** Escape a string for literal embedding in a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * FAIL-CLOSED gate over a discovery/list/info result. Throws (no create) unless
 * the child exited cleanly — a NUMERIC `status === 0`. Because
 * {@link normalizeRunWranglerResult} already folds a signal-killed child or a
 * spawn error into a non-zero status, a single numeric check here rejects ALL of
 * nonzero-exit / SIGTERM / spawn-error / non-numeric status. MUST be called
 * BEFORE parsing stdout, so a failed result can never be parsed as "absent".
 */
function assertDiscoverySucceeded(result: RunWranglerResult, label: string): void {
  if (!isCleanSuccess(result)) {
    throw new Error(
      `provision: "${label}" failed (exit ${String(result.status)}): ` +
        `${result.stderr || result.stdout || 'no output'}. Cannot verify existing resources; ` +
        `refusing to create a possible duplicate.`,
    );
  }
}

/** Field spec describing a wrangler `--json` list member's required identity. */
interface ResourceListSpec {
  /** Human resource name for messages, e.g. `KV namespace` / `D1 database`. */
  resource: string;
  /** Command name for messages, e.g. `wrangler kv namespace list`. */
  command: string;
  /**
   * F4/F7 — the resource-SPECIFIC member-identity validator, run over EVERY member
   * inside the whole-list gate BEFORE any name filtering: KV requires a real 32-hex
   * `id`; D1 requires its TWO id aliases to RECONCILE ({@link reconcileD1IdAliases} —
   * every present alias a well-formed UUID, all agreeing on one id). A member whose
   * identity is merely non-empty but MALFORMED (`" "`, `"bogus"`, a `local`
   * placeholder) — or whose secondary alias conflicts — no longer passes: the list is
   * untrustworthy, so we reject it WHOLE and fail closed rather than skip that member
   * and mistake the target for absent (which would mint a duplicate).
   */
  hasValidId: (member: Record<string, unknown>) => boolean;
  /** Human description of the id requirement for the whole-list rejection message. */
  idRule: string;
  /** The member field carrying the account-matched name/title. */
  nameField: string;
  /** Grammatical label for the name field in messages: `titled` / `named`. */
  nameLabel: string;
}

/**
 * STRICT list validator shared by KV + D1. Rejects the ENTIRE list (throws) if ANY
 * member is not a well-formed object carrying a non-empty name AND — F4 — a
 * FORMAT-VALID id (per {@link ResourceListSpec.idValidator}). A member is NEVER
 * silently filtered, and a member with a malformed id is NEVER accepted, because
 * either could BE the requested target (or signal a corrupt list) and treating it as
 * "absent" would mint a duplicate. Validates EVERY member up front — BEFORE any
 * name-filtering by the caller — so a nonmatching member with a bogus id can no longer
 * pass the gate as authoritative absence. Returns the validated members (every one
 * guaranteed to have a real id + name) on success.
 */
function validateResourceList(
  list: Array<unknown>,
  spec: ResourceListSpec,
): Array<Record<string, unknown>> {
  const validated: Array<Record<string, unknown>> = [];
  for (const member of list) {
    if (!isRecord(member)) {
      throw new Error(
        `provision: "${spec.command}" returned a malformed ${spec.resource} entry (not an object). ` +
          `Cannot verify existing resources; refusing to create a possible duplicate.`,
      );
    }
    const rawName = member[spec.nameField];
    const nameValid = typeof rawName === 'string' && rawName.length > 0;
    // F4/F7 — a REAL, RECONCILED identity — not merely one non-empty alias.
    const idValid = spec.hasValidId(member);
    if (nameValid && !idValid) {
      throw new Error(
        `provision: "${spec.command}" returned a ${spec.resource} ${spec.nameLabel} ` +
          `${JSON.stringify(rawName)} with no valid id (${spec.idRule}). Cannot verify existing ` +
          `resources; refusing to create a possible duplicate.`,
      );
    }
    if (!nameValid) {
      throw new Error(
        `provision: "${spec.command}" returned a malformed ${spec.resource} entry with no valid ` +
          `${spec.nameField}. Cannot verify existing resources; refusing to create a possible duplicate.`,
      );
    }
    validated.push(member);
  }
  return validated;
}

/**
 * The one D1 identity outcome, so a caller can distinguish "not the requested
 * database" (skip → maybe create) from "IS the requested database but ambiguous"
 * (fail closed → never adopt, never mistake for absent).
 */
type D1Match = { kind: 'match'; id: string } | { kind: 'claimed-but-invalid' } | { kind: 'other' };

/**
 * F7 (round 12) — THE one D1 id-alias reconciler, shared by the WHOLE-LIST gate (every
 * `d1 list` member, BEFORE any name filtering) and {@link normalizeD1} (the requested
 * database's identity). D1 carries TWO id aliases (`database_id`, `uuid`); `undefined`
 * or an EMPTY STRING means "not provided" (wrangler omits/blanks the secondary alias).
 * The reconciled id exists ONLY when at least one alias is present, EVERY present alias
 * is a well-formed real D1 UUID, and ALL present aliases agree on one id. Anything
 * else — a non-string alias, a malformed value (`"bogus"`), or two disagreeing UUIDs —
 * is `invalid`: the entry's identity cannot be trusted. The old gate accepted a member
 * when ANY ONE alias validated, so `{ name: "other-db", uuid: <valid>,
 * database_id: "bogus" }` passed the whole-list gate and authorized authoritative
 * absence for the target — a corrupt list minting a duplicate.
 */
type D1ReconciledId = { kind: 'id'; id: string } | { kind: 'absent' } | { kind: 'invalid' };

function reconcileD1IdAliases(entry: Record<string, unknown>): D1ReconciledId {
  const present = [entry.database_id, entry.uuid].filter(
    (value) => value !== undefined && value !== '',
  );
  if (present.length === 0) {
    return { kind: 'absent' };
  }
  const ids = new Set<string>();
  for (const value of present) {
    if (!isRealD1Id(value)) {
      return { kind: 'invalid' };
    }
    ids.add(value);
  }
  if (ids.size !== 1) {
    return { kind: 'invalid' };
  }
  return { kind: 'id', id: [...ids][0] };
}

/**
 * THE single strict D1 identity normalizer (F5), shared by `d1 list --json` and
 * `d1 info <name> --json`. It reconciles the TWO name aliases (`name`,
 * `database_name`) and TWO id aliases (`database_id`, `uuid`) — an EMPTY STRING is
 * treated as ABSENT for each — and returns a usable id ONLY when the entry
 * unambiguously IS the requested database:
 *   - `{ kind: 'other' }` — no non-empty name alias equals `requestedName`, so this
 *     entry is a different database (the caller skips it, never mistakes it for the
 *     target, and never adopts it under a normalization of a DIFFERENT name);
 *   - `{ kind: 'claimed-but-invalid' }` — a name alias DOES equal `requestedName`
 *     but the entry is ambiguous: CONFLICTING non-empty name aliases (e.g.
 *     `name:"wanted"` + `database_name:"other"`), OR not EXACTLY ONE distinct
 *     non-empty id (0 → no id; >1 → conflicting/blank uuid vs database_id). The
 *     caller fails closed (never adopt, never create a duplicate);
 *   - `{ kind: 'match', id }` — exactly one requested-name alias and exactly one
 *     unambiguous non-empty id.
 * The old two-helper split (`normalizeD1Identity` preferring `database_name`,
 * `d1EntryName` preferring `name`) let a `{name,database_name}` mismatch be
 * SELECTED under one alias yet KEYED under the other. This collapses both into one
 * exact-match rule so no sibling gap remains.
 */
function normalizeD1(entry: Record<string, unknown> | undefined, requestedName: string): D1Match {
  if (!isRecord(entry)) {
    return { kind: 'other' };
  }
  const names = [entry.name, entry.database_name].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  // Not the requested database unless SOME non-empty alias equals it exactly.
  if (!names.includes(requestedName)) {
    return { kind: 'other' };
  }
  // It claims the requested name — now it must be UNAMBIGUOUS to adopt.
  // Conflicting non-empty name aliases → ambiguous identity.
  if (new Set(names).size > 1) {
    return { kind: 'claimed-but-invalid' };
  }
  // F7 — the ONE alias reconciler: no id, ANY malformed/non-string present alias, or
  // disagreeing aliases → ambiguous, never adoptable — fail closed rather than adopt
  // or (worse) mistake it for absent and mint a duplicate.
  const reconciled = reconcileD1IdAliases(entry);
  if (reconciled.kind !== 'id') {
    return { kind: 'claimed-but-invalid' };
  }
  return { kind: 'match', id: reconciled.id };
}

/**
 * `wrangler kv namespace list` → the `{ id }` of every namespace whose title
 * matches. The list has ALREADY been through {@link validateResourceList} (every
 * member has a non-empty string `id` + `title`), so this only filters + collects.
 *
 * F4 — a title-matching namespace whose `id` is NOT a real KV id (32-hex) is ambiguous:
 * we can neither adopt it nor treat it as absent (which would mint a duplicate title), so
 * we FAIL CLOSED. Real wrangler always returns 32-hex ids; this guards a malformed seam.
 */
function extractKvMatches(
  list: Array<Record<string, unknown>>,
  title: string,
): Array<{ id: string }> {
  const matches: Array<{ id: string }> = [];
  for (const ns of list) {
    if (ns.title !== title) {
      continue;
    }
    if (!isRealKvId(ns.id)) {
      throw new Error(
        `provision: "wrangler kv namespace list" returned a namespace titled ${JSON.stringify(title)} ` +
          `with a malformed id ${JSON.stringify(ns.id)} (expected a 32-character hex namespace id). ` +
          `Cannot verify whether it already exists; refusing to create a possible duplicate.`,
      );
    }
    matches.push({ id: ns.id });
  }
  return matches;
}

/** True when a `d1 create` failure means the name is already taken (code 7502). */
function isAlreadyExistsError(result: RunWranglerResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return text.includes('7502') || /already exists/i.test(text);
}

/**
 * EXACT, name-aware not-found classifier shared by R2 + queues. Given a
 * already-NON-zero `<res> info`-by-name probe, returns `true` (confirmed absent →
 * safe to create) ONLY on wrangler's exact, resource-specific not-found signal
 * for THIS name (regex-escaped). Everything else returns `false` so the caller
 * fails closed — a signal/spawn failure, an auth/network/metrics error, or a
 * GENERIC "not found" (e.g. `Account not found`) is NEVER treated as absence,
 * which would mint a duplicate resource.
 */
function isConfirmedAbsent(result: RunWranglerResult, kind: 'r2' | 'queue', name: string): boolean {
  // Provenance rule: only a CLEAN non-zero exit may be classified. A signal-killed
  // or unspawnable probe is a HARD failure — its buffered text (which may contain a
  // not-found line printed just before the kill) is NOT proof of absence, so we
  // refuse to authorize a create on it.
  if (!isCleanFailure(result)) {
    return false;
  }
  const text = `${result.stdout}\n${result.stderr}`;
  switch (kind) {
    case 'r2':
      // F5 — CF API error code 10006 is the exact code wrangler treats as "bucket absent"
      // (its `getR2Bucket`/`isConnectedToExistingResource` branch on `err.code === 10006`).
      // wrangler renders an `APIError` as `${message} [code: ${err.code}]` (its `renderError`
      // in wrangler 4.107), so a genuine 10006 ALWAYS surfaces as the STRUCTURED token
      // `[code: 10006]` in the error output. We require that bracketed token — NOT a bare
      // `10006` anywhere in output: a bucket NAME that merely contains those digits (e.g.
      // `archive-10006-prod`) inside an unrelated auth/service/network failure would falsely
      // read as absence and authorize a duplicating create. Only the structured code counts.
      return /\[code:\s*10006\]/.test(text);
    case 'queue':
      // wrangler's `getQueue` throws exactly `Queue "<name>" does not exist`.
      // Match ONLY that message for THIS queue name — a generic `not found` /
      // `no such` / `Account not found` must NOT be read as queue absence.
      return new RegExp(`Queue\\s+"${escapeRegExp(name)}"\\s+does not exist`, 'i').test(text);
  }
}

/**
 * F4 — a `wrangler queues info <name>` result POSITIVELY confirms THIS queue
 * exists. Queues write NO config, so a create cannot be verified by re-reading the
 * config (the D1/KV/R2/Hyperdrive backstop). And wrangler's `bin.wrangler` wrapper
 * maps a signal-killed inner CLI to `process.exit(0)` (`bin/wrangler.js`:
 * `code === null → exit(0)`), so a KILLED probe/create can surface a clean exit 0
 * with empty/partial output. A bare clean 0 is therefore NOT proof the queue exists.
 * We require BOTH a clean success (numeric exit 0, no signal/spawn error — the
 * provenance rule) AND the output to name THIS exact queue: wrangler 4.107's
 * `queues info` prints `Queue Name: <queue_name>` for the queue it fetched by name
 * (account-unique), so an exact `Queue Name: <name>` line is the positive signal.
 * Used for BOTH the reuse probe and the post-create verify probe.
 */
function queueInfoConfirmsExists(result: RunWranglerResult, name: string): boolean {
  if (!isCleanSuccess(result)) {
    return false;
  }
  const text = `${result.stdout}\n${result.stderr}`;
  return new RegExp(`^Queue Name:\\s+${escapeRegExp(name)}\\s*$`, 'm').test(text);
}

/**
 * Throw when the writer could not attach `migrations_dir` because no matching
 * `d1_databases[]` entry exists. The provisioner only writes `migrations_dir`
 * AFTER establishing the D1 entry (create/adopt/reuse), so a skip here means the
 * D1 resource is unexpectedly absent from the config — never silently succeed
 * with the gap unfilled.
 */
function assertD1MigrationsDirApplied(
  result: WriteProvisionedWranglerResult,
  binding: string,
  configPath: string,
): void {
  if (result.d1MigrationsDirSkipped) {
    throw new Error(
      `provision: could not set migrations_dir for D1 binding ${JSON.stringify(binding)} — no ` +
        `matching d1_databases entry exists in "${configPath}" after provisioning it. The D1 ` +
        `resource was not written to the config as expected; inspect the file and retry.`,
    );
  }
}

/** Which config field + id key a CONFIG-WRITING create must have populated. */
interface CreatePostcondition {
  /** Config array field the create's `--update-config` upserts into. */
  field: string;
  /** The member key that must hold a REAL (non-placeholder) id afterward. */
  idField: string;
  /**
   * F4 — resource-SPECIFIC id-format validator (D1 UUID / KV 32-hex / R2 bucket-name /
   * Hyperdrive 32-hex). Replaces the loose `isRealValue`, so a create that reported
   * success but wrote a placeholder/garbage id (e.g. a signal-killed child masked as
   * exit 0) fails closed instead of being recorded as provisioned.
   */
  idValidator: (value: unknown) => value is string;
  /**
   * F4 — when set, the member key that must EXACTLY equal the requested name (the
   * resource's IDENTITY). R2's `bucket_name` and D1's `database_name` ARE the
   * identity, so a create that wrote a DIFFERENT resource's name (a race, a stale
   * `--update-config`, a wrong-account write) must fail closed rather than binding the
   * app to the wrong resource. KV/Hyperdrive config entries carry no name to
   * cross-check, so they verify only a real id.
   */
  nameField?: string;
  /** Human resource name for the message. */
  resource: string;
  /** Command name for the message. */
  command: string;
}

/**
 * F4 backstop — verify a create's POSTCONDITION, RESOURCE-SPECIFICALLY + identity
 * checked. wrangler 4.107's `bin.wrangler` is a WRAPPER that spawns
 * `wrangler-dist/cli.js` and maps a signal-killed child (`code === null`) to
 * `process.exit(0)`, so `spawnSync` can see a `create` report "success" though the
 * real CLI was killed and `--update-config` wrote NO id. After every config-writing
 * create (d1/kv/r2/hyperdrive) reports success we RE-READ the resolved config and
 * CONFIRM the target binding now holds a REAL id AND — where the resource's name is
 * its identity (R2 `bucket_name`, D1 `database_name`) — that the recorded name EXACTLY
 * matches the requested one; otherwise we FAIL CLOSED. A bare "some non-placeholder
 * value" check is NOT enough: for R2, `bucket_name` IS the identity, so
 * `{ bucket_name: 'other' }` would otherwise pass and bind the WRONG bucket. This also
 * catches any partial/silent create failure, not only kills. (Queue creates write NO
 * config, so they cannot be verified this way — a killed queue-create self-heals on
 * the next read-first/probe run, which re-detects absence and re-creates.)
 */
function assertCreateWroteRealId(
  configPath: string,
  spec: CreatePostcondition,
  binding: string,
  name: string,
): void {
  const entry = readBindingEntry(configPath, spec.field, binding);
  const idOk = !!entry && spec.idValidator(entry[spec.idField]);
  const nameOk = spec.nameField === undefined || (!!entry && entry[spec.nameField] === name);
  if (!idOk || !nameOk) {
    throw new Error(
      `provision: "${spec.command} ${name}" reported success but "${configPath}" does not hold the ` +
        `expected ${spec.resource} for binding ${JSON.stringify(binding)} afterward (need a real ` +
        `${spec.idField}${spec.nameField ? ` and ${spec.nameField} === ${JSON.stringify(name)}` : ''}). ` +
        `The create may have been interrupted or written a different resource — wrangler's launcher ` +
        `can mask a signal-killed child as exit 0. Refusing to record a wrong/unprovisioned ` +
        `resource; inspect the account/config and retry.`,
    );
  }
}

// --- F5: option-injection guard SEPARATE from per-resource service grammar -----
// The old single regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$` was applied to EVERY
// resource, but wrangler 4.107 forwards the KV namespace positional VERBATIM as the KV
// TITLE, and Cloudflare permits titles like "My Own Namespace" (spaces) — so valid KV
// namespaces were REJECTED before discovery. It was also wrong for R2 (whose real
// grammar is lowercase DNS-like). We therefore split the two concerns:
//   1. OPTION-INJECTION guard  — a SECURITY invariant applied to EVERY positional,
//      identical across resources: shell-free spawning stops shell injection but NOT CLI
//      OPTION injection, so a positional starting with `-` (`--help`, `-c`, `--config`)
//      would be parsed by wrangler as a FLAG (a queue name is derived from a filename →
//      attacker-influenced). We reject empty, a leading `-`, and any control char /
//      newline (which could smuggle a token or corrupt argv).
//   2. SERVICE grammar         — each resource's ACTUAL Cloudflare grammar (verified
//      2026-07 against wrangler 4.107 + live resources), so a valid name is never
//      rejected AND obvious garbage still fails before a remote call.

/** True when `value` contains an ASCII control character (0x00–0x1F or 0x7F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** F5.1 — the universal option-injection guard for ANY wrangler ARGV positional. */
function assertNoOptionInjection(kind: string, name: string): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.startsWith('-') ||
    hasControlChar(name)
  ) {
    throw new Error(
      `provision: refusing to pass an unsafe ${kind} name ${JSON.stringify(name)} to wrangler. A ` +
        `name may not be empty, begin with "-" (it would be parsed as a CLI flag), or contain ` +
        `control characters. Rename the resource and retry.`,
    );
  }
}

type ResourceNameKind = 'd1' | 'kvTitle' | 'r2' | 'hyperdrive' | 'queue';

/**
 * F5.2 — per-resource Cloudflare naming GRAMMAR, verified 2026-07 against wrangler 4.107
 * and live account resources:
 *   - `r2`      — wrangler's own `isValidR2BucketName`: 3–63 chars, lowercase letters /
 *                 digits / `-`, begin+end alphanumeric (DNS-like). This IS the identity.
 *   - `kvTitle` — the KV namespace positional is forwarded verbatim as the account TITLE;
 *                 Cloudflare allows a broad charset INCLUDING SPACES (≤512 chars). We only
 *                 forbid control chars (already covered by the injection guard) — spaces
 *                 and mixed case are legal, so "My Own Namespace" is accepted.
 *   - `d1` / `hyperdrive` / `queue` — 1–63 chars, begin with a letter/digit, then
 *                 letters / digits / `-` / `_` (matches every live D1 `name`, Hyperdrive
 *                 config `name`, and Void's `QUEUE_<NAME>`-derived queue names).
 */
const RESOURCE_NAME_GRAMMARS: Record<
  ResourceNameKind,
  { re: RegExp; label: string; rule: string }
> = {
  r2: {
    re: R2_BUCKET_NAME_RE,
    label: 'R2 bucket',
    rule: 'be 3–63 characters, contain only lowercase letters, digits and "-", and begin and end with a letter or digit',
  },
  kvTitle: {
    // 1–512 chars, any non-control character (spaces allowed). The leading-"-" / control
    // guard is enforced separately by assertNoOptionInjection.
    re: /^[\s\S]{1,512}$/,
    label: 'KV namespace',
    rule: 'be 1–512 characters and contain no control characters (spaces are allowed)',
  },
  d1: {
    re: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
    label: 'D1 database',
    rule: 'be 1–63 characters, start with a letter or digit, and contain only letters, digits, "-" or "_"',
  },
  hyperdrive: {
    re: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
    label: 'Hyperdrive config',
    rule: 'be 1–63 characters, start with a letter or digit, and contain only letters, digits, "-" or "_"',
  },
  queue: {
    // F6 — Cloudflare Queues: 1–63 chars, letters/digits/dashes only (NO underscores),
    // and the FIRST and LAST char must be alphanumeric (no leading/trailing dash). The
    // leading-`-` case is also covered by the option-injection guard, kept as belt+braces.
    re: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
    label: 'queue',
    rule: 'be 1–63 characters, contain only letters, digits and "-", and begin and end with a letter or digit',
  },
};

/**
 * F5 — validate a name destined for a wrangler ARGV positional: FIRST the universal
 * option-injection guard, THEN the resource's own Cloudflare grammar. Fail closed on any
 * violation, before the account gate or any wrangler/REST call.
 */
function assertValidResourceName(kind: ResourceNameKind, name: string): void {
  assertNoOptionInjection(RESOURCE_NAME_GRAMMARS[kind].label, name);
  const grammar = RESOURCE_NAME_GRAMMARS[kind];
  if (!grammar.re.test(name)) {
    throw new Error(
      `provision: refusing to pass an invalid ${grammar.label} name ${JSON.stringify(name)} to ` +
        `wrangler. A ${grammar.label} name must ${grammar.rule}. Rename the resource and retry.`,
    );
  }
}

/**
 * F1 — the trailing flags EVERY provisioner wrangler invocation MUST carry, built
 * ONCE so no call site can forget them:
 *   - `-c <configPath>` pins the ONE resolved config (no split-brain reads/writes);
 *   - `--env=` (an explicit EMPTY environment) FORCES wrangler onto the top-level
 *     config environment. wrangler 4.107 selects its config env as
 *     `args.env ?? getCloudflareEnv()`; passing an explicit empty `args.env`
 *     short-circuits the `??` so a project `.env`/`.env.local` that sets
 *     `CLOUDFLARE_ENV` (reloaded into `process.env` on every wrangler command)
 *     can NEVER reselect a named `env.*` block — whose `account_id`/bindings could
 *     differ from the single account this provision resolved, patched, and pinned.
 *     `--env=` is wrangler's own documented sentinel for "use the top-level
 *     environment" (it prints exactly this guidance when multiple env blocks exist).
 * Discovery/create AND `--update-config` therefore all operate on the SAME
 * top-level config/account.
 */
function wranglerConfigArgs(configPath: string): Array<string> {
  return ['-c', configPath, '--env='];
}

/**
 * F4 — build a redactor that strips connection-string secrets from every string the
 * provisioner PROPAGATES (buffered wrangler stdout/stderr, error strings, logged
 * warnings). Two layers:
 *   1. the EXACT desired connection string (when this provision carries one) is replaced
 *      whole, so no derived message can echo it verbatim;
 *   2. any URL userinfo password (`scheme://user:secret@…`) is masked generically, so a
 *      wrangler error that re-renders a connection string in ANY spelling still never
 *      leaks the password (the scheme + user survive for diagnostics).
 * Applied at the single runWrangler choke point (every call site reads pre-redacted
 * results) and to the Hyperdrive lister's propagated failure message.
 */
function createSecretRedactor(connectionString?: string): (text: string) => string {
  return (text) => {
    let out = text;
    if (typeof connectionString === 'string' && connectionString.length > 0) {
      out = out.split(connectionString).join('[REDACTED]');
    }
    out = out.replace(/(\w[\w+.-]*:\/\/[^\s/@:]+:)[^\s@/]+(@)/g, '$1[REDACTED]$2');
    return out;
  };
}

/**
 * F5 (round 12) — deep-redact an UNKNOWN rejection value through the ONE text redactor.
 * A seam (runWrangler / the Hyperdrive lister) may reject with ANYTHING — an Error, a
 * plain STRING, an object, an array — and the old `instanceof Error` guard let a
 * password-bearing string propagate verbatim. Strings return a redacted copy; Errors,
 * objects, and arrays are redacted IN PLACE — own enumerable string fields recursively,
 * plus an Error's (non-enumerable) `message` and `stack` — so the value's IDENTITY
 * survives redaction: quarantine detection (`isQuarantineError` checks the SAME object,
 * instanceof AND the structural `quarantine === true` flag) and every metadata field
 * (`pid`, …) are preserved explicitly, never lost to a rebuilt error. Cycle-safe;
 * read-only/getter fields that cannot be reassigned are left as-is (best effort).
 */
function redactUnknownValue(value: unknown, redactText: (text: string) => string): unknown {
  const seen = new WeakSet<object>();
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return redactText(v);
    }
    if (typeof v !== 'object' || v === null) {
      return v;
    }
    if (seen.has(v)) {
      return v;
    }
    seen.add(v);
    if (v instanceof Error) {
      // `message`/`stack` are non-enumerable — handle them explicitly.
      if (typeof v.message === 'string') {
        v.message = redactText(v.message);
      }
      if (typeof v.stack === 'string') {
        v.stack = redactText(v.stack);
      }
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        try {
          v[i] = visit(v[i]);
        } catch {
          // A frozen/getter-only element — leave it (best effort).
        }
      }
      return v;
    }
    for (const key of Object.keys(v)) {
      try {
        (v as Record<string, unknown>)[key] = visit((v as Record<string, unknown>)[key]);
      } catch {
        // A frozen/getter-only property — leave it (best effort).
      }
    }
    return v;
  };
  return visit(value);
}

/**
 * Ensure every resource in `desired` exists in the user's own Cloudflare account,
 * creating the missing ones by shelling out to `wrangler` and letting
 * `wrangler <res> create --update-config` write real ids into the root config.
 * For resources that already exist (adopt path) — where `create` cannot run —
 * the real id is captured from `wrangler <res> list/info` (or, for Hyperdrive,
 * the account-list existence seam) and written through the Task 3 writer's adopt
 * fields. Pure provisioning: NO build, deploy, or drift-check. Idempotent +
 * read-first: a binding already pointing at a real id is left untouched.
 */
export async function provisionCloudflareResources(
  root: string,
  rootWranglerPath: string,
  desired: DesiredResourceSet,
  opts?: ProvisionOptions,
): Promise<ProvisionResult> {
  await Promise.resolve();
  // ONE ABSOLUTE config path threaded through read-first, wrangler `-c`, AND the
  // writer, so reads and writes can never hit different files (no split-brain).
  // Resolve it against `root` ONCE, up front: Node reads/writes here resolve a
  // RELATIVE path against `process.cwd()`, but the default wrangler runs with
  // `cwd: root` and resolves `-c` there — so with `root !== process.cwd()` a bare
  // relative `rootWranglerPath` would let Node inspect one file while wrangler
  // creates against another (orphan). An already-absolute path is returned as-is.
  //
  // F3 — then CANONICALIZE it with `realpath` so the lock identity (and every read/
  // write/`-c`) is keyed on the REAL file, not a lexical alias. Without this, a real
  // config and a symlink alias to it resolve to DIFFERENT lexical paths → DIFFERENT lock
  // marker dirs (`<path>.void-provision.lock`), so both processes acquire "the" lock at
  // once and race the same underlying file. Canonicalizing collapses all aliases to one
  // identity; a missing config canonicalizes its parent dir so the identity is still
  // alias-stable before the file is created.
  const configPath = canonicalizeConfigPath(resolve(root, rootWranglerPath));

  // F1/F2 — hold ONE cross-process lock for the WHOLE provision: acquire it BEFORE
  // the first config read (so account reconciliation + persistence + all discovery,
  // remote work, and config writes happen against the state the lock protects), and
  // ALWAYS release it (both the success and error paths below call `lock.release()`, so
  // an interruption never leaks the lock; a genuine unlock failure fails the provision).
  // The reconciliation + duplicate-member guard + resource work all run UNDER the lock in
  // `provisionCloudflareResourcesLocked`, so a racing first-run serializes: the second
  // process re-reads the persisted account/ids and fails closed (or reuses).
  //
  // C5 (accepted residual) — this mutex is keyed on the local CONFIG PATH, so it only
  // serializes provisions of the same config on ONE machine; two different HOSTS
  // provisioning the same project can still race and create duplicates. Accepted by
  // design: provision is a single-operator dev-machine action, so no remote coordination
  // is built. (Documented in the Task 7 docs.)
  const lock = await acquireProvisionLock(configPath, opts?.lockOptions);
  // F1/F2 (round 12) — while this provision runs, a fatal-signal death under an
  // UNCONFIRMED wrangler child must RETAIN the mutex: register the lock's quarantine as
  // a before-death hook (the default runner's signal path invokes it SYNCHRONOUSLY —
  // sidecar written, lock detached from the exit sweep — before re-raising the signal).
  const quarantineHook = (info: QuarantineInfo): void => lock.quarantine(info);
  quarantineBeforeDeathHooks.add(quarantineHook);
  // F2 — ALWAYS release, but do NOT swallow a release failure. On body SUCCESS a failed
  // unlock means the mutex leaked, so the provision must FAIL (surfaced, not hidden). On
  // body FAILURE the body error is primary, but a release failure means the mutex LEAKED,
  // so it must NOT be silently discarded (a leaked mutex blocks future retries). We
  // preserve BOTH via an AggregateError. (`release()` is idempotent — one shared promise —
  // so these paths never double-unlock.)
  let result: ProvisionResult | undefined;
  let threw = false;
  let bodyError: unknown;
  try {
    result = await provisionCloudflareResourcesLocked(root, configPath, desired, opts);
  } catch (error) {
    threw = true;
    bodyError = error;
  }
  // Every wrangler call has settled by here (each is awaited), so the before-death hook
  // is no longer needed on any terminal path below.
  quarantineBeforeDeathHooks.delete(quarantineHook);
  if (threw) {
    // F2 (round 11) — QUARANTINE: the failure means a spawned wrangler child could not be
    // confirmed dead — it may STILL be creating resources — so the mutex is INTENTIONALLY
    // RETAINED (never released here; `quarantine()` also detaches it from proper-lockfile's
    // exit sweep so the on-disk directory outlives this process). Releasing it would let a
    // concurrent provision race the surviving child on the same config/account.
    if (isQuarantineError(bodyError)) {
      lock.quarantine({
        // Defensive reads: `isQuarantineError` also accepts a structural match (a
        // `{ quarantine: true }` carrier that is not the class instance).
        pid: typeof bodyError.pid === 'number' ? bodyError.pid : undefined,
        reason: typeof bodyError.message === 'string' ? bodyError.message : String(bodyError),
      });
      throw bodyError;
    }
    // F7 — attempt release; if IT also fails, surface BOTH (the body error is primary but
    // the leaked-mutex error must never be swallowed). An AggregateError carries both in
    // `.errors`, with `.cause` set to the primary body error so a `cause`-walking logger
    // still sees it.
    let releaseError: unknown;
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
    if (releaseError !== undefined) {
      throw new AggregateError(
        [bodyError, releaseError],
        `provision failed AND the cross-process provision lock could not be released afterward — a ` +
          `leaked mutex may block future provisions. Primary error: ` +
          `${bodyError instanceof Error ? bodyError.message : String(bodyError)}; release error: ` +
          `${releaseError instanceof Error ? releaseError.message : String(releaseError)}.`,
        { cause: bodyError },
      );
    }
    throw bodyError;
  }
  // Body succeeded: a genuine unlock failure (leaked mutex) rejects the provision.
  await lock.release();
  return result as ProvisionResult;
}

/** Injectable seams + settings for {@link provisionCloudflareResources}. */
export interface ProvisionOptions {
  runWrangler?: RunWrangler;
  accountId?: string;
  apiToken?: string;
  listHyperdriveConfigs?: ListHyperdriveConfigs;
  log?: ProvisionLogger;
  /** Test-only override of the `proper-lockfile` stale/update/retries/fs knobs (F1/F2). */
  lockOptions?: ProvisionLockOptions;
  /** F4 — override the OVERALL Hyperdrive-lister deadline (ms). Defaults to {@link HYPERDRIVE_LIST_TIMEOUT_MS}. */
  listTimeoutMs?: number;
}

/**
 * The provision body, run entirely UNDER the whole-provision lock (see
 * {@link provisionCloudflareResources}). `configPath` is the ONE resolved absolute
 * config path the lock is keyed on — threaded through read-first, wrangler `-c`, and
 * the writer so reads/writes can never hit different files.
 */
async function provisionCloudflareResourcesLocked(
  root: string,
  configPath: string,
  desired: DesiredResourceSet,
  opts?: ProvisionOptions,
): Promise<ProvisionResult> {
  // --- F2: strict duplicate-member guard at the PROVISIONER BOUNDARY --------
  // `jsonc-parser.parse()` (used by `readRootConfig`) does NOT flag duplicate object
  // members, and the Task 3 writer's duplicate-member guard only runs when the writer
  // is invoked — which is SKIPPED when `account_id` is already correct. So without
  // this, a config with duplicated members (e.g. two `kv_namespaces` arrays) could
  // reach `kv namespace create` (orphan) or be falsely "reused". Run the SAME strict
  // detection the writer uses (reused, not re-implemented) at the boundary — before
  // account persistence, discovery, or ANY remote side effect — and fail closed.
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
    assertNoDuplicateMembers(content, configPath);
  }

  // --- F5: resource-name validation (BEFORE any argv / remote work) ---------
  // Every name that becomes a wrangler ARGV POSITIONAL runs through the universal
  // option-injection guard (so an option-like name `--help`/`-h`/`--config` can never
  // reach wrangler as a flag) AND its own per-resource Cloudflare grammar (so a valid KV
  // title with spaces is accepted, while an invalid R2 bucket name is rejected). Fail
  // closed here, before the account gate or any wrangler/REST call.
  if (desired.d1) {
    assertValidResourceName('d1', desired.d1.name);
  }
  for (const { title } of desired.kvNamespaces) {
    assertValidResourceName('kvTitle', title);
  }
  if (desired.r2) {
    assertValidResourceName('r2', desired.r2.bucketName);
  }
  if (desired.hyperdrive) {
    assertValidResourceName('hyperdrive', desired.hyperdrive.name);
  }
  for (const queueName of desired.queues) {
    assertValidResourceName('queue', queueName);
  }

  // --- F1: resolve + pin the ONE effective Cloudflare account ---------------
  // Precedence: the resolved config's `account_id` > `opts.accountId` > the ambient
  // `CLOUDFLARE_ACCOUNT_ID`. wrangler 4.107 gives the resolved config's account_id
  // PRECEDENCE over the env var, so if the config pins X while `opts.accountId`
  // requests Y, wrangler create/list would target X while the Hyperdrive REST check
  // targets Y — a cross-account create/orphan. Fail closed on a real mismatch;
  // otherwise pin ONE value EVERYWHERE (the wrangler env, which scrubs CLOUDFLARE_ENV
  // and overrides any different ambient account, AND the Hyperdrive REST call).
  const rootConfig = readRootConfig(configPath);
  const rawConfigAccountId = rootConfig.account_id;
  const configAccountId =
    typeof rawConfigAccountId === 'string' && rawConfigAccountId.length > 0
      ? rawConfigAccountId
      : undefined;
  // F1 — the config's top-level `compliance_region` co-determines the ONE pinned API base
  // (FedRAMP vs public). Read + type-check it here so it can be reconciled with the ambient
  // `CLOUDFLARE_COMPLIANCE_REGION` (fail closed on conflict) when the base is resolved below.
  const rawComplianceRegion = rootConfig.compliance_region;
  if (rawComplianceRegion !== undefined && typeof rawComplianceRegion !== 'string') {
    throw new Error(
      `provision: "${configPath}" has a non-string "compliance_region"; it must be "public" or ` +
        `"fedramp_high". Fix the config and retry.`,
    );
  }
  // F1 — a PRESENT string is passed through VERBATIM (an empty string included): wrangler's
  // config validation (`isOneOf("public", "fedramp_high")`) rejects any present
  // out-of-choices value, so the resolver must see it to fail closed identically.
  const configComplianceRegion =
    typeof rawComplianceRegion === 'string' ? rawComplianceRegion : undefined;
  if (configAccountId && opts?.accountId && configAccountId !== opts.accountId) {
    throw new Error(
      `provision: Cloudflare account mismatch — "${configPath}" pins account_id ` +
        `${JSON.stringify(configAccountId)} but deploy requested ${JSON.stringify(opts.accountId)}. ` +
        `Reconcile them (correct or remove the config's account_id, or deploy to the pinned account) ` +
        `and retry.`,
    );
  }
  const ambientAccountId =
    typeof process.env.CLOUDFLARE_ACCOUNT_ID === 'string' &&
    process.env.CLOUDFLARE_ACCOUNT_ID.length > 0
      ? process.env.CLOUDFLARE_ACCOUNT_ID
      : undefined;
  const effectiveAccountId = configAccountId ?? opts?.accountId ?? ambientAccountId;

  const log = opts?.log ?? defaultLogger;
  const resources: Array<ProvisionOutcome> = [];
  const write = (
    patch: Parameters<typeof writeProvisionedWranglerConfig>[1],
  ): WriteProvisionedWranglerResult => writeProvisionedWranglerConfig(root, patch, { configPath });

  // Any resource to ensure implies remote work (list/info/create/REST).
  const hasRemoteWork =
    !!desired.d1 ||
    desired.kvNamespaces.length > 0 ||
    !!desired.r2 ||
    !!desired.hyperdrive ||
    desired.queues.length > 0;

  // F2 — the MANDATORY account fence, at the PROVISIONER BOUNDARY (not inside the
  // default runWrangler). Whenever `desired` implies remote work, an effective
  // account MUST be resolvable — UNCONDITIONALLY, whether the wrangler runner and
  // Hyperdrive lister are the default seams or injected. Otherwise a seam could do
  // remote work (list/info/create/REST) under an ambient/interactive account we
  // never persisted, so a partial run under account A followed by a retry under B
  // would rebind A's resources with no reconciliation (the F1 pin needs a
  // persisted `account_id` to fail closed on the retry). Fail closed BEFORE
  // selecting or calling ANY seam.
  if (hasRemoteWork && !effectiveAccountId) {
    throw new Error(
      `provision: no Cloudflare account is resolvable — set "account_id" in your root wrangler ` +
        `config or export CLOUDFLARE_ACCOUNT_ID before deploying. Refusing to provision resources ` +
        `without a pinned account (wrangler would otherwise fall back to an ambient/interactive ` +
        `account that is never persisted, so a later retry could rebind them elsewhere).`,
    );
  }

  // F1 — before ANY remote work, fail closed if the project dotenv would redirect
  // wrangler's authenticated transport out from under the pinned base (wrangler reloads
  // `.env`/`.env.local`/`.dev.vars` on every command). A single-endpoint provisioner
  // cannot reason about a redirected transport vs. the pinned Hyperdrive REST base.
  if (hasRemoteWork) {
    assertNoTransportRedirectInProjectDotenv(root);
  }

  // --- account_id (PERSIST FIRST, before selecting/calling any seam) --------
  // Pin the effective account_id NOW — before the runWrangler/lister seams are even
  // selected, and before any create writes a real id — so a partial run can never
  // leave freshly-minted ids in a config with NO account pin. Without this, a later
  // retry under a DIFFERENT account would see the real id (read-first hit → skips
  // discovery) and finally stamp its own `account_id`, binding the first account's
  // resources under the second. With the pin written up front, a different-account
  // retry instead hits the reconciliation above (config account ≠ requested → fail
  // closed) before touching wrangler/REST. Skip the write when the config ALREADY
  // pins that exact account (keeps byte-identical configs untouched).
  let accountIdWritten = false;
  if (effectiveAccountId && configAccountId !== effectiveAccountId) {
    write({ accountId: effectiveAccountId });
    accountIdWritten = true;
  }

  // F1 — the reconciled effective account, threaded as the transport context into
  // EVERY wrangler + Hyperdrive invocation below (default AND injected). The boundary
  // fence above guarantees a resolved account for ALL remote work, so this non-null
  // assertion is sound wherever a seam is actually called (an empty `desired` reaches
  // no seam and never reads it).
  const transportAccountId = effectiveAccountId!;
  // F1 — the ONE pinned Cloudflare API base URL (mirroring wrangler's own derivation),
  // resolved from the REAL ambient env AND the config's `compliance_region` (so a FedRAMP
  // config pins the `.fed` endpoint even with no ambient override, and a config-vs-ambient
  // region conflict fails closed like wrangler). Threaded into BOTH the wrangler runner (via
  // the spawned env's `CLOUDFLARE_API_BASE_URL`) and the Hyperdrive REST lister, so both hit
  // the same endpoint. The dotenv fence above guarantees no project `.env` can move it.
  const transportApiBaseUrl = resolvePinnedApiBaseUrl(process.env, configComplianceRegion);

  // Both seams are pinned to the SAME effective account + API base: the default wrangler
  // runner via its env (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_BASE_URL` + the top-level
  // `--env=` on every argv), and the default Hyperdrive lister via
  // `createDefaultListHyperdriveConfigs` (below). An injected seam owns its own transport
  // but is ALWAYS invoked WITH the reconciled account + base (via the single choke point
  // below / the lister's `{ accountId, apiBaseUrl }` context), so it can never target a
  // DIFFERENT account/endpoint than the one the config is pinned to.
  const selectedRunWrangler = opts?.runWrangler ?? createDefaultRunWrangler(root);
  // F4 — every wrangler result (and any rejection message) is redacted at THIS single
  // choke point, so no call site can propagate a Hyperdrive connection string (or any URL
  // userinfo password a wrangler error echoes) into thrown errors / logs / diagnostics.
  const redactSecrets = createSecretRedactor(desired.hyperdrive?.connectionString);
  const redactResult = (result: RunWranglerResult): RunWranglerResult => ({
    ...result,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    error: result.error != null ? redactSecrets(result.error) : result.error,
  });
  // Single choke point: inject the reconciled account + API base into EVERY call so no
  // call site can forget them (grep-proven — every `runWrangler(...)` below routes through
  // here). F1 — async: `Promise.resolve` coerces a sync-stub result OR the default runner's
  // Promise, and every call site `await`s it. Awaiting yields to the event loop, so a
  // real (slow) wrangler call never blocks the lock heartbeat.
  const runWrangler = (
    args: Array<string>,
    callOpts?: { cwd?: string; captureJson?: boolean },
  ): Promise<RunWranglerResult> =>
    Promise.resolve(
      selectedRunWrangler(args, {
        ...callOpts,
        accountId: transportAccountId,
        apiBaseUrl: transportApiBaseUrl,
      }),
    ).then(redactResult, (error: unknown) => {
      // F4/F5 — a REJECTING runner (an F2 quarantine, an injected seam rejecting a plain
      // string/object/array) must not smuggle the secret either: EVERY rejection value is
      // normalized through the ONE deep redactor before propagation. Non-string values
      // are redacted in place, so quarantine identity/metadata survive.
      throw redactUnknownValue(error, redactSecrets);
    });

  // --- D1 ------------------------------------------------------------------
  if (desired.d1) {
    const { binding, name } = desired.d1;
    const entry = readBindingEntry(configPath, 'd1_databases', binding);
    if (entry && isRealD1Id(entry.database_id)) {
      // F7 (round 11, user-approved contract) — stored-name identity: when the entry
      // STORES a `database_name`, it must EQUAL the desired name before the id is
      // reused. A real id under a CONTRADICTING stored name means the binding points at
      // a DIFFERENT database than this deploy wants — reusing it would silently run the
      // app (and its migrations) against the wrong database. An entry storing NO name
      // keeps ID-only reuse (the id alone is the identity then).
      const storedName = entry.database_name;
      if (storedName !== undefined && storedName !== name) {
        throw new Error(
          `provision: D1 binding ${JSON.stringify(binding)} in "${configPath}" stores ` +
            `database_name ${JSON.stringify(storedName)} (with a real database_id), but this ` +
            `deploy wants database ${JSON.stringify(name)}. Refusing to reuse a database that ` +
            `contradicts the desired name. Fix "${configPath}" — correct the entry's ` +
            `database_name/database_id (or remove the entry to re-provision) — or rename the ` +
            `desired database, then retry.`,
        );
      }
      // Read-first hit. A prior run may have created the D1 (id written) then
      // crashed BEFORE migrations_dir was set, so ensure + verify it here too —
      // idempotent when already present — so the retry converges rather than
      // leaving the gap unfilled forever.
      const res = write({ d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR } });
      assertD1MigrationsDirApplied(res, binding, configPath);
      resources.push({ kind: 'd1', binding, name, action: 'reused', id: entry.database_id });
    } else {
      // Discovery must SUCCEED (gate) before its stdout is parsed, then the whole
      // list is strictly validated — a nonzero/SIGTERM/spawn-error or a malformed
      // member never parses as "absent" and mints a duplicate D1.
      const listResult = await runWrangler(
        ['d1', 'list', '--json', ...wranglerConfigArgs(configPath)],
        {
          captureJson: true,
        },
      );
      assertDiscoverySucceeded(listResult, 'wrangler d1 list');
      const rawList = parseJsonArrayStrict(listResult.stdout);
      if (!rawList) {
        throw new Error(
          `provision: "wrangler d1 list --json" did not return a JSON array; cannot verify whether ` +
            `D1 database ${JSON.stringify(name)} exists. Refusing to create a possible duplicate.`,
        );
      }
      const databases = validateResourceList(rawList, {
        resource: 'D1 database',
        command: 'wrangler d1 list',
        // F7 — the ONE alias reconciler gates EVERY member (never "any one alias
        // valid"): a conflicting or malformed secondary alias rejects the whole list.
        hasValidId: (member) => reconcileD1IdAliases(member).kind === 'id',
        idRule:
          'its uuid/database_id aliases must be present, well-formed D1 UUIDs agreeing on one id',
        nameField: 'name',
        nameLabel: 'named',
      });
      // F5: run the ONE strict normalizer over EVERY member against the requested
      // name. Collect the members that CLAIM the requested name (match or ambiguous).
      // - >1 claimant → ambiguous which to adopt → fail closed;
      // - 1 ambiguous claimant → fail closed (never adopt an ambiguous id, never
      //   mistake it for absent and mint a duplicate);
      // - 1 valid claimant → adopt; 0 → create.
      const claimants = databases
        .map((db) => normalizeD1(db, name))
        .filter((m): m is Exclude<D1Match, { kind: 'other' }> => m.kind !== 'other');
      if (claimants.length > 1) {
        throw new Error(
          `provision: "wrangler d1 list" returned ${claimants.length} D1 databases named ` +
            `${JSON.stringify(name)}. D1 database names are account-unique, so this is ambiguous; ` +
            `cannot pick one to adopt and refusing to create a possible duplicate. Inspect the ` +
            `account and retry.`,
        );
      }
      if (claimants.length === 1 && claimants[0].kind === 'claimed-but-invalid') {
        throw new Error(
          `provision: "wrangler d1 list" returned a D1 database named ${JSON.stringify(name)} with ` +
            `an ambiguous or empty id (conflicting/blank uuid/database_id, or conflicting name ` +
            `aliases). Cannot adopt it, and refusing to create a possible duplicate; inspect the ` +
            `account and retry.`,
        );
      }
      // After the guards above, a lone claimant is necessarily a valid `match`.
      const existing =
        claimants.length === 1 && claimants[0].kind === 'match' ? claimants[0] : undefined;
      if (existing) {
        log.info(`adopted existing D1 database ${name} (${existing.id})`);
        const res = write({
          d1: { binding, databaseName: name, databaseId: existing.id },
          d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR },
        });
        assertD1MigrationsDirApplied(res, binding, configPath);
        resources.push({ kind: 'd1', binding, name, action: 'adopted', id: existing.id });
      } else {
        const created = await runWrangler([
          'd1',
          'create',
          name,
          '--binding',
          binding,
          '--update-config',
          ...wranglerConfigArgs(configPath),
        ]);
        if (isCleanSuccess(created)) {
          // wrangler wrote database_id/database_name via --update-config; VERIFY the
          // real id landed (F4 postcondition), then fill the migrations_dir it does
          // not write.
          assertCreateWroteRealId(
            configPath,
            {
              field: 'd1_databases',
              idField: 'database_id',
              idValidator: isRealD1Id,
              nameField: 'database_name',
              resource: 'D1 database',
              command: 'wrangler d1 create',
            },
            binding,
            name,
          );
          const res = write({ d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR } });
          assertD1MigrationsDirApplied(res, binding, configPath);
          resources.push({ kind: 'd1', binding, name, action: 'created' });
        } else if (isCleanFailure(created) && isAlreadyExistsError(created)) {
          // TOCTOU: created between our list and create (clean non-zero, code 7502).
          // Capture the id via `d1 info` — which must SUCCEED (gate) and POSITIVELY
          // identify THIS database (EXACT name match) before we adopt its id.
          const infoResult = await runWrangler(
            ['d1', 'info', name, '--json', ...wranglerConfigArgs(configPath)],
            { captureJson: true },
          );
          assertDiscoverySucceeded(infoResult, `wrangler d1 info ${name}`);
          // SAME strict normalizer as the list path — must POSITIVELY identify THIS
          // database by an exact name match with an unambiguous id.
          const info = normalizeD1(parseJsonObject(infoResult.stdout), name);
          if (info.kind !== 'match') {
            throw new Error(
              `provision: "wrangler d1 create ${name}" reported the database already exists, ` +
                `but "wrangler d1 info ${name} --json" did not return a database with a matching ` +
                `name and an unambiguous id. Refusing to adopt an unverified database.`,
            );
          }
          log.info(`adopted existing D1 database ${name} (${info.id})`);
          const res = write({
            d1: { binding, databaseName: name, databaseId: info.id },
            d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR },
          });
          assertD1MigrationsDirApplied(res, binding, configPath);
          resources.push({ kind: 'd1', binding, name, action: 'adopted', id: info.id });
        } else {
          // Everything else — a hard failure (signal/spawn error) or a clean
          // non-7502 error — fails closed.
          throw new Error(
            `provision: "wrangler d1 create ${name}" failed: ${created.stderr || created.stdout}`,
          );
        }
      }
    }
  }

  // --- KV ------------------------------------------------------------------
  for (const { binding, title } of desired.kvNamespaces) {
    const entry = readBindingEntry(configPath, 'kv_namespaces', binding);
    if (entry && isRealKvId(entry.id)) {
      resources.push({ kind: 'kv', binding, name: title, action: 'reused', id: entry.id });
      continue;
    }
    // KV titles are NOT account-unique and `kv namespace create` never dedupes,
    // so this list is the ONLY orphan guard. Route it through the SHARED gate +
    // strict validator: the discovery must exit 0 (nonzero/SIGTERM/spawn-error →
    // throw), return a real JSON array, and have EVERY member well-formed (a
    // malformed member — which could BE the target — fails closed rather than being
    // filtered to a false "absent" that mints a duplicate namespace).
    const listResult = await runWrangler(
      ['kv', 'namespace', 'list', ...wranglerConfigArgs(configPath)],
      {
        captureJson: true,
      },
    );
    assertDiscoverySucceeded(listResult, 'wrangler kv namespace list');
    const rawList = parseJsonArrayStrict(listResult.stdout);
    if (!rawList) {
      throw new Error(
        `provision: "wrangler kv namespace list" did not return a JSON array; cannot verify whether ` +
          `KV namespace ${JSON.stringify(title)} exists. Refusing to create a possible duplicate.`,
      );
    }
    const namespaces = validateResourceList(rawList, {
      resource: 'KV namespace',
      command: 'wrangler kv namespace list',
      hasValidId: (member) => isRealKvId(member.id),
      idRule: 'its id is missing or not a well-formed 32-hex namespace id',
      nameField: 'title',
      nameLabel: 'titled',
    });
    const matches = extractKvMatches(namespaces, title);
    if (matches.length > 0) {
      // KV titles are NOT account-unique. Tie-break deterministically on the
      // lexicographically-smallest id so re-runs adopt the same namespace.
      const chosen = matches.reduce((min, ns) => (ns.id < min.id ? ns : min));
      if (matches.length > 1) {
        log.warn(
          `multiple KV namespaces titled "${title}" (${matches
            .map((m) => m.id)
            .join(', ')}); adopting the lexicographically-smallest id ${chosen.id}`,
        );
      }
      log.info(`adopted existing KV namespace ${title} (${chosen.id})`);
      write({ kv: { binding, id: chosen.id } });
      resources.push({ kind: 'kv', binding, name: title, action: 'adopted', id: chosen.id });
    } else {
      const created = await runWrangler([
        'kv',
        'namespace',
        'create',
        title,
        '--binding',
        binding,
        '--update-config',
        ...wranglerConfigArgs(configPath),
      ]);
      if (!isCleanSuccess(created)) {
        throw new Error(
          `provision: "wrangler kv namespace create ${title}" failed: ${created.stderr || created.stdout}`,
        );
      }
      // F4 postcondition: confirm --update-config wrote a REAL id (a killed create
      // masked as exit 0 by wrangler's launcher would leave none).
      assertCreateWroteRealId(
        configPath,
        {
          field: 'kv_namespaces',
          idField: 'id',
          idValidator: isRealKvId,
          resource: 'KV namespace',
          command: 'wrangler kv namespace create',
        },
        binding,
        title,
      );
      resources.push({ kind: 'kv', binding, name: title, action: 'created' });
    }
  }

  // --- R2 ------------------------------------------------------------------
  if (desired.r2) {
    const { binding, bucketName } = desired.r2;
    const entry = readBindingEntry(configPath, 'r2_buckets', binding);
    // F7 (round 11, user-approved contract) — `bucket_name` IS the R2 identity: a stored
    // REAL (non-placeholder) bucket_name that differs from the desired name is a
    // CONTRADICTION — reusing it would keep the app bound to a different bucket while
    // reporting the desired one provisioned. Equal → reuse as before (the desired name
    // already passed the R2 grammar gate, so an equal stored name is format-valid too).
    // F6 (round 12) — ONLY R2's own placeholder (`default`) or an absent/non-string name
    // keeps the discovery path: a stored `local` is a grammar-valid REAL bucket name
    // (the shared check that also rejected `local` let it bypass this contradiction
    // gate and be silently rewritten).
    const storedBucketName = entry?.bucket_name;
    if (entry && isRealStoredR2BucketName(storedBucketName)) {
      if (storedBucketName !== bucketName) {
        throw new Error(
          `provision: R2 binding ${JSON.stringify(binding)} in "${configPath}" stores ` +
            `bucket_name ${JSON.stringify(storedBucketName)}, but this deploy wants bucket ` +
            `${JSON.stringify(bucketName)}. bucket_name IS the R2 identity, so this entry ` +
            `contradicts the desired bucket. Fix "${configPath}" — correct the entry's ` +
            `bucket_name (or remove the entry to re-provision) — or rename the desired bucket, ` +
            `then retry.`,
        );
      }
      resources.push({ kind: 'r2', binding, name: bucketName, action: 'reused' });
    } else {
      // `wrangler r2 bucket list` is a human table, not JSON. Bucket names ARE
      // account-unique, so probe the single bucket by name.
      const info = await runWrangler(
        ['r2', 'bucket', 'info', bucketName, '--json', ...wranglerConfigArgs(configPath)],
        { captureJson: true },
      );
      if (isCleanSuccess(info)) {
        // A clean exit 0 is not enough to adopt — the success payload must
        // POSITIVELY identify the requested bucket (its `name`) before we write the
        // entry, else a mismatched/garbled 0-exit payload could bind the wrong
        // bucket. (A signal-killed probe is NOT a clean success — see the rule.)
        const payload = parseJsonObject(info.stdout);
        if (!payload || payload.name !== bucketName) {
          throw new Error(
            `provision: "wrangler r2 bucket info ${bucketName} --json" exited 0 but did not identify ` +
              `the requested bucket (expected name ${JSON.stringify(bucketName)}). Refusing to adopt an ` +
              `unverified bucket. Output: ${info.stdout || info.stderr}`,
          );
        }
        // Adopt it — write the `{binding,bucket_name}` entry via the writer.
        log.info(`adopted existing R2 bucket ${bucketName}`);
        write({ r2: { binding, bucketName } });
        resources.push({ kind: 'r2', binding, name: bucketName, action: 'adopted' });
      } else if (isConfirmedAbsent(info, 'r2', bucketName)) {
        // CONFIRMED not-found (clean non-zero + exact signal) → create.
        // `--update-config` upserts by binding.
        const created = await runWrangler([
          'r2',
          'bucket',
          'create',
          bucketName,
          '--binding',
          binding,
          '--update-config',
          ...wranglerConfigArgs(configPath),
        ]);
        if (!isCleanSuccess(created)) {
          throw new Error(
            `provision: "wrangler r2 bucket create ${bucketName}" failed: ${created.stderr || created.stdout}`,
          );
        }
        // F4 postcondition: confirm --update-config wrote the requested bucket_name
        // (grammar-valid + EXACT name equality — the name IS the R2 identity).
        // F6 (round 12): no placeholder heuristic here — a desired bucket genuinely
        // named `default` must not fail a create that succeeded.
        assertCreateWroteRealId(
          configPath,
          {
            field: 'r2_buckets',
            idField: 'bucket_name',
            idValidator: isValidR2BucketNameFormat,
            nameField: 'bucket_name',
            resource: 'R2 bucket',
            command: 'wrangler r2 bucket create',
          },
          binding,
          bucketName,
        );
        // F6 (round 12) — when the DESIRED name IS R2's placeholder string, the config
        // postcondition is vacuous: a pre-existing placeholder entry is byte-identical
        // to a real create result, so a masked signal-killed create (wrangler's
        // launcher can report exit 0) would pass it. Verify via the EXACT remote probe
        // instead — the same positive identification the adopt path uses.
        if (bucketName === R2_BUCKET_NAME_PLACEHOLDER) {
          const verify = await runWrangler(
            ['r2', 'bucket', 'info', bucketName, '--json', ...wranglerConfigArgs(configPath)],
            { captureJson: true },
          );
          const payload = isCleanSuccess(verify) ? parseJsonObject(verify.stdout) : undefined;
          if (!payload || payload.name !== bucketName) {
            throw new Error(
              `provision: "wrangler r2 bucket create ${bucketName}" reported success but a ` +
                `follow-up "wrangler r2 bucket info ${bucketName}" did not confirm the bucket ` +
                `exists. The create may have been interrupted — wrangler's launcher can mask a ` +
                `signal-killed child as exit 0, and the config entry is indistinguishable from ` +
                `the local-dev placeholder for this name. Refusing to record an unprovisioned ` +
                `bucket; inspect the account and retry.`,
            );
          }
        }
        resources.push({ kind: 'r2', binding, name: bucketName, action: 'created' });
      } else {
        // A non-zero that is NOT the confirmed not-found signal (auth/metrics/
        // network) — the bucket may well EXIST. Surface the real error instead of
        // attempting a create that would spuriously fail or risk a duplicate.
        throw new Error(
          `provision: "wrangler r2 bucket info ${bucketName}" failed: ${info.stderr || info.stdout}. ` +
            `Cannot determine whether the bucket exists; refusing to create a possible duplicate.`,
        );
      }
    }
  }

  // --- Hyperdrive ----------------------------------------------------------
  // wrangler 4.107 has NO machine-readable Hyperdrive list (`hyperdrive list`
  // prints a cli-table3 box table; there is no `--json`, and `hyperdrive get`
  // takes an id, not a name). `hyperdrive create` on a NON-UNIQUE name silently
  // mints a DUPLICATE config (new UUID), so a re-run without the id in config
  // would keep minting duplicates. Existence is therefore checked via an
  // INJECTABLE Cloudflare REST seam (GET …/hyperdrive/configs, matched by name):
  // reliable + fully testable (unit tests stub it, no real network). Adoption is
  // attempted BEFORE the connection-string gate (it needs no connection string).
  if (desired.hyperdrive) {
    const { binding, name, connectionString } = desired.hyperdrive;
    // The whole-provision lock (F1/F2) already serializes this unguarded list→create
    // across processes: the read-first check below runs UNDER that lock, so a second
    // concurrent provision sees the id the first wrote and SKIPS (no duplicate).
    const entry = readBindingEntry(configPath, 'hyperdrive', binding);
    if (entry && isRealHyperdriveId(entry.id)) {
      resources.push({ kind: 'hyperdrive', binding, name, action: 'reused', id: entry.id });
    } else {
      const lister =
        opts?.listHyperdriveConfigs ?? createDefaultListHyperdriveConfigs(opts?.apiToken);
      // F3 — treat the seam result as UNKNOWN until PROVEN a real array. The OUTER
      // result is validated (`Array.isArray`) BEFORE existence is marked known, so a
      // runtime `null`/`undefined`/non-array is NEVER coerced to "empty" (confirmed
      // absence) — which would authorize a blind create. A malformed outer result and a
      // failed async lister BOTH leave existence UNKNOWN → fail closed if we WOULD create.
      let validatedConfigs: Array<unknown> | undefined;
      let existenceUnknown = true;
      if (lister) {
        try {
          // F1 — always invoke the lister WITH the reconciled account, so an injected
          // lister can never query a DIFFERENT account than the config is pinned to.
          // F4 — bound the WHOLE call by an overall deadline threaded as an `AbortSignal`.
          // `withListerDeadline` aborts the signal AND rejects at the deadline, so even a
          // seam that ignores the signal (a stalled body / never-settling promise) can NEVER
          // keep the heartbeat refreshing the whole-provision lock forever — it fails closed
          // (→ existence unknown → a create attempt throws below → the lock is released).
          const result = await withListerDeadline(
            (signal) =>
              lister({
                accountId: transportAccountId,
                apiBaseUrl: transportApiBaseUrl,
                signal,
              }),
            opts?.listTimeoutMs ?? HYPERDRIVE_LIST_TIMEOUT_MS,
          );
          if (!Array.isArray(result)) {
            throw new Error(
              `the existence check returned a ${result === null ? 'null' : typeof result} result ` +
                `instead of an array`,
            );
          }
          validatedConfigs = result;
          existenceUnknown = false;
        } catch (error) {
          // F4/F5 — redact through the ONE deep redactor before propagating (a
          // lister/network error could echo a URL carrying userinfo credentials, and an
          // injected seam may reject with a plain string instead of an Error).
          const redacted = redactUnknownValue(error, redactSecrets);
          log.warn(
            `Hyperdrive existence check for ${name} failed: ` +
              (redacted instanceof Error ? redacted.message : String(redacted)),
          );
          existenceUnknown = true;
          validatedConfigs = undefined;
        }
      }
      // F3 — the ONE strict per-entry validator runs OUTSIDE the try, on a PROVEN array
      // only, so its malformed-member / duplicate-id / ambiguous-name throws stay HARD
      // failures (never swallowed into "unknown"). It requires EXACTLY 0 or 1 exact-name
      // match (>1 → fail closed) BEFORE matching or writing, so no injected list can be
      // adopted with an empty/garbage id.
      const existing =
        validatedConfigs !== undefined
          ? selectHyperdriveMatch(validatedConfigs, name, configPath)
          : undefined;
      if (existing) {
        log.info(`adopted existing Hyperdrive config ${name} (${existing.id})`);
        write({ hyperdrive: { binding, id: existing.id } });
        resources.push({ kind: 'hyperdrive', binding, name, action: 'adopted', id: existing.id });
      } else if (!connectionString) {
        // No connection string → we can never CREATE, so there is no duplicate
        // risk whether or not existence is known: skip (structured, never prompts).
        const reason = 'no connection string provided';
        log.warn(`skipping Hyperdrive config ${name}: ${reason}`);
        resources.push({ kind: 'hyperdrive', binding, name, action: 'skipped', reason });
      } else if (existenceUnknown) {
        // A connection string is present (we WOULD create) but existence is
        // unverifiable → FAIL CLOSED. Blindly creating duplicates a same-named config.
        throw new Error(
          `provision: cannot verify whether Hyperdrive config ${JSON.stringify(name)} already ` +
            `exists (no existence check available — provide an accountId + API token, or inject a ` +
            `listHyperdriveConfigs seam). "wrangler hyperdrive create" silently duplicates a ` +
            `same-named config, so provisioning refuses to create it blindly.`,
        );
      } else {
        // Confirmed absent + connection string present → create.
        const created = await runWrangler([
          'hyperdrive',
          'create',
          name,
          `--connection-string=${connectionString}`,
          '--binding',
          binding,
          '--update-config',
          ...wranglerConfigArgs(configPath),
        ]);
        if (!isCleanSuccess(created)) {
          throw new Error(
            `provision: "wrangler hyperdrive create ${name}" failed: ${created.stderr || created.stdout}`,
          );
        }
        // F4 postcondition: confirm --update-config wrote a REAL Hyperdrive id.
        assertCreateWroteRealId(
          configPath,
          {
            field: 'hyperdrive',
            idField: 'id',
            idValidator: isRealHyperdriveId,
            resource: 'Hyperdrive config',
            command: 'wrangler hyperdrive create',
          },
          binding,
          name,
        );
        resources.push({ kind: 'hyperdrive', binding, name, action: 'created' });
      }
    }
  }

  // --- Queues (resource only; NEVER writes queue config entries) -----------
  // `wrangler queues list` is a human table, not JSON, and `queues create` has
  // no `--update-config`. So probe each queue by name: `queues info` exits
  // non-zero (`Queue "x" does not exist`) when absent. Task 4 only ensures the
  // queue RESOURCE exists — binding the producers/consumers into the config is
  // app-class-aware and belongs to Task 6.
  for (const name of desired.queues) {
    const info = await runWrangler(['queues', 'info', name, ...wranglerConfigArgs(configPath)]);
    // "Exists → reuse" ONLY when the probe POSITIVELY names THIS queue (F4). A bare
    // clean 0 is NOT trusted: the bin wrapper can mask a signal-killed inner CLI as
    // exit 0 with empty output, which a plain `isCleanSuccess` would misread as
    // reused though nothing was verified.
    if (queueInfoConfirmsExists(info, name)) {
      resources.push({ kind: 'queue', name, action: 'reused' });
      continue;
    }
    // Not confirmed-present. It is "absent" (→ create) ONLY on a CLEAN non-zero exit
    // carrying the EXACT, name-aware not-found signal (`Queue "<name>" does not
    // exist`). Everything else — a signal/spawn failure, an auth error, a generic
    // `Account not found`, OR a masked-kill clean-0 that did NOT positively identify
    // the queue — fails closed (never a blind create, never a false reuse).
    if (!isConfirmedAbsent(info, 'queue', name)) {
      throw new Error(
        `provision: "wrangler queues info ${name}" failed or did not confirm the queue exists: ` +
          `${info.stderr || info.stdout || 'no output'}`,
      );
    }
    const created = await runWrangler([
      'queues',
      'create',
      name,
      ...wranglerConfigArgs(configPath),
    ]);
    if (!isCleanSuccess(created)) {
      throw new Error(
        `provision: "wrangler queues create ${name}" failed: ${created.stderr || created.stdout}`,
      );
    }
    // F4 verify probe — queues write NO config, so `assertCreateWroteRealId` cannot
    // cover them. A create reporting clean 0 is NOT enough (the bin wrapper masks a
    // signal-killed inner CLI as exit 0, creating nothing). RE-RUN the SAME positive
    // `queues info` probe and only record `created` if it now confirms THIS queue;
    // otherwise fail closed (a killed create self-heals on the next run's probe).
    const verify = await runWrangler(['queues', 'info', name, ...wranglerConfigArgs(configPath)]);
    if (!queueInfoConfirmsExists(verify, name)) {
      throw new Error(
        `provision: "wrangler queues create ${name}" reported success but "wrangler queues info ` +
          `${name}" did not confirm the queue exists afterward. The create may have been ` +
          `interrupted — wrangler's launcher can mask a signal-killed child as exit 0. Refusing to ` +
          `record an unprovisioned queue; inspect the account and retry.`,
      );
    }
    resources.push({ kind: 'queue', name, action: 'created' });
  }

  // account_id was persisted up front (before any remote side effect) — see the
  // account_id block near the top of this function (F1 fail-closed pin).
  return { resources, configPath, accountIdWritten };
}
