import { readConfig } from '../config.ts';
import { getMiniflareDatabasePath } from '../migrations/runner.ts';
import {
  applyMySqlAuthMigrations,
  applyPgAuthMigrations,
  applySqliteAuthMigrations,
  mysqlMigrationRunner,
  pgMigrationRunner,
} from '../runtime/auth-migrations.ts';
import type { VoidAuthDialect, VoidAuthEnv } from '../runtime/better-auth-shared.ts';
import { loadLocalEnv } from '../shared/env.ts';
import { findVoidAuthConfig, loadVoidAuthConfig } from './config.ts';
import { resolveVoidAuthMigrationSchema } from './drizzle.ts';

export async function runLocalVoidAuthMigrations(
  root: string,
  dialect: VoidAuthDialect,
  persistRoot: string,
  databaseId: string,
  configPath: string | null = findVoidAuthConfig(root),
): Promise<void> {
  const authConfig = await loadVoidAuthConfig(configPath);
  const runtime = {
    dialect,
    providers: readConfig(root).auth?.providers ?? null,
    userConfig: authConfig,
  };
  const env = { ...loadLocalEnv(root), ...process.env } as unknown as VoidAuthEnv;
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

  if (dialect === 'mysql') {
    const { createConnection } = await import('mysql2/promise');
    const connection = await createConnection(connectionString);
    try {
      await applyMySqlAuthMigrations(mysqlMigrationRunner(connection), migrationSchema);
    } finally {
      await connection.end();
    }
    return;
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await applyPgAuthMigrations(pgMigrationRunner(client), migrationSchema);
  } finally {
    await client.end();
  }
}
