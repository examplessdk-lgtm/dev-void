import { applySqliteAuthMigrations } from './auth-migrations';
import {
  createVoidAuthRuntime,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared';

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  if (!env.DB) {
    throw new Error('Better Auth requires the "DB" D1 binding for sqlite apps.');
  }
  return {
    database: env.DB,
    async dispose() {},
  };
}

async function runSqliteAuthMigrations(
  _request: Request,
  env: VoidAuthEnv,
  runtime: Parameters<VoidAuthRuntimeApi['runVoidAuthMigrations']>[2],
  migrationSchema: Parameters<VoidAuthRuntimeApi['runVoidAuthMigrations']>[3],
): Promise<void> {
  if (!migrationSchema) {
    throw new Error('Void auth migration schema is unavailable.');
  }
  if (runtime.dialect !== 'sqlite') {
    throw new Error(`Void auth runtime mismatch: expected sqlite, received ${runtime.dialect}.`);
  }
  if (migrationSchema.dialect !== 'sqlite') {
    throw new Error(
      `Void auth runtime mismatch: expected sqlite, received ${migrationSchema.dialect}.`,
    );
  }
  if (!env.DB) {
    throw new Error('Better Auth requires the "DB" D1 binding for sqlite apps.');
  }

  await applySqliteAuthMigrations(
    {
      async all<T extends Record<string, unknown>>(sql: string) {
        const result = await env.DB!.prepare(sql).all();
        return (result.results ?? []) as T[];
      },
      async run(sql: string) {
        await env.DB!.prepare(sql).run();
      },
    },
    migrationSchema,
  );
}

const runtime = createVoidAuthRuntime('sqlite', resolveDatabase, runSqliteAuthMigrations);

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

export type { VoidAuthDialect, VoidAuthEnv, VoidAuthRuntimeOptions } from './better-auth-shared';
