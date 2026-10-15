import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as output from '../../src/cli/output.ts';

const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockLog = {
  error: vi.fn(),
  info: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};
const mockGetMiniflareDatabasePath = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockRunMigrations = vi.fn();
const mockGetPgAppliedMigrations = vi.fn();
const mockRunPgMigrations = vi.fn();
const mockGetMySqlAppliedMigrations = vi.fn();
const mockRunMySqlMigrations = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: (...args: Array<unknown>) => mockIntro(...args),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  log: {
    error: (...args: Array<unknown>) => mockLog.error(...args),
    info: (...args: Array<unknown>) => mockLog.info(...args),
    step: (...args: Array<unknown>) => mockLog.step(...args),
    success: (...args: Array<unknown>) => mockLog.success(...args),
    warn: (...args: Array<unknown>) => mockLog.warn(...args),
  },
}));

vi.mock('../../src/migrations/runner', () => ({
  getMiniflareDatabasePath: (...args: Array<unknown>) => mockGetMiniflareDatabasePath(...args),
  getAppliedMigrations: (...args: Array<unknown>) => mockGetAppliedMigrations(...args),
  runMigrations: (...args: Array<unknown>) => mockRunMigrations(...args),
}));

vi.mock('../../src/migrations/runner-pg', () => ({
  getPgAppliedMigrations: (...args: Array<unknown>) => mockGetPgAppliedMigrations(...args),
  readPgAppliedMigrations: vi.fn(),
  runPgMigrations: (...args: Array<unknown>) => mockRunPgMigrations(...args),
}));

vi.mock('../../src/migrations/runner-mysql', () => ({
  getMySqlAppliedMigrations: (...args: Array<unknown>) => mockGetMySqlAppliedMigrations(...args),
  readMySqlAppliedMigrations: vi.fn(),
  toMySqlClient: vi.fn(),
  runMySqlMigrations: (...args: Array<unknown>) => mockRunMySqlMigrations(...args),
}));

const roots: Array<string> = [];

function infoMessagesWithoutColor(): Array<string> {
  return mockLog.info.mock.calls.map(([message]) => stripVTControlCharacters(String(message)));
}

function createProjectRoot(migrations: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-migrate-'));
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });

  const entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }> = [];
  let idx = 0;
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(join(migrationsDir, name), sql);
    entries.push({
      idx: idx++,
      version: '7',
      when: Date.now(),
      tag: name.replace(/\.sql$/, ''),
      breakpoints: true,
    });
  }
  writeFileSync(
    join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  );

  roots.push(root);
  return root;
}

function createPgProjectRoot(migrations: Record<string, string>): string {
  const root = createProjectRoot(migrations);
  writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }, null, 2) + '\n');
  writeFileSync(
    join(root, 'db', 'migrations', 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: Object.keys(migrations).map((name, idx) => ({
        idx,
        version: '7',
        when: Date.now(),
        tag: name.replace(/\.sql$/, ''),
        breakpoints: true,
      })),
    }),
  );
  return root;
}

function createMySqlProjectRoot(migrations: Record<string, string>): string {
  const root = createProjectRoot(migrations);
  writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'mysql' }, null, 2) + '\n');
  writeFileSync(
    join(root, 'db', 'migrations', 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'mysql',
      entries: Object.keys(migrations).map((name, idx) => ({
        idx,
        version: '7',
        when: Date.now(),
        tag: name.replace(/\.sql$/, ''),
        breakpoints: true,
      })),
    }),
  );
  return root;
}

function selectCloudflare(root: string): void {
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({ platform: 'cloudflare' }, null, 2) + '\n',
  );
}

const mockReadCloudflareD1Migrations = vi.fn();
const mockApplyCloudflareD1Migrations = vi.fn();

// The D1 context still comes from the real config reader; only the Cloudflare calls are fake.
vi.mock('../../src/cli/cloudflare-operations.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/cloudflare-operations.ts')>()),
  readCloudflareD1Migrations: (...args: Array<unknown>) => mockReadCloudflareD1Migrations(...args),
  applyCloudflareD1Migrations: (...args: Array<unknown>) =>
    mockApplyCloudflareD1Migrations(...args),
}));

describe('void db migrate', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    vi.clearAllMocks();
    mockGetMiniflareDatabasePath.mockReturnValue(join(tmpdir(), 'void-db-migrate.sqlite'));
    mockGetAppliedMigrations.mockResolvedValue([]);
    mockRunMigrations.mockResolvedValue([]);
    mockGetPgAppliedMigrations.mockResolvedValue([]);
    mockRunPgMigrations.mockResolvedValue([]);
    mockGetMySqlAppliedMigrations.mockResolvedValue([]);
    mockRunMySqlMigrations.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
    delete process.env.DATABASE_URL;
  });

  it('fails before applying a pending destructive migration without pragma', async () => {
    const root = createProjectRoot({
      '001_drop_users.sql': 'DROP TABLE users;',
    });

    await expect(runDbCommand(root, { action: 'migrate' })).rejects.toThrow('process.exit:1');

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Destructive migrations detected without pragma'),
    );
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('001_drop_users.sql'));
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it("allows a pragma'd destructive migration to apply locally", async () => {
    const root = createProjectRoot({
      '001_drop_users.sql': '-- void:allow-destructive\nDROP TABLE users;',
    });
    mockRunMigrations.mockResolvedValue(['001_drop_users.sql']);

    await runDbCommand(root, { action: 'migrate' });

    expect(mockRunMigrations).toHaveBeenCalledWith(
      toSlash(join(root, 'db', 'migrations')),
      join(tmpdir(), 'void-db-migrate.sqlite'),
      expect.any(Function),
    );
    expect(output.printSuccess).toHaveBeenCalledWith('Applied 1 migration.');
  });

  it('does not block reruns because of already applied destructive history', async () => {
    const root = createProjectRoot({
      '001_drop_users.sql': 'DROP TABLE users;',
    });
    mockGetAppliedMigrations.mockResolvedValue([
      { name: '001_drop_users.sql', applied_at: '2026-03-10T00:00:00.000Z' },
    ]);

    await runDbCommand(root, { action: 'migrate' });

    expect(mockRunMigrations).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('All migrations are up to date.');
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('rejects remote migrate for PostgreSQL before falling through to the D1 endpoint', async () => {
    const root = createPgProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id text primary key);',
    });

    await expect(runDbCommand(root, { action: 'migrate', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    expect(mockLog.error).toHaveBeenCalledWith(
      'db: `void db migrate --remote` is only supported for D1 projects. PostgreSQL remote migrations run during `void deploy` through the project Hyperdrive binding.',
    );
    expect(mockGetAppliedMigrations).not.toHaveBeenCalled();
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it('refuses remote D1 migrate when the binding has no migrations_dir', async () => {
    const root = createProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id integer primary key);',
    });
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'linked-worker',
        account_id: 'acc1',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'app-db',
            database_id: '3f2a9c1e-0000-4000-8000-000000000000',
          },
        ],
      }),
    );
    // Cloudflare's default folder holds SQL that Void never checked.
    mkdirSync(join(root, 'migrations'));
    writeFileSync(join(root, 'migrations', '0001_legacy.sql'), 'DROP TABLE users;');
    selectCloudflare(root);
    mockReadCloudflareD1Migrations.mockResolvedValue([]);

    await expect(runDbCommand(root, { action: 'migrate', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('"migrations_dir"'));
    expect(mockApplyCloudflareD1Migrations).not.toHaveBeenCalled();
  });

  it('applies pending PostgreSQL migrations directly for a Cloudflare target', async () => {
    const root = createPgProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id text primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'postgresql://example.test/app';
    mockRunPgMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'migrate', remote: true });

    expect(mockGetPgAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockRunPgMigrations).toHaveBeenCalledWith(
      toSlash(join(root, 'db', 'migrations')),
      process.env.DATABASE_URL,
    );
    expect(output.printSuccess).toHaveBeenCalledWith('Applied 1 migration to remote database.');
  });

  it('applies pending MySQL migrations directly for a Cloudflare target', async () => {
    const root = createMySqlProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id varchar(255) primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'mysql://example.test/app';
    mockRunMySqlMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'migrate', remote: true });

    expect(mockGetMySqlAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockRunMySqlMigrations).toHaveBeenCalledWith(
      toSlash(join(root, 'db', 'migrations')),
      process.env.DATABASE_URL,
    );
    expect(output.printSuccess).toHaveBeenCalledWith('Applied 1 migration to remote database.');
  });

  it('reads direct Cloudflare PostgreSQL migration status from DATABASE_URL', async () => {
    const root = createPgProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id text primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'postgresql://example.test/app';
    mockGetPgAppliedMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'status' });

    expect(mockGetPgAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL not found in .env'),
    );
    expect(infoMessagesWithoutColor()).toContain(
      '  001_create_users.sql  local: unknown  remote: applied',
    );
  });

  it('reads direct Cloudflare MySQL migration status from DATABASE_URL', async () => {
    const root = createMySqlProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id varchar(255) primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'mysql://example.test/app';
    mockGetMySqlAppliedMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'status' });

    expect(mockGetMySqlAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL not found in .env'),
    );
    expect(infoMessagesWithoutColor()).toContain(
      '  001_create_users.sql  local: unknown  remote: applied',
    );
  });

  it('counts pending files, not tracked names, in the status summary', async () => {
    // Another branch applied 002 and 003, which are not on disk here.
    const root = createProjectRoot({
      '001_a.sql': 'CREATE TABLE a (id integer);',
      '004_d.sql': 'CREATE TABLE d (id integer);',
    });
    mockGetAppliedMigrations.mockResolvedValue(
      ['001_a.sql', '002_b.sql', '003_c.sql'].map((name) => ({ name, applied_at: '' })),
    );

    await runDbCommand(root, { action: 'status' });

    expect(mockOutro).toHaveBeenCalledWith('2 migrations, 1 pending locally');
  });

  it('names journal drift under sourceDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-migrate-'));
    roots.push(root);
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }, null, 2) + '\n');
    const migrationsDir = join(root, 'src', 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    writeFileSync(join(migrationsDir, '0000_init.sql'), 'CREATE TABLE a (id integer);');
    writeFileSync(join(migrationsDir, '0001_orphan.sql'), 'CREATE TABLE b (id integer);');
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '7', when: 0, tag: '0000_init', breakpoints: true }],
      }),
    );

    await expect(runDbCommand(root, { action: 'migrate' })).rejects.toThrow('process.exit:1');

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('  - src/db/migrations/0001_orphan.sql'),
    );
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });
});
