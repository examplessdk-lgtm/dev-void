import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  applyMySqlMigrations,
  readMySqlAppliedMigrations,
  type MySqlClient,
} from '../../src/migrations/runner-mysql.ts';
import { runVoidAuthMigrations } from '../../src/runtime/better-auth-mysql.ts';
import { createMigrationHandler } from '../../src/runtime/migration-handler-mysql.ts';

const mysqlConnections = vi.hoisted(() => [] as Array<unknown>);
const mysqlServer = vi.hoisted(() => ({ database: undefined as unknown }));

// Every connection the hosted handler opens reaches the test's FakeMySqlDatabase.
vi.mock('mysql2/promise', () => ({
  createConnection: async (options: unknown) => {
    mysqlConnections.push(options);
    const database = mysqlServer.database as FakeMySqlDatabase;
    const session = database.connect({ database: database.handlerDatabase });
    return {
      query: async (sql: string, params?: Array<unknown>) => [
        await database.query(session, sql, params),
      ],
      end: async () => database.disconnect(session),
    };
  },
}));

const LOCK_NAME = `void_migrations:${createHash('sha1').update('app').digest('hex')}`;
const CONTROL =
  /^(BEGIN|COMMIT|ROLLBACK)$|SAVEPOINT|GET_LOCK|RELEASE_LOCK|IS_USED_LOCK|DATABASE\(\)|_void_migration_lock/;

function mySqlError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `expiresAt` is the stored DATETIME, which has no time zone, in milliseconds. */
type Lease = { owner: string; expiresAt: number };
type Session = { utcOffsetMs?: number; database?: string };

/**
 * One MySQL database shared by every connection and client of a test. It keeps the tracking rows,
 * the deploy lease and named locks, and logs each statement with its session and time.
 * `SELECT SLEEP(n)` waits n seconds, so runs can overlap. Each session has a time zone, which
 * NOW(6) follows and UTC_TIMESTAMP(6) does not, and the name DATABASE() reports.
 */
class FakeMySqlDatabase {
  readonly log: Array<{ session: number; sql: string; at: number }> = [];
  readonly failures = new Map<string, Error>();
  /** Statements that fail on their next run only, keyed by their first characters. */
  readonly failOnce = new Map<string, Error>();
  readonly applied: Array<string> = [];
  lease: Lease | undefined;
  /** DATABASE() for the sessions the hosted handler opens. */
  readonly handlerDatabase: string;
  private leaseTable = false;
  private readonly locks = new Map<string, number>();
  private readonly sessions: Array<Session> = [];

  constructor(options: { lease?: Lease; handlerDatabase?: string } = {}) {
    this.lease = options.lease;
    this.leaseTable = options.lease !== undefined;
    this.handlerDatabase = options.handlerDatabase ?? 'app';
  }

  connect(session: Session = {}): number {
    return this.sessions.push(session);
  }

  disconnect(session: number): void {
    for (const [name, holder] of this.locks) {
      if (holder === session) {
        this.locks.delete(name);
      }
    }
  }

  client(options: { utcOffsetMs?: number } = {}): MySqlClient {
    const session = this.connect(options);
    return {
      query: async <T extends Array<Record<string, unknown>>>(
        sql: string,
        params?: Array<unknown>,
      ) => {
        const result = await this.query(session, sql, params);
        return (Array.isArray(result) ? result : []) as T;
      },
    };
  }

  statements(session?: number): Array<string> {
    return this.log
      .filter((entry) => session === undefined || entry.session === session)
      .map((entry) => entry.sql);
  }

  async query(session: number, sql: string, params: Array<unknown> = []): Promise<unknown> {
    this.log.push({ session, sql, at: Date.now() });
    const failure = this.failures.get(sql);
    if (failure) {
      throw failure;
    }
    for (const [prefix, error] of this.failOnce) {
      if (sql.startsWith(prefix)) {
        this.failOnce.delete(prefix);
        throw error;
      }
    }
    const sleep = /^SELECT SLEEP\((\d+(?:\.\d+)?)\)/.exec(sql);
    if (sleep) {
      await new Promise((resolve) => setTimeout(resolve, Number(sleep[1]) * 1000));
      return [{ slept: 0 }];
    }
    const name = String(params[0]);
    if (sql === 'SELECT DATABASE() AS db') {
      return [{ db: this.sessions[session - 1]!.database ?? 'app' }];
    }
    if (sql.startsWith('SELECT GET_LOCK')) {
      const holder = this.locks.get(name);
      if (holder !== undefined && holder !== session) {
        return [{ acquired: 0 }];
      }
      this.locks.set(name, session);
      return [{ acquired: 1 }];
    }
    if (sql.startsWith('SELECT RELEASE_LOCK')) {
      if (this.locks.get(name) === session) {
        this.locks.delete(name);
      }
      return [{ released: 1 }];
    }
    if (sql.startsWith('SELECT IS_USED_LOCK')) {
      return [{ [`IS_USED_LOCK('${name}')`]: this.locks.get(name) ?? null }];
    }
    if (sql.includes('`_void_migration_lock`')) {
      return this.leaseStatement(session, sql, params);
    }
    if (sql === 'SELECT `name` FROM `_void_migrations`') {
      return this.applied.map((applied) => ({ name: applied }));
    }
    if (sql.startsWith('INSERT INTO `_void_migrations`')) {
      if (this.applied.includes(name)) {
        throw mySqlError(`Duplicate entry '${name}' for key 'PRIMARY'`, 'ER_DUP_ENTRY');
      }
      this.applied.push(name);
    }
    return /^\s*SELECT\b/i.test(sql) ? [] : { affectedRows: 1 };
  }

  private leaseStatement(session: number, sql: string, params: Array<unknown>): unknown {
    const now = Date.now();
    const clock = /UTC_TIMESTAMP\(6\)/.test(sql)
      ? now
      : now + (this.sessions[session - 1]!.utcOffsetMs ?? 0);
    // The statement's own expiry filter, if it has one.
    const filter = /`expires_at` ([<>]) (?:NOW|UTC_TIMESTAMP)\(6\)/.exec(sql)?.[1];
    const matches = (lease: Lease) =>
      filter === undefined || (filter === '<' ? lease.expiresAt < clock : lease.expiresAt > clock);
    if (sql.startsWith('CREATE TABLE')) {
      this.leaseTable = true;
      return { affectedRows: 0 };
    }
    if (!this.leaseTable) {
      throw mySqlError("Table 'app._void_migration_lock' doesn't exist", 'ER_NO_SUCH_TABLE');
    }
    if (sql.startsWith('SELECT TIMESTAMPDIFF')) {
      return this.lease && matches(this.lease)
        ? [{ remaining: Math.floor((this.lease.expiresAt - clock) / 1000) }]
        : [];
    }
    if (sql.startsWith('INSERT IGNORE')) {
      if (this.lease) {
        return { affectedRows: 0 };
      }
      this.lease = { owner: String(params[0]), expiresAt: clock + Number(params[1]) * 1000 };
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE') && sql.includes('SET `owner`')) {
      if (!this.lease || !matches(this.lease)) {
        return { affectedRows: 0 };
      }
      this.lease = { owner: String(params[0]), expiresAt: clock + Number(params[1]) * 1000 };
      return { affectedRows: 1 };
    }
    // The release keeps the row and moves its expiry into the past.
    if (sql.startsWith('UPDATE') && sql.includes('- INTERVAL 1 SECOND')) {
      if (!this.lease || this.lease.owner !== params[0]) {
        return { affectedRows: 0 };
      }
      this.lease.expiresAt = clock - 1000;
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE')) {
      if (!this.lease || !matches(this.lease) || this.lease.owner !== params[1]) {
        return { affectedRows: 0 };
      }
      this.lease.expiresAt = clock + Number(params[0]) * 1000;
      return { affectedRows: 1 };
    }
    throw new Error(`unexpected lease statement: ${sql}`);
  }
}

function useDatabase(database: FakeMySqlDatabase): FakeMySqlDatabase {
  mysqlServer.database = database;
  return database;
}

beforeEach(() => {
  mysqlConnections.length = 0;
  useDatabase(new FakeMySqlDatabase());
});

async function migrate(
  migrations: Array<{ name: string; sql: string }>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = createMigrationHandler(
    { HYPERDRIVE: { connectionString: 'mysql://localhost/app' }, __VOID_PROXY_TOKEN: 'token' },
    migrations,
  );
  const response = await handler(
    new Request('http://localhost/__void/migrate', {
      method: 'POST',
      headers: { 'x-void-internal': 'token' },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Runs `start` to its end while fake time moves on one second at a time. */
async function withFakeTime<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let settled = false;
    const promise = start().finally(() => {
      settled = true;
    });
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1000);
    }
    return await promise;
  } finally {
    vi.useRealTimers();
  }
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

    const database = useDatabase(new FakeMySqlDatabase());
    expect((await migrate([{ name: '001_init.sql', sql }])).body).toMatchObject({ ok: true });
    expect(migrationQueries(database.statements())).toEqual(statements);
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
      (query) =>
        !/GET_LOCK|DATABASE\(\)|CREATE TABLE IF NOT EXISTS|SELECT `name`|_void_migration_lock/.test(
          query,
        ),
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
    const database = useDatabase(new FakeMySqlDatabase());
    database.failures.set(
      'INSERT INTO nope VALUES (1);',
      mySqlError("Table 'app.nope' doesn't exist", 'ER_NO_SUCH_TABLE'),
    );

    const { body } = await migrate([
      { name: '001_init.sql', sql: 'CREATE TABLE c (n INT);' },
      {
        name: '002_backfill.sql',
        sql: 'UPDATE c SET n = n + 1;\n--> statement-breakpoint\nINSERT INTO nope VALUES (1);',
      },
    ]);

    expect(body).toMatchObject({
      ok: false,
      error: 'migration 002_backfill.sql failed',
      migrations: [
        { name: '001_init.sql', applied: true },
        { name: '002_backfill.sql', applied: false, error: "Table 'app.nope' doesn't exist" },
      ],
    });
    // Session 1 runs the migrations; the lease uses its own connection.
    expect(database.statements(1).slice(2)).toEqual([
      'BEGIN',
      'CREATE TABLE c (n INT);',
      'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
      'COMMIT',
      'BEGIN',
      'UPDATE c SET n = n + 1;',
      'INSERT INTO nope VALUES (1);',
      'ROLLBACK',
    ]);
  });

  it('names the failed file when the rollback fails too', async () => {
    const database = useDatabase(new FakeMySqlDatabase());
    database.failures.set(
      'UPDATE c SET n = n + 1;',
      mySqlError('Connection lost: The server closed the connection.', 'PROTOCOL_CONNECTION_LOST'),
    );
    database.failures.set(
      'ROLLBACK',
      new Error("Can't add new command when connection is in closed state"),
    );

    const { body } = await migrate([
      { name: '001_init.sql', sql: 'CREATE TABLE c (n INT);' },
      { name: '002_backfill.sql', sql: 'UPDATE c SET n = n + 1;' },
    ]);

    expect(body).toMatchObject({
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
  });
});

// The CLI runner holds a named lock; a deploy, which reaches MySQL through Hyperdrive, holds a
// lease row. Each checks for the other, so runs on one database never apply a file twice.
describe('MySQL migration lock across runners', () => {
  const RACE = [
    {
      name: '0001_seed.sql',
      sql: 'SELECT SLEEP(0.2);\n--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS roles (name TEXT);\n--> statement-breakpoint\nINSERT INTO roles VALUES (1);',
    },
  ];
  const seeded = (database: FakeMySqlDatabase) =>
    database.statements().filter((sql) => sql === 'INSERT INTO roles VALUES (1);').length;

  it('applies a pending file once when two deploys share a database', async () => {
    const { database, bodies, finishedAt } = await withFakeTime(async () => {
      const database = useDatabase(new FakeMySqlDatabase());
      // The second starts while the first sleeps, before either has recorded the file.
      const first = migrate(RACE);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const results = await Promise.all([first, migrate(RACE)]);
      return { database, bodies: results.map((result) => result.body), finishedAt: Date.now() };
    });

    expect(seeded(database)).toBe(1);
    expect(bodies.map((body) => body.ok)).toEqual([true, true]);
    // Released by expiring the row: the next run's INSERT IGNORE finds it and takes it over.
    expect(database.lease?.expiresAt).toBeLessThan(finishedAt);
  });

  it('applies a pending file once when a CLI run and a deploy share a database', async () => {
    const { database, cli, deploy } = await withFakeTime(async () => {
      const database = useDatabase(new FakeMySqlDatabase());
      const [cli, deploy] = await Promise.all([
        applyMySqlMigrations(database.client(), RACE),
        migrate(RACE),
      ]);
      return { database, cli, deploy };
    });

    expect(seeded(database)).toBe(1);
    expect(deploy.body.ok).toBe(true);
    expect(cli).toEqual(['0001_seed.sql']);
  });

  // Vitess reports a connection's target in DATABASE(): Hyperdrive may connect to `app@primary`
  // while the CLI connects to `app`.
  it('makes a deploy wait for a CLI run that names a Vitess target', async () => {
    const { database, deploy } = await withFakeTime(async () => {
      const database = useDatabase(new FakeMySqlDatabase({ handlerDatabase: 'app@primary' }));
      const [, deploy] = await Promise.all([
        applyMySqlMigrations(database.client(), RACE),
        new Promise((resolve) => setTimeout(resolve, 100)).then(() => migrate(RACE)),
      ]);
      return { database, deploy };
    });

    expect(seeded(database)).toBe(1);
    expect(deploy.body.ok).toBe(true);
  });

  it('stops a CLI run while a deploy holds the lease', async () => {
    const error = await withFakeTime(async () => {
      const database = useDatabase(
        new FakeMySqlDatabase({ lease: { owner: 'deploy', expiresAt: Date.now() + 100_000 } }),
      );
      const failure = await applyMySqlMigrations(database.client(), RACE).catch(
        (caught: unknown) => caught,
      );
      expect(database.statements()).not.toContain('SELECT `name` FROM `_void_migrations`');
      expect(database.statements().at(-1)).toBe('SELECT RELEASE_LOCK(?)');
      return failure;
    });

    expect((error as Error).message).toBe(
      'A deploy is applying migrations to MySQL database "app". Wait for it to finish, then run the command again. If that deploy stopped, its lock expires in 90 seconds.',
    );
  });

  it('stops a CLI run while a deploy holds the lease in another time zone', async () => {
    const error = await withFakeTime(async () => {
      const database = useDatabase(
        new FakeMySqlDatabase({ lease: { owner: 'deploy', expiresAt: Date.now() + 100_000 } }),
      );
      const failure = await applyMySqlMigrations(
        database.client({ utcOffsetMs: 9 * 3_600_000 }),
        RACE,
      ).catch((caught: unknown) => caught);
      expect(database.statements()).not.toContain('SELECT `name` FROM `_void_migrations`');
      return failure;
    });

    expect((error as Error).message).toBe(
      'A deploy is applying migrations to MySQL database "app". Wait for it to finish, then run the command again. If that deploy stopped, its lock expires in 90 seconds.',
    );
  });

  it('lets a CLI run apply after a deploy released its lease', async () => {
    const applied = await withFakeTime(async () => {
      const database = useDatabase(
        new FakeMySqlDatabase({ lease: { owner: 'done', expiresAt: Date.now() - 1000 } }),
      );
      return await applyMySqlMigrations(database.client(), [
        { name: '0001_a.sql', sql: 'CREATE TABLE a (id INT)' },
      ]);
    });

    expect(applied).toEqual(['0001_a.sql']);
  });

  it('makes a deploy wait for the lease of a run that stopped early to expire', async () => {
    const { database, expiresAt, finishedAt, result } = await withFakeTime(async () => {
      const expiresAt = Date.now() + 30_000;
      const database = useDatabase(new FakeMySqlDatabase({ lease: { owner: 'gone', expiresAt } }));
      const result = await migrate(RACE);
      return { database, expiresAt, finishedAt: Date.now(), result };
    });

    expect(result.body.ok).toBe(true);
    const seededAt = database.log.find((entry) => entry.sql === 'INSERT INTO roles VALUES (1);');
    expect(seededAt?.at).toBeGreaterThanOrEqual(expiresAt);
    expect(database.lease?.owner).not.toBe('gone');
    expect(database.lease?.expiresAt).toBeLessThan(finishedAt);
  });

  it('keeps waiting when MySQL ends its lease insert as a deadlock victim', async () => {
    const { database, result } = await withFakeTime(async () => {
      const database = useDatabase(new FakeMySqlDatabase());
      database.failOnce.set(
        'INSERT IGNORE',
        Object.assign(
          mySqlError(
            'Deadlock found when trying to get lock; try restarting transaction',
            'ER_LOCK_DEADLOCK',
          ),
          { errno: 1213 },
        ),
      );
      return { database, result: await migrate(RACE) };
    });

    expect(result.body.ok).toBe(true);
    expect(seeded(database)).toBe(1);
  });

  it('fails a deploy that waited too long for another run', async () => {
    const { database, result } = await withFakeTime(async () => {
      const database = useDatabase(
        new FakeMySqlDatabase({ lease: { owner: 'other', expiresAt: Date.now() + 3_600_000 } }),
      );
      return { database, result: await migrate(RACE) };
    });

    expect(result).toEqual({
      status: 500,
      body: {
        ok: false,
        error:
          'Another migration run is applying migrations to MySQL database "app". Wait for it to finish, then deploy again.',
        migrations: [],
      },
    });
    expect(seeded(database)).toBe(0);
    expect(database.lease?.owner).toBe('other');
  });

  // Hyperdrive ends statements after 60 seconds, so this only happens if that limit changes.
  it('stops a deploy whose lease expired during a statement', async () => {
    const { database, result } = await withFakeTime(async () => {
      const database = useDatabase(new FakeMySqlDatabase());
      const result = await migrate([
        {
          name: '0001_slow.sql',
          sql: 'SELECT SLEEP(200);\n--> statement-breakpoint\nUPDATE c SET n = n + 1;',
        },
      ]);
      return { database, result };
    });

    expect(result.body).toMatchObject({
      ok: false,
      migrations: [
        {
          name: '0001_slow.sql',
          applied: false,
          error:
            'The migration lock on MySQL database "app" expired before this run finished. Deploy again.',
        },
      ],
    });
    expect(database.statements()).not.toContain('UPDATE c SET n = n + 1;');
  });
});

describe('MySQL connections in Workers', () => {
  // Workers forbid eval, which mysql2 uses to build row parsers unless disableEval is set.
  it('opens the hosted migration connections with eval disabled', async () => {
    expect((await migrate([])).body).toMatchObject({ ok: true });
    expect(mysqlConnections).toEqual([
      { uri: 'mysql://localhost/app', multipleStatements: true, disableEval: true },
      { uri: 'mysql://localhost/app', disableEval: true },
    ]);
  });

  it('opens the Better Auth migration connection with eval disabled', async () => {
    await runVoidAuthMigrations(
      { DATABASE_URL: 'mysql://localhost/auth' },
      { dialect: 'mysql', providers: null },
      { dialect: 'mysql', idStrategy: 'text', tables: [] },
    );
    expect(mysqlConnections).toEqual([{ uri: 'mysql://localhost/auth', disableEval: true }]);
  });
});
