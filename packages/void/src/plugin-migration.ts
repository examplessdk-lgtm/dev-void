import type { Plugin } from "vite";

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Vite plugin that runs local D1 migrations on dev server startup.
 * Applies unapplied .sql files from the migrations/ directory
 * to the local SQLite database used by miniflare.
 */
export function migrationPlugin(root: string, databaseId = "local"): Plugin {
  return {
    name: "void:migrations",
    apply: "serve",

    async configureServer() {
      const migrationsDir = join(root, "migrations");
      if (!existsSync(migrationsDir)) return;

      const persistRoot = join(root, ".void");

      try {
        const { runMigrations, getMiniflareDatabasePath } = await import("./migrations/runner");
        const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
        const applied = await runMigrations(migrationsDir, dbPath);
        if (applied.length > 0) {
          console.log(`[void] Applied ${applied.length} migration(s): ${applied.join(", ")}`);
        }
      } catch (err) {
        console.error("[void] Migration error:", err);
      }
    },
  };
}
