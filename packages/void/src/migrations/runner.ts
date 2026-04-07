import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { collectMigrations } from "./collect";

export interface AppliedMigration {
  name: string;
  applied_at: string;
}

function toBetterSqlite3Error(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Could not locate the bindings file")) {
    return error instanceof Error ? error : new Error(message);
  }

  return new Error(
    "better-sqlite3 is installed but its native binding was not built. " +
      "Add it to your 'onlyBuiltDependencies' and run `pnpm rebuild better-sqlite3`. See https://pnpm.io/settings#onlybuiltdependencies",
  );
}

export async function openSqliteDatabase(
  dbPath: string,
  options?: Record<string, unknown>,
): Promise<any> {
  try {
    const Database = (await import("better-sqlite3")).default;
    return new Database(dbPath, options);
  } catch (error) {
    throw toBetterSqlite3Error(error);
  }
}

/**
 * Read the list of applied migrations from the local SQLite database.
 * Returns [] if the DB file or tracking table doesn't exist.
 */
export async function getAppliedMigrations(dbPath: string): Promise<AppliedMigration[]> {
  if (!existsSync(dbPath)) {
    return [];
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });

  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();

    if (!table) return [];

    return db
      .prepare("SELECT name, applied_at FROM _migrations ORDER BY name")
      .all() as AppliedMigration[];
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
  const uniqueKey = "miniflare-D1DatabaseObject";

  // Step 1: SHA-256 of the unique key
  const key = createHash("sha256").update(uniqueKey).digest();

  // Step 2: HMAC-SHA-256 of database_id, take first 16 bytes
  const nameHmac = createHmac("sha256", key).update(databaseId).digest().subarray(0, 16);

  // Step 3: HMAC-SHA-256 of nameHmac, take first 16 bytes
  const hmac = createHmac("sha256", key).update(nameHmac).digest().subarray(0, 16);

  // Step 4: Concatenate to get the filename hash
  const hash = Buffer.concat([nameHmac, hmac]).toString("hex");

  return join(persistRoot, "v3", "d1", uniqueKey, `${hash}.sqlite`);
}

/**
 * Apply unapplied SQL migrations from the migrations directory.
 * Tracks applied migrations in the `_migrations` table.
 * Each .sql file is split into statements and executed individually
 * because D1's `exec()` with multi-statement SQL can fail.
 */
export async function runMigrations(migrationsDir: string, dbPath: string): Promise<string[]> {
  const allMigrations = collectMigrations(migrationsDir);
  if (allMigrations.length === 0) {
    return [];
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  const db = await openSqliteDatabase(dbPath);

  try {
    // Create tracking table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const applied = new Set(
      (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
    );

    const pending = allMigrations.filter((m) => !applied.has(m.name));
    if (pending.length === 0) {
      return [];
    }

    const insertStmt = db.prepare("INSERT INTO _migrations (name) VALUES (?)");

    for (const migration of pending) {
      // Split into individual statements — D1/better-sqlite3 can choke on multi-statement exec
      const statements = migration.sql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const transaction = db.transaction(() => {
        for (const stmt of statements) {
          db.exec(stmt);
        }
        insertStmt.run(migration.name);
      });

      transaction();
    }

    return pending.map((m) => m.name);
  } finally {
    db.close();
  }
}
