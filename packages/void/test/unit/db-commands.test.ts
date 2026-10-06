import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vite-plus/test';

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockGetMiniflareDatabasePath = vi.fn();
const mockOpenSqliteDatabase = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockRunMigrations = vi.fn();
const mockWriteJournal = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: Array<unknown>) => mockExecFileSync(...args),
}));

vi.mock('../../src/migrations/runner', async () => {
  const actual = await vi.importActual<typeof import('../../src/migrations/runner.ts')>(
    '../../src/migrations/runner',
  );
  return {
    ...actual,
    getMiniflareDatabasePath: (...args: Array<unknown>) =>
      mockGetMiniflareDatabasePath.getMockImplementation()
        ? mockGetMiniflareDatabasePath(...args)
        : actual.getMiniflareDatabasePath(...(args as [string, string])),
    openSqliteDatabase: (...args: Array<unknown>) =>
      mockOpenSqliteDatabase.getMockImplementation()
        ? mockOpenSqliteDatabase(...args)
        : actual.openSqliteDatabase(...(args as [string, Record<string, unknown> | undefined])),
    getAppliedMigrations: (...args: Array<unknown>) =>
      mockGetAppliedMigrations.getMockImplementation()
        ? mockGetAppliedMigrations(...args)
        : actual.getAppliedMigrations(...(args as [string])),
    runMigrations: (...args: Array<unknown>) =>
      mockRunMigrations.getMockImplementation()
        ? mockRunMigrations(...args)
        : actual.runMigrations(...(args as [string, string])),
  };
});

vi.mock('../../src/migrations/collect', async () => {
  const actual = await vi.importActual<typeof import('../../src/migrations/collect.ts')>(
    '../../src/migrations/collect',
  );
  return {
    ...actual,
    writeJournal: (...args: Array<unknown>) =>
      mockWriteJournal.getMockImplementation()
        ? mockWriteJournal(...args)
        : actual.writeJournal(
            ...(args as [string, import('../../src/migrations/collect.ts').DrizzleJournal]),
          ),
  };
});

const mockGetToken = vi.fn<() => string | null>(() => null);
const mockReadProjectConfig = vi.fn<() => { projectId: string; slug: string } | null>(() => null);
const mockRenameMigrations =
  vi.fn<
    (projectId: string, renames: Array<{ from: string; to: string }>) => Promise<{ ok: boolean }>
  >();

vi.mock('../../src/cli/auth', () => ({
  getToken: () => mockGetToken(),
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
  readDeploymentPlatform: () => 'void',
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    renameMigrations(
      projectId: string,
      renames: Array<{ from: string; to: string }>,
    ): Promise<{ ok: boolean }> {
      return mockRenameMigrations(projectId, renames);
    }
  },
}));

const mockLog = {
  error: vi.fn(),
  info: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    error: (...args: Array<unknown>) => mockLog.error(...args),
    info: (...args: Array<unknown>) => mockLog.info(...args),
    step: (...args: Array<unknown>) => mockLog.step(...args),
    success: (...args: Array<unknown>) => mockLog.success(...args),
    warn: (...args: Array<unknown>) => mockLog.warn(...args),
  },
}));

const TMP_DIR = join(import.meta.dirname, '.tmp-db-commands-test');

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('getAppliedMigrations', () => {
  it('returns [] when DB file does not exist', async () => {
    const { getAppliedMigrations } = await import('../../src/migrations/runner.ts');
    const result = await getAppliedMigrations(join(TMP_DIR, 'nonexistent.sqlite'));
    expect(result).toEqual([]);
  });

  it('returns [] when _void_migrations table does not exist', async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, 'empty.sqlite');

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec('CREATE TABLE other (id INTEGER)');
    db.close();

    const { getAppliedMigrations } = await import('../../src/migrations/runner.ts');
    const result = await getAppliedMigrations(dbPath);
    expect(result).toEqual([]);
  });

  it('returns applied migrations sorted by name', async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, 'migrations.sqlite');

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO _void_migrations (name, applied_at) VALUES ('002_second.sql', '2025-01-02T00:00:00Z');
      INSERT INTO _void_migrations (name, applied_at) VALUES ('001_first.sql', '2025-01-01T00:00:00Z');
    `);
    db.close();

    const { getAppliedMigrations } = await import('../../src/migrations/runner.ts');
    const result = await getAppliedMigrations(dbPath);
    expect(result).toEqual([
      { name: '001_first.sql', applied_at: '2025-01-01T00:00:00Z' },
      { name: '002_second.sql', applied_at: '2025-01-02T00:00:00Z' },
    ]);
  });
});

describe('getLocalD1Target', () => {
  it('uses .void for Void apps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-persist-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { void: '*' } }));

      const { getLocalD1Target } = await import('../../src/cli/db.ts');
      expect(getLocalD1Target(root).persistRoot).toBe(toSlash(join(root, '.void')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses Wrangler state for framework apps that own the Cloudflare emulator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-persist-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { '@sveltejs/kit': '*' } }),
      );

      const { getLocalD1Target } = await import('../../src/cli/db.ts');
      expect(getLocalD1Target(root).persistRoot).toBe(toSlash(join(root, '.wrangler', 'state')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const rootsToClean: Array<string> = [];

function createRenameProjectRoot(options: {
  files: Record<string, string>;
  journalEntries?: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
  withJournal?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-rename-test-'));
  rootsToClean.push(root);

  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });

  for (const [name, sql] of Object.entries(options.files)) {
    writeFileSync(join(migrationsDir, name), sql);
  }

  const withJournal = options.withJournal ?? true;
  if (withJournal) {
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const entries =
      options.journalEntries ??
      Object.keys(options.files).map((name, idx) => ({
        idx,
        version: '7',
        when: 1_700_000_000_000 + idx,
        tag: name.replace(/\.sql$/, ''),
        breakpoints: true,
      }));
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries }, null, 2) + '\n',
    );
  }

  // Minimal void.json so readConfig / getDatabaseDialect default cleanly.
  writeFileSync(join(root, 'void.json'), JSON.stringify({}));

  return root;
}

function createDrizzleProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void db subprocess test-'));
  rootsToClean.push(root);
  mkdirSync(join(root, 'db'), { recursive: true });
  writeFileSync(join(root, 'db', 'schema.ts'), 'export const users = {};\n');
  writeFileSync(join(root, 'void.json'), JSON.stringify({}));
  return root;
}

describe('void db drizzle-kit subprocesses', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockExecFileSync.mockReset();
    mockGetMiniflareDatabasePath.mockReset();
    for (const root of rootsToClean.splice(0, rootsToClean.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes drizzle-kit arguments without shell interpolation', async () => {
    const root = createDrizzleProjectRoot();

    await runDbCommand(root, { action: 'generate' });

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFileSync.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      expect.stringContaining(toSlash(join('drizzle-kit', 'bin.cjs'))),
      'generate',
      '--config',
      toSlash(join(root, '.void', 'drizzle.config.json')),
    ]);
    expect(options).toEqual({ cwd: root, stdio: 'inherit' });
  });

  it('includes generated Better Auth tables in migration generation', async () => {
    const root = createDrizzleProjectRoot();
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ auth: { providers: ['email'] } }, null, 2),
    );

    await runDbCommand(root, { action: 'generate' });

    const config = JSON.parse(readFileSync(join(root, '.void', 'drizzle.config.json'), 'utf-8'));
    expect(config.schema).toEqual(['./db/schema.ts', './.void/better-auth-schema.ts']);
    const authSchema = readFileSync(join(root, '.void', 'better-auth-schema.ts'), 'utf-8');
    expect(authSchema).toContain('export const userTable = sqliteTable("user"');
    expect(authSchema).toContain('export const sessionTable = sqliteTable("session"');
    expect(authSchema).toContain('export const accountTable = sqliteTable("account"');
    expect(authSchema).toContain('export const verificationTable = sqliteTable("verification"');
  });

  it('rejects invalid generated SQLite SQL and restores migration artifacts', async () => {
    const root = createDrizzleProjectRoot();
    const migrations = join(root, 'db', 'migrations');
    mockExecFileSync.mockImplementation(() => {
      mkdirSync(join(migrations, 'meta'), { recursive: true });
      writeFileSync(join(migrations, '0000.sql'), 'THIS IS NOT SQL;');
      writeFileSync(join(migrations, 'meta', '_journal.json'), '{}');
    });

    await expect(runDbCommand(root, { action: 'generate' })).rejects.toThrow('process.exit:1');
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('0000.sql'));
    expect(existsSync(migrations)).toBe(false);
  });

  it('generates Better Auth migrations for an auth-only project', async () => {
    const root = createDrizzleProjectRoot();
    rmSync(join(root, 'db', 'schema.ts'));
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ auth: { providers: ['email'] } }, null, 2),
    );

    await runDbCommand(root, { action: 'generate' });

    const config = JSON.parse(readFileSync(join(root, '.void', 'drizzle.config.json'), 'utf-8'));
    expect(config.schema).toBe('./.void/better-auth-schema.ts');
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  it('resolves function-based Better Auth schemas with local env values', async () => {
    const root = createDrizzleProjectRoot();
    const voidStubDir = join(root, 'node_modules', 'void');
    mkdirSync(voidStubDir, { recursive: true });
    writeFileSync(
      join(voidStubDir, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './auth': './auth.js' } }),
    );
    writeFileSync(join(voidStubDir, 'auth.js'), 'export const defineAuth = (config) => config;\n');
    writeFileSync(
      join(root, 'auth.js'),
      [
        'import { defineAuth } from "void/auth";',
        'export default defineAuth(({ defaults, env }) => ({',
        '  ...defaults,',
        '  user: { modelName: env.AUTH_USER_TABLE },',
        '}));',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, '.env'), 'AUTH_USER_TABLE=development_users\n');

    await runDbCommand(root, { action: 'generate' });

    const authSchema = readFileSync(join(root, '.void', 'better-auth-schema.ts'), 'utf-8');
    expect(authSchema).toContain('sqliteTable("development_users"');
  });

  it('uses the framework emulator store for SQLite push in SvelteKit apps', async () => {
    const root = createDrizzleProjectRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': '*' } }),
    );
    mockGetMiniflareDatabasePath.mockReturnValue(join(root, 'local.sqlite'));

    await runDbCommand(root, { action: 'push' });

    expect(mockGetMiniflareDatabasePath).toHaveBeenCalledWith(
      toSlash(join(root, '.wrangler', 'state')),
      'local',
    );
  });
});

describe('void db reset', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockRunMigrations.mockReset();
    mockGetMiniflareDatabasePath.mockReset();
    mockOpenSqliteDatabase.mockReset();
    mockGetAppliedMigrations.mockReset();
    mockWriteJournal.mockReset();
    for (const root of rootsToClean.splice(0, rootsToClean.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SQLite: catches genuine drift before rmSync (dbPath file survives)', async () => {
    // Create a project with a journal entry that has NO matching .sql file
    // on disk. Bootstrap cannot heal this — a journal already exists — so
    // assertJournalCoherence must throw and nothing destructive can happen.
    const root = mkdtempSync(join(tmpdir(), 'void-reset-sqlite-'));
    rootsToClean.push(root);

    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    // Journal references a file that doesn't exist on disk — genuine drift.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 1,
            tag: '0001_missing',
            breakpoints: true,
          },
        ],
      }),
    );

    writeFileSync(join(root, 'void.json'), JSON.stringify({}));

    // Set up a fake DB file that must NOT be deleted.
    const fakeDbPath = join(root, '.void', 'fake.sqlite');
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(fakeDbPath, 'sentinel');
    mockGetMiniflareDatabasePath.mockReturnValue(fakeDbPath);

    // If runMigrations is called, the test should fail — drift was not caught first.
    mockRunMigrations.mockRejectedValue(new Error('runMigrations should not be called'));

    await expect(runDbCommand(root, { action: 'reset' })).rejects.toThrow();

    // The db file must still exist — nothing destructive happened.
    expect(existsSync(fakeDbPath)).toBe(true);
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  // Note: The symmetric PG path follows the same pattern — assertJournalCoherence
  // is called before withPgClient, so the PG client is never contacted on drift.
  // Testing it here would require a live PG connection; the SQLite test is sufficient
  // to validate the "coherence before destructive work" invariant.
});

describe('void db status', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockRunMigrations.mockReset();
    mockGetMiniflareDatabasePath.mockReset();
    mockOpenSqliteDatabase.mockReset();
    mockGetAppliedMigrations.mockReset();
    mockWriteJournal.mockReset();
    for (const root of rootsToClean.splice(0, rootsToClean.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SQLite: corrupted _journal.json exits cleanly via log.error (not uncaught throw)', async () => {
    // Regression: `readJournal` (called inside assertJournalCoherence) throws
    // on malformed JSON. That call must live inside the try/catch so the
    // failure routes through log.error + process.exit(1) rather than bubbling
    // as an uncaught stack trace.
    const root = mkdtempSync(join(tmpdir(), 'void-status-corrupt-journal-'));
    rootsToClean.push(root);

    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    writeFileSync(join(migrationsDir, '0001_a.sql'), '-- a\n');
    // Corrupted journal — invalid JSON, e.g. from a bad merge.
    writeFileSync(join(migrationsDir, 'meta', '_journal.json'), '{invalid');
    writeFileSync(join(root, 'void.json'), JSON.stringify({}));

    await expect(runDbCommand(root, { action: 'status' })).rejects.toThrow('process.exit:1');

    expect(mockLog.error).toHaveBeenCalledTimes(1);
    const errorMessage = mockLog.error.mock.calls[0][0] as string;
    expect(errorMessage).toContain('_journal.json');
  });
});

describe('void db rename-migrations', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Return a path that does NOT exist so the SQLite tracking branch no-ops.
    mockGetMiniflareDatabasePath.mockReturnValue(join(tmpdir(), 'nonexistent-void-rename.sqlite'));
    // Reinstall default implementations — `mockReset` in `afterEach`
    // clears them between tests.
    mockGetToken.mockImplementation(() => null);
    mockReadProjectConfig.mockImplementation(() => null);
    mockRenameMigrations.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockOpenSqliteDatabase.mockReset();
    mockGetAppliedMigrations.mockReset();
    mockRunMigrations.mockReset();
    mockWriteJournal.mockReset();
    mockGetToken.mockReset();
    mockReadProjectConfig.mockReset();
    mockRenameMigrations.mockReset();
    for (const root of rootsToClean.splice(0, rootsToClean.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites journal tags to match renamed files (sqlite)', async () => {
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });
    // Journal-backed projects must have matching snapshots on
    // disk. Seed them so the pre-rename gate passes.
    const migrationsDirForSnapshots = join(root, 'db', 'migrations');
    writeFileSync(
      join(migrationsDirForSnapshots, 'meta', '0001_snapshot.json'),
      '{"id":"snap-a","prevId":null}',
    );
    writeFileSync(
      join(migrationsDirForSnapshots, 'meta', '0002_snapshot.json'),
      '{"id":"snap-b","prevId":"snap-a"}',
    );

    await runDbCommand(root, { action: 'rename-migrations' });

    const migrationsDir = join(root, 'db', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\d{14}_a\.sql$/);
    expect(files[1]).toMatch(/^\d{14}_b\.sql$/);

    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8'));
    expect(journal.version).toBe('7');
    expect(journal.dialect).toBe('sqlite');
    expect(journal.entries).toHaveLength(2);
    const tagsOnDisk = files.map((f) => f.replace(/\.sql$/, ''));
    expect(journal.entries.map((e: { tag: string }) => e.tag).sort()).toEqual(tagsOnDisk.sort());
    // idx preserved
    expect(journal.entries[0].idx).toBe(0);
    expect(journal.entries[1].idx).toBe(1);
    // when preserved (original fixture values)
    expect(journal.entries[0].when).toBe(1_700_000_000_000);
    expect(journal.entries[1].when).toBe(1_700_000_000_001);

    const { collectMigrations } = await import('../../src/migrations/collect.ts');
    const { assertJournalCoherence } = await import('../../src/migrations/validate.ts');
    expect(() =>
      assertJournalCoherence(migrationsDir, collectMigrations(migrationsDir)),
    ).not.toThrow();
  });

  it('renames legacy bare projects without a journal (no _journal.json, no snapshots)', async () => {
    // Legacy projects carry hand-written `.sql` files plus a tracking row
    // in `_void_migrations`, but no `meta/_journal.json` and no snapshots.
    // `rename-migrations` must still be usable on those projects — it
    // renames the files, updates the tracking rows, and skips the journal/
    // snapshot rewrite steps cleanly (no journal is created).
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
      withJournal: false,
    });

    const migrationsDir = join(root, 'db', 'migrations');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    expect(existsSync(journalPathOnDisk)).toBe(false);

    // Seed a real SQLite file with a `_void_migrations` tracking table so we
    // can assert the tracking rows get rewritten even without a journal.
    const Database = (await import('better-sqlite3')).default;
    const dbPath = join(root, '.void', 'legacy.sqlite');
    mkdirSync(join(root, '.void'), { recursive: true });
    const db = new Database(dbPath);
    db.exec(
      'CREATE TABLE _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);' +
        "INSERT INTO _void_migrations (name, applied_at) VALUES ('0001_a.sql', '2025-01-01T00:00:00Z');" +
        "INSERT INTO _void_migrations (name, applied_at) VALUES ('0002_b.sql', '2025-01-02T00:00:00Z');",
    );
    db.close();
    mockGetMiniflareDatabasePath.mockReturnValue(dbPath);

    await runDbCommand(root, { action: 'rename-migrations' });

    // Files got renamed to timestamp-prefixed tags.
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\d{14}_a\.sql$/);
    expect(files[1]).toMatch(/^\d{14}_b\.sql$/);

    // No journal file was synthesized — legacy projects stay legacy.
    expect(existsSync(journalPathOnDisk)).toBe(false);
    // Nothing landed in meta/ either.
    const metaDir = join(migrationsDir, 'meta');
    if (existsSync(metaDir)) {
      expect(readdirSync(metaDir)).toEqual([]);
    }

    // Tracking rows were updated to match the new filenames.
    const verify = new Database(dbPath);
    const names = verify.prepare('SELECT name FROM _void_migrations ORDER BY name').all() as Array<{
      name: string;
    }>;
    verify.close();
    expect(names).toHaveLength(2);
    expect(names[0].name).toMatch(/^\d{14}_a\.sql$/);
    expect(names[1].name).toMatch(/^\d{14}_b\.sql$/);
  }, 15_000);

  it('restores original journal bytes when writeJournal itself fails', async () => {
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    // Seed snapshots so the pre-rename gate passes and we
    // actually exercise the `writeJournal` failure path below.
    writeFileSync(join(migrationsDir, 'meta', '0001_snapshot.json'), '{"id":"snap-a"}');
    writeFileSync(join(migrationsDir, 'meta', '0002_snapshot.json'), '{"id":"snap-b"}');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);

    // Force `writeJournal` to throw during the rename flow. With the
    // current rollback semantics, the snapshot must still be restored
    // byte-for-byte even though the mutation never completed.
    mockWriteJournal.mockImplementation(() => {
      throw new Error('simulated writeJournal failure');
    });

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // Files reverted to original names.
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toEqual(['0001_a.sql', '0002_b.sql']);

    // Journal restored byte-for-byte.
    const afterBytes = readFileSync(journalPathOnDisk);
    expect(afterBytes.equals(originalJournalBytes)).toBe(true);
  });

  it('restores journal on rollback when sqlite tracking update fails', async () => {
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    // Seed snapshots so the pre-rename gate passes and we
    // actually reach the sqlite tracking-table branch below.
    writeFileSync(join(migrationsDir, 'meta', '0001_snapshot.json'), '{"id":"snap-a"}');
    writeFileSync(join(migrationsDir, 'meta', '0002_snapshot.json'), '{"id":"snap-b"}');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);

    // Create a fake sqlite DB file so the SQLite branch runs.
    const fakeDbPath = join(root, '.void', 'fake.sqlite');
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(fakeDbPath, '');
    mockGetMiniflareDatabasePath.mockReturnValue(fakeDbPath);

    // Force the tracking-table update to blow up.
    mockOpenSqliteDatabase.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // Files reverted to original names.
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toEqual(['0001_a.sql', '0002_b.sql']);

    // Journal restored byte-for-byte.
    const afterBytes = readFileSync(journalPathOnDisk);
    expect(afterBytes.equals(originalJournalBytes)).toBe(true);
  });

  it('renames meta/*_snapshot.json alongside .sql files', async () => {
    // Drizzle-kit stores snapshots at `meta/<tag-prefix>_snapshot.json`
    // where the prefix is everything before the first underscore in the
    // journal entry's tag. Renaming the .sql file without renaming the
    // snapshot leaves drop/rollback tooling looking for the wrong path, so
    // `rename-migrations` must rename both in lockstep.
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    const snapshotContentsA = '{"id":"snap-a","prevId":null}';
    const snapshotContentsB = '{"id":"snap-b","prevId":"snap-a"}';
    writeFileSync(join(migrationsDir, 'meta', '0001_snapshot.json'), snapshotContentsA);
    writeFileSync(join(migrationsDir, 'meta', '0002_snapshot.json'), snapshotContentsB);

    await runDbCommand(root, { action: 'rename-migrations' });

    // SQL files got timestamp prefixes.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toHaveLength(2);
    const tagA = sqlFiles[0].replace(/\.sql$/, '');
    const tagB = sqlFiles[1].replace(/\.sql$/, '');
    const prefixA = tagA.split('_')[0];
    const prefixB = tagB.split('_')[0];
    expect(prefixA).toMatch(/^\d{14}$/);
    expect(prefixB).toMatch(/^\d{14}$/);

    // The old snapshot paths no longer exist.
    const metaDir = join(migrationsDir, 'meta');
    expect(existsSync(join(metaDir, '0001_snapshot.json'))).toBe(false);
    expect(existsSync(join(metaDir, '0002_snapshot.json'))).toBe(false);

    // The new snapshot paths exist and carry the original bytes.
    const newSnapshotA = join(metaDir, `${prefixA}_snapshot.json`);
    const newSnapshotB = join(metaDir, `${prefixB}_snapshot.json`);
    expect(existsSync(newSnapshotA)).toBe(true);
    expect(existsSync(newSnapshotB)).toBe(true);
    expect(readFileSync(newSnapshotA, 'utf-8')).toBe(snapshotContentsA);
    expect(readFileSync(newSnapshotB, 'utf-8')).toBe(snapshotContentsB);
  });

  it('renames journal-backed projects when matching snapshots are present', async () => {
    // Positive coverage for the round-29 gate: a journal-backed project
    // with all snapshots present on disk renames cleanly and does not
    // invent spurious snapshot files along the way.
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
      },
    });
    const migrationsDir = join(root, 'db', 'migrations');
    writeFileSync(
      join(migrationsDir, 'meta', '0001_snapshot.json'),
      '{"id":"snap-a","prevId":null}',
    );

    await runDbCommand(root, { action: 'rename-migrations' });

    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toHaveLength(1);
    expect(sqlFiles[0]).toMatch(/^\d{14}_a\.sql$/);

    // Exactly one snapshot file exists, under the new timestamp prefix.
    const metaFiles = readdirSync(join(migrationsDir, 'meta'));
    const snapshots = metaFiles.filter((f) => f.endsWith('_snapshot.json')).sort();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatch(/^\d{14}_snapshot\.json$/);
  });

  it('renames bare-legacy placeholder journal projects (empty entries, no snapshots)', async () => {
    // The kitchen-sink playground ships a placeholder journal of the
    // form `{"version":"7","dialect":"sqlite","entries":[]}` with no
    // `meta/*_snapshot.json` files. `assertJournalCoherence` treats that
    // shape as bare-legacy, so the pre-rename snapshot gate must not run.
    const root = mkdtempSync(join(tmpdir(), 'void-rename-placeholder-'));
    rootsToClean.push(root);

    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    writeFileSync(join(migrationsDir, '0000_foo.sql'), '-- foo\n');
    writeFileSync(join(migrationsDir, '0001_bar.sql'), '-- bar\n');
    // Placeholder journal: parseable, well-formed, empty entries.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }, null, 2) + '\n',
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({}));

    // Sanity: no snapshot files seeded, no migrations.js.
    expect(readdirSync(join(migrationsDir, 'meta'))).toEqual(['_journal.json']);
    expect(existsSync(join(migrationsDir, 'migrations.js'))).toBe(false);

    await runDbCommand(root, { action: 'rename-migrations' });

    // Files were renamed to timestamp-prefixed tags.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toHaveLength(2);
    expect(sqlFiles[0]).toMatch(/^\d{14}_foo\.sql$/);
    expect(sqlFiles[1]).toMatch(/^\d{14}_bar\.sql$/);

    // No "missing snapshot" error was logged — the gate was skipped.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).not.toContain('snapshot files are missing');
    expect(errorMessages).not.toContain('drizzle-managed project');
  });

  it('refuses to rename when _journal.json is missing but meta/*_snapshot.json is present', async () => {
    // Regression: `rename-migrations` used to key its legacy bypass solely
    // on the absence of `_journal.json`. If a user lost the journal in a
    // merge but the drizzle snapshots stayed behind, the command ran to
    // completion, renamed the files, and reported success — after which
    // every subsequent `void db status`/`migrate`/`deploy` failed because
    // `assertJournalCoherence` treats that exact shape as partial drizzle
    // state. Refuse up front with the same phrasing, before any file
    // mutation or remote call.
    const root = createRenameProjectRoot({
      files: {
        '0001_old.sql': '-- old\n',
      },
      withJournal: false,
    });
    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const snapshotPath = join(migrationsDir, 'meta', '0000_silent_the_anarchist_snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify({ id: 'snap-0000', prevId: null }));

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // No files were renamed — the lone .sql is still on disk under its
    // original numeric prefix.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['0001_old.sql']);
    // The snapshot is still there too.
    expect(existsSync(snapshotPath)).toBe(true);

    // The error message calls out the partial state AND the snapshot path.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('partial drizzle-kit state');
    expect(errorMessages).toContain('db/migrations/meta/0000_silent_the_anarchist_snapshot.json');
  });

  it('refuses to rename when _journal.json is missing but migrations.js is present', async () => {
    // Symmetric to the snapshot case above, but for drizzle-kit's bundled
    // mode. A `migrations.js` on disk without a journal is still a
    // partial drizzle-kit state — refuse consistently.
    const root = createRenameProjectRoot({
      files: {
        '0001_old.sql': '-- old\n',
      },
      withJournal: false,
    });
    const migrationsDir = join(root, 'db', 'migrations');
    const bundledPath = join(migrationsDir, 'migrations.js');
    writeFileSync(bundledPath, 'export default {};\n');

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // Nothing got renamed.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['0001_old.sql']);
    expect(existsSync(bundledPath)).toBe(true);

    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('partial drizzle-kit state');
    expect(errorMessages).toContain('db/migrations/migrations.js');
  });

  it('refuses to rename when db/migrations has journal/file drift (missing .sql)', async () => {
    // Seed a journal with two entries but only one matching `.sql` file on
    // disk. `assertJournalCoherence` rejects that shape across the rest of
    // the CLI; `rename-migrations` must refuse with the same drift error
    // BEFORE any file rename, journal rewrite, or remote call. Previously
    // the command checked only the partial-state shape (missing journal +
    // leftover artifacts) and happily renamed the one matching file,
    // leaving the user with new timestamped filenames that were harder to
    // reconcile against the stale journal entry.
    const root = createRenameProjectRoot({
      files: {
        '0001_first.sql': '-- first\n',
      },
      journalEntries: [
        {
          idx: 0,
          version: '7',
          when: 1_700_000_000_000,
          tag: '0001_first',
          breakpoints: true,
        },
        {
          idx: 1,
          version: '7',
          when: 1_700_000_000_001,
          tag: '0002_second',
          breakpoints: true,
        },
      ],
    });
    const migrationsDir = join(root, 'db', 'migrations');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);
    const filesBefore = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // File list is byte-identical to what we seeded.
    const filesAfter = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter).toEqual(['0001_first.sql']);

    // Journal bytes are untouched — no partial rewrite.
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);

    // No tracking-table update, no remote call, no journal write was attempted.
    expect(mockOpenSqliteDatabase).not.toHaveBeenCalled();
    expect(mockWriteJournal).not.toHaveBeenCalled();

    // Error message calls out drift AND names the missing file.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('Migration drift detected');
    expect(errorMessages).toContain('db/migrations/0002_second.sql');
  });

  it('refuses to rename when disk has an orphan .sql file not in journal', async () => {
    // Symmetric to the missing-file drift case: seed one journal entry but
    // two `.sql` files on disk. The extra file is an orphan drizzle-kit
    // never saw; renaming it would dress it up with a timestamp prefix and
    // leave the orphan state intact. Refuse up front via
    // `assertJournalCoherence`, same as the rest of the CLI.
    const root = createRenameProjectRoot({
      files: {
        '0001_first.sql': '-- first\n',
        '0002_orphan.sql': '-- orphan\n',
      },
      journalEntries: [
        {
          idx: 0,
          version: '7',
          when: 1_700_000_000_000,
          tag: '0001_first',
          breakpoints: true,
        },
      ],
    });
    const migrationsDir = join(root, 'db', 'migrations');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);
    const filesBefore = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // Both files remain on disk under their original numeric prefixes.
    const filesAfter = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter).toEqual(['0001_first.sql', '0002_orphan.sql']);

    // Journal bytes untouched.
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);

    // No tracking-table update, no remote call, no journal write.
    expect(mockOpenSqliteDatabase).not.toHaveBeenCalled();
    expect(mockWriteJournal).not.toHaveBeenCalled();

    // Error message calls out drift AND names the orphan file.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('Migration drift detected');
    expect(errorMessages).toContain('db/migrations/0002_orphan.sql');
  });

  it('refuses to rename when db/migrations/migrations.js is present (bundled mode)', async () => {
    // A drizzle-kit bundled project has BOTH `_journal.json` AND
    // `db/migrations/migrations.js`. The journal is valid, so the
    // partial-state guard above does NOT fire — only the bundled-mode
    // guard does. Renaming the .sql files in bundled mode would break the
    // static imports inside `migrations.js` at runtime, so refuse up
    // front with an actionable recovery path before touching anything.
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });
    const migrationsDir = join(root, 'db', 'migrations');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);
    const bundledPath = join(migrationsDir, 'migrations.js');
    writeFileSync(
      bundledPath,
      "import m0000 from './0001_a.sql?raw';\n" +
        "import m0001 from './0002_b.sql?raw';\n" +
        'export default { migrations: { m0000, m0001 } };\n',
    );
    const originalBundleBytes = readFileSync(bundledPath);

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // Files are untouched — nothing was renamed.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['0001_a.sql', '0002_b.sql']);

    // Journal bytes unchanged.
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);
    // Bundle file is still there, unchanged.
    expect(existsSync(bundledPath)).toBe(true);
    expect(readFileSync(bundledPath).equals(originalBundleBytes)).toBe(true);

    // No remote calls / tracking-table updates were attempted.
    expect(mockOpenSqliteDatabase).not.toHaveBeenCalled();
    expect(mockWriteJournal).not.toHaveBeenCalled();

    // Error message calls out the bundled format and the recovery path.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toMatch(/bundled migration format/);
    expect(errorMessages).toContain('db/migrations/migrations.js');
  });

  it('rollback restores snapshot filenames when journal rewrite fails', async () => {
    // Seed snapshots alongside the .sql files, then force `writeJournal` to
    // throw. Rollback must reverse both the .sql renames AND the snapshot
    // renames, leaving the filesystem exactly as it was before.
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    const snapshotContentsA = '{"id":"snap-a"}';
    const snapshotContentsB = '{"id":"snap-b"}';
    writeFileSync(join(migrationsDir, 'meta', '0001_snapshot.json'), snapshotContentsA);
    writeFileSync(join(migrationsDir, 'meta', '0002_snapshot.json'), snapshotContentsB);

    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);

    // Force the journal rewrite to fail after the file (and snapshot)
    // renames have happened, so we exercise the full rollback path.
    mockWriteJournal.mockImplementation(() => {
      throw new Error('simulated writeJournal failure');
    });

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // SQL files reverted to original names.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['0001_a.sql', '0002_b.sql']);

    // Snapshot files restored to original paths with original contents.
    const metaDir = join(migrationsDir, 'meta');
    expect(existsSync(join(metaDir, '0001_snapshot.json'))).toBe(true);
    expect(existsSync(join(metaDir, '0002_snapshot.json'))).toBe(true);
    expect(readFileSync(join(metaDir, '0001_snapshot.json'), 'utf-8')).toBe(snapshotContentsA);
    expect(readFileSync(join(metaDir, '0002_snapshot.json'), 'utf-8')).toBe(snapshotContentsB);

    // No stray timestamp-prefixed snapshot paths linger.
    const allSnapshots = readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'));
    expect(allSnapshots.sort()).toEqual(['0001_snapshot.json', '0002_snapshot.json']);

    // Journal restored byte-for-byte.
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);
  });

  it('refuses to rename when a journal-backed snapshot is missing', async () => {
    // Journal-backed project where the snapshot for one of the tags has
    // disappeared (bad merge, hand cleanup). Renaming would leave the
    // snapshot chain broken for the next `void gen migration` or
    // `void db generate`, so the command refuses BEFORE any rename happens.
    const root = createRenameProjectRoot({
      files: {
        '0000_foo.sql': '-- foo\n',
        '0001_bar.sql': '-- bar\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    const metaDir = join(migrationsDir, 'meta');
    // 0000_snapshot.json present, 0001_snapshot.json deliberately missing.
    writeFileSync(join(metaDir, '0000_snapshot.json'), '{"id":"snap-0000","prevId":null}');

    const journalPathOnDisk = join(metaDir, '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);
    const filesBefore = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // Neither .sql file was renamed — both are still on disk under
    // their original numeric prefixes.
    const filesAfter = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter).toEqual(['0000_foo.sql', '0001_bar.sql']);

    // The journal file is byte-unchanged from the original.
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);

    // No tracking-table update, no journal rewrite was attempted.
    expect(mockOpenSqliteDatabase).not.toHaveBeenCalled();
    expect(mockWriteJournal).not.toHaveBeenCalled();

    // The error message calls out the missing snapshot path.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('snapshot files are missing');
    expect(errorMessages).toContain('db/migrations/meta/0001_snapshot.json');
  });

  it('runs the snapshot preflight BEFORE mutating the remote (linked project)', async () => {
    // Regression: `runRenameMigrations` used to call
    // `client.renameMigrations` FIRST and then run the snapshot preflight
    // gate, meaning a missing snapshot left the remote mutated while
    // nothing locally changed. The best-effort `reverseRemote()` rollback
    // could then fail transiently and leave the project in a divergent
    // state. The fix hoists the preflight above the remote call so the
    // remote is mutated only after the local state is verified safe.
    //
    // This test simulates a linked project (`getToken` + `readProjectConfig`
    // both return values) with a journal-backed layout where one snapshot
    // is missing. `client.renameMigrations` is wired to throw if it ever
    // runs. We assert:
    //   1. `process.exit(1)` fires with the missing-snapshot error.
    //   2. `client.renameMigrations` was NEVER called.
    //   3. The on-disk state is byte-identical to the seed (no local
    //      mutation either — the preflight runs before file renames too).
    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-under-test', slug: 'under-test' });
    mockRenameMigrations.mockImplementation(() => {
      throw new Error('client.renameMigrations must not run before preflight');
    });

    const root = createRenameProjectRoot({
      files: {
        '0000_foo.sql': '-- foo\n',
        '0001_bar.sql': '-- bar\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    const metaDir = join(migrationsDir, 'meta');
    // Seed only one of the two required snapshots — 0001 is deliberately
    // absent so the preflight bails.
    writeFileSync(join(metaDir, '0000_snapshot.json'), '{"id":"snap-0000","prevId":null}');

    const journalPathOnDisk = join(metaDir, '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);
    const filesBefore = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    // `client.renameMigrations` was never invoked — the preflight ran
    // first and refused to proceed.
    expect(mockRenameMigrations).not.toHaveBeenCalled();

    // Local filesystem is byte-identical to the seed: no .sql renames,
    // no journal rewrite, no snapshot renames.
    const filesAfter = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter).toEqual(['0000_foo.sql', '0001_bar.sql']);
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);
    // The one snapshot we did seed is still there under its original name.
    expect(existsSync(join(metaDir, '0000_snapshot.json'))).toBe(true);

    // Error message names the missing snapshot file.
    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('snapshot files are missing');
    expect(errorMessages).toContain('db/migrations/meta/0001_snapshot.json');
  });
});
