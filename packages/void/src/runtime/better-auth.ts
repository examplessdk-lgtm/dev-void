import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { applySqliteAuthMigrations } from './auth-migrations.ts';
import {
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

async function applyMigrations(
  env: VoidAuthEnv,
  migrationSchema: VoidAuthMigrationSchema,
): Promise<void> {
  const database = env.DB;
  if (!database) {
    throw new Error('auth: Better Auth requires the "DB" D1 binding for sqlite apps.');
  }

  await applySqliteAuthMigrations(
    {
      async all<T extends Record<string, unknown>>(sql: string) {
        const result = await database.prepare(sql).all();
        return (result.results ?? []) as Array<T>;
      },
      async run(sql: string) {
        await database.prepare(sql).run();
      },
    },
    migrationSchema,
  );
}

const runtime = createVoidAuthRuntime('sqlite', resolveDatabase, applyMigrations);

export const resolveVoidAuthOptions: VoidAuthRuntimeApi['resolveVoidAuthOptions'] =
  runtime.resolveVoidAuthOptions;
export const resolveVoidAuthState: VoidAuthRuntimeApi['resolveVoidAuthState'] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi['runVoidAuthMiddleware'] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi['handleVoidAuthRequest'] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'] =
  runtime.runVoidAuthMigrations;
