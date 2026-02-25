import type { Plugin } from "vite";

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateDbTypes } from "./codegen/db-types";
import { ensureProjectTsconfig } from "./codegen/project-tsconfig";
import { collectMigrations } from "./migrations/collect";
import { parseMigrationSchema } from "./migrations/schema";

/**
 * Vite plugin that generates .void/db.d.ts and tsconfig.json.
 *
 * Runs in both default and framework mode so typed DB queries work
 * everywhere. Watches migrations/ for changes during dev.
 *
 * @param hasRouteTypes - Whether route type codegen is active (default mode).
 *   Controls whether tsconfig.json includes routes.d.ts in its files list.
 */
export function dbTypesPlugin(root: string, hasRouteTypes: boolean): Plugin {
  const outDir = join(root, ".void");
  const migrationsDir = join(root, "migrations");

  function writeDbTypes() {
    const migrations = collectMigrations(migrationsDir);
    const schema = parseMigrationSchema(migrations);
    const dts = generateDbTypes(schema);
    writeFileSync(join(outDir, "db.d.ts"), dts);
  }

  // Write tsconfig.json eagerly so users can extend it immediately.
  ensureProjectTsconfig(root, hasRouteTypes);

  return {
    name: "void:db-types",
    enforce: "pre",

    buildStart() {
      writeDbTypes();
    },

    configureServer(devServer) {
      if (!existsSync(migrationsDir)) return;

      devServer.watcher.on("add", (path) => {
        if (path.startsWith(migrationsDir)) writeDbTypes();
      });
      devServer.watcher.on("change", (path) => {
        if (path.startsWith(migrationsDir)) writeDbTypes();
      });
      devServer.watcher.on("unlink", (path) => {
        if (path.startsWith(migrationsDir)) writeDbTypes();
      });
    },
  };
}
