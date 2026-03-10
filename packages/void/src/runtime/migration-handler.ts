export interface MigrationEntry {
  name: string;
  sql: string;
}

export interface MigrationResult {
  name: string;
  applied: boolean;
  durationMs: number;
  error?: string;
}

export interface MigrationResponse {
  ok: boolean;
  migrations: MigrationResult[];
  error?: string;
}

export function createMigrationHandler(
  env: Record<string, unknown>,
  migrations: MigrationEntry[] | undefined,
  _dialect: "sqlite" | "postgresql",
  runAuthMigrations?: () => Promise<void>,
) {
  return async (request: Request): Promise<Response> => {
    const token = request.headers.get("x-void-internal");
    if (!token || token !== (env as Record<string, string>).__VOID_PROXY_TOKEN) {
      return Response.json(
        { ok: false, error: "unauthorized", migrations: [] } satisfies MigrationResponse,
        {
          status: 401,
        },
      );
    }

    try {
      const db = (env as Record<string, D1Database>).DB;
      if (!db) {
        return Response.json(
          { ok: false, error: "no D1 binding found", migrations: [] } satisfies MigrationResponse,
          { status: 500 },
        );
      }
      const result = await runD1Migrations(db, migrations ?? []);
      if (result.ok && runAuthMigrations) {
        await runAuthMigrations();
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          migrations: [],
        } satisfies MigrationResponse,
        { status: 500 },
      );
    }
  };
}

async function runD1Migrations(
  db: D1Database,
  migrations: MigrationEntry[],
): Promise<MigrationResponse> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    )
    .run();

  const { results } = await db.prepare("SELECT name FROM _void_migrations").all();
  const applied = new Set((results ?? []).map((r) => r.name as string));

  const migrationResults: MigrationResult[] = [];

  for (const m of migrations) {
    if (applied.has(m.name)) {
      migrationResults.push({ name: m.name, applied: false, durationMs: 0 });
      continue;
    }

    const start = Date.now();
    try {
      await db.prepare(m.sql).run();
      await db
        .prepare("INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)")
        .bind(m.name, new Date().toISOString())
        .run();
      migrationResults.push({ name: m.name, applied: true, durationMs: Date.now() - start });
    } catch (err) {
      migrationResults.push({
        name: m.name,
        applied: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, migrations: migrationResults, error: `migration ${m.name} failed` };
    }
  }

  return { ok: true, migrations: migrationResults };
}
