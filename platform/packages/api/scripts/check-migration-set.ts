/**
 * Checks that a candidate drizzle migration set is an append-only extension of the released
 * set: every released file is unchanged, the released journal is a prefix of the candidate
 * journal, and every new entry is newer than the one before it.
 *
 * `drizzle-kit migrate` applies only journal entries whose `when` is later than the last entry
 * it applied and never re-runs an entry it has applied, so a set that fails this check would
 * migrate a fresh database differently from production. The `schema-compat` CI job runs this
 * from `$RUNNER_TEMP`, so it must not import anything from the repository.
 *
 * Usage:
 *   node scripts/check-migration-set.ts --baseline <released drizzle dir> --candidate <drizzle dir>
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export type JournalEntry = Readonly<{ idx: number; tag: string; when: number }>;

export type MigrationSet = Readonly<{
  /** relative path → sha256 hex, for every file under the migrations dir except meta/_journal.json */
  files: ReadonlyMap<string, string>;
  journal: ReadonlyArray<JournalEntry>;
}>;

const JOURNAL_PATH = 'meta/_journal.json';

// ── Reading ─────────────────────────────────────────────────────────

function hashFilesUnder(dir: string, prefix: string, into: Map<string, string>): void {
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      hashFilesUnder(dir, relativePath, into);
    } else if (relativePath !== JOURNAL_PATH) {
      into.set(
        relativePath,
        createHash('sha256')
          .update(readFileSync(join(dir, relativePath)))
          .digest('hex'),
      );
    }
  }
}

function readJournal(dir: string): ReadonlyArray<JournalEntry> {
  const path = join(dir, JOURNAL_PATH);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  const entries =
    typeof parsed === 'object' && parsed !== null && 'entries' in parsed
      ? parsed.entries
      : undefined;
  if (!Array.isArray(entries)) {
    throw new Error(`${path} has no "entries" array`);
  }
  return entries.map((raw: unknown, i) => {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('idx' in raw && typeof raw.idx === 'number') ||
      !('tag' in raw && typeof raw.tag === 'string') ||
      !('when' in raw && typeof raw.when === 'number')
    ) {
      throw new Error(`${path} entry ${i} lacks a numeric idx, a string tag, or a numeric when`);
    }
    return { idx: raw.idx, tag: raw.tag, when: raw.when };
  });
}

export function readMigrationSet(dir: string): MigrationSet {
  const files = new Map<string, string>();
  hashFilesUnder(dir, '', files);
  return { files, journal: readJournal(dir) };
}

// ── Comparison ──────────────────────────────────────────────────────

function describeEntry(entry: JournalEntry): string {
  return `${entry.tag} (idx ${entry.idx}, when ${entry.when})`;
}

/** Returns the reasons the candidate is not an append-only extension of the baseline; empty when it is. */
export function compareMigrationSets(
  baseline: MigrationSet,
  candidate: MigrationSet,
): Array<string> {
  const problems: Array<string> = [];

  let releasedFilesChanged = false;
  for (const [path, hash] of baseline.files) {
    const candidateHash = candidate.files.get(path);
    if (candidateHash === undefined) {
      problems.push(`released migration ${path} was removed`);
      releasedFilesChanged = true;
    } else if (candidateHash !== hash) {
      problems.push(`released migration ${path} was modified`);
      releasedFilesChanged = true;
    }
  }
  if (releasedFilesChanged) {
    problems.push(
      'Production never re-applies a migration it has already applied, so this database would not match production.',
    );
  }

  if (candidate.journal.length < baseline.journal.length) {
    problems.push(
      `journal is shorter than the released journal (${candidate.journal.length} entries, released ${baseline.journal.length})`,
    );
    return problems;
  }
  for (let i = 0; i < baseline.journal.length; i++) {
    const released = baseline.journal[i];
    const proposed = candidate.journal[i];
    if (
      released.idx !== proposed.idx ||
      released.tag !== proposed.tag ||
      released.when !== proposed.when
    ) {
      problems.push(
        `journal entry ${i} differs from the released journal: released ${describeEntry(released)}, candidate ${describeEntry(proposed)}`,
      );
      return problems;
    }
  }

  for (let i = baseline.journal.length; i < candidate.journal.length; i++) {
    const previous = candidate.journal[i - 1];
    const entry = candidate.journal[i];
    if (previous !== undefined && entry.when <= previous.when) {
      problems.push(
        `migration ${entry.tag} (idx ${entry.idx}) has timestamp ${entry.when}, not after the previous entry ${previous.tag} (${previous.when}); drizzle-kit migrate applies only entries newer than the last applied one and would skip it in production.`,
      );
    }
  }

  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────

function main(): void {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
    },
  });

  if (!values.baseline || !values.candidate) {
    console.error(
      'Usage: node check-migration-set.ts --baseline <released drizzle dir> --candidate <drizzle dir>',
    );
    process.exit(1);
  }

  if (!existsSync(join(values.baseline, JOURNAL_PATH))) {
    console.log(
      `The baseline ${values.baseline} has no ${JOURNAL_PATH}, so there is no released migration set to compare against.`,
    );
    return;
  }
  if (!existsSync(join(values.candidate, JOURNAL_PATH))) {
    console.error(`::error::The candidate ${values.candidate} has no ${JOURNAL_PATH}.`);
    process.exit(1);
  }

  const baseline = readMigrationSet(values.baseline);
  const candidate = readMigrationSet(values.candidate);
  const problems = compareMigrationSets(baseline, candidate);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `Migration set is an append-only extension of the released set (${baseline.journal.length} released, ${candidate.journal.length - baseline.journal.length} new).`,
  );
}

if (import.meta.main) {
  main();
}
