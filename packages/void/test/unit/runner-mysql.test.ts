import { createHash } from 'node:crypto';
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
const mysqlFailures = vi.hoisted(() => new Map<string, Error>());

vi.mock('mysql2/promise', () => ({
  createConnection: async (options: unknown) => {
    mysqlConnections.push(options);
    return {
      query: async (sql: string) => {
        mysqlQueries.push(sql);
        const failure = mysqlFailures.get(sql);
        if (failure) {
          throw failure;
        }
        return [[]];
      },
      end: async () => {},
    };
  },
}));

const LOCK_NAME = `void_migrations:${createHash('sha1').update('app').digest('hex')}`;
const CONTROL = /^(BEGIN|COMMIT|ROLLBACK)$|SAVEPOINT|GET_LOCK|RELEASE_LOCK|DATABASE\(\)/;

function mySqlError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * A client for `applyMySqlMigrations`. It owns database `app`, grants the lock unless `locked`,
 * and throws for statements in `failures`. With `committed`, MySQL has already committed the
 * open transaction (after DDL), so rolling back to a savepoint fails as it does in MySQL.
 */
function fakeClient(
  options: {
    applied?: Array<string>;
    failures?: Record<string, Error>;
    locked?: boolean;
    committed?: boolean;
  } = {},
) {
  const calls: Array<{ sql: string; params?: Array<unknown> }> = [];
  const client: MySqlClient = {
    async query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
      sql: string,
      params?: Array<unknown>,
    ): Promise<T> {
      calls.push({ sql, params });
      const failure = options.failures?.[sql];
      if (failure) {
        throw failure;
      }
      if (sql === 'SELECT DATABASE() AS db') {
        return [{ db: 'app' }] as unknown as T;
      }
      if (sql.startsWith('SELECT GET_LOCK')) {
        return [{ acquired: options.locked ? 0 : 1 }] as unknown as T;
      }
      if (sql === 'SELECT `name` FROM `_void_migrations`') {
        return (options.applied ?? []).map((name) => ({ name })) as unknown as T;
      }
      if (sql.startsWith('ROLLBACK TO SAVEPOINT') && options.committed) {
        throw mySqlError('SAVEPOINT void_migration does not exist', 'ER_SP_DOES_NOT_EXIST');
      }
      return [] as unknown as T;
    },
  };
  return { client, calls, sql: () => calls.map((call) => call.sql) };
}

describe('MySQL migration runner', () => {
  it('applies only pending migrations and records them with MySQL placeholders', async () => {
    const { client, calls } = fakeClient({ applied: ['001_initial.sql'] });

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
      queries.filter((query) => !query.includes('_void_migrations') && !CONTROL.test(query));

    const { client, sql: calls } = fakeClient();
    await applyMySqlMigrations(client, [{ name: '001_init.sql', sql }]);
    expect(migrationQueries(calls())).toEqual(statements);

    mysqlQueries.length = 0;
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

  // Two runs at once would both apply a pending data migration.
  it('holds a named lock for the database while it reads and applies migrations', async () => {
    const { client, calls, sql } = fakeClient();

    await applyMySqlMigrations(client, [{ name: '001_bump.sql', sql: 'UPDATE c SET n = n + 1' }]);

    expect(calls[1]).toEqual({ sql: 'SELECT GET_LOCK(?, ?) AS acquired', params: [LOCK_NAME, 10] });
    expect(sql().indexOf('SELECT `name` FROM `_void_migrations`')).toBeGreaterThan(1);
    expect(calls.at(-1)).toEqual({ sql: 'SELECT RELEASE_LOCK(?)', params: [LOCK_NAME] });
  });

  // Vitess (PlanetScale) names the GET_LOCK column after the call and ignores the alias.
  it('takes the lock when the server ignores the column alias', async () => {
    const client: MySqlClient = {
      async query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
        sql: string,
      ): Promise<T> {
        if (sql === 'SELECT DATABASE() AS db') {
          return [{ db: 'app' }] as unknown as T;
        }
        if (sql.startsWith('SELECT GET_LOCK')) {
          return [{ [`get_lock('${LOCK_NAME}', 10)`]: 1 }] as unknown as T;
        }
        return [] as unknown as T;
      },
    };

    await expect(
      applyMySqlMigrations(client, [{ name: '001_bump.sql', sql: 'UPDATE c SET n = n + 1' }]),
    ).resolves.toEqual(['001_bump.sql']);
  });

  it('stops before reading or applying migrations when another run holds the lock', async () => {
    const { client, sql } = fakeClient({ locked: true });

    await expect(
      applyMySqlMigrations(client, [{ name: '001_bump.sql', sql: 'UPDATE c SET n = n + 1' }]),
    ).rejects.toThrow(
      'Another migration run is applying migrations to MySQL database "app". Wait for it to finish, then run the command again.',
    );
    expect(sql()).toEqual(['SELECT DATABASE() AS db', 'SELECT GET_LOCK(?, ?) AS acquired']);
  });

  it('commits each file with its tracking row and rolls back a failed file', async () => {
    const cause = mySqlError("Table 'app.nope' doesn't exist", 'ER_NO_SUCH_TABLE');
    const { client, sql } = fakeClient({ failures: { 'INSERT INTO nope VALUES (1);': cause } });

    const error = await applyMySqlMigrations(client, [
      { name: '001_init.sql', sql: 'CREATE TABLE c (n INT);' },
      {
        name: '002_backfill.sql',
        sql: 'UPDATE c SET n = n + 1;\n--> statement-breakpoint\nINSERT INTO nope VALUES (1);',
      },
    ]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "migration 002_backfill.sql failed: Table 'app.nope' doesn't exist",
    );
    expect((error as Error).cause).toBe(cause);
    const migrationQueries = sql().filter(
      (query) => !/GET_LOCK|DATABASE\(\)|CREATE TABLE IF NOT EXISTS|SELECT `name`/.test(query),
    );
    expect(migrationQueries).toEqual([
      'BEGIN',
      'CREATE TABLE c (n INT);',
      'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
      'COMMIT',
      'BEGIN',
      'UPDATE c SET n = n + 1;',
      'INSERT INTO nope VALUES (1);',
      'SAVEPOINT `void_migration`',
      'ROLLBACK TO SAVEPOINT `void_migration`',
      'ROLLBACK',
      'SELECT RELEASE_LOCK(?)',
    ]);
  });

  it('says how to repair a file whose earlier statements MySQL already committed', async () => {
    const cause = mySqlError(
      "Key column 'nope' doesn't exist in table",
      'ER_KEY_COLUMN_DOES_NOT_EXITS',
    );
    const { client } = fakeClient({
      committed: true,
      failures: { 'ALTER TABLE c ADD INDEX i (nope);': cause },
    });

    await expect(
      applyMySqlMigrations(client, [
        {
          name: '002_comments.sql',
          sql: 'CREATE TABLE comments (id INT);\n--> statement-breakpoint\nALTER TABLE c ADD INDEX i (nope);',
        },
      ]),
    ).rejects.toThrow(
      [
        "migration 002_comments.sql failed: Key column 'nope' doesn't exist in table",
        'MySQL commits schema changes immediately, so earlier statements in 002_comments.sql may already be applied. Undo them, fix the file, then run the command again.',
        'See https://void.cloud/guide/database/mysql#failed-migrations',
      ].join('\n'),
    );
  });

  it('does not warn about earlier statements when the first statement fails', async () => {
    const cause = mySqlError("Duplicate column name 'n'", 'ER_DUP_FIELDNAME');
    const { client, sql } = fakeClient({
      committed: true,
      failures: { 'ALTER TABLE c ADD COLUMN n INT;': cause },
    });

    await expect(
      applyMySqlMigrations(client, [
        { name: '002_dup.sql', sql: 'ALTER TABLE c ADD COLUMN n INT;' },
      ]),
    ).rejects.toThrow(/^migration 002_dup\.sql failed: Duplicate column name 'n'$/);
    expect(sql()).not.toContain('SAVEPOINT `void_migration`');
  });

  // MySQL rolls back the whole transaction itself here, so the file left nothing behind.
  it.each([
    {
      failing: 'UPDATE d SET n = n + 1;',
      cause: Object.assign(
        mySqlError(
          'Deadlock found when trying to get lock; try restarting transaction',
          'ER_LOCK_DEADLOCK',
        ),
        { errno: 1213 },
      ),
    },
    {
      failing: 'COMMIT',
      cause: Object.assign(
        mySqlError(
          'Plugin instructed the server to rollback the current transaction.',
          'ER_TRANSACTION_ROLLBACK_DURING_COMMIT',
        ),
        { errno: 3101 },
      ),
    },
  ])(
    'does not warn about earlier statements when MySQL rolled back $cause.code',
    async ({ failing, cause }) => {
      const { client, sql } = fakeClient({ committed: true, failures: { [failing]: cause } });

      const error = await applyMySqlMigrations(client, [
        {
          name: '002_backfill.sql',
          sql: 'UPDATE c SET n = n + 1;\n--> statement-breakpoint\nUPDATE d SET n = n + 1;',
        },
      ]).catch((caught: unknown) => caught);

      expect((error as Error).message).toBe(`migration 002_backfill.sql failed: ${cause.message}`);
      expect((error as Error).cause).toBe(cause);
      expect(sql()).toContain('ROLLBACK');
    },
  );

  // A lost connection makes ROLLBACK fail too; the error must still name the file.
  it('names the failed file when the rollback fails too', async () => {
    const cause = mySqlError(
      'Connection lost: The server closed the connection.',
      'PROTOCOL_CONNECTION_LOST',
    );
    const { client, sql } = fakeClient({
      failures: {
        'UPDATE c SET n = n + 1;': cause,
        ROLLBACK: new Error("Can't add new command when connection is in closed state"),
      },
    });

    const error = await applyMySqlMigrations(client, [
      { name: '002_backfill.sql', sql: 'UPDATE c SET n = n + 1;' },
    ]).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(`migration 002_backfill.sql failed: ${cause.message}`);
    expect((error as Error).cause).toBe(cause);
    expect(sql().at(-1)).toBe('SELECT RELEASE_LOCK(?)');
  });
});

describe('MySQL hosted migration handler', () => {
  it('commits each file with its tracking row and rolls back a failed file', async () => {
    mysqlQueries.length = 0;
    mysqlFailures.set(
      'INSERT INTO nope VALUES (1);',
      mySqlError("Table 'app.nope' doesn't exist", 'ER_NO_SUCH_TABLE'),
    );
    try {
      const handler = createMigrationHandler(
        { HYPERDRIVE: { connectionString: 'mysql://localhost/app' }, __VOID_PROXY_TOKEN: 'token' },
        [
          { name: '001_init.sql', sql: 'CREATE TABLE c (n INT);' },
          {
            name: '002_backfill.sql',
            sql: 'UPDATE c SET n = n + 1;\n--> statement-breakpoint\nINSERT INTO nope VALUES (1);',
          },
        ],
      );
      const response = await handler(
        new Request('http://localhost/__void/migrate', {
          method: 'POST',
          headers: { 'x-void-internal': 'token' },
        }),
      );

      expect(await response.json()).toMatchObject({
        ok: false,
        error: 'migration 002_backfill.sql failed',
        migrations: [
          { name: '001_init.sql', applied: true },
          { name: '002_backfill.sql', applied: false, error: "Table 'app.nope' doesn't exist" },
        ],
      });
      expect(mysqlQueries.slice(2)).toEqual([
        'BEGIN',
        'CREATE TABLE c (n INT);',
        'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
        'COMMIT',
        'BEGIN',
        'UPDATE c SET n = n + 1;',
        'INSERT INTO nope VALUES (1);',
        'ROLLBACK',
      ]);
    } finally {
      mysqlFailures.clear();
    }
  });

  it('names the failed file when the rollback fails too', async () => {
    mysqlFailures.set(
      'UPDATE c SET n = n + 1;',
      mySqlError('Connection lost: The server closed the connection.', 'PROTOCOL_CONNECTION_LOST'),
    );
    mysqlFailures.set(
      'ROLLBACK',
      new Error("Can't add new command when connection is in closed state"),
    );
    try {
      const handler = createMigrationHandler(
        { HYPERDRIVE: { connectionString: 'mysql://localhost/app' }, __VOID_PROXY_TOKEN: 'token' },
        [
          { name: '001_init.sql', sql: 'CREATE TABLE c (n INT);' },
          { name: '002_backfill.sql', sql: 'UPDATE c SET n = n + 1;' },
        ],
      );
      const response = await handler(
        new Request('http://localhost/__void/migrate', {
          method: 'POST',
          headers: { 'x-void-internal': 'token' },
        }),
      );

      expect(await response.json()).toMatchObject({
        ok: false,
        error: 'migration 002_backfill.sql failed',
        migrations: [
          { name: '001_init.sql', applied: true },
          {
            name: '002_backfill.sql',
            applied: false,
            error: 'Connection lost: The server closed the connection.',
          },
        ],
      });
    } finally {
      mysqlFailures.clear();
    }
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
