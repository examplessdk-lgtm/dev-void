import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { needsWrapper, generateWrapper } from '../../src/cli/wrapper';
import type { WrapperFeatures } from '../../src/cli/wrapper';

const base: WrapperFeatures = {
  auth: null,
  crons: [],
  queues: [],
};

describe('needsWrapper', () => {
  it('returns false when no features are set', () => {
    expect(needsWrapper(base)).toBe(false);
  });

  it('returns true when crons are present', () => {
    expect(
      needsWrapper({
        ...base,
        crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
      }),
    ).toBe(true);
  });

  it('returns true when queues are present', () => {
    expect(
      needsWrapper({
        ...base,
        queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'EMAILS' }],
      }),
    ).toBe(true);
  });

  it('returns true when hasMigrations is set', () => {
    expect(needsWrapper({ ...base, hasMigrations: true })).toBe(true);
  });

  it('returns false when hasMigrations is false', () => {
    expect(needsWrapper({ ...base, hasMigrations: false })).toBe(false);
  });
});

describe('generateWrapper with migrations', () => {
  const tmpRoot = join(import.meta.dirname, '..', '..', '.test-wrapper-tmp');
  const workerDir = join(tmpRoot, 'server');
  const projectRoot = join(tmpRoot, 'project');

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('generates wrapper with /__void/migrate handler', async () => {
    // Set up fake worker dir with a minimal entry
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    // Set up fake project with a migration
    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id INTEGER PRIMARY KEY);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'sqlite',
    });

    // Original entry should be renamed
    expect(existsSync(join(workerDir, '__original.mjs'))).toBe(true);

    // Wrapper should be written as index.mjs
    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/migrate');
    expect(wrapper).toContain('createMigrationHandler');
    expect(wrapper).toContain('__migrations');
    expect(wrapper).toContain('import original from "./__original.mjs"');

    // Migration handler should be copied
    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
  });

  it('includes migrations JSON in wrapper source', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('001_create_users.sql');
    expect(wrapper).toContain('CREATE TABLE users');
  });

  it('uses PG migration handler when dialect is postgresql', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id SERIAL PRIMARY KEY);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'postgresql',
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/migrate');
    expect(wrapper).toContain('createMigrationHandler');
    expect(wrapper).toContain('"postgresql"');

    // Migration handler should be copied
    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
  });

  it('does not generate migration handler when hasMigrations is false', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });

    // Create fake cron handler
    mkdirSync(join(projectRoot, 'crons'), { recursive: true });
    writeFileSync(join(projectRoot, 'crons', 'daily.ts'), 'export default async () => {};');

    // Only crons, no migrations
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).not.toContain('/__void/migrate');
    expect(wrapper).toContain('/__void/scheduled');
  });
});
