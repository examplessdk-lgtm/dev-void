import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vite-plus/test';
import { classifyMigration } from '../../src/migrations/plan.ts';
import {
  assertJournalCoherence,
  isDestructive,
  validateMigrations,
} from '../../src/migrations/validate.ts';

describe('isDestructive', () => {
  it('detects DROP TABLE', () => {
    expect(isDestructive('DROP TABLE users;')).toBe(true);
  });

  it('detects DROP TABLE case-insensitive', () => {
    expect(isDestructive('drop table users;')).toBe(true);
    expect(isDestructive('Drop Table users;')).toBe(true);
  });

  it('detects DROP COLUMN', () => {
    expect(isDestructive('ALTER TABLE users DROP COLUMN email;')).toBe(true);
  });

  it('detects ALTER TABLE ... RENAME', () => {
    expect(isDestructive('ALTER TABLE users RENAME TO people;')).toBe(true);
  });

  it('returns false for safe SQL', () => {
    expect(isDestructive('CREATE TABLE users (id TEXT PRIMARY KEY);')).toBe(false);
  });

  it.each(['NULL', 'DEFAULT'])('allows foreign-key SET %s actions in table DDL', (action) => {
    const reference = `REFERENCES users(id) ON UPDATE NO ACTION ON DELETE SET ${action}`;
    expect(isDestructive(`CREATE TABLE posts (userId TEXT ${reference});`)).toBe(false);
    expect(isDestructive(`CREATE TEMP TABLE posts (userId TEXT ${reference});`)).toBe(false);
    expect(isDestructive(`ALTER TABLE posts ADD COLUMN userId TEXT ${reference};`)).toBe(false);
    expect(
      isDestructive(`CREATE TABLE posts (userId TEXT ${reference}); UPDATE users SET name = NULL;`),
    ).toBe(true);
  });

  it('still detects writes in trigger bodies', () => {
    expect(
      isDestructive(
        'CREATE TRIGGER clear_names AFTER INSERT ON posts BEGIN UPDATE users SET name = NULL; END;',
      ),
    ).toBe(true);
  });

  it('returns false for bounded INSERT/UPDATE/DELETE', () => {
    expect(isDestructive("INSERT INTO users VALUES ('1', 'test');")).toBe(false);
    expect(isDestructive("UPDATE users SET name = 'test' WHERE id = '1';")).toBe(false);
    expect(isDestructive("DELETE FROM users WHERE id = '1';")).toBe(false);
  });

  it('detects unbounded UPDATE and DELETE', () => {
    expect(isDestructive("UPDATE users SET name = 'test';")).toBe(true);
    expect(isDestructive('DELETE FROM users;')).toBe(true);
  });

  it('detects unbounded writes per statement', () => {
    expect(isDestructive("DELETE FROM users; UPDATE posts SET name = 'test' WHERE id = '1';")).toBe(
      true,
    );
    expect(isDestructive("UPDATE users SET name = (SELECT name FROM posts WHERE id = '1');")).toBe(
      true,
    );
  });

  it('does not treat nested WHERE clauses as the UPDATE or DELETE bound', () => {
    expect(
      isDestructive('DELETE FROM users WHERE id IN (SELECT id FROM posts WHERE ok = 1);'),
    ).toBe(false);
    expect(isDestructive('UPDATE users SET name = name WHERE id IN (SELECT id FROM posts);')).toBe(
      false,
    );
  });

  it('returns false for ADD COLUMN', () => {
    expect(isDestructive('ALTER TABLE users ADD COLUMN age INTEGER;')).toBe(false);
  });

  it('detects TRUNCATE TABLE', () => {
    expect(isDestructive('TRUNCATE TABLE users;')).toBe(true);
    expect(isDestructive('truncate table users;')).toBe(true);
  });

  it('detects TRUNCATE without TABLE keyword (PostgreSQL)', () => {
    expect(isDestructive('TRUNCATE users;')).toBe(true);
    expect(isDestructive('truncate users, posts;')).toBe(true);
  });
});

describe('validateMigrations', () => {
  it('returns validated files for safe migrations', () => {
    const result = validateMigrations([
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: '001_create.sql',
      sql: 'CREATE TABLE users (id TEXT);',
      destructive: false,
    });
  });

  it('allows destructive migration with pragma', () => {
    const sql = '-- void:allow-destructive\nDROP TABLE old_users;';
    const result = validateMigrations([{ name: '003_drop.sql', sql }]);
    expect(result).toHaveLength(1);
    expect(result[0].destructive).toBe(true);
  });

  it('throws for destructive migration without pragma', () => {
    expect(() =>
      validateMigrations([{ name: '003_drop.sql', sql: 'DROP TABLE old_users;' }]),
    ).toThrow('Destructive migrations detected');
  });

  it('includes all failing filenames in error', () => {
    expect(() =>
      validateMigrations([
        { name: '003_drop.sql', sql: 'DROP TABLE a;' },
        { name: '004_rename.sql', sql: 'ALTER TABLE b RENAME TO c;' },
      ]),
    ).toThrow(/003_drop\.sql[\s\S]*004_rename\.sql/);
  });

  it('handles empty list', () => {
    const result = validateMigrations([]);
    expect(result).toEqual([]);
  });
});

describe('classifyMigration', () => {
  it('does not reject CREATE TRIGGER bodies as transaction control', () => {
    const plan = classifyMigration({
      name: '001_trigger.sql',
      sql: [
        'CREATE TRIGGER users_updated',
        'AFTER UPDATE ON users',
        'BEGIN',
        "  INSERT INTO audit_log(message) VALUES('updated');",
        'END;',
      ].join('\n'),
    });

    expect(plan).toEqual(
      expect.objectContaining({
        kind: 'legacy-unsplit-multi-statement',
        stability: 'legacy',
      }),
    );
  });

  it('still rejects explicit transaction-control statements', () => {
    expect(() =>
      classifyMigration({
        name: '001_tx.sql',
        sql: 'BEGIN;\nCREATE TABLE users (id TEXT);\nCOMMIT;',
      }),
    ).toThrow('contains BEGIN');
  });

  it('only splits on executable statement breakpoint comments', () => {
    const plan = classifyMigration({
      name: '001_breakpoints.sql',
      sql:
        "INSERT INTO logs(message) VALUES('--> statement-breakpoint');\n" +
        'CREATE TABLE users (id TEXT);\n' +
        '--> statement-breakpoint\n' +
        'CREATE TABLE posts (id TEXT);',
    });

    expect(plan).toEqual(
      expect.objectContaining({
        kind: 'breakpoint-framed',
        statements: [
          "INSERT INTO logs(message) VALUES('--> statement-breakpoint');\nCREATE TABLE users (id TEXT);",
          'CREATE TABLE posts (id TEXT);',
        ],
        stability: 'stable',
      }),
    );
  });
});

describe('assertJournalCoherence', () => {
  let root: string;
  let migrationsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-journal-'));
    migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJournal(tags: Array<string>): void {
    const entries = tags.map((tag, idx) => ({
      idx,
      version: '7',
      when: Date.now(),
      tag,
      breakpoints: true,
    }));
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
    );
  }

  it('passes when disk and journal match', () => {
    writeJournal(['0000_silent_the_anarchist']);
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_silent_the_anarchist.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]),
    ).not.toThrow();
  });

  it('passes on an empty project with no journal and no files', () => {
    rmSync(migrationsDir, { recursive: true, force: true });
    expect(() => assertJournalCoherence(migrationsDir, [])).not.toThrow();
  });

  it('throws when a .sql file has no matching journal entry', () => {
    writeJournal(['0000_silent_the_anarchist']);
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_silent_the_anarchist.sql', sql: 'CREATE TABLE posts (id TEXT);' },
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE IF NOT EXISTS posts (id TEXT);' },
      ]),
    ).toThrow(/0000_create_posts\.sql/);
  });

  it('throws when a journal entry has no matching .sql file', () => {
    writeJournal(['0000_silent_the_anarchist', '0001_add_author']);
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_silent_the_anarchist.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]),
    ).toThrow(/0001_add_author\.sql/);
  });

  it('passes in legacy mode: files on disk but no journal at all', () => {
    // Bare-legacy projects (hand-written .sql migrations, no db/schema.ts,
    // no drizzle-kit) never have a `_journal.json`. The drift check has
    // nothing to diff against there — the local/remote runners track
    // applied migrations by filename via `_void_migrations`. Missing
    // journal must pass silently.
    rmSync(join(migrationsDir, 'meta', '_journal.json'), { force: true });
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE posts (id TEXT);' },
        { name: '0001_add_author.sql', sql: 'ALTER TABLE posts ADD COLUMN author TEXT;' },
      ]),
    ).not.toThrow();
  });

  it('passes in legacy mode even when meta/ itself does not exist', () => {
    // Some bare-legacy projects never created a meta/ directory at all.
    // assertJournalCoherence must not synthesize drift from thin air.
    rmSync(migrationsDir, { recursive: true, force: true });
    mkdirSync(migrationsDir, { recursive: true });
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]),
    ).not.toThrow();
  });

  it('passes on a placeholder journal: empty entries, disk files, no snapshots (kitchen-sink shape)', () => {
    // The checked-in kitchen-sink playground ships `meta/_journal.json` with
    // `{ "entries": [] }` alongside hand-written .sql files and no snapshot
    // metadata. That's functionally identical to "no journal at all" — the
    // drift gate must treat it as bare-legacy so `void db status`, `migrate`,
    // `reset`, and `deploy` keep working on unchanged projects.
    writeJournal([]);
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '001_create_notes.sql', sql: 'CREATE TABLE notes (id TEXT);' },
        { name: '002_create_queue_results.sql', sql: 'CREATE TABLE queue_results (id TEXT);' },
      ]),
    ).not.toThrow();
  });

  it('throws on an empty-entries journal when a snapshot is also present', () => {
    // An empty journal with snapshot files is NOT the bare-legacy shape;
    // it's a half-deleted drizzle state. Surface it as a hard error
    // referencing the specific leftover artifact, the same way the
    // missing-journal branch does. The presence of `.sql` files on
    // disk is irrelevant — the journal-vs-artifacts mismatch is the
    // corruption signal.
    writeJournal([]);
    writeFileSync(join(migrationsDir, 'meta', '0000_snapshot.json'), JSON.stringify({ id: 'abc' }));

    let message = '';
    try {
      assertJournalCoherence(migrationsDir, [
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('has no entries');
    expect(message).toContain('db/migrations/meta/0000_snapshot.json');
    expect(message).toContain('partial drizzle-kit state');
  });

  it('throws on an empty-entries journal with a snapshot even when no .sql files remain', () => {
    // The half-deleted shape where `_journal.json` has `entries: []`, a
    // stale `meta/*_snapshot.json` is still present, and every on-disk
    // `.sql` file has been deleted. The drift diff finds neither orphans
    // nor missing entries here, so the guard must fire on its own.
    writeJournal([]);
    writeFileSync(join(migrationsDir, 'meta', '0000_snapshot.json'), JSON.stringify({ id: 'abc' }));

    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('has no entries');
    expect(message).toContain('db/migrations/meta/0000_snapshot.json');
    expect(message).toContain('partial drizzle-kit state');
  });

  it('throws on an empty-entries journal when the bundled migrations.js is still present', () => {
    // Same half-deleted shape but with the bundled-mode
    // artifact (`db/migrations/migrations.js`) left behind instead of
    // a snapshot JSON. `void gen migration` already refuses this
    // shape; `assertJournalCoherence` must match so every downstream
    // command surfaces the corruption uniformly.
    writeJournal([]);
    writeFileSync(join(migrationsDir, 'migrations.js'), 'export default {};\n');

    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('has no entries');
    expect(message).toContain('db/migrations/migrations.js');
    expect(message).toContain('partial drizzle-kit state');
  });

  it('throws when _journal.json is missing but a meta/*_snapshot.json is present', () => {
    // Deleting just `_journal.json` while leaving `meta/*_snapshot.json`
    // behind is a realistic merge/cleanup failure. Treating that as bare-
    // legacy would silently let `void db status`, `migrate`, `reset`, and
    // `deploy` continue on a partial drizzle-kit state. Surface it as a
    // hard error with a concrete recovery path.
    rmSync(join(migrationsDir, 'meta', '_journal.json'), { force: true });
    writeFileSync(join(migrationsDir, 'meta', '0000_snapshot.json'), JSON.stringify({ id: 'abc' }));

    let message = '';
    try {
      assertJournalCoherence(migrationsDir, [
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json is missing');
    expect(message).toContain('db/migrations/meta/0000_snapshot.json');
    expect(message).toContain('partial drizzle-kit state');
  });

  it('throws when _journal.json is missing but migrations.js (bundled mode) is present', () => {
    // A bundled-mode project that lost `_journal.json` but kept its
    // compiled `migrations.js` on disk is still in a partial drizzle-kit
    // state. Refuse to silently fall through to bare-legacy.
    rmSync(join(migrationsDir, 'meta', '_journal.json'), { force: true });
    writeFileSync(join(migrationsDir, 'migrations.js'), 'export default {};\n');

    let message = '';
    try {
      assertJournalCoherence(migrationsDir, [
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json is missing');
    expect(message).toContain('db/migrations/migrations.js');
    expect(message).toContain('partial drizzle-kit state');
  });

  it('throws an actionable error when journal.entries is null', () => {
    // A bad merge / hand-edit can leave `_journal.json` parseable as JSON
    // but with `entries` replaced by `null`. Without the shape guard, the
    // subsequent `.length` access throws a raw `Cannot read properties of
    // null (reading 'length')`. Surface an actionable error instead so
    // users who hit this from `void db status`/`migrate`/`reset`/deploy
    // get the same recovery path as `void gen migration`.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: null }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('`entries` array');
  });

  it('throws an actionable error when journal.entries is an object', () => {
    // Same bad-merge shape as above but with `entries` replaced by a
    // non-null object. Without the guard, `.map()` throws a raw
    // `...map is not a function`. The actionable error must fire before
    // the drift-check `.map()` call.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: { '0': 'foo' } }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('`entries` array');
  });

  it('throws an actionable error when the journal file is a JSON scalar null', () => {
    // `readJournal` returns `undefined` only when the file is missing on
    // disk. A hand-edit or merge can leave `_journal.json` parseable as
    // the JSON scalar `null`. Treating that as bare-legacy mode would let
    // `void db status`/`migrate`/`reset`/deploy continue on a corrupted
    // drizzle project. Reject the malformed shape instead.
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), 'null');
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('`entries` array');
  });

  it('throws an actionable error when the journal file is a JSON scalar number', () => {
    // Same path as the `null` scalar: the file parses but the top-level
    // value is a number. Must hit the same malformed branch rather than
    // falling through to the bare-legacy check.
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), '0');
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
  });

  it('throws an actionable error when the journal file is a JSON array', () => {
    // Arrays are truthy `typeof 'object'` values, so the only thing
    // catching this shape is the explicit `Array.isArray(journal)` check.
    // The drift code below would otherwise throw `journal.entries is not
    // iterable` on the `.map()` call.
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), '[]');
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('`entries` array');
  });

  it('throws an actionable error when a journal entry is null', () => {
    // `{ "entries": [null] }` survives the top-level `Array.isArray`
    // guard, but the drift check below reads `e.tag` for each entry — a
    // null entry would crash with a raw `Cannot read properties of null
    // (reading 'tag')`. The per-entry guard must fire first so every
    // caller (`runStatus`, `runMigrate`, `runReset`, deploy paths, and
    // `void gen migration`) gets the same actionable malformed-journal
    // error instead of a raw TypeError.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: [null] }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 0');
    expect(message).toContain('missing required fields');
  });

  it('throws an actionable error when a journal entry is missing the tag field', () => {
    // A hand-edit or merge can leave an entry as a plain object without
    // the `tag` field. The drift check would then feed `undefined.sql`
    // into its missing-file list, masking the corruption. Surface the
    // malformed-journal error with the offending index instead.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 0,
            tag: '0000_ok',
            breakpoints: true,
          },
          {},
        ],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 1');
    expect(message).toContain('missing required fields');
  });

  it('throws an actionable error when a journal entry has a non-string tag', () => {
    // A corrupted-but-parseable journal can have `tag` as a number (e.g.
    // `42`) instead of a string. `${e.tag}.sql` would then silently
    // produce `42.sql` and the drift check would flag every on-disk file
    // as missing. Require `typeof tag === 'string'` explicitly.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '7', when: 0, tag: 42, breakpoints: true }],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 0');
    expect(message).toContain('missing required fields');
  });

  it('throws an actionable error when top-level `version` is missing', () => {
    // `runRenameMigrations` rewrites `journal.version` and
    // `journal.dialect` verbatim when it writes the updated journal. A
    // missing top-level `version` would produce
    // `{ version: undefined, dialect: ..., entries: [...] }` after the
    // rewrite — an unusable journal. Surface the corrupted shape up front.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ dialect: 'sqlite', entries: [] }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('string `version`');
  });

  it('throws an actionable error when top-level `dialect` is missing', () => {
    // Symmetric to the missing-`version` case — `runRenameMigrations`
    // also rewrites `dialect` verbatim, so an undefined one corrupts the
    // output journal.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', entries: [] }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('string `dialect`');
  });

  it('throws an actionable error when top-level `version` is a non-string', () => {
    // Drizzle writes `version` as a string literal (e.g. `"7"`). A
    // hand-edit to a JSON number would leak into the rewritten journal
    // as a number.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: 7, dialect: 'sqlite', entries: [] }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('string `version`');
  });

  it('throws an actionable error when a journal entry is missing `idx`', () => {
    // `runMigration` (the custom-migration path) computes the
    // next entry's `idx` via `Math.max(...entries.map(e => e.idx)) + 1`.
    // An entry missing `idx` would make that `NaN + 1 === NaN` and
    // write a corrupted entry back to disk. Reject the shape up front.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ version: '7', when: 0, tag: '0000_no_idx', breakpoints: true }],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 0');
    expect(message).toContain('missing required fields');
  });

  it('throws an actionable error when a journal entry has a non-number `idx`', () => {
    // `idx` is read via `entries.map(e => e.idx)` and fed into
    // `Math.max(...)`. A string coerces to NaN through Math.max, so
    // explicitly require the numeric shape here.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: '0', version: '7', when: 0, tag: '0000_str_idx', breakpoints: true }],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 0');
    expect(message).toContain('missing required fields');
  });

  it('throws an actionable error when a journal entry is missing `breakpoints`', () => {
    // `runMigration` inherits `breakpoints` from the last
    // entry into the new one (`breakpoints: lastEntry.breakpoints`).
    // A missing field would serialize as `breakpoints: undefined` in
    // the rewritten entry, producing a malformed output journal.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '7', when: 0, tag: '0000_no_breakpoints' }],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 0');
    expect(message).toContain('missing required fields');
  });

  it('throws an actionable error when a journal entry is missing `version`', () => {
    // `runMigration` inherits `version` from the last entry
    // into the new one — the drizzle-kit snapshot schema version (e.g.
    // `"6"` / `"7"`). Missing it here would produce `version: undefined`
    // in the rewritten entry.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, when: 0, tag: '0000_no_version', breakpoints: true }],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('db/migrations/meta/_journal.json');
    expect(message).toContain('malformed');
    expect(message).toContain('entry at index 0');
    expect(message).toContain('missing required fields');
  });

  it('passes on a journal with all required top-level and entry fields (happy-path regression)', () => {
    // A canonical drizzle-kit journal with an entry matching the on-disk
    // .sql file must pass through silently.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1_700_000_000_000,
            tag: '0000_initial',
            breakpoints: true,
          },
        ],
      }),
    );
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_initial.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]),
    ).not.toThrow();
  });

  it('mentions both orphans and missing entries together', () => {
    writeJournal(['0000_first', '0001_second']);
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, [
        { name: '0000_first.sql', sql: 'SELECT 1;' },
        { name: '0002_orphan.sql', sql: 'SELECT 1;' },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('0002_orphan.sql');
    expect(message).toContain('0001_second.sql');
  });

  it('throws when _journal.json contains duplicate tag entries', () => {
    // Regression: a bad merge can leave two
    // entries in `_journal.json` sharing the same `tag`. The old
    // `new Set(journal.entries.map(...))` silently collapsed those into
    // a single tag, the drift diff passed, and every downstream caller
    // continued on a corrupted journal. `void db rename-migrations` would
    // then rewrite both copies to the same new tag, deepening the
    // corruption. The coherence gate must surface the duplication with
    // an actionable error that mentions the repeated tag.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 1_700_000_000_000,
            tag: '0000_initial',
            breakpoints: true,
          },
          {
            idx: 1,
            version: '7',
            when: 1_700_000_000_001,
            tag: '0000_initial',
            breakpoints: true,
          },
        ],
      }),
    );
    let message = '';
    try {
      assertJournalCoherence(migrationsDir, [
        { name: '0000_initial.sql', sql: 'CREATE TABLE posts (id TEXT);' },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('duplicate');
    expect(message).toContain('0000_initial');
  });
});
