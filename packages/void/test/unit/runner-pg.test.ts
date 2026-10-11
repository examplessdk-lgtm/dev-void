import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  applyPgMigrations,
  readPgAppliedMigrations,
  type PgClient,
} from '../../src/migrations/runner-pg.ts';

let pglite: PGlite;
let client: PgClient;

beforeAll(
  async () => {
    pglite = new PGlite();
    // Cold WASM startup can exceed 10s on Windows CI. Pay that cost once here,
    // not in the first schema-reset hook; query and test deadlines stay unchanged.
    await pglite.waitReady;
    client = pglite;
  },
  process.platform === 'win32' ? 30_000 : undefined,
);

beforeEach(async () => {
  await pglite.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
});

afterAll(async () => {
  await pglite.close();
});

describe('applyPgMigrations', () => {
  it('returns empty array for empty migrations list', async () => {
    const result = await applyPgMigrations(client, []);
    expect(result).toEqual([]);
  });

  it('skips already-applied migrations (idempotent re-run)', async () => {
    const migrations = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
    ];

    const first = await applyPgMigrations(client, migrations);
    expect(first).toEqual(['001_create_users.sql']);

    const second = await applyPgMigrations(client, migrations);
    expect(second).toEqual([]);

    const tracking = await pglite.query('SELECT name FROM _void_migrations');
    expect(tracking.rows).toHaveLength(1);
  });

  it('applies multiple migrations in order', async () => {
    const migrations = [
      {
        name: '001_create_users.sql',
        sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)',
      },
      { name: '002_add_email.sql', sql: 'ALTER TABLE users ADD COLUMN email TEXT' },
      {
        name: '003_create_posts.sql',
        sql: 'CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id))',
      },
    ];

    const applied = await applyPgMigrations(client, migrations);
    expect(applied).toEqual(['001_create_users.sql', '002_add_email.sql', '003_create_posts.sql']);

    const userCols = await pglite.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position",
    );
    expect(userCols.rows.map((r) => r.column_name)).toEqual(['id', 'name', 'email']);

    const postCheck = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'posts'",
    );
    expect(postCheck.rows).toHaveLength(1);
  });

  it('applies only pending migrations when some are already applied', async () => {
    const first = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
    ];
    await applyPgMigrations(client, first);

    const all = [
      ...first,
      { name: '002_add_email.sql', sql: 'ALTER TABLE users ADD COLUMN email TEXT' },
    ];
    const applied = await applyPgMigrations(client, all);
    expect(applied).toEqual(['002_add_email.sql']);

    const tracking = await pglite.query<{ name: string }>(
      'SELECT name FROM _void_migrations ORDER BY name',
    );
    expect(tracking.rows.map((r) => r.name)).toEqual(['001_create_users.sql', '002_add_email.sql']);
  });

  it('rolls back failed migration and does not record it', async () => {
    const migrations = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
      { name: '002_bad.sql', sql: 'INVALID SQL THAT WILL FAIL' },
    ];

    await expect(applyPgMigrations(client, migrations)).rejects.toThrow(/INVALID/i);

    // First migration committed before the failure
    const tracking = await pglite.query<{ name: string }>('SELECT name FROM _void_migrations');
    expect(tracking.rows).toHaveLength(1);
    expect(tracking.rows[0].name).toBe('001_create_users.sql');

    // users table exists, no residue from bad migration
    const tables = await pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name != '_void_migrations'",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['users']);
  });

  it('rolls back partial state from a multi-statement failed migration', async () => {
    const migrations = [
      {
        name: '001_bad_multi.sql',
        sql: 'CREATE TABLE temp_table (id SERIAL PRIMARY KEY); INVALID SQL HERE',
      },
    ];

    await expect(applyPgMigrations(client, migrations)).rejects.toThrow(/INVALID/i);

    // temp_table should NOT exist — transaction rolled back
    const tables = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'temp_table'",
    );
    expect(tables.rows).toHaveLength(0);

    // No tracking entry
    const tracking = await pglite.query('SELECT name FROM _void_migrations');
    expect(tracking.rows).toHaveLength(0);
  });
});

describe('readPgAppliedMigrations', () => {
  it('reads status without creating the tracking table', async () => {
    await expect(readPgAppliedMigrations(client)).resolves.toEqual([]);
    const tracking = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = '_void_migrations'",
    );
    expect(tracking.rows).toEqual([]);
  });

  it('fails closed on errors other than a missing tracking table', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: '42501' });
    const failing: PgClient = {
      query: async () => {
        throw permissionError;
      },
    };
    await expect(readPgAppliedMigrations(failing)).rejects.toBe(permissionError);
  });
});
