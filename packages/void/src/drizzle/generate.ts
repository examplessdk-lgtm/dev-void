import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { collectMigrations } from '../migrations/collect.ts';
import { openMigrationValidationDatabase } from '../migrations/sqlite-validation.ts';

function snapshotFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        files.set(path, readFileSync(path));
      }
    }
  }
  return files;
}

/** Keep SQL and Drizzle's snapshot/journal together when generation fails validation. */
export async function generateValidatedSqliteMigrations(
  migrationsDir: string,
  generate: () => void,
): Promise<void> {
  // An existing invalid migration needs repair; generating from its target snapshot cannot fix it.
  try {
    (await openMigrationValidationDatabase(collectMigrations(migrationsDir))).close();
  } catch (cause) {
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n` +
        'Repair the unapplied migration before generating again. Drizzle diffs snapshots; rerunning generation does not repair existing SQL.',
      { cause },
    );
  }

  const existed = existsSync(migrationsDir);
  const previous = snapshotFiles(migrationsDir);
  try {
    generate();
    (await openMigrationValidationDatabase(collectMigrations(migrationsDir))).close();
  } catch (cause) {
    if (!existed) {
      rmSync(migrationsDir, { recursive: true, force: true });
    } else {
      for (const path of snapshotFiles(migrationsDir).keys()) {
        if (!previous.has(path)) {
          rmSync(path);
        }
      }
      for (const [path, contents] of previous) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
      }
    }
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n` +
        'Migration generation failed; previous SQL, snapshots and journal were restored. Review the schema change before retrying. For additive changes, use an additive migration rather than rebuilding existing tables.',
      { cause },
    );
  }
}
