import { join } from "node:path";
import { loadEnv } from "vite";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import { readConfig } from "../config";
import { getMiniflareDatabasePath } from "../migrations/runner";
import { findVoidAuthConfig, loadVoidAuthConfig } from "./config";
import type { VoidAuthDialect, VoidAuthEnv } from "../runtime/better-auth-shared";

export async function runLocalVoidAuthMigrations(
  root: string,
  dialect: VoidAuthDialect,
  persistRoot = join(root, ".void"),
  databaseId = "local",
  configPath: string | null = findVoidAuthConfig(root),
): Promise<void> {
  const authConfig = await loadVoidAuthConfig(configPath);
  const runtime = {
    dialect,
    providers: readConfig(root).auth?.providers ?? null,
    userConfig: authConfig,
  };

  const env = loadEnv("development", root, "") as unknown as VoidAuthEnv;
  const request = new Request("http://localhost/api/auth");

  if (dialect === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const { resolveVoidAuthOptions } = await import("../runtime/better-auth");
    const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
    const db = new DatabaseSync(dbPath);
    try {
      const { options } = await resolveVoidAuthOptions(request, env, runtime, db as any);
      const { runMigrations } = await getMigrations(options);
      await runMigrations();
    } finally {
      db.close();
    }
    return;
  }

  const connectionString =
    typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0
      ? env.DATABASE_URL
      : undefined;
  if (!connectionString) return;

  const { resolveVoidAuthOptions } = await import("../runtime/better-auth-pg");
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { options } = await resolveVoidAuthOptions(request, env, runtime, pool as any);
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
  } finally {
    await pool.end();
  }
}
