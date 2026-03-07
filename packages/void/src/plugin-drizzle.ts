import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Plugin } from "vite";
import { discoverSchema, type SchemaLocation } from "./drizzle/discover";
import { ensureProjectTsconfig } from "./codegen/project-tsconfig";
import { voidWarn } from "./log";

// Resolve drizzle-orm paths from void's own deps so they work in any project
// (including metaframeworks where drizzle-orm isn't a direct dependency).
const drizzleD1Resolved = fileURLToPath(import.meta.resolve("drizzle-orm/d1"));
const drizzleOrmResolved = fileURLToPath(import.meta.resolve("drizzle-orm"));
const envModuleResolved = fileURLToPath(import.meta.resolve("void/_env"));

const VIRTUAL_DB_ID = "\0virtual:void-db";

/**
 * Vite plugin for Drizzle integration.
 *
 * - Intercepts `void/db` imports in SSR/worker environments and serves
 *   a virtual module that creates a Drizzle D1 instance with the user's schema.
 * - Generates `.void/db.d.ts` with proper Drizzle types.
 * - Sets up `@schema` Vite alias for convenient imports.
 * - Updates `.void/tsconfig.json` with TypeScript paths.
 */
export function drizzlePlugin(root: string, hasRouteTypes: boolean): Plugin {
  const outDir = join(root, ".void");
  const schema = discoverSchema(root);

  // Always write tsconfig (for routes.d.ts, queues.d.ts, etc.)
  ensureProjectTsconfig(root, hasRouteTypes, schema != null);

  // Generate db.d.ts if schema exists
  if (schema) {
    generateDbDts(outDir, schema);
  }

  return {
    name: "void:drizzle",
    enforce: "pre",

    config() {
      if (!schema) return;

      return {
        resolve: {
          alias: {
            "@schema": schema.path,
          },
        },
      };
    },

    resolveId: {
      filter: { id: /^(void\/db|@schema)/ },
      handler(id, importer) {
        // Only intercept void/db in server/worker environments (not client)
        if (id === "void/db" && this.environment?.name !== "client") {
          if (!schema) return; // Fall through to the real module (stub)
          // Don't redirect schema files to avoid circular dependency
          // (virtual:void-db imports the schema, which imports void/db)
          if (importer) {
            if (schema.type === "file" && importer === schema.path) return;
            if (schema.type === "directory" && importer.startsWith(schema.path)) return;
          }
          return VIRTUAL_DB_ID;
        }

        // Resolve @schema alias explicitly via resolveId so it works in
        // meta-framework SSR environments (Astro's workerd runner, etc.)
        // where Vite's config-level resolve.alias may not be applied.
        if (schema && (id === "@schema" || id.startsWith("@schema/"))) {
          if (id === "@schema") return schema.path;
          return join(schema.path, id.slice("@schema/".length));
        }
      },
    },

    load: {
      filter: { id: /^\0virtual:void-db$/ },
      handler() {
        const schemaImport = JSON.stringify(schema!.path);

        // Use absolute paths for drizzle-orm imports so they resolve in any
        // project context (metaframeworks where drizzle-orm isn't a direct dep).
        return `
import { drizzle } from ${JSON.stringify(drizzleD1Resolved)};
import { requireRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
import * as schema from ${schemaImport};
export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max } from ${JSON.stringify(drizzleOrmResolved)};

let _instance;

export const db = new Proxy({}, {
  get(_, prop) {
    _instance ??= drizzle(requireRuntimeBinding("DB"), { schema });
    return Reflect.get(_instance, prop);
  },
});

export function createDb(d1) {
  return drizzle(d1, { schema });
}
`;
      },
    },

    configureServer(server) {
      if (!schema) return;

      // Check for schema drift on startup
      const migrationsDir = join(root, "db", "migrations");
      const hasMigrations =
        existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => f.endsWith(".sql"));

      if (!hasMigrations) {
        voidWarn(
          "Schema found but no migrations in db/migrations/.\n" +
            "         Run `void db push` to apply to local DB, or\n" +
            "         `void db generate` to create migration files.",
        );
      }

      // Watch schema files for changes → regenerate db.d.ts
      const watchPath = schema.path;
      const regenerate = (path: string) => {
        if (path === watchPath || (schema.type === "directory" && path.startsWith(watchPath))) {
          generateDbDts(outDir, schema);
        }
      };
      server.watcher.on("change", regenerate);
      server.watcher.on("add", regenerate);
      server.watcher.on("unlink", regenerate);
    },
  };
}

/**
 * Generate `.void/db.d.ts` with Drizzle types referencing the user's schema.
 *
 * Uses an ambient module declaration (no `export {}`) to REPLACE the
 * package's built-in types with schema-aware Drizzle types. This is
 * intentional — the old QueryClient types are gone and the new types
 * should reference the user's specific schema.
 */
function generateDbDts(outDir: string, _schema: SchemaLocation): void {
  mkdirSync(outDir, { recursive: true });

  const lines = [
    "// Auto-generated by void — do not edit",
    '/// <reference types="@cloudflare/workers-types" />',
    'declare module "void/db" {',
    '  import type { DrizzleD1Database } from "void/db";',
    '  import type * as schema from "@schema";',
    "  type Schema = typeof schema;",
    "  export const db: DrizzleD1Database<Schema>;",
    "  export function createDb(d1: D1Database): DrizzleD1Database<Schema>;",
    '  export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max } from "drizzle-orm";',
    '  export type { DrizzleD1Database } from "drizzle-orm/d1";',
    "}",
    "",
  ];

  writeFileSync(join(outDir, "db.d.ts"), lines.join("\n"));
}
