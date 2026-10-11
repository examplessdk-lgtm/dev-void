import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { applyMySqlAuthMigrations, mysqlMigrationRunner } from './auth-migrations.ts';
import {
  createVoidAuthRuntime,
  resolveConnectionString,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({ uri: resolveConnectionString(env, 'MySQL'), connectionLimit: 1 });
  return {
    database: pool,
    async dispose() {
      await pool.end();
    },
  };
}

async function applyMigrations(
  env: VoidAuthEnv,
  migrationSchema: VoidAuthMigrationSchema,
): Promise<void> {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection(resolveConnectionString(env, 'MySQL'));
  try {
    await applyMySqlAuthMigrations(mysqlMigrationRunner(connection), migrationSchema);
  } finally {
    await connection.end();
  }
}

const runtime = createVoidAuthRuntime('mysql', resolveDatabase, applyMigrations);

export const resolveVoidAuthState: VoidAuthRuntimeApi['resolveVoidAuthState'] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi['runVoidAuthMiddleware'] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi['handleVoidAuthRequest'] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'] =
  runtime.runVoidAuthMigrations;
