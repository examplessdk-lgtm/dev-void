import { applyPgAuthMigrations } from './auth-migrations.ts';
import {
  assertRuntimeDialect,
  createVoidAuthRuntime,
  resolveConnectionString,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';
import { disablePgPassFallback } from './pg.ts';

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  const { default: pg } = await import('pg');
  const connectionString = resolveConnectionString(env, 'PostgreSQL');
  const pool = new pg.Pool({ connectionString, max: 1 });
  return {
    database: pool,
    async dispose() {
      await pool.end();
    },
  };
}

async function runPostgresAuthMigrations(
  _request: Request,
  env: VoidAuthEnv,
  runtime: Parameters<VoidAuthRuntimeApi['runVoidAuthMigrations']>[2],
  migrationSchema: Parameters<VoidAuthRuntimeApi['runVoidAuthMigrations']>[3],
): Promise<void> {
  if (!migrationSchema) {
    throw new Error('auth: Migration schema is unavailable.');
  }
  assertRuntimeDialect(runtime, 'postgresql');
  if (migrationSchema.dialect !== 'postgresql') {
    throw new Error(
      `auth: Runtime mismatch. Expected postgresql, received '${migrationSchema.dialect}'.`,
    );
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: resolveConnectionString(env, 'PostgreSQL') });
  disablePgPassFallback(client);
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

const runtime = createVoidAuthRuntime('postgresql', resolveDatabase, runPostgresAuthMigrations);

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
