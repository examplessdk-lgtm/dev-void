import { describe, expect, it } from 'vite-plus/test';
import { applyMySqlMigrations, type MySqlClient } from '../../src/migrations/runner-mysql.ts';

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
});
