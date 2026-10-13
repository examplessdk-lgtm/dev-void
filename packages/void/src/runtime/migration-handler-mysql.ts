import type { Connection } from 'mysql2/promise';
import {
  splitMigrationSql,
  type MigrationEntry,
  type MigrationResponse,
  type MigrationResult,
} from './migration-handler.ts';
import { acquireMySqlMigrationLease, type MySqlMigrationLease } from './migration-lock-mysql.ts';

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
    disableEval: true,
  });
  let leaseConnection: Connection | undefined;
  let lease: MySqlMigrationLease | undefined;
  try {
    // Lease statements must stay out of the migration transactions, so they get their own connection.
    const leaseClient = await createConnection({
      uri: hyperdrive.connectionString,
      disableEval: true,
    });
    leaseConnection = leaseClient;
    lease = await acquireMySqlMigrationLease(
      async (sql, params) => (await leaseClient.query(sql, params))[0],
    );
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
        // Data changes commit with the tracking row. MySQL commits DDL, and anything before it,
        // on its own. Hyperdrive keeps one connection for the open transaction.
        await connection.query('BEGIN');
        // MySQL does not read drizzle-kit `--> statement-breakpoint` lines as comments.
        for (const statement of splitMigrationSql(migration.sql)) {
          await lease.renew();
          await connection.query(statement);
        }
        await lease.renew();
        await connection.query(
          'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
          [migration.name, new Date().toISOString()],
        );
        await connection.query('COMMIT');
        results.push({ name: migration.name, applied: true, durationMs: Date.now() - start });
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => {});
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
    await lease?.release().catch(() => {});
    await Promise.all([connection.end(), leaseConnection?.end()]);
  }
}
