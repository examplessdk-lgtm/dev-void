import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  cleanupWrapper,
  needsWrapper,
  generateWrapper,
  selectBundledEntryFilename,
} from '../../src/cli/wrapper.ts';
import type { WrapperFeatures } from '../../src/cli/wrapper.ts';

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

  it('returns true when deployment readiness is required', () => {
    expect(needsWrapper({ ...base, readiness: true })).toBe(true);
  });

  it('returns false when hasMigrations is false', () => {
    expect(needsWrapper({ ...base, hasMigrations: false })).toBe(false);
  });
});

describe('selectBundledEntryFilename', () => {
  it('selects the exact bundled entry when index-prefixed chunks sort first', () => {
    expect(selectBundledEntryFilename(['index-server-Bo4VDtw5.js', 'index.js'])).toBe('index.js');
  });

  it('throws a helpful error when no exact bundled entry exists', () => {
    expect(() => selectBundledEntryFilename(['index-server-Bo4VDtw5.js'])).toThrow(
      'deploy: Bundled worker entry not found',
    );
  });
});

describe('cleanupWrapper', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the linked project config needed by remote commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-cleanup-'));
    roots.push(root);

    const voidDir = join(root, '.void');
    const projectFile = join(voidDir, 'project.json');
    const temporaryDirectories = ['handlers', 'migration-handler', 'bundle'];
    for (const directory of temporaryDirectories) {
      mkdirSync(join(voidDir, directory), { recursive: true });
      writeFileSync(join(voidDir, directory, 'generated.js'), 'export default {};');
    }
    writeFileSync(projectFile, JSON.stringify({ projectId: 'proj_123', slug: 'speakers' }));
    writeFileSync(join(voidDir, 'dev-trigger-token'), 'stable-token');

    cleanupWrapper(root);

    expect(existsSync(projectFile)).toBe(true);
    expect(readFileSync(join(voidDir, 'dev-trigger-token'), 'utf-8')).toBe('stable-token');
    for (const directory of temporaryDirectories) {
      expect(existsSync(join(voidDir, directory))).toBe(false);
    }
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

    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
  });

  it('bundles the SQLite migration handler into a self-contained worker module', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

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

    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).not.toMatch(/from\s+["']\.\.\//);
    expect(handler).not.toContain('../migrations/canonical-json');
    expect(handler).not.toContain('../canonical-json-');
    expect(handler).toContain('function canonicalJson');
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

    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).not.toContain('import("pg")');
    expect(
      readdirSync(workerDir).some((file) => file.startsWith('__void_migration_handler-')),
    ).toBe(true);
    const bundled = readdirSync(workerDir)
      .map((file) => readFileSync(join(workerDir, file), 'utf-8'))
      .join('\n');
    expect(bundled).not.toContain('PGPASSFILE');
    expect(bundled).not.toContain('createReadStream');
    expect(bundled).not.toContain('__require("pgpass")');
    expect(bundled).not.toContain('createRequire(import.meta.url)');
    expect(bundled).not.toContain('createRequire("file:///__void_migration_handler.mjs")');
    expect(bundled).not.toContain('node:module');
    expect(bundled).not.toContain('empty module that is served up when outside of a workerd');
    expect(bundled).toContain('CloudflareSocket');
    expect(bundled).toContain('cloudflare:sockets');
    expect(bundled).toContain('node:events');
    expect(bundled).toContain('node:util/types');
    expect(bundled).toContain('"util/types": __voidNodeUtilTypes');
    expect(bundled).toContain('__voidNodeRequireModules');
    expect(bundled).toContain('__voidPgpassNoop');
  });

  it('uses the MySQL migration handler when dialect is mysql', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );
    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id INT);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'mysql',
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/migrate');
    expect(wrapper).toContain('"mysql"');
    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
  });

  it('intercepts GET /__void/ready with {ready:true} when wrapper is generated', async () => {
    // Platform's deploy-time readiness probe (packages/api/src/routes/deploy.ts)
    // expects a JSON 200 from GET /__void/ready before dispatching migrations.
    // Without this, the request falls through to the user's framework handler
    // (e.g. SvelteKit -> env.ASSETS), which returns CF's "Assets have not yet
    // been deployed to this script." stub during WfP propagation, causing the
    // probe to retry until exhaustion.
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

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

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/ready');
    expect(wrapper).toMatch(/Response\.json\(\s*\{\s*ready:\s*true\s*\}\s*\)/);
    // Must be checked before delegating to original.fetch, otherwise the
    // user's framework handler will see the request.
    const readyIdx = wrapper.indexOf('/__void/ready');
    const originalIdx = wrapper.indexOf('original.fetch');
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(originalIdx).toBeGreaterThan(readyIdx);
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
