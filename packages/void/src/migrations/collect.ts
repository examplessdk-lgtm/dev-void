import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Collect all .sql migration files from the migrations directory,
 * sorted by filename (lexicographic order).
 */
export function collectMigrations(migrationsDir: string): { name: string; sql: string }[] {
  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name), 'utf-8'),
    }));
}

export interface DrizzleJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: DrizzleJournalEntry[];
}

/**
 * Read `db/migrations/meta/_journal.json` if it exists. Drizzle maintains
 * this file whenever `drizzle-kit generate` runs; every `.sql` migration
 * under `db/migrations/` should correspond to an entry whose `tag` is the
 * filename without the `.sql` suffix.
 */
export function readJournal(migrationsDir: string): DrizzleJournal | undefined {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(journalPath, 'utf-8')) as DrizzleJournal;
  } catch (err) {
    throw new Error(`Failed to parse db/migrations/meta/_journal.json: ${(err as Error).message}`);
  }
}

/**
 * Write `db/migrations/meta/_journal.json` with pretty-printed JSON and a
 * trailing newline, matching the format Drizzle itself emits. Creates the
 * `meta/` directory if it does not yet exist.
 */
export function writeJournal(migrationsDir: string, journal: DrizzleJournal): void {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
}

/**
 * Drop the `.sql` extension from a migration filename, leaving any other
 * suffix untouched. Used to line filenames up with journal `tag` values.
 */
export function stripSqlExt(name: string): string {
  return name.endsWith('.sql') ? name.slice(0, -4) : name;
}
