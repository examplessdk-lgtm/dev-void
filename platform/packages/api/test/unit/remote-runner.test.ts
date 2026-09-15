import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  runRemoteMigrations,
  isSingleStatement,
  queryD1,
} from '../../src/migrations/remote-runner.ts';

const ACCOUNT_ID = 'test-account';
const API_TOKEN = 'test-token';
const DATABASE_ID = 'd1-uuid-123';

// Track all queries made to D1
let queries: Array<{ sql: string; params?: Array<unknown> }> = [];

// Applied migrations state (simulates _void_migrations table)
let appliedMigrations: Array<string> = [];

// Whether the legacy `_migrations` table exists (for upgrade tests)
let hasLegacyTable = false;
let legacyMigrations: Array<string> = [];

// SQL strings that should trigger a failure response. Map from a substring
// match (or regex) to the error message to return. `beforeFail` is an optional
// side-effect hook fired once per match — used to simulate state changes (e.g.
// a concurrent winner inserting a tracking row) before the loser's request is
// rejected.
let failingSql: Array<{
  match: string | RegExp;
  message: string;
  beforeFail?: () => void;
}> = [];

beforeEach(() => {
  queries = [];
  appliedMigrations = [];
  hasLegacyTable = false;
  legacyMigrations = [];
  failingSql = [];
  vi.restoreAllMocks();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sql: string; params?: Array<unknown> };
      queries.push(body);

      const failure = failingSql.find((f) =>
        typeof f.match === 'string' ? body.sql?.includes(f.match) : f.match.test(body.sql ?? ''),
      );
      if (failure) {
        failure.beforeFail?.();
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: failure.message }],
            result: [],
          }),
        );
      }

      // Tracking INSERT from runRemoteMigrations uses INSERT OR IGNORE ... VALUES.
      // Distinguish from the legacy upgrade path, which uses FROM _migrations.
      if (
        body.sql?.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        body.sql?.includes('VALUES')
      ) {
        if (!appliedMigrations.includes(body.params![0] as string)) {
          appliedMigrations.push(body.params![0] as string);
        }
      }

      if (body.sql === 'SELECT name FROM _void_migrations') {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: appliedMigrations.map((name) => ({ name })) }],
          }),
        );
      }

      // Multi-statement recovery recheck: runRemoteMigrations re-queries the
      // tracking table after an "already exists" error to distinguish a true
      // concurrent winner from an unrecoverable partial commit. Match the
      // current state of `appliedMigrations`, not the stale preflight set.
      if (body.sql === 'SELECT name FROM _void_migrations WHERE name = ?') {
        const name = body.params?.[0] as string | undefined;
        const found = name !== undefined && appliedMigrations.includes(name) ? [{ name }] : [];
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: found }],
          }),
        );
      }

      // sqlite_master check for legacy table
      if (body.sql?.includes('sqlite_master') && body.sql?.includes("'_migrations'")) {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [
              {
                results: hasLegacyTable ? [{ name: '_migrations' }] : [],
              },
            ],
          }),
        );
      }

      // INSERT OR IGNORE from legacy table — simulate copying rows
      if (
        body.sql?.includes('INSERT OR IGNORE INTO _void_migrations') &&
        body.sql?.includes('FROM _migrations')
      ) {
        appliedMigrations.push(...legacyMigrations);
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: [] }],
          }),
        );
      }

      // DROP TABLE _migrations
      if (body.sql?.includes('DROP TABLE _migrations')) {
        hasLegacyTable = false;
        legacyMigrations = [];
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: [] }],
          }),
        );
      }

      // Default success response
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [{ results: [] }],
        }),
      );
    }),
  );
});

describe('runRemoteMigrations', () => {
  it('creates _void_migrations table, checks for legacy table, and queries applied', async () => {
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    expect(queries[0]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining('CREATE TABLE IF NOT EXISTS _void_migrations'),
      }),
    );
    // Upgrade check: query sqlite_master for legacy _migrations table
    expect(queries[1]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining('sqlite_master'),
      }),
    );
    expect(queries[2]).toEqual(
      expect.objectContaining({ sql: 'SELECT name FROM _void_migrations' }),
    );
  });

  it('applies pending migrations as individual queries', async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.applied).toEqual(['001_create.sql']);
    expect(result.skipped).toEqual([]);
    // Should have: CREATE TABLE, sqlite_master check, SELECT, migration SQL, INSERT
    expect(queries).toHaveLength(5);
    expect(queries[3].sql).toBe('CREATE TABLE users (id TEXT);');
    expect(queries[4].sql).toContain('INSERT OR IGNORE INTO _void_migrations');
    expect(queries[4].params![0]).toBe('001_create.sql');
  });

  it('skips already-applied migrations', async () => {
    appliedMigrations = ['001_create.sql'];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ]);

    expect(result.skipped).toEqual(['001_create.sql']);
    expect(result.applied).toEqual(['002_add_col.sql']);
  });

  it('applies multiple pending migrations in order', async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE a;' },
      { name: '002_more.sql', sql: 'CREATE TABLE b;' },
    ]);

    expect(result.applied).toEqual(['001_create.sql', '002_more.sql']);
    // CREATE TABLE IF NOT EXISTS, sqlite_master check, SELECT, SQL1, INSERT1, SQL2, INSERT2
    expect(queries).toHaveLength(7);
    expect(queries[3].sql).toBe('CREATE TABLE a;');
    expect(queries[4].sql).toContain('INSERT OR IGNORE INTO _void_migrations');
    expect(queries[5].sql).toBe('CREATE TABLE b;');
    expect(queries[6].sql).toContain('INSERT OR IGNORE INTO _void_migrations');
  });

  it('handles empty migrations list', async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('throws on D1 API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message: 'database not found' }],
              result: [],
            }),
          ),
      ),
    );

    await expect(
      runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
        { name: '001.sql', sql: 'CREATE TABLE x;' },
      ]),
    ).rejects.toThrow('D1 migration failed');
  });

  it('sends correct URL with account and database ID', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
  });

  it('upgrades legacy _migrations table to _void_migrations', async () => {
    hasLegacyTable = true;
    legacyMigrations = ['001_create.sql', '002_add_col.sql'];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
      { name: '003_new.sql', sql: 'CREATE TABLE posts (id TEXT);' },
    ]);

    // Legacy migrations should be copied, so 001 and 002 are skipped
    expect(result.skipped).toEqual(['001_create.sql', '002_add_col.sql']);
    expect(result.applied).toEqual(['003_new.sql']);

    // Verify upgrade queries were issued:
    // 1. CREATE TABLE IF NOT EXISTS _void_migrations
    // 2. SELECT from sqlite_master for _migrations
    // 3. INSERT OR IGNORE ... FROM _migrations
    // 4. DROP TABLE _migrations
    const sqlList = queries.map((q) => q.sql);
    expect(sqlList).toContainEqual(expect.stringContaining('SELECT name FROM sqlite_master'));
    expect(sqlList).toContainEqual(
      expect.stringContaining('INSERT OR IGNORE INTO _void_migrations'),
    );
    expect(sqlList).toContainEqual(expect.stringContaining('DROP TABLE _migrations'));
  });

  it('tolerates a concurrent upgrade race where the winner already dropped _migrations', async () => {
    // Two concurrent ensureTrackingTable callers both pass the sqlite_master
    // probe for the legacy `_migrations` table. The winner runs the
    // INSERT OR IGNORE ... FROM _migrations copy AND drops the legacy table.
    // The loser's copy INSERT then fails with `no such table: _migrations`.
    // The loser swallows `no such table` specifically and continues; the
    // DROP also fails safely.
    hasLegacyTable = true;
    legacyMigrations = ['001_create.sql'];

    failingSql = [
      {
        // Only the legacy-upgrade shape (FROM _migrations). The tracking
        // INSERT in runRemoteMigrations uses VALUES and stays untouched.
        match: /INSERT OR IGNORE INTO _void_migrations[\s\S]*FROM _migrations/,
        message: 'no such table: _migrations',
        // Simulate the concurrent winner's outcome: rows already copied
        // into _void_migrations and the legacy table dropped by the time
        // the loser's failing copy dispatch happens. The winner's INSERT
        // landed and its DROP cleared the flag.
        beforeFail: () => {
          for (const name of legacyMigrations) {
            if (!appliedMigrations.includes(name)) {
              appliedMigrations.push(name);
            }
          }
          hasLegacyTable = false;
          legacyMigrations = [];
        },
      },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_new.sql', sql: 'CREATE TABLE posts (id TEXT);' },
    ]);

    // 001 was already copied by the winner; we only apply 002.
    expect(result.skipped).toEqual(['001_create.sql']);
    expect(result.applied).toEqual(['002_new.sql']);
    // The winner's row is preserved and 002 was tracked.
    expect(appliedMigrations).toContain('001_create.sql');
    expect(appliedMigrations).toContain('002_new.sql');
  });

  it('propagates non-"no such table" errors from the legacy upgrade copy INSERT', async () => {
    // Safety guard: the narrow catch must ONLY swallow `no such table`
    // errors. Any other failure on the copy INSERT (auth, quota, schema
    // mismatch on `_void_migrations`) must still propagate so the operator
    // sees it.
    hasLegacyTable = true;
    legacyMigrations = ['001_create.sql'];
    failingSql = [
      {
        match: /INSERT OR IGNORE INTO _void_migrations[\s\S]*FROM _migrations/,
        message: 'Authentication error',
      },
    ];

    await expect(runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [])).rejects.toThrow(
      /Authentication error/,
    );
  });

  it('skips upgrade when no legacy _migrations table exists', async () => {
    hasLegacyTable = false;

    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    // Should query sqlite_master but NOT issue INSERT OR IGNORE / DROP from
    // a legacy upgrade. The mock distinguishes the two INSERT OR IGNORE shapes
    // by checking for FROM _migrations.
    const sqlList = queries.map((q) => q.sql);
    expect(sqlList).toContainEqual(expect.stringContaining('SELECT name FROM sqlite_master'));
    expect(sqlList.some((sql) => typeof sql === 'string' && sql.includes('FROM _migrations'))).toBe(
      false,
    );
    expect(sqlList).not.toContainEqual(expect.stringContaining('DROP TABLE _migrations'));
  });

  it('recovers from "already exists" when the tracking row was lost on a prior run', async () => {
    // Simulates a migration journal mismatch: a previous deploy committed the user SQL
    // to D1 but the subsequent tracking INSERT failed (network blip, 429,
    // timeout). A retry re-runs the migration, which now fails with
    // "already exists". Because the applied set (populated from
    // _void_migrations) does NOT contain this migration, runRemoteMigrations
    // reconciles by writing the tracking row and marking it applied.
    failingSql = [
      { match: 'CREATE TABLE users (id TEXT);', message: 'table users already exists' },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.applied).toEqual(['001_create.sql']);
    expect(result.skipped).toEqual([]);
    // Tracking row was written even though the SQL call threw.
    expect(appliedMigrations).toContain('001_create.sql');
    // The tracking INSERT was still issued.
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(1);
    expect(trackingInserts[0].params![0]).toBe('001_create.sql');
  });

  it('recovers from "duplicate column" when the tracking row was lost', async () => {
    failingSql = [
      {
        match: 'ALTER TABLE users ADD COLUMN name TEXT;',
        message: 'duplicate column name: name',
      },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ]);

    expect(result.applied).toEqual(['002_add_col.sql']);
    expect(appliedMigrations).toContain('002_add_col.sql');
  });

  it('does NOT recover when the migration is already in the applied set', async () => {
    // When the tracking row exists, the migration is skipped entirely
    // BEFORE the SQL call runs — the recovery path is never reached, and
    // no SQL queries are issued for this migration.
    appliedMigrations = ['001_create.sql'];
    failingSql = [
      { match: 'CREATE TABLE users (id TEXT);', message: 'table users already exists' },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.skipped).toEqual(['001_create.sql']);
    expect(result.applied).toEqual([]);
    // The migration SQL was never issued — the skip happened before the
    // try/catch around queryD1.
    const migrationSqlCalls = queries.filter((q) => q.sql === 'CREATE TABLE users (id TEXT);');
    expect(migrationSqlCalls).toHaveLength(0);
  });

  it('reports unrelated errors (syntax error) on result.failed instead of recovering', async () => {
    // Only "already exists" / "duplicate column" triggers the narrow
    // recovery. A syntax error means the migration is broken — fail loud.
    //
    // The runner returns the failure on `result.failed` instead of
    // throwing so /apply can persist the committed prefix before surfacing
    // the error. The end-state guarantee (tracking row NOT written) is
    // preserved.
    failingSql = [{ match: 'CREATE TABEL', message: 'syntax error near "TABEL"' }];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_bad.sql', sql: 'CREATE TABEL oops (id TEXT);' },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toBeDefined();
    expect(result.failed!.name).toBe('001_bad.sql');
    expect(result.failed!.error).toContain('syntax error');

    // Tracking row must NOT be written for the failed migration.
    expect(appliedMigrations).not.toContain('001_bad.sql');
  });

  it('reports "already exists" for multi-statement migrations on result.failed (not safe to recover)', async () => {
    // Multi-statement migrations CANNOT safely fall through the recovery
    // path. Consider `CREATE TABLE a; CREATE INDEX idx ON a(id);` where
    // statement 1 committed on a prior deploy and statement 2 failed
    // (network blip). The retry re-runs the whole body, D1 aborts at the
    // first "already exists" error on statement 1, and marking the
    // migration applied would permanently skip statement 2 — the index
    // would never get created. Surface the error via result.failed instead
    // and leave the tracking row unwritten so the operator can reconcile.
    //
    // Propagation is via the structured result, not a thrown error,
    // so /apply can still persist any committed prefix before surfacing.
    const multiSql = 'CREATE TABLE a (id TEXT); CREATE INDEX idx_a ON a(id);';
    failingSql = [{ match: 'CREATE TABLE a', message: 'table a already exists' }];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_multi.sql', sql: multiSql },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toBeDefined();
    expect(result.failed!.name).toBe('001_multi.sql');
    expect(result.failed!.error).toMatch(/already exists/);

    // Tracking row must NOT be written for a migration we refused to recover.
    expect(appliedMigrations).not.toContain('001_multi.sql');
    // Tracking INSERT (the VALUES form from runRemoteMigrations) must not
    // have been issued for this migration.
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
  });

  it('recovers a multi-statement migration when a concurrent winner already recorded it', async () => {
    // Two overlapping /apply requests race on the same multi-statement
    // migration. The first lands the SQL and the tracking INSERT. The
    // second has a stale preflight `applied` set, so it re-runs the body,
    // hits "already exists", and must re-check `_void_migrations` directly
    // — finding the winner's tracking row, it marks the migration skipped
    // instead of failing. The partial-commit safety direction is preserved
    // by the `propagates ... when no concurrent winner` test below.
    const multiSql = 'CREATE TABLE a (id TEXT); CREATE INDEX idx_a ON a(id);';
    failingSql = [
      {
        match: 'CREATE TABLE a',
        message: 'table a already exists',
        // Simulate the concurrent winner having already inserted the
        // tracking row by the time the loser's failing SQL dispatch
        // happens. The recheck (which reads `appliedMigrations` directly)
        // will then find the winner's row and recover.
        beforeFail: () => {
          if (!appliedMigrations.includes('001_multi.sql')) {
            appliedMigrations.push('001_multi.sql');
          }
        },
      },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_multi.sql', sql: multiSql },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_multi.sql']);
    // The tracking row from the concurrent winner is preserved and the
    // loser did NOT issue its own VALUES-form INSERT (no double-write).
    expect(appliedMigrations).toEqual(['001_multi.sql']);
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
    // The recheck SELECT was issued.
    const recheckQueries = queries.filter(
      (q) => q.sql === 'SELECT name FROM _void_migrations WHERE name = ?',
    );
    expect(recheckQueries).toHaveLength(1);
    expect(recheckQueries[0].params?.[0]).toBe('001_multi.sql');
  });

  it('bounds-retries the multi-statement recheck so the loser can wait for the winner INSERT', async () => {
    // The recheck and the winner's tracking INSERT are two non-atomic
    // HTTP calls. A loser that fires its recheck microseconds before the
    // winner's INSERT lands sees an empty result; the recheck retries up
    // to 5× × 50ms and sees the row as soon as it lands.
    //
    // Simulate this by having the mock tracking-row SELECT return empty
    // for the first call and "land" the winner's row on the second.
    const multiSql = 'CREATE TABLE a (id TEXT); CREATE INDEX idx_a ON a(id);';
    let recheckCount = 0;
    failingSql = [{ match: 'CREATE TABLE a', message: 'table a already exists' }];

    const originalFetch = globalThis.fetch as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { sql: string; params?: Array<unknown> };
        if (body.sql === 'SELECT name FROM _void_migrations WHERE name = ?') {
          recheckCount++;
          // Land the winner's tracking row right before the loser's second
          // recheck observes the table — this is exactly the interleaving
          // the bounded retry exists to survive.
          if (recheckCount === 2 && !appliedMigrations.includes('001_multi.sql')) {
            appliedMigrations.push('001_multi.sql');
          }
        }
        return originalFetch(url, init);
      }),
    );

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_multi.sql', sql: multiSql },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_multi.sql']);
    // The recheck was retried at least twice — first attempt observed the
    // empty state, second observed the freshly-landed winner row.
    expect(recheckCount).toBeGreaterThanOrEqual(2);
    // The loser did NOT issue its own VALUES-form tracking INSERT (only the
    // winner's row, which the test injected via beforeFail-style hook above).
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
  });

  it('reports "already exists" on result.failed for multi-statement when no concurrent winner exists', async () => {
    // The recheck must NOT recover when the tracking row is genuinely
    // absent — that's a real partial commit the operator has to
    // investigate. Same setup as the recovery test above but WITHOUT
    // injecting the winner's row. Returns result.failed rather than
    // throwing so the caller can heal any committed prefix from earlier
    // in the batch.
    const multiSql = 'CREATE TABLE a (id TEXT); CREATE INDEX idx_a ON a(id);';
    failingSql = [{ match: 'CREATE TABLE a', message: 'table a already exists' }];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_multi.sql', sql: multiSql },
    ]);
    expect(result.failed).toBeDefined();
    expect(result.failed!.name).toBe('001_multi.sql');
    expect(result.failed!.error).toMatch(/already exists/);

    // Tracking row must NOT be written.
    expect(appliedMigrations).not.toContain('001_multi.sql');
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
    // Recheck WAS issued and returned empty. The loser polls up to 5
    // times before giving up, so assert at least one attempt and at
    // most the full budget.
    const recheckQueries = queries.filter(
      (q) => q.sql === 'SELECT name FROM _void_migrations WHERE name = ?',
    );
    expect(recheckQueries.length).toBeGreaterThanOrEqual(1);
    expect(recheckQueries.length).toBeLessThanOrEqual(5);
  });

  it('reports "already exists" on result.failed when -- inside a quoted literal masks a second statement', async () => {
    // A multi-statement migration whose first statement defaults a column
    // to a string containing `--` must be classified as multi-statement.
    // With the tokenizer, isSingleStatement correctly reports multi, the
    // recovery path is skipped, and the error surfaces on result.failed.
    // A regex-based stripper would misclassify this as single-statement
    // and silently mark the whole migration applied, leaving the second
    // CREATE TABLE missing from the remote schema.
    const multiSql = "CREATE TABLE t (x TEXT DEFAULT '-- none'); CREATE TABLE u (y TEXT);";
    failingSql = [{ match: 'CREATE TABLE t', message: 'table t already exists' }];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_quoted_comment.sql', sql: multiSql },
    ]);
    expect(result.failed).toBeDefined();
    expect(result.failed!.name).toBe('001_quoted_comment.sql');
    expect(result.failed!.error).toMatch(/already exists/);

    // Tracking row must NOT be written — the tokenizer correctly
    // refused to reconcile a multi-statement body.
    expect(appliedMigrations).not.toContain('001_quoted_comment.sql');
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
  });

  it('tracking INSERT OR IGNORE is idempotent across retries', async () => {
    // Simulates a retry where the user SQL has already committed to D1 via
    // a prior request (so running the migration a second time succeeds) and
    // the tracking row may or may not exist. Since the mock is forgiving
    // (no stateful "already exists" here), we replay the same migration
    // twice against a fresh mock and assert exactly one tracking row ends
    // up in the simulated _void_migrations.
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    // Re-run: the applied set now contains the migration, so it's skipped
    // entirely and no additional tracking write is attempted.
    queries = [];
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_create.sql']);
    expect(appliedMigrations.filter((n) => n === '001_create.sql')).toHaveLength(1);

    // Even if the SAME RUN were to call the tracking INSERT twice with the
    // same name (e.g. a retry loop higher up), the mock simulates
    // INSERT OR IGNORE idempotency — duplicate rows are not appended.
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);
    expect(appliedMigrations.filter((n) => n === '001_create.sql')).toHaveLength(1);
  });
});

describe('queryD1 timeout', () => {
  it('aborts the fetch and throws a timed-out error when the request hangs', async () => {
    // Without a timeout, a hung D1 REST call would hold the
    // migration row lock indefinitely — every subsequent apply/
    // rename/rollback on the same project would pile up on the
    // project's FOR UPDATE row lock. queryD1 must abort the fetch
    // on its own timeout so the transaction unwinds and releases
    // the lock.
    let abortSignal: AbortSignal | undefined;
    const hangingFetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          abortSignal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    vi.stubGlobal('fetch', hangingFetch);

    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).rejects.toThrow(/timed out after 50ms/);
    expect(abortSignal?.aborted).toBe(true);
  });

  it('propagates non-abort fetch errors unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).rejects.toThrow('network unreachable');
  });

  it('clears the timeout on a successful response so no dangling timer fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, errors: [], result: [{ results: [] }] })),
      ),
    );
    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).resolves.toEqual({ results: [], meta: undefined });
  });

  it('aborts and rejects when headers arrive but the body stalls', async () => {
    // `fetch()` resolves on response HEADERS, not the full body. A D1
    // that sends headers and then stalls the chunked body (or sends a
    // truncated stream that never closes) would hang the `response.json()`
    // await forever, holding the row lock and pg pool connection. The
    // abort controller must stay active until AFTER json() completes so
    // abort propagates into the body stream and rejects the parse.
    //
    // The test constructs a Response whose body is a ReadableStream that
    // never emits a byte. When the timer fires, the abort listener
    // errors the stream, which propagates through json() as an
    // AbortError, and queryD1 rethrows it as a timeout.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});

describe('isSingleStatement', () => {
  it('treats a single statement with trailing semicolon as single', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('treats a single statement without trailing semicolon as single', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT)')).toBe(true);
  });

  it('ignores a trailing SQL line comment', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT); -- trailing comment')).toBe(true);
  });

  it('treats two SQL statements separated by a semicolon as multi', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT); CREATE INDEX b ON a(id);')).toBe(false);
  });

  it('ignores a leading SQL line comment', () => {
    expect(isSingleStatement('-- leading comment\nCREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('ignores a leading SQL block comment', () => {
    expect(isSingleStatement('/* block */\nCREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('ignores a block comment that contains a semicolon', () => {
    // The `;` inside the block comment is stripped before counting, so
    // this remains a single statement.
    expect(isSingleStatement('/* has ; inside */\nCREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('returns false for empty / whitespace-only / comment-only sql', () => {
    // No effective statements — not "single", so recovery stays disabled.
    expect(isSingleStatement('')).toBe(false);
    expect(isSingleStatement('   \n  ')).toBe(false);
    expect(isSingleStatement('-- only a comment\n')).toBe(false);
    expect(isSingleStatement('/* only a block */')).toBe(false);
  });

  it('treats three statements as multi', () => {
    expect(
      isSingleStatement(
        'CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT); CREATE INDEX c ON a(id);',
      ),
    ).toBe(false);
  });

  it('-- inside a string literal is not a comment (single-statement)', () => {
    // Regression: the previous regex-based stripper turned `--` inside a
    // quoted literal into a line comment, potentially swallowing the rest
    // of the file. The tokenizer must leave the literal alone.
    expect(isSingleStatement("CREATE TABLE t (x TEXT DEFAULT '-- none');")).toBe(true);
  });

  it('-- inside a string literal does not mask a second statement', () => {
    // A regex stripper would eat everything from the first `--` onward
    // (including the closing quote and the second statement), leaving a
    // single fragment that parsed as "1 statement". The tokenizer must
    // count both.
    expect(
      isSingleStatement("CREATE TABLE t (x TEXT DEFAULT '-- none'); CREATE TABLE u (y TEXT);"),
    ).toBe(false);
  });

  it('; inside a string literal is not a statement terminator', () => {
    expect(isSingleStatement("INSERT INTO t VALUES ('a;b');")).toBe(true);
  });

  it('; inside a double-quoted identifier is not a terminator', () => {
    expect(isSingleStatement('INSERT INTO "weird;name" (x) VALUES (1);')).toBe(true);
  });

  it('doubled single-quote escape stays inside the literal', () => {
    // `''` is an escaped inner single quote — the literal keeps running.
    expect(isSingleStatement("INSERT INTO t VALUES ('O''Brien');")).toBe(true);
  });

  it('doubled double-quote escape stays inside the identifier', () => {
    // `""` is an escaped inner double quote — the identifier keeps running.
    expect(isSingleStatement('INSERT INTO "weird""name" (x) VALUES (1);')).toBe(true);
  });

  it('-- inside a backtick identifier does not mask a second statement', () => {
    // The tokenizer must treat backtick as an identifier quote so `--`
    // inside a backtick identifier is not interpreted as a line comment.
    // Otherwise the `;` terminator gets eaten and a multi-statement body
    // is misclassified as single, enabling the single-statement recovery
    // path to silently mark a half-applied body as complete.
    const sql = ['CREATE TABLE `a--x` (id INT);', 'CREATE INDEX idx ON `a--x`(id);'].join('\n');
    expect(isSingleStatement(sql)).toBe(false);
  });

  it('-- inside a bracket identifier does not mask a second statement', () => {
    const sql = ['CREATE TABLE [a--x] (id INT);', 'CREATE INDEX idx ON [a--x](id);'].join('\n');
    expect(isSingleStatement(sql)).toBe(false);
  });

  it('; inside a backtick identifier is not a statement terminator', () => {
    expect(isSingleStatement('CREATE TABLE `a;b` (id INT)')).toBe(true);
  });

  it('; inside a bracket identifier is not a statement terminator', () => {
    expect(isSingleStatement('CREATE TABLE [a;b] (id INT)')).toBe(true);
  });

  describe('drizzle-kit statement-breakpoint marker (primary gate)', () => {
    it('exact drizzle format is detected as multi-statement', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--> statement-breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with extra whitespace is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--   >   statement-breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with extra dashes is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '-----> statement-breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with uppercase is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--> STATEMENT-BREAKPOINT',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with underscore separator is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--> statement_breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with no space between statement and breakpoint is detected', () => {
      // Regression guard: `[\s\-_]*` covers zero-width so `statementbreakpoint`
      // (hypothetical tighter drizzle format) is still caught.
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '-->statementbreakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker short-circuits even when the body parses as one statement', () => {
      // The tokenizer alone would see a single `CREATE TABLE` fragment here
      // (the second line is all comment), but the drizzle marker is a
      // declaration that there are more statements to come — trust it.
      const sql = 'CREATE TABLE a (id TEXT); --> statement-breakpoint';
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('drizzle-shaped multi-table migration is detected as multi-statement', () => {
      // Shape of a real drizzle-kit output from our fixtures.
      const sql = [
        'CREATE TABLE `posts` (',
        '\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
        '\t`title` text NOT NULL',
        ');',
        '--> statement-breakpoint',
        'CREATE TABLE `users` (',
        '\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
        '\t`name` text NOT NULL',
        ');',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('single-statement drizzle migration (no marker) falls through to tokenizer', () => {
      // A drizzle-kit migration for a single table has no marker — the
      // tokenizer must still recognize it as a single statement.
      const sql = [
        'CREATE TABLE `posts` (',
        '\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
        '\t`title` text NOT NULL',
        ');',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(true);
    });

    it('marker embedded in a quoted literal is a safe false-positive', () => {
      // The marker regex runs before tokenization, so a literal string
      // containing `--> statement-breakpoint` inside quotes will be
      // detected as if it were a real marker. This is intentional: the
      // only consequence is that recovery is disabled for this migration,
      // which is the safe direction. Documented in `isSingleStatement`'s
      // docstring and guarded by this test so a future "smarter" check
      // that breaks the safety direction fails loudly.
      const sql = "INSERT INTO t VALUES ('--> statement-breakpoint');";
      expect(isSingleStatement(sql)).toBe(false);
    });
  });
});
