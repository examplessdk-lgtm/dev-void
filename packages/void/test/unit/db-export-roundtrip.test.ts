import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import { join } from 'pathslash';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { getLocalD1Target, runDbCommand } from '../../src/cli/db.ts';

const state = vi.hoisted(() => ({ pg: null as PGlite | null }));
vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params?: Array<unknown>) {
      return params
        ? state.pg!.query(sql, params)
        : ((await state.pg!.exec(sql)).at(-1) ?? { rows: [] });
    }
  },
}));
vi.mock('@clack/prompts', () => ({
  intro() {},
  outro() {},
  confirm: async () => true,
  isCancel: () => false,
  log: { error() {}, info() {}, step() {}, success() {} },
}));
const roots: Array<string> = [];
beforeAll(async () => {
  // Load PostgreSQL once: Windows' cold WASM startup belongs to the hook budget,
  // while each export assertion retains its normal short test deadline.
  state.pg = new PGlite();
  await state.pg.waitReady;
}, 30_000);
beforeEach(async () => {
  await state.pg!.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});
afterAll(async () => {
  await state.pg?.close();
  state.pg = null;
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function project(pg = false) {
  const root = mkdtempSync(join(tmpdir(), 'void-export-'));
  roots.push(root);
  writeFileSync(join(root, 'void.json'), JSON.stringify(pg ? { database: 'pg' } : {}));
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://unused:unused@localhost/isolated');
  return root;
}

describe('SQL export restore', () => {
  it('round-trips generated PostgreSQL timestamp defaults without locale or time-zone conversion', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, name text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    ); INSERT INTO users(name, created_at, updated_at)
      VALUES ('Alice', '2026-01-01 12:34:56.123456', '2026-01-02 23:45:00');`);
    const select = 'SELECT id, name, created_at::text, updated_at::text FROM users';
    const original = await pg.query(select);
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE users');
    await pg.exec(dump);
    expect((await pg.query(select)).rows).toEqual(original.rows);
  });

  it('restores a schema-only PostgreSQL export with a fresh serial counter', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(
      "CREATE TABLE users(id SERIAL PRIMARY KEY); SELECT setval('users_id_seq', 100, true);",
    );
    await runDbCommand(root, { action: 'export', output: 'dump.sql', noData: true });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE users');
    await pg.exec(dump);
    expect((await pg.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows).toEqual([
      { id: 1 },
    ]);
  });

  it('preserves an unused PostgreSQL sequence without skipping its first value', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec('CREATE TABLE users(id BIGSERIAL PRIMARY KEY);');
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE users');
    await pg.exec(dump);
    expect(
      (await pg.query('INSERT INTO users DEFAULT VALUES RETURNING id::text AS id')).rows,
    ).toEqual([{ id: '1' }]);
  });

  it.each([{}, { table: 'users' }, { noSchema: true }])(
    'restores SQLite autoincrement and its high-water mark (%j)',
    async (options) => {
      const root = project();
      const { databasePath } = getLocalD1Target(root);
      mkdirSync(join(databasePath, '..'), { recursive: true });
      const source = new Database(databasePath);
      const schema =
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);';
      source.exec(
        schema +
          "INSERT INTO users VALUES (1, 'Alice'); INSERT INTO users VALUES (100, 'deleted'); DELETE FROM users WHERE id=100;",
      );
      source.close();
      await runDbCommand(root, { action: 'export', output: 'dump.sql', ...options });
      const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
      const restored = new Database(':memory:');
      try {
        if ('noSchema' in options) {
          restored.exec(schema);
        }
        restored.exec(dump);
        expect(restored.prepare('SELECT * FROM users').all()).toEqual([{ id: 1, name: 'Alice' }]);
        const result = restored.prepare('INSERT INTO users (name) VALUES (?)').run('Bob');
        expect(result.lastInsertRowid).toBe(101);
      } finally {
        restored.close();
      }
    },
  );

  it.each([{}, { table: 'users' }, { noSchema: true }])(
    'restores PostgreSQL serial sequences and their state (%j)',
    async (options) => {
      const pg = state.pg!;
      const root = project(true);
      const schema = 'CREATE TABLE users (id SERIAL PRIMARY KEY, name text NOT NULL);';
      await pg.exec(
        schema +
          "INSERT INTO users(name) VALUES ('Alice'); SELECT setval('users_id_seq', 100, true);",
      );
      await runDbCommand(root, { action: 'export', output: 'dump.sql', ...options });
      const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
      await pg.exec('DROP TABLE users;');
      if ('noSchema' in options) {
        await pg.exec(schema);
      }
      await pg.exec(dump);
      expect((await pg.query('SELECT * FROM users')).rows).toEqual([{ id: 1, name: 'Alice' }]);
      expect((await pg.query("INSERT INTO users(name) VALUES ('Bob') RETURNING id")).rows).toEqual([
        { id: 101 },
      ]);
      await expect(pg.exec("INSERT INTO users(id, name) VALUES (1, 'duplicate')")).rejects.toThrow(
        'duplicate key',
      );
    },
  );
});
