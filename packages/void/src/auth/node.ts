import { join } from 'node:path';
import { loadEnv } from 'vite';
import { readConfig } from '../config.ts';
import { getMiniflareDatabasePath } from '../migrations/runner.ts';
import { applyPgAuthMigrations, applySqliteAuthMigrations } from '../runtime/auth-migrations.ts';
import type { VoidAuthDialect, VoidAuthEnv } from '../runtime/better-auth-shared.ts';
import { findVoidAuthConfig, loadVoidAuthConfig } from './config.ts';
import { resolveVoidAuthMigrationSchema } from './drizzle.ts';

export async function runLocalVoidAuthMigrations(
  root: string,
  dialect: VoidAuthDialect,
  persistRoot: string = join(root, '.void'),
  databaseId: string = 'local',
  configPath: string | null = findVoidAuthConfig(root),
): Promise<void> {
  const authConfig = await loadVoidAuthConfig(configPath);
  const runtime = {
    dialect,
    providers: readConfig(root).auth?.providers ?? null,
    userConfig: authConfig,
  };
  const env = loadEnv('development', root, '') as unknown as VoidAuthEnv;
  const migrationSchema = resolveVoidAuthMigrationSchema(runtime, env);

  if (dialect === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
    const db = new DatabaseSync(dbPath);
    try {
      await applySqliteAuthMigrations(
        {
          async all<T extends Record<string, unknown>>(sql: string) {
            return db.prepare(sql).all() as Array<T>;
          },
          async run(sql: string) {
            db.prepare(sql).run();
          },
        },
        migrationSchema,
      );
    } finally {
      db.close();
    }
    return;
  }

  const connectionString =
    typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.length > 0
      ? env.DATABASE_URL
      : undefined;
  if (!connectionString) {
    return;
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await applyPgAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string, params?: Array<unknown>) {
          const result = await client.query(sql, params);
          return result.rows as Array<T>;
        },
        async run(sql: string, params?: Array<unknown>) {
          await client.query(sql, params);
        },
      },
      migrationSchema,
    );
  } finally {
    await client.end();
  }
}
