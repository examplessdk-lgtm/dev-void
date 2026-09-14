import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import {
  compareMigrationSets,
  readMigrationSet,
  type JournalEntry,
  type MigrationSet,
} from '../../scripts/check-migration-set.ts';

const REAPPLY_NOTE =
  'Production never re-applies a migration it has already applied, so this database would not match production.';

function entry(idx: number, when: number): JournalEntry {
  return { idx, tag: `${String(idx).padStart(4, '0')}_tag`, when };
}

function migrationSet(
  journal: ReadonlyArray<JournalEntry>,
  files: Readonly<Record<string, string>>,
): MigrationSet {
  return { files: new Map(Object.entries(files)), journal };
}

const releasedFiles = {
  '0000_tag.sql': 'hash-0000',
  '0001_tag.sql': 'hash-0001',
  'meta/0000_snapshot.json': 'hash-snap-0000',
  'meta/0001_snapshot.json': 'hash-snap-0001',
} as const;

const released = migrationSet([entry(0, 100), entry(1, 200)], releasedFiles);

describe('compareMigrationSets', () => {
  it('accepts an identical set', () => {
    expect(compareMigrationSets(released, released)).toEqual([]);
  });

  it('accepts an appended entry with a later timestamp and its new files', () => {
    const candidate = migrationSet([...released.journal, entry(2, 300)], {
      ...releasedFiles,
      '0002_tag.sql': 'hash-0002',
      'meta/0002_snapshot.json': 'hash-snap-0002',
    });
    expect(compareMigrationSets(released, candidate)).toEqual([]);
  });

  it('rejects a modified released .sql', () => {
    const candidate = migrationSet(released.journal, {
      ...releasedFiles,
      '0001_tag.sql': 'hash-0001-edited',
    });
    expect(compareMigrationSets(released, candidate)).toEqual([
      'released migration 0001_tag.sql was modified',
      REAPPLY_NOTE,
    ]);
  });

  it('rejects a removed released snapshot', () => {
    const { 'meta/0001_snapshot.json': _removed, ...rest } = releasedFiles;
    const candidate = migrationSet(released.journal, rest);
    expect(compareMigrationSets(released, candidate)).toEqual([
      'released migration meta/0001_snapshot.json was removed',
      REAPPLY_NOTE,
    ]);
  });

  it('lists every changed released file once and the explanation once', () => {
    const { 'meta/0001_snapshot.json': _removed, ...rest } = releasedFiles;
    const candidate = migrationSet(released.journal, {
      ...rest,
      '0000_tag.sql': 'hash-0000-edited',
    });
    expect(compareMigrationSets(released, candidate)).toEqual([
      'released migration 0000_tag.sql was modified',
      'released migration meta/0001_snapshot.json was removed',
      REAPPLY_NOTE,
    ]);
  });

  it('rejects a new entry whose timestamp equals the last released one', () => {
    const candidate = migrationSet([...released.journal, entry(2, 200)], {
      ...releasedFiles,
      '0002_tag.sql': 'hash-0002',
    });
    expect(compareMigrationSets(released, candidate)).toEqual([
      'migration 0002_tag (idx 2) has timestamp 200, not after the previous entry 0001_tag (200); drizzle-kit migrate applies only entries newer than the last applied one and would skip it in production.',
    ]);
  });

  it('rejects a new entry whose timestamp is before the last released one', () => {
    const candidate = migrationSet([...released.journal, entry(2, 150)], {
      ...releasedFiles,
      '0002_tag.sql': 'hash-0002',
    });
    expect(compareMigrationSets(released, candidate)).toEqual([
      'migration 0002_tag (idx 2) has timestamp 150, not after the previous entry 0001_tag (200); drizzle-kit migrate applies only entries newer than the last applied one and would skip it in production.',
    ]);
  });

  it('checks each new entry against the entry before it, not only the last released one', () => {
    const candidate = migrationSet([...released.journal, entry(2, 400), entry(3, 300)], {
      ...releasedFiles,
      '0002_tag.sql': 'hash-0002',
      '0003_tag.sql': 'hash-0003',
    });
    expect(compareMigrationSets(released, candidate)).toEqual([
      'migration 0003_tag (idx 3) has timestamp 300, not after the previous entry 0002_tag (400); drizzle-kit migrate applies only entries newer than the last applied one and would skip it in production.',
    ]);
  });

  it('rejects a released journal entry whose timestamp changed', () => {
    const candidate = migrationSet([entry(0, 100), entry(1, 201)], releasedFiles);
    expect(compareMigrationSets(released, candidate)).toEqual([
      'journal entry 1 differs from the released journal: released 0001_tag (idx 1, when 200), candidate 0001_tag (idx 1, when 201)',
    ]);
  });

  it('rejects a released journal entry whose tag or idx changed', () => {
    const candidate = migrationSet([entry(0, 100), { idx: 1, tag: '0001_other', when: 200 }], {
      ...releasedFiles,
    });
    expect(compareMigrationSets(released, candidate)).toEqual([
      'journal entry 1 differs from the released journal: released 0001_tag (idx 1, when 200), candidate 0001_other (idx 1, when 200)',
    ]);
  });

  it('rejects a journal shorter than the released one', () => {
    const candidate = migrationSet([entry(0, 100)], releasedFiles);
    expect(compareMigrationSets(released, candidate)).toEqual([
      'journal is shorter than the released journal (1 entries, released 2)',
    ]);
  });
});

describe('readMigrationSet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'void-check-migration-set-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes every file except the journal and parses the journal', () => {
    mkdirSync(join(dir, 'meta'));
    writeFileSync(join(dir, '0000_first.sql'), 'CREATE TABLE a ();');
    writeFileSync(join(dir, 'meta', '0000_snapshot.json'), '{"id":"snap"}');
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1, tag: '0000_first', breakpoints: true }],
      }),
    );

    const set = readMigrationSet(dir);

    expect([...set.files.keys()].sort()).toEqual(['0000_first.sql', 'meta/0000_snapshot.json']);
    expect(set.files.get('0000_first.sql')).toBe(
      createHash('sha256').update('CREATE TABLE a ();').digest('hex'),
    );
    expect(set.files.get('meta/0000_snapshot.json')).toBe(
      createHash('sha256').update('{"id":"snap"}').digest('hex'),
    );
    expect(set.journal).toEqual([{ idx: 0, tag: '0000_first', when: 1 }]);
  });
});

describe("the repository's migration set", () => {
  const real = readMigrationSet(resolve(import.meta.dirname, '../../drizzle'));

  it('is an append-only extension of itself', () => {
    expect(compareMigrationSets(real, real)).toEqual([]);
  });

  it('has strictly increasing journal timestamps', () => {
    for (let i = 1; i < real.journal.length; i++) {
      expect(
        real.journal[i].when,
        `${real.journal[i].tag} must be after ${real.journal[i - 1].tag}`,
      ).toBeGreaterThan(real.journal[i - 1].when);
    }
  });
});
