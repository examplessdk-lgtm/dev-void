import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getHookHandler } from '../helpers/vite-hooks.ts';

vi.mock('../../src/log', () => ({
  voidLog: vi.fn(),
  voidWarn: vi.fn(),
  voidError: vi.fn(),
}));

import { voidWarn } from '../../src/log.ts';
import { getMiniflareDatabasePath, openSqliteDatabase } from '../../src/migrations/runner.ts';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';

const roots: Array<string> = [];
const fakeStateKeys: Array<string> = [];
const warnMock = vi.mocked(voidWarn);

function createProjectRoot(options?: { schema?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-drizzle-'));
  if (options?.schema !== false) {
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db', 'schema.ts'), 'export {};\n');
  }
  roots.push(root);
  return root;
}

type FakePoolRecord = {
  dialect: 'postgresql' | 'mysql';
  options: Record<string, unknown>;
  drizzleConfig?: Record<string, unknown>;
};

type FakeDatabaseState = {
  nextId: number;
  pools: Array<FakePoolRecord>;
  clients: Array<unknown>;
};

type ExecutableDbModule = {
  db: {
    instanceId: number;
    query(expectedOwner: string): Promise<number>;
    transaction<T>(callback: (tx: { instanceId: number }) => T | Promise<T>): Promise<T>;
  };
  createDb(connectionString: string): ExecutableDbModule['db'];
  withEnv<T>(env: Record<string, unknown>, callback: () => T): T;
};

async function loadExecutableDbModule(
  dialect: 'postgresql' | 'mysql' | 'sqlite',
): Promise<{ module: ExecutableDbModule; state: FakeDatabaseState }> {
  const root = createProjectRoot({ schema: dialect !== 'sqlite' });
  const plugin = drizzlePlugin(root, false, dialect, { forceVirtualDb: true });
  const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
  let code = load.call({}, '\0virtual:void-db');
  const stateKey = `__void_db_scope_${dialect}_${crypto.randomUUID().replaceAll('-', '')}`;
  const state: FakeDatabaseState = { nextId: 0, pools: [], clients: [] };
  (globalThis as Record<string, unknown>)[stateKey] = state;
  fakeStateKeys.push(stateKey);

  const fakeDriverPath = join(root, 'fake-driver.mjs');
  const fakePgPath = join(root, 'fake-pg.mjs');
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
  const stateExpression = `globalThis[${JSON.stringify(stateKey)}]`;
  const createDatabaseSource = `
function createDatabase(dialect, pool) {
  const state = ${stateExpression};
  const instanceId = ++state.nextId;
  const connectionOwner = dialect === "postgresql" ? pool.options.connectionString : pool.options.uri;
  let owner = connectionOwner;
  try { owner = getTestRuntimeBinding("REQUEST_ID") ?? connectionOwner; } catch {}
  const database = {
    instanceId,
    async query(expectedOwner) {
      if (owner !== expectedOwner) throw new Error("database instance crossed request ownership");
      return instanceId;
    },
    async transaction(callback) {
      return callback(database);
    },
  };
  return database;
}
`;

  if (dialect === 'sqlite') {
    writeFileSync(
      fakeDriverPath,
      `const state = ${stateExpression};
export function drizzle(client) {
  state.clients.push(client);
  return { instanceId: ++state.nextId };
}
`,
    );
    code = code.replace(
      /^import \{ drizzle \} from .*;$/m,
      'import { drizzle } from "./fake-driver.mjs";',
    );
  } else if (dialect === 'postgresql') {
    writeFileSync(
      fakePgPath,
      `const state = ${stateExpression};
export class Pool {
  constructor(options) {
    this.options = options;
    state.pools.push({ dialect: "postgresql", options });
  }
}
export default { Pool };
`,
    );
    writeFileSync(
      fakeDriverPath,
      `import { getRuntimeBinding as getTestRuntimeBinding } from ${JSON.stringify(envUrl)};
${createDatabaseSource}
export function drizzle(pool) {
  if (typeof pool === "string") pool = { options: { connectionString: pool } };
  return createDatabase("postgresql", pool);
}
`,
    );
    code = code
      .replace(/^import \{ drizzle \} from .*;$/m, `import { drizzle } from "./fake-driver.mjs";`)
      .replace('import pg from "pg";', 'import pg from "./fake-pg.mjs";');
  } else {
    writeFileSync(
      fakeDriverPath,
      `import { getRuntimeBinding as getTestRuntimeBinding } from ${JSON.stringify(envUrl)};
const state = ${stateExpression};
${createDatabaseSource}
export function drizzle(config) {
  if (typeof config?.connection !== "object" || config.connection === null) {
    throw new Error("void/db must let drizzle build the mysql2 pool from a connection object");
  }
  const { connection, ...drizzleConfig } = config;
  state.pools.push({ dialect: "mysql", options: connection, drizzleConfig });
  return createDatabase("mysql", { options: connection });
}
`,
    );
    code = code.replace(
      /^import \{ drizzle \} from .*;$/m,
      `import { drizzle } from "./fake-driver.mjs";`,
    );
  }

  code = code.replace(
    /^import \{ ((?:getRuntimeBinding|getRuntimeRequestResource|requireRuntimeBinding)[^}]*) \} from .*;$/m,
    (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
  );
  writeFileSync(join(root, 'virtual-db.mjs'), code);
  writeFileSync(
    join(root, 'harness.mjs'),
    `import { db, createDb } from "./virtual-db.mjs";
import { withRuntimeEnv } from ${JSON.stringify(envUrl)};
export { db, createDb };
export const withEnv = (env, callback) => withRuntimeEnv(env, callback);
`,
  );

  const module = (await import(
    `${pathToFileURL(join(root, 'harness.mjs')).href}?test=${crypto.randomUUID()}`
  )) as ExecutableDbModule;
  return { module, state };
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const key of fakeStateKeys.splice(0, fakeStateKeys.length)) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

beforeEach(() => {
  warnMock.mockReset();
});

describe('drizzlePlugin db typing generation', () => {
  it('uses one nearby D1 session per request, including custom bindings', async () => {
    const { module, state } = await loadExecutableDbModule('sqlite');
    const sessions: Array<{ constraint: string; owner: string }> = [];
    const binding = {
      withSession(constraint: string) {
        const session = { constraint, owner: 'default' };
        sessions.push(session);
        return session;
      },
    };

    const first = module.withEnv({ DB: binding }, () => [
      module.db.instanceId,
      module.db.instanceId,
    ]);
    const second = module.withEnv({ DB: binding }, () => module.db.instanceId);
    expect(first[0]).toBe(first[1]);
    expect(second).not.toBe(first[0]);
    expect(sessions).toEqual([
      { constraint: 'first-unconstrained', owner: 'default' },
      { constraint: 'first-unconstrained', owner: 'default' },
    ]);
    expect(state.clients).toEqual(sessions);

    const other = {
      withSession(constraint: string) {
        const session = { constraint, owner: 'other' };
        sessions.push(session);
        return session;
      },
    };
    module.createDb(other as unknown as string);
    expect(state.clients[2]).toEqual({ constraint: 'first-unconstrained', owner: 'other' });
  });

  it('uses a primary D1 session when a framework handler has no Void request scope', async () => {
    const { module, state } = await loadExecutableDbModule('sqlite');
    const previousEnv = (globalThis as Record<string, unknown>).__env__;
    (globalThis as Record<string, unknown>).__env__ = {
      DB: {
        withSession(constraint: string) {
          return { constraint };
        },
      },
    };
    try {
      expect(module.db.instanceId).not.toBe(module.db.instanceId);
      expect(state.clients).toEqual([
        { constraint: 'first-primary' },
        { constraint: 'first-primary' },
      ]);
    } finally {
      if (previousEnv === undefined) {
        delete (globalThis as Record<string, unknown>).__env__;
      } else {
        (globalThis as Record<string, unknown>).__env__ = previousEnv;
      }
    }
  });

  it('keeps sqlite projects on the D1 internal db entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'sqlite');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { DrizzleD1Database } from "void/_db";');
    expect(dts).not.toContain('void/_db-pg');
  });

  it('keeps postgres-only types off the shared db runtime entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'postgresql');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain('export type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain(
      `export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max } from "void/_db";`,
    );
  });

  it('generates MySQL database types from the dedicated runtime entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'mysql');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { MySql2Database } from "void/_db-mysql";');
    expect(dts).toContain('export type { MySql2Database } from "void/_db-mysql";');
  });

  it.each(['postgresql', 'mysql'] as const)(
    'keeps %s Hyperdrive clients inside one runtime invocation',
    async (dialect) => {
      const { module, state } = await loadExecutableDbModule(dialect);
      const sharedEnv = {
        HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
        REQUEST_ID: 'request-one',
      };

      const sameRequest = await module.withEnv(sharedEnv, async () => {
        const first = await module.db.query('request-one');
        const second = await module.db.query('request-one');
        const transaction = await module.db.transaction(async (tx) => ({
          proxy: module.db.instanceId,
          transaction: tx.instanceId,
        }));
        return { first, second, transaction };
      });

      expect(sameRequest.first).toBe(sameRequest.second);
      expect(sameRequest.transaction).toEqual({
        proxy: sameRequest.first,
        transaction: sameRequest.first,
      });

      sharedEnv.REQUEST_ID = 'request-two';
      const nextRequest = await module.withEnv(sharedEnv, () => module.db.query('request-two'));
      expect(nextRequest).not.toBe(sameRequest.first);

      const localOwner = `${dialect}://local`;
      await expect(
        module.withEnv({ DATABASE_URL: localOwner, REQUEST_ID: 'local' }, () =>
          module.db.query('local'),
        ),
      ).resolves.toBeTypeOf('number');

      const explicitOwner = `${dialect}://explicit`;
      await expect(module.createDb(explicitOwner).query(explicitOwner)).resolves.toBeTypeOf(
        'number',
      );

      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
      const firstOverlap = module.withEnv(
        {
          HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
          REQUEST_ID: 'overlap-one',
        },
        async () => {
          const before = await module.db.query('overlap-one');
          await firstGate;
          const after = await module.db.query('overlap-one');
          return { before, after };
        },
      );
      const secondOverlap = module.withEnv(
        {
          HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
          REQUEST_ID: 'overlap-two',
        },
        async () => {
          const before = await module.db.query('overlap-two');
          await secondGate;
          const after = await module.db.query('overlap-two');
          return { before, after };
        },
      );
      releaseSecond();
      releaseFirst();
      const [overlapOne, overlapTwo] = await Promise.all([firstOverlap, secondOverlap]);
      expect(overlapOne.before).toBe(overlapOne.after);
      expect(overlapTwo.before).toBe(overlapTwo.after);
      expect(overlapOne.before).not.toBe(overlapTwo.before);

      let background!: Promise<number>;
      const responseInstance = await module.withEnv(
        {
          HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
          REQUEST_ID: 'background',
        },
        async () => {
          const instance = module.db.instanceId;
          background = new Promise((resolve, reject) => {
            setTimeout(() => module.db.query('background').then(resolve, reject), 0);
          });
          return instance;
        },
      );
      expect(await background).toBe(responseInstance);

      // MySQL createDb() builds its own pool through drizzle; the other pools are per request.
      const requestPools = state.pools.filter((pool) => pool.options.uri !== explicitOwner);
      expect(requestPools).toHaveLength(6);
      for (const pool of requestPools) {
        if (dialect === 'postgresql') {
          expect(pool.options).toMatchObject({ max: 1, idleTimeoutMillis: 1000 });
        } else {
          expect(pool.options).toMatchObject({ connectionLimit: 1, maxIdle: 1, idleTimeout: 1000 });
        }
      }
      if (dialect === 'mysql') {
        expect(state.pools).toHaveLength(7);
        expect(state.pools.find((pool) => pool.options.uri === explicitOwner)?.options).toEqual({
          uri: explicitOwner,
          disableEval: true,
        });
        for (const pool of state.pools) {
          expect(pool.options).toMatchObject({ disableEval: true });
          expect(pool.drizzleConfig).toEqual({ schema: expect.anything(), mode: 'default' });
        }
      }
    },
  );

  it('leaves the MySQL driver import to drizzle', () => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'mysql');
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;

    const code = load.call({}, '\0virtual:void-db');
    const specifiers = Array.from(
      code.matchAll(/\b(?:from|import)\s*\(?\s*("[^"]+")/g),
      (match) => JSON.parse(match[1]!) as string,
    );

    // The worker optimizer serves drizzle's bare mysql2 import from a prebundle; a direct import
    // by file path would reach workerd as raw CommonJS.
    expect(specifiers.filter((specifier) => specifier.includes('mysql2'))).toEqual([
      expect.stringMatching(/drizzle-orm[\\/]mysql2[\\/]/),
    ]);
  });

  it.each([true, false])(
    'gives drizzle a mysql2 pool with eval disabled (schema: %s)',
    async (hasSchema) => {
      const root = createProjectRoot({ schema: hasSchema });
      const plugin = drizzlePlugin(root, false, 'mysql', { forceVirtualDb: true });
      const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
      const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
      const code = load
        .call({}, '\0virtual:void-db')
        .replace(
          /^import \{ (getRuntimeBinding, getRuntimeRequestResource) \} from .*;$/m,
          (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
        );
      writeFileSync(join(root, 'virtual-db.mjs'), code);
      writeFileSync(
        join(root, 'harness.mjs'),
        `import { db, createDb } from "./virtual-db.mjs";
import { withRuntimeEnv } from ${JSON.stringify(envUrl)};
export { createDb };
export const requestClient = (env) => withRuntimeEnv(env, () => db.$client);
`,
      );
      type MySqlPool = { config: { connectionConfig: { disableEval: boolean } }; end(): void };
      const harness = (await import(
        `${pathToFileURL(join(root, 'harness.mjs')).href}?test=${crypto.randomUUID()}`
      )) as {
        createDb(url: string): { $client: MySqlPool };
        requestClient(env: Record<string, unknown>): MySqlPool;
      };

      const pools = [
        harness.createDb('mysql://void@127.0.0.1:9/app').$client,
        harness.requestClient({ DATABASE_URL: 'mysql://void@127.0.0.1:9/app' }),
      ];
      try {
        for (const pool of pools) {
          expect(pool.config.connectionConfig.disableEval).toBe(true);
        }
      } finally {
        for (const pool of pools) {
          pool.end?.();
        }
      }
    },
  );

  it('serves schema imports of void/db from an operator-only virtual module', () => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'sqlite');
    const schemaPath = join(root, 'db', 'schema.ts');
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', schemaPath, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db-schema');

    const code = load.call({}, '\0virtual:void-db-schema');
    expect(code).toContain('export const db = {};');
    expect(code).toContain(
      'export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max }',
    );
    expect(code).not.toContain('requireRuntimeBinding');
  });

  it('can virtualize void/db without a user schema when forced', () => {
    const root = createProjectRoot({ schema: false });
    const plugin = drizzlePlugin(root, false, 'postgresql', { forceVirtualDb: true });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', undefined, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('NodePgDatabase<Record<string, never>>');
    expect(dts).not.toContain('@schema');

    const tsconfig = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.paths['void/db']).toEqual(['./db.d.ts']);
    expect(tsconfig.compilerOptions.paths['@schema']).toBeUndefined();

    const code = load.call({}, '\0virtual:void-db');
    expect(code).toContain('import { drizzle } from "');
    expect(code).not.toContain('import * as schema');
    expect(code).toContain('return drizzle(pool)');
  });

  it('uses a custom D1 binding name in the sqlite virtual module', () => {
    const root = createProjectRoot({ schema: false });
    const plugin = drizzlePlugin(root, false, 'sqlite', {
      d1BindingName: 'myapp_db',
      forceVirtualDb: true,
    });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', undefined, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db');

    const code = load.call({}, '\0virtual:void-db');
    expect(code).toContain('requireRuntimeBinding("myapp_db")');
    expect(code).not.toContain('requireRuntimeBinding("DB")');
  });

  it('can keep void/db off tsconfig paths for metaframeworks that materialize aliases', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'sqlite', { redirectDbTypePaths: false });

    const tsconfig = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.paths['void/db']).toBeUndefined();
    expect(tsconfig.compilerOptions.paths['@schema']).toEqual(['../db/schema.ts']);
  });

  it('warns when a sqlite schema has neither migrations nor a pushed local database', async () => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'sqlite');
    const configureServer = getHookHandler(plugin.configureServer) as (
      server: unknown,
    ) => Promise<void>;

    await configureServer({ watcher: { on: vi.fn() } });

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('Schema found but no migrations in db/migrations/.'),
    );
  });

  it('does not warn after void db push has created local sqlite tables', async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, 'local-state');
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    } finally {
      db.close();
    }

    const plugin = drizzlePlugin(root, false, 'sqlite', { localD1PersistRoot: persistRoot });
    const configureServer = getHookHandler(plugin.configureServer) as (
      server: unknown,
    ) => Promise<void>;

    await configureServer({ watcher: { on: vi.fn() } });

    expect(warnMock).not.toHaveBeenCalled();
  });

  it('checks schema state using the configured local D1 database ID', async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, 'local-state');
    const databaseId = 'configured-preview-id';
    const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    } finally {
      db.close();
    }

    const plugin = drizzlePlugin(root, false, 'sqlite', {
      localD1DatabaseId: databaseId,
      localD1PersistRoot: persistRoot,
    });
    const configureServer = getHookHandler(plugin.configureServer) as (
      server: unknown,
    ) => Promise<void>;

    await configureServer({ watcher: { on: vi.fn() } });

    expect(warnMock).not.toHaveBeenCalled();
  });
});
