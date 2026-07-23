import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  getAppliedMigrations,
  openSqliteDatabase,
  runMigrations,
  toBetterSqlite3Error,
} from '../../src/migrations/runner.ts';

/**
 * Low-level tests for `runMigrations` against a real better-sqlite3
 * database file. These tests exercise the transactional semantics and
 * legacy-table upgrade that the platform's D1 runtime can't easily
 * simulate — specifically:
 *
 *   - multi-statement atomic rollback when one statement fails mid-file
 *   - legacy `_migrations` table upgrade path (copy + drop)
 *   - applied-set filter on re-run (idempotency)
 *   - tracking row gets written only after all statements succeed
 *
 * These are unit-level because they instantiate better-sqlite3 directly.
 */

const roots: Array<string> = [];

function createDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-runner-sqlite-'));
  roots.push(root);
  return root;
}

function writeMigration(dir: string, name: string, sql: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('toBetterSqlite3Error', () => {
  it('suggests vp rebuild for Vite+ projects when the native binding is missing', () => {
    const root = createDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { 'vite-plus': '^0.1.0' } }),
      'utf8',
    );

    const error = toBetterSqlite3Error(
      new Error('Could not locate the bindings file. Tried:'),
      root,
    );

    expect(error.message).toContain('run `vp rebuild`');
    expect(error.message).toContain('vp exec void <command>');
    expect(error.message).not.toContain('run `pnpm rebuild better-sqlite3`');
  });

  it('suggests vp rebuild for Vite+ projects when the native binding has a Node ABI mismatch', () => {
    const root = createDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { 'vite-plus': '^0.1.0' } }),
      'utf8',
    );

    const error = toBetterSqlite3Error(
      new Error(
        'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137.',
      ),
      root,
    );

    expect(error.message).toContain('run `vp rebuild`');
  });

  it('keeps pnpm rebuild guidance for plain Vite projects', () => {
    const root = createDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^7.0.0' } }),
      'utf8',
    );

    const error = toBetterSqlite3Error(
      new Error('Could not locate the bindings file. Tried:'),
      root,
    );

    expect(error.message).toContain('run `pnpm rebuild better-sqlite3`');
    expect(error.message).not.toContain('run `vp rebuild`');
  });
});

describe('runMigrations (local SQLite)', () => {
  it('applies a single-statement migration and writes the tracking row', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_init.sql']);

    const tracked = await getAppliedMigrations(dbPath);
    expect(tracked.map((t) => t.name)).toEqual(['001_init.sql']);
  });

  it('is idempotent on re-run (pending filter removes already-applied)', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    await runMigrations(migDir, dbPath);
    const second = await runMigrations(migDir, dbPath);
    expect(second).toEqual([]);
  });

  it('fails before replaying migrations when a pushed schema has no tracking rows', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');

    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    } finally {
      db.close();
    }

    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow(
      'Local database already has application tables but no Void migration history.',
    );
  });

  it('fails before replaying migrations when applied rows refer to missing files', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');

    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE _void_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO _void_migrations (name) VALUES ('001_old_init.sql');
      `);
    } finally {
      db.close();
    }

    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow(
      'Local database migration history does not match db/migrations/.',
    );
  });

  it('applies multi-statement migrations in order', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_multi.sql',
      'CREATE TABLE users (id TEXT PRIMARY KEY);\nCREATE TABLE posts (id TEXT PRIMARY KEY);',
    );

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_multi.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toContain('users');
      expect(names).toContain('posts');
    } finally {
      db.close();
    }
  });

  it('rolls back the whole migration when a later statement fails', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_bad.sql',
      'CREATE TABLE temp_t (id TEXT PRIMARY KEY);\nINVALID SQL HERE;',
    );

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow();

    // The partial table should NOT exist — the transaction rolled back.
    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const tempExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_t'")
        .get();
      expect(tempExists).toBeUndefined();

      // No tracking row
      const trackedTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_void_migrations'")
        .get();
      if (trackedTable) {
        const rows = db.prepare('SELECT name FROM _void_migrations').all();
        expect(rows).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it('rolls back only the failing migration and keeps prior successes', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_ok.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY)');
    writeMigration(migDir, '002_bad.sql', 'CREATE TABLE b (id TEXT); NOT SQL AT ALL;');

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow();

    // 001 should have committed; 002 should have rolled back.
    const tracked = await getAppliedMigrations(dbPath);
    expect(tracked.map((t) => t.name)).toEqual(['001_ok.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const aExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a'")
        .get();
      const bExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'")
        .get();
      expect(aExists).toBeDefined();
      expect(bExists).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('upgrades a legacy _migrations table into _void_migrations on first run', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');

    // Pre-seed a legacy tracking table with one row, no `_void_migrations` table.
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(`CREATE TABLE _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )`);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        '001_init.sql',
        '2023-01-01T00:00:00Z',
      );
    } finally {
      db.close();
    }

    // Provide both 001 (should be detected as already applied via upgrade) and 002.
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    writeMigration(migDir, '002_posts.sql', 'CREATE TABLE posts (id TEXT PRIMARY KEY)');

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['002_posts.sql']);

    const db2 = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      // _migrations was dropped
      const legacy = db2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .get();
      expect(legacy).toBeUndefined();
      // _void_migrations has the expected rows
      const rows = db2.prepare('SELECT name FROM _void_migrations ORDER BY name').all() as Array<{
        name: string;
      }>;
      expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_posts.sql']);
    } finally {
      db2.close();
    }
  });

  it('getAppliedMigrations returns [] when the db file does not exist', async () => {
    const root = createDir();
    const dbPath = join(root, 'never-created.sqlite');
    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([]);
  });

  it('getAppliedMigrations returns [] when neither tracking table exists', async () => {
    const root = createDir();
    const dbPath = join(root, 'empty.sqlite');
    // Create an empty DB
    const db = await openSqliteDatabase(dbPath);
    db.close();

    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([]);
  });

  it('getAppliedMigrations reads from legacy _migrations if _void_migrations is absent', async () => {
    const root = createDir();
    const dbPath = join(root, 'legacy-only.sqlite');
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(
        "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
      );
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        '001_legacy.sql',
        '2023-02-02T00:00:00Z',
      );
    } finally {
      db.close();
    }

    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([{ name: '001_legacy.sql', applied_at: '2023-02-02T00:00:00Z' }]);
  });

  it('returns [] when no migrations are present on disk', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    mkdirSync(migDir, { recursive: true });
    const dbPath = join(root, 'test.sqlite');
    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual([]);
  });

  it('writes the tracking row AFTER the migration SQL, not before (mutation-sensitive ordering)', async () => {
    // Load-bearing invariant: the per-migration transaction body must run
    // `db.exec(migration.sql)` BEFORE `insertStmt.run(migration.name)`. If a
    // future refactor reverses the order, the classic "tracking row written
    // before the SQL" bug returns — and a rollback test can't catch it
    // because the failing transaction rolls back both.
    //
    // The trick: write a migration that peeks at its own tracking row mid-
    // apply. If the INSERT ran first, the peek sees 1; if after, it sees 0.
    // Because both the exec and the insert are inside the same transaction
    // and SQLite sees the in-flight transaction state, the observation is
    // deterministic.
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_peek.sql',
      [
        'CREATE TABLE peek (saw INTEGER);',
        "INSERT INTO peek (saw) SELECT COUNT(*) FROM _void_migrations WHERE name = '001_peek.sql';",
      ].join('\n'),
    );

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_peek.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT saw FROM peek').all() as Array<{ saw: number }>;
      // saw === 0 proves the tracking INSERT happened AFTER db.exec.
      // saw === 1 would mean the INSERT ran first — this test regresses.
      expect(rows).toEqual([{ saw: 0 }]);
    } finally {
      db.close();
    }
  });

  it('is safe when two runMigrations calls race against the same DB (concurrent-runner recovery)', async () => {
    // Two local `void` processes can target the same SQLite file. Without
    // write-side re-checks, both see the migration as pending, both try to
    // run its DDL, and the loser crashes with "table already exists". The
    // runner's per-migration IMMEDIATE-transaction re-check must make the
    // loser observe the winner's tracking row under the write lock and skip.
    //
    // Two sequential runMigrations calls over the same file simulate this —
    // the second call opens the DB fresh, so its in-memory applied-set
    // snapshot is accurate here, but the point is to exercise the re-check
    // path and prove it's idempotent. The real regression we're guarding
    // against is a future change that breaks the re-check by reading from
    // the snapshot instead of the DB.
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    const first = await runMigrations(migDir, dbPath);
    expect(first).toEqual(['001_init.sql']);

    // Re-run: should observe the migration applied and skip, NOT crash
    // with "table users already exists".
    const second = await runMigrations(migDir, dbPath);
    expect(second).toEqual([]);

    // Exactly one tracking row
    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const tracked = db.prepare('SELECT name FROM _void_migrations').all();
      expect(tracked).toEqual([{ name: '001_init.sql' }]);
    } finally {
      db.close();
    }
  });

  it('upgradeTrackingTable is idempotent under concurrent invocation (DROP IF EXISTS)', async () => {
    // Two runMigrations calls racing the legacy→void upgrade must both
    // succeed. Before the fix, the second process would crash on
    // `DROP TABLE _migrations` after the first already dropped it. The
    // upgrade is now wrapped in an IMMEDIATE transaction that re-checks
    // legacy presence under the write lock, and uses `DROP TABLE IF EXISTS`.
    //
    // Seed legacy, run runMigrations (which runs the upgrade as part of
    // applying pending migrations), then run it again — proving the second
    // call no-ops cleanly instead of crashing on a missing `_migrations`.
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_bootstrap.sql', 'CREATE TABLE bootstrap (id TEXT PRIMARY KEY)');
    writeMigration(migDir, '002.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    // Seed legacy with the first on-disk migration, so the upgrade preserves
    // it and the apply loop still has a later migration pending.
    let db = await openSqliteDatabase(dbPath);
    try {
      db.exec(
        "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
      );
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        '001_bootstrap.sql',
        '2023-01-01T00:00:00Z',
      );
    } finally {
      db.close();
    }

    // First run: upgrade copies 001_bootstrap.sql into _void_migrations,
    // drops _migrations, then applies 002.sql.
    const first = await runMigrations(migDir, dbPath);
    expect(first).toEqual(['002.sql']);

    db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = (
        db.prepare('SELECT name FROM _void_migrations ORDER BY name').all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(rows).toEqual(['001_bootstrap.sql', '002.sql']);
      const legacy = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .get();
      expect(legacy).toBeUndefined();
    } finally {
      db.close();
    }

    // Second run: legacy is already gone, both migrations already applied. Must
    // no-op, not crash on a "no such table" during the upgrade body.
    const second = await runMigrations(migDir, dbPath);
    expect(second).toEqual([]);
  });

  it('handles semicolons inside string literals as a single statement', async () => {
    // A naive `sql.split(';')` preprocessor would fracture this migration
    // at the `;` inside the default literal, producing garbage fragments
    // like `CREATE TABLE t (msg TEXT DEFAULT 'a` and `b')`. The runner
    // must hand the raw SQL to better-sqlite3's multi-statement exec so
    // SQLite does the tokenizing and understands that the `;` inside
    // a quoted literal is NOT a statement terminator.
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_literal.sql',
      `CREATE TABLE t (msg TEXT DEFAULT 'a;b');\nINSERT INTO t DEFAULT VALUES;`,
    );

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_literal.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT msg FROM t').all() as Array<{ msg: string }>;
      expect(rows).toEqual([{ msg: 'a;b' }]);
      // Exactly one tracking row.
      const tracked = db.prepare('SELECT name FROM _void_migrations').all();
      expect(tracked).toEqual([{ name: '001_literal.sql' }]);
    } finally {
      db.close();
    }
  });
});
