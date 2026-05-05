import { existsSync, readdirSync } from 'node:fs';
import { join } from 'pathe';
import {
  readJournal,
  stripSqlExt,
  type DrizzleJournal,
  type DrizzleJournalEntry,
} from './collect.ts';

export interface MigrationFile {
  name: string;
  sql: string;
  destructive: boolean;
}

/**
 * Destructive SQL patterns that are rejected unless the migration
 * contains the `-- void:allow-destructive` pragma comment.
 */
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i,
  /\bTRUNCATE\b/i,
];

const PRAGMA_COMMENT = '-- void:allow-destructive';

/**
 * Check if a SQL migration contains destructive operations.
 */
export function isDestructive(sql: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(sql));
}

/**
 * Validate migration files. Returns the validated list with destructive flags.
 * Throws if any destructive migration lacks the allow-destructive pragma.
 */
export function validateMigrations(
  files: Array<{ name: string; sql: string }>,
): Array<MigrationFile> {
  const results: Array<MigrationFile> = [];
  const errors: Array<string> = [];

  for (const file of files) {
    const destructive = isDestructive(file.sql);
    if (destructive && !file.sql.includes(PRAGMA_COMMENT)) {
      errors.push(file.name);
    }
    results.push({ name: file.name, sql: file.sql, destructive });
  }

  if (errors.length > 0) {
    throw new Error(
      `Destructive migrations detected without pragma:\n` +
        errors.map((f) => `  - ${f}`).join('\n') +
        `\n\nAdd "${PRAGMA_COMMENT}" to each file to allow the migration locally and on deploy.`,
    );
  }

  return results;
}

/**
 * Enumerate drizzle-kit metadata artifacts in a migrations directory.
 * Returns repo-relative paths like `db/migrations/meta/0000_snapshot.json`
 * and `db/migrations/migrations.js`. Empty when none are present.
 *
 * Shared across `assertJournalCoherence`, `void gen migration`, and
 * `void db rename-migrations` so all three agree on what counts as a
 * "partial drizzle-kit state" (journal gone but other metadata lingering).
 */
export function listDrizzleArtifacts(migrationsDir: string): Array<string> {
  const metaDir = join(migrationsDir, 'meta');
  const snapshotFiles = existsSync(metaDir)
    ? readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'))
    : [];
  const bundledPath = join(migrationsDir, 'migrations.js');
  const out: Array<string> = [];
  for (const f of snapshotFiles) {
    out.push(`db/migrations/meta/${f}`);
  }
  if (existsSync(bundledPath)) {
    out.push('db/migrations/migrations.js');
  }
  return out;
}

/**
 * Assert that every `.sql` file under `migrationsDir` has a matching entry
 * in `meta/_journal.json`, and vice versa.
 *
 * Drift is a silent footgun: the local/remote runners apply files directly
 * from disk, but `drizzle-kit generate` only sees what's in the journal.
 * An orphan file created by hand (or by a botched scaffold/merge) gets
 * applied to D1 without Drizzle ever acknowledging it, and a failed
 * deploy can leave the database in a state that is impossible to recover
 * from without manual SQL edits (see void-sdk/void#6).
 *
 * A missing journal is NOT a drift error. The drift check is a diff
 * between disk and `meta/_journal.json`; with no journal, there is nothing
 * to diff against. Bare-legacy projects — hand-written `.sql` files with no
 * `db/schema.ts`, no drizzle-kit, no `meta/` directory — worked long
 * before this check existed, and the local/remote runners still track
 * applied migrations by filename via `_void_migrations`. Gating those
 * projects here would break `void deploy`, `void db migrate`, `void db
 * reset`, and `void db status` for a valid path with no migration path
 * forward (they cannot run `void db generate` because it requires
 * `db/schema.ts`). We skip the check silently and let the filename-based
 * runners take over.
 *
 * Throws a user-facing error when any mismatch is detected between the
 * journal and disk. Returns silently otherwise.
 */
export function assertJournalCoherence(
  migrationsDir: string,
  collected: Array<{ name: string; sql: string }>,
): void {
  const journal = readJournal(migrationsDir);
  const drizzleArtifacts = listDrizzleArtifacts(migrationsDir);

  // `readJournal` returns `undefined` *only* when the file is absent on
  // disk. Any parseable JSON content — including scalars like `null`,
  // `false`, `0`, or `"string"` — comes back as a value. A plain falsy
  // check (`!journal`) would incorrectly collapse those corrupted shapes
  // into the "no journal at all" branch and silently fall through to
  // bare-legacy mode, after which `void gen migration` later crashes with
  // a raw TypeError when it dereferences `existingJournal.entries`.
  // Distinguish "file missing" from "file parseable but malformed" here.
  if (journal === undefined) {
    // No journal means the project is not drizzle-managed — UNLESS there
    // are other drizzle-kit artifacts still on disk (`meta/*_snapshot.json`
    // or a bundled `migrations.js`). Deleting `_journal.json` in isolation
    // is a realistic merge/cleanup failure; treating that as bare-legacy
    // would silently let `void db status`, `migrate`, `reset`, and `deploy`
    // continue on a corrupted drizzle state. Surface the partial state as
    // a hard error with a concrete recovery path. Otherwise, the "no
    // drizzle artifacts at all" shape is genuinely bare-legacy and we skip
    // the drift check — see the block comment above for the rationale.
    if (drizzleArtifacts.length > 0) {
      throw new Error(
        [
          'db/migrations/meta/_journal.json is missing, but other drizzle-kit metadata is still present:',
          ...drizzleArtifacts.map((p) => `  - ${p}`),
          '',
          'This is a partial drizzle-kit state. Restore _journal.json from version control, or delete the orphaned metadata files above if you intended to revert to hand-written migrations.',
        ].join('\n'),
      );
    }
    return;
  }

  // `readJournal` only guarantees the file parsed as JSON — a bad merge or
  // hand-edit can leave the top-level value as `null`, a scalar (number,
  // string, boolean), an array, or an object with `entries` replaced by a
  // non-array shape. Catch all of those here before the `.length` /
  // `.map()` calls below throw a raw `Cannot read properties of null` or
  // `...map is not a function`. Every caller (`runStatus`, `runMigrate`,
  // `runReset`, `runRenameMigrations`, both deploy paths, and
  // `runMigration`) reaches this helper, so surface the failure as an
  // actionable error with a concrete recovery path. `version` and
  // `dialect` are required here because `runRenameMigrations` writes them
  // back verbatim when rewriting the journal — a malformed top-level that
  // passes through this guard would otherwise produce a journal with
  // `version: undefined` / `dialect: undefined` and break every
  // subsequent drizzle-kit read.
  if (
    journal === null ||
    typeof journal !== 'object' ||
    Array.isArray(journal) ||
    typeof (journal as DrizzleJournal).version !== 'string' ||
    typeof (journal as DrizzleJournal).dialect !== 'string' ||
    !Array.isArray((journal as DrizzleJournal).entries)
  ) {
    throw new Error(
      'db/migrations/meta/_journal.json is malformed: expected an object with string `version`, string `dialect`, and an `entries` array. Restore the file from version control, or delete it if you intended to revert to hand-written migrations.',
    );
  }

  // A parseable journal with a well-formed top level can still carry
  // individual entries that are `null`, non-objects, or missing fields
  // that later mutation paths read back. These are the fields that
  // mutation commands (`void gen migration` custom-migration path and
  // `void db rename-migrations`) later read and rewrite back: `idx` feeds
  // `Math.max(...entries.map(e => e.idx))` when computing the next index,
  // `version` and `breakpoints` are inherited into the new entry, and
  // `tag` is the key the drift check + rename map operate on.
  // Validating them here guarantees every mutation path sees a
  // well-formed input before it starts writing — otherwise a malformed
  // entry like `{ "tag": "0000_a" }` would silently yield `idx: NaN`,
  // `version: undefined`, `breakpoints: undefined` in the rewritten
  // entry and leave the on-disk journal unusable.
  for (let i = 0; i < journal.entries.length; i++) {
    const entry = journal.entries[i];
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as DrizzleJournalEntry).idx !== 'number' ||
      typeof (entry as DrizzleJournalEntry).version !== 'string' ||
      typeof (entry as DrizzleJournalEntry).tag !== 'string' ||
      typeof (entry as DrizzleJournalEntry).breakpoints !== 'boolean'
    ) {
      throw new Error(
        `db/migrations/meta/_journal.json is malformed: entry at index ${i} is missing required fields (\`idx\`, \`version\`, \`tag\`, \`breakpoints\`). Restore the file from version control, or delete it if you intended to revert to hand-written migrations.`,
      );
    }
  }

  // Empty-entries journal: two shapes share `entries.length === 0` but
  // must be handled differently.
  //
  // 1. Placeholder shape — `{ "entries": [] }` with NO accompanying
  //    drizzle-kit artifacts (no snapshot JSONs, no bundled
  //    `migrations.js`). The checked-in kitchen-sink playground ships
  //    exactly this shape: empty journal, old-style `.sql` files on
  //    disk, no drizzle-kit metadata at all. Historically this was a
  //    supported legacy setup, and treating it as drizzle-managed
  //    would flag every `.sql` file as an orphan and break `void db
  //    status`, `migrate`, `reset`, and `deploy` on unchanged
  //    projects. Functionally identical to "no journal at all" —
  //    skip the drift check with the same legacy rationale.
  //
  // 2. Half-deleted drizzle state — `{ "entries": [] }` WITH drizzle
  //    artifacts still on disk. This is the same realistic merge /
  //    cleanup failure the missing-journal branch above handles:
  //    someone wiped the journal entries without also cleaning up the
  //    snapshot files or the compiled bundle. Without this gate the
  //    drift diff below silently passes (journalTags is empty,
  //    collectedTags is empty if all `.sql` files were deleted too),
  //    and every downstream command — `void db status`, `migrate`,
  //    `reset`, `deploy`, `void gen migration` — would continue on a
  //    corrupted drizzle state. Surface the partial state as a hard
  //    error with a concrete recovery path so it matches what `void
  //    gen migration` already refuses elsewhere.
  if (journal.entries.length === 0) {
    if (drizzleArtifacts.length === 0) {
      return;
    }
    throw new Error(
      [
        'db/migrations/meta/_journal.json has no entries, but drizzle-kit metadata is still present:',
        ...drizzleArtifacts.map((p) => `  - ${p}`),
        '',
        'This is a partial drizzle-kit state. Restore _journal.json from version control (or run `void db generate`), or delete the orphaned metadata files above if you intended to revert to hand-written migrations.',
      ].join('\n'),
    );
  }

  // A bad merge or hand-edit can leave two `entries` objects sharing the
  // same `tag` (e.g. `[{ tag: "0000_initial" }, { tag: "0000_initial" }]`).
  // The `new Set(...)` below would silently collapse those into a single
  // entry and the drift diff would pass, after which every downstream
  // caller — `deploy`, `db migrate`, `db status`, `void gen migration`,
  // `void db rename-migrations` — would proceed on a duplicated journal.
  // `rename-migrations` in particular would rewrite both copies to the
  // same new tag, deepening the corruption. Surface duplicates here with
  // an actionable error so every entry point refuses the corrupted state
  // uniformly.
  const tagCounts = new Map<string, number>();
  for (const entry of journal.entries) {
    tagCounts.set(entry.tag, (tagCounts.get(entry.tag) ?? 0) + 1);
  }
  const duplicateTags = [...tagCounts.entries()].filter(([, n]) => n > 1).map(([tag]) => tag);
  if (duplicateTags.length > 0) {
    throw new Error(
      [
        'db/migrations/meta/_journal.json has duplicate migration entries:',
        ...duplicateTags.map((t) => `  - ${t} (appears ${tagCounts.get(t)} times)`),
        '',
        'Each migration must have a unique tag. Restore _journal.json from version control, or hand-edit to remove the duplicates.',
      ].join('\n'),
    );
  }

  const journalTags = new Set(journal.entries.map((e) => e.tag));
  const collectedTags = new Set(collected.map((m) => stripSqlExt(m.name)));

  const orphans = collected
    .map((m) => m.name)
    .filter((name) => !journalTags.has(stripSqlExt(name)));
  const missing = journal.entries
    .map((e) => `${e.tag}.sql`)
    .filter((file) => !collectedTags.has(stripSqlExt(file)));

  if (orphans.length === 0 && missing.length === 0) {
    return;
  }

  const lines: Array<string> = [
    'Migration drift detected between db/migrations/ and db/migrations/meta/_journal.json.',
  ];
  if (orphans.length > 0) {
    lines.push('', 'These files exist on disk but are not tracked in _journal.json:');
    for (const f of orphans) {
      lines.push(`  - db/migrations/${f}`);
    }
    lines.push(
      '',
      'Delete the orphan file(s), or move their contents into `db/schema.ts` and re-run `void db generate`.',
    );
  }
  if (missing.length > 0) {
    lines.push('', 'These entries are in _journal.json but the matching file is missing:');
    for (const f of missing) {
      lines.push(`  - db/migrations/${f}`);
    }
    lines.push('', 'Restore the missing file(s) from version control, or regenerate migrations.');
  }
  throw new Error(lines.join('\n'));
}
