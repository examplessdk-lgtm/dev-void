import { existsSync } from 'node:fs';
import { join } from 'pathslash';
import type { Plugin } from 'vite';
import type { DatabaseDialect } from './config.ts';
import { voidLog, voidWarn, voidError } from './log.ts';
import { afterServerReady } from './plugin-dev-config.ts';
import { readProjectPaths } from './project-paths.ts';
import { loadLocalEnv } from './shared/env.ts';

function readDatabaseUrl(root: string): string | undefined {
  return loadLocalEnv(root).DATABASE_URL;
}

/**
 * Vite plugin that runs local migrations on dev server startup.
 * For SQLite/D1: applies migrations to the local miniflare database.
 * For PostgreSQL/MySQL: connects via DATABASE_URL from .env.
 */
export function migrationPlugin(
  root: string,
  dialect: DatabaseDialect,
  databaseId: string = 'local',
  persistRoot: string = join(root, '.void'),
  auth?: { enabled: boolean; configPath?: string | null },
): Plugin {
  return {
    name: 'void:migrations',
    apply: 'serve',

    async configureServer(server) {
      const paths = readProjectPaths(root);
      const migrationsDir = paths.migrationsDir;
      const hasSqlMigrations = existsSync(migrationsDir);
      if (!hasSqlMigrations && !auth?.enabled) {
        return;
      }

      try {
        if (hasSqlMigrations && dialect !== 'sqlite') {
          const url = readDatabaseUrl(root);
          if (!url) {
            afterServerReady(server, () => {
              console.log();
              voidError(
                `DATABASE_URL not found in .env — skipping ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations.`,
              );
            });
            return;
          }
          const { collectMigrations } = await import('./migrations/collect.ts');
          const { validateMigrations } = await import('./migrations/validate.ts');

          const allMigrations = collectMigrations(migrationsDir);
          const appliedNames =
            dialect === 'mysql'
              ? await import('./migrations/runner-mysql.ts').then((runner) =>
                  runner.getMySqlAppliedMigrations(url),
                )
              : await import('./migrations/runner-pg.ts').then((runner) =>
                  runner.getPgAppliedMigrations(url),
                );
          const appliedSet = new Set(appliedNames);
          const pending = allMigrations.filter((migration) => !appliedSet.has(migration.name));
          if (pending.length > 0) {
            try {
              validateMigrations(pending);
            } catch (err) {
              voidWarn(err instanceof Error ? err.message : String(err));
            }
          }

          const applied =
            dialect === 'mysql'
              ? await import('./migrations/runner-mysql.ts').then((runner) =>
                  runner.runMySqlMigrations(migrationsDir, url),
                )
              : await import('./migrations/runner-pg.ts').then((runner) =>
                  runner.runPgMigrations(migrationsDir, url),
                );
          if (applied.length > 0) {
            voidLog(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
          }
        } else if (hasSqlMigrations) {
          const { runMigrations, getMiniflareDatabasePath, getAppliedMigrations } =
            await import('./migrations/runner.ts');
          const { collectMigrations } = await import('./migrations/collect.ts');
          const { validateMigrations } = await import('./migrations/validate.ts');
          const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);

          const allMigrations = collectMigrations(migrationsDir);
          const appliedRows = await getAppliedMigrations(dbPath);
          const appliedSet = new Set(appliedRows.map((r) => r.name));
          const pending = allMigrations.filter((m) => !appliedSet.has(m.name));
          if (pending.length > 0) {
            try {
              validateMigrations(pending);
            } catch (err) {
              voidWarn(err instanceof Error ? err.message : String(err));
            }
          }

          const applied = await runMigrations(migrationsDir, dbPath);
          if (applied.length > 0) {
            voidLog(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
          }
        }

        if (auth?.enabled) {
          const { runLocalVoidAuthMigrations } = await import('./auth/node.ts');
          await runLocalVoidAuthMigrations(root, dialect, persistRoot, databaseId, auth.configPath);
          voidLog('Applied Better Auth migrations');
        }
      } catch (err) {
        voidError(`Migration error: ${err}`);
      }
    },
  };
}
