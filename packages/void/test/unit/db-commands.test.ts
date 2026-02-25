import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { getAppliedMigrations } from "../../src/migrations/runner";

const TMP_DIR = join(import.meta.dirname, ".tmp-db-commands-test");

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("getAppliedMigrations", () => {
  it("returns [] when DB file does not exist", async () => {
    const result = await getAppliedMigrations(join(TMP_DIR, "nonexistent.sqlite"));
    expect(result).toEqual([]);
  });

  it("returns [] when _migrations table does not exist", async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, "empty.sqlite");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);
    db.exec("CREATE TABLE other (id INTEGER)");
    db.close();

    const result = await getAppliedMigrations(dbPath);
    expect(result).toEqual([]);
  });

  it("returns applied migrations sorted by name", async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, "migrations.sqlite");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO _migrations (name, applied_at) VALUES ('002_second.sql', '2025-01-02T00:00:00Z');
      INSERT INTO _migrations (name, applied_at) VALUES ('001_first.sql', '2025-01-01T00:00:00Z');
    `);
    db.close();

    const result = await getAppliedMigrations(dbPath);
    expect(result).toEqual([
      { name: "001_first.sql", applied_at: "2025-01-01T00:00:00Z" },
      { name: "002_second.sql", applied_at: "2025-01-02T00:00:00Z" },
    ]);
  });
});
