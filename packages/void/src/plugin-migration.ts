import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { DatabaseDialect } from './config';
import { voidLog, voidWarn, voidError } from './log';

function readDatabaseUrl(root: string): string | undefined {
  const envPath = join(root, '.env.local');
  if (!existsSync(envPath)) {
    return undefined;
  }
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (key !== 'DATABASE_URL') {
      continue;
    }
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * Vite plugin that runs local migrations on dev server startup.
 * For SQLite/D1: applies migrations to the local miniflare database.
 * For PostgreSQL: connects via DATABASE_URL from .env.local.
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
      const migrationsDir = join(root, 'db', 'migrations');
      const hasSqlMigrations = existsSync(migrationsDir);
      if (!hasSqlMigrations && !auth?.enabled) {
        return;
      }

      try {
        if (hasSqlMigrations && dialect === 'postgresql') {
          const url = readDatabaseUrl(root);
          if (!url) {
            // Defer warning until after Vite prints "ready" so it's visible.
            const warn = () => {
              console.log();
              voidError('DATABASE_URL not found in .env.local — skipping PostgreSQL migrations.');
            };
            if (server.httpServer) {
              server.httpServer.once('listening', () => setTimeout(warn, 100));
            } else {
              warn();
            }
            return;
          }
          const { runPgMigrations } = await import('./migrations/runner-pg');
          const { collectMigrations } = await import('./migrations/collect');
          const { validateMigrations } = await import('./migrations/validate');

          const allMigrations = collectMigrations(migrationsDir);
          try {
            validateMigrations(allMigrations);
          } catch (err) {
            voidWarn(err instanceof Error ? err.message : String(err));
          }

          const applied = await runPgMigrations(migrationsDir, url);
          if (applied.length > 0) {
            voidLog(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
          }
        } else if (hasSqlMigrations) {
          const { runMigrations, getMiniflareDatabasePath, getAppliedMigrations } =
            await import('./migrations/runner');
          const { collectMigrations } = await import('./migrations/collect');
          const { validateMigrations } = await import('./migrations/validate');
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
          const { runLocalVoidAuthMigrations } = await import('./auth/node');
          await runLocalVoidAuthMigrations(root, dialect, persistRoot, databaseId, auth.configPath);
          voidLog('Applied Better Auth migrations');
        }
      } catch (err) {
        voidError(`Migration error: ${err}`);
      }
    },
  };
}
