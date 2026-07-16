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

/** Result of one `runWrangler` invocation. */
export type RunWranglerResult = { stdout: string; stderr: string; status: number };

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
function provisionEnv(accountId?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;
  // Select the target account non-interactively (CI-safe) when known, so
  // `wrangler <res> list/create` never prompts for account disambiguation.
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
  return { stdout, stderr, status };
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
    const perPage = 100;
    const all: Array<HyperdriveConfig> = [];
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
        all.push({ id: entry.id, name: entry.name });
      }
      // Follow `result_info` pagination: stop once we have gathered `total_count`
      // entries (or the page came back empty / without pagination metadata).
      const info = body.result_info;
      const totalCount =
        isRecord(info) && typeof info.total_count === 'number' ? info.total_count : undefined;
      if (totalCount === undefined || body.result.length === 0 || all.length >= totalCount) {
        break;
      }
    }
    return all;
  };
}

/** Parse a wrangler `--json` stdout into an array, tolerating noise/failure. */
function parseJsonArray(stdout: string): Array<Record<string, unknown>> {
  const value = parseJsonLoose(stdout);
  return Array.isArray(value) ? (value.filter(isRecord) as Array<Record<string, unknown>>) : [];
}

/**
 * Parse a wrangler `--json` stdout into an array, distinguishing a VALID JSON
 * array (returns it, possibly empty) from unparseable/non-array output (returns
 * `undefined`). Used where an empty list must mean "authoritatively absent" and
 * garbage must NOT be silently coerced to "absent" (the KV pre-check).
 */
function parseJsonArrayStrict(stdout: string): Array<Record<string, unknown>> | undefined {
  const value = parseJsonLoose(stdout);
  return Array.isArray(value)
    ? (value.filter(isRecord) as Array<Record<string, unknown>>)
    : undefined;
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

// --- wrangler output extractors (one place to align field names with wrangler) ---

/** `wrangler d1 list --json` / `d1 info <name> --json` → `{ id, name }`. */
function extractD1(
  entry: Record<string, unknown> | undefined,
): { id: string; name?: string } | undefined {
  if (!entry) {
    return undefined;
  }
  const id = entry.uuid ?? entry.database_id;
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  return { id, name: typeof entry.name === 'string' ? entry.name : undefined };
}

/**
 * `wrangler kv namespace list` → the `{ id }` of every namespace whose title
 * matches. FAILS CLOSED: a namespace whose title matches the target but carries
 * no non-empty string `id` (a schema-valid-but-idless member like
 * `{ "title": "target" }`) is NOT silently dropped — dropping it would look like
 * "absent" and mint a DUPLICATE namespace (KV titles are not account-unique). It
 * throws so the caller surfaces the ambiguity instead of blindly creating.
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
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `provision: "wrangler kv namespace list" returned a namespace titled ${JSON.stringify(title)} ` +
          `with no valid id. Cannot verify whether it already exists; refusing to create a possible ` +
          `duplicate (KV titles are not account-unique). Inspect the account and retry.`,
      );
    }
    matches.push({ id });
  }
  return matches;
}

/** True when a `d1 create` failure means the name is already taken (code 7502). */
function isAlreadyExistsError(result: RunWranglerResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return text.includes('7502') || /already exists/i.test(text);
}

/**
 * True when a failing `<res> info/get` means the resource simply does NOT exist
 * (safe to create), vs. a different failure (auth/network) we must surface
 * instead of blindly creating. wrangler's `getQueue` throws `Queue "x" does not
 * exist`; the R2/other get-by-name paths throw comparable not-found errors.
 */
function isMissingResourceError(result: RunWranglerResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return /does not exist|not found|could not be found|no such/i.test(text);
}

/**
 * True ONLY when a failing `r2 bucket info` is the confirmed bucket-not-found
 * signal. The DEFINITIVE signal is CF API error code `10006` — the exact code
 * wrangler's own `isConnectedToExistingResource` treats as "bucket absent" — plus
 * wrangler's exact R2 not-found message. In wrangler 4.107 `r2 bucket info` does
 * the bucket lookup AND a separate metrics/GraphQL query, so an EXISTING bucket
 * can exit non-zero on a metrics/auth/network failure. We deliberately do NOT
 * fall back to the broad `isMissingResourceError` regex (`not found`/`no such`/…):
 * an unrelated metrics/GraphQL error whose text loosely contains "not found"
 * would be misread as absence and mint a duplicate. Create ONLY on this confirmed
 * signal; any other non-zero is surfaced.
 */
function isBucketNotFoundError(result: RunWranglerResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return /\b10006\b/.test(text) || /the specified bucket does not exist/i.test(text);
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
  // Resolve the ONE effective Cloudflare account BEFORE any read-first / create /
  // REST. wrangler 4.107 gives the resolved config's `account_id` PRECEDENCE over
  // the CLOUDFLARE_ACCOUNT_ID env var, so if the config pins account X while
  // `opts.accountId` requests Y, wrangler create/list would target X while the
  // Hyperdrive REST existence check targets Y — a cross-account create/orphan.
  // Fail closed on a real mismatch; otherwise pin `config.account_id ??
  // opts.accountId` EVERYWHERE (the wrangler env AND the Hyperdrive REST call), so
  // every path targets the same account.
  const configAccountId = readRootConfig(configPath).account_id;
  if (
    typeof configAccountId === 'string' &&
    configAccountId.length > 0 &&
    opts?.accountId &&
    configAccountId !== opts.accountId
  ) {
    throw new Error(
      `provision: Cloudflare account mismatch — "${configPath}" pins account_id ` +
        `${JSON.stringify(configAccountId)} but deploy requested ${JSON.stringify(opts.accountId)}. ` +
        `Reconcile them (correct or remove the config's account_id, or deploy to the pinned account) ` +
        `and retry.`,
    );
  }
  const effectiveAccountId =
    typeof configAccountId === 'string' && configAccountId.length > 0
      ? configAccountId
      : opts?.accountId;
  const runWrangler =
    opts?.runWrangler ?? createDefaultRunWrangler(root, { accountId: effectiveAccountId });
  const log = opts?.log ?? defaultLogger;
  const resources: Array<ProvisionOutcome> = [];
  const write = (
    patch: Parameters<typeof writeProvisionedWranglerConfig>[1],
  ): WriteProvisionedWranglerResult => writeProvisionedWranglerConfig(root, patch, { configPath });

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
      const existing = extractD1(
        parseJsonArray(
          runWrangler(['d1', 'list', '--json', '-c', configPath], { captureJson: true }).stdout,
        ).find((db) => db.name === name),
      );
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
        if (created.status !== 0) {
          if (isAlreadyExistsError(created)) {
            // TOCTOU: created between our list and create (code 7502). Capture
            // the id via `d1 info` and adopt instead of failing.
            const info = extractD1(
              parseJsonObject(
                runWrangler(['d1', 'info', name, '--json', '-c', configPath], { captureJson: true })
                  .stdout,
              ),
            );
            if (!info) {
              throw new Error(
                `provision: "wrangler d1 create ${name}" reported the database already exists, ` +
                  `but its id could not be resolved via "wrangler d1 info ${name} --json".`,
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
            throw new Error(
              `provision: "wrangler d1 create ${name}" failed: ${created.stderr || created.stdout}`,
            );
          }
        } else {
          // wrangler wrote database_id/database_name via --update-config; fill
          // the migrations_dir it does not.
          const res = write({ d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR } });
          assertD1MigrationsDirApplied(res, binding, configPath);
          resources.push({ kind: 'd1', binding, name, action: 'created' });
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
    // so this list is the ONLY orphan guard. Require status 0 AND a schema-valid
    // JSON array before treating an absent title as authoritative — otherwise a
    // nonzero/auth/network/truncated result would parse as "absent" and mint a
    // duplicate namespace. Fail closed (throw) instead.
    const listResult = runWrangler(['kv', 'namespace', 'list', '-c', configPath], {
      captureJson: true,
    });
    if (listResult.status !== 0) {
      throw new Error(
        `provision: "wrangler kv namespace list" failed: ${listResult.stderr || listResult.stdout}. ` +
          `Cannot verify whether KV namespace ${JSON.stringify(title)} exists; refusing to create a ` +
          `possible duplicate (KV titles are not account-unique).`,
      );
    }
    const parsedList = parseJsonArrayStrict(listResult.stdout);
    if (!parsedList) {
      throw new Error(
        `provision: "wrangler kv namespace list" did not return a JSON array; cannot verify whether ` +
          `KV namespace ${JSON.stringify(title)} exists. Refusing to create a possible duplicate.`,
      );
    }
    const matches = extractKvMatches(parsedList, title);
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
      if (created.status !== 0) {
        throw new Error(
          `provision: "wrangler kv namespace create ${title}" failed: ${created.stderr || created.stdout}`,
        );
      }
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
      if (info.status === 0) {
        // Exit 0 is not enough to adopt — the success payload must POSITIVELY
        // identify the requested bucket (its `name`) before we write the entry,
        // else a mismatched/garbled 0-exit payload could bind the wrong bucket.
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
      } else if (isBucketNotFoundError(info)) {
        // CONFIRMED not-found → create. `--update-config` upserts by binding.
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
        if (created.status !== 0) {
          throw new Error(
            `provision: "wrangler r2 bucket create ${bucketName}" failed: ${created.stderr || created.stdout}`,
          );
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
        if (created.status !== 0) {
          throw new Error(
            `provision: "wrangler hyperdrive create ${name}" failed: ${created.stderr || created.stdout}`,
          );
        }
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
    if (info.status === 0) {
      resources.push({ kind: 'queue', name, action: 'reused' });
      continue;
    }
    if (!isMissingResourceError(info)) {
      throw new Error(
        `provision: "wrangler queues info ${name}" failed: ${info.stderr || info.stdout}`,
      );
    }
    const created = runWrangler(['queues', 'create', name, '-c', configPath]);
    if (created.status !== 0) {
      throw new Error(
        `provision: "wrangler queues create ${name}" failed: ${created.stderr || created.stdout}`,
      );
    }
    resources.push({ kind: 'queue', name, action: 'created' });
  }

  // --- account_id ----------------------------------------------------------
  let accountIdWritten = false;
  if (opts?.accountId) {
    write({ accountId: opts.accountId });
    accountIdWritten = true;
  }

  return { resources, configPath, accountIdWritten };
}
