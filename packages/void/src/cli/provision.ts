import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePosixPath } from 'node:path/posix';
import { resolve as resolveWindowsPath } from 'node:path/win32';
import { types as utilTypes } from 'node:util';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { isRecord } from '@void/deploy-core';
import { parse, type ParseError } from 'jsonc-parser';
import { basename, dirname, join, normalize, resolve } from 'pathslash';
import lockfile from 'proper-lockfile';
import { voidLog, voidWarn } from '../log.ts';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import {
  encodeCloudflareOperation,
  decodeCloudflareOperationResult,
} from './cloudflare-process.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';
import {
  assertNoDuplicateMembers,
  persistMaterializedWranglerConfig,
  readProvisionedBindingEntry,
  writeProvisionedWranglerConfig,
  type WriteProvisionedWranglerResult,
} from './wrangler.ts';

/**
 * The set of Cloudflare resources an app needs, computed by the deploy
 * orchestrator from inferred bindings + config. The provisioner
 * consumes this as-is; it never computes the set itself.
 *
 * `binding` values are the pre-validated uppercase names the app already uses
 * (`DB`, `KV`, `ISR_CACHE`, `STORAGE`, `HYPERDRIVE`) and are passed to wrangler
 * verbatim.
 */
export interface DesiredResourceSet {
  /**
   * D1 database — `{ binding: 'DB', name: 'myapp-db' }`. `migrationsDir` is the
   * config-relative `migrations_dir` to write on the D1 entry (sourceDir-aware);
   * when omitted the provisioner falls back to the default `./db/migrations`.
   */
  d1?: { binding: string; name: string; migrationsDir?: string };
  /** KV namespaces (app KV + `ISR_CACHE`). Titles are NOT account-unique. */
  kvNamespaces: Array<{ binding: string; title: string }>;
  /** R2 bucket — bucket names ARE account-unique. */
  r2?: { binding: string; bucketName: string };
  /** Queue resource NAMES to ensure exist (account-unique). */
  queues: Array<string>;
  /** Hyperdrive config — a connection string is required only to CREATE one. */
  hyperdrive?: { binding: string; name: string; connectionString: string };
}

/** One DESIRED id-bearing resource absent (or placeholder-only) in the config. */
export interface ProvisionDriftEntry {
  /** Binding name (`DB`, `KV`, `ISR_CACHE`, `STORAGE`, `HYPERDRIVE`). */
  binding: string;
  kind: 'd1' | 'kv' | 'r2' | 'hyperdrive';
  /** Resource name / KV title / bucket name the deploy wants. */
  name: string;
}

export interface ProvisionDriftResult {
  /** Desired id-bearing resources not yet provisioned (real-id) in the config. */
  missing: Array<ProvisionDriftEntry>;
}

/**
 * Diff the DESIRED id-bearing resources against the ACTUAL bindings in the root
 * wrangler config, WITHOUT any remote/wrangler call. A resource counts as
 * provisioned ONLY when its binding entry exists with a REAL (non-placeholder)
 * identifier — the SAME predicate the provisioner's read-first uses:
 *   - D1 `database_id` is a real UUID ({@link isRealD1Id}, not `'local'`);
 *   - KV `id` is a real 32-hex ({@link isRealKvId}, not `'local'`);
 *   - R2 `bucket_name` names a real bucket ({@link isRealStoredR2BucketName});
 *   - Hyperdrive `id` is a real 32-hex ({@link isRealHyperdriveId}).
 *
 * Queues are NAME-bearing (no id in the config), so they are NOT part of this
 * id-drift check. A missing config file yields every desired resource as missing.
 *
 * Used by the deploy orchestrator to decide whether automatic provisioning is needed
 * and to verify that every id-bearing resource was satisfied afterward.
 * A malformed/duplicate-binding config makes {@link readProvisionedBindingEntry}
 * throw — fail closed, exactly as the provisioner would.
 */
export function checkCloudflareProvisionDrift(
  configPath: string,
  desired: DesiredResourceSet,
): ProvisionDriftResult {
  const config = readRootConfig(configPath);
  const missing: Array<ProvisionDriftEntry> = [];
  const isProvisioned = (
    field: string,
    binding: string,
    hasRealId: (entry: Record<string, unknown>) => boolean,
  ): boolean => {
    const entry = readProvisionedBindingEntry(config, field, binding, configPath);
    return entry !== undefined && hasRealId(entry);
  };
  if (desired.d1) {
    if (!isProvisioned('d1_databases', desired.d1.binding, (e) => isRealD1Id(e.database_id))) {
      missing.push({ binding: desired.d1.binding, kind: 'd1', name: desired.d1.name });
    }
  }
  for (const kv of desired.kvNamespaces) {
    if (!isProvisioned('kv_namespaces', kv.binding, (e) => isRealKvId(e.id))) {
      missing.push({ binding: kv.binding, kind: 'kv', name: kv.title });
    }
  }
  if (desired.r2) {
    if (
      !isProvisioned('r2_buckets', desired.r2.binding, (e) =>
        isRealStoredR2BucketName(e.bucket_name, desired.r2?.bucketName),
      )
    ) {
      missing.push({ binding: desired.r2.binding, kind: 'r2', name: desired.r2.bucketName });
    }
  }
  if (desired.hyperdrive) {
    if (!isProvisioned('hyperdrive', desired.hyperdrive.binding, (e) => isRealHyperdriveId(e.id))) {
      missing.push({
        binding: desired.hyperdrive.binding,
        kind: 'hyperdrive',
        name: desired.hyperdrive.name,
      });
    }
  }
  return { missing };
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
  data?: unknown;
  errorCode?: number;
  failure?: 'not-found' | 'durable-migration' | 'containers-unavailable';
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
 * The transport context threaded into EVERY wrangler invocation (default AND
 * injected). Its `accountId` is the ONE reconciled effective account this whole
 * provision is pinned to: the default runner uses it to pin the spawned wrangler's
 * env (`CLOUDFLARE_ACCOUNT_ID`), and an
 * injected seam MUST bind its own transport to the SAME account (so it can never
 * query account B while the config pins A and write a same-name B result into A).
 */
export interface WranglerCallContext {
  /** The reconciled effective Cloudflare account (never empty for a real call). */
  accountId: string;
  /**
   * The ONE pinned Cloudflare API base URL this provision resolved (mirroring
   * wrangler's own `getCloudflareApiBaseUrl`), threaded so the default runner can pin the
   * spawned wrangler's `CLOUDFLARE_API_BASE_URL` to the SAME endpoint the Hyperdrive REST
   * lister uses. An injected seam may ignore it (it owns its own transport).
   */
  apiBaseUrl?: string;
  /** Pin the operator credential selected by the caller for every subprocess. */
  apiToken?: string;
  cwd?: string;
  input?: string;
  /** Keep borrowed OAuth bearer values out of Wrangler's on-disk logs. */
  suppressLogs?: boolean;
}

/**
 * The seam returns a Promise (or a plain value, which the choke point coerces
 * with `Promise.resolve`). The default runner is ASYNC (`spawn`, awaited) so a slow
 * wrangler call NEVER blocks the event loop, which keeps `proper-lockfile`'s heartbeat
 * timer firing (a synchronous `spawnSync` would freeze the loop, so the heartbeat could
 * not refresh the mutex mtime and another process could steal a lock we still hold).
 * Injected unit-test stubs may stay synchronous (returning a plain `RunWranglerResult`)
 * — `Promise.resolve` at the choke point wraps them transparently.
 */
export type RunWrangler = (
  args: CloudflareOperation,
  opts: WranglerCallContext,
) => RunWranglerResult | Promise<RunWranglerResult>;

/** A Cloudflare Hyperdrive config as returned by the account-list existence check. */
export interface HyperdriveConfig {
  id: string;
  name: string;
}

/**
 * Seam over listing the account's Hyperdrive configs (wrangler 4.131 has NO
 * machine-readable `hyperdrive list` and no get-by-name, so existence is checked
 * via the Cloudflare REST API). The default implementation
 * ({@link createDefaultListHyperdriveConfigs}) calls
 * `GET /accounts/{id}/hyperdrive/configs`; unit tests inject a stub so no real
 * network call runs.
 *
 * The lister receives the reconciled `accountId` AND the pinned `apiBaseUrl` as an
 * explicit transport context (never a closure-only binding), so an injected lister can
 * never query a DIFFERENT account/endpoint than the one wrangler + the config are pinned
 * to. The default lister builds its REST URL from `apiBaseUrl` instead of hardcoding prod.
 */
export type ListHyperdriveConfigs = (ctx: {
  accountId: string;
  apiBaseUrl: string;
  /**
   * The abort signal enforcing the caller's OVERALL lister deadline. The default lister
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

type PinnedRunWrangler = (
  args: CloudflareOperation,
  callOpts?: { cwd?: string; suppressLogs?: boolean; input?: string },
) => Promise<RunWranglerResult>;

type ProvisionConfigWriter = (
  patch: Parameters<typeof writeProvisionedWranglerConfig>[1],
) => WriteProvisionedWranglerResult;

export interface ProvisionLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Where Void keeps D1 migrations — written as `migrations_dir` on the D1 entry. */
const D1_MIGRATIONS_DIR = './db/migrations';

/** UTF-8 byte-order mark. Node's utf-8 read preserves a leading one. */
const UTF8_BOM = '﻿';

// --- Per-resource local-dev placeholder metadata -----------------
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

// --- Resource-SPECIFIC real-id format validators --------------------------
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
/** R2 bucket names ARE the identity: wrangler 4.131's `isValidR2BucketName`. */
const R2_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * A D1 `database_id` that is a real (non-placeholder) hyphenated UUID. Exported so
 * the deploy orchestrator applies the SAME placeholder rule when deciding whether a
 * stored `database_name` names a real DB (a synced `database_id: "local"` must not
 * let its paired name become the production database identity).
 */
export function isRealD1Id(value: unknown): value is string {
  return typeof value === 'string' && value !== D1_ID_PLACEHOLDER && D1_ID_RE.test(value);
}
/**
 * A KV namespace `id` that is a real (non-placeholder) 32-hex string. Exported so the
 * deploy orchestrator applies the SAME placeholder rule when checking whether two KV
 * bindings already share one provisioned namespace.
 */
export function isRealKvId(value: unknown): value is string {
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
 * A STORED R2 `bucket_name` that names a REAL bucket, i.e. any non-empty string
 * other than the placeholder (`default`), unless `default` itself is desired.
 * `local` IS a real name here. Grammar is
 * deliberately not required: a grammar-invalid stored name that contradicts the desired
 * bucket must still fail closed as a contradiction, never be silently rewritten.
 */
function isRealStoredR2BucketName(value: unknown, desiredName?: string): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (value !== R2_BUCKET_NAME_PLACEHOLDER || value === desiredName)
  );
}

const defaultLogger: ProvisionLogger = {
  info: (msg) => voidLog(msg),
  warn: (msg) => voidWarn(msg),
};

/**
 * The transport-redirecting env vars wrangler 4.131 honors. Each can point
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
 * Wrangler 4.131's diagnostic-output sinks that would PERSIST the raw provisioning
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
const OUTPUT_FILE_ENV_VARS = [
  'WRANGLER_OUTPUT_FILE_PATH',
  'WRANGLER_OUTPUT_FILE_DIRECTORY',
] as const;

/**
 * Resolve the ONE Cloudflare API base URL this provision is pinned to, mirroring
 * wrangler 4.131's `getCloudflareApiBaseUrl` EXACTLY (wrangler-dist/cli.js) so the
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
    env.CLOUDFLARE_API_BASE_URL !== undefined ? env.CLOUDFLARE_API_BASE_URL : env.CF_API_BASE_URL;
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
 * Mirror wrangler 4.131's `getCloudflareApiEnvironmentFromEnv` (env factory with
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

/** The compliance-region choices wrangler 4.131 accepts (`getCloudflareComplianceRegionFromEnv`). */
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
 * Reconcile the effective Cloudflare compliance region, mirroring wrangler 4.131's
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
 * Mirror wrangler 4.131's `getDefaultEnvFiles(env)`: base `.env`/`.env.local`, then —
 * when the environment argument is DEFINED (we always pass `--env=`, so wrangler sees
 * `args.env === ""`, which is `!== undefined`) — the per-env pair `.env.${env}`/`.env.${env}.local`.
 * With the empty environment those are the empty-env filenames `.env.` and `.env..local`.
 */
function defaultWranglerEnvFiles(env: string): Array<string> {
  return ['.env', '.env.local', `.env.${env}`, `.env.${env}.local`];
}

/**
 * FAIL CLOSED when the project's dotenv files declare a transport-redirecting
 * variable. wrangler 4.131 reloads `.env`/`.env.local` (and the dev-vars files) from the
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
  // Scan the EXACT files wrangler 4.131 loads for the
  // provisioner's `--env=` (EMPTY environment string), with wrangler's own per-family
  // SELECTION and CASE semantics, using a KEY scanner that mirrors wrangler's dotenv
  // parser (accepts the optional `export ` prefix + quoting):
  //   - DOTENV family — the per-command `process.env` reload (the startup middleware's
  //     `check`) loads ALL of `getDefaultEnvFiles("")` = [".env", ".env.local", ".env.",
  //     ".env..local"] via `loadDotEnv`, which parses into `caseInsensitiveEnv()` when
  //     `process.platform === "win32"` (a Proxy canonicalizing property names via
  //     `toLowerCase`) — so dotenv KEYS fold case ONLY on win32, exactly elsewhere.
  //   - DEV-VARS family — `loadDotDevDotVars(envPath, env)` is (wrangler-dist/cli.js):
  //       env !== undefined && tryLoadDotDevDotVars(`${envPath}.${env}`)
  //         || tryLoadDotDevDotVars(envPath)
  //     For the empty env it probes `.dev.vars.` FIRST and reads `.dev.vars` ONLY when
  //     `.dev.vars.` is ABSENT — exactly ONE file is ever parsed, so the fence inspects
  //     only the SELECTED one (fencing both falsely rejected a benign `.dev.vars.`
  //     paired with an unused redirect var in `.dev.vars` that wrangler never reads).
  //     `tryLoadDotDevDotVars` parses via `dotenv.parse` into a PLAIN object —
  //     case-SENSITIVE on EVERY platform (`caseInsensitiveEnv` is used only by
  //     `loadDotEnv`), so no case folding applies to dev-vars keys anywhere. It NEVER
  //     loads `.dev.vars.local`, so that file stays deliberately unfenced.
  // We do NOT expand — presence of the KEY is the signal.
  const dotenvCaseInsensitive = platform === 'win32';
  const devVarsFile = existsSync(join(root, '.dev.vars.')) ? '.dev.vars.' : '.dev.vars';
  const files: Array<{ file: string; caseInsensitive: boolean }> = [
    ...defaultWranglerEnvFiles('').map((file) => ({
      file,
      caseInsensitive: dotenvCaseInsensitive,
    })),
    { file: devVarsFile, caseInsensitive: false },
  ];
  for (const { file, caseInsensitive } of files) {
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
    // Wrangler's session-output sinks are fenced too: wrangler reloads this dotenv
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
 * Delete `name` from `env` IN PLACE, honoring the platform's env-key case rule.
 * Windows environment keys are CASE-INSENSITIVE: a spawned child's `process.env`
 * resolves `WRANGLER_OUTPUT_FILE_PATH` from an ambient `Wrangler_Output_File_Path`
 * too, so an exact-case `delete` leaves a mixed-case spelling live. On win32 every
 * case-insensitive spelling is removed; elsewhere POSIX env vars are case-sensitive,
 * so only the exact key is a match. Exported so the deploy orchestrator scrubs its
 * OWN extra deploy-time keys (worker-name override, build-config-path) through the
 * SAME rule the provisioner uses, instead of re-deriving it.
 */
export function deleteEnvVarCaseAware(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    delete env[name];
    return;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) {
      delete env[key];
    }
  }
}

/**
 * Child-process env with every CF Access credential scrubbed. Mirrors `buildEnv`
 * in `deploy.ts`: Access credentials are needed only by this CLI's own guarded
 * HTTP requests and must never leak into the spawned wrangler process (which may
 * in turn run user hooks). This includes the short-lived cloudflared
 * `CF_ACCESS_TOKEN` JWT used by local readiness probes.
 *
 * Pins ONE transport context: scrubs every {@link TRANSPORT_REDIRECT_ENV_VARS}
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
  apiToken?: string;
  /** Test seam for the win32 case rule; production always uses the real platform. */
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Windows environment keys are CASE-INSENSITIVE: the spawned child's
  // `process.env` resolves `WRANGLER_OUTPUT_FILE_PATH` from an ambient
  // `Wrangler_Output_File_Path` too, so an exact-case `delete` left every scrub below
  // bypassable by a mixed-case spelling (wrangler would then see the sink var and
  // persist the raw argv — Hyperdrive password included — to disk). Scrub EVERY
  // case-insensitive spelling of EVERY scrubbed/pinned key on win32; exact-case
  // elsewhere (POSIX env vars are case-sensitive, so other spellings are genuinely
  // different variables).
  const platform = ctx?.platform ?? process.platform;
  const scrub = (name: string): void => deleteEnvVarCaseAware(env, name, platform);
  scrub('CF_ACCESS_CLIENT_ID');
  scrub('CF_ACCESS_CLIENT_SECRET');
  scrub('CF_ACCESS_TOKEN');
  scrub('VOID_ACCESS_CREDENTIALS');
  scrub('VOID_ACCESS_ORIGIN');
  // Scrub EVERY transport-redirecting selector (CLOUDFLARE_ENV, the API-base overrides,
  // WRANGLER_API_ENVIRONMENT, CLOUDFLARE_COMPLIANCE_REGION). CLOUDFLARE_ENV would select a
  // named env-block whose account_id/bindings differ; the others would re-derive a
  // different API base. We fold their effect into the ONE explicit base below.
  for (const name of TRANSPORT_REDIRECT_ENV_VARS) {
    scrub(name);
  }
  // Scrub wrangler's session-output sinks (they would persist the raw argv —
  // a Hyperdrive connection string's password included — to disk) and PIN sanitized
  // logging: never pass through an ambient `WRANGLER_LOG_SANITIZE=false` for a
  // secret-bearing invocation. A truthy pinned value also survives wrangler's
  // per-command dotenv reload (dotenv-expand keeps a set truthy process.env value).
  // The pinned keys' case-variants are scrubbed FIRST so the canonical spelling
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
  // env even if a stray CLOUDFLARE_ENV survived elsewhere. Pinned by PRESENCE: a
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
  // Case-variants scrubbed first so the pin is unambiguous on win32.
  if (ctx?.accountId) {
    scrub('CLOUDFLARE_ACCOUNT_ID');
    env.CLOUDFLARE_ACCOUNT_ID = ctx.accountId;
  }
  if (ctx?.apiToken) {
    for (const name of [
      'CLOUDFLARE_API_TOKEN',
      'CF_API_TOKEN',
      'CLOUDFLARE_API_KEY',
      'CF_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CF_EMAIL',
    ]) {
      scrub(name);
    }
    env.CLOUDFLARE_API_TOKEN = ctx.apiToken;
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
 * After a timeout SIGKILL, how long to keep confirming the child is ACTUALLY gone —
 * BOTH its `close` event AND whole-group disappearance (`kill(-pid, 0)` → ESRCH) — before
 * giving up. SIGKILL is uncatchable, so a healthy kernel reaps the group within
 * milliseconds; this generous bound only guards a pathological uninterruptible-sleep child.
 * The runner NEVER settles a timeout as "done" until both facts are confirmed; an expiry
 * (or a failed kill) REJECTS with a {@link WranglerQuarantineError} instead, so the
 * whole-provision lock — released only after a CONFIRMED settle — is intentionally
 * retained while the real wrangler CLI may still be creating resources.
 */
const CONFIRM_KILL_GRACE_MS = 5_000;
/** The pid-poll interval while confirming post-SIGKILL termination. */
const CONFIRM_KILL_POLL_MS = 20;
/**
 * The margin the coordinator-WIDE teardown deadline adds on top of a
 * runner's own confirmation grace window: a signal teardown is bounded at
 * `confirmGraceMs + this` even if the runner's bounded confirmation never calls back.
 */
const SIGNAL_TEARDOWN_DEADLINE_MARGIN_MS = 5_000;

/**
 * Classify a process-group kill error. `ESRCH` means the group ALREADY exited (there was
 * nothing left to kill) → success. ANY other code (`EPERM`, …) is a REAL kill failure: the
 * child may still be running, so it must be surfaced, never swallowed. Exported for direct
 * unit testing of the classification the timeout/cancel paths rely on.
 */
export function isAlreadyGoneKillError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
}

/**
 * A QUARANTINE failure: the runner could NOT confirm that a spawned
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
 * The owner metadata a quarantine records: the unconfirmed wrangler
 * child's pid (on POSIX the child is spawned `detached`, so its pid IS its process-GROUP
 * id) and a human-readable reason. Persisted in the quarantine sidecar next to the lock
 * (see {@link acquireProvisionLock}) so EVERY later acquisition can probe the recorded
 * group before the mutex could otherwise be stolen by the mtime-stale path.
 */
export interface QuarantineInfo {
  pid?: number;
  reason: string;
}

// --- AT MOST ONE active provision per process --------------------------
// THE structural invariant the signal coordinator (below) relies on: a single CLI
// process runs AT MOST ONE provision at a time — the deploy orchestrator
// calls `provisionCloudflareResources` exactly once per process, and CROSS-process
// concurrency is what the on-disk whole-provision lock serializes. Because every
// wrangler call inside a provision is awaited sequentially, this guard means the
// signal coordinator manages AT MOST ONE {wrangler child group, provision lock} pair
// at any moment — which is what makes its dispatch barrier, its 1:1 quarantine
// binding, and its bounded teardown structurally simple instead of racy.
// A second in-process provision fails fast and loudly here rather than eroding those
// invariants. The slot is taken SYNCHRONOUSLY at provision entry (before the first
// await), so two same-tick calls cannot both pass.
let activeProvisionSlot: symbol | undefined;

function acquireProcessProvisionSlot(): () => void {
  if (activeProvisionSlot !== undefined) {
    throw new Error(
      'provision: a provision is already active in this process — run provisions ' +
        'sequentially. provisionCloudflareResources supports at most one concurrent ' +
        'provision per process; concurrent provisions across PROCESSES are serialized ' +
        'by the on-disk provision lock instead.',
    );
  }
  // While a previous provision's retention watchdog is still nursing an
  // undurably-quarantined lock (unconfirmed child, no durable sidecar yet), a new
  // provision would hand the coordinator a second pair; refuse until it resolves.
  if (retentionWatchdog !== undefined) {
    throw new Error(
      'provision: a previous provision in this process is still retaining its lock — an ' +
        `unconfirmed wrangler child` +
        `${retentionWatchdog.info.pid !== undefined ? ` (pid ${retentionWatchdog.info.pid})` : ''} ` +
        'could not be quarantined durably yet. No new provision may start until that ' +
        'retention resolves (the child is confirmed dead, or the quarantine metadata ' +
        'persists durably).',
    );
  }
  const token = Symbol('void-provision-slot');
  activeProvisionSlot = token;
  return () => {
    if (activeProvisionSlot === token) {
      activeProvisionSlot = undefined;
    }
  };
}

/**
 * The ONE active provision's lock-quarantine hook, 1:1 with the
 * provision slot above. When the parent process is about to DIE re-raising a forwarded
 * SIGINT/SIGTERM while a spawned wrangler child's teardown could NOT be confirmed,
 * proper-lockfile's signal-exit sweep would remove the still-TRACKED provision mutex —
 * releasing the lock under a possibly-live child. {@link provisionCloudflareResources}
 * sets this for the duration of the provision; a registering wrangler child CAPTURES it
 * at registration (see {@link registerRunner}) so an unresolved teardown quarantines
 * exactly ITS OWNING provision lock with ITS OWN pid metadata — never a broadcast
 * through every lock (the previous Set this replaces stamped the FIRST unresolved
 * registrant's pid into every lock's sidecar, so a foreign group's death could clear a
 * quarantine whose real child was alive).
 */
let activeProvisionQuarantineHook: ((info: QuarantineInfo) => void) | undefined;

/** True when `error` is a quarantine failure whose provision lock must stay retained. */
export function isQuarantineError(error: unknown): error is WranglerQuarantineError {
  return (
    error instanceof WranglerQuarantineError ||
    (error as { quarantine?: boolean } | null)?.quarantine === true
  );
}

// --- THE process-wide signal coordinator ----------------------
// ONE coordinator owns forward → confirm → quarantine → re-raise for the (at most one
// — see the provision slot above) active {wrangler child group, provision lock} pair:
// the runner registers its pair for the child's lifetime; listeners are installed only
// while a registration / teardown / retention watchdog is active; on the FIRST
// SIGINT/SIGTERM the coordinator forwards the signal to the registered group, awaits
// its bounded both-facts confirmation, quarantines it if unresolved (the OWNING lock's
// hook, bound at registration, with THIS pair's own pid metadata), and then re-raises
// EXACTLY ONCE. Repeated signals during the teardown are coalesced by the
// still-installed handler (no second re-raise, no default-action bypass).
// The barrier is PRE-ACCOUNTED from a snapshot taken BEFORE dispatch
// (a synchronously-failing registrant can never finish the teardown mid-dispatch), new
// wrangler spawns are REJECTED outright once a teardown began (fail fast, no child
// spawned → nothing to confirm — never a late join with a fresh deadline), and one
// coordinator-WIDE deadline backstops the whole teardown (an unconfirmable pair is
// quarantined at the bound, so `pending` can never wedge the re-raise forever).

/** What a runner registers with the coordinator for its child's lifetime. */
interface TerminationRegistrant {
  /** The child's pid (its process-GROUP id on POSIX), for quarantine metadata. */
  pid: () => number | undefined;
  /** Forward `signal` to the child's whole process group (see the runner's signalGroup). */
  signalGroup: (signal: NodeJS.Signals) => 'signaled' | 'gone' | { error: Error };
  /** Record that the group is already confirmed gone (an ESRCH outcome of the forward). */
  markGroupGone: () => void;
  /** Start the runner's bounded both-facts confirmation; exactly one callback fires. */
  awaitConfirmedDead: (
    onDone: (outcome: { confirmed: true } | { confirmed: false; detail: string }) => void,
  ) => void;
  /** Reject the runner promise with a quarantine error (idempotent once settled). */
  quarantine: (detail: string) => void;
  /**
   * The coordinator-WIDE teardown deadline for this pair: if the bounded
   * both-facts confirmation has not called back by then, the coordinator quarantines the
   * pair itself, so a fatal signal's teardown is ALWAYS globally bounded.
   */
  teardownDeadlineMs: number;
}

/**
 * A registration binds the registrant to ITS OWNING provision lock's
 * quarantine hook (captured from the active provision at registration time), so
 * an unresolved teardown quarantines exactly that lock with exactly this pair's pid.
 */
interface ActiveRegistration {
  registrant: TerminationRegistrant;
  lockQuarantine: ((info: QuarantineInfo) => void) | undefined;
  parallelWorkerUpload: boolean;
}

interface CoordinatorTeardown {
  signal: NodeJS.Signals;
  /** Pre-accounted from the registration snapshot BEFORE dispatch. */
  pending: number;
  /** True while the initial dispatch is still running (finish latch). */
  dispatching: boolean;
  persistFailed: boolean;
  finished: boolean;
  /** The coordinator-wide deadline backstop (referenced; cleared at finish). */
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** Expire every still-pending pair at the deadline (each has its own done flag). */
  expirePendingPairs: Array<(detail: string) => void>;
}

/** Concurrent registrations are allowed only for two immutable Worker uploads. */
const activeRegistrations = new Map<TerminationRegistrant, ActiveRegistration>();
let coordinatorListenersInstalled = false;
let activeTeardown: CoordinatorTeardown | undefined;
let reRaisedOnce = false;

const onCoordinatorSigint = (): void => coordinatorHandleSignal('SIGINT');
const onCoordinatorSigterm = (): void => coordinatorHandleSignal('SIGTERM');

function installCoordinatorListeners(): void {
  if (coordinatorListenersInstalled) {
    return;
  }
  coordinatorListenersInstalled = true;
  process.on('SIGINT', onCoordinatorSigint);
  process.on('SIGTERM', onCoordinatorSigterm);
}

function removeCoordinatorListeners(): void {
  if (!coordinatorListenersInstalled) {
    return;
  }
  coordinatorListenersInstalled = false;
  process.removeListener('SIGINT', onCoordinatorSigint);
  process.removeListener('SIGTERM', onCoordinatorSigterm);
}

function canRegisterRunner(parallelWorkerUpload: boolean): boolean {
  return (
    activeRegistrations.size === 0 ||
    (parallelWorkerUpload &&
      activeProvisionQuarantineHook === undefined &&
      activeRegistrations.size < 2 &&
      [...activeRegistrations.values()].every((entry) => entry.parallelWorkerUpload))
  );
}

function registerRunner(registrant: TerminationRegistrant, parallelWorkerUpload: boolean): void {
  // The pre-spawn check and registration run in one synchronous block.
  if (!canRegisterRunner(parallelWorkerUpload)) {
    throw new Error(
      'provision: internal invariant violated — a Cloudflare child tried to register outside its concurrency limit',
    );
  }
  activeRegistrations.set(registrant, {
    registrant,
    // Bind the OWNING provision lock at registration (1:1). Undefined
    // for a bare runner used outside a provision (unit tests): there is no lock to
    // retain, so an unresolved pair only rejects its own promise.
    lockQuarantine: activeProvisionQuarantineHook,
    parallelWorkerUpload,
  });
  installCoordinatorListeners();
}

function deregisterRunner(registrant: TerminationRegistrant): void {
  activeRegistrations.delete(registrant);
  // Keep the listeners through an active teardown (they COALESCE repeated signals) and
  // while a retention watchdog is unresolved (a default-action death would sweep
  // the still-tracked mutex under the possibly-live child).
  if (
    activeRegistrations.size === 0 &&
    activeTeardown === undefined &&
    retentionWatchdog === undefined
  ) {
    removeCoordinatorListeners();
  }
}

function coordinatorHandleSignal(signal: NodeJS.Signals): void {
  // Coalesce: repeated signals during an in-flight teardown are swallowed by this
  // still-installed handler — no second re-raise, no bypass of the confirmation
  // barrier.
  if (activeTeardown !== undefined) {
    return;
  }
  // While the retention watchdog holds an undurably-quarantined lock,
  // the process must NOT die of a re-raise: the exit sweep would release the tracked
  // mutex under the possibly-live child. Swallow the signal with a warning; the
  // watchdog resolves by confirming the child dead or persisting the sidecar.
  if (retentionWatchdog !== undefined && activeRegistrations.size === 0) {
    process.stderr.write(
      `provision: ignoring ${signal} — a provision lock is retained while an unconfirmed ` +
        `wrangler child may live and its quarantine metadata is not yet durable. The ` +
        `process exits once the child is confirmed dead or the metadata persists.\n`,
    );
    return;
  }
  const teardown: CoordinatorTeardown = {
    signal,
    pending: 0,
    dispatching: true,
    persistFailed: false,
    finished: false,
    deadlineTimer: undefined,
    expirePendingPairs: [],
  };
  activeTeardown = teardown;
  // Snapshot + PRE-ACCOUNT the barrier BEFORE dispatch: `pending` is
  // initialized from the snapshot size, so a registrant that fails/settles
  // SYNCHRONOUSLY during dispatch can never drop it to 0 and finish the teardown while
  // the dispatch loop is still outstanding, and the `dispatching` latch
  // defers the finish until the loop below has fully completed.
  const snapshot = [...activeRegistrations.values()];
  teardown.pending = snapshot.length;
  if (snapshot.length > 0) {
    // The coordinator-WIDE deadline backstop: even if a pair's bounded
    // confirmation never calls back, the teardown quarantines the pair and completes at
    // this bound. REFERENCED — the teardown must hold the loop open until resolved.
    const deadlineMs = Math.max(...snapshot.map((r) => r.registrant.teardownDeadlineMs));
    teardown.deadlineTimer = setTimeout(() => {
      for (const expire of teardown.expirePendingPairs) {
        expire(
          `the coordinator-wide ${deadlineMs}ms teardown deadline expired before the process ` +
            `group's termination was confirmed`,
        );
      }
    }, deadlineMs);
  }
  for (const registration of snapshot) {
    coordinatorTearDownRegistrant(teardown, registration);
  }
  teardown.dispatching = false;
  maybeFinishCoordinatorTeardown(teardown);
}

/** Finish only after the initial dispatch fully completed AND every
 * snapshot registrant resolved (confirmed or quarantined). */
function maybeFinishCoordinatorTeardown(teardown: CoordinatorTeardown): void {
  if (!teardown.dispatching && teardown.pending === 0) {
    finishCoordinatorTeardown(teardown);
  }
}

function coordinatorTearDownRegistrant(
  teardown: CoordinatorTeardown,
  registration: ActiveRegistration,
): void {
  const { registrant, lockQuarantine } = registration;
  let done = false;
  const complete = (): void => {
    if (done) {
      return;
    }
    done = true;
    teardown.pending -= 1;
    maybeFinishCoordinatorTeardown(teardown);
  };
  const quarantinePair = (detail: string): void => {
    if (done) {
      return;
    }
    // Before-death retention of ONLY this pair's OWNING provision lock,
    // with THIS registrant's own pid metadata (bound 1:1 at registration — never a
    // broadcast through every lock hook, which stamped a foreign pair's pid into
    // unrelated sidecars). Synchronous: the sidecar must be persisted and the lock
    // detached from the exit sweep before the process could die of the re-raise.
    if (lockQuarantine !== undefined) {
      try {
        lockQuarantine({
          pid: registrant.pid(),
          reason:
            `the spawned wrangler could not be confirmed terminated after a forwarded ` +
            `${teardown.signal} — ${detail}`,
        });
      } catch (failure) {
        // The lock could NOT be quarantined durably; it
        // stays TRACKED and the retention watchdog (armed by the hook wrapper) now owns
        // the unresolved state. The finish below must not re-raise.
        teardown.persistFailed = true;
        process.stderr.write(`provision: ${(failure as Error).message}\n`);
      }
    }
    const pid = registrant.pid();
    process.stderr.write(
      `provision: warning — the wrangler child process group` +
        `${typeof pid === 'number' ? ` (pid ${pid})` : ''} could not be confirmed terminated ` +
        `after ${teardown.signal} (${detail}). It may still be running; the provision lock is ` +
        `retained (quarantined) — verify the process is dead before re-running provision.\n`,
    );
    registrant.quarantine(detail);
    complete();
  };
  // The coordinator-wide deadline expires the pair through the same idempotent path.
  teardown.expirePendingPairs.push(quarantinePair);
  const outcome = registrant.signalGroup(teardown.signal);
  if (typeof outcome === 'object') {
    quarantinePair(`the process group could not be signalled: ${outcome.error.message}`);
    return;
  }
  if (outcome === 'gone') {
    registrant.markGroupGone();
  }
  registrant.awaitConfirmedDead((result) => {
    if (result.confirmed) {
      complete();
    } else {
      quarantinePair(result.detail);
    }
  });
}

function finishCoordinatorTeardown(teardown: CoordinatorTeardown): void {
  if (teardown.finished) {
    return;
  }
  teardown.finished = true;
  if (teardown.deadlineTimer !== undefined) {
    clearTimeout(teardown.deadlineTimer);
  }
  // Remove the listeners so the re-raise below takes Node's DEFAULT exit-on-signal
  // action instead of being swallowed by this very handler.
  removeCoordinatorListeners();
  if (teardown.persistFailed || retentionWatchdog !== undefined) {
    // A provision lock could NOT be quarantined durably;
    // it stays TRACKED (heartbeat running — see {@link ProvisionLock.quarantine}) under
    // the retention watchdog. Re-raising would kill this process, whose exit sweep
    // releases the tracked mutex under the possibly-live child — so do NOT re-raise.
    // The watchdog keeps signal handling installed, retries durable persistence, and
    // probes the recorded group for death.
    activeTeardown = undefined;
    installCoordinatorListeners();
    process.stderr.write(
      `provision: NOT re-raising ${teardown.signal} — a provision lock's quarantine ` +
        `metadata could not be persisted, so the lock is intentionally still held by this ` +
        `process to keep it from being stolen while the unconfirmed wrangler child may ` +
        `live.\n`,
    );
    return;
  }
  // Exactly-once re-raise (process-wide): the registered group is now confirmed dead
  // or durably quarantined, so the parent may take the signal's default action.
  if (reRaisedOnce) {
    return;
  }
  reRaisedOnce = true;
  process.kill(process.pid, teardown.signal);
  // Signals are delivered asynchronously: if the event loop has drained by now, the
  // process would exit NORMALLY (status 0) before the pending signal lands. A short
  // REFERENCED no-op keeps the loop alive so the re-raised signal's default action
  // terminates the process (it fires within milliseconds; the timer is only a bounded
  // fallback if something else swallowed the signal).
  setTimeout(() => {}, 2_000);
}

// --- The retention WATCHDOG for an undurable quarantine -----------
// When quarantine persistence FAILS, the lock stays TRACKED (heartbeat running, not
// stealable) — but a tracked mutex is exactly what proper-lockfile's exit sweep removes
// when the process drains and exits naturally, leaving the possibly-live wrangler child
// with NO mutex and NO sidecar. While that state is unresolved the process must not
// drain unprotected: a REFERENCED watchdog timer holds the loop open and, each tick,
//   (a) probes the recorded group for death (ESRCH → clear state, release the mutex
//       normally, resolve), then
//   (b) retries the DURABLE quarantine persistence with backoff (success → sidecar
//       durable + lock detached from the sweep → safe to resume normal exit semantics).
// Signal handling stays installed throughout (the coordinator swallows further
// SIGINT/SIGTERM with a warning — see {@link coordinatorHandleSignal}) and no new
// provision may start in this process until the watchdog resolves (see the slot guard).

const RETENTION_RETRY_MIN_MS = 250;
const RETENTION_RETRY_MAX_MS = 5_000;

interface RetentionWatchdogState {
  lock: ProvisionLock;
  info: QuarantineInfo;
  timer: ReturnType<typeof setTimeout>;
}

let retentionWatchdog: RetentionWatchdogState | undefined;

/**
 * Quarantine `lock`, and on a PERSISTENCE failure arm the retention
 * watchdog BEFORE rethrowing. THE single quarantine entry point for provision-level
 * code (the body-error path and the signal coordinator's hook both route through it),
 * so no persistence failure can leave the process free to drain unprotected.
 */
function retainQuarantinedLock(lock: ProvisionLock, info: QuarantineInfo): void {
  try {
    lock.quarantine(info);
  } catch (error) {
    armRetentionWatchdog(lock, info);
    throw error;
  }
}

function armRetentionWatchdog(lock: ProvisionLock, info: QuarantineInfo): void {
  // At most one provision per process → at most one retention; re-arming is a no-op.
  if (retentionWatchdog !== undefined) {
    return;
  }
  // Surface the retained state LOUDLY, once, naming the pid and the lock path.
  process.stderr.write(
    `provision: warning — quarantine metadata for the unconfirmed wrangler child` +
      `${info.pid !== undefined ? ` (pid ${info.pid})` : ''} could not be persisted, so the ` +
      `provision lock "${lock.lockTargetPath}.lock" is RETAINED by this process, which stays ` +
      `alive until the child is confirmed dead or the metadata persists durably.\n`,
  );
  installCoordinatorListeners();
  let attempt = 0;
  const resolveWatchdog = (): void => {
    if (retentionWatchdog !== undefined) {
      clearTimeout(retentionWatchdog.timer);
    }
    retentionWatchdog = undefined;
    if (activeRegistrations.size === 0 && activeTeardown === undefined) {
      removeCoordinatorListeners();
    }
  };
  const tick = (): void => {
    // (a) probe the recorded group for death FIRST: a dead group needs no quarantine —
    // release the mutex normally and resume normal exit semantics.
    if (info.pid !== undefined) {
      let dead = false;
      try {
        process.kill(process.platform === 'win32' ? info.pid : -info.pid, 0);
      } catch (error) {
        dead = isAlreadyGoneKillError(error);
      }
      if (dead) {
        lock.release().then(
          () => resolveWatchdog(),
          (error: unknown) => {
            process.stderr.write(
              `provision: the retained provision lock could not be released after the ` +
                `child's death was confirmed (${(error as Error).message}); the mutex ` +
                `self-heals once stale.\n`,
            );
            resolveWatchdog();
          },
        );
        return;
      }
    }
    // (b) retry the DURABLE persistence: success detaches the lock behind a durable
    // sidecar, so the process may exit while the retained mutex keeps blocking.
    try {
      lock.quarantine(info);
      resolveWatchdog();
      return;
    } catch {
      // Still failing — keep holding the process open and retry with backoff.
    }
    attempt += 1;
    const delay = Math.min(RETENTION_RETRY_MIN_MS * 2 ** attempt, RETENTION_RETRY_MAX_MS);
    if (retentionWatchdog !== undefined) {
      retentionWatchdog.timer = setTimeout(tick, delay); // REFERENCED — holds the process
    }
  };
  retentionWatchdog = { lock, info, timer: setTimeout(tick, RETENTION_RETRY_MIN_MS) };
}

/**
 * Default provider runner: launches the isolated typed operation entry through
 * {@link resolveCloudflareOperationArgv} with `shell: false`. Public request fields
 * travel as literal JSON argv; secrets travel through stdin. Captured stdout carries
 * the structured result envelope, while stderr carries provider diagnostics.
 *
 * ASYNC (returns a Promise). `spawn` + `await` (vs. the old blocking
 * `spawnSync`) keeps the Node event loop free while wrangler runs, so
 * `proper-lockfile`'s update timer keeps refreshing the mutex mtime for the WHOLE
 * provision — no wrangler call, however slow, can freeze the loop long enough for
 * another process to see the lock stale and steal it while we still hold it. A
 * {@link COMMAND_TIMEOUT_MS} SIGKILL guards against a hung child.
 */
export function createDefaultRunWrangler(
  root: string,
  options?: {
    /** Only immutable platform Worker version uploads may share the process with another upload. */
    parallelWorkerUpload?: boolean;
    /** Test seam — the argv launcher. Defaults to the typed operation entry. */
    launcher?: Array<string>;
    /** Test seam — the per-command timeout. Defaults to {@link COMMAND_TIMEOUT_MS}. */
    timeoutMs?: number;
    /**
     * Test seam — the process-GROUP signaller (`target` is the value passed to
     * `process.kill`: a NEGATIVE pid for the group). Defaults to `process.kill`. Tests inject
     * it to exercise the ESRCH-already-gone and real-kill-failure branches.
     */
    killProcessGroup?: (target: number, signal: NodeJS.Signals) => void;
    /**
     * Test seam — the post-kill termination-confirmation window. Defaults to
     * {@link CONFIRM_KILL_GRACE_MS}. Tests shrink it to exercise the quarantine expiry.
     */
    confirmKillGraceMs?: number;
    /**
     * Test seam — the coordinator-WIDE signal-teardown deadline for this
     * runner's pair. Defaults to `confirmKillGraceMs + `{@link SIGNAL_TEARDOWN_DEADLINE_MARGIN_MS}.
     * Tests shrink it to exercise the backstop quarantine.
     */
    signalTeardownDeadlineMs?: number;
    /**
     * Test seam — observe the spawned ChildProcess (unit tests use it to inject a
     * post-spawn `error` event). Never set in production.
     */
    onSpawnedChild?: (child: ChildProcess) => void;
  },
): RunWrangler {
  // The operation entry executes provider work in this process group. Killing the
  // group reaches the entry and any provider subprocess, and exit provenance is
  // retained independently of the structured result envelope.
  const launcher = options?.launcher ?? resolveCloudflareOperationArgv(root);
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
  const teardownDeadlineMs =
    options?.signalTeardownDeadlineMs ?? confirmGraceMs + SIGNAL_TEARDOWN_DEADLINE_MARGIN_MS;
  return (args, opts) =>
    new Promise<RunWranglerResult>((resolvePromise, rejectPromise) => {
      const parallelWorkerUpload =
        options?.parallelWorkerUpload === true && args.type === 'versions.upload';
      // Once a fatal-signal teardown has begun, this process is
      // terminating: REJECT new wrangler work outright BEFORE spawning (fail fast — no
      // child spawned means nothing to confirm), never join the teardown late with a
      // fresh deadline.
      if (activeTeardown !== undefined) {
        rejectPromise(
          new Error(
            `provision: refusing to spawn wrangler — a fatal ${activeTeardown.signal} is being ` +
              `handled and this process is terminating; no new wrangler work may start.`,
          ),
        );
        return;
      }
      // Ordinary commands stay serial. Only two immutable platform Worker uploads
      // can overlap outside provisioning. This check and the spawn+registration below
      // run in ONE synchronous block, so no signal dispatch can interleave between them.
      if (!canRegisterRunner(parallelWorkerUpload)) {
        rejectPromise(
          new Error(
            'provision: refusing to spawn wrangler — another wrangler child is already active ' +
              'in this process (only two immutable Worker uploads may overlap; all other ' +
              'Cloudflare commands and provisions remain sequential).',
          ),
        );
        return;
      }
      const child = spawn(command, [...prefix, ...encodeCloudflareOperation(args)], {
        cwd: opts.cwd ?? root,
        shell: false,
        // Pin the account + API base PER CALL from the transport context, so the
        // spawned wrangler targets the SAME reconciled account + endpoint the config +
        // Hyperdrive REST path use (no split-brain between the config pin and the
        // ambient/dotenv env).
        env: {
          ...provisionEnv({
            accountId: opts.accountId,
            apiBaseUrl: opts.apiBaseUrl,
            apiToken: opts.apiToken,
          }),
          ...(opts.suppressLogs ? { WRANGLER_WRITE_LOGS: 'false' } : {}),
        },
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      // Whether the spawn SUCCEEDED. The direct-settle carve-out in the
      // `error` handler is reserved for a GENUINE pre-spawn failure (no pid, `spawn`
      // never fired — the child never ran, so there is nothing to confirm dead).
      let spawned = false;
      // A post-spawn `error` event routes through the termination
      // machine; this makes the `close` handler defer to that path (like `timedOut`).
      let postSpawnError: Error | undefined;
      // ONE termination state machine for EVERY spawned-child outcome
      // (normal close, timeout, parent signal, post-spawn error, kill failure). The TWO
      // facts every path must confirm before the promise may settle — and before a
      // forwarded parent signal may be re-raised:
      //   `closed`    — the child's `close` event fired (process exited + stdio drained);
      //   `groupGone` — the whole process GROUP is confirmed gone (`kill(-pid, 0)` → ESRCH;
      //                 trivially true where no group exists: Windows, or no pid).
      // NO path settles-and-releases (or re-raises) without BOTH; an unconfirmable
      // teardown instead QUARANTINES — rejects with a {@link WranglerQuarantineError}
      // (lock intentionally retained; on the signal path the before-death hooks retain
      // it synchronously first).
      let closed = false;
      let groupGone = false;
      child.once('spawn', () => {
        spawned = true;
      });
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // Signal the child's WHOLE process group (it is `detached`, so its own group leader).
      // Returns a STRUCTURED outcome so the caller distinguishes ESRCH ("already gone" →
      // success) from a REAL kill failure (EPERM/… → the child may still be running → surface).
      const signalGroup = (signal: NodeJS.Signals): 'signaled' | 'gone' | { error: Error } => {
        try {
          if (!isWindows && typeof child.pid === 'number') {
            killProcessGroup(-child.pid, signal); // negative pid → the whole group
            return 'signaled';
          }
          if (isWindows && typeof child.pid === 'number') {
            // Windows has NO process groups, so the signal target is the child ITSELF.
            // Consult Node's own bookkeeping FIRST: once the exit has been observed there is
            // nothing left to signal. This ORDERING is also what makes the pid-based call below
            // free of any pid-reuse hazard. Windows destroys a pid only when the process OBJECT
            // is destroyed, which requires the process to have exited AND every handle to it to
            // be closed; libuv closes its handle (`CloseHandle(handle->process_handle)` in
            // `uv__process_proc_exit`, win/process.c) in the SAME straight-line frame that then
            // invokes `exit_cb` — Node's `onexit`, whose first statements set
            // `exitCode`/`signalCode`. No JavaScript runs in between, so a pid observed here
            // with a null exit code is still pinned by libuv's open handle and cannot have been
            // reassigned. (`child.kill()` is no safer in that instant: libuv sets
            // UV_HANDLE_ESRCH on the very next line and `uv_process_kill` then short-circuits to
            // ESRCH, which `ChildProcess.kill` reports as the same ambiguous `false`.)
            if (child.exitCode !== null || child.signalCode !== null) {
              return 'gone';
            }
            // Routed through the SAME seam POSIX uses, because `process.kill` THROWS ESRCH
            // (classified "already gone" below), whereas `child.kill()` collapses ESRCH and
            // EPERM into one silent `false`. Node sets `exitCode`/`signalCode` asynchronously
            // in its `exit` handler, so a child that died a moment ago still reads as
            // "running" here — and the ambiguous `false` would then be reported as a FAILED
            // delivery, quarantining the lock over a child that had simply already exited.
            killProcessGroup(child.pid, signal);
            return 'signaled';
          }
          if (child.kill(signal)) {
            return 'signaled';
          }
          // `child.kill()` returning FALSE is Node's non-throwing way of
          // reporting a failed signal delivery. An already-exited child has nothing left
          // to signal ("gone"); otherwise it is a FAILED signal attempt that must be
          // surfaced (same path as a thrown non-ESRCH kill error), never read as sent.
          if (child.exitCode !== null || child.signalCode !== null) {
            return 'gone';
          }
          return {
            error: new Error(`child.kill(${signal}) returned false (signal not delivered)`),
          };
        } catch (error) {
          return isAlreadyGoneKillError(error) ? 'gone' : { error: error as Error };
        }
      };

      /** True when the whole process group no longer exists (`kill(-pid, 0)` → ESRCH). */
      const probeGroupGone = (): boolean => {
        if (groupGone) {
          return true;
        }
        if (typeof child.pid !== 'number') {
          groupGone = true;
          return true;
        }
        if (isWindows) {
          // No process GROUP to probe, but the child ITSELF is still confirmable: libuv
          // implements `kill(pid, 0)` on Windows as a real liveness check
          // (GetExitCodeProcess + WaitForSingleObject). Descendants are covered separately —
          // libuv assigns every non-`detached` child to a global Job Object with
          // KILL_ON_JOB_CLOSE, so they die with this process. Prefer Node's own bookkeeping
          // (immune to pid reuse) and fall back to the signal-0 probe while the exit has not
          // been observed yet — so confirmation stays EARNED rather than assumed.
          if (child.exitCode !== null || child.signalCode !== null) {
            groupGone = true;
            return true;
          }
          try {
            process.kill(child.pid, 0);
          } catch (error) {
            groupGone = isAlreadyGoneKillError(error);
          }
          return groupGone;
        }
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          groupGone = isAlreadyGoneKillError(error);
          // EPERM → some group member exists but we cannot signal it — treat as ALIVE
          // (fail safe: never confirm on a probe we could not perform).
        }
        return groupGone;
      };

      const timeoutStderr = (extra?: string): string =>
        [stderr, `provision: wrangler exceeded the ${timeoutMs}ms command timeout`, extra]
          .filter(Boolean)
          .join('\n');

      // This runner's pair is registered with the process-wide
      // signal coordinator (below) for the child's lifetime; settling deregisters it.
      const deregisterSelf = (): void => deregisterRunner(registrant);

      const finish = (result: RunWranglerResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        deregisterSelf();
        resolvePromise(decodeCloudflareOperationResult(result));
      };

      // Settle by REJECTING with a quarantine error: the child could not be confirmed
      // dead, so the caller must retain the whole-provision lock (never release it under a
      // possibly-live child) and surface manual-recovery guidance.
      const quarantine = (detail: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        deregisterSelf();
        rejectPromise(new WranglerQuarantineError(child.pid, detail));
      };

      // The ONE bounded both-facts confirmation loop, shared by the
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
        // A poll never registers new waiters while running, so direct iteration is safe.
        for (const poll of confirmPollNudges) {
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

      // Forward a parent SIGINT/SIGTERM to the child's process GROUP so a Ctrl-C /
      // termination tears the DETACHED child (+ grandchildren) down instead of orphaning it.
      // Signal handling lives in the ONE process-wide coordinator (see
      // {@link registerRunner}); this runner registers its own pair. The coordinator forwards the first
      // SIGINT/SIGTERM to the registered group, awaits its bounded both-facts
      // confirmation (via this registrant's `awaitConfirmedDead`), quarantines it if
      // unresolved, coalesces repeated signals during the teardown, and re-raises
      // EXACTLY ONCE — never over a pending child.
      const registrant: TerminationRegistrant = {
        pid: () => child.pid,
        signalGroup,
        teardownDeadlineMs,
        markGroupGone: () => {
          // ESRCH ⇒ the whole group already exited — only `close` remains to be seen.
          groupGone = true;
        },
        awaitConfirmedDead: (onDone) => {
          awaitConfirmedDead({
            stopWhenSettled: false,
            onConfirmed: () => onDone({ confirmed: true }),
            onExpiry: () =>
              onDone({
                confirmed: false,
                detail:
                  `the process group did not terminate within ${confirmGraceMs}ms of the ` +
                  `forwarded signal`,
              }),
          });
        },
        quarantine,
      };

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

      // Node emits `error` on a ChildProcess AFTER a successful spawn
      // too (e.g. a failed in-flight signal delivery; the Windows timeout/signal paths
      // go through `child.kill()`), and the old handler ALWAYS settled directly — an
      // ordinary hard failure that RELEASED the whole-provision lock while the child
      // could still be alive. The direct-settle carve-out is reserved for a GENUINE
      // pre-spawn failure (ENOENT/EACCES: no pid, `spawn` never fired — the child never
      // ran, so there is nothing to confirm dead, and `close` may never follow). Every
      // POST-spawn `error` routes through the ONE bounded termination-confirmation →
      // quarantine machine like any other outcome.
      const handleProcessError = (error: Error): void => {
        if (!spawned && typeof child.pid !== 'number') {
          finish(normalizeRunWranglerResult({ stdout, stderr, status: null, signal: null, error }));
          return;
        }
        if (settled || timedOut || postSpawnError !== undefined) {
          // Already settling through another arm of the machine (its confirm poll
          // still owns the outcome) — never double-drive it.
          return;
        }
        postSpawnError = error;
        // The command is over as far as the caller is concerned — the machine's own
        // grace window bounds the rest.
        clearTimeout(commandTimer);
        const outcome = signalGroup('SIGKILL');
        if (typeof outcome === 'object') {
          quarantine(
            `a post-spawn child error (${error.message}) was followed by a failed ` +
              `process-group kill: ${outcome.error.message}`,
          );
          return;
        }
        if (outcome === 'gone') {
          groupGone = true;
        }
        confirmThenSettle(
          () =>
            normalizeRunWranglerResult({
              stdout,
              stderr: [
                stderr,
                `provision: the spawned wrangler child emitted an error after spawn: ` +
                  `${error.message}`,
              ]
                .filter(Boolean)
                .join('\n'),
              status: null,
              signal: 'SIGKILL',
            }),
          `a post-spawn child error (${error.message}; the group was SIGKILLed)`,
        );
      };
      child.on('error', handleProcessError);
      child.stdin?.on('error', handleProcessError);
      child.on('close', (code, signal) => {
        closed = true;
        if (timedOut || postSpawnError !== undefined) {
          // The timeout / post-spawn-error path's confirm poll settles once the group
          // is ALSO confirmed gone (both facts). Nudge every active poll now for
          // promptness.
          nudgeConfirmPolls();
          return;
        }
        // The command itself is DONE — the hard timeout no longer applies; only group
        // confirmation remains (bounded by its own grace window below).
        clearTimeout(commandTimer);
        // `close` alone is NOT sufficient to settle: a same-group
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

      // Register with the coordinator LAST (after commandTimer +
      // every handler exists). The pre-spawn checks at the top of this executor ran in
      // the SAME synchronous block, so no teardown can have begun and no other
      // registration can exist by the time this runs.
      registerRunner(registrant, parallelWorkerUpload);
      options?.onSpawnedChild?.(child);
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
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
  return !isHardFailure(result) && Number.isSafeInteger(result.status) && result.status > 0;
}

/**
 * The OVERALL deadline for the Hyperdrive existence lister (across ALL its paginated
 * requests). A stalled body or a never-settling injected seam must never hold the
 * whole-provision lock (whose heartbeat keeps refreshing while the loop is free) forever, so
 * the caller fails closed at this bound.
 */
const HYPERDRIVE_LIST_TIMEOUT_MS = 60_000;

/**
 * Run a lister call under an OVERALL deadline. Builds one `AbortController`, hands its
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
    // The deadline timer stays REFERENCED until the lister settles (both
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
 * The Cloudflare API token the default Hyperdrive existence check authenticates with:
 * the caller-supplied one, else the ambient `CLOUDFLARE_API_TOKEN`. An empty value is
 * treated as absent. This is the ONE resolver — the up-front Hyperdrive fence and the
 * default lister below both use it, so the fence can never promise a check the lister
 * then declines to make.
 */
function resolveHyperdriveApiToken(apiToken?: string): string | undefined {
  const token = apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Default Hyperdrive existence check: `GET /accounts/{id}/hyperdrive/configs`
 * with the CF API token, matched by name in the caller. Returns `undefined` when
 * it cannot be built (no account id / no token) — the caller then fails closed
 * before any blind create. Never called in unit tests — those inject a stub.
 */
function createDefaultListHyperdriveConfigs(apiToken?: string): ListHyperdriveConfigs | undefined {
  const token = resolveHyperdriveApiToken(apiToken);
  if (!token) {
    return undefined;
  }
  // The account AND the pinned API base come from the per-call transport context
  // (not a closure), so this default REST lister always targets the reconciled effective
  // account at the SAME endpoint the spawned wrangler uses (never a hardcoded prod base
  // while wrangler was redirected to staging/FedRAMP/an arbitrary endpoint).
  return async ({ accountId, apiBaseUrl, signal }) => {
    // Build every request URL with wrangler 4.131's EXACT concatenation
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
        // Apply the caller's deadline signal to EVERY paginated request, so a stalled
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
    // that covers BOTH this default path AND any injected lister.
    return [...byId.values()];
  };
}

/**
 * The ONE strict Hyperdrive-list validator, applied at the CALLER after EITHER
 * lister returns (the default fetch OR an injected seam), so validation can never live
 * only inside the default fetch. Validates EVERY member up front — BEFORE any name
 * filtering: rejects any non-object member, empty/non-string `name`, and duplicate `id`,
 * AND requires every member's `id` to be a REAL 32-hex Hyperdrive id (not merely
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
    // EVERY member's id must be a real 32-hex Hyperdrive id, checked BEFORE name
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

// --- Whole-provision cross-process lock (proper-lockfile) ----------------
// TWO independent races must be serialized across processes, so ONE lock is held for
// the WHOLE provision (acquired before the first config read, released in `finally`):
//   1. Account reconciliation. A first-run provision READS → RECONCILES → PERSISTS
//      one effective `account_id`. Two first-run processes for accounts A and B could
//      otherwise both see no `account_id`, overwrite each other, and then write an
//      A-side result into a now-B-pinned config. Under the lock the second process
//      re-reads the persisted account and FAILS CLOSED on mismatch (or reuses).
//   2. Hyperdrive list→create. Hyperdrive is unguarded and its names are NOT
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
  /** The synthetic lock target (`<configPath>.void-provision.lock`), for diagnostics. */
  readonly lockTargetPath: string;
  /**
   * Drop the mutex. REJECTS on a genuine (non-`onCompromised`) unlock failure so a
   * LEAKED lock is surfaced, never hidden behind a "successful" provision. Idempotent:
   * repeated calls return the SAME settled promise.
   */
  release: () => Promise<void>;
  /**
   * RETAIN the mutex intentionally (quarantine): a spawned wrangler child
   * could not be confirmed dead, so the on-disk mutex directory must OUTLIVE this process
   * to keep blocking concurrent provisions. `proper-lockfile` registers a signal-exit
   * sweep that `rmdirSync`s every still-TRACKED lock on process exit, so simply "not
   * releasing" is not enough — this detaches the lock from the library's internal
   * tracking (stopping the mtime heartbeat too), leaving the mutex directory on disk.
   *
   * It ALSO persists the quarantine OWNER METADATA (`info`: the
   * unconfirmed child's pid/pgid + reason + timestamp) in an atomically-written sidecar
   * next to the lock (`<lock>.quarantine.json`). The retained mutex is NO LONGER
   * released by mere age: every later acquisition gates on the sidecar first (see
   * {@link acquireProvisionLock}) — it proceeds only after probing the recorded group
   * dead (ESRCH), clearing the sidecar + stale mutex itself; while the group may live
   * (or the probe fails) it FAILS CLOSED. Idempotent; a later `release()` becomes a
   * no-op (`ERELEASED` → success) and never removes the retained directory.
   *
   * DURABLE sidecar persistence is a PRECONDITION for the detach: the
   * detached mutex's heartbeat stops, so without a durable sidecar there is nothing for
   * the acquisition gate to gate on and the mutex would go mtime-stale and be STOLEN
   * while the child may live (the previous code warned and detached anyway — fail open).
   * If the sidecar cannot be written+verified this THROWS instead, leaving the lock
   * fully TRACKED (heartbeat running, `release()` still functional, NOT stealable): the
   * error states the lock is intentionally still held and how to recover manually. A
   * later `quarantine()` call retries the persistence.
   */
  quarantine: (info: QuarantineInfo) => void;
}

/** The quarantine sidecar path for a lock target. */
function quarantineSidecarPath(lockTarget: string): string {
  return `${lockTarget}.quarantine.json`;
}

/**
 * Atomically persist the quarantine owner metadata: write a temp file,
 * then `rename` over the final path, so a concurrent acquisition gate can never read
 * partial JSON. On POSIX the spawned wrangler child is `detached` (its own process-group
 * leader), so the recorded `pgid` IS its pid; Windows has no process groups (the gate
 * probes the pid directly there).
 *
 * DURABLE: the temp file is fsync'd before the rename, the directory is
 * fsync'd after it (see the classification below), and the final sidecar is READ
 * BACK and verified. Any failure THROWS — callers treat persistence as a PRECONDITION
 * for detaching the lock from proper-lockfile's tracking (see
 * {@link ProvisionLock.quarantine}); a sidecar that merely "probably" landed is not a
 * durable marker the acquisition gate can rely on.
 */
function writeQuarantineSidecar(
  sidecarPath: string,
  info: QuarantineInfo,
  dirDurability?: ProvisionLockOptions['dirDurability'],
): void {
  const payload = JSON.stringify(
    {
      pid: info.pid ?? null,
      pgid: process.platform === 'win32' ? null : (info.pid ?? null),
      reason: info.reason,
      quarantinedAt: new Date().toISOString(),
      quarantinedBy: process.pid,
      // The sidecar GENERATION: a recovery decision may only remove the
      // exact generation it just inspected under the recovery mutex (see
      // {@link assertQuarantineClearedOrClear}), so a decision made against a dead
      // generation can never delete a NEWER quarantine persisted meanwhile. Random UUID
      // + a monotonic timestamp so two generations can never collide.
      generation: `${randomUUID()}.${process.hrtime.bigint().toString()}`,
    },
    null,
    2,
  );
  const tmpPath = `${sidecarPath}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, sidecarPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup — the write failure below is the real signal.
    }
    throw error;
  }
  // The DIRECTORY entry (the rename above) must be durable too: without
  // a directory fsync a crash can lose the just-renamed sidecar, leaving the retained
  // heartbeat-less mutex stale-reclaimable under a live child. Only codes meaning "this
  // platform/filesystem genuinely cannot fsync a directory" are ignored — enumerated:
  //   - EISDIR / EPERM — Windows cannot open a directory with O_RDONLY at all (libuv
  //     surfaces one of these depending on the Windows version/path kind);
  //   - EINVAL         — fsync(2) on a directory fd is rejected by some filesystems
  //     (certain FUSE/network mounts) and platforms;
  //   - ENOTSUP/ENOSYS — the operation is not supported/implemented at all.
  // EVERYTHING else (EIO, ENOSPC, EBADF, …) is a REAL durability failure: the sidecar
  // is NOT a durable marker, so the just-renamed (non-durable) file is best-effort
  // rolled back and the error PROPAGATES — the caller keeps the lock fully tracked and
  // the retention watchdog retries the persistence.
  const dirOpen = dirDurability?.openSync ?? openSync;
  const dirFsync = dirDurability?.fsyncSync ?? fsyncSync;
  const dirClose = dirDurability?.closeSync ?? closeSync;
  try {
    const dirFd = dirOpen(dirname(sidecarPath), 'r');
    try {
      dirFsync(dirFd);
    } finally {
      dirClose(dirFd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'ENOSYS'].includes(code)) {
      try {
        unlinkSync(sidecarPath);
      } catch {
        // Best-effort rollback of the non-durable file — the propagated error below is
        // the real signal either way (a leftover sidecar is conservative: it makes the
        // gate fail closed until its recorded pid is probed).
      }
      throw error;
    }
    // Platform-unsupported directory fsync — the read-back below is still required.
  }
  // VERIFY: the durable marker must be present and carry the recorded owner.
  const readBack: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
  if (
    !isRecord(readBack) ||
    readBack.pid !== (info.pid ?? null) ||
    readBack.reason !== info.reason
  ) {
    throw new Error(`the quarantine sidecar "${sidecarPath}" did not verify after writing`);
  }
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The quarantine acquisition GATE. Every provision acquires its mutex
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
 *
 * This gate now ALWAYS runs under the RECOVERY mutex (see
 * {@link acquireProvisionLock}), so its read IS the re-read-under-the-mutex every
 * recoverer must base its decision on, and a clear may only remove the exact sidecar
 * GENERATION it just inspected: the sidecar is re-read immediately before the unlink
 * and the decision fails closed if the generation changed (a newer quarantine was
 * persisted by the current main-mutex holder — whose quarantine writes are the one
 * interleaving the recovery mutex cannot serialize — while this decision was pending).
 * `onBeforeClear` is a test seam injecting exactly that interleaving deterministically.
 */
function assertQuarantineClearedOrClear(lockTarget: string, onBeforeClear?: () => void): void {
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
  // A NEGATIVE target is POSIX-ONLY: on win32 `process.kill(-n, 0)` resolves to
  // OpenProcess((DWORD)-n), which fails with ERROR_INVALID_PARAMETER and surfaces as ESRCH —
  // i.e. it would report ANY recorded owner "confirmed dead" and clear a LIVE quarantine,
  // inverting this gate from fail-closed to fail-open. Mirrors the watchdog's guard above.
  const probeTarget = pgid !== undefined && process.platform !== 'win32' ? -pgid : (pid ?? pgid);
  let confirmedDead = false;
  if (probeTarget !== undefined) {
    try {
      process.kill(probeTarget, 0);
      // Signal 0 succeeded — some member of the recorded group still exists → alive.
    } catch (error) {
      confirmedDead = isAlreadyGoneKillError(error);
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
  //
  // Generation-verified: RE-READ the sidecar and remove it ONLY if it
  // still carries the exact generation this decision inspected. A holder quarantining
  // (the one write the recovery mutex cannot serialize) between the read above and this
  // unlink would otherwise have its NEWER sidecar deleted by this now-stale decision.
  const inspectedGeneration =
    typeof recorded?.generation === 'string' ? recorded.generation : undefined;
  onBeforeClear?.();
  let current: Record<string, unknown> | undefined;
  try {
    const reread: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    current = isRecord(reread) ? reread : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Concurrently cleared — nothing left to remove; proceed to normal acquisition.
      return;
    }
    // Unreadable at the re-read → the generation cannot be verified → fail closed below.
    current = undefined;
  }
  const currentGeneration =
    typeof current?.generation === 'string' ? current.generation : undefined;
  if (current === undefined || currentGeneration !== inspectedGeneration) {
    throw new Error(
      `provision: refusing to clear the quarantine sidecar "${sidecarPath}" — it changed while ` +
        `this recovery decision was being made (a newer quarantine generation was persisted). ` +
        `Re-run to re-evaluate the current quarantine.`,
    );
  }
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
 * `proper-lockfile`'s INTERNAL lock registry, used ONLY by {@link ProvisionLock.quarantine}
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
    return createRequire(import.meta.url)(
      'proper-lockfile/lib/lockfile.js',
    ) as ProperLockfileInternals;
  } catch {
    return undefined;
  }
}

/**
 * `realpathSync` is `node:fs`, so it returns a NATIVE path — backslashes on Windows —
 * while every other path in this module comes from `pathslash` and is POSIX-normalized,
 * including the not-yet-created branch below (whose `join()` already normalizes). Without
 * this, `canonicalizeConfigPath` hands back TWO different spellings of the same file
 * depending only on whether it happens to exist yet, defeating the "ONE identity" contract
 * the function exists to provide — and splitting the lock identity, the wrangler `-c` argv,
 * and the paths printed in error messages. No-op off Windows, where `\` is a legal filename
 * character that must survive byte-for-byte.
 */
function toPosixConfigPath(nativePath: string): string {
  return process.platform === 'win32' ? normalize(nativePath) : nativePath;
}

/**
 * Canonicalize an already-absolute config path via `realpath` so the lock identity
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
    return toPosixConfigPath(realpathSync(absoluteConfigPath));
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
  /**
   * Test seam — runs between a confirmed-dead recovery decision and its
   * generation-verified sidecar clear, so a test can deterministically inject the ONE
   * interleaving the recovery mutex cannot serialize (the current main-mutex holder
   * persisting a NEWER quarantine generation). Never set in production.
   */
  onBeforeQuarantineClear?: () => void;
  /**
   * Test seam — overrides the fs functions used for the quarantine
   * sidecar's DIRECTORY fsync, so a test can inject ENOSPC/EINVAL and exercise the
   * durability classification. Never set in production.
   */
  dirDurability?: {
    openSync?: typeof openSync;
    fsyncSync?: typeof fsyncSync;
    closeSync?: typeof closeSync;
  };
}

/**
 * A lock whose owner has not refreshed it within this window is treated as abandoned
 * (crashed) and may be compromised/stolen, so a crashed provision cannot wedge every
 * future one. A LIVE owner refreshes the mutex mtime every {@link LOCK_UPDATE_MS}
 * (strictly less than this), so it never expires by age. Generous vs. a real
 * provision's duration.
 *
 * CORRECTNESS — this heartbeat is a `setTimeout` on the Node event loop, so it only
 * fires while the loop is FREE. The default runner is ASYNC (`spawn`, awaited), so no
 * wrangler call blocks the loop; between/`during` every `await` the pending update timer
 * runs and refreshes the mtime. Fast synchronous bookkeeping (JSON parse, small config
 * reads) is « `LOCK_UPDATE_MS`, so the mtime is continuously refreshed and NO other
 * process ever sees this lock stale → it can never be stolen while we hold it. (The old
 * blocking `spawnSync` could freeze the loop past `LOCK_STALE_MS`, starving the
 * heartbeat AND `onCompromised`, which is exactly the race this closes.)
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
 * The stale window of the RECOVERY mutex (the small proper-lockfile
 * lock serializing every gate→probe→clear→acquire→revalidate decision — see
 * {@link acquireProvisionLock}). Deliberately SHORT: its critical section is a few
 * synchronous fs reads plus one mkdir, so a crashed recoverer frees it within seconds
 * (proper-lockfile's own heartbeat keeps a live recoverer's window fresh).
 */
const RECOVERY_LOCK_STALE_MS = 6_000;

/**
 * Normalize the `retries` knob into the ONE backoff schedule OUR
 * acquisition loop runs (proper-lockfile's internal retrying is disabled with
 * `retries: 0` so the quarantine gate runs on EVERY attempt — see
 * {@link acquireProvisionLock}). A bare number keeps {@link LOCK_RETRIES}' backoff shape.
 */
function normalizeLockRetries(retries: ProvisionLockOptions['retries']): {
  retries: number;
  factor: number;
  minTimeout: number;
  maxTimeout: number;
} {
  if (typeof retries === 'number') {
    return { ...LOCK_RETRIES, retries };
  }
  return {
    retries: retries?.retries ?? LOCK_RETRIES.retries,
    factor: retries?.factor ?? LOCK_RETRIES.factor,
    minTimeout: retries?.minTimeout ?? LOCK_RETRIES.minTimeout,
    maxTimeout: retries?.maxTimeout ?? LOCK_RETRIES.maxTimeout,
  };
}

/**
 * Match the key spelling `proper-lockfile` stores when `realpath: false`.
 *
 * The library uses the host's native `node:path.resolve`, including backslashes on
 * Windows. Most Void paths intentionally use `pathslash`, but its forward-slash output
 * cannot address `proper-lockfile`'s internal registry on Windows.
 */
export function resolveProperLockfileKey(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? resolveWindowsPath(file) : resolvePosixPath(file);
}

/**
 * Acquire the cross-process provision lock over the resolved config path via
 * `proper-lockfile` (an atomic `mkdir`-based mutex at `<configPath>.void-provision.lock.lock`).
 * The library normally realpaths the pathname being locked, which requires it to exist.
 * Both lock identities here are deliberately SYNTHETIC adjacent paths, so acquisition
 * passes `realpath: false`: proper-lockfile resolves the identity lexically and creates
 * only its temporary mutex directory — never an empty marker file in the user's project.
 * This is safe because the config path was already canonicalized (including missing-file
 * and symlink cases) before reaching this function. It also preserves the writer's
 * missing-vs-empty config semantics. Returns a handle whose `release()` drops the mutex;
 * ALWAYS call it in a `finally` so an interruption never leaks the lock.
 *
 * `onCompromised` FAILS CLOSED (re-throws): if the lock is ever detected stolen (its
 * mtime changed, or the mutex vanished under a live owner), provisioning must NEVER
 * continue — a compromised lock means another process may be racing the same config.
 *
 * Acquisition is ONE atomic recovery protocol, applied on EVERY
 * attempt: quarantine GATE → single non-retrying proper-lockfile acquisition →
 * REVALIDATE the gate under ownership → clear-or-abort. Retrying is owned by THIS
 * function (proper-lockfile runs with `retries: 0`), so a waiter that entered while the
 * holder was healthy re-runs the gate on every backoff attempt and can never stale-take
 * a mutex whose holder QUARANTINED mid-wait; the post-acquire revalidation catches a
 * sidecar that appeared between the last gate and the acquisition itself (the fresh
 * lock is released and the acquisition fails closed).
 *
 * The ENTIRE per-attempt protocol runs under a second small
 * proper-lockfile RECOVERY mutex (`<lockTarget>.recovery`, `retries: 0`, short stale):
 * without it, two recoverers could interleave ACROSS processes — B reads a dead sidecar
 * S0, gets descheduled; A clears S0, acquires the main mutex, quarantines again writing
 * a LIVE sidecar S1; B resumes and unlinks the PATHNAME (now S1) on its stale decision,
 * then stale-reclaims A's retained mutex (the revalidation sees no sidecar). Under the
 * recovery mutex every decision re-reads the sidecar after acquiring it, and the clear
 * is additionally GENERATION-verified (see {@link assertQuarantineClearedOrClear}) for
 * the one interleaving the recovery mutex cannot serialize (the current MAIN-mutex
 * holder quarantining mid-decision). The recovery mutex deliberately does NOT take the
 * caller's `fs` seam — that seam simulates main-mutex failures.
 */
export async function acquireProvisionLock(
  configPath: string,
  lockOptions?: ProvisionLockOptions,
): Promise<ProvisionLock> {
  const lockTarget = `${configPath}.void-provision.lock`;
  const recoveryTarget = `${lockTarget}.recovery`;
  const staleMs = lockOptions?.stale ?? LOCK_STALE_MS;
  const retryCfg = normalizeLockRetries(lockOptions?.retries);
  const isElocked = (error: unknown): boolean =>
    (error as { code?: string } | null)?.code === 'ELOCKED';
  const backoffDelay = (attempt: number): Promise<void> =>
    new Promise((resolveSleep) =>
      setTimeout(
        resolveSleep,
        Math.min(retryCfg.minTimeout * retryCfg.factor ** attempt, retryCfg.maxTimeout),
      ),
    );
  // One NON-retrying proper-lockfile acquisition (it still performs the library's own
  // internal stale-reclaim of an abandoned mutex within the single attempt).
  const acquireOnce = (): ReturnType<typeof lockfile.lock> =>
    lockfile.lock(lockTarget, {
      stale: staleMs,
      update: lockOptions?.update ?? LOCK_UPDATE_MS,
      retries: 0,
      // `lockTarget` is a synthetic identity derived from an already-canonical config
      // path. Do not require/create an on-disk marker merely so it can be realpathed.
      realpath: false,
      // `proper-lockfile`'s callback-style fs seam — overridable so a test can force an
      // unlock failure. Production uses the library default (graceful-fs).
      ...(lockOptions?.fs !== undefined ? { fs: lockOptions.fs as never } : {}),
      onCompromised: (error) => {
        throw error;
      },
    });
  // One non-retrying RECOVERY-mutex acquisition (retrying is owned by
  // the loop below, so contention on a recovery decision backs off like a held main
  // mutex). Always the default fs — never the caller's failure-injection seam.
  const acquireRecoveryOnce = (): ReturnType<typeof lockfile.lock> =>
    lockfile.lock(recoveryTarget, {
      stale: RECOVERY_LOCK_STALE_MS,
      retries: 0,
      // Same synthetic-identity contract as the main mutex above. Distinct config paths
      // remain distinct, so different apps can provision concurrently on one machine.
      realpath: false,
      onCompromised: (error) => {
        throw error;
      },
    });
  // ONE atomic recovery protocol: gate → acquire → revalidate →
  // clear-or-abort, on EVERY attempt — and every attempt's WHOLE protocol
  // runs under the recovery mutex. This function is the single acquisition choke point
  // for every provision (grep-proven: no other code calls `lockfile.lock`), and
  // proper-lockfile's INTERNAL retrying is disabled (`retries: 0` above) in favor of
  // OUR loop, because the previous code gated on the quarantine sidecar ONCE before the
  // library's retry loop: a contender could pass that gate while the holder was still
  // healthy, keep retrying while the holder QUARANTINED (sidecar written, heartbeat
  // detached), then stale-take the retained mutex without ever seeing the sidecar —
  // acquiring the lock while the recorded wrangler group was alive.
  let release: Awaited<ReturnType<typeof lockfile.lock>> | undefined;
  for (let attempt = 0; ; attempt++) {
    // (0) the RECOVERY mutex, serializing this whole attempt's decision across
    // processes. Held by another recoverer → back off and re-run the WHOLE protocol.
    let releaseRecovery: Awaited<ReturnType<typeof lockfile.lock>>;
    try {
      releaseRecovery = await acquireRecoveryOnce();
    } catch (error) {
      if (isElocked(error) && attempt < retryCfg.retries) {
        await backoffDelay(attempt);
        continue;
      }
      throw error;
    }
    let mainHeldByOther = false;
    try {
      // (1) the GATE, on every attempt UNDER the recovery mutex (this read is the
      // re-read every recoverer's decision must be based on): fail closed while a
      // recorded group may live; generation-verified clear once it is confirmed dead.
      assertQuarantineClearedOrClear(lockTarget, lockOptions?.onBeforeQuarantineClear);
      // (2) one acquisition attempt; a held (non-stale) mutex backs off and loops.
      try {
        release = await acquireOnce();
      } catch (error) {
        if (isElocked(error) && attempt < retryCfg.retries) {
          mainHeldByOther = true; // back off AFTER releasing the recovery mutex
        } else {
          throw error;
        }
      }
      if (!mainHeldByOther) {
        // (3) REVALIDATE under ownership, before the provision body may run: the one
        // writer the recovery mutex cannot serialize — the PREVIOUS main-mutex holder
        // quarantining — can have persisted a sidecar between this attempt's gate and
        // the acquisition (its retained mutex going mtime-stale and being reclaimed by
        // the very `acquireOnce` above). A recorded group that is alive/unprobeable →
        // release the fresh mutex + fail closed; a dead group → the gate cleared the
        // sidecar → ownership is valid.
        try {
          assertQuarantineClearedOrClear(lockTarget, lockOptions?.onBeforeQuarantineClear);
        } catch (gateError) {
          let revalidateReleaseError: unknown;
          try {
            await release!();
          } catch (error) {
            revalidateReleaseError = error;
          }
          release = undefined;
          if (revalidateReleaseError !== undefined) {
            throw new AggregateError(
              [gateError, revalidateReleaseError],
              `provision: a quarantine was found right after acquiring the provision lock AND the ` +
                `fresh lock could not be released afterward. Quarantine: ` +
                `${(gateError as Error).message}; release error: ` +
                `${(revalidateReleaseError as Error).message}`,
              { cause: gateError },
            );
          }
          throw gateError;
        }
      }
    } finally {
      try {
        await releaseRecovery();
      } catch {
        // The recovery mutex has a SHORT stale window (seconds), so a failed rmdir
        // self-heals promptly and must never fail an otherwise-valid acquisition (or
        // mask the real error propagating out of the protocol above).
      }
    }
    if (!mainHeldByOther) {
      break;
    }
    await backoffDelay(attempt);
  }
  // Cache ONE shared release promise so a double-release is idempotent (the SAME
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
  // The loop above only breaks after a successful acquisition + revalidation.
  const acquiredRelease = release!;
  let releasePromise: Promise<void> | undefined;
  const doRelease = async (): Promise<void> => {
    try {
      await acquiredRelease();
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
    lockTargetPath: lockTarget,
    release: () => (releasePromise ??= doRelease()),
    // Quarantine: detach this lock from proper-lockfile's internal
    // tracking WITHOUT removing the on-disk mutex directory, so:
    //   1. the library's signal-exit sweep (which rmdirSync's every tracked lock on
    //      process exit) no longer removes it — the retained mutex OUTLIVES this process
    //      and keeps blocking concurrent provisions while the unconfirmed child may live;
    //   2. the mtime heartbeat stops; the sidecar below then guards the
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
      // DURABLE sidecar persistence is a PRECONDITION for everything
      // below: the detach stops the mtime heartbeat, so a mutex retained WITHOUT a
      // durable sidecar has nothing for the acquisition gate to gate on — it goes
      // mtime-stale and is stolen while the unconfirmed child may live (the previous
      // code warned and detached anyway — fail open). On persistence failure the lock
      // stays fully TRACKED (heartbeat running, release() functional, NOT stealable)
      // and this throws the hard error below; a later quarantine() call retries.
      try {
        writeQuarantineSidecar(quarantineSidecarPath(lockTarget), info, lockOptions?.dirDurability);
      } catch (error) {
        throw new Error(
          `provision: could not persist quarantine metadata to ` +
            `"${quarantineSidecarPath(lockTarget)}" (${(error as Error).message}). The ` +
            `cross-process provision lock "${lockTarget}.lock" is intentionally STILL HELD by ` +
            `this process (tracked, heartbeat running) so it cannot go stale and be stolen ` +
            `while the unconfirmed wrangler child` +
            `${info.pid !== undefined ? ` (pid ${info.pid})` : ''} may still be running. ` +
            `Manual recovery: verify the process is dead` +
            `${info.pid !== undefined ? ` (e.g. \`kill -0 ${info.pid}\`)` : ''} and terminate ` +
            `it if not; the lock is freed when this process exits — remove the ` +
            `"${lockTarget}.lock" directory if it persists, then re-run.`,
        );
      }
      releasePromise = Promise.resolve(); // any later release() is a settled no-op
      const internals = loadProperLockfileInternals();
      const locks = internals?.getLocks?.();
      if (!locks) {
        return; // degraded: retained only until process exit (internals unavailable)
      }
      // With `realpath: false`, proper-lockfile keys its registry using node:path.resolve.
      // Use that same NATIVE spelling here (not pathslash's POSIX spelling) so quarantine
      // detaches correctly on Windows too.
      const key = resolveProperLockfileKey(lockTarget);
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
function parseJsonArrayStrict(value: unknown): Array<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}
function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * Read the single provisioned binding entry for `field`/`binding` from the resolved
 * config, delegating to the STRICT canonical reader in `wrangler.ts`
 * ({@link readProvisionedBindingEntry}). Unlike the old loose first-match `.find()`, this
 * validates the target field's outer shape, fails closed on a DUPLICATE binding, and runs
 * the worker-wide CROSS-TYPE collision check — so a
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
 * BOM-aware (wrangler + `writeProvisionedWranglerConfig` strip a leading BOM before
 * parsing, so we must too, else a BOM-prefixed config would look unparseable). FAILS CLOSED
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
//      when it exited cleanly (numeric status 0). Called BEFORE inspecting data.
//   2. validateResourceList     — a structured list is rejected WHOLE if ANY member
//      is malformed (never silently filtered — a malformed member could BE the
//      target and look "absent", minting a duplicate).
//   3. isConfirmedAbsent        — a NON-zero `<res> info`-by-name probe means
//      "absent" (→ create) ONLY on the structured provider not-found classification;
//      a signal/spawn failure or any other nonzero is NEVER absence.

/**
 * FAIL-CLOSED gate over a discovery/list/info result. Throws (no create) unless
 * the child exited cleanly — a NUMERIC `status === 0`. Because
 * {@link normalizeRunWranglerResult} already folds a signal-killed child or a
 * spawn error into a non-zero status, a single numeric check here rejects ALL of
 * nonzero-exit / SIGTERM / spawn-error / non-numeric status. MUST be called
 * BEFORE reading provider data, so failed discovery never implies absence.
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
   * The resource-SPECIFIC member-identity validator, run over EVERY member
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
 * member is not a well-formed object carrying a non-empty name AND a
 * FORMAT-VALID id (per {@link ResourceListSpec.hasValidId}). A member is NEVER
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
    // A REAL, RECONCILED identity — not merely one non-empty alias.
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
 * THE one D1 id-alias reconciler, shared by the WHOLE-LIST gate (every
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
 * THE single strict D1 identity normalizer, shared by `d1 list --json` and
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
  if (entry === undefined) {
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
  // The ONE alias reconciler: no id, ANY malformed/non-string present alias, or
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
 * A title-matching namespace whose `id` is NOT a real KV id (32-hex) is ambiguous:
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
  return result.errorCode === 7502;
}

/**
 * Not-found classifier shared by R2 + queues. Given an `<res> info`-by-name probe,
 * returns `true` (confirmed absent → safe to create) ONLY on a clean non-zero exit
 * with the provider's typed not-found result (R2 error code 10006; the queue
 * operation's `not-found` failure). Everything else returns `false` so the caller
 * fails closed — a signal/spawn failure, an auth/network/metrics error, or a
 * GENERIC "not found" (e.g. `Account not found`) is NEVER treated as absence,
 * which would mint a duplicate resource.
 */
function isConfirmedAbsent(result: RunWranglerResult, kind: 'r2' | 'queue'): boolean {
  return (
    isCleanFailure(result) &&
    (kind === 'r2' ? result.errorCode === 10006 : result.failure === 'not-found')
  );
}

/** Only a completed, typed not-found response confirms queue absence. */
export function isQueueConfirmedAbsent(result: RunWranglerResult, _name: string): boolean {
  return isConfirmedAbsent(result, 'queue');
}

/** Reuse and post-create verification require clean success and the exact returned name. */
function queueInfoConfirmsExists(result: RunWranglerResult, name: string): boolean {
  return isCleanSuccess(result) && isRecord(result.data) && result.data.name === name;
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
   * Resource-SPECIFIC id-format validator (D1 UUID / KV 32-hex / R2 bucket-name /
   * Hyperdrive 32-hex). Replaces the loose `isRealValue`, so a create that reported
   * success but wrote a placeholder/garbage id (e.g. a signal-killed child masked as
   * exit 0) fails closed instead of being recorded as provisioned.
   */
  idValidator: (value: unknown) => value is string;
  /**
   * When set, the member key that must EXACTLY equal the requested name (the
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
 * Backstop — verify a create's POSTCONDITION, RESOURCE-SPECIFICALLY + identity
 * checked. wrangler 4.131's `bin.wrangler` is a WRAPPER that spawns
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

// --- Option-injection guard SEPARATE from per-resource service grammar -----
// The old single regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$` was applied to EVERY
// resource, but wrangler 4.131 forwards the KV namespace positional VERBATIM as the KV
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

/** The universal option-injection guard for ANY wrangler ARGV positional. */
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
 * Per-resource Cloudflare naming GRAMMAR, verified 2026-07 against wrangler 4.107
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
    // Cloudflare Queues: 1–63 chars, letters/digits/dashes only (NO underscores),
    // and the FIRST and LAST char must be alphanumeric (no leading/trailing dash). The
    // leading-`-` case is also covered by the option-injection guard, kept as belt+braces.
    re: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
    label: 'queue',
    rule: 'be 1–63 characters, contain only letters, digits and "-", and begin and end with a letter or digit',
  },
};

/**
 * Validate a name destined for a wrangler ARGV positional: FIRST the universal
 * option-injection guard, THEN the resource's own Cloudflare grammar. Fail closed on any
 * violation, before the account gate or any wrangler/REST call.
 *
 * Exported — like {@link isQueueConfirmedAbsent} — so the deploy orchestrator's
 * pre-provision queue probe (`cli/deploy.ts`) gates names on the SAME rules this
 * provisioner enforces. Queue names
 * are taken verbatim from filenames with no sanitization, so without this gate a name
 * beginning with `-` reaches wrangler as a FLAG rather than a positional.
 */
export function assertValidResourceName(kind: ResourceNameKind, name: string): void {
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
 * Build a redactor that strips connection-string secrets from every string the
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

// --- THE one no-throw redaction boundary --------------------------
// ALL classification and inspection of a seam rejection happens INSIDE the boundary
// ({@link redactRejection}): a hostile Proxy's `instanceof`/property traps can throw an
// error of the attacker's choosing (potentially secret-bearing), so no read of the
// original value — not even `isQuarantineError` — may run outside it. If inspection is
// unsafe anywhere, the boundary FAILS CLOSED AS QUARANTINE: a fresh INERT carrier
// marked `{ quarantine: true }` propagates, so the whole-provision mutex is RETAINED
// (conservative — the hostile value could have been hiding a real quarantine) and no
// trap error ever replaces the rejection. Values bearing user accessors or Proxies are
// NEVER returned as the original — a stateful/hostile getter can present clean text
// during sanitization and mint the secret on a later read — they are converted to an
// inert plain carrier (data properties only, prototype restored only for KNOWN error
// classes). No logging path may coerce an unknown value (`String()`/template invokes an
// arbitrary `toString`): {@link safeRedactedErrorMessage} extracts only safely-read
// fields inside the boundary.

/**
 * The engine's own lazy `Error#stack` accessor pair, captured ONCE at
 * module init. V8 defines `stack` as an own get/set accessor on every Error instance,
 * sharing ONE getter/setter function across all of them — so FUNCTION IDENTITY proves
 * "this is the engine's deterministic lazy-stack slot" (user code cannot forge these
 * function identities). It is the ONLY accessor the in-place sanitizer may handle;
 * every other accessor forces the inert fallback carrier.
 */
const engineStackDescriptor = Object.getOwnPropertyDescriptor(new Error(), 'stack');
const ENGINE_STACK_GET = engineStackDescriptor?.get;
const ENGINE_STACK_SET = engineStackDescriptor?.set;

/**
 * The ONLY prototypes a rebuilt carrier may have restored. Restoring an
 * ARBITRARY prototype would reintroduce hostile behavior on the otherwise-inert carrier
 * (a prototype getter or `toString` the carrier's readers would still hit), so an
 * unknown prototype degrades to the base Error/Object/Array prototype the fresh carrier
 * was built with. `WranglerQuarantineError` is included so a rebuilt quarantine carrier
 * keeps its `instanceof` classification.
 */
const KNOWN_SAFE_PROTOTYPES = new Set<object>([
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  EvalError.prototype,
  URIError.prototype,
  AggregateError.prototype,
  WranglerQuarantineError.prototype,
  Object.prototype,
  Array.prototype,
]);

/**
 * Deep-redact an UNKNOWN rejection value through the ONE text
 * redactor, inside one no-throw attempt. A seam may reject with ANYTHING — an Error, a
 * plain STRING, an object, an array, a FROZEN value, a graph carrying secrets in
 * non-enumerable slots (`Error.cause`, `AggregateError.errors`, `message`/`stack`),
 * Maps/Sets, cycles, Proxies, accessor-bearing objects. The contract:
 *   1. NEVER throw — any internal throw (hostile trap/getter anywhere) returns
 *      `{ ok: false }` so the caller fails closed;
 *   2. NEVER propagate an unsanitized OR non-inert value: a graph of plain data
 *      properties (plus the engine's own lazy `stack` slot) that can be fully redacted
 *      IN PLACE returns the ORIGINAL (identity preserved — quarantine detection and
 *      metadata fields survive untouched); anything else — a Proxy anywhere, ANY user
 *      accessor, a frozen/non-writable secret-bearing slot — returns a fully sanitized
 *      INERT deep copy (data properties only, every string redacted, only KNOWN
 *      prototypes restored);
 *   3. traverse own property DESCRIPTORS (string + symbol keys, non-enumerable
 *      included — covering `message`, `stack`, `cause`, `errors`), plus Map keys/values
 *      and Set members (whose internal slots `Object.freeze` never covers), cycle-safely.
 */
type RedactAttempt = { ok: true; value: unknown } | { ok: false };

function tryRedactValue(value: unknown, redactText: (text: string) => string): RedactAttempt {
  try {
    if (typeof value === 'string') {
      return { ok: true, value: redactText(value) };
    }
    if (typeof value !== 'object' || value === null) {
      return { ok: true, value };
    }
    if (!utilTypes.isProxy(value) && sanitizeInPlace(value, redactText)) {
      return { ok: true, value };
    }
    return { ok: true, value: deepSanitizedCopy(value, redactText) };
  } catch {
    // Rule 1: never throw out of the attempt — a pathological value (throwing traps or
    // getters anywhere) makes the caller fail closed instead.
    return { ok: false };
  }
}

/**
 * Attempt to redact `root` fully IN PLACE. Returns `true` only when EVERY string
 * that needed redaction was verifiably rewritten (assignment read back); any immutable
 * or unverifiable slot holding a secret returns `false` so the caller switches to the
 * fallback-carrier copy. Partial rewrites applied before a `false` are harmless — they
 * only ever REMOVE secret text, and the caller then discards the original anyway.
 */
function sanitizeInPlace(root: object, redactText: (text: string) => string): boolean {
  const seen = new WeakSet<object>();
  let ok = true;
  const visitChild = (child: unknown): void => {
    if (typeof child === 'object' && child !== null) {
      visit(child);
    }
  };
  const visit = (v: object): void => {
    if (!ok || seen.has(v)) {
      return;
    }
    seen.add(v);
    // A Proxy ANYWHERE in the graph forces the inert fallback carrier:
    // its traps run arbitrary code on every later read, so a proxied original can mint
    // fresh secrets (or throw) after "passing" this walk. Detection is native
    // (`util.types.isProxy`), not trap-observable.
    if (utilTypes.isProxy(v)) {
      ok = false;
      return;
    }
    // Map/Set data lives in internal slots `Object.freeze` does NOT cover, so their
    // members are always rewritable in place (delete + re-add / set).
    if (v instanceof Map) {
      // Snapshot first — the loop mutates the Map while iterating.
      for (const [key, val] of Array.from(v.entries())) {
        const newKey = typeof key === 'string' ? redactText(key) : key;
        const newVal = typeof val === 'string' ? redactText(val) : val;
        visitChild(key);
        visitChild(val);
        if (newKey !== key) {
          v.delete(key);
        }
        if (newKey !== key || newVal !== val) {
          v.set(newKey, newVal);
        }
        if (!ok) {
          return;
        }
      }
      return;
    }
    if (v instanceof Set) {
      // Snapshot first — the loop mutates the Set while iterating.
      for (const member of Array.from(v.values())) {
        if (typeof member === 'string') {
          const red = redactText(member);
          if (red !== member) {
            v.delete(member);
            v.add(red);
          }
        } else {
          visitChild(member);
        }
        if (!ok) {
          return;
        }
      }
      return;
    }
    // EVERY own property — string AND symbol keys, non-enumerable included (an Error's
    // `message`/`stack`/`cause` and an AggregateError's `errors` are non-enumerable own
    // data properties the old `Object.keys` walk missed entirely).
    for (const key of Reflect.ownKeys(v)) {
      const desc = Object.getOwnPropertyDescriptor(v, key);
      if (!desc) {
        continue;
      }
      if (desc.get !== undefined || desc.set !== undefined) {
        // ONLY the engine's own lazy `Error#stack` pair may be handled
        // in place: its getter is deterministic (formats the captured frames + the
        // current message) and rewriting through its setter morphs the slot into a
        // verified data property. EVERY other accessor forces the fallback carrier — a
        // stateful/hostile getter can return clean text during THIS walk and mint the
        // secret on a later read, so an accessor-bearing original must never be
        // returned as "sanitized" (rule 2).
        const isEngineStackSlot =
          key === 'stack' &&
          ENGINE_STACK_GET !== undefined &&
          desc.get === ENGINE_STACK_GET &&
          desc.set === ENGINE_STACK_SET;
        if (!isEngineStackSlot) {
          ok = false;
          return;
        }
        // The engine stack slot passes when its CURRENT text is verifiably clean, or
        // when a secret-bearing string can be rewritten THROUGH its setter with the
        // result read back (the stack text embeds the message, so it routinely carries
        // the secret). An unverifiable write still forces the fallback carrier.
        let current: unknown;
        try {
          current = desc.get !== undefined ? desc.get.call(v) : undefined;
        } catch {
          ok = false;
          return;
        }
        if (typeof current === 'string') {
          const red = redactText(current);
          if (red !== current) {
            if (desc.set === undefined) {
              ok = false;
              return;
            }
            try {
              desc.set.call(v, red);
            } catch {
              ok = false;
              return;
            }
            // The setter may have morphed the slot into a data property (V8's stack
            // setter does) — verify via a FRESH descriptor read.
            let after: unknown;
            try {
              const afterDesc = Object.getOwnPropertyDescriptor(v, key);
              after = afterDesc?.get !== undefined ? afterDesc.get.call(v) : afterDesc?.value;
            } catch {
              ok = false;
              return;
            }
            if (after !== red) {
              ok = false;
              return;
            }
          }
        } else {
          visitChild(current);
        }
        if (!ok) {
          return;
        }
        continue;
      }
      const val = desc.value;
      if (typeof val === 'string') {
        const red = redactText(val);
        if (red === val) {
          continue;
        }
        if (desc.writable !== true) {
          ok = false; // frozen / non-writable data slot holding a secret
          return;
        }
        try {
          (v as Record<PropertyKey, unknown>)[key] = red;
        } catch {
          ok = false;
          return;
        }
        // VERIFY the write took (a sloppy-mode swallow / hostile Proxy must not pass).
        if (Object.getOwnPropertyDescriptor(v, key)?.value !== red) {
          ok = false;
          return;
        }
      } else {
        visitChild(val);
        if (!ok) {
          return;
        }
      }
    }
  };
  visit(root);
  return ok;
}

/**
 * The fallback CARRIER: a fully sanitized deep copy of `root`, built when in-place
 * redaction is impossible. Fresh objects/arrays/Errors/Maps/Sets (all mutable), every
 * string redacted, every own property — enumerable or not, string or symbol key —
 * carried over as a plain data property, accessors snapshotted (an unreadable getter
 * becomes `'[unredactable]'`), the original PROTOTYPE restored so `instanceof`
 * classification (e.g. {@link WranglerQuarantineError}) survives the rebuild. Cycle-safe
 * (a cycle in the original maps to the same cycle among the copies).
 */
function deepSanitizedCopy(root: unknown, redactText: (text: string) => string): unknown {
  const copies = new WeakMap<object, unknown>();
  const copy = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return redactText(v);
    }
    if (typeof v !== 'object' || v === null) {
      return v;
    }
    if (copies.has(v)) {
      return copies.get(v);
    }
    if (v instanceof Map) {
      const out = new Map<unknown, unknown>();
      copies.set(v, out);
      for (const [key, val] of v.entries()) {
        out.set(copy(key), copy(val));
      }
      return out;
    }
    if (v instanceof Set) {
      const out = new Set<unknown>();
      copies.set(v, out);
      for (const member of v.values()) {
        out.add(copy(member));
      }
      return out;
    }
    const out: object = Array.isArray(v) ? [] : v instanceof Error ? new Error() : {};
    // Restore the prototype ONLY for KNOWN error/base classes. The
    // carrier must be INERT: an arbitrary prototype could carry hostile getters or a
    // hostile `toString` that later reads/coercions of the carrier would invoke, so an
    // unknown prototype degrades to the base one `out` was built with (the structural
    // fields below still carry the metadata; `redactRejection` restores the quarantine
    // classification structurally when it was lost this way).
    const proto: unknown = Object.getPrototypeOf(v);
    if (typeof proto === 'object' && proto !== null && KNOWN_SAFE_PROTOTYPES.has(proto)) {
      try {
        Object.setPrototypeOf(out, proto);
      } catch {
        // Keep the base prototype.
      }
    }
    copies.set(v, out);
    for (const key of Reflect.ownKeys(v)) {
      const desc = Object.getOwnPropertyDescriptor(v, key);
      if (!desc) {
        continue;
      }
      let val: unknown;
      if (desc.get !== undefined || desc.set !== undefined) {
        try {
          val = desc.get !== undefined ? desc.get.call(v) : undefined;
        } catch {
          val = '[unredactable]';
        }
      } else {
        val = desc.value;
      }
      try {
        Object.defineProperty(out, key, {
          value: copy(val),
          writable: true,
          enumerable: desc.enumerable === true,
          configurable: true,
        });
      } catch {
        // e.g. an array's non-configurable `length` — the index copies already set it.
      }
    }
    return out;
  };
  return copy(root);
}

/**
 * Extract a SAFELY-READ, redacted one-line message from an unknown
 * value, for logging. Never coerces an object (`String()`/template literals invoke an
 * arbitrary — possibly hostile — `toString`): only primitives are stringified, and for
 * objects only a plain string `message` field is read (inside the no-throw boundary; a
 * throwing trap/getter degrades to the generic placeholder). THE one helper every
 * logging path uses for unknown rejection values (grep-proven: the Hyperdrive lister
 * warning and the rebuilt-carrier message below).
 */
function safeRedactedErrorMessage(value: unknown, redactText: (text: string) => string): string {
  try {
    if (typeof value === 'string') {
      return redactText(value);
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') {
      return redactText(message);
    }
  } catch {
    // A throwing trap/getter — fall through to the withheld placeholder.
  }
  return 'the rejection could not be rendered safely; its content was withheld';
}

/** The conservative carrier for a rejection that resists inspection. */
function unsafeInspectionQuarantineCarrier(): Error {
  const carrier = new Error(
    'provision: a propagated rejection could not be safely inspected (a property or ' +
      'prototype trap threw during redaction); its content was withheld. Treating it ' +
      'conservatively as an unconfirmed-wrangler-child (quarantine) failure: the ' +
      'whole-provision lock is retained, not released.',
  );
  Object.assign(carrier, { quarantine: true as const, pid: undefined });
  return carrier;
}

/**
 * Redact a seam REJECTION with EVERYTHING — the quarantine
 * classification included — inside the ONE no-throw boundary, GUARANTEEING:
 *   1. this function NEVER throws (pre-fix, `isQuarantineError`'s `instanceof` ran on
 *      the ORIGINAL value before any boundary — a Proxy with throwing
 *      `getPrototypeOf`/property traps made the redactor itself throw a
 *      secret-bearing, classification-free replacement error, and the outer path then
 *      RELEASED the mutex under a possibly-live child);
 *   2. if inspection is unsafe ANYWHERE (classification, redaction, message reads), it
 *      FAILS CLOSED AS QUARANTINE: a fresh INERT sanitized carrier marked
 *      `{ quarantine: true }` propagates, so the mutex is retained (conservative — the
 *      hostile value could have been hiding a real quarantine) and no trap error or
 *      secret ever escapes;
 *   3. a quarantined rejection can never degrade into an ordinary failure: the
 *      classification + pid are captured inside the boundary and restored structurally
 *      on the carrier when a rebuild lost them.
 */
function redactRejection(error: unknown, redactText: (text: string) => string): unknown {
  try {
    const wasQuarantine = isQuarantineError(error);
    const quarantinePid =
      wasQuarantine && typeof (error as WranglerQuarantineError).pid === 'number'
        ? (error as WranglerQuarantineError).pid
        : undefined;
    const attempt = tryRedactValue(error, redactText);
    if (!attempt.ok) {
      return unsafeInspectionQuarantineCarrier();
    }
    const redacted = attempt.value;
    if (!wasQuarantine || isQuarantineError(redacted)) {
      return redacted;
    }
    // The redactor had to rebuild and the carrier lost the classification (e.g. the
    // original relied on a prototype outside the known-safe set) — restore it
    // structurally on the (always freshly-built, inert) carrier.
    const carrier =
      redacted instanceof Error
        ? redacted
        : new Error(safeRedactedErrorMessage(redacted, redactText));
    Object.assign(carrier, { quarantine: true as const, pid: quarantinePid });
    return carrier;
  } catch {
    // Rule 2 — anything that slipped past the inner boundaries still fails closed as
    // an inert quarantine-conservative carrier, never a throw out of the redactor.
    return unsafeInspectionQuarantineCarrier();
  }
}

/**
 * Ensure every resource in `desired` exists in the user's own Cloudflare account,
 * creating the missing ones by shelling out to `wrangler` and letting
 * `wrangler <res> create --update-config` write real ids into the root config.
 * For resources that already exist (adopt path) — where `create` cannot run —
 * the real id is captured from `wrangler <res> list/info` (or, for Hyperdrive,
 * the account-list existence seam) and written through `writeProvisionedWranglerConfig`'s
 * adopt fields. Pure provisioning: NO build, deploy, or drift-check. Idempotent +
 * read-first: a binding already pointing at a real id is left untouched.
 */
export async function provisionCloudflareResources(
  root: string,
  rootWranglerPath: string,
  desired: DesiredResourceSet,
  opts?: ProvisionOptions,
): Promise<ProvisionResult> {
  // The at-most-one-provision-per-process guard, taken SYNCHRONOUSLY at
  // entry (before the first await) so two same-tick calls cannot both pass. See the
  // invariant documented at {@link acquireProcessProvisionSlot}: the signal coordinator
  // manages at most one {wrangler child group, provision lock} pair because of it.
  const releaseProvisionSlot = acquireProcessProvisionSlot();
  try {
    return await provisionWithProcessSlot(root, rootWranglerPath, desired, opts);
  } finally {
    releaseProvisionSlot();
  }
}

/** The provision body, run while holding this process's single provision slot. */
async function provisionWithProcessSlot(
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
  // Then CANONICALIZE it with `realpath` so the lock identity (and every read/
  // write/`-c`) is keyed on the REAL file, not a lexical alias. Without this, a real
  // config and a symlink alias to it resolve to DIFFERENT lexical paths → DIFFERENT lock
  // mutex dirs (`<path>.void-provision.lock.lock`), so both processes acquire "the" lock at
  // once and race the same underlying file. Canonicalizing collapses all aliases to one
  // identity; a missing config canonicalizes its parent dir so the identity is still
  // alias-stable before the file is created.
  const configPath = canonicalizeConfigPath(resolve(root, rootWranglerPath));

  // Hold ONE cross-process lock for the WHOLE provision: acquire it BEFORE
  // the first config read (so account reconciliation + persistence + all discovery,
  // remote work, and config writes happen against the state the lock protects), and
  // ALWAYS release it (both the success and error paths below call `lock.release()`, so
  // an interruption never leaks the lock; a genuine unlock failure fails the provision).
  // The reconciliation + duplicate-member guard + resource work all run UNDER the lock in
  // `provisionCloudflareResourcesLocked`, so a racing first-run serializes: the second
  // process re-reads the persisted account/ids and fails closed (or reuses).
  //
  // This mutex is keyed on the local CONFIG PATH, so it only
  // serializes provisions of the same config on ONE machine; two different HOSTS
  // provisioning the same project can still race and create duplicates. Accepted by
  // design: provision is a single-operator dev-machine action, so no remote coordination
  // is built.
  const lock = await acquireProvisionLock(configPath, opts?.lockOptions);
  // While this provision runs, a fatal-signal death under an
  // UNCONFIRMED wrangler child must RETAIN the mutex: publish the lock's quarantine as
  // THE single active hook (1:1 with this process's one provision slot). A registering
  // wrangler child captures it at registration, and the coordinator's signal path
  // invokes it SYNCHRONOUSLY — sidecar written, lock detached from the exit sweep —
  // before re-raising the signal. Routed through {@link retainQuarantinedLock} so a
  // persistence failure arms the retention watchdog.
  const quarantineHook = (info: QuarantineInfo): void => retainQuarantinedLock(lock, info);
  activeProvisionQuarantineHook = quarantineHook;
  // ALWAYS release, but do NOT swallow a release failure. On body SUCCESS a failed
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
  if (activeProvisionQuarantineHook === quarantineHook) {
    activeProvisionQuarantineHook = undefined;
  }
  if (threw) {
    // QUARANTINE: the failure means a spawned wrangler child could not be
    // confirmed dead — it may STILL be creating resources — so the mutex is INTENTIONALLY
    // RETAINED (never released here; `quarantine()` also detaches it from proper-lockfile's
    // exit sweep so the on-disk directory outlives this process). Releasing it would let a
    // concurrent provision race the surviving child on the same config/account.
    if (isQuarantineError(bodyError)) {
      try {
        retainQuarantinedLock(lock, {
          // Defensive reads: `isQuarantineError` also accepts a structural match (a
          // `{ quarantine: true }` carrier that is not the class instance).
          pid: typeof bodyError.pid === 'number' ? bodyError.pid : undefined,
          reason: typeof bodyError.message === 'string' ? bodyError.message : String(bodyError),
        });
      } catch (quarantineError) {
        // The quarantine sidecar could not be persisted,
        // so the lock is intentionally STILL HELD (tracked, heartbeat running) under the
        // retention watchdog {@link retainQuarantinedLock} just armed: the process will
        // not drain unprotected while the unconfirmed wrangler child may still be
        // creating resources. NEVER release the lock here. Surface BOTH errors.
        throw new AggregateError(
          [bodyError, quarantineError],
          `provision failed with an unconfirmed wrangler child AND its quarantine metadata ` +
            `could not be persisted — the cross-process provision lock is intentionally still ` +
            `held by this process (not released, not stealable) while the child may live. ` +
            `Primary error: ` +
            `${bodyError instanceof Error ? bodyError.message : String(bodyError)}; quarantine ` +
            `error: ` +
            `${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}.`,
          { cause: bodyError },
        );
      }
      throw bodyError;
    }
    // Attempt release; if IT also fails, surface BOTH (the body error is primary but
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
  /** Test seam for the D1 database-level read-replication update. */
  enableD1ReadReplication?: (context: D1ReplicationContext) => Promise<void>;
  listHyperdriveConfigs?: ListHyperdriveConfigs;
  log?: ProvisionLogger;
  /** Test-only override of the `proper-lockfile` stale/update/retries/fs knobs. */
  lockOptions?: ProvisionLockOptions;
  /** Override the OVERALL Hyperdrive-lister deadline (ms). Defaults to {@link HYPERDRIVE_LIST_TIMEOUT_MS}. */
  listTimeoutMs?: number;
}

export type D1ReplicationContext = {
  databaseId: string;
  accountId: string;
  apiBaseUrl: string;
};

export async function enableD1ReadReplicationViaApi(
  context: D1ReplicationContext,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${context.apiBaseUrl}/accounts/${context.accountId}/d1/database/${context.databaseId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read_replication: { mode: 'auto' } }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const envelope = (await response.json().catch(() => null)) as { success?: unknown } | null;
  if (!response.ok || envelope?.success !== true) {
    throw new Error(
      `provision: could not enable D1 read replication for database ${context.databaseId} ` +
        `(Cloudflare API status ${response.status}). The credential needs D1 Edit permission.`,
    );
  }
}

async function reconcileD1(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
  transportAccountId: string,
  transportApiBaseUrl: string,
  opts?: ProvisionOptions,
): Promise<void> {
  // --- D1 ------------------------------------------------------------------
  if (desired.d1) {
    const { binding, name } = desired.d1;
    // The config-relative `migrations_dir` to stamp on the D1 entry. The orchestrator
    // passes the sourceDir-aware value; fall back to the default when unset so a direct
    // provisioner call (no orchestrator) keeps the historical `./db/migrations`.
    const migrationsDir = desired.d1.migrationsDir ?? D1_MIGRATIONS_DIR;
    const entry = readBindingEntry(configPath, 'd1_databases', binding);
    if (entry && isRealD1Id(entry.database_id)) {
      // Stored-name identity: when the entry
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
      const res = write({ d1MigrationsDir: { binding, dir: migrationsDir } });
      assertD1MigrationsDirApplied(res, binding, configPath);
      resources.push({ kind: 'd1', binding, name, action: 'reused', id: entry.database_id });
    } else {
      // Discovery must SUCCEED (gate) before its stdout is parsed, then the whole
      // list is strictly validated — a nonzero/SIGTERM/spawn-error or a malformed
      // member never parses as "absent" and mints a duplicate D1.
      const listResult = await runWrangler({ type: 'd1.list', configPath }, {});
      assertDiscoverySucceeded(listResult, 'wrangler d1 list');
      const rawList = parseJsonArrayStrict(listResult.data);
      if (!rawList) {
        throw new Error(
          `provision: "wrangler d1 list --json" did not return a JSON array; cannot verify whether ` +
            `D1 database ${JSON.stringify(name)} exists. Refusing to create a possible duplicate.`,
        );
      }
      const databases = validateResourceList(rawList, {
        resource: 'D1 database',
        command: 'wrangler d1 list',
        // The ONE alias reconciler gates EVERY member (never "any one alias
        // valid"): a conflicting or malformed secondary alias rejects the whole list.
        hasValidId: (member) => reconcileD1IdAliases(member).kind === 'id',
        idRule:
          'its uuid/database_id aliases must be present, well-formed D1 UUIDs agreeing on one id',
        nameField: 'name',
        nameLabel: 'named',
      });
      // Run the ONE strict normalizer over EVERY member against the requested
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
          d1MigrationsDir: { binding, dir: migrationsDir },
        });
        assertD1MigrationsDirApplied(res, binding, configPath);
        resources.push({ kind: 'd1', binding, name, action: 'adopted', id: existing.id });
      } else {
        const created = await runWrangler({ type: 'd1.create', name: name, binding, configPath });
        if (isCleanSuccess(created)) {
          // wrangler wrote database_id/database_name via --update-config; VERIFY the
          // real id landed (postcondition), then fill the migrations_dir it does
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
          persistCreatedConfig();
          const res = write({ d1MigrationsDir: { binding, dir: migrationsDir } });
          assertD1MigrationsDirApplied(res, binding, configPath);
          resources.push({ kind: 'd1', binding, name, action: 'created' });
        } else if (isCleanFailure(created) && isAlreadyExistsError(created)) {
          // TOCTOU: created between our list and create (clean non-zero, code 7502).
          // Capture the id via `d1 info` — which must SUCCEED (gate) and POSITIVELY
          // identify THIS database (EXACT name match) before we adopt its id.
          const infoResult = await runWrangler({ type: 'd1.info', name: name, configPath }, {});
          assertDiscoverySucceeded(infoResult, `wrangler d1 info ${name}`);
          // SAME strict normalizer as the list path — must POSITIVELY identify THIS
          // database by an exact name match with an unambiguous id.
          const info = normalizeD1(parseJsonObject(infoResult.data), name);
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
            d1MigrationsDir: { binding, dir: migrationsDir },
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

    // The database-level setting is separate from the Worker binding. A reused
    // database may predate this feature, so converge it on every provision run.
    const databaseId = readBindingEntry(configPath, 'd1_databases', binding)?.database_id;
    if (!isRealD1Id(databaseId)) {
      throw new Error(`provision: D1 binding ${binding} has no real database id after setup.`);
    }
    const context: D1ReplicationContext = {
      databaseId,
      accountId: transportAccountId,
      apiBaseUrl: transportApiBaseUrl,
    };
    if (opts?.enableD1ReadReplication) {
      await opts.enableD1ReadReplication(context);
    } else {
      let token = opts?.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        const auth = await runWrangler({ type: 'auth.token', configPath }, { suppressLogs: true });
        const parsed = isCleanSuccess(auth) && isRecord(auth.data) ? auth.data : undefined;
        if (
          (parsed?.type === 'oauth' || parsed?.type === 'api_token') &&
          typeof parsed.token === 'string'
        ) {
          token = parsed.token;
        }
      }
      if (!token) {
        throw new Error(
          'provision: D1 read replication requires a Cloudflare API bearer with D1 Edit permission. ' +
            'Log in with `wrangler login` or set CLOUDFLARE_API_TOKEN, then retry.',
        );
      }
      await enableD1ReadReplicationViaApi(context, token);
    }
  }
}

async function reconcileKv(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
): Promise<void> {
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
    const listResult = await runWrangler({ type: 'kv.namespace.list', configPath }, {});
    assertDiscoverySucceeded(listResult, 'wrangler kv namespace list');
    const rawList = parseJsonArrayStrict(listResult.data);
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
      const created = await runWrangler({
        type: 'kv.namespace.create',
        name: title,
        binding,
        configPath,
      });
      if (!isCleanSuccess(created)) {
        throw new Error(
          `provision: "wrangler kv namespace create ${title}" failed: ${created.stderr || created.stdout}`,
        );
      }
      // Postcondition: confirm --update-config wrote a REAL id (a killed create
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
      persistCreatedConfig();
      resources.push({ kind: 'kv', binding, name: title, action: 'created' });
    }
  }
}

async function reconcileR2(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
): Promise<void> {
  // --- R2 ------------------------------------------------------------------
  if (desired.r2) {
    const { binding, bucketName } = desired.r2;
    const entry = readBindingEntry(configPath, 'r2_buckets', binding);
    // `bucket_name` IS the R2 identity: a stored
    // REAL (non-placeholder) bucket_name that differs from the desired name is a
    // CONTRADICTION — reusing it would keep the app bound to a different bucket while
    // reporting the desired one provisioned. Equal → reuse as before (the desired name
    // already passed the R2 grammar gate, so an equal stored name is format-valid too).
    // ONLY R2's own placeholder (`default`) or an absent/non-string name
    // keeps the discovery path: a stored `local` is a grammar-valid REAL bucket name
    // (the shared check that also rejected `local` let it bypass this contradiction
    // gate and be silently rewritten).
    const storedBucketName = entry?.bucket_name;
    if (entry && isRealStoredR2BucketName(storedBucketName, bucketName)) {
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
      const info = await runWrangler({ type: 'r2.bucket.info', name: bucketName, configPath }, {});
      if (isCleanSuccess(info)) {
        // A clean exit 0 is not enough to adopt — the success payload must
        // POSITIVELY identify the requested bucket (its `name`) before we write the
        // entry, else a mismatched/garbled 0-exit payload could bind the wrong
        // bucket. (A signal-killed probe is NOT a clean success — see the rule.)
        const payload = parseJsonObject(info.data);
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
      } else if (isConfirmedAbsent(info, 'r2')) {
        // CONFIRMED not-found (clean non-zero + exact signal) → create.
        // `--update-config` upserts by binding.
        const created = await runWrangler({
          type: 'r2.bucket.create',
          name: bucketName,
          binding,
          configPath,
        });
        if (!isCleanSuccess(created)) {
          throw new Error(
            `provision: "wrangler r2 bucket create ${bucketName}" failed: ${created.stderr || created.stdout}`,
          );
        }
        // Postcondition: confirm --update-config wrote the requested bucket_name
        // (grammar-valid + EXACT name equality — the name IS the R2 identity).
        // No placeholder heuristic here — a desired bucket genuinely
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
        // When the DESIRED name IS R2's placeholder string, the config
        // postcondition is vacuous: a pre-existing placeholder entry is byte-identical
        // to a real create result, so a masked signal-killed create (wrangler's
        // launcher can report exit 0) would pass it. Verify via the EXACT remote probe
        // instead — the same positive identification the adopt path uses.
        if (bucketName === R2_BUCKET_NAME_PLACEHOLDER) {
          const verify = await runWrangler(
            { type: 'r2.bucket.info', name: bucketName, configPath },
            {},
          );
          const payload = isCleanSuccess(verify) ? parseJsonObject(verify.data) : undefined;
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
        persistCreatedConfig();
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
}

async function reconcileHyperdrive(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
  transportAccountId: string,
  transportApiBaseUrl: string,
  redactSecrets: (value: string) => string,
  opts?: ProvisionOptions,
): Promise<void> {
  // --- Hyperdrive ----------------------------------------------------------
  // wrangler 4.131 has NO machine-readable Hyperdrive list (`hyperdrive list`
  // prints a cli-table3 box table; there is no `--json`, and `hyperdrive get`
  // takes an id, not a name). `hyperdrive create` on a NON-UNIQUE name silently
  // mints a DUPLICATE config (new UUID), so a re-run without the id in config
  // would keep minting duplicates. Existence is therefore checked via an
  // INJECTABLE Cloudflare REST seam (GET …/hyperdrive/configs, matched by name):
  // reliable + fully testable (unit tests stub it, no real network). Adoption is
  // attempted BEFORE the connection-string gate (it needs no connection string).
  if (desired.hyperdrive) {
    const { binding, name, connectionString } = desired.hyperdrive;
    // The whole-provision lock already serializes this unguarded list→create
    // across processes: the read-first check below runs UNDER that lock, so a second
    // concurrent provision sees the id the first wrote and SKIPS (no duplicate).
    const entry = readBindingEntry(configPath, 'hyperdrive', binding);
    if (entry && isRealHyperdriveId(entry.id)) {
      resources.push({ kind: 'hyperdrive', binding, name, action: 'reused', id: entry.id });
    } else {
      const lister =
        opts?.listHyperdriveConfigs ?? createDefaultListHyperdriveConfigs(opts?.apiToken);
      // Treat the seam result as UNKNOWN until PROVEN a real array. The OUTER
      // result is validated (`Array.isArray`) BEFORE existence is marked known, so a
      // runtime `null`/`undefined`/non-array is NEVER coerced to "empty" (confirmed
      // absence) — which would authorize a blind create. A malformed outer result and a
      // failed async lister BOTH leave existence UNKNOWN → fail closed if we WOULD create.
      let validatedConfigs: Array<unknown> | undefined;
      let existenceUnknown = true;
      if (lister) {
        try {
          // Always invoke the lister WITH the reconciled account, so an injected
          // lister can never query a DIFFERENT account than the config is pinned to.
          // Bound the WHOLE call by an overall deadline threaded as an `AbortSignal`.
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
          // Never coerce the unknown rejection (`String()`/template
          // would invoke an arbitrary — possibly hostile — `toString`, and a lister/
          // network error could echo a URL carrying userinfo credentials): log ONLY a
          // safely-extracted, redacted message from inside the no-throw boundary.
          log.warn(
            `Hyperdrive existence check for ${name} failed: ` +
              safeRedactedErrorMessage(error, redactSecrets),
          );
          existenceUnknown = true;
          validatedConfigs = undefined;
        }
      }
      // The ONE strict per-entry validator runs OUTSIDE the try, on a PROVEN array
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
        const created = await runWrangler(
          { type: 'hyperdrive.create', name: name, binding, configPath },
          { input: connectionString },
        );
        if (!isCleanSuccess(created)) {
          throw new Error(
            `provision: "wrangler hyperdrive create ${name}" failed: ${created.stderr || created.stdout}`,
          );
        }
        // Postcondition: confirm --update-config wrote a REAL Hyperdrive id.
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
        persistCreatedConfig();
        resources.push({ kind: 'hyperdrive', binding, name, action: 'created' });
      }
    }
  }
}

async function reconcileQueues(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  resources: Array<ProvisionOutcome>,
): Promise<void> {
  // --- Queues (resource only; NEVER writes queue config entries) -----------
  // `wrangler queues list` is a human table, not JSON, and `queues create` has
  // no `--update-config`. So probe each queue by name: `queues info` reports a
  // typed not-found failure when absent. This step only ensures the queue RESOURCE
  // exists — the deploy orchestrator binds producers/consumers into the config
  // (app-class-aware) through `writeProvisionedWranglerConfig`.
  for (const name of desired.queues) {
    const info = await runWrangler({ type: 'queues.info', name: name, configPath });
    // "Exists → reuse" ONLY when the probe POSITIVELY names THIS queue. A bare
    // clean 0 is NOT trusted: the bin wrapper can mask a signal-killed inner CLI as
    // exit 0 with empty output, which a plain `isCleanSuccess` would misread as
    // reused though nothing was verified.
    if (queueInfoConfirmsExists(info, name)) {
      resources.push({ kind: 'queue', name, action: 'reused' });
      continue;
    }
    // Not confirmed-present. It is "absent" (→ create) ONLY on a CLEAN non-zero exit
    // carrying the typed not-found failure. Everything else — a signal/spawn failure, an auth error, a generic
    // `Account not found`, OR a masked-kill clean-0 that did NOT positively identify
    // the queue — fails closed (never a blind create, never a false reuse).
    if (!isConfirmedAbsent(info, 'queue')) {
      throw new Error(
        `provision: "wrangler queues info ${name}" failed or did not confirm the queue exists: ` +
          `${info.stderr || info.stdout || 'no output'}`,
      );
    }
    const created = await runWrangler({ type: 'queues.create', name: name, configPath });
    if (!isCleanSuccess(created)) {
      throw new Error(
        `provision: "wrangler queues create ${name}" failed: ${created.stderr || created.stdout}`,
      );
    }
    // Verify probe — queues write NO config, so `assertCreateWroteRealId` cannot
    // cover them. A create reporting clean 0 is NOT enough (the bin wrapper masks a
    // signal-killed inner CLI as exit 0, creating nothing). RE-RUN the SAME positive
    // `queues info` probe and only record `created` if it now confirms THIS queue;
    // otherwise fail closed (a killed create self-heals on the next run's probe).
    const verify = await runWrangler({ type: 'queues.info', name: name, configPath });
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
  // --- Strict duplicate-member guard at the PROVISIONER BOUNDARY --------
  // `jsonc-parser.parse()` (used by `readRootConfig`) does NOT flag duplicate object
  // members, and `writeProvisionedWranglerConfig`'s duplicate-member guard only runs when
  // the writer is invoked — which is SKIPPED when `account_id` is already correct. So without
  // this, a config with duplicated members (e.g. two `kv_namespaces` arrays) could
  // reach `kv namespace create` (orphan) or be falsely "reused". Run the SAME strict
  // detection the writer uses (reused, not re-implemented) at the boundary — before
  // account persistence, discovery, or ANY remote side effect — and fail closed.
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
    assertNoDuplicateMembers(content, configPath);
  }

  // --- Resource-name validation (BEFORE any argv / remote work) ---------
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

  // --- Resolve + pin the ONE effective Cloudflare account ---------------
  // Precedence: the resolved config's `account_id` > `opts.accountId` > the ambient
  // `CLOUDFLARE_ACCOUNT_ID`. wrangler 4.131 gives the resolved config's account_id
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
  // The config's top-level `compliance_region` co-determines the ONE pinned API base
  // (FedRAMP vs public). Read + type-check it here so it can be reconciled with the ambient
  // `CLOUDFLARE_COMPLIANCE_REGION` (fail closed on conflict) when the base is resolved below.
  const rawComplianceRegion = rootConfig.compliance_region;
  if (rawComplianceRegion !== undefined && typeof rawComplianceRegion !== 'string') {
    throw new Error(
      `provision: "${configPath}" has a non-string "compliance_region"; it must be "public" or ` +
        `"fedramp_high". Fix the config and retry.`,
    );
  }
  // A PRESENT string is passed through VERBATIM (an empty string included): wrangler's
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
  const persistCreatedConfig = (): void => persistMaterializedWranglerConfig(configPath);

  // Any resource to ensure implies remote work (list/info/create/REST).
  const hasRemoteWork =
    !!desired.d1 ||
    desired.kvNamespaces.length > 0 ||
    !!desired.r2 ||
    !!desired.hyperdrive ||
    desired.queues.length > 0;

  // The MANDATORY account fence, at the PROVISIONER BOUNDARY (not inside the
  // default runWrangler). Whenever `desired` implies remote work, an effective
  // account MUST be resolvable — UNCONDITIONALLY, whether the wrangler runner and
  // Hyperdrive lister are the default seams or injected. Otherwise a seam could do
  // remote work (list/info/create/REST) under an ambient/interactive account we
  // never persisted, so a partial run under account A followed by a retry under B
  // would rebind A's resources with no reconciliation (the pin needs a
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

  // Before ANY remote work, fail closed if the project dotenv would redirect
  // wrangler's authenticated transport out from under the pinned base (wrangler reloads
  // `.env`/`.env.local`/`.dev.vars` on every command). A single-endpoint provisioner
  // cannot reason about a redirected transport vs. the pinned Hyperdrive REST base.
  if (hasRemoteWork) {
    assertNoTransportRedirectInProjectDotenv(root);
  }

  // --- Hyperdrive blockers that are knowable BEFORE any account mutation ---
  // Unlike D1/KV/R2/queues — each of which has a machine-readable wrangler probe that
  // works under ANY wrangler credential, including a `wrangler login` OAuth session —
  // Hyperdrive has none (wrangler 4.131 prints a human table and offers no get-by-name;
  // see the Hyperdrive block below). Its existence check is therefore a direct Cloudflare
  // REST call, which needs an API token of its own. Without one there is no way to tell
  // "config absent" from "cannot look", and `hyperdrive create` silently mints a DUPLICATE
  // on a name collision — so the run has to stop.
  //
  // It stops HERE, before the account pin is written and before the first create, rather
  // than at the Hyperdrive block far below: by that point D1/KV/R2 have already been
  // created, so the user pays for a half-provisioned account to learn about a missing
  // token. The message names both ways out, because `wrangler login` is the documented
  // setup and this is the one resource it does not cover.
  //
  // Two DIFFERENT blockers land here, and both are decided WITHOUT a network call — the
  // gate is only ever "could this run reach a real Hyperdrive id by ANY route?":
  //   - a connection string but no token → could create, cannot check first → stop;
  //   - no connection string AND no token/lister → can neither create NOR adopt, so the
  //     only reachable outcome is the fatal `skipped` below → stop.
  // A stringless run that CAN look (token or injected lister) is deliberately let through:
  // adoption needs no connection string, so it may still legitimately succeed.
  if (desired.hyperdrive && !opts?.listHyperdriveConfigs) {
    const { binding, name, connectionString } = desired.hyperdrive;
    const entry = readBindingEntry(configPath, 'hyperdrive', binding);
    const alreadyProvisioned = entry !== undefined && isRealHyperdriveId(entry.id);
    // The read-first path is pure config I/O and needs NO token: an already-provisioned
    // Postgres app deploys fine under `wrangler login` alone.
    if (!alreadyProvisioned && !resolveHyperdriveApiToken(opts?.apiToken)) {
      if (connectionString) {
        throw new Error(
          `provision: Hyperdrive config ${JSON.stringify(name)} is not in "${configPath}" yet, and ` +
            `creating it needs a Cloudflare API token. wrangler exposes no machine-readable ` +
            `Hyperdrive list, so Void checks the account over the Cloudflare REST API, which a ` +
            `Cloudflare browser OAuth cannot authenticate. Without that check a create ` +
            `would silently duplicate an existing same-named config, so nothing was provisioned. ` +
            `Either (a) export CLOUDFLARE_API_TOKEN with Hyperdrive edit permission and rerun, or ` +
            `(b) create the Hyperdrive config yourself (dashboard / "wrangler hyperdrive create") ` +
            `and add its id to the ${JSON.stringify(binding)} hyperdrive binding in ` +
            `"${configPath}" — deploying an already-provisioned Hyperdrive needs no token.`,
        );
      }
      // NO connection string AND no way to look the account up (no token, no injected
      // lister) — so this run can neither CREATE nor ADOPT. Its only possible outcome is
      // the structured `skipped` far below, which the deploy orchestrator treats as FATAL.
      // Reaching that point would first create D1/KV/R2 and pin `account_id`, billing the
      // user for a half-provisioned account to learn about an unset variable. Stop HERE,
      // before the pin and before the first create, for the SAME reason as the token fence.
      //
      // Deliberately NOT loaded from the project's dotenv files: project-derived env is
      // read only inside the credential-scrubbed build subprocess, so making `.env.local` a
      // deploy input here would re-introduce exactly the plaintext leak deploy warns about.
      // The variable has to come from the shell.
      throw new Error(
        `provision: Hyperdrive config ${JSON.stringify(name)} is not in "${configPath}" yet, and ` +
          `there is no DATABASE_URL to create it from. Nothing was provisioned. ` +
          `Either (a) export DATABASE_URL with your PostgreSQL connection string and rerun ` +
          `(Void reads it from the shell — a value in .env/.env.local is NOT used here, so it ` +
          `never ships as a plaintext worker var), or (b) create the Hyperdrive config yourself ` +
          `(dashboard / "wrangler hyperdrive create") and add its id to the ` +
          `${JSON.stringify(binding)} hyperdrive binding in "${configPath}" — deploying an ` +
          `already-provisioned Hyperdrive needs neither DATABASE_URL nor an API token.`,
      );
    }
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

  // The reconciled effective account, threaded as the transport context into
  // EVERY wrangler + Hyperdrive invocation below (default AND injected). The boundary
  // fence above guarantees a resolved account for ALL remote work, so this non-null
  // assertion is sound wherever a seam is actually called (an empty `desired` reaches
  // no seam and never reads it).
  const transportAccountId = effectiveAccountId!;
  // The ONE pinned Cloudflare API base URL (mirroring wrangler's own derivation),
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
  // Every wrangler result (and any rejection message) is redacted at THIS single
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
  // here). Async: `Promise.resolve` coerces a sync-stub result OR the default runner's
  // Promise, and every call site `await`s it. Awaiting yields to the event loop, so a
  // real (slow) wrangler call never blocks the lock heartbeat.
  const runWrangler = (
    args: CloudflareOperation,
    callOpts?: { cwd?: string; suppressLogs?: boolean; input?: string },
  ): Promise<RunWranglerResult> =>
    Promise.resolve(
      selectedRunWrangler(args, {
        ...callOpts,
        accountId: transportAccountId,
        apiBaseUrl: transportApiBaseUrl,
      }),
    ).then(redactResult, (error: unknown) => {
      // A REJECTING runner (a quarantine, an injected seam rejecting a plain
      // string/object/array/frozen value) must not smuggle the secret either: EVERY
      // rejection value is normalized through the ONE redaction carrier before
      // propagation. In-place where possible (identity/metadata survive), a sanitized
      // fallback carrier otherwise — with the quarantine classification captured BEFORE
      // redaction so it can never be lost to a rebuild.
      throw redactRejection(error, redactSecrets);
    });

  await reconcileD1(
    desired,
    configPath,
    runWrangler,
    write,
    persistCreatedConfig,
    resources,
    log,
    transportAccountId,
    transportApiBaseUrl,
    opts,
  );

  await reconcileKv(desired, configPath, runWrangler, write, persistCreatedConfig, resources, log);

  await reconcileR2(desired, configPath, runWrangler, write, persistCreatedConfig, resources, log);

  await reconcileHyperdrive(
    desired,
    configPath,
    runWrangler,
    write,
    persistCreatedConfig,
    resources,
    log,
    transportAccountId,
    transportApiBaseUrl,
    redactSecrets,
    opts,
  );

  await reconcileQueues(desired, configPath, runWrangler, resources);

  // account_id was persisted up front (before any remote side effect) — see the
  // account_id block near the top of this function (fail-closed pin).
  return { resources, configPath, accountIdWritten };
}
