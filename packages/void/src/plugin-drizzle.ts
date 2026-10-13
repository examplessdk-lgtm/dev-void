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

const VIRTUAL_DB_ID = '\0virtual:void-db';
const VIRTUAL_SCHEMA_DB_ID = '\0virtual:void-db-schema';

// Workers tie a connection to the request that opened it. void/db's PostgreSQL and MySQL
// templates share one drizzle instance whose client looks up the current request's pool on
// every call, so a query built or prepared in one request runs on the pool of the request that
// executes it. `has` and `getPrototypeOf` answer drizzle's pool checks before a transaction.
// Every pool has the same shape, so those answers are kept: outside a request scope, where each
// lookup builds a pool, a check would otherwise build one that never runs a query.
const REQUEST_POOL_PROXY = `
function requestPool(resolve, own = {}) {
  const has = new Map();
  let prototype;
  return new Proxy({}, {
    get(_, prop) {
      if (Object.hasOwn(own, prop)) return own[prop];
      const pool = resolve();
      const value = Reflect.get(pool, prop);
      return typeof value === "function" ? value.bind(pool) : value;
    },
    has(_, prop) {
      if (Object.hasOwn(own, prop)) return true;
      if (!has.has(prop)) has.set(prop, Reflect.has(resolve(), prop));
      return has.get(prop);
    },
    getPrototypeOf: () => (prototype ??= Object.getPrototypeOf(resolve())),
  });
}
`;
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

  return {
    name: 'void:drizzle',
    enforce: 'pre',

    config() {
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
      filter: { id: /^(void\/db|@schema)/ },
      handler(id, importer) {
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
        const drizzleConfig = schema ? ', { schema }' : '';

        if (dialect === 'mysql') {
          // drizzle builds the pool from `connection`, so its bare mysql2 import is the only one
          // and the worker prebundle serves it. Its config check rejects `mode` without `schema`.
          const mysqlDrizzleConfig = schema ? ', schema, mode: "default"' : '';
          return `
import { drizzle } from ${JSON.stringify(drizzleMysql2Resolved)};
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

// mysql2 closes idle connections only from a timer that it starts when it builds a pool with
// maxIdle below connectionLimit, and that timer runs until the pool ends: workerd rejects it in
// global scope, and nothing ends Void's pools. Time each connection from its release instead,
// which runs in the request that ran the query.
function closeIdleConnections(pool, idleTimeout) {
  const timers = new WeakMap();
  pool.on("release", (connection) => {
    const timer = setTimeout(() => connection.destroy(), idleTimeout);
    // A Node script that ends its pool exits without waiting for this timer.
    timer.unref?.();
    timers.set(connection, timer);
  });
  pool.on("acquire", (connection) => clearTimeout(timers.get(connection)));
  return pool;
}

function createPools() {
  const pool = closeIdleConnections(
    drizzle({
      connection: {
        uri: getConnectionString(),
        connectionLimit: 1,
        // Workers forbid eval, which mysql2 uses to build its row parsers.
        disableEval: true,
      },
    }).$client,
    1000,
  );
  return { pool, promisePool: pool.promise() };
}

function getPools() {
  // Framework entries that Void does not own run outside its request scope:
  // they get a client for each use, never one shared across requests.
  return getRuntimeRequestResource(_requestResourceKey, createPools, createPools);
}
${REQUEST_POOL_PROXY}
const promiseClient = requestPool(() => getPools().promisePool);
// drizzle asks for the promise API while it builds the database, which can run in global
// scope. No request exists there to own a pool, so answer without one.
const client = requestPool(() => getPools().pool, { promise: () => promiseClient });

let instance;

export const db = new Proxy({}, {
  get(_, prop) {
    // drizzle reports a query's errors as "Failed query", so build the request's pool here:
    // a missing connection string then throws its own message. Outside a request, build none.
    getRuntimeRequestResource(_requestResourceKey, createPools, () => undefined);
    instance ??= drizzle({ client${mysqlDrizzleConfig} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function createDb(connectionString) {
  const db = drizzle({ connection: { uri: connectionString, disableEval: true }${mysqlDrizzleConfig} });
  // 60 seconds is mysql2's own idleTimeout default.
  closeIdleConnections(db.$client, 60000);
  return db;
}
`;
        }

        if (dialect === 'postgresql') {
          // Like MySQL: drizzle builds the pool, so its bare pg import is the only one.
          return `
import { drizzle } from ${JSON.stringify(drizzleNodePgResolved)};
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

function createPool() {
  return drizzle({
    connection: {
      connectionString: getConnectionString(),
      max: 1,
      idleTimeoutMillis: 1000,
    },
  }).$client;
}

function getPool() {
  // Framework entries that Void does not own run outside its request scope:
  // they get a client for each use, never one shared across requests.
  return getRuntimeRequestResource(_requestResourceKey, createPool, createPool);
}
${REQUEST_POOL_PROXY}
let instance;

export const db = new Proxy({}, {
  get(_, prop) {
    // drizzle reports a query's errors as "Failed query", so build the request's pool here:
    // a missing connection string then throws its own message. Outside a request, build none.
    getRuntimeRequestResource(_requestResourceKey, createPool, () => undefined);
    instance ??= drizzle({ client: requestPool(getPool)${schema ? ', schema' : ''} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
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

    async configureServer() {
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
    },
  };
}
