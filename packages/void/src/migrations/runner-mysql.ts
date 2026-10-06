import type { Connection } from 'mysql2/promise';
import { collectMigrations } from './collect.ts';

export type MySqlClient = {
  query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<T>;
};

export async function readMySqlAppliedMigrations(client: MySqlClient): Promise<Array<string>> {
  try {
    const rows = await client.query<Array<{ name: string }>>(
      'SELECT `name` FROM `_void_migrations`',
    );
    return rows.map((row) => String(row.name));
  } catch (error) {
    const value =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
    if (value?.code === 'ER_NO_SUCH_TABLE' || value?.errno === 1146) {
      return [];
    }
    throw error;
  }
}

function toMySqlClient(connection: Connection): MySqlClient {
  return {
    async query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
      sql: string,
      params?: Array<unknown>,
    ): Promise<T> {
      const [rows] = await connection.query(sql, params);
      return (Array.isArray(rows) ? rows : []) as T;
    },
  };
}

export async function getMySqlAppliedMigrations(url: string): Promise<Array<string>> {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection(url);
  try {
    return await readMySqlAppliedMigrations(toMySqlClient(connection));
  } finally {
    await connection.end();
  }
}

export async function applyMySqlMigrations(
  client: MySqlClient,
  migrations: Array<{ name: string; sql: string }>,
): Promise<Array<string>> {
  if (migrations.length === 0) {
    return [];
  }

  await client.query(
    'CREATE TABLE IF NOT EXISTS `_void_migrations` (`name` VARCHAR(255) PRIMARY KEY, `applied_at` VARCHAR(64) NOT NULL)',
  );
  const existing = await client.query<Array<{ name: string }>>(
    'SELECT `name` FROM `_void_migrations`',
  );
  const appliedSet = new Set(existing.map((row) => String(row.name)));
  const pending = migrations.filter((migration) => !appliedSet.has(migration.name));

  for (const migration of pending) {
    await client.query(migration.sql);
    await client.query('INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)', [
      migration.name,
      new Date().toISOString(),
    ]);
  }

  return pending.map((migration) => migration.name);
}

export async function runMySqlMigrations(
  migrationsDir: string,
  url: string,
): Promise<Array<string>> {
  const migrations = collectMigrations(migrationsDir);
  if (migrations.length === 0) {
    return [];
  }

  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({ uri: url, multipleStatements: true });
  try {
    return await applyMySqlMigrations(toMySqlClient(connection), migrations);
  } finally {
    await connection.end();
  }
}
