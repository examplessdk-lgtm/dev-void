import { collectMigrations } from './collect.ts';

/**
 * Minimal client shape satisfied by both pg.Client and PGlite.
 */
export type PgClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: Array<unknown>,
  ): Promise<{ rows: Array<T> }>;
};

export async function readPgAppliedMigrations(client: PgClient): Promise<Array<string>> {
  try {
    const result = await client.query('SELECT name FROM _void_migrations');
    return result.rows.map((row) => String(row.name));
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as Record<string, unknown>).code === '42P01'
    ) {
      return [];
    }
    throw error;
  }
}

export async function getPgAppliedMigrations(url: string): Promise<Array<string>> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await readPgAppliedMigrations(client);
  } finally {
    await client.end();
  }
}

/**
 * Apply unapplied SQL migrations via a connected PostgreSQL client.
 * Each migration runs in its own transaction (BEGIN/COMMIT).
 */
export async function applyPgMigrations(
  client: PgClient,
  migrations: Array<{ name: string; sql: string }>,
): Promise<Array<string>> {
  if (migrations.length === 0) {
    return [];
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );

  const existing = await client.query('SELECT name FROM _void_migrations');
  const appliedSet = new Set(existing.rows.map((row) => String(row.name)));

  const pending = migrations.filter((m) => !appliedSet.has(m.name));
  if (pending.length === 0) {
    return [];
  }

  for (const m of pending) {
    await client.query('BEGIN');
    try {
      await client.query(m.sql);
      await client.query('INSERT INTO _void_migrations (name, applied_at) VALUES ($1, $2)', [
        m.name,
        new Date().toISOString(),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  return pending.map((m) => m.name);
}

/**
 * Apply unapplied SQL migrations to a PostgreSQL database.
 * Each migration runs in its own transaction (BEGIN/COMMIT).
 */
export async function runPgMigrations(migrationsDir: string, url: string): Promise<Array<string>> {
  const allMigrations = collectMigrations(migrationsDir);
  if (allMigrations.length === 0) {
    return [];
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    return await applyPgMigrations(client, allMigrations);
  } finally {
    await client.end();
  }
}
