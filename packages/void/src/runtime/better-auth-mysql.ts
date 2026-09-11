import { applyMySqlAuthMigrations } from './auth-migrations.ts';
import {
  createVoidAuthRuntime,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';

function resolveConnectionString(env: VoidAuthEnv): string {
  const connectionString =
    typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.length > 0
      ? env.DATABASE_URL
      : typeof env.HYPERDRIVE?.connectionString === 'string' &&
          env.HYPERDRIVE.connectionString.length > 0
        ? env.HYPERDRIVE.connectionString
        : undefined;
  if (!connectionString) {
    throw new Error(
      'auth: Better Auth requires DATABASE_URL for local MySQL dev or HYPERDRIVE in production.',
    );
  }
  return connectionString;
}

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({ uri: resolveConnectionString(env), connectionLimit: 1 });
  return {
    database: pool,
    async dispose() {
      await pool.end();
    },
  };
}

async function runMySqlAuthMigrations(
  _request: Request,
  env: VoidAuthEnv,
  runtime: Parameters<VoidAuthRuntimeApi['runVoidAuthMigrations']>[2],
  migrationSchema: Parameters<VoidAuthRuntimeApi['runVoidAuthMigrations']>[3],
): Promise<void> {
  if (!migrationSchema) {
    throw new Error('auth: Migration schema is unavailable.');
  }
  if (runtime.dialect !== 'mysql' || migrationSchema.dialect !== 'mysql') {
    throw new Error('auth: Runtime mismatch. Expected mysql.');
  }

  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection(resolveConnectionString(env));
  try {
    await applyMySqlAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string, params?: Array<unknown>) {
          const [rows] = await connection.query(sql, params);
          return rows as Array<T>;
        },
        async run(sql: string, params?: Array<unknown>) {
          await connection.query(sql, params);
        },
      },
      migrationSchema,
    );
  } finally {
    await connection.end();
  }
}

const runtime = createVoidAuthRuntime('mysql', resolveDatabase, runMySqlAuthMigrations);

export const resolveVoidAuthOptions: VoidAuthRuntimeApi['resolveVoidAuthOptions'] =
  runtime.resolveVoidAuthOptions;
export const createVoidAuth: VoidAuthRuntimeApi['createVoidAuth'] = runtime.createVoidAuth;
export const resolveVoidAuthState: VoidAuthRuntimeApi['resolveVoidAuthState'] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi['runVoidAuthMiddleware'] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi['handleVoidAuthRequest'] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'] =
  runtime.runVoidAuthMigrations;

export type { VoidAuthDialect, VoidAuthEnv, VoidAuthRuntimeOptions } from './better-auth-shared.ts';
