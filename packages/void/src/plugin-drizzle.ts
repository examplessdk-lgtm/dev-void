import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'pathslash';
import { normalizePath, type Plugin } from 'vite';
import { DRIZZLE_OPERATORS, generateDbDts } from './codegen/db-types.ts';
import { ensureProjectTsconfig } from './codegen/project-tsconfig.ts';
import { discoverSchema } from './drizzle/discover.ts';
import { voidWarn } from './log.ts';
import { readProjectPaths } from './project-paths.ts';

// Resolve drizzle-orm paths from void's own deps so they work in any project
// (including metaframeworks where drizzle-orm isn't a direct dependency).
const drizzleD1Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/d1'));
const drizzleOrmResolved = fileURLToPath(import.meta.resolve('drizzle-orm'));
const envModuleResolved = fileURLToPath(import.meta.resolve('#self/_env'));
const drizzleNodePgResolved = fileURLToPath(import.meta.resolve('drizzle-orm/node-postgres'));
const drizzleMysql2Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/mysql2'));
const pgResolved = fileURLToPath(import.meta.resolve('pg'));
const mysql2Resolved = fileURLToPath(import.meta.resolve('mysql2'));

const VIRTUAL_DB_ID = '\0virtual:void-db';
const VIRTUAL_SCHEMA_DB_ID = '\0virtual:void-db-schema';
type DrizzlePluginOptions = {
  d1BindingName?: string;
  forceVirtualDb?: boolean;
  localD1DatabaseId?: string;
  localD1PersistRoot?: string;
  redirectDbTypePaths?: boolean;
};

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
  dialect: 'sqlite' | 'postgresql' | 'mysql' = 'sqlite',
  options: DrizzlePluginOptions = {},
): Plugin {
  const outDir = join(root, '.void');
  const paths = readProjectPaths(root);
  const schema = discoverSchema(root, paths);
  const hasDbRuntime = schema != null || options.forceVirtualDb === true;
  const d1BindingName = options.d1BindingName ?? 'DB';

  // Always write tsconfig (for routes.d.ts, queues.d.ts, etc.)
  ensureProjectTsconfig(root, hasRouteTypes, hasDbRuntime, schema != null, {
    redirectDbModule: options.redirectDbTypePaths,
    paths,
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
  throw new Error("db: createDb() is unavailable when importing void/db from a schema file.");
}
`;
        }

        // void/db virtual module
        const schemaImport = schema
          ? `import * as schema from ${JSON.stringify(schema.path)};`
          : '';
        const drizzleConfig = schema
          ? dialect === 'mysql'
            ? ', { schema, mode: "default" }'
            : ', { schema }'
          : '';

        if (dialect === 'mysql') {
          return `
import { drizzle } from ${JSON.stringify(drizzleMysql2Resolved)};
import { createPool } from ${JSON.stringify(mysql2Resolved)};
import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

const _requestResourceKey = {};

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("db: MySQL is not configured. Add DATABASE_URL to .env for local dev, or configure Hyperdrive for production.");
}

function getInstance() {
  return getRuntimeRequestResource(_requestResourceKey, () => {
    const pool = createPool({
      uri: getConnectionString(),
      connectionLimit: 1,
      maxIdle: 1,
      idleTimeout: 1000,
    });
    return drizzle(pool${drizzleConfig});
  });
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

        if (dialect === 'postgresql') {
          return `
import { drizzle } from ${JSON.stringify(drizzleNodePgResolved)};
import pg from "pg";
import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

const _requestResourceKey = {};

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("db: PostgreSQL is not configured. Add DATABASE_URL to .env for local dev, or configure Hyperdrive for production.");
}

function getInstance() {
  return getRuntimeRequestResource(_requestResourceKey, () => {
    const pool = new pg.Pool({
      connectionString: getConnectionString(),
      max: 1,
      idleTimeoutMillis: 1000,
    });
    return drizzle(pool${drizzleConfig});
  });
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

        // SQLite (default)
        return `
import { drizzle } from ${JSON.stringify(drizzleD1Resolved)};
import { getRuntimeRequestResource, requireRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

const _requestResourceKey = {};

export const db = new Proxy({}, {
  get(_, prop) {
    const instance = getRuntimeRequestResource(
      _requestResourceKey,
      () => createDb(requireRuntimeBinding(${JSON.stringify(d1BindingName)})),
      () => createPrimaryDb(requireRuntimeBinding(${JSON.stringify(d1BindingName)}))
    );
    return Reflect.get(instance, prop);
  },
});

export function createDb(d1) {
  return drizzle(d1.withSession("first-unconstrained")${drizzleConfig});
}

function createPrimaryDb(d1) {
  return drizzle(d1.withSession("first-primary")${drizzleConfig});
}
`;
      },
    },

    async configureServer(server) {
      if (!schema) {
        return;
      }

      // Check for schema drift on startup
      const migrationsDir = paths.migrationsDir;
      const hasMigrations =
        existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => f.endsWith('.sql'));

      if (!hasMigrations) {
        if (dialect === 'sqlite') {
          const { getApplicationTables, getMiniflareDatabasePath } =
            await import('./migrations/runner.ts');
          const dbPath = getMiniflareDatabasePath(
            options.localD1PersistRoot ?? join(root, '.void'),
            options.localD1DatabaseId ?? 'local',
          );
          const tables = await getApplicationTables(dbPath).catch(() => []);
          if (tables.length > 0) {
            return;
          }
        }

        voidWarn(
          `Schema found but no migrations in ${paths.sourceRelative('db/migrations')}/.\n` +
            '         `void db push` syncs the schema to your local DB without creating migration files.\n' +
            '         Run `void db generate` to create migration files for dev startup and deploy.',
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
