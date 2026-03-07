import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { voidLog, voidError } from "./log";

/**
 * Vite plugin that runs local D1 migrations on dev server startup.
 * Applies unapplied .sql files from the migrations/ directory
 * to the local SQLite database used by miniflare.
 */
export function migrationPlugin(
  root: string,
  databaseId = "local",
  persistRoot = join(root, ".void"),
): Plugin {
  return {
    name: "void:migrations",
    apply: "serve",

    async configureServer() {
      const migrationsDir = join(root, "db", "migrations");
      if (!existsSync(migrationsDir)) return;

      try {
        const { runMigrations, getMiniflareDatabasePath } = await import("./migrations/runner");
        const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
        const applied = await runMigrations(migrationsDir, dbPath);
        if (applied.length > 0) {
          voidLog(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
        }
      } catch (err) {
        voidError(`Migration error: ${err}`);
      }
    },
  };
}
