import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';
import { resolve } from 'pathe';
import lockfile from 'proper-lockfile';
import { voidLog, voidWarn } from '../log.ts';
import { resolveWranglerArgv } from './preset.ts';
import {
  assertNoDuplicateMembers,
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
  cwd?: string;
  captureJson?: boolean;
}

export type RunWrangler = (args: Array<string>, opts: WranglerCallContext) => RunWranglerResult;

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
 * F1 — the lister receives the reconciled `accountId` as an explicit transport
 * context (never a closure-only binding), so an injected lister can never query a
 * DIFFERENT account than the one the config is pinned to.
 */
export type ListHyperdriveConfigs = (ctx: {
  accountId: string;
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

/**
 * Values wrangler/Void write as placeholders during local dev
 * (`syncWranglerBindings`): a D1 `database_id: 'local'`, a KV `id: 'local'`, an
 * R2 `bucket_name: 'default'`. A binding holding one of these is NOT yet backed
 * by a real account resource, so provisioning must not treat it as done.
 */
function isRealValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== 'local' && value !== 'default';
}

const defaultLogger: ProvisionLogger = {
  info: (msg) => voidLog(msg),
  warn: (msg) => voidWarn(msg),
};

/**
 * Child-process env with the CF Access service-token PAIR scrubbed. Mirrors
 * `buildEnv` in `deploy.ts`: a shared, long-lived Access token is needed only by
 * this CLI's own API client and must never leak into the spawned wrangler
 * process (which may in turn run user hooks). The cloudflared `CF_ACCESS_TOKEN`
 * JWT (dev path) is left untouched.
 */
export function provisionEnv(accountId?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;
  // Best-effort scrub of CLOUDFLARE_ENV (it selects an ENVIRONMENT-specific config
  // block whose `account_id`/bindings could differ from the account this provision
  // pinned). This ALONE is NOT sufficient: wrangler 4.107 reloads `.env`/`.env.local`
  // from the project root into `process.env` on every command, so a project `.env`
  // with `CLOUDFLARE_ENV=staging` would repopulate it after this delete. The RELIABLE
  // top-level pin is the explicit empty `--env=` flag added to EVERY wrangler argv
  // (see `wranglerConfigArgs`); wrangler resolves the env as `args.env ?? CLOUDFLARE_ENV`,
  // and an explicit empty `args.env` short-circuits the `??` so the reloaded
  // CLOUDFLARE_ENV can never reselect a named env-block/account. The delete stays as
  // defense in depth for any other consumer of this env.
  delete env.CLOUDFLARE_ENV;
  // Pin the target account non-interactively (CI-safe) when known, so
  // `wrangler <res> list/create` never prompts for disambiguation AND never falls
  // back to a DIFFERENT ambient account than the one we resolved + persisted.
  if (accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  return env;
}

/**
 * Default `runWrangler`: resolves the project-local wrangler as an ARGV launcher
 * via Task 2's {@link resolveWranglerArgv} and runs it with `spawnSync` and
 * `shell: false`, so every argument is passed literally (no shell parsing → no
 * injection). Captures stdout (for `--json` parsing) and stderr (for
 * error/collision detection). Never called in unit tests — those inject a stub.
 */
export function createDefaultRunWrangler(root: string): RunWrangler {
  const launcher = resolveWranglerArgv(root);
  const [command, ...prefix] = launcher;
  return (args, opts) => {
    const result = spawnSync(command, [...prefix, ...args], {
      cwd: opts.cwd ?? root,
      shell: false,
      encoding: 'utf-8',
      // F1 — pin the account PER CALL from the transport context, so the spawned
      // wrangler targets the SAME reconciled account the config + Hyperdrive REST
      // path use (no split-brain between the config pin and the ambient env).
      env: provisionEnv(opts.accountId),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return normalizeRunWranglerResult(result);
  };
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
  // F1 — the account comes from the per-call transport context (not a closure), so
  // this default REST lister always targets the reconciled effective account.
  return async ({ accountId }) => {
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
    const perPage = 100;
    const byId = new Map<string, HyperdriveConfig>();
    let expectedTotal: number | undefined;
    for (let page = 1; ; page++) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs?page=${page}&per_page=${perPage}`,
        { headers: { Authorization: `Bearer ${token}` } },
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
 * F3 — the ONE strict Hyperdrive-list validator, applied at the CALLER after EITHER
 * lister returns (the default fetch OR an injected seam), so validation can never live
 * only inside the default fetch. Rejects any non-object member, empty/non-string `id`
 * or `name`, and duplicate `id`; then requires EXACTLY 0 or 1 exact-name match (>1 is
 * ambiguous — Hyperdrive names are NOT account-unique — and fails closed) BEFORE any
 * match/write. Returns the single exact-name match, or `undefined` when none matches.
 * Without this, an injected `[{ id:'', name: requested }]` would be adopted with an
 * EMPTY id.
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
  release: () => Promise<void>;
}

/**
 * A lock whose owner has not refreshed it within this window is treated as abandoned
 * (crashed) and may be compromised/stolen, so a crashed provision cannot wedge every
 * future one. A LIVE owner refreshes the mutex mtime every {@link LOCK_UPDATE_MS}
 * (strictly less than this), so it never expires by age. Generous vs. a real
 * provision's duration.
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
export async function acquireProvisionLock(configPath: string): Promise<ProvisionLock> {
  const lockTarget = `${configPath}.void-provision.lock`;
  if (!existsSync(lockTarget)) {
    writeFileSync(lockTarget, '');
  }
  const release = await lockfile.lock(lockTarget, {
    stale: LOCK_STALE_MS,
    update: LOCK_UPDATE_MS,
    retries: LOCK_RETRIES,
    onCompromised: (error) => {
      throw error;
    },
  });
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await release();
      } catch {
        // best-effort: a stale-compromise sweep may have already dropped the mutex
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

/** Read the entry in a `[{ binding }]` array whose `binding` matches. */
function findBindingEntry(list: unknown, binding: string): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.binding === binding,
  );
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
  /** Any ONE of these holding a non-empty string satisfies "has an id". */
  idFields: Array<string>;
  /** The member field carrying the account-matched name/title. */
  nameField: string;
  /** Grammatical label for the name field in messages: `titled` / `named`. */
  nameLabel: string;
}

/**
 * STRICT list validator shared by KV + D1. Rejects the ENTIRE list (throws) if
 * ANY member is not a well-formed object carrying the required non-empty string
 * fields — a member is NEVER silently filtered, because a malformed member could
 * BE the requested target and dropping it would look like "absent" and mint a
 * duplicate. Returns the validated members (every one guaranteed to have a valid
 * id + name) on success.
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
    const idValid = spec.idFields.some((f) => {
      const value = member[f];
      return typeof value === 'string' && value.length > 0;
    });
    if (nameValid && !idValid) {
      throw new Error(
        `provision: "${spec.command}" returned a ${spec.resource} ${spec.nameLabel} ` +
          `${JSON.stringify(rawName)} with no valid id. Cannot verify whether it already exists; ` +
          `refusing to create a possible duplicate.`,
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
  const ids = [entry.database_id, entry.uuid].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  // 0 distinct → no id; >1 distinct → conflicting/blank aliases. Fail closed.
  if (new Set(ids).size !== 1) {
    return { kind: 'claimed-but-invalid' };
  }
  return { kind: 'match', id: ids[0] };
}

/**
 * `wrangler kv namespace list` → the `{ id }` of every namespace whose title
 * matches. The list has ALREADY been through {@link validateResourceList} (every
 * member has a non-empty string `id` + `title`), so this only filters + collects.
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
    const id = ns.id;
    if (typeof id === 'string' && id.length > 0) {
      matches.push({ id });
    }
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
      // CF API error code 10006 (the exact code wrangler's own
      // `isConnectedToExistingResource` treats as "bucket absent") or wrangler's
      // exact R2 not-found message. R2's message does not embed the bucket name,
      // so the code/message IS the exact signal. A metrics/auth/network failure
      // (whose text may loosely contain "not found") is NOT matched here.
      return /\b10006\b/.test(text) || /the specified bucket does not exist/i.test(text);
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
  const entry = findBindingEntry(readRootConfig(configPath)[spec.field], binding);
  const idOk = !!entry && isRealValue(entry[spec.idField]);
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

/**
 * F2 — Cloudflare resource-name grammar enforced on EVERY name placed as a
 * wrangler ARGV POSITIONAL (D1 db name, KV title, R2 bucket, Hyperdrive name,
 * queue name) BEFORE it reaches argv. Shell-free spawning stops shell injection
 * but NOT CLI OPTION injection: a name like `--help`, `--config`, or `-h` would be
 * parsed by wrangler as a FLAG (and a queue name is derived from a filename → it
 * is attacker-influenced). We require the name to START with an ASCII letter or
 * digit and contain only ASCII letters, digits, `-` and `_`, 1–63 chars. That
 * rejects any leading `-` (the flag vector) plus whitespace/metacharacters, and is
 * a safe superset of Cloudflare's per-resource naming rules. Fail closed on any
 * violation — an option-like name never reaches wrangler.
 */
const RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
function assertValidResourceName(kind: string, name: string): void {
  if (typeof name !== 'string' || !RESOURCE_NAME_RE.test(name)) {
    throw new Error(
      `provision: refusing to pass an invalid ${kind} name ${JSON.stringify(name)} to wrangler. ` +
        `Resource names must be 1–63 characters, start with a letter or digit, and contain only ` +
        `letters, digits, "-" or "_" (a name beginning with "-" would be parsed as a CLI flag). ` +
        `Rename the resource and retry.`,
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
  const configPath = resolve(root, rootWranglerPath);

  // F1/F2 — hold ONE cross-process lock for the WHOLE provision: acquire it BEFORE
  // the first config read (so account reconciliation + persistence + all discovery,
  // remote work, and config writes happen against the state the lock protects), and
  // ALWAYS release it in `finally` (an interruption must never leak the lock). The
  // reconciliation + duplicate-member guard + resource work all run UNDER the lock in
  // `provisionCloudflareResourcesLocked`, so a racing first-run serializes: the second
  // process re-reads the persisted account/ids and fails closed (or reuses).
  const lock = await acquireProvisionLock(configPath);
  try {
    return await provisionCloudflareResourcesLocked(root, configPath, desired, opts);
  } finally {
    await lock.release();
  }
}

/** Injectable seams + settings for {@link provisionCloudflareResources}. */
export interface ProvisionOptions {
  runWrangler?: RunWrangler;
  accountId?: string;
  apiToken?: string;
  listHyperdriveConfigs?: ListHyperdriveConfigs;
  log?: ProvisionLogger;
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

  // --- F2: resource-name validation (BEFORE any argv / remote work) ---------
  // Every name that becomes a wrangler ARGV POSITIONAL is validated up front, so an
  // option-like name (`--help`, `-h`, `--config`) can never reach wrangler and be
  // parsed as a flag. Fail closed here, before the account gate or any wrangler/REST
  // call.
  if (desired.d1) {
    assertValidResourceName('D1 database', desired.d1.name);
  }
  for (const { title } of desired.kvNamespaces) {
    assertValidResourceName('KV namespace', title);
  }
  if (desired.r2) {
    assertValidResourceName('R2 bucket', desired.r2.bucketName);
  }
  if (desired.hyperdrive) {
    assertValidResourceName('Hyperdrive config', desired.hyperdrive.name);
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
  const rawConfigAccountId = readRootConfig(configPath).account_id;
  const configAccountId =
    typeof rawConfigAccountId === 'string' && rawConfigAccountId.length > 0
      ? rawConfigAccountId
      : undefined;
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

  // Both seams are pinned to the SAME effective account: the default wrangler runner
  // via its env (`CLOUDFLARE_ACCOUNT_ID` + the top-level `--env=` on every argv), and
  // the default Hyperdrive lister via `createDefaultListHyperdriveConfigs` (below).
  // An injected seam owns its own transport but is ALWAYS invoked WITH the reconciled
  // account (via the single choke point below / the lister's `{ accountId }` context),
  // so it can never target a DIFFERENT account than the one the config is pinned to.
  const selectedRunWrangler = opts?.runWrangler ?? createDefaultRunWrangler(root);
  // Single choke point: inject the reconciled account into EVERY call so no call site
  // can forget it (grep-proven — every `runWrangler(...)` below routes through here).
  const runWrangler = (
    args: Array<string>,
    callOpts?: { cwd?: string; captureJson?: boolean },
  ): RunWranglerResult => selectedRunWrangler(args, { ...callOpts, accountId: transportAccountId });

  // --- D1 ------------------------------------------------------------------
  if (desired.d1) {
    const { binding, name } = desired.d1;
    const entry = findBindingEntry(readRootConfig(configPath).d1_databases, binding);
    if (entry && isRealValue(entry.database_id)) {
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
      const listResult = runWrangler(['d1', 'list', '--json', ...wranglerConfigArgs(configPath)], {
        captureJson: true,
      });
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
        idFields: ['uuid', 'database_id'],
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
        const created = runWrangler([
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
          const infoResult = runWrangler(
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
    const entry = findBindingEntry(readRootConfig(configPath).kv_namespaces, binding);
    if (entry && isRealValue(entry.id)) {
      resources.push({ kind: 'kv', binding, name: title, action: 'reused', id: entry.id });
      continue;
    }
    // KV titles are NOT account-unique and `kv namespace create` never dedupes,
    // so this list is the ONLY orphan guard. Route it through the SHARED gate +
    // strict validator: the discovery must exit 0 (nonzero/SIGTERM/spawn-error →
    // throw), return a real JSON array, and have EVERY member well-formed (a
    // malformed member — which could BE the target — fails closed rather than being
    // filtered to a false "absent" that mints a duplicate namespace).
    const listResult = runWrangler(['kv', 'namespace', 'list', ...wranglerConfigArgs(configPath)], {
      captureJson: true,
    });
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
      idFields: ['id'],
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
      const created = runWrangler([
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
    const entry = findBindingEntry(readRootConfig(configPath).r2_buckets, binding);
    if (entry && isRealValue(entry.bucket_name)) {
      resources.push({ kind: 'r2', binding, name: bucketName, action: 'reused' });
    } else {
      // `wrangler r2 bucket list` is a human table, not JSON. Bucket names ARE
      // account-unique, so probe the single bucket by name.
      const info = runWrangler(
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
        const created = runWrangler([
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
        // F4 postcondition: confirm --update-config wrote a REAL bucket_name.
        assertCreateWroteRealId(
          configPath,
          {
            field: 'r2_buckets',
            idField: 'bucket_name',
            nameField: 'bucket_name',
            resource: 'R2 bucket',
            command: 'wrangler r2 bucket create',
          },
          binding,
          bucketName,
        );
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
    const entry = findBindingEntry(readRootConfig(configPath).hyperdrive, binding);
    if (entry && isRealValue(entry.id)) {
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
          const result = await lister({ accountId: transportAccountId });
          if (!Array.isArray(result)) {
            throw new Error(
              `the existence check returned a ${result === null ? 'null' : typeof result} result ` +
                `instead of an array`,
            );
          }
          validatedConfigs = result;
          existenceUnknown = false;
        } catch (error) {
          log.warn(`Hyperdrive existence check for ${name} failed: ${(error as Error).message}`);
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
        const created = runWrangler([
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
    const info = runWrangler(['queues', 'info', name, ...wranglerConfigArgs(configPath)]);
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
    const created = runWrangler(['queues', 'create', name, ...wranglerConfigArgs(configPath)]);
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
    const verify = runWrangler(['queues', 'info', name, ...wranglerConfigArgs(configPath)]);
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
