import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyMySqlMigrations,
  readMySqlAppliedMigrations,
  type MySqlClient,
} from '../../src/migrations/runner-mysql.ts';
import { runVoidAuthMigrations } from '../../src/runtime/better-auth-mysql.ts';
import { createMigrationHandler } from '../../src/runtime/migration-handler-mysql.ts';

const mysqlQueries = vi.hoisted(() => [] as Array<string>);
const mysqlConnections = vi.hoisted(() => [] as Array<unknown>);

vi.mock('mysql2/promise', () => ({
  createConnection: async (options: unknown) => {
    mysqlConnections.push(options);
    return {
      query: async (sql: string) => {
        mysqlQueries.push(sql);
        return [[]];
      },
      end: async () => {},
    };
  },
}));

describe('MySQL migration runner', () => {
  it('applies only pending migrations and records them with MySQL placeholders', async () => {
    const calls: Array<{ sql: string; params?: Array<unknown> }> = [];
    const client: MySqlClient = {
      async query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
        sql: string,
        params?: Array<unknown>,
      ): Promise<T> {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT')) {
          return [{ name: '001_initial.sql' }] as unknown as T;
        }
        return [] as unknown as T;
      },
    };

    const applied = await applyMySqlMigrations(client, [
      { name: '001_initial.sql', sql: 'CREATE TABLE existing (id INT)' },
      { name: '002_users.sql', sql: 'CREATE TABLE users (id INT)' },
    ]);

    expect(applied).toEqual(['002_users.sql']);
    expect(calls.some((call) => call.sql === 'CREATE TABLE existing (id INT)')).toBe(false);
    expect(calls).toContainEqual({ sql: 'CREATE TABLE users (id INT)', params: undefined });
    expect(calls).toContainEqual({
      sql: 'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
      params: ['002_users.sql', expect.any(String)],
    });
  });

  it('treats only a missing tracking table as empty history', async () => {
    const missingTableError = Object.assign(new Error('table not found'), {
      code: 'ER_NO_SUCH_TABLE',
      errno: 1146,
    });
    const missing: MySqlClient = {
      query: async () => {
        throw missingTableError;
      },
    };
    await expect(readMySqlAppliedMigrations(missing)).resolves.toEqual([]);

    const permissionError = Object.assign(new Error('permission denied'), {
      code: 'ER_TABLEACCESS_DENIED_ERROR',
      errno: 1142,
    });
    const denied: MySqlClient = {
      query: async () => {
        throw permissionError;
      },
    };
    await expect(readMySqlAppliedMigrations(denied)).rejects.toBe(permissionError);
  });

  it('runs each drizzle statement-breakpoint chunk as its own query', async () => {
    const sql =
      'CREATE TABLE `a` (`id` int);\n--> statement-breakpoint\nCREATE INDEX `a_id_idx` ON `a` (`id`);';
    const statements = ['CREATE TABLE `a` (`id` int);', 'CREATE INDEX `a_id_idx` ON `a` (`id`);'];
    const migrationQueries = (queries: Array<string>) =>
      queries.filter((query) => !query.includes('_void_migrations'));

    const calls: Array<string> = [];
    const client: MySqlClient = {
      async query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
        query: string,
      ): Promise<T> {
        calls.push(query);
        return [] as unknown as T;
      },
    };
    await applyMySqlMigrations(client, [{ name: '001_init.sql', sql }]);
    expect(migrationQueries(calls)).toEqual(statements);

    const handler = createMigrationHandler(
      { HYPERDRIVE: { connectionString: 'mysql://localhost/app' }, __VOID_PROXY_TOKEN: 'token' },
      [{ name: '001_init.sql', sql }],
    );
    const response = await handler(
      new Request('http://localhost/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': 'token' },
      }),
    );
    expect(await response.json()).toMatchObject({ ok: true });
    expect(migrationQueries(mysqlQueries)).toEqual(statements);
  });
});

describe('MySQL connections in Workers', () => {
  // Workers forbid eval, which mysql2 uses to build row parsers unless disableEval is set.
  it('opens the hosted migration connection with eval disabled', async () => {
    mysqlConnections.length = 0;
    const handler = createMigrationHandler(
      { HYPERDRIVE: { connectionString: 'mysql://localhost/app' }, __VOID_PROXY_TOKEN: 'token' },
      [],
    );
    const response = await handler(
      new Request('http://localhost/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': 'token' },
      }),
    );
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mysqlConnections).toEqual([
      { uri: 'mysql://localhost/app', multipleStatements: true, disableEval: true },
    ]);
  });

  it('opens the Better Auth migration connection with eval disabled', async () => {
    mysqlConnections.length = 0;
    await runVoidAuthMigrations(
      { DATABASE_URL: 'mysql://localhost/auth' },
      { dialect: 'mysql', providers: null },
      { dialect: 'mysql', idStrategy: 'text', tables: [] },
    );
    expect(mysqlConnections).toEqual([{ uri: 'mysql://localhost/auth', disableEval: true }]);
  });
});
