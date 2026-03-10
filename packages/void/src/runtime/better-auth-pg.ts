import pg from "pg";
import {
  createVoidAuthRuntime,
  type ResolvedDatabase,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from "./better-auth-shared";

async function resolveDatabase(env: VoidAuthEnv): Promise<ResolvedDatabase> {
  const connectionString =
    typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0
      ? env.DATABASE_URL
      : typeof env.HYPERDRIVE?.connectionString === "string" &&
          env.HYPERDRIVE.connectionString.length > 0
        ? env.HYPERDRIVE.connectionString
        : undefined;

  if (!connectionString) {
    throw new Error(
      "Better Auth requires DATABASE_URL for local PostgreSQL dev or HYPERDRIVE in production.",
    );
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  return {
    database: pool,
    async dispose() {
      await pool.end();
    },
  };
}

const runtime = createVoidAuthRuntime("postgresql", resolveDatabase);

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
