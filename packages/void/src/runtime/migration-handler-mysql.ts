import {
  splitMigrationSql,
  type MigrationEntry,
  type MigrationResponse,
  type MigrationResult,
} from './migration-handler.ts';

export function createMigrationHandler(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry>,
  runAuthMigrations?: () => Promise<void>,
) {
  return async (request: Request): Promise<Response> => {
    const token = request.headers.get('x-void-internal');
    if (!token || token !== (env as Record<string, string>).__VOID_PROXY_TOKEN) {
      return Response.json(
        { ok: false, error: 'unauthorized', migrations: [] } satisfies MigrationResponse,
        { status: 401 },
      );
    }

    try {
      const result = await runMySqlMigrations(env, migrations);
      if (result.ok && runAuthMigrations) {
        await runAuthMigrations();
      }
      return Response.json(result);
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          migrations: [],
        } satisfies MigrationResponse,
        { status: 500 },
      );
    }
  };
}

async function runMySqlMigrations(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry>,
): Promise<MigrationResponse> {
  const hyperdrive = env.HYPERDRIVE as { connectionString?: string } | undefined;
  if (!hyperdrive?.connectionString) {
    return { ok: false, error: 'no HYPERDRIVE binding found', migrations: [] };
  }

  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({
    uri: hyperdrive.connectionString,
    multipleStatements: true,
  });
  try {
    await connection.query(
      'CREATE TABLE IF NOT EXISTS `_void_migrations` (`name` VARCHAR(255) PRIMARY KEY, `applied_at` VARCHAR(64) NOT NULL)',
    );
    const [rows] = await connection.query('SELECT `name` FROM `_void_migrations`');
    const applied = new Set((rows as Array<{ name: string }>).map((row) => String(row.name)));
    const results: Array<MigrationResult> = [];

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        results.push({ name: migration.name, applied: false, durationMs: 0 });
        continue;
      }
      const start = Date.now();
      try {
        // MySQL does not read drizzle-kit `--> statement-breakpoint` lines as comments.
        for (const statement of splitMigrationSql(migration.sql)) {
          await connection.query(statement);
        }
        await connection.query(
          'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
          [migration.name, new Date().toISOString()],
        );
        results.push({ name: migration.name, applied: true, durationMs: Date.now() - start });
      } catch (error) {
        results.push({
          name: migration.name,
          applied: false,
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, migrations: results, error: `migration ${migration.name} failed` };
      }
    }

    return { ok: true, migrations: results };
  } finally {
    await connection.end();
  }
}
