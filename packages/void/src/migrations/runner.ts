import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { hasPackageDependency, readNearestPackageJson } from '../shared/package-json.ts';
import { collectMigrations } from './collect.ts';
import { classifyMigration } from './plan.ts';

type SqliteStatement<T = unknown> = {
  get(...params: Array<unknown>): T | undefined;
  all(...params: Array<unknown>): Array<T>;
  run(...params: Array<unknown>): unknown;
};

type SqliteTransaction<T = unknown> = {
  (): T;
  immediate(): T;
};

type SqliteDatabase = {
  prepare<T = unknown>(sql: string): SqliteStatement<T>;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: () => T): SqliteTransaction<T>;
};

export type AppliedMigration = {
  name: string;
  applied_at: string;
};

const SQLITE_INTERNAL_TABLES = new Set([
  '_cf_METADATA',
  '_migrations',
  '_void_migrations',
  '__drizzle_migrations',
]);

function projectUsesVitePlus(startDir: string = process.cwd()): boolean {
  const nearest = readNearestPackageJson(startDir);
  return nearest ? hasPackageDependency(nearest.packageJson, 'vite-plus') : false;
}

export function toBetterSqlite3Error(error: unknown, cwd: string = process.cwd()): Error {
  const message = error instanceof Error ? error.message : String(error);
  const isMissingBinding = message.includes('Could not locate the bindings file');
  const isNodeVersionMismatch =
    message.includes('was compiled against a different Node.js version') ||
    message.includes('NODE_MODULE_VERSION');

  if (!isMissingBinding && !isNodeVersionMismatch) {
    return error instanceof Error ? error : new Error(message);
  }

  const usesVitePlus = projectUsesVitePlus(cwd);
  const rebuildCommand = usesVitePlus ? 'vp rebuild' : 'pnpm rebuild better-sqlite3';
  const commandReason = usesVitePlus
    ? 'Vite+ uses its managed Node.js runtime for `vp dev`; rebuild native modules with `vp rebuild` and run Void CLI commands through Vite+ as `vp exec void <command>`.'
    : 'Plain Vite projects use your system Node.js runtime, so `pnpm rebuild better-sqlite3` rebuilds the matching native module.';

  return new Error(
    'db: better-sqlite3 is installed but its native binding was not built. ' +
      `Set \`allowBuilds.better-sqlite3\` to \`true\` in pnpm-workspace.yaml and run \`${rebuildCommand}\`. ` +
      `${commandReason} ` +
      'See https://pnpm.io/settings#allowbuilds',
  );
}

export async function openSqliteDatabase(
  dbPath: string,
  options?: Record<string, unknown>,
): Promise<SqliteDatabase> {
  try {
    const Database = (await import('better-sqlite3')).default;
    return new Database(dbPath, options) as unknown as SqliteDatabase;
  } catch (error) {
    throw toBetterSqlite3Error(error);
  }
}

/**
 * Read the list of applied migrations from the local SQLite database.
 * Returns [] if the DB file or tracking table doesn't exist.
 */
export async function getAppliedMigrations(dbPath: string): Promise<Array<AppliedMigration>> {
  if (!existsSync(dbPath)) {
    return [];
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });

  try {
    // Check for current table name, fall back to legacy `_migrations` for
    // projects that haven't run `void db migrate` yet (which auto-upgrades).
    let tableName: string | null = null;
    for (const candidate of ['_void_migrations', '_migrations']) {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${candidate}'`)
        .get();
      if (exists) {
        tableName = candidate;
        break;
      }
    }

    if (!tableName) {
      return [];
    }

    return db
      .prepare(`SELECT name, applied_at FROM ${tableName} ORDER BY name`)
      .all() as Array<AppliedMigration>;
  } finally {
    db.close();
  }
}

/**
 * Compute the miniflare D1 SQLite database path.
 * Miniflare uses a deterministic hash based on the database_id
 * to store local D1 data.
 */
export function getMiniflareDatabasePath(persistRoot: string, databaseId: string): string {
  const uniqueKey = 'miniflare-D1DatabaseObject';

  // Step 1: SHA-256 of the unique key
  const key = createHash('sha256').update(uniqueKey).digest();

  // Step 2: HMAC-SHA-256 of database_id, take first 16 bytes
  const nameHmac = createHmac('sha256', key).update(databaseId).digest().subarray(0, 16);

  // Step 3: HMAC-SHA-256 of nameHmac, take first 16 bytes
  const hmac = createHmac('sha256', key).update(nameHmac).digest().subarray(0, 16);

  // Step 4: Concatenate to get the filename hash
  const hash = Buffer.concat([nameHmac, hmac]).toString('hex');

  return join(persistRoot, 'v3', 'd1', uniqueKey, `${hash}.sqlite`);
}

/**
 * One-time migration: rename legacy `_migrations` table to `_void_migrations`.
 * Copies all rows from the old table to the new one, then drops the old table.
 *
 * Wrapped in an IMMEDIATE transaction + re-checked inside, so two concurrent
 * local runners (e.g. two `vite dev` processes against the same DB file)
 * don't race each other. Without the lock, both could observe `_migrations`
 * exists, both enter the body, and the loser crashes on `SELECT … FROM
 * _migrations` after the winner already dropped it.
 */
function upgradeTrackingTable(db: SqliteDatabase): void {
  const tx = db.transaction(() => {
    const legacy = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();
    if (!legacy) {
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS _void_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      `INSERT OR IGNORE INTO _void_migrations (name, applied_at) SELECT name, applied_at FROM _migrations`,
    );
    db.exec(`DROP TABLE IF EXISTS _migrations`);
  });
  tx.immediate();
}

function getApplicationTableNames(db: SqliteDatabase): Array<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;

  return rows
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_') && !SQLITE_INTERNAL_TABLES.has(name));
}

export async function getApplicationTables(dbPath: string): Promise<Array<string>> {
  if (!existsSync(dbPath)) {
    return [];
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });
  try {
    return getApplicationTableNames(db);
  } finally {
    db.close();
  }
}

function assertLocalMigrationState(
  migrations: Array<{ name: string; sql: string }>,
  appliedNames: Set<string>,
  applicationTables: Array<string>,
): void {
  const migrationNames = new Set(migrations.map((migration) => migration.name));
  const missingFiles = [...appliedNames].filter((name) => !migrationNames.has(name)).sort();

  if (missingFiles.length > 0) {
    throw new Error(
      [
        'Local database migration history does not match db/migrations/.',
        '',
        'These migrations are recorded as applied locally but no longer exist on disk:',
        ...missingFiles.map((name) => `  - ${name}`),
        '',
        'If the migration files were renamed, run `void db rename-migrations`.',
        'If the migration history was intentionally rewritten, run `void db reset` to recreate the local database from the current files.',
      ].join('\n'),
    );
  }

  if (appliedNames.size === 0 && migrations.length > 0 && applicationTables.length > 0) {
    throw new Error(
      [
        'Local database already has application tables but no Void migration history.',
        '',
        `Existing tables: ${applicationTables.join(', ')}`,
        '',
        'This usually means the schema was applied with `void db push` or the local database was created before migration tracking existed.',
        'Run `void db reset` to recreate the local database from db/migrations/, or delete the local D1 state if you do not need its data.',
      ].join('\n'),
    );
  }
}

/**
 * Apply unapplied SQL migrations from the migrations directory.
 * Tracks applied migrations in the `_void_migrations` table.
 *
 * Each .sql file is executed as a single `db.exec()` call — better-sqlite3's
 * `exec` natively handles multi-statement SQL and lets SQLite do the parsing,
 * so semicolons inside string literals, comments, or trigger bodies don't
 * fracture the migration. A naive `split(';')` pre-processor would misparse
 * a statement like `CREATE TABLE t (msg TEXT DEFAULT 'a;b')` into garbage
 * fragments.
 *
 * Concurrent-runner safety: two local `void` processes can race against the
 * same SQLite file. Both can snapshot the applied-set before either writes,
 * and if both decide a migration is pending, the loser would crash on a
 * `table already exists` error. Each per-migration apply therefore runs
 * inside an IMMEDIATE transaction that re-checks the tracking row under the
 * SQLite write lock — the loser sees the winner's insert and skips, instead
 * of re-running the DDL.
 */
export async function runMigrations(migrationsDir: string, dbPath: string): Promise<Array<string>> {
  const allMigrations = collectMigrations(migrationsDir);
  if (allMigrations.length === 0) {
    return [];
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  const db = await openSqliteDatabase(dbPath);

  try {
    upgradeTrackingTable(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS _void_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const appliedSet = new Set(
      (db.prepare('SELECT name FROM _void_migrations').all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const applicationTables = getApplicationTableNames(db);

    assertLocalMigrationState(allMigrations, appliedSet, applicationTables);

    const pending = allMigrations.filter((m) => !appliedSet.has(m.name));
    if (pending.length === 0) {
      return [];
    }
    for (const migration of pending) {
      classifyMigration(migration);
    }

    const insertStmt = db.prepare('INSERT INTO _void_migrations (name) VALUES (?)');
    const checkStmt = db.prepare('SELECT 1 FROM _void_migrations WHERE name = ?');
    const appliedNames: Array<string> = [];

    for (const migration of pending) {
      const tx = db.transaction(() => {
        // Re-check under the write lock. A concurrent runner may have
        // applied this migration between our pending-filter snapshot and
        // now; if so, skip instead of re-running the DDL.
        if (checkStmt.get(migration.name)) {
          return false;
        }
        db.exec(migration.sql);
        insertStmt.run(migration.name);
        return true;
      });

      if (tx.immediate()) {
        appliedNames.push(migration.name);
      }
    }

    return appliedNames;
  } finally {
    db.close();
  }
}
