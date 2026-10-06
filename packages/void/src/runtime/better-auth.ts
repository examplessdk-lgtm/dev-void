import { applySqliteAuthMigrations } from './auth-migrations.ts';
import {
  assertRuntimeDialect,
  createVoidAuthRuntime,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  if (!env.DB) {
    throw new Error('auth: Better Auth requires the "DB" D1 binding for sqlite apps.');
  }
  return {
    // Auth must observe current revocations. Keep its first lookup on the
    // primary, then preserve sequential consistency for the request.
    database: env.DB.withSession('first-primary') as unknown as D1Database,
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
    throw new Error('auth: Migration schema is unavailable.');
  }
  assertRuntimeDialect(runtime, 'sqlite');
  if (migrationSchema.dialect !== 'sqlite') {
    throw new Error(
      `auth: Runtime mismatch. Expected sqlite, received '${migrationSchema.dialect}'.`,
    );
  }
  if (!env.DB) {
    throw new Error('auth: Better Auth requires the "DB" D1 binding for sqlite apps.');
  }

  await applySqliteAuthMigrations(
    {
      async all<T extends Record<string, unknown>>(sql: string) {
        const result = await env.DB!.prepare(sql).all();
        return (result.results ?? []) as Array<T>;
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

export type { VoidAuthDialect, VoidAuthEnv, VoidAuthRuntimeOptions } from './better-auth-shared.ts';
