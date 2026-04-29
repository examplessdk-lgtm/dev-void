import { applyPgAuthMigrations } from './auth-migrations.ts';
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
      'auth: Better Auth requires DATABASE_URL for local PostgreSQL dev or HYPERDRIVE in production.',
    );
  }

  return connectionString;
}

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  const { default: pg } = await import('pg');
  const connectionString = resolveConnectionString(env);
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
  if (runtime.dialect !== 'postgresql') {
    throw new Error(`auth: Runtime mismatch. Expected postgresql, received '${runtime.dialect}'.`);
  }
  if (migrationSchema.dialect !== 'postgresql') {
    throw new Error(
      `auth: Runtime mismatch. Expected postgresql, received '${migrationSchema.dialect}'.`,
    );
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: resolveConnectionString(env) });
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
