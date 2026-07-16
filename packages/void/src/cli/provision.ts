import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';
import { voidLog, voidWarn } from '../log.ts';
import { resolveWranglerCommand } from './preset.ts';
import { writeProvisionedWranglerConfig } from './wrangler.ts';

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
 * Seam over shelling out to the project's `wrangler`. The default
 * implementation ({@link createDefaultRunWrangler}) wraps `spawnSync`; unit
 * tests inject a stub so no real wrangler runs. `subcommand` is the part AFTER
 * `wrangler ` (e.g. `d1 list --json`).
 */
export type RunWrangler = (
  subcommand: string,
  opts?: { cwd?: string; captureJson?: boolean },
) => RunWranglerResult;

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
 * Default `runWrangler`: resolves the project-local wrangler via Task 2's
 * {@link resolveWranglerCommand} and runs it with `spawnSync`, capturing stdout
 * (for `--json` parsing) and stderr (for error/collision detection). Never
 * called in unit tests — those inject a stub.
 */
export function createDefaultRunWrangler(
  root: string,
  options?: { accountId?: string },
): RunWrangler {
  return (subcommand, opts) => {
    const command = resolveWranglerCommand(root, subcommand);
    const result = spawnSync(command, {
      cwd: opts?.cwd ?? root,
      shell: true,
      encoding: 'utf-8',
      env: provisionEnv(options?.accountId),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? (result.error ? 1 : 0),
    };
  };
}

/** Parse a wrangler `--json` stdout into an array, tolerating noise/failure. */
function parseJsonArray(stdout: string): Array<Record<string, unknown>> {
  const value = parseJsonLoose(stdout);
  return Array.isArray(value) ? (value.filter(isRecord) as Array<Record<string, unknown>>) : [];
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

/** Read + parse the root wrangler config (fresh each call — wrangler mutates it). */
function readRootConfig(rootWranglerPath: string): Record<string, unknown> {
  if (!existsSync(rootWranglerPath)) {
    return {};
  }
  const errors: Array<ParseError> = [];
  const parsed = parse(readFileSync(rootWranglerPath, 'utf-8'), errors, {
    allowTrailingComma: true,
  });
  return errors.length === 0 && isRecord(parsed) ? parsed : {};
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

/** `wrangler kv namespace list` → `[{ id, title }]`. */
function extractKvMatches(stdout: string, title: string): Array<{ id: string; title: string }> {
  return parseJsonArray(stdout)
    .filter((ns) => ns.title === title)
    .map((ns) => ({ id: String(ns.id ?? ''), title }))
    .filter((ns) => ns.id.length > 0);
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
 * Ensure every resource in `desired` exists in the user's own Cloudflare account,
 * creating the missing ones by shelling out to `wrangler` and letting
 * `wrangler <res> create --update-config` write real ids into the root config.
 * For resources that already exist (adopt path) — where `create` cannot run —
 * the real id is captured from `wrangler <res> list/info` and written through the
 * Task 3 writer's adopt fields. Pure provisioning: NO build, deploy, or
 * drift-check. Idempotent + read-first: a binding already pointing at a real id
 * is left untouched.
 */
export async function provisionCloudflareResources(
  root: string,
  rootWranglerPath: string,
  desired: DesiredResourceSet,
  opts?: {
    runWrangler?: RunWrangler;
    accountId?: string;
    log?: ProvisionLogger;
  },
): Promise<ProvisionResult> {
  await Promise.resolve();
  const runWrangler =
    opts?.runWrangler ?? createDefaultRunWrangler(root, { accountId: opts?.accountId });
  const log = opts?.log ?? defaultLogger;
  const resources: Array<ProvisionOutcome> = [];
  let configPath = rootWranglerPath;
  const write = (patch: Parameters<typeof writeProvisionedWranglerConfig>[1]): void => {
    configPath = writeProvisionedWranglerConfig(root, patch).configPath;
  };

  // --- D1 ------------------------------------------------------------------
  if (desired.d1) {
    const { binding, name } = desired.d1;
    const entry = findBindingEntry(readRootConfig(rootWranglerPath).d1_databases, binding);
    if (entry && isRealValue(entry.database_id)) {
      resources.push({ kind: 'd1', binding, name, action: 'reused', id: entry.database_id });
    } else {
      const existing = extractD1(
        parseJsonArray(runWrangler('d1 list --json', { captureJson: true }).stdout).find(
          (db) => db.name === name,
        ),
      );
      if (existing) {
        log.info(`adopted existing D1 database ${name} (${existing.id})`);
        write({
          d1: { binding, databaseName: name, databaseId: existing.id },
          d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR },
        });
        resources.push({ kind: 'd1', binding, name, action: 'adopted', id: existing.id });
      } else {
        const created = runWrangler(
          `d1 create ${name} --binding ${binding} --update-config -c ${rootWranglerPath}`,
        );
        if (created.status !== 0) {
          if (isAlreadyExistsError(created)) {
            // TOCTOU: created between our list and create (code 7502). Capture
            // the id via `d1 info` and adopt instead of failing.
            const info = extractD1(
              parseJsonObject(runWrangler(`d1 info ${name} --json`, { captureJson: true }).stdout),
            );
            if (!info) {
              throw new Error(
                `provision: "wrangler d1 create ${name}" reported the database already exists, ` +
                  `but its id could not be resolved via "wrangler d1 info ${name} --json".`,
              );
            }
            log.info(`adopted existing D1 database ${name} (${info.id})`);
            write({
              d1: { binding, databaseName: name, databaseId: info.id },
              d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR },
            });
            resources.push({ kind: 'd1', binding, name, action: 'adopted', id: info.id });
          } else {
            throw new Error(
              `provision: "wrangler d1 create ${name}" failed: ${created.stderr || created.stdout}`,
            );
          }
        } else {
          // wrangler wrote database_id/database_name via --update-config; fill
          // the migrations_dir it does not.
          write({ d1MigrationsDir: { binding, dir: D1_MIGRATIONS_DIR } });
          resources.push({ kind: 'd1', binding, name, action: 'created' });
        }
      }
    }
  }

  // --- KV ------------------------------------------------------------------
  for (const { binding, title } of desired.kvNamespaces) {
    const entry = findBindingEntry(readRootConfig(rootWranglerPath).kv_namespaces, binding);
    if (entry && isRealValue(entry.id)) {
      resources.push({ kind: 'kv', binding, name: title, action: 'reused', id: entry.id });
      continue;
    }
    const matches = extractKvMatches(
      runWrangler('kv namespace list', { captureJson: true }).stdout,
      title,
    );
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
      const created = runWrangler(
        `kv namespace create ${title} --binding ${binding} --update-config -c ${rootWranglerPath}`,
      );
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
    const entry = findBindingEntry(readRootConfig(rootWranglerPath).r2_buckets, binding);
    if (entry && isRealValue(entry.bucket_name)) {
      resources.push({ kind: 'r2', binding, name: bucketName, action: 'reused' });
    } else if (
      runWrangler(`r2 bucket info ${bucketName} --json`, { captureJson: true }).status === 0
    ) {
      // `wrangler r2 bucket list` is a human table, not JSON. Bucket names ARE
      // account-unique, so probe the single bucket by name: `r2 bucket info`
      // exits 0 only when the bucket exists (it throws a CF API error otherwise).
      // Adopt it — write the `{binding,bucket_name}` entry via the writer.
      log.info(`adopted existing R2 bucket ${bucketName}`);
      write({ r2: { binding, bucketName } });
      resources.push({ kind: 'r2', binding, name: bucketName, action: 'adopted' });
    } else {
      // Non-zero info → the bucket does not exist (or is unreachable); create it.
      // `r2 bucket create` on an already-existing name errors instead of silently
      // duplicating, so a transient info failure can never mint a second bucket —
      // the create surfaces the real problem. `--update-config` upserts by binding.
      const created = runWrangler(
        `r2 bucket create ${bucketName} --binding ${binding} --update-config -c ${rootWranglerPath}`,
      );
      if (created.status !== 0) {
        throw new Error(
          `provision: "wrangler r2 bucket create ${bucketName}" failed: ${created.stderr || created.stdout}`,
        );
      }
      resources.push({ kind: 'r2', binding, name: bucketName, action: 'created' });
    }
  }

  // --- Hyperdrive ----------------------------------------------------------
  // wrangler 4.107 has NO machine-readable Hyperdrive list (`hyperdrive list`
  // prints a cli-table3 box table; there is no `--json` and no get-by-NAME —
  // `hyperdrive get` takes an id). So account-list adoption is not reliably
  // possible; idempotency comes from read-first on the config (where the id
  // `wrangler hyperdrive create --update-config` wrote already lives) plus
  // create otherwise. The writer's `hyperdrive` adopt field stays available for
  // Task 6, which can supply a known id from its own preflight.
  if (desired.hyperdrive) {
    const { binding, name, connectionString } = desired.hyperdrive;
    const entry = findBindingEntry(readRootConfig(rootWranglerPath).hyperdrive, binding);
    if (entry && isRealValue(entry.id)) {
      resources.push({ kind: 'hyperdrive', binding, name, action: 'reused', id: entry.id });
    } else if (!connectionString) {
      // CI-safe: never prompt. Task 6/preflight is responsible for obtaining a
      // connection string; without one we cannot create the config.
      const reason = 'no connection string provided';
      log.warn(`skipping Hyperdrive config ${name}: ${reason}`);
      resources.push({ kind: 'hyperdrive', binding, name, action: 'skipped', reason });
    } else {
      const created = runWrangler(
        `hyperdrive create ${name} --connection-string=${connectionString} --binding ${binding} --update-config -c ${rootWranglerPath}`,
      );
      if (created.status !== 0) {
        throw new Error(
          `provision: "wrangler hyperdrive create ${name}" failed: ${created.stderr || created.stdout}`,
        );
      }
      resources.push({ kind: 'hyperdrive', binding, name, action: 'created' });
    }
  }

  // --- Queues (resource only; NEVER writes queue config entries) -----------
  // `wrangler queues list` is a human table, not JSON, and `queues create` has
  // no `--update-config`. So probe each queue by name: `queues info` exits
  // non-zero (`Queue "x" does not exist`) when absent. Task 4 only ensures the
  // queue RESOURCE exists — binding the producers/consumers into the config is
  // app-class-aware and belongs to Task 6.
  for (const name of desired.queues) {
    const info = runWrangler(`queues info ${name}`);
    if (info.status === 0) {
      resources.push({ kind: 'queue', name, action: 'reused' });
      continue;
    }
    if (!isMissingResourceError(info)) {
      throw new Error(
        `provision: "wrangler queues info ${name}" failed: ${info.stderr || info.stdout}`,
      );
    }
    const created = runWrangler(`queues create ${name}`);
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
