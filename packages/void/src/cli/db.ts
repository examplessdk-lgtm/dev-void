import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { intro, outro, log } from '@clack/prompts';
import { readConfig, getDatabaseDialect, type DatabaseDialect } from '../config';
import { collectMigrations } from '../migrations/collect';
import { validateMigrations } from '../migrations/validate';
import type { SeedFn } from '../runtime/seed';
import { getToken } from './auth';
import { PlatformClient } from './client';
import type { DbArgs } from './db-args';
import { cliTitle, dim, pc } from './output';
import { readProjectConfig } from './project';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const DEFAULT_SEED_FILES = [
  'db/seed.ts',
  'db/seed.mts',
  'db/seed.js',
  'db/seed.mjs',
  'db/seed.sql',
];
const MODULE_SEED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

type SeedTarget = {
  displayPath: string;
  kind: 'module' | 'sql';
  path: string;
};

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

async function withPgClient<T>(root: string, fn: (client: any) => Promise<T>): Promise<T> {
  const url = getPgUrl(root);
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function validatePendingMigrations(
  migrations: { name: string; sql: string }[],
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
    await runExecute(root, args.command, args.file, dialect);
  } else if (args.action === 'migrate') {
    await runMigrate(root, dialect, args.remote);
  } else if (args.action === 'studio') {
    await runStudio(root, dialect);
  } else if (args.action === 'set-url') {
    await runSetUrl(root);
  } else if (args.action === 'rename-migrations') {
    await runRenameMigrations(root, dialect);
  } else {
    await runExport(root, args, dialect);
  }
}

async function runPush(root: string, dialect: DatabaseDialect): Promise<void> {
  const { execSync } = await import('node:child_process');
  const { writeDrizzleConfig } = await import('../drizzle/config');

  let configPath: string;
  if (dialect === 'postgresql') {
    const url = getPgUrl(root);
    configPath = writeDrizzleConfig(root, url, 'postgresql');
  } else {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { getMiniflareDatabasePath } = await import('../migrations/runner');
    const persistRoot = join(root, '.void');
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    mkdirSync(dirname(dbPath), { recursive: true });
    configPath = writeDrizzleConfig(root, dbPath);
  }

  try {
    execSync(`node ${drizzleKitBin} push --config ${configPath}`, {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }
  outro('Done.');
}

async function runGenerate(root: string, dialect: DatabaseDialect): Promise<void> {
  const { execSync } = await import('node:child_process');
  const { writeDrizzleConfig } = await import('../drizzle/config');

  const configPath =
    dialect === 'postgresql'
      ? writeDrizzleConfig(root, 'postgresql://dummy', 'postgresql')
      : writeDrizzleConfig(root, ':memory:');

  try {
    execSync(`node ${drizzleKitBin} generate --config ${configPath}`, {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }
  outro('Done.');
}

async function runStatus(root: string, dialect: DatabaseDialect): Promise<void> {
  const migrationsDir = join(root, 'db', 'migrations');
  const { collectMigrations } = await import('../migrations/collect');
  const allMigrations = collectMigrations(migrationsDir);

  if (allMigrations.length === 0) {
    log.info('No migration files found in db/migrations/');
    outro('Done.');
    return;
  }

  let localApplied: { name: string }[];
  if (dialect === 'postgresql') {
    try {
      localApplied = await withPgClient(root, async (client) => {
        try {
          const result = await client.query('SELECT name FROM _void_migrations ORDER BY name');
          return result.rows;
        } catch {
          return [];
        }
      });
    } catch {
      localApplied = [];
    }
  } else {
    const { getMiniflareDatabasePath, getAppliedMigrations } = await import('../migrations/runner');
    const persistRoot = join(root, '.void');
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    localApplied = await getAppliedMigrations(dbPath);
  }
  const localSet = new Set(localApplied.map((m) => m.name));

  // Try to get remote status
  let remoteApplied: { name: string; applied_at: string }[] | null = null;
  const token = getToken();
  const config = readProjectConfig(root);
  if (token && config) {
    try {
      const client = new PlatformClient(token);
      const result = await client.getMigrationStatus(config.projectId);
      remoteApplied = result.applied;
    } catch {
      // graceful degradation — remote unavailable
    }
  }

  const remoteSet = remoteApplied ? new Set(remoteApplied.map((m) => m.name)) : null;

  const lines: string[] = [];
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
  if (dialect === 'postgresql') {
    await withPgClient(root, async (client) => {
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const row of tables.rows) {
        await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }
    });
    const migrationsDir = join(root, 'db', 'migrations');
    const { collectMigrations } = await import('../migrations/collect');
    const migrations = collectMigrations(migrationsDir);
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

  const { getMiniflareDatabasePath, runMigrations } = await import('../migrations/runner');
  const persistRoot = join(root, '.void');
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });

  const migrationsDir = join(root, 'db', 'migrations');
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

    const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner');
    const persistRoot = join(root, '.void');
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

async function runExecute(
  root: string,
  command: string | undefined,
  file: string | undefined,
  dialect: DatabaseDialect,
): Promise<void> {
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

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner');
  const persistRoot = join(root, '.void');
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
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
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

function printTable(rows: Record<string, unknown>[]): void {
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

  const header = cols.map((col, i) => col.padEnd(widths[i])).join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('──');
  const lines = [header, separator];
  for (const row of rows) {
    lines.push(cols.map((col, i) => String(row[col] ?? 'NULL').padEnd(widths[i])).join('  '));
  }
  console.log(lines.join('\n'));
}

async function runMigrate(root: string, dialect: DatabaseDialect, remote?: boolean): Promise<void> {
  const migrationsDir = join(root, 'db', 'migrations');
  const rawMigrations = collectMigrations(migrationsDir);

  if (remote) {
    const token = getToken();
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
      log.info('No migration files found in db/migrations/');
      outro('Done.');
      return;
    }

    const client = new PlatformClient(token);

    // Fetch remote applied set so we only validate and send pending migrations.
    // This is required — if we can't determine what's already applied, we must
    // abort rather than risk validating (and rejecting) already-applied migrations.
    let remoteApplied: Set<string>;
    try {
      const status = await client.getMigrationStatus(config.projectId);
      remoteApplied = new Set(status.applied.map((m) => m.name));
    } catch (err) {
      log.error(
        `Failed to fetch remote migration status: ${err instanceof Error ? err.message : String(err)}`,
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
    } catch (err: any) {
      log.error(err.message);
      process.exit(1);
    }

    const result = await client.applyRemoteMigrations(config.projectId, pendingMigrations);

    if (!result.ok) {
      log.error(result.error ?? 'Remote migration failed.');
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
    outro('Done.');
    return;
  }

  if (dialect === 'postgresql') {
    const { applyPgMigrations } = await import('../migrations/runner-pg');
    const applied = await withPgClient(root, async (client) => {
      let existingRows: { name: string }[] = [];
      try {
        const result = await client.query('SELECT name FROM _void_migrations');
        existingRows = result.rows;
      } catch {
        existingRows = [];
      }

      try {
        validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
      } catch (err: any) {
        log.error(err.message);
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
    await import('../migrations/runner');
  const persistRoot = join(root, '.void');
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  try {
    const existingRows = await getAppliedMigrations(dbPath);
    validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
  } catch (err: any) {
    log.error(err.message);
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

async function runStudio(root: string, dialect: DatabaseDialect): Promise<void> {
  if (dialect === 'postgresql') {
    const { execSync } = await import('node:child_process');
    const { writeDrizzleConfig } = await import('../drizzle/config');
    const url = getPgUrl(root);
    const configPath = writeDrizzleConfig(root, url, 'postgresql');

    log.info('Opening Drizzle Studio...');
    try {
      execSync(`node ${drizzleKitBin} studio --config ${configPath}`, {
        cwd: root,
        stdio: 'inherit',
      });
    } catch {
      process.exit(1);
    }
    return;
  }

  const { existsSync } = await import('node:fs');
  const { execSync } = await import('node:child_process');
  const { writeDrizzleConfig } = await import('../drizzle/config');
  const { getMiniflareDatabasePath } = await import('../migrations/runner');

  const persistRoot = join(root, '.void');
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  if (!existsSync(dbPath)) {
    log.error('No local database found. Run `void dev` first.');
    process.exit(1);
  }

  const configPath = writeDrizzleConfig(root, dbPath);

  log.info('Opening Drizzle Studio...');
  try {
    execSync(`node ${drizzleKitBin} studio --config ${configPath}`, {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }
}

async function runRenameMigrations(root: string, dialect: DatabaseDialect): Promise<void> {
  const migrationsDir = join(root, 'db', 'migrations');
  if (!existsSync(migrationsDir)) {
    log.info('No migrations directory found.');
    outro('Done.');
    return;
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
  const pad = (n: number) => String(n).padStart(2, '0');
  const formatTs = (d: Date) =>
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());

  let baseTime: Date;
  if (timestampFiles.length > 0) {
    // Parse the earliest timestamp (always UTC) and place renamed files before it
    const earliest = timestampFiles[0].slice(0, 14);
    const y = +earliest.slice(0, 4),
      mo = +earliest.slice(4, 6) - 1,
      d = +earliest.slice(6, 8);
    const h = +earliest.slice(8, 10),
      mi = +earliest.slice(10, 12),
      s = +earliest.slice(12, 14);
    baseTime = new Date(Date.UTC(y, mo, d, h, mi, s - oldStyleFiles.length));
  } else {
    baseTime = new Date(Date.now() - oldStyleFiles.length * 1000);
  }

  const renames: { from: string; to: string }[] = [];
  for (let i = 0; i < oldStyleFiles.length; i++) {
    const oldName = oldStyleFiles[i];
    const description = oldName.replace(/^\d+_/, '');
    const ts = new Date(baseTime.getTime() + i * 1000);
    const newName = `${formatTs(ts)}_${description}`;
    renames.push({ from: oldName, to: newName });
  }

  for (const { from, to } of renames) {
    renameSync(join(migrationsDir, from), join(migrationsDir, to));
    log.step(`${from} → ${to}`);
  }

  if (dialect === 'postgresql') {
    try {
      await withPgClient(root, async (client) => {
        for (const { from, to } of renames) {
          await client.query('UPDATE _void_migrations SET name = $1 WHERE name = $2', [to, from]);
        }
      });
    } catch (err) {
      log.error(
        'Failed to update PostgreSQL tracking table. Files were renamed but the database still has old names.\n' +
          'Run `void db migrate` to re-sync, or manually update the _void_migrations table.',
      );
      log.error(String(err));
      process.exit(1);
    }
  } else {
    const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner');
    const persistRoot = join(root, '.void');
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    if (existsSync(dbPath)) {
      const db = await openSqliteDatabase(dbPath);
      try {
        const hasNew = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_void_migrations'")
          .get();
        const hasLegacy = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
          .get();
        const tableName = hasNew ? '_void_migrations' : hasLegacy ? '_migrations' : null;
        if (tableName) {
          const updateStmt = db.prepare(`UPDATE ${tableName} SET name = ? WHERE name = ?`);
          for (const { from, to } of renames) {
            updateStmt.run(to, from);
          }
        }
      } finally {
        db.close();
      }
    }
  }

  const token = getToken();
  const config = readProjectConfig(root);
  if (token && config) {
    try {
      const client = new PlatformClient(token);
      await client.renameMigrations(config.projectId, renames);
      log.info('Remote migration records updated.');
    } catch {
      log.warn('Could not update remote migration records. Run `void deploy` to sync.');
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
    const parts: string[] = [];
    await withPgClient(root, async (client) => {
      let tables: string[];
      if (args.table) {
        const check = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
          [args.table],
        );
        if (check.rows.length === 0) {
          log.error(`Table not found: ${args.table}`);
          process.exit(1);
        }
        tables = [args.table];
      } else {
        const result = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_%' ORDER BY tablename",
        );
        tables = result.rows.map((r: any) => r.tablename);
      }

      for (const table of tables) {
        if (!args.noSchema) {
          // Get CREATE TABLE statement (simplified — pg_dump would be more complete)
          const cols = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
            [table],
          );
          const colDefs = cols.rows.map((c: any) => {
            let def = `  "${c.column_name}" ${c.data_type}`;
            if (c.is_nullable === 'NO') {
              def += ' NOT NULL';
            }
            if (c.column_default) {
              def += ` DEFAULT ${c.column_default}`;
            }
            return def;
          });
          parts.push(`CREATE TABLE "${table}" (\n${colDefs.join(',\n')}\n);`);
        }

        if (!args.noData) {
          const rows = await client.query(`SELECT * FROM "${table}"`);
          for (const row of rows.rows) {
            const cols = Object.keys(row);
            const vals = cols.map((c) => {
              const v = row[c];
              if (v === null) {
                return 'NULL';
              }
              if (typeof v === 'number') {
                return String(v);
              }
              return `'${String(v).replace(/'/g, "''")}'`;
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

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner');
  const persistRoot = join(root, '.void');
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');

  if (!existsSync(dbPath)) {
    log.error('No local database found. Run `void dev` first.');
    process.exit(1);
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });
  try {
    let tables: string[];
    if (args.table) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(args.table);
      if (!exists) {
        log.error(`Table not found: ${args.table}`);
        process.exit(1);
      }
      tables = [args.table];
    } else {
      tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .all()
        .map((row: any) => row.name);
    }

    const parts: string[] = [];

    for (const table of tables) {
      if (!args.noSchema) {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) as { sql: string };
        parts.push(row.sql + ';');
      }

      if (!args.noData) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map((c) => {
            const v = row[c];
            if (v === null) {
              return 'NULL';
            }
            if (typeof v === 'number') {
              return String(v);
            }
            return `'${String(v).replace(/'/g, "''")}'`;
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
  const { readConfig: readVoidConfig, getDatabaseDialect: getDialect } = await import('../config');
  const config = readVoidConfig(root);
  const dialect = getDialect(config);

  if (dialect !== 'postgresql') {
    log.error('This command is only for PostgreSQL projects. Set "database": "pg" in void.json.');
    process.exit(1);
  }

  const token = getToken();
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

  const client = new PlatformClient(token);
  await client.setDatabaseUrl(projectConfig.projectId, connectionString as string);

  log.success('Database URL updated.');
  outro('Done.');
}

function resolveSeedTarget(root: string, file: string | undefined): SeedTarget {
  if (file) {
    return toSeedTarget(root, resolve(root, file), file);
  }

  const defaults = DEFAULT_SEED_FILES.filter((candidate) => existsSync(join(root, candidate)));
  if (defaults.length === 0) {
    log.error(
      `No seed file found. Create one of: ${DEFAULT_SEED_FILES.join(', ')} or pass --file <path>.`,
    );
    process.exit(1);
  }

  if (defaults.length > 1) {
    log.error(
      `Multiple default seed files found: ${defaults.join(', ')}. Use --file <path> to choose one.`,
    );
    process.exit(1);
  }

  const [seedPath] = defaults;
  return toSeedTarget(root, join(root, seedPath), seedPath);
}

function toSeedTarget(root: string, seedPath: string, displayPath?: string): SeedTarget {
  if (!existsSync(seedPath)) {
    log.error(`Seed file not found: ${seedPath}`);
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

  log.error(`Unsupported seed file: ${normalizedDisplay}. Use .sql, .ts, .mts, .js, or .mjs.`);
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
      const db = options ? drizzle(client, options) : drizzle(client);
      await seed({ dialect, db, schema });
    });
    return;
  }

  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getMiniflareDatabasePath, openSqliteDatabase } = await import('../migrations/runner');
  const persistRoot = join(root, '.void');
  const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
  const sqlite = await openSqliteDatabase(dbPath);
  try {
    const options = getDrizzleSchemaOptions(schema);
    const db = options ? drizzle(sqlite, options) : drizzle(sqlite);
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
      `Seed module must export a default function or a named "seed" function: ${seedPath}`,
    );
  }
  return seed as SeedFn<Record<string, unknown>>;
}

async function loadSeedSchema(root: string): Promise<Record<string, unknown>> {
  const { discoverSchema } = await import('../drizzle/discover');
  const location = discoverSchema(root);
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

function collectSchemaModuleFiles(dir: string): string[] {
  const files: string[] = [];
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
