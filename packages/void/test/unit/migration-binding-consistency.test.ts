import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { buildVoidManifest, buildFrameworkManifest } from '../../src/cli/package.ts';
import { inferBindingsFromSource, mergeBindings } from '../../src/inference/walk.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';
import { buildMigrationPlanBundle } from '../../src/migrations/plan.ts';
import { validateMigrations } from '../../src/migrations/validate.ts';
import type { MigrationFile } from '../../src/migrations/validate.ts';
import {
  createMigrationHandler,
  type MigrationResponse,
} from '../../src/runtime/migration-handler.ts';

const TMP = join(import.meta.dirname, '.tmp-migration-binding-test');

const noBindings: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

const sampleMigrations: Array<MigrationFile> = [
  {
    name: '0001_create_users.sql',
    sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    destructive: false,
  },
];

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildVoidManifest: migration ↔ binding consistency
// ---------------------------------------------------------------------------

describe('buildVoidManifest migration-binding consistency', () => {
  it('includes both d1 binding and migrations when needsD1 is true', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('forces d1 binding when migrations exist even if needsD1 is false', () => {
    const manifest = buildVoidManifest({
      bindings: noBindings,
      migrations: sampleMigrations,
    });

    // Migrations imply a database is needed — d1 binding must be present
    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('has no migrations and no d1 binding when both are absent', () => {
    const manifest = buildVoidManifest({ bindings: noBindings });

    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toBeUndefined();
  });

  it('includes live durable object manifest when void/live is used', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsLive: true },
    });

    expect(manifest.live).toEqual({
      bindingName: 'VOID_LIVE',
      className: 'VoidLiveStreamDurableObject',
      storage: 'sqlite',
      classes: ['VoidLiveStreamDurableObject'],
      migrations: [{ tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
    });
  });

  it('uses resolved live durable object names in the manifest', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsLive: true },
      options: {
        live: {
          bindingName: 'VOID_LIVE_abcd1234',
          className: 'VoidLiveStreamDurableObject_abcd1234',
        },
      },
    });

    expect(manifest.live).toEqual({
      bindingName: 'VOID_LIVE_abcd1234',
      className: 'VoidLiveStreamDurableObject_abcd1234',
      storage: 'sqlite',
      classes: ['VoidLiveStreamDurableObject_abcd1234'],
      migrations: [{ tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject_abcd1234'] }],
    });
  });

  it('has no migrations when migrations array is empty', () => {
    const manifest = buildVoidManifest({ bindings: noBindings, migrations: [] });

    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toBeUndefined();
  });

  it('has d1 binding but no migrations when needsD1 is true with no migration files', () => {
    const manifest = buildVoidManifest({ bindings: { ...noBindings, needsD1: true } });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toBeUndefined();
  });

  it('includes d1 binding when auth forces needsD1 even without explicit D1 usage', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsAuth: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('forces d1 binding when multiple migrations exist without D1 usage', () => {
    const migrations: Array<MigrationFile> = [
      {
        name: '0001_create_users.sql',
        sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);',
        destructive: false,
      },
      {
        name: '0002_create_posts.sql',
        sql: 'CREATE TABLE posts (id INTEGER PRIMARY KEY);',
        destructive: false,
      },
      {
        name: '0003_add_email.sql',
        sql: 'ALTER TABLE users ADD COLUMN email TEXT;',
        destructive: false,
      },
    ];

    const manifest = buildVoidManifest({ bindings: noBindings, migrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 3 }));
  });

  it('uses custom d1 binding name when provided', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
      options: { bindingNames: { d1: 'MY_DB' } },
    });

    expect(manifest.bindings.d1).toEqual(['MY_DB']);
  });
});

// ---------------------------------------------------------------------------
// buildVoidManifest: postgresql / hyperdrive variant
// ---------------------------------------------------------------------------

describe('buildVoidManifest postgresql migration-binding consistency', () => {
  it('forces hyperdrive binding when migrations exist with postgresql dialect and needsD1 is false', () => {
    const manifest = buildVoidManifest({
      bindings: noBindings,
      migrations: sampleMigrations,
      dialect: 'postgresql',
    });

    // Migrations with postgresql dialect imply hyperdrive is needed
    expect(manifest.bindings.hyperdrive).toEqual(['HYPERDRIVE']);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: 'postgresql', pending: 1 });
  });

  it('includes both hyperdrive binding and migrations when needsD1 is true with postgresql dialect', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
      dialect: 'postgresql',
    });

    expect(manifest.bindings.hyperdrive).toEqual(['HYPERDRIVE']);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: 'postgresql', pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// buildFrameworkManifest: same consistency requirement
// ---------------------------------------------------------------------------

describe('buildFrameworkManifest migration-binding consistency', () => {
  it('forces d1 binding when migrations exist even if needsD1 is false', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: noBindings,
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('includes both d1 binding and migrations when needsD1 is true', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('includes d1 binding via auth even without explicit D1 usage', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: { ...noBindings, needsAuth: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('forces hyperdrive binding when postgresql migrations exist with needsD1 false', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: noBindings,
      migrations: sampleMigrations,
      dialect: 'postgresql',
    });

    expect(manifest.bindings.hyperdrive).toEqual(['HYPERDRIVE']);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: 'postgresql', pending: 1 });
  });

  it('rejects live bindings because framework workers do not export the live durable object', () => {
    expect(() =>
      buildFrameworkManifest({
        frameworkName: 'nuxt',
        workerMain: 'index.js',
        bindings: { ...noBindings, needsLive: true },
      }),
    ).toThrow('void/live is currently supported in Void apps only');
  });
});

// ---------------------------------------------------------------------------
// createMigrationHandler: behavior when D1 binding is missing
// ---------------------------------------------------------------------------

describe('createMigrationHandler with missing D1 binding', () => {
  const proxyToken = 'test-token-123';

  function makeRequest() {
    return new Request('https://example.com/__void/migrate', {
      method: 'POST',
      headers: { 'x-void-internal': proxyToken },
    });
  }

  it('returns error when env.DB is undefined', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      'sqlite',
    );

    const response = await handler(makeRequest());
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no D1 binding found');
    expect(body.migrations).toEqual([]);
  });

  it('returns error when env.DB is null', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: null },
      sampleMigrations,
      'sqlite',
    );

    const response = await handler(makeRequest());
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no D1 binding found');
  });

  it('rejects requests with wrong proxy token', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      'sqlite',
    );

    const badRequest = new Request('https://example.com/__void/migrate', {
      method: 'POST',
      headers: { 'x-void-internal': 'wrong-token' },
    });
    const response = await handler(badRequest);
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unauthorized');
  });

  it('rejects requests with no proxy token', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      'sqlite',
    );

    const noAuthRequest = new Request('https://example.com/__void/migrate', {
      method: 'POST',
    });
    const response = await handler(noAuthRequest);
    expect(response.status).toBe(401);
  });
});

describe('createMigrationHandler D1 execution', () => {
  const proxyToken = 'test-token-123';

  function createMockD1(options?: {
    attempts?: Map<string, Record<string, unknown>>;
    failExec?: (sql: string) => Error | undefined;
    lockAttemptId?: string;
  }) {
    const calls = {
      batch: 0,
      batchSql: [] as Array<Array<string>>,
      exec: [] as Array<string>,
      run: [] as Array<string>,
    };
    const applied = new Set<string>();
    const attempts = new Map(options?.attempts ?? []);
    let lockAttemptId = options?.lockAttemptId;

    const db = {
      async batch(statements: Array<{ __sql?: string; run(): Promise<unknown> }>) {
        calls.batch++;
        calls.batchSql.push(statements.map((statement) => statement.__sql ?? ''));
        for (const statement of statements) {
          await statement.run();
        }
        return [];
      },
      async exec(sql: string) {
        calls.exec.push(sql);
        const error = options?.failExec?.(sql);
        if (error) {
          throw error;
        }
      },
      prepare(sql: string) {
        let bound: Array<unknown> = [];
        const statement = {
          bind(...params: Array<unknown>) {
            bound = params;
            (statement as { __bound?: Array<unknown> }).__bound = params;
            return statement;
          },
          async all() {
            if (sql.includes('sqlite_master') && sql.includes("'_migrations'")) {
              return { results: [] };
            }
            if (sql === 'SELECT name FROM _void_migrations') {
              return {
                results: Array.from(applied, (name) => ({ name })),
              };
            }
            return { results: [] };
          },
          async first() {
            if (sql === 'SELECT attempt_id FROM _void_migration_lock WHERE name = ?') {
              return lockAttemptId ? { attempt_id: lockAttemptId } : null;
            }
            if (sql === 'SELECT * FROM _void_migration_attempts WHERE attempt_id = ?') {
              return attempts.get(bound[0] as string) ?? null;
            }
            return null;
          },
          async run() {
            calls.run.push(sql);
            if (sql.startsWith('INSERT INTO _void_migration_lock')) {
              if (lockAttemptId) {
                throw new Error('UNIQUE constraint failed: _void_migration_lock.name');
              }
              lockAttemptId = bound[1] as string;
            }
            if (sql.startsWith('DELETE FROM _void_migration_lock')) {
              if (lockAttemptId === bound[1]) {
                lockAttemptId = undefined;
              }
            }
            if (sql.includes('INSERT INTO _void_migration_attempts')) {
              const attemptId = bound[0] as string;
              if (attempts.has(attemptId)) {
                throw new Error('UNIQUE constraint failed: _void_migration_attempts.attempt_id');
              }
              attempts.set(attemptId, {
                attempt_id: attemptId,
                completed_at: null,
                deployment_id: bound[1] as string | null,
                error: null,
                migration_list_hash: bound[2] as string,
                plan_hashes_json: bound[4] as string,
                planned_names_json: bound[3] as string,
                started_at: bound[5] as string,
                status: 'running',
              });
            }
            if (sql.includes('UPDATE _void_migration_attempts')) {
              const attempt = attempts.get(bound[3] as string);
              if (attempt) {
                attempt.status = bound[0] as string;
                attempt.completed_at = bound[1] as string;
                attempt.error = bound[2] as string | null;
              }
            }
            if (
              sql.startsWith('INSERT OR IGNORE INTO _void_migrations') ||
              sql.startsWith('INSERT INTO _void_migrations ')
            ) {
              applied.add(bound[0] as string);
            }
            return {};
          },
          __sql: sql,
        };
        return statement;
      },
    };

    return {
      attempts,
      calls,
      db: db as unknown as D1Database,
      getLockAttemptId: () => lockAttemptId,
    };
  }

  it('runs unsplit multi-statement migrations statement by statement in one D1 batch', async () => {
    const createTable = ['CREATE TABLE notes (', "  message TEXT DEFAULT 'a;b'", ');'].join('\n');
    const sql = `${createTable}\nINSERT INTO notes DEFAULT VALUES;`;
    const { calls, db } = createMockD1({
      failExec: (executedSql) =>
        executedSql.includes('\n')
          ? new Error('D1_EXEC_ERROR: Error in line 1: CREATE TABLE notes (: incomplete input')
          : undefined,
    });
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      [{ name: '0001_semicolon.sql', sql }],
      'sqlite',
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': proxyToken },
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.migrations).toEqual([
      { name: '0001_semicolon.sql', applied: true, durationMs: expect.any(Number) },
    ]);
    expect(calls.exec).toEqual([]);
    expect(calls.batchSql).toEqual([
      [
        createTable,
        'INSERT INTO notes DEFAULT VALUES;',
        'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
      ],
    ]);
  });

  it('keeps raw exec for legacy trigger migrations that cannot be split safely', async () => {
    const sql = [
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, updated_at TEXT);',
      'CREATE TRIGGER notes_touch AFTER UPDATE ON notes BEGIN',
      "  UPDATE notes SET updated_at = datetime('now') WHERE id = NEW.id;",
      'END;',
    ].join('\n');
    const { calls, db } = createMockD1();
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      [{ name: '0001_trigger.sql', sql }],
      'sqlite',
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': proxyToken },
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls.exec).toEqual([sql]);
    expect(calls.batch).toBe(0);
  });

  it('runs protocol v2 legacy multi-statement migrations through one D1 batch', async () => {
    const createTable = ['CREATE TABLE notes (', '  id INTEGER PRIMARY KEY', ');'].join('\n');
    const sql = `-- void:allow-unsplit-multi-statement\n${createTable}\nINSERT INTO notes DEFAULT VALUES;`;
    const migrations = [{ name: '0001_legacy.sql', sql }];
    const { calls, db } = createMockD1({
      failExec: (executedSql) =>
        executedSql.includes('\n')
          ? new Error('D1_EXEC_ERROR: Error in line 1: CREATE TABLE notes (: incomplete input')
          : undefined,
    });
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      migrations,
      'sqlite',
      undefined,
      buildMigrationPlanBundle(migrations),
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate/app', {
        body: JSON.stringify({ attemptId: 'attempt_legacy', deploymentId: 'dpl_1' }),
        headers: { 'content-type': 'application/json', 'x-void-internal': proxyToken },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.confirmedApplied).toEqual(['0001_legacy.sql']);
    expect(calls.exec).toEqual([]);
    expect(calls.batchSql).toContainEqual([
      `-- void:allow-unsplit-multi-statement\n${createTable}`,
      'INSERT INTO notes DEFAULT VALUES;',
      'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
    ]);
  });

  it('applies scaffolded multiline single-statement D1 migrations without raw exec', async () => {
    const sql = [
      'CREATE TABLE `posts` (',
      '\t`id` integer PRIMARY KEY NOT NULL,',
      '\t`title` text NOT NULL',
      ');',
    ].join('\n');
    const { calls, db } = createMockD1({
      failExec: (executedSql) =>
        executedSql.includes('\n')
          ? new Error('D1_EXEC_ERROR: Error in line 1: CREATE TABLE `posts` (: incomplete input')
          : undefined,
    });
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      [{ name: '0000_generated.sql', sql }],
      'sqlite',
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': proxyToken },
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.migrations).toEqual([
      { name: '0000_generated.sql', applied: true, durationMs: expect.any(Number) },
    ]);
    expect(calls.exec).toEqual([]);
    expect(calls.run).toEqual([
      `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
      sql,
      'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
    ]);
  });

  it('applies Drizzle statement breakpoint chunks separately on D1', async () => {
    const sql = [
      'CREATE TABLE `account` (',
      '\t`id` text PRIMARY KEY NOT NULL,',
      '\t`userId` text NOT NULL',
      ');',
      '--> statement-breakpoint',
      'CREATE UNIQUE INDEX `account_userId_key` ON `account` (`userId`);--> statement-breakpoint',
      'CREATE TABLE `user` (',
      '\t`id` text PRIMARY KEY NOT NULL',
      ');',
    ].join('\n');
    const { calls, db } = createMockD1();
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      [{ name: '0001_drizzle.sql', sql }],
      'sqlite',
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': proxyToken },
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls.exec).toEqual([]);
    expect(calls.run).toEqual([
      `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
      [
        'CREATE TABLE `account` (',
        '\t`id` text PRIMARY KEY NOT NULL,',
        '\t`userId` text NOT NULL',
        ');',
      ].join('\n'),
      'CREATE UNIQUE INDEX `account_userId_key` ON `account` (`userId`);',
      ['CREATE TABLE `user` (', '\t`id` text PRIMARY KEY NOT NULL', ');'].join('\n'),
      'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
    ]);
    expect(calls.batch).toBe(0);
  });

  it('does not split statement breakpoint text inside SQL strings or comments', async () => {
    const sql = [
      "CREATE TABLE notes (message TEXT DEFAULT '--> statement-breakpoint');",
      "INSERT INTO notes VALUES ('literal --> statement-breakpoint value');",
      '/* --> statement-breakpoint */',
    ].join('\n');
    const { calls, db } = createMockD1();
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      [{ name: '0001_literal_marker.sql', sql }],
      'sqlite',
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': proxyToken },
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls.exec).toEqual([]);
    expect(calls.batchSql).toEqual([
      [
        "CREATE TABLE notes (message TEXT DEFAULT '--> statement-breakpoint');",
        "INSERT INTO notes VALUES ('literal --> statement-breakpoint value');",
        'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
      ],
    ]);
  });

  it('executes protocol v2 breakpoint migrations and tracking insert in one D1 batch', async () => {
    const sql = [
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      '--> statement-breakpoint',
      'CREATE INDEX users_id_idx ON users (id);',
    ].join('\n');
    const migrations = [{ name: '0001_users.sql', sql }];
    const { calls, db } = createMockD1();
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      migrations,
      'sqlite',
      undefined,
      buildMigrationPlanBundle(migrations),
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate/app', {
        body: JSON.stringify({ attemptId: 'attempt_1', deploymentId: 'dpl_1' }),
        headers: { 'content-type': 'application/json', 'x-void-internal': proxyToken },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(2);
    expect(body.confirmedApplied).toEqual(['0001_users.sql']);
    expect(calls.exec).toEqual([]);
    expect(calls.batchSql).toContainEqual([
      expect.stringContaining('INSERT INTO _void_migration_fences'),
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      'CREATE INDEX users_id_idx ON users (id);',
      'INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)',
    ]);
  });

  it('retains an incomplete lock owned by an older executor without fencing', async () => {
    const attempts = new Map<string, Record<string, unknown>>([
      [
        'attempt_old',
        {
          attempt_id: 'attempt_old',
          completed_at: null,
          deployment_id: 'dpl_old',
          error: null,
          migration_list_hash: 'sha256:old',
          plan_hashes_json: '[]',
          planned_names_json: JSON.stringify(['0001_users.sql']),
          started_at: new Date().toISOString(),
          status: 'running',
        },
      ],
    ]);
    const {
      attempts: storedAttempts,
      db,
      getLockAttemptId,
    } = createMockD1({
      attempts,
      lockAttemptId: 'attempt_old',
    });
    const migrations: Array<MigrationFile> = [];
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      migrations,
      'sqlite',
      undefined,
      buildMigrationPlanBundle(migrations),
    );

    const reconcile = await handler(
      new Request('https://example.com/__void/migrate/app/attempt/attempt_old', {
        headers: { 'x-void-internal': proxyToken },
      }),
    );
    const reconcileBody = (await reconcile.json()) as MigrationResponse;

    expect(reconcile.status).toBe(409);
    expect(reconcileBody.ok).toBe(false);
    expect(reconcileBody.error).toContain(
      'wait for this migration to finish before retrying recovery',
    );
    expect(storedAttempts.get('attempt_old')?.status).toBe('running');
    expect(getLockAttemptId()).toBe('attempt_old');

    const retry = await handler(
      new Request('https://example.com/__void/migrate/app', {
        body: JSON.stringify({ attemptId: 'attempt_new', deploymentId: 'dpl_new' }),
        headers: { 'content-type': 'application/json', 'x-void-internal': proxyToken },
        method: 'POST',
      }),
    );
    const retryBody = (await retry.json()) as MigrationResponse;
    expect(retry.status).toBe(409);
    expect(retryBody.ok).toBe(false);
  });

  it('does not steal a lock when an older executor has not published its attempt', async () => {
    const migrations: Array<MigrationFile> = [];
    const { db, getLockAttemptId } = createMockD1({ lockAttemptId: 'attempt_orphan' });
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: db },
      migrations,
      'sqlite',
      undefined,
      buildMigrationPlanBundle(migrations),
    );

    const response = await handler(
      new Request('https://example.com/__void/migrate/app', {
        body: JSON.stringify({ attemptId: 'attempt_new', deploymentId: 'dpl_new' }),
        headers: { 'content-type': 'application/json', 'x-void-internal': proxyToken },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(getLockAttemptId()).toBe('attempt_orphan');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: collectMigrations + inference + buildVoidManifest
// ---------------------------------------------------------------------------

describe('end-to-end: D1 removed but migrations remain on disk', () => {
  it('forces d1 binding when user removes D1 usage but keeps migration files', () => {
    // Source code has no void/db imports or env.DB usage
    const sourceCode = `export const GET = defineHandler(() => ({ message: "hello" }));`;
    const bindings = inferBindingsFromSource(sourceCode, 'hello.ts');
    expect(bindings.needsD1).toBe(false);

    // But old migration files still exist on disk
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const rawMigrations = collectMigrations(migrationsDir);
    expect(rawMigrations).toHaveLength(1);
    const validatedMigrations = validateMigrations(rawMigrations);

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('works correctly when D1 usage is still present', () => {
    const sourceCode = `
      import { db } from "void/db";
      export const GET = defineHandler(async () => {
        return db.select().from("users");
      });
    `;
    const bindings = inferBindingsFromSource(sourceCode, 'users.ts');
    expect(bindings.needsD1).toBe(true);

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 1 }));
  });

  it('produces clean manifest when both D1 and migrations are removed', () => {
    const sourceCode = `export const GET = defineHandler(() => ({ ok: true }));`;
    const bindings = inferBindingsFromSource(sourceCode, 'health.ts');

    const migrationsDir = join(TMP, 'db', 'migrations');
    const rawMigrations = collectMigrations(migrationsDir);
    expect(rawMigrations).toHaveLength(0);

    const manifest = buildVoidManifest({ bindings });

    expect(manifest.migrations).toBeUndefined();
    expect(manifest.bindings.d1).toBeUndefined();
  });

  it('forces d1 binding when multiple old migrations remain after removing env.DB', () => {
    const sourceCode = `
      export const GET = defineHandler(async (c) => {
        const data = await fetch("https://api.example.com/users");
        return c.json(await data.json());
      });
    `;
    const bindings = inferBindingsFromSource(sourceCode, 'users.ts');
    expect(bindings.needsD1).toBe(false);

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    writeFileSync(
      join(migrationsDir, '0002_add_email.sql'),
      'ALTER TABLE users ADD COLUMN email TEXT;',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual(expect.objectContaining({ dialect: 'sqlite', pending: 2 }));
  });

  it('auth-enabled project with leftover migrations stays consistent', () => {
    const authSource = `import { auth } from "void/client"; await auth.signOut();`;
    const routeSource = `export const GET = defineHandler(() => ({ ok: true }));`;
    const merged = mergeBindings([
      inferBindingsFromSource(authSource, 'auth.ts'),
      inferBindingsFromSource(routeSource, 'health.ts'),
    ]);
    expect(merged.needsAuth).toBe(true);
    expect(merged.needsD1).toBe(false);

    // Simulate deploy.ts behavior: auth forces needsD1
    const effectiveBindings =
      merged.needsAuth && !merged.needsD1 ? { ...merged, needsD1: true } : merged;

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_auth_tables.sql'),
      'CREATE TABLE auth_users (id TEXT PRIMARY KEY);',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({
      bindings: effectiveBindings,
      migrations: validatedMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations!.pending).toBe(1);
  });

  it('forces d1 binding for non-auth project with leftover migrations', () => {
    const routeSource = `export const GET = defineHandler(() => ({ ok: true }));`;
    const bindings = inferBindingsFromSource(routeSource, 'health.ts');
    expect(bindings.needsD1).toBe(false);
    expect(bindings.needsAuth).toBe(false);

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    // Migrations should force the d1 binding even without auth or D1 imports
    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations!.pending).toBe(1);
  });
});
