import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { confirm, intro, isCancel, outro, log } from '@clack/prompts';
import { extname, join, relative, resolve } from 'pathe';
import { readConfig, getDatabaseDialect, type DatabaseDialect } from '../config.ts';
import {
  collectMigrations,
  readJournal,
  stripSqlExt,
  writeJournal,
} from '../migrations/collect.ts';
import {
  assertJournalCoherence,
  listDrizzleArtifacts,
  validateMigrations,
} from '../migrations/validate.ts';
import { detectFramework } from '../plugin-inference.ts';
import { readProjectPaths } from '../project-paths.ts';
import type { SeedFn } from '../runtime/seed.ts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { DEFAULT_PROXY_URL, STAGING_PROXY_URL } from '../shared/proxy.ts';
import { getToken, isStagingMode } from './auth.ts';
import { PlatformApiError, PlatformClient } from './client.ts';
import type { DbArgs } from './db-args.ts';
import { formatTimestamp } from './gen.ts';
import { cliTitle, dim, pc } from './output.ts';
import { readProjectConfig } from './project.ts';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const DEFAULT_SEED_FILES = [
  'db/seed.ts',
  'db/seed.mts',
  'db/seed.js',
  'db/seed.mjs',
  'db/seed.sql',
];
const MODULE_SEED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

export function getLocalD1PersistRoot(root: string): string {
  const detected = detectFramework(root);
  return detected && (detected.class === 'b' || detected.class === 'c')
    ? join(root, '.wrangler', 'state')
    : join(root, '.void');
}

function runDrizzleKit(root: string, args: Array<string>): void {
  execFileSync(process.execPath, [drizzleKitBin, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
}

type SeedTarget = {
  displayPath: string;
  kind: 'module' | 'sql';
  path: string;
};

type PgClient = {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<{ rows: Array<T> }>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readEnvLocal(root: string): Record<string, string> {
  const envPath = join(root, '.env.local');
  if (!existsSync(envPath)) {
    return {};
  }
  const content = readFileSync(envPath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function getPgUrl(root: string): string {
  const vars = readEnvLocal(root);
  const url = vars.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL not found in .env.local. Add it to connect to your PostgreSQL database.',
    );
  }
  return url;
}

async function withPgClient<T>(root: string, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const url = getPgUrl(root);
  const { Client } = await import('pg');
  const client: PgClient = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function validatePendingMigrations(
  migrations: Array<{ name: string; sql: string }>,
  appliedNames: Set<string>,
): void {
  const pending = migrations.filter((migration) => !appliedNames.has(migration.name));
  if (pending.length === 0) {
    return;
  }
  validateMigrations(pending);
}

export async function runDbCommand(root: string, args: DbArgs): Promise<void> {
  console.log();
  intro(cliTitle('db'));

  const dialect = getDatabaseDialect(readConfig(root));

  if (args.action === 'push') {
    await runPush(root, dialect);
  } else if (args.action === 'generate') {
    await runGenerate(root, dialect);
  } else if (args.action === 'status') {
    await runStatus(root, dialect);
  } else if (args.action === 'reset') {
    await runReset(root, dialect);
  } else if (args.action === 'seed') {
    await runSeed(root, args.file, dialect);
  } else if (args.action === 'execute') {
    await runExecute(root, args.command, args.file, dialect, args.remote);
  } else if (args.action === 'migrate') {
    await runMigrate(root, dialect, args.remote);
  } else if (args.action === 'studio') {
    await runStudio(root, dialect, args.remote);
  } else if (args.action === 'set-url') {
    await runSetUrl(root);
  } else if (args.action === 'rename-migrations') {
    await runRenameMigrations(root, dialect);
  } else {
    await runExport(root, args, dialect);
  }
}

async function runPush(root: string, dialect: DatabaseDialect): Promise<void> {
  const { writeDrizzleConfig } = await import('../drizzle/config.ts');

  let configPath: string;
  if (dialect === 'postgresql') {
    const url = getPgUrl(root);
    configPath = writeDrizzleConfig(root, url, 'postgresql');
  } else {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { getMiniflareDatabasePath } = await import('../migrations/runner.ts');
    const persistRoot = getLocalD1PersistRoot(root);
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    mkdirSync(dirname(dbPath), { recursive: true });
    configPath = writeDrizzleConfig(root, dbPath);
  }

  try {
    runDrizzleKit(root, ['push', '--config', configPath]);
  } catch {
    process.exit(1);
  }
  outro('Done.');
}

async function runGenerate(root: string, dialect: DatabaseDialect): Promise<void> {
  const { writeDrizzleConfig } = await import('../drizzle/config.ts');

  const configPath =
    dialect === 'postgresql'
      ? writeDrizzleConfig(root, 'postgresql://dummy', 'postgresql')
      : writeDrizzleConfig(root, ':memory:');

  try {
    runDrizzleKit(root, ['generate', '--config', configPath]);
  } catch {
    process.exit(1);
  }
  outro('Done.');
}

async function runStatus(root: string, dialect: DatabaseDialect): Promise<void> {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const allMigrations = collectMigrations(migrationsDir);

  try {
    assertJournalCoherence(migrationsDir, allMigrations);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  if (allMigrations.length === 0) {
    log.info(`No migration files found in ${paths.sourceRelative('db/migrations')}/`);
    outro('Done.');
    return;
  }

  let localApplied: Array<{ name: string }>;
  if (dialect === 'postgresql') {
    try {
      localApplied = await withPgClient(root, async (client) => {
        try {
          const result = await client.query<{ name: string }>(
            'SELECT name FROM _void_migrations ORDER BY name',
          );
          return result.rows;
        } catch {
          return [];
        }
      });
    } catch {
      localApplied = [];
    }
  } else {
    const { getMiniflareDatabasePath, getAppliedMigrations } =
      await import('../migrations/runner.ts');
    const persistRoot = getLocalD1PersistRoot(root);
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    localApplied = await getAppliedMigrations(dbPath);
  }
  const localSet = new Set(localApplied.map((m) => m.name));

  // Try to get remote status
  let remoteApplied: Array<{ name: string; applied_at: string }> | null = null;
  const token = getToken(root);
  const config = readProjectConfig(root);
  if (token && config) {
    try {
      const client = new PlatformClient(token, { root });
      const result = await client.getMigrationStatus(config.projectId, dialect);
      remoteApplied = result.applied;
    } catch {
      // graceful degradation — remote unavailable
    }
  }

  const remoteSet = remoteApplied ? new Set(remoteApplied.map((m) => m.name)) : null;

  const lines: Array<string> = [];
  for (const migration of allMigrations) {
    const localStatus = localSet.has(migration.name) ? pc.green('applied') : pc.yellow('pending');

    let remotePart = '';
    if (remoteSet !== null) {
      const remoteStatus = remoteSet.has(migration.name)
        ? pc.green('applied')
        : pc.yellow('pending');
      remotePart = `  remote: ${remoteStatus}`;
    }

    lines.push(`  ${migration.name}  ${dim('local:')} ${localStatus}${remotePart}`);
  }

  log.info(lines.join('\n'));

  const localPending = allMigrations.length - localSet.size;
  const parts = [`${allMigrations.length} migration(s)`];
  if (localPending > 0) {
    parts.push(`${localPending} pending locally`);
  }
  if (remoteSet !== null) {
    const remotePending = allMigrations.length - remoteSet.size;
    if (remotePending > 0) {
      parts.push(`${remotePending} pending remotely`);
    }
  }
  outro(parts.join(', '));
}

async function resetDatabase(root: string, dialect: DatabaseDialect): Promise<number> {
  // Coherence check must happen before any destructive work. Route
  // failures through `log.error` + `process.exit(1)` instead of letting
  // malformed `_journal.json` bubble as a raw stack trace — this matches
  // `runStatus`, `runMigrate`, and the deploy path, and this is the exact
  // drift case the preflight is here to surface.
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const migrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, migrations);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  if (dialect === 'postgresql') {
    await withPgClient(root, async (client) => {
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const row of tables.rows) {
        await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }
    });
    if (migrations.length > 0) {
      await withPgClient(root, async (client) => {
        await client.query(
          `CREATE TABLE IF NOT EXISTS _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
        );
        for (const m of migrations) {
          await client.query('BEGIN');
          try {
            await client.query(m.sql);
            await client.query('INSERT INTO _void_migrations (name, applied_at) VALUES ($1, $2)', [
              m.name,
              new Date().toISOString(),
            ]);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
      });
    }
    return migrations.length;
  }

  const { getMiniflareDatabasePath, runMigrations } = await import('../migrations/runner.ts');
  const persistRoot = getLocalD1PersistRoot(root);
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });

  const applied = await runMigrations(migrationsDir, dbPath);
  return applied.length;
}

async function runReset(root: string, dialect: DatabaseDialect): Promise<void> {
  const count = await resetDatabase(root, dialect);
  log.success(`Database reset. Applied ${count} migration(s).`);
  if (dialect !== 'postgresql') {
    log.info(dim("Restart your dev server if it's running."));
  }
  outro('Done.');
}

async function runSeed(
  root: string,
  file: string | undefined,
  dialect: DatabaseDialect,
): Promise<void> {
  // Reset first (drop + re-run migrations)
  const migrationCount = await resetDatabase(root, dialect);
  log.step(`Reset database. Applied ${migrationCount} migration(s).`);

  const seed = resolveSeedTarget(root, file);

  if (seed.kind === 'sql') {
    const sql = readFileSync(seed.path, 'utf-8');

    if (dialect === 'postgresql') {
      await withPgClient(root, async (client) => {
        await client.query(sql);
      });
      log.success(`Seeded from ${seed.displayPath}.`);
      outro('Done.');
      return;
    }

    const { getMiniflareDatabasePath, openSqliteDatabase } =
      await import('../migrations/runner.ts');
    const persistRoot = getLocalD1PersistRoot(root);
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  } else {
    await runSeedModule(root, seed.path, dialect);
  }

  log.success(`Seeded from ${seed.displayPath}.`);
  log.info(dim("Restart your dev server if it's running."));
  outro('Done.');
}

/**
 * Returns true when the SQL is read-only (SELECT / EXPLAIN only).
 * Used to skip the destructive-statement safety prompt for safe queries.
 *
 * This is a fail-closed heuristic, not a real SQL parser:
 * - `WITH` (CTEs) is intentionally excluded: writable CTEs such as
 *   `WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted`
 *   are destructive but match a naive `WITH` prefix check. Users with
 *   read-only CTEs will see the safety prompt — minor friction, safe by default.
 * - Multi-statement SQL (`SELECT 1; DELETE FROM users`) is rejected: any `;`
 *   followed by non-whitespace content after stripping a trailing semicolon is
 *   treated as unsafe.
 * - Leading SQL comments are not stripped; `-- foo\nSELECT 1` will be flagged
 *   as destructive. This is a UX nuisance, not a safety hole.
 */
function isSafeStatement(sql: string): boolean {
  // Strip a single trailing semicolon/whitespace, then bail if any internal `;` remains.
  const stripped = sql.replace(/;\s*$/, '');
  if (stripped.includes(';')) {
    return false;
  }
  // Only SELECT/EXPLAIN prefixes are reliably safe without a parser.
  return /^\s*(SELECT|EXPLAIN)\b/i.test(stripped);
}

/**
 * Prompt the user to confirm a destructive remote query when running in a TTY.
 * Returns true if execution should proceed, false if it was cancelled.
 */
async function confirmDestructiveRemote(sql: string): Promise<boolean> {
  if (isSafeStatement(sql)) {
    return true;
  }
  if (!process.stdin.isTTY) {
    // --yes flag (skip prompt under a TTY) is intentionally not wired here — non-TTY already bypasses; --yes can be added in a follow-up if scripted-TTY callers need it.
    return true;
  }
  const ok = await confirm({
    message: 'This will run against your deployed database. Continue?',
  });
  if (isCancel(ok) || !ok) {
    return false;
  }
  return true;
}

async function runExecute(
  root: string,
  command: string | undefined,
  file: string | undefined,
  dialect: DatabaseDialect,
  remote?: boolean,
): Promise<void> {
  if (remote) {
    // Reject --file with --remote D1 before reading the file or prompting.
    if (dialect !== 'postgresql' && file) {
      log.error(
        '--file is not yet supported with --remote D1; pipe statements through stdin or run them one at a time.',
      );
      process.exit(1);
    }

    const sql = file ? readFileSync(join(root, file), 'utf-8') : command!;

    const token = getToken(root);
    if (!token) {
      log.error('Not logged in. Run `void auth login` first.');
      process.exit(1);
    }

    const projectConfig = readProjectConfig(root);
    if (!projectConfig) {
      log.error('No project linked. Run `void deploy` first or link a project.');
      process.exit(1);
    }

    const shouldProceed = await confirmDestructiveRemote(sql);
    if (!shouldProceed) {
      log.info('Cancelled.');
      process.exit(0);
    }

    if (dialect === 'postgresql') {
      // PG remote: fetch the connection string from the platform, then connect directly.
      const client = new PlatformClient(token, { root });
      let dbUrl: string;
      try {
        const result = await client.getDatabaseUrl(projectConfig.projectId);
        dbUrl = result.url;
      } catch (err) {
        if (err instanceof PlatformApiError && err.status === 404) {
          log.error(
            "This project's database URL isn't stored on the platform yet. Run `void db set-url` once to populate it, then retry.",
          );
          process.exit(1);
        }
        throw err;
      }

      const { Client } = await import('pg');
      const pgClient: PgClient = new Client({ connectionString: dbUrl });
      await pgClient.connect();
      try {
        const result = await pgClient.query(sql);
        if (result.rows && result.rows.length > 0) {
          printTable(result.rows);
        } else {
          log.success('Executed successfully.');
        }
      } finally {
        await pgClient.end();
      }
      outro('Done.');
      return;
    }

    // D1 remote: route through the platform proxy.
    const platformClient = new PlatformClient(token, { root });
    let binding = 'DB';
    try {
      const resources = await platformClient.getResources(projectConfig.projectId);
      // TODO: support --binding for projects with multiple D1 bindings (currently auto-selects the first).
      const d1Resource = resources.find((r) => r.type === 'd1');
      if (d1Resource) {
        binding = d1Resource.binding_name;
      }
    } catch {
      // Fall back to default binding 'DB' if resource discovery fails
    }

    const proxyUrl = isStagingMode(root) ? STAGING_PROXY_URL : DEFAULT_PROXY_URL;
    const res = await fetch(`${proxyUrl}/d1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...cfAccessHeaders(process.env),
      },
      body: JSON.stringify({
        projectId: projectConfig.projectId,
        binding,
        sql,
        params: [],
        method: 'all',
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      log.error(`db: Proxy request failed with ${res.status}: '${text}'.`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
      success?: boolean;
    };
    const rows = data.results ?? [];
    if (rows.length > 0) {
      printTable(rows);
    } else {
      log.success('Executed successfully.');
    }
    outro('Done.');
    return;
  }

  if (dialect === 'postgresql') {
    const sql = file ? readFileSync(join(root, file), 'utf-8') : command!;
    await withPgClient(root, async (client) => {
      const result = await client.query(sql);
      if (result.rows && result.rows.length > 0) {
        printTable(result.rows);
      } else {
        log.success('Executed successfully.');
      }
    });
    outro('Done.');
    return;
  }

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner.ts');
  const persistRoot = getLocalD1PersistRoot(root);
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  if (!existsSync(dbPath)) {
    log.error('No local database found. Run `void dev` first.');
    process.exit(1);
  }

  const sql = file ? readFileSync(join(root, file), 'utf-8') : command!;

  const db = await openSqliteDatabase(dbPath);
  try {
    const trimmed = sql.trimStart();
    if (/^SELECT\b/i.test(trimmed)) {
      const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        log.info('No rows returned.');
      } else {
        printTable(rows);
      }
    } else {
      db.exec(sql);
      log.success('Executed successfully.');
    }
  } finally {
    db.close();
  }
  outro('Done.');
}

function printTable(rows: Array<Record<string, unknown>>): void {
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) => {
    let max = col.length;
    for (const row of rows) {
      const len = String(row[col] ?? 'NULL').length;
      if (len > max) {
        max = len;
      }
    }
    return max;
  });

  const header = cols.map((col, columnIndex) => col.padEnd(widths[columnIndex])).join('  ');
  const separator = widths.map((width) => '─'.repeat(width)).join('──');
  const lines = [header, separator];
  for (const row of rows) {
    lines.push(
      cols
        .map((col, columnIndex) => String(row[col] ?? 'NULL').padEnd(widths[columnIndex]))
        .join('  '),
    );
  }
  console.log(lines.join('\n'));
}

async function runMigrate(root: string, dialect: DatabaseDialect, remote?: boolean): Promise<void> {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const rawMigrations = collectMigrations(migrationsDir);

  try {
    assertJournalCoherence(migrationsDir, rawMigrations);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  if (remote) {
    if (dialect === 'postgresql') {
      log.error(
        'db: `void db migrate --remote` is only supported for D1 projects. PostgreSQL remote migrations run during `void deploy` through the project Hyperdrive binding.',
      );
      process.exit(1);
    }

    const token = getToken(root);
    if (!token) {
      log.error('Not logged in. Run `void auth login` first.');
      process.exit(1);
    }

    const config = readProjectConfig(root);
    if (!config) {
      log.error('No project linked. Run `void deploy` first or link a project.');
      process.exit(1);
    }

    if (rawMigrations.length === 0) {
      log.info(`No migration files found in ${paths.sourceRelative('db/migrations')}/`);
      outro('Done.');
      return;
    }

    const client = new PlatformClient(token, { root });

    // Fetch remote applied set so we only validate and send pending migrations.
    // This is required — if we can't determine what's already applied, we must
    // abort rather than risk validating (and rejecting) already-applied migrations.
    let remoteApplied: Set<string>;
    try {
      const status = await client.getMigrationStatus(config.projectId, dialect);
      remoteApplied = new Set(status.applied.map((m) => m.name));
    } catch (err) {
      log.error(
        `db: Failed to fetch remote migration status: '${err instanceof Error ? err.message : String(err)}'.`,
      );
      process.exit(1);
    }

    const pendingMigrations = rawMigrations.filter((m) => !remoteApplied.has(m.name));
    if (pendingMigrations.length === 0) {
      log.info('Remote database is up to date.');
      outro('Done.');
      return;
    }

    try {
      validateMigrations(pendingMigrations);
    } catch (err: unknown) {
      log.error(getErrorMessage(err));
      process.exit(1);
    }

    const result = await client.applyRemoteMigrations(config.projectId, pendingMigrations);

    if (!result.ok) {
      log.error(
        result.error
          ? `db: Remote migration failed: '${result.error}'.`
          : 'db: Remote migration failed.',
      );
      process.exit(1);
    }

    if (result.applied.length === 0) {
      log.info('Remote database is up to date.');
    } else {
      for (const name of result.applied) {
        log.step(name);
      }
      log.success(`Applied ${result.applied.length} migration(s) to remote database.`);
    }
    for (const warning of result.warnings ?? []) {
      log.warn(warning);
    }
    outro('Done.');
    return;
  }

  if (dialect === 'postgresql') {
    const { applyPgMigrations } = await import('../migrations/runner-pg.ts');
    const applied = await withPgClient(root, async (client) => {
      let existingRows: Array<{ name: string }> = [];
      try {
        const result = await client.query<{ name: string }>('SELECT name FROM _void_migrations');
        existingRows = result.rows;
      } catch {
        existingRows = [];
      }

      try {
        validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
      } catch (err: unknown) {
        log.error(getErrorMessage(err));
        process.exit(1);
      }

      return applyPgMigrations(client, rawMigrations);
    });

    if (applied.length === 0) {
      log.info('All migrations are up to date.');
    } else {
      for (const name of applied) {
        log.step(name);
      }
      log.success(`Applied ${applied.length} migration(s).`);
    }
    outro('Done.');
    return;
  }

  const { getMiniflareDatabasePath, getAppliedMigrations, runMigrations } =
    await import('../migrations/runner.ts');
  const persistRoot = getLocalD1PersistRoot(root);
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  try {
    const existingRows = await getAppliedMigrations(dbPath);
    validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  const applied = await runMigrations(migrationsDir, dbPath);
  if (applied.length === 0) {
    log.info('All migrations are up to date.');
  } else {
    for (const name of applied) {
      log.step(name);
    }
    log.success(`Applied ${applied.length} migration(s).`);
    log.info(dim("Restart your dev server if it's running."));
  }
  outro('Done.');
}

async function runStudio(root: string, dialect: DatabaseDialect, remote?: boolean): Promise<void> {
  if (remote) {
    if (dialect !== 'postgresql') {
      log.error(
        'Remote D1 studio is not yet supported. Use `void db execute --remote` for ad-hoc queries against your deployed D1 database.',
      );
      process.exit(1);
    }

    // PG remote: fetch the connection URL from the platform, then open Studio against it.
    const token = getToken(root);
    if (!token) {
      log.error('Not logged in. Run `void auth login` first.');
      process.exit(1);
    }

    const projectConfig = readProjectConfig(root);
    if (!projectConfig) {
      log.error('No project linked. Run `void deploy` first or link a project.');
      process.exit(1);
    }

    const client = new PlatformClient(token, { root });
    let dbUrl: string;
    try {
      const result = await client.getDatabaseUrl(projectConfig.projectId);
      dbUrl = result.url;
    } catch (err) {
      if (err instanceof PlatformApiError && err.status === 404) {
        log.error(
          "This project's database URL isn't stored on the platform yet. Run `void db set-url` once to populate it, then retry.",
        );
        process.exit(1);
      }
      throw err;
    }

    const { writeDrizzleConfig } = await import('../drizzle/config.ts');
    const configPath = writeDrizzleConfig(root, dbUrl, 'postgresql');

    log.info('Opening Drizzle Studio (remote)...');
    try {
      runDrizzleKit(root, ['studio', '--config', configPath]);
    } catch {
      process.exit(1);
    }
    return;
  }

  if (dialect === 'postgresql') {
    const { writeDrizzleConfig } = await import('../drizzle/config.ts');
    const url = getPgUrl(root);
    const configPath = writeDrizzleConfig(root, url, 'postgresql');

    log.info('Opening Drizzle Studio...');
    try {
      runDrizzleKit(root, ['studio', '--config', configPath]);
    } catch {
      process.exit(1);
    }
    return;
  }

  const { writeDrizzleConfig } = await import('../drizzle/config.ts');
  const { getMiniflareDatabasePath } = await import('../migrations/runner.ts');

  const persistRoot = getLocalD1PersistRoot(root);
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  if (!existsSync(dbPath)) {
    log.error('No local database found. Run `void dev` first.');
    process.exit(1);
  }

  const configPath = writeDrizzleConfig(root, dbPath);

  log.info('Opening Drizzle Studio...');
  try {
    runDrizzleKit(root, ['studio', '--config', configPath]);
  } catch {
    process.exit(1);
  }
}

async function runRenameMigrations(root: string, dialect: DatabaseDialect): Promise<void> {
  const migrationsDir = readProjectPaths(root).migrationsDir;
  if (!existsSync(migrationsDir)) {
    log.info('No migrations directory found.');
    outro('Done.');
    return;
  }

  // Drift / partial-state gate. Mirrors the preflight used by `runStatus`,
  // `runMigrate`, and `runReset` — one shared helper, one source of truth.
  // Run BEFORE the bundled-mode guard and BEFORE computing files or
  // touching anything remote, so a project in a partial drizzle-kit state
  // (missing journal + leftover snapshots/`migrations.js`) or a project
  // whose journal tags don't line up with its `.sql` files gets refused
  // with the same message the rest of the CLI emits. Bare-legacy (no
  // journal, no artifacts) silently passes through — those projects are
  // the entire reason `rename-migrations` exists, and the journal/snapshot
  // mutation steps below are already no-ops on that shape.
  const currentMigrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, currentMigrations);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  // Refuse bundled-mode projects up front. A bundled project has a valid
  // `_journal.json` AND a sibling `db/migrations/migrations.js` that
  // statically imports every `.sql` file by filename. Renaming the files
  // here would leave `migrations.js` pointing at nonexistent imports, so
  // the next bundled migration run blows up at module resolution.
  // Drizzle-kit owns the bundle format (import paths, padding, trailing
  // comma) — replicating its emit here would silently break whenever
  // drizzle-kit bumps that format. Fail fast with a concrete recovery path
  // instead.
  if (existsSync(join(migrationsDir, 'migrations.js'))) {
    log.error(
      "This project uses Drizzle's bundled migration format (db/migrations/migrations.js).\n" +
        '`void db rename-migrations` cannot rename migrations in bundled mode because\n' +
        '`migrations.js` contains static imports of the SQL files by filename.\n\n' +
        'Delete db/migrations/migrations.js and re-run `void db generate` to migrate away\n' +
        'from bundled mode, then retry `void db rename-migrations`.',
    );
    process.exit(1);
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort();

  const oldStyleFiles = files.filter((f) => /^\d{1,4}_/.test(f));
  if (oldStyleFiles.length === 0) {
    log.info('No migrations with numeric prefixes found. Nothing to rename.');
    outro('Done.');
    return;
  }

  // Find the earliest existing timestamp-prefixed migration so renamed files sort before them
  const timestampFiles = files.filter((f) => /^\d{14}_/.test(f));
  const formatTs = formatTimestamp;

  let baseTime: Date;
  if (timestampFiles.length > 0) {
    // Parse the earliest timestamp (always UTC) and place renamed files before it
    const earliest = timestampFiles[0].slice(0, 14);
    const year = +earliest.slice(0, 4);
    const monthIndex = +earliest.slice(4, 6) - 1;
    const day = +earliest.slice(6, 8);
    const hour = +earliest.slice(8, 10);
    const minute = +earliest.slice(10, 12);
    const second = +earliest.slice(12, 14);
    baseTime = new Date(
      Date.UTC(year, monthIndex, day, hour, minute, second - oldStyleFiles.length),
    );
  } else {
    baseTime = new Date(Date.now() - oldStyleFiles.length * 1000);
  }

  const renames: Array<{ from: string; to: string }> = [];
  for (let fileIndex = 0; fileIndex < oldStyleFiles.length; fileIndex++) {
    const oldName = oldStyleFiles[fileIndex];
    const description = oldName.replace(/^\d+_/, '');
    const ts = new Date(baseTime.getTime() + fileIndex * 1000);
    const newName = `${formatTs(ts)}_${description}`;
    renames.push({ from: oldName, to: newName });
  }

  // Snapshot the raw journal bytes BEFORE the remote rename and BEFORE
  // the snapshot preflight gate. Two reasons:
  //   1. The preflight below uses `originalJournalBytes !== null` as
  //      the "journal-backed project" signal, so it must be captured
  //      first.
  //   2. `restoreJournal` (defined further down) needs the pre-run
  //      bytes to byte-restore after a rollback — capturing them here
  //      guarantees we have the state from before ANY mutation.
  // Legacy projects have no journal at all — `originalJournalBytes` stays
  // `null` and `restoreJournal` becomes a no-op in that mode.
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  const originalJournalBytes: Buffer | null = existsSync(journalPath)
    ? readFileSync(journalPath)
    : null;

  // Drizzle-kit locates snapshot files by splitting the journal tag on the
  // first underscore and appending `_snapshot.json`. When we rewrite tags,
  // we must rename the matching snapshot alongside the .sql file so
  // rollback/drop tooling keeps working. The old tag prefix is the numeric
  // `NNNN` chunk before the first underscore; the new prefix is the
  // 14-digit timestamp. Legacy projects without snapshots are skipped.
  // These helpers are hoisted above the remote rename because the
  // snapshot preflight below needs `snapshotPathFor` / `snapshotPrefix`.
  const metaDir = join(migrationsDir, 'meta');
  const snapshotPrefix = (tag: string): string => tag.split('_')[0];
  const snapshotPathFor = (tag: string): string =>
    join(metaDir, `${snapshotPrefix(tag)}_snapshot.json`);

  // Round 29 gate: if this is a journal-backed project, every tag we're
  // about to rename MUST have its matching snapshot on disk. The rename
  // loop below silently skips missing snapshots so bare-legacy projects
  // (no journal, no snapshots at all) keep working — but a journal-backed
  // project with a missing snapshot is a partial state. Proceeding would
  // rename the .sql + journal entry to the new tag, then the next
  // `void gen migration` (custom-migration path) or `void db generate`
  // would be unable to locate the expected snapshot under the new
  // filename. Refuse up front with a concrete recovery path.
  //
  // Round 30 refinement: the "journal file exists on disk" signal
  // (`originalJournalBytes !== null`) is not enough on its own. The
  // kitchen-sink playground ships a placeholder journal of the form
  // `{ "version": "7", "dialect": "sqlite", "entries": [] }` with no
  // `meta/*_snapshot.json` files and no bundled `migrations.js`.
  // `assertJournalCoherence` treats that exact shape as identical to
  // "bare-legacy, no journal at all" and lets `void db status`, `migrate`,
  // `reset`, and `deploy` fall through to the filename-based runner. The
  // gate below must honor the same equivalence — otherwise
  // `rename-migrations` rejects the playground outright, even though
  // there is no snapshot chain to worry about. The
  // `entries: [] + drizzle artifacts on disk` partial state is a real
  // shape but `assertJournalCoherence` already rejected it long before
  // this gate runs, so we don't need to re-handle it here.
  //
  // Order of operations note: this gate MUST run BEFORE
  // `client.renameMigrations` below. Running it after the remote call
  // means a failed gate leaves the remote mutated while the local
  // filesystem is untouched; the best-effort `reverseRemote()` rollback
  // can then fail on a transient network error and leave the project in
  // divergent state that's hard to recover from. Running it up front
  // guarantees "remote is mutated only after the local preflight
  // passes," so there is nothing to reverse when the gate bails.
  const preRenameJournal = readJournal(migrationsDir);
  const drizzleArtifacts = listDrizzleArtifacts(migrationsDir);
  const isBareLegacyPlaceholder =
    preRenameJournal !== undefined &&
    preRenameJournal !== null &&
    typeof preRenameJournal === 'object' &&
    Array.isArray((preRenameJournal as { entries?: unknown }).entries) &&
    (preRenameJournal as { entries: Array<unknown> }).entries.length === 0 &&
    drizzleArtifacts.length === 0;

  if (originalJournalBytes !== null && !isBareLegacyPlaceholder) {
    const missingSnapshots: Array<string> = [];
    for (const { from } of renames) {
      const fromTag = stripSqlExt(from);
      const snapshotFrom = snapshotPathFor(fromTag);
      if (!existsSync(snapshotFrom)) {
        missingSnapshots.push(`meta/${snapshotPrefix(fromTag)}_snapshot.json`);
      }
    }
    if (missingSnapshots.length > 0) {
      log.error(
        'db: Cannot rename migrations because one or more Drizzle snapshot files are missing:',
      );
      for (const p of missingSnapshots) {
        log.error(`  - db/migrations/${p}`);
      }
      log.error(
        '\nRestore the missing snapshot(s) from version control, or reset the migration directory with `void db generate`, then retry.',
      );
      // No reverseRemote() here — the remote has not been touched yet.
      process.exit(1);
    }
  }

  // Update remote tracking — the snapshot preflight above has already
  // verified that the local filesystem is in a state we can safely
  // mutate. If this fails, nothing local has changed yet.
  const token = getToken(root);
  const config = readProjectConfig(root);
  let remoteRenamed = false;
  if (config && !token) {
    log.error(
      'Project is linked but you are not logged in.\n' +
        'Run `void auth login` first so remote migration records can be updated.',
    );
    process.exit(1);
  }
  if (token && config) {
    try {
      const client = new PlatformClient(token, { root });
      await client.renameMigrations(config.projectId, renames);
      remoteRenamed = true;
      log.info('Remote migration records updated.');
    } catch (err) {
      log.error(
        'db: Failed to update remote migration records. No local changes were made.\n' +
          'Fix the connection and run `void db rename-migrations` again.',
      );
      log.error(String(err));
      process.exit(1);
    }
  }

  // Best-effort reversal of remote renames when a later step fails
  const reverseRemote = async () => {
    if (!remoteRenamed || !token || !config) {
      return;
    }
    try {
      const client = new PlatformClient(token, { root });
      const reversed = renames.map(({ from, to }) => ({ from: to, to: from }));
      await client.renameMigrations(config.projectId, reversed);
    } catch {
      log.warn('db: Could not reverse remote rename. Run `void deploy` to sync remote records.');
    }
  };

  // Tracks whether `_journal.json` was actually rewritten below, so
  // `restoreJournal` knows when a byte-restore is needed on rollback.
  // `originalJournalBytes` was captured above (before the remote call).
  let journalRewritten = false;

  const restoreJournal = () => {
    // Byte-restore the pre-run snapshot. No-op when nothing was rewritten
    // or when no journal existed before the run (legacy path).
    if (!journalRewritten || originalJournalBytes === null) {
      return;
    }
    try {
      writeFileSync(journalPath, originalJournalBytes);
    } catch (err) {
      log.warn(
        'Could not restore db/migrations/meta/_journal.json after rollback. ' +
          'The journal may be in a partial state.\n' +
          'Regenerate it with `void db generate`, or restore it from version control.',
      );
      log.warn(String(err));
    }
  };

  // Rename files — roll back completed renames (and remote) on any failure
  const renamed: Array<{ from: string; to: string }> = [];
  // Parallel list tracking snapshot renames so rollback can reverse them
  // with the same best-effort semantics as the .sql file renames.
  const renamedSnapshots: Array<{ from: string; to: string }> = [];

  const reverseSnapshotRenames = () => {
    for (const { from, to } of renamedSnapshots) {
      try {
        renameSync(to, from);
      } catch (err) {
        // best-effort rollback — warn but don't fail
        log.warn(
          `db: Could not reverse snapshot rename for '${from}'. ` +
            'The meta/ directory may be in a partial state.',
        );
        log.warn(String(err));
      }
    }
  };

  try {
    for (const { from, to } of renames) {
      renameSync(join(migrationsDir, from), join(migrationsDir, to));
      renamed.push({ from, to });
      log.step(`${from} → ${to}`);

      // Mirror the SQL rename onto the Drizzle snapshot when one exists.
      const fromTag = stripSqlExt(from);
      const toTag = stripSqlExt(to);
      const snapshotFrom = snapshotPathFor(fromTag);
      const snapshotTo = snapshotPathFor(toTag);
      if (existsSync(snapshotFrom)) {
        renameSync(snapshotFrom, snapshotTo);
        renamedSnapshots.push({ from: snapshotFrom, to: snapshotTo });
      }
    }
  } catch (err) {
    reverseSnapshotRenames();
    for (const { from, to } of renamed) {
      try {
        renameSync(join(migrationsDir, to), join(migrationsDir, from));
      } catch {
        // best-effort rollback
      }
    }
    restoreJournal();
    await reverseRemote();
    log.error('db: Failed to rename migration files. All changes have been reverted.');
    log.error(String(err));
    process.exit(1);
  }

  // Rewrite `_journal.json` tags to match the new filenames BEFORE touching
  // the tracking tables, so any tracking-table failure can roll the journal
  // back alongside the file renames. Legacy projects with no journal skip
  // this step entirely — there's nothing to rewrite, and the snapshot/
  // tracking rollback sites already no-op via `journalRewritten === false`.
  if (originalJournalBytes !== null) {
    try {
      const journal = readJournal(migrationsDir);
      if (!journal) {
        // The journal existed when we snapshotted its bytes above but has
        // since disappeared or become unreadable. Treat this as a hard
        // failure so the rename flow rolls back rather than silently
        // losing journal coherence.
        throw new Error(
          'db: db/migrations/meta/_journal.json disappeared mid-run. File renames will be reverted.',
        );
      }
      const renameMap = new Map<string, string>();
      for (const { from, to } of renames) {
        renameMap.set(stripSqlExt(from), stripSqlExt(to));
      }
      const updatedEntries = journal.entries.map((entry) => {
        const next = renameMap.get(entry.tag);
        return next ? { ...entry, tag: next } : entry;
      });
      // Mark the journal as mutated BEFORE the write, so rollback will
      // byte-restore the snapshot even if `writeJournal` fails mid-write
      // (disk full, EIO, process killed). The flag's semantic is "a
      // mutation was attempted," which is what rollback correctness needs.
      journalRewritten = true;
      writeJournal(migrationsDir, {
        version: journal.version,
        dialect: journal.dialect,
        entries: updatedEntries,
      });
    } catch (err) {
      // Revert file renames so journal and filenames stay in sync
      reverseSnapshotRenames();
      for (const { from, to } of renames) {
        try {
          renameSync(join(migrationsDir, to), join(migrationsDir, from));
        } catch {
          // best-effort rollback
        }
      }
      restoreJournal();
      await reverseRemote();
      log.error(
        'db: Failed to update db/migrations/meta/_journal.json. File renames have been reverted.',
      );
      log.error(String(err));
      process.exit(1);
    }
  }

  if (dialect === 'postgresql') {
    try {
      await withPgClient(root, async (client) => {
        const tableCheck = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = '_void_migrations' LIMIT 1`,
        );
        if (tableCheck.rows.length === 0) {
          return;
        }
        await client.query('BEGIN');
        try {
          for (const { from, to } of renames) {
            await client.query('UPDATE _void_migrations SET name = $1 WHERE name = $2', [to, from]);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
    } catch (err) {
      // Roll back file renames so tracking and filenames stay in sync
      reverseSnapshotRenames();
      for (const { from, to } of renames) {
        try {
          renameSync(join(migrationsDir, to), join(migrationsDir, from));
        } catch {
          // best-effort rollback — ignore individual rename failures
        }
      }
      restoreJournal();
      await reverseRemote();
      log.error(
        'db: Failed to update PostgreSQL tracking table. File renames have been reverted.\n' +
          'Fix the database connection and run `void db rename-migrations` again.',
      );
      log.error(String(err));
      process.exit(1);
    }
  } else {
    const { getMiniflareDatabasePath, openSqliteDatabase } =
      await import('../migrations/runner.ts');
    const persistRoot = getLocalD1PersistRoot(root);
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    if (existsSync(dbPath)) {
      try {
        const db = await openSqliteDatabase(dbPath);
        try {
          const hasNew = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='_void_migrations'",
            )
            .get();
          const hasLegacy = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
            .get();
          const tableName = hasNew ? '_void_migrations' : hasLegacy ? '_migrations' : null;
          if (tableName) {
            const updateStmt = db.prepare(`UPDATE ${tableName} SET name = ? WHERE name = ?`);
            const applyRenames = db.transaction(() => {
              for (const { from, to } of renames) {
                updateStmt.run(to, from);
              }
            });
            applyRenames();
          }
        } finally {
          db.close();
        }
      } catch (err) {
        // Roll back file renames so tracking and filenames stay in sync
        reverseSnapshotRenames();
        for (const { from, to } of renames) {
          try {
            renameSync(join(migrationsDir, to), join(migrationsDir, from));
          } catch {
            // best-effort rollback — ignore individual rename failures
          }
        }
        restoreJournal();
        await reverseRemote();
        log.error(
          'db: Failed to update SQLite tracking table. File renames have been reverted.\n' +
            'Fix the database issue and run `void db rename-migrations` again.',
        );
        log.error(String(err));
        process.exit(1);
      }
    }
  }

  log.success(`Renamed ${renames.length} migration(s) to timestamp format.`);
  outro('Done.');
}

async function runExport(
  root: string,
  args: { output?: string; noData?: boolean; noSchema?: boolean; table?: string },
  dialect: DatabaseDialect,
): Promise<void> {
  if (dialect === 'postgresql') {
    const parts: Array<string> = [];
    await withPgClient(root, async (client) => {
      let tables: Array<string>;
      if (args.table) {
        const check = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
          [args.table],
        );
        if (check.rows.length === 0) {
          log.error(`db: Table '${args.table}' not found.`);
          process.exit(1);
        }
        tables = [args.table];
      } else {
        const result = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_%' ORDER BY tablename",
        );
        tables = result.rows.map((row) => String(row.tablename));
      }

      for (const table of tables) {
        if (!args.noSchema) {
          // Get CREATE TABLE statement (simplified — pg_dump would be more complete)
          const cols = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
            [table],
          );
          const colDefs = cols.rows.map((column) => {
            let def = `  "${String(column.column_name)}" ${String(column.data_type)}`;
            if (column.is_nullable === 'NO') {
              def += ' NOT NULL';
            }
            if (column.column_default) {
              def += ` DEFAULT ${String(column.column_default)}`;
            }
            return def;
          });
          parts.push(`CREATE TABLE "${table}" (\n${colDefs.join(',\n')}\n);`);
        }

        if (!args.noData) {
          const rows = await client.query(`SELECT * FROM "${table}"`);
          for (const row of rows.rows) {
            const cols = Object.keys(row);
            const vals = cols.map((column) => {
              const value = row[column];
              if (value === null) {
                return 'NULL';
              }
              if (typeof value === 'number') {
                return String(value);
              }
              return `'${String(value).replace(/'/g, "''")}'`;
            });
            parts.push(`INSERT INTO "${table}" (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
          }
        }
        parts.push('');
      }
    });

    const output = parts.join('\n');
    if (args.output) {
      writeFileSync(join(root, args.output), output);
      log.success(`Exported to ${args.output}`);
      outro('Done.');
    } else {
      process.stdout.write(output);
    }
    return;
  }

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner.ts');
  const persistRoot = getLocalD1PersistRoot(root);
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  if (!existsSync(dbPath)) {
    log.error('No local database found. Run `void dev` first.');
    process.exit(1);
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });
  try {
    let tables: Array<string>;
    if (args.table) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(args.table);
      if (!exists) {
        log.error(`db: Table '${args.table}' not found.`);
        process.exit(1);
      }
      tables = [args.table];
    } else {
      tables = db
        .prepare<{ name: unknown }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    }

    const parts: Array<string> = [];

    for (const table of tables) {
      if (!args.noSchema) {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) as { sql: string };
        parts.push(row.sql + ';');
      }

      if (!args.noData) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map((column) => {
            const value = row[column];
            if (value === null) {
              return 'NULL';
            }
            if (typeof value === 'number') {
              return String(value);
            }
            return `'${String(value).replace(/'/g, "''")}'`;
          });
          parts.push(`INSERT INTO "${table}" (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
        }
      }

      parts.push('');
    }

    const output = parts.join('\n');

    if (args.output) {
      writeFileSync(join(root, args.output), output);
      log.success(`Exported to ${args.output}`);
      outro('Done.');
    } else {
      // Print raw SQL to stdout for piping — no clack formatting
      process.stdout.write(output);
    }
  } finally {
    db.close();
  }
}

async function runSetUrl(root: string): Promise<void> {
  const { readConfig: readVoidConfig, getDatabaseDialect: getDialect } =
    await import('../config.ts');
  const config = readVoidConfig(root);
  const dialect = getDialect(config);

  if (dialect !== 'postgresql') {
    log.error(
      'db: This command is only for PostgreSQL projects. Set "database": "pg" in void.json.',
    );
    process.exit(1);
  }

  const token = getToken(root);
  if (!token) {
    log.error('No auth token found. Run `void auth login` first.');
    process.exit(1);
  }

  const projectConfig = readProjectConfig(root);
  if (!projectConfig) {
    log.error('No project linked. Run `void deploy` first or link a project.');
    process.exit(1);
  }

  const { text: promptText, isCancel: isCancelCheck } = await import('@clack/prompts');

  const connectionString = await promptText({
    message: 'Enter your PostgreSQL connection string:',
    placeholder: 'postgresql://user:pass@host:5432/dbname',
    validate(value = '') {
      if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
        return 'Connection string must start with "postgres://" or "postgresql://"';
      }
    },
  });

  if (isCancelCheck(connectionString)) {
    process.exit(0);
  }

  const client = new PlatformClient(token, { root });
  await client.setDatabaseUrl(projectConfig.projectId, connectionString as string);

  log.success('Database URL updated.');
  outro('Done.');
}

function resolveSeedTarget(root: string, file: string | undefined): SeedTarget {
  if (file) {
    return toSeedTarget(root, resolve(root, file), file);
  }

  const paths = readProjectPaths(root);
  const defaults = DEFAULT_SEED_FILES.map((candidate) => paths.sourceRelative(candidate)).filter(
    (candidate) => existsSync(join(root, candidate)),
  );
  if (defaults.length === 0) {
    log.error(
      `db: No seed file found. Create one of: ${DEFAULT_SEED_FILES.map((candidate) => paths.sourceRelative(candidate)).join(', ')} or pass --file <path>.`,
    );
    process.exit(1);
  }

  if (defaults.length > 1) {
    log.error(
      `db: Multiple default seed files found: ${defaults.join(', ')}. Use --file <path> to choose one.`,
    );
    process.exit(1);
  }

  const [seedPath] = defaults;
  return toSeedTarget(root, join(root, seedPath), seedPath);
}

function toSeedTarget(root: string, seedPath: string, displayPath?: string): SeedTarget {
  if (!existsSync(seedPath)) {
    log.error(`db: Seed file '${seedPath}' not found.`);
    process.exit(1);
  }

  const ext = extname(seedPath);
  const normalizedDisplay = (displayPath ?? relative(root, seedPath)).replaceAll('\\', '/');
  if (ext === '.sql') {
    return { path: seedPath, displayPath: normalizedDisplay, kind: 'sql' };
  }
  if (MODULE_SEED_EXTENSIONS.has(ext)) {
    return { path: seedPath, displayPath: normalizedDisplay, kind: 'module' };
  }

  log.error(`db: Unsupported seed file '${normalizedDisplay}'. Use .sql, .ts, .mts, .js, or .mjs.`);
  process.exit(1);
}

async function runSeedModule(
  root: string,
  seedPath: string,
  dialect: DatabaseDialect,
): Promise<void> {
  const seed = await loadSeedFunction(seedPath);
  const schema = await loadSeedSchema(root);

  if (dialect === 'postgresql') {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    await withPgClient(root, async (client) => {
      const options = getDrizzleSchemaOptions(schema);
      const drizzleClient = client as never;
      const db = options ? drizzle(drizzleClient, options) : drizzle(drizzleClient);
      await seed({ dialect, db, schema });
    });
    return;
  }

  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner.ts');
  const persistRoot = getLocalD1PersistRoot(root);
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
  const sqlite = await openSqliteDatabase(dbPath);
  try {
    const options = getDrizzleSchemaOptions(schema);
    const db = options ? drizzle(sqlite as never, options) : drizzle(sqlite as never);
    await seed({ dialect, db, schema });
  } finally {
    sqlite.close();
  }
}

async function loadSeedFunction(seedPath: string): Promise<SeedFn<Record<string, unknown>>> {
  const mod = await importLocalModule(seedPath);
  const seed =
    typeof mod.default === 'function'
      ? mod.default
      : typeof mod.seed === 'function'
        ? mod.seed
        : undefined;
  if (!seed) {
    throw new Error(
      `db: Seed module '${seedPath}' must export a default function or a named "seed" function.`,
    );
  }
  return seed as SeedFn<Record<string, unknown>>;
}

async function loadSeedSchema(root: string): Promise<Record<string, unknown>> {
  const { discoverSchema } = await import('../drizzle/discover.ts');
  const paths = readProjectPaths(root);
  const location = discoverSchema(root, paths);
  if (!location) {
    return {};
  }

  if (location.type === 'file') {
    const mod = await importLocalModule(location.path);
    return Object.fromEntries(
      Object.entries(mod).filter(([name]) => name !== 'default' && name !== '__esModule'),
    );
  }

  const files = collectSchemaModuleFiles(location.path);
  const parts = await Promise.all(files.map((file) => importLocalModule(file)));
  return Object.assign(
    {},
    ...parts.map((mod) =>
      Object.fromEntries(Object.entries(mod).filter(([name]) => name !== 'default')),
    ),
  );
}

function collectSchemaModuleFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSchemaModuleFiles(fullPath));
      continue;
    }
    if (
      MODULE_SEED_EXTENSIONS.has(extname(entry.name)) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.d.mts')
    ) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function importLocalModule(modulePath: string): Promise<Record<string, unknown>> {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

function getDrizzleSchemaOptions(
  schema: Record<string, unknown>,
): { schema: Record<string, unknown> } | undefined {
  return Object.keys(schema).length > 0 ? { schema } : undefined;
}
