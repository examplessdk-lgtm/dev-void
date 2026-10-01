import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

type Rows = Record<string, Record<string, unknown>>;
let assertPreserved: (original: Rows, rows: Rows, projectModeMigrationApplied?: boolean) => void;
let migrationApplied: (rows: Array<{ hash?: string; created_at?: number | string }>) => boolean;
const migration = {
  hash: createHash('sha256')
    .update(
      readFileSync(
        new URL('../../../../platform/packages/api/drizzle/0054_project_mode.sql', import.meta.url),
      ),
    )
    .digest('hex'),
  created_at: 1790841384175,
};

beforeAll(async () => {
  const module = await import(
    new URL('../../../../.github/scripts/schema-fixture.mjs', import.meta.url).href
  );
  assertPreserved = module.assertSchemaFixturePreserved;
  migrationApplied = module.isProjectModeMigrationApplied;
});

function original(mode = 'worker'): Rows {
  return {
    users: { id: 'user_compat', role: 'admin', email: 'compat@example.invalid' },
    projects: { id: 'proj_compat', user_id: 'user_compat', slug: 'schema-compat-fixture', mode },
    project_secrets: { id: 'psc_compat', ciphertext: 'fixture-ciphertext', iv: 'fixture-iv' },
  };
}

describe('populated schema compatibility fixture', () => {
  it('accepts only the exact applied project-mode migration and intentional Worker normalization', () => {
    expect(migrationApplied([migration])).toBe(true);
    expect(migrationApplied([{ ...migration, created_at: String(migration.created_at) }])).toBe(
      true,
    );
    const before = original();
    const after = structuredClone(before);
    after.projects.mode = 'void';
    expect(() => assertPreserved(before, after, migrationApplied([migration]))).not.toThrow();
    expect(after.project_secrets).toEqual(before.project_secrets);
  });

  it.each([
    { rows: [] },
    { rows: [{ created_at: migration.created_at }] },
    { rows: [{ ...migration, hash: '0'.repeat(64) }] },
    { rows: [{ ...migration, created_at: migration.created_at + 1 }] },
    { rows: [migration, migration] },
  ])('refuses normalization without the exact unique applied migration $rows', ({ rows }) => {
    expect(migrationApplied(rows)).toBe(false);
    const before = original();
    const after = structuredClone(before);
    after.projects.mode = 'void';
    expect(() => assertPreserved(before, after, migrationApplied(rows))).toThrow('projects.mode');
  });

  it.each(['spa', 'static', 'framework', 'unexpected'])(
    'refuses a Worker conversion to %s',
    (mode) => {
      const before = original();
      const after = structuredClone(before);
      after.projects.mode = mode;
      expect(() => assertPreserved(before, after, true)).toThrow('projects.mode');
    },
  );

  it.each(['void', 'spa', 'static', 'framework'])(
    'preserves existing %s projects exactly',
    (mode) => {
      const before = original(mode);
      const after = structuredClone(before);
      expect(() => assertPreserved(before, after, true)).not.toThrow();
      after.projects.mode = mode === 'void' ? 'worker' : 'void';
      expect(() => assertPreserved(before, after, true)).toThrow('projects.mode');
    },
  );

  it.each([
    ['users', 'email'],
    ['projects', 'slug'],
    ['projects', 'user_id'],
    ['project_secrets', 'ciphertext'],
    ['project_secrets', 'iv'],
  ])('still rejects unrelated mutation of %s.%s', (table, column) => {
    const before = original();
    const after = structuredClone(before);
    after.projects.mode = 'void';
    after[table][column] = 'changed';
    expect(() => assertPreserved(before, after, true)).toThrow(`${table}.${column}`);
  });

  it('does not allow another project identity to use the fixture normalization exception', () => {
    const before = original();
    before.projects.id = 'unrelated';
    const after = structuredClone(before);
    after.projects.mode = 'void';
    expect(() => assertPreserved(before, after, true)).toThrow('projects.mode');
  });
});
