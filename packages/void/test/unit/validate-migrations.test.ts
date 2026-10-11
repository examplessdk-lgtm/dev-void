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
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), journalWith(entries));
  }

  function journalWith(entries: unknown): string {
    return JSON.stringify({ version: '7', dialect: 'sqlite', entries });
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
    rmSync(join(migrationsDir, 'meta', '_journal.json'), { force: true });
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '0000_create_posts.sql', sql: 'CREATE TABLE posts (id TEXT);' },
        { name: '0001_add_author.sql', sql: 'ALTER TABLE posts ADD COLUMN author TEXT;' },
      ]),
    ).not.toThrow();
  });

  it('passes on a placeholder journal: empty entries, disk files, no snapshots (kitchen-sink shape)', () => {
    writeJournal([]);
    expect(() =>
      assertJournalCoherence(migrationsDir, [
        { name: '001_create_notes.sql', sql: 'CREATE TABLE notes (id TEXT);' },
        { name: '002_create_queue_results.sql', sql: 'CREATE TABLE queue_results (id TEXT);' },
      ]),
    ).not.toThrow();
  });

  it('throws on an empty-entries journal when a snapshot is also present', () => {
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
    expect(message).toContain('void db generate');
  });

  it('throws on an empty-entries journal with a snapshot even when no .sql files remain', () => {
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

  it.each([
    ['journal.entries is null', journalWith(null), '`entries` array'],
    ['journal.entries is an object', journalWith({ '0': 'foo' }), '`entries` array'],
    ['the journal file is JSON null', 'null', '`entries` array'],
    ['the journal file is a JSON number', '0', '`entries` array'],
    ['the journal file is a JSON array', '[]', '`entries` array'],
    [
      'top-level `version` is missing',
      JSON.stringify({ dialect: 'sqlite', entries: [] }),
      'string `version`',
    ],
    [
      'top-level `dialect` is missing',
      JSON.stringify({ version: '7', entries: [] }),
      'string `dialect`',
    ],
    [
      'top-level `version` is a number',
      JSON.stringify({ version: 7, dialect: 'sqlite', entries: [] }),
      'string `version`',
    ],
    ['a journal entry is null', journalWith([null]), 'entry at index 0 is missing required fields'],
    [
      'a journal entry is missing `tag`',
      journalWith([{ idx: 0, version: '7', when: 0, tag: '0000_ok', breakpoints: true }, {}]),
      'entry at index 1 is missing required fields',
    ],
    [
      'a journal entry has a non-string `tag`',
      journalWith([{ idx: 0, version: '7', when: 0, tag: 42, breakpoints: true }]),
      'entry at index 0 is missing required fields',
    ],
    [
      'a journal entry is missing `idx`',
      journalWith([{ version: '7', when: 0, tag: '0000_no_idx', breakpoints: true }]),
      'entry at index 0 is missing required fields',
    ],
    [
      'a journal entry has a non-number `idx`',
      journalWith([{ idx: '0', version: '7', when: 0, tag: '0000_str_idx', breakpoints: true }]),
      'entry at index 0 is missing required fields',
    ],
    [
      'a journal entry is missing `breakpoints`',
      journalWith([{ idx: 0, version: '7', when: 0, tag: '0000_no_breakpoints' }]),
      'entry at index 0 is missing required fields',
    ],
    [
      'a journal entry is missing `version`',
      journalWith([{ idx: 0, when: 0, tag: '0000_no_version', breakpoints: true }]),
      'entry at index 0 is missing required fields',
    ],
  ])('throws an actionable error when %s', (_case, journal, fragment) => {
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), journal);
    expect(() => assertJournalCoherence(migrationsDir, [])).toThrow(
      new RegExp(`db/migrations/meta/_journal\\.json is malformed: [\\s\\S]*${fragment}`),
    );
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
