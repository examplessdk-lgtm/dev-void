import {
  createVoidAuthRuntime,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from "./better-auth-shared";

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  if (!env.DB) {
    throw new Error('Better Auth requires the "DB" D1 binding for sqlite apps.');
  }
  return {
    database: env.DB,
    async dispose() {},
  };
}

const runtime = createVoidAuthRuntime("sqlite", resolveDatabase);

export const resolveVoidAuthOptions: VoidAuthRuntimeApi["resolveVoidAuthOptions"] =
  runtime.resolveVoidAuthOptions;
export const createVoidAuth: VoidAuthRuntimeApi["createVoidAuth"] = runtime.createVoidAuth;
export const resolveVoidAuthState: VoidAuthRuntimeApi["resolveVoidAuthState"] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi["runVoidAuthMiddleware"] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi["handleVoidAuthRequest"] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi["runVoidAuthMigrations"] =
  runtime.runVoidAuthMigrations;

export type { VoidAuthDialect, VoidAuthEnv, VoidAuthRuntimeOptions } from "./better-auth-shared";
