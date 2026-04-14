import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath, type Plugin } from 'vite';
import { ensureProjectTsconfig } from './codegen/project-tsconfig';
import { discoverSchema, type SchemaLocation } from './drizzle/discover';
import { voidWarn } from './log';

// Resolve drizzle-orm paths from void's own deps so they work in any project
// (including metaframeworks where drizzle-orm isn't a direct dependency).
const drizzleD1Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/d1'));
const drizzleOrmResolved = fileURLToPath(import.meta.resolve('drizzle-orm'));
const envModuleResolved = fileURLToPath(import.meta.resolve('#self/_env'));
const drizzleNodePgResolved = fileURLToPath(import.meta.resolve('drizzle-orm/node-postgres'));
const pgResolved = fileURLToPath(import.meta.resolve('pg'));

const VIRTUAL_DB_ID = '\0virtual:void-db';
const VIRTUAL_SCHEMA_DB_ID = '\0virtual:void-db-schema';
const DRIZZLE_OPERATORS =
  'sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max';

interface DrizzlePluginOptions {
  forceVirtualDb?: boolean;
  redirectDbTypePaths?: boolean;
}

/**
 * Vite plugin for Drizzle integration.
 *
 * - Intercepts `void/db` imports in SSR/worker environments and serves
 *   a virtual module that creates a Drizzle DB instance, using the user's
 *   schema when present.
 * - Generates `.void/db.d.ts` with proper Drizzle types.
 * - Sets up `@schema` Vite alias for convenient imports when a schema exists.
 * - Updates `.void/tsconfig.json` with TypeScript paths.
 */
export function drizzlePlugin(
  root: string,
  hasRouteTypes: boolean,
  dialect: 'sqlite' | 'postgresql' = 'sqlite',
  options: DrizzlePluginOptions = {},
): Plugin {
  const outDir = join(root, '.void');
  const schema = discoverSchema(root);
  const hasDbRuntime = schema != null || options.forceVirtualDb === true;

  // Always write tsconfig (for routes.d.ts, queues.d.ts, etc.)
  ensureProjectTsconfig(root, hasRouteTypes, hasDbRuntime, schema != null, {
    redirectDbModule: options.redirectDbTypePaths,
  });

  // Generate db.d.ts when void/db is available, even without a user schema.
  if (hasDbRuntime) {
    generateDbDts(outDir, schema ?? null, dialect);
  }

  let isBuild = false;

  return {
    name: 'void:drizzle',
    enforce: 'pre',

    config(_, env) {
      isBuild = env.command === 'build';
      if (!schema) {
        return;
      }

      return {
        resolve: {
          alias: {
            '@schema': schema.path,
          },
        },
      };
    },

    resolveId: {
      filter: { id: /^(void\/db|@schema|pg$)/ },
      handler(id, importer) {
        // Resolve pg from void's own deps during build so PG projects
        // don't need pg as a direct dependency.
        if (id === 'pg' && isBuild && dialect === 'postgresql' && importer === VIRTUAL_DB_ID) {
          return pgResolved;
        }

        // Only intercept void/db in server/worker environments (not client)
        if (id === 'void/db' && this.environment?.name !== 'client') {
          if (!hasDbRuntime) {
            return;
          } // Fall through to the real module (stub)
          // Don't redirect schema files to avoid circular dependency
          // (virtual:void-db imports the schema, which imports void/db).
          // Schema files only need SQL helpers, not the runtime DB instance.
          if (schema && importer) {
            // Normalize separators for Windows — Vite uses forward slashes,
            // but schema.path from Node's path.join uses backslashes on Windows.
            const normalizedImporter = normalizePath(importer);
            const normalizedSchemaPath = normalizePath(schema.path);
            if (schema.type === 'file' && normalizedImporter === normalizedSchemaPath) {
              return VIRTUAL_SCHEMA_DB_ID;
            }
            if (
              schema.type === 'directory' &&
              normalizedImporter.startsWith(normalizedSchemaPath)
            ) {
              return VIRTUAL_SCHEMA_DB_ID;
            }
          }
          return VIRTUAL_DB_ID;
        }

        // Resolve @schema alias explicitly via resolveId so it works in
        // meta-framework SSR environments (Astro's workerd runner, etc.)
        // where Vite's config-level resolve.alias may not be applied.
        if (schema && (id === '@schema' || id.startsWith('@schema/'))) {
          if (id === '@schema') {
            return schema.path;
          }
          return join(schema.path, id.slice('@schema/'.length));
        }
      },
    },

    load: {
      // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
      filter: { id: /^\0virtual:void-db(?:-schema)?$/ },
      handler(id) {
        if (id === VIRTUAL_SCHEMA_DB_ID) {
          return `
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};
export const db = {};
export function createDb() {
  throw new Error("createDb() is unavailable when importing void/db from a schema file.");
}
`;
        }

        // void/db virtual module
        const schemaImport = schema
          ? `import * as schema from ${JSON.stringify(schema.path)};`
          : '';
        const drizzleConfig = schema ? ', { schema }' : '';

        if (dialect === 'postgresql') {
          return `
import { drizzle } from ${JSON.stringify(drizzleNodePgResolved)};
import pg from "pg";
import { getRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

let _prodInstance;

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("PostgreSQL not configured. Add DATABASE_URL to .env.local for local dev, or configure Hyperdrive for production.");
}

function getInstance() {
  // Local dev (DATABASE_URL): create a fresh Pool per query chain.
  // workerd kills TCP sockets between requests, so pg.Pool's cached
  // connections go stale and hang. Fresh Pool = fresh connection every time.
  if (getRuntimeBinding("DATABASE_URL")) {
    return drizzle(new pg.Pool({ connectionString: getRuntimeBinding("DATABASE_URL"), max: 1 })${drizzleConfig});
  }
  // Production (Hyperdrive): cache the instance — Hyperdrive handles pooling.
  _prodInstance ??= drizzle(getConnectionString()${drizzleConfig});
  return _prodInstance;
}

export const db = new Proxy({}, {
  get(_, prop) {
    return Reflect.get(getInstance(), prop);
  },
});

export function createDb(connectionString) {
  return drizzle(connectionString${drizzleConfig});
}
`;
        }

        // SQLite (default) — existing code
        return `
import { drizzle } from ${JSON.stringify(drizzleD1Resolved)};
import { requireRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

let _instance;

export const db = new Proxy({}, {
  get(_, prop) {
    _instance ??= drizzle(requireRuntimeBinding("DB")${drizzleConfig});
    return Reflect.get(_instance, prop);
  },
});

export function createDb(d1) {
  return drizzle(d1${drizzleConfig});
}
`;
      },
    },

    configureServer(server) {
      if (!schema) {
        return;
      }

      // Check for schema drift on startup
      const migrationsDir = join(root, 'db', 'migrations');
      const hasMigrations =
        existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => f.endsWith('.sql'));

      if (!hasMigrations) {
        voidWarn(
          'Schema found but no migrations in db/migrations/.\n' +
            '         Run `void db push` to apply to local DB, or\n' +
            '         `void db generate` to create migration files.',
        );
      }

      // Watch schema files for changes → regenerate db.d.ts
      const watchPath = schema.path;
      const regenerate = (path: string) => {
        if (path === watchPath || (schema.type === 'directory' && path.startsWith(watchPath))) {
          generateDbDts(outDir, schema, dialect);
        }
      };
      server.watcher.on('change', regenerate);
      server.watcher.on('add', regenerate);
      server.watcher.on('unlink', regenerate);
    },
  };
}

/**
 * Generate `.void/db.d.ts` with Drizzle types referencing the user's schema.
 *
 * This is a proper module file (not `declare module`) whose types override
 * the base `void/db` package via a tsconfig `paths` redirect:
 *   "void/db": ["./.void/db.d.ts"]
 *
 * Imports reference `void/_db` (internal subpath pointing at the same
 * base module) to avoid circular resolution through the paths redirect.
 */
function generateDbDts(
  outDir: string,
  schema: SchemaLocation | null,
  dialect: 'sqlite' | 'postgresql',
): void {
  mkdirSync(outDir, { recursive: true });

  const lines =
    dialect === 'postgresql'
      ? schema
        ? [
            '// Auto-generated by void — do not edit',
            `import type { NodePgDatabase } from "void/_db-pg";`,
            `import type * as schema from "@schema";`,
            'type Schema = typeof schema;',
            'export declare const db: NodePgDatabase<Schema>;',
            'export declare function createDb(connectionString: string): NodePgDatabase<Schema>;',
            `export { ${DRIZZLE_OPERATORS} } from "void/_db";`,
            `export type { NodePgDatabase } from "void/_db-pg";`,
            '',
          ]
        : [
            '// Auto-generated by void — do not edit',
            `import type { NodePgDatabase } from "void/_db-pg";`,
            'export declare const db: NodePgDatabase<Record<string, never>>;',
            'export declare function createDb(connectionString: string): NodePgDatabase<Record<string, never>>;',
            `export { ${DRIZZLE_OPERATORS} } from "void/_db";`,
            `export type { NodePgDatabase } from "void/_db-pg";`,
            '',
          ]
      : schema
        ? [
            '// Auto-generated by void — do not edit',
            '/// <reference types="@cloudflare/workers-types" />',
            `import type { DrizzleD1Database } from "void/_db";`,
            `import type * as schema from "@schema";`,
            'type Schema = typeof schema;',
            'export declare const db: DrizzleD1Database<Schema>;',
            'export declare function createDb(d1: D1Database): DrizzleD1Database<Schema>;',
            `export { ${DRIZZLE_OPERATORS} } from "void/_db";`,
            `export type { DrizzleD1Database } from "void/_db";`,
            '',
          ]
        : [
            '// Auto-generated by void — do not edit',
            '/// <reference types="@cloudflare/workers-types" />',
            `import type { DrizzleD1Database } from "void/_db";`,
            'export declare const db: DrizzleD1Database<Record<string, never>>;',
            'export declare function createDb(d1: D1Database): DrizzleD1Database<Record<string, never>>;',
            `export { ${DRIZZLE_OPERATORS} } from "void/_db";`,
            `export type { DrizzleD1Database } from "void/_db";`,
            '',
          ];

  writeFileSync(join(outDir, 'db.d.ts'), lines.join('\n'));
}
