import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';
import { voidLog, voidWarn } from '../log.ts';
import { resolveWranglerArgv } from './preset.ts';
import { writeProvisionedWranglerConfig, type WriteProvisionedWranglerResult } from './wrangler.ts';

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
export type RunWrangler = (
  args: Array<string>,
  opts?: { cwd?: string; captureJson?: boolean },
) => RunWranglerResult;

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
 */
export type ListHyperdriveConfigs = () => Promise<Array<HyperdriveConfig>>;

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
  // Scrub CLOUDFLARE_ENV: it selects an ENVIRONMENT-specific config block, whose
  // own `account_id` (and bindings) could differ from the single account this
  // provision pinned — a footgun. Removing it forces wrangler onto the top-level
  // (pinned) config/account so `wrangler <res> list/create` cannot silently drift
  // to an env-specific account we never resolved or persisted.
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
export function createDefaultRunWrangler(
  root: string,
  options?: { accountId?: string },
): RunWrangler {
  const launcher = resolveWranglerArgv(root);
  const [command, ...prefix] = launcher;
  return (args, opts) => {
    const result = spawnSync(command, [...prefix, ...args], {
      cwd: opts?.cwd ?? root,
      shell: false,
      encoding: 'utf-8',
      env: provisionEnv(options?.accountId),
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
function createDefaultListHyperdriveConfigs(
  accountId?: string,
  apiToken?: string,
): ListHyperdriveConfigs | undefined {
  const token = apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    return undefined;
  }
  return async () => {
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
    return [...byId.values()];
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
 * ONE strict D1 identity normalizer, shared by `d1 list --json` and
 * `d1 info <name> --json`. Requires EXACTLY ONE unambiguous NON-EMPTY id:
 *   - reads BOTH aliases (`database_id`, `uuid`), treating an EMPTY STRING as
 *     ABSENT for each — so an empty-string `uuid` can no longer shadow a valid
 *     `database_id` (`'' ?? x === ''` in the old `??` chain made a validated DB
 *     look absent → duplicate create);
 *   - prefers `database_id` when both are present and equal;
 *   - REJECTS conflicting non-empty aliases (two distinct ids → returns
 *     `undefined`, so the caller does not adopt an ambiguous identity).
 * The `name` (from `database_name`/`name`, empty treated as absent) is returned so
 * callers can require an EXACT requested-name match before adopting.
 */
function normalizeD1Identity(
  entry: Record<string, unknown> | undefined,
): { id: string; name?: string } | undefined {
  if (!entry) {
    return undefined;
  }
  const ids = [entry.database_id, entry.uuid].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  // 0 distinct → no id; >1 distinct → conflicting/ambiguous. Either way, not a
  // usable identity: the caller must fail closed rather than adopt/duplicate.
  if (new Set(ids).size !== 1) {
    return undefined;
  }
  const name = [entry.database_name, entry.name].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return { id: ids[0], name };
}

/** The requested-name value carried by a `d1 list` member (either alias). */
function d1EntryName(entry: Record<string, unknown>): string | undefined {
  return [entry.name, entry.database_name].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
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
  /** Human resource name for the message. */
  resource: string;
  /** Command name for the message. */
  command: string;
}

/**
 * F4 backstop — verify a create's POSTCONDITION. wrangler 4.107's `bin.wrangler`
 * is a WRAPPER that spawns `wrangler-dist/cli.js` and maps a signal-killed child
 * (`code === null`) to `process.exit(0)`, so `spawnSync` can see a `create` report
 * "success" though the real CLI was killed and `--update-config` wrote NO id.
 * After every config-writing create (d1/kv/r2/hyperdrive) reports success we
 * RE-READ the resolved config and CONFIRM the target binding now holds a REAL id;
 * otherwise we FAIL CLOSED. This also catches any partial/silent create failure,
 * not only kills. (Queue creates write NO config, so they cannot be verified this
 * way — a killed queue-create self-heals on the next read-first/probe run, which
 * re-detects absence and re-creates.)
 */
function assertCreateWroteRealId(
  configPath: string,
  spec: CreatePostcondition,
  binding: string,
  name: string,
): void {
  const entry = findBindingEntry(readRootConfig(configPath)[spec.field], binding);
  if (!entry || !isRealValue(entry[spec.idField])) {
    throw new Error(
      `provision: "${spec.command} ${name}" reported success but "${configPath}" holds no real ` +
        `${spec.resource} id for binding ${JSON.stringify(binding)} afterward. The create may have ` +
        `been interrupted — wrangler's launcher can mask a signal-killed child as exit 0. Refusing ` +
        `to record an unprovisioned resource; inspect the account/config and retry.`,
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
  opts?: {
    runWrangler?: RunWrangler;
    accountId?: string;
    apiToken?: string;
    listHyperdriveConfigs?: ListHyperdriveConfigs;
    log?: ProvisionLogger;
  },
): Promise<ProvisionResult> {
  await Promise.resolve();
  // ONE exact config path threaded through read-first, wrangler `-c`, AND the
  // writer, so reads and writes can never hit different files (no split-brain).
  const configPath = rootWranglerPath;

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

  // F1 fail-closed gate: the DEFAULT runWrangler passes the ambient
  // CLOUDFLARE_ACCOUNT_ID to the REAL wrangler, so without a resolved account
  // wrangler could create resources under an environment/ambient account we never
  // persisted (a later retry under a different account would then rebind them).
  // Require a known account before spawning it. The gate is scoped to the default
  // path — the ONLY consumer of the ambient env; when a caller injects runWrangler
  // (unit tests / a future orchestrator seam) it owns the account context.
  if (!opts?.runWrangler && hasRemoteWork && !effectiveAccountId) {
    throw new Error(
      `provision: no Cloudflare account is resolvable — set "account_id" in your root wrangler ` +
        `config or export CLOUDFLARE_ACCOUNT_ID before deploying. Refusing to provision resources ` +
        `without a pinned account (wrangler would otherwise fall back to an ambient/interactive ` +
        `account that is never persisted, so a later retry could rebind them elsewhere).`,
    );
  }
  const runWrangler =
    opts?.runWrangler ?? createDefaultRunWrangler(root, { accountId: effectiveAccountId });

  // --- account_id (PERSIST FIRST, before any remote side effect) -----------
  // Pin the effective account_id NOW — before any create writes a real id — so a
  // partial run can never leave freshly-minted ids in a config with NO account pin.
  // Without this, a later retry under a DIFFERENT account would see the real id
  // (read-first hit → skips discovery) and finally stamp its own `account_id`,
  // binding the first account's resources under the second. With the pin written up
  // front, a different-account retry instead hits the reconciliation above (config
  // account ≠ requested → fail closed) before touching wrangler/REST. Skip the write
  // when the config ALREADY pins that exact account (keeps byte-identical configs
  // untouched).
  let accountIdWritten = false;
  if (effectiveAccountId && configAccountId !== effectiveAccountId) {
    write({ accountId: effectiveAccountId });
    accountIdWritten = true;
  }

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
      const listResult = runWrangler(['d1', 'list', '--json', '-c', configPath], {
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
      // F5: find the member whose name matches the request, then normalize its
      // identity strictly. If the target-named member exists but its id is
      // ambiguous/empty (e.g. an empty-string `uuid` that used to shadow a valid
      // `database_id`, or conflicting aliases), FAIL CLOSED — never fall through to
      // create (a duplicate) and never adopt an ambiguous id.
      const namedMatch = databases.find((db) => d1EntryName(db) === name);
      const existing = normalizeD1Identity(namedMatch);
      if (namedMatch && !existing) {
        throw new Error(
          `provision: "wrangler d1 list" returned a D1 database named ${JSON.stringify(name)} with ` +
            `an ambiguous or empty id (conflicting/blank uuid/database_id). Cannot adopt it, and ` +
            `refusing to create a possible duplicate; inspect the account and retry.`,
        );
      }
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
          '-c',
          configPath,
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
          const infoResult = runWrangler(['d1', 'info', name, '--json', '-c', configPath], {
            captureJson: true,
          });
          assertDiscoverySucceeded(infoResult, `wrangler d1 info ${name}`);
          const info = normalizeD1Identity(parseJsonObject(infoResult.stdout));
          if (!info || info.name !== name) {
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
    const listResult = runWrangler(['kv', 'namespace', 'list', '-c', configPath], {
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
        '-c',
        configPath,
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
      const info = runWrangler(['r2', 'bucket', 'info', bucketName, '--json', '-c', configPath], {
        captureJson: true,
      });
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
          '-c',
          configPath,
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
    const entry = findBindingEntry(readRootConfig(configPath).hyperdrive, binding);
    if (entry && isRealValue(entry.id)) {
      resources.push({ kind: 'hyperdrive', binding, name, action: 'reused', id: entry.id });
    } else {
      const lister =
        opts?.listHyperdriveConfigs ??
        createDefaultListHyperdriveConfigs(effectiveAccountId, opts?.apiToken);
      let configs: Array<HyperdriveConfig> | undefined;
      let existenceUnknown = true;
      if (lister) {
        try {
          configs = await lister();
          existenceUnknown = false;
        } catch (error) {
          log.warn(`Hyperdrive existence check for ${name} failed: ${(error as Error).message}`);
          existenceUnknown = true;
        }
      }
      // Require EXACTLY 0 or 1 exact-name match. Hyperdrive names are NOT unique,
      // so >1 is ambiguous — adoption cannot pick one, and a blind create would
      // mint yet another duplicate. Fail closed on ambiguity (regardless of the
      // connection string).
      let existing: HyperdriveConfig | undefined;
      if (configs) {
        const named = configs.filter((c) => c.name === name);
        if (named.length > 1) {
          throw new Error(
            `provision: cannot adopt Hyperdrive config ${JSON.stringify(name)} — ${named.length} ` +
              `configs in this account share that name (ids: ${named.map((c) => c.id).join(', ')}). ` +
              `Hyperdrive names are not account-unique; remove the duplicates or pin the id in ` +
              `"${configPath}", then retry.`,
          );
        }
        existing = named[0];
      }
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
        // unverifiable → FAIL CLOSED. Blindly creating duplicates a same-named
        // config.
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
          '-c',
          configPath,
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
    const info = runWrangler(['queues', 'info', name, '-c', configPath]);
    if (isCleanSuccess(info)) {
      resources.push({ kind: 'queue', name, action: 'reused' });
      continue;
    }
    // A probe is "absent" (→ create) ONLY on a CLEAN non-zero exit carrying the
    // EXACT, name-aware not-found signal (`Queue "<name>" does not exist`). Any
    // signal/spawn failure (HARD failure), an auth error, or a generic `Account not
    // found` is NOT absence and fails closed (never a blind create).
    if (!isConfirmedAbsent(info, 'queue', name)) {
      throw new Error(
        `provision: "wrangler queues info ${name}" failed: ${info.stderr || info.stdout}`,
      );
    }
    const created = runWrangler(['queues', 'create', name, '-c', configPath]);
    // Queue creates write NO config, so they cannot be postcondition-verified; a
    // killed queue-create self-heals on the next run (its `queues info` probe
    // re-detects absence and re-creates). We still fail closed on a non-clean exit.
    if (!isCleanSuccess(created)) {
      throw new Error(
        `provision: "wrangler queues create ${name}" failed: ${created.stderr || created.stdout}`,
      );
    }
    resources.push({ kind: 'queue', name, action: 'created' });
  }

  // account_id was persisted up front (before any remote side effect) — see the
  // account_id block near the top of this function (F1 fail-closed pin).
  return { resources, configPath, accountIdWritten };
}
