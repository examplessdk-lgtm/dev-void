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
const mockPgQuery = vi.hoisted(() => vi.fn(async (_sql: string) => ({ rows: [] })));
const mockConfirm = vi.fn();
const mockGetMiniflareDatabasePath = vi.fn();
const mockOpenSqliteDatabase = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockRunMigrations = vi.fn();
const mockWriteJournal = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: Array<unknown>) => mockExecFileSync(...args),
}));

vi.mock('pg', async (importOriginal) => {
  // Keep pg's own connection-string parsing; stub only the network calls.
  class Client extends (await importOriginal<typeof import('pg')>()).Client {}
  Object.assign(Client.prototype, {
    async connect() {},
    async end() {},
    query: (sql: string) => mockPgQuery(sql),
  });
  return { Client };
});

const mysqlQueries = vi.hoisted((): Array<string> => []);

vi.mock('mysql2/promise', () => ({
  createConnection: async () => ({
    async end() {},
    async query(sql: string) {
      mysqlQueries.push(sql);
      // MySQL 8 labels an unaliased information_schema column in upper case.
      const tables = /^SELECT table_name(?: AS (\w+))? FROM information_schema\.tables/.exec(sql);
      if (tables) {
        const key = tables[1] ?? 'TABLE_NAME';
        return [[{ [key]: '_void_migrations' }, { [key]: 'users' }], []];
      }
      if (sql === 'SELECT `name` FROM `_void_migrations`') {
        const dropped = mysqlQueries.includes('DROP TABLE IF EXISTS `_void_migrations`');
        return [dropped ? [] : [{ name: '0000_init.sql' }], []];
      }
      if (sql.startsWith('SELECT GET_LOCK')) {
        return [[{ acquired: 1 }], []];
      }
      return [[], []];
    },
  }),
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
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  isCancel: () => false,
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
    const root = mkdtempSync(join(tmpdir(), 'void-reset-sqlite-'));
    rootsToClean.push(root);

    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    // The journal names a .sql file that is not on disk.
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

    const fakeDbPath = join(root, '.void', 'fake.sqlite');
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(fakeDbPath, 'sentinel');
    mockGetMiniflareDatabasePath.mockReturnValue(fakeDbPath);
    mockRunMigrations.mockRejectedValue(new Error('runMigrations should not be called'));

    await expect(runDbCommand(root, { action: 'reset' })).rejects.toThrow();

    expect(existsSync(fakeDbPath)).toBe(true);
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it('PostgreSQL: asks before dropping every table in a non-local DATABASE_URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-reset-pg-remote-'));
    rootsToClean.push(root);
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }));
    writeFileSync(
      join(root, '.env'),
      'DATABASE_URL="postgresql://user:secret@db.example.com:5432/prod"\n',
    );
    const stdinTty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
      await expect(runDbCommand(root, { action: 'reset' })).rejects.toThrow('process.exit:1');
      const message = String(mockLog.error.mock.calls[0][0]);
      expect(message).toContain('"prod" on db.example.com:5432');
      expect(message).toContain('--yes');
      expect(message).not.toContain('secret');

      writeFileSync(
        join(root, '.env'),
        'DATABASE_URL="postgresql://user:secret@localhost/prod?host=db.example.com"\n',
      );
      await expect(runDbCommand(root, { action: 'reset' })).rejects.toThrow('process.exit:1');
      expect(String(mockLog.error.mock.lastCall?.[0])).toContain('"prod" on db.example.com:5432');

      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      mockConfirm.mockResolvedValue(false);
      await expect(runDbCommand(root, { action: 'seed' })).rejects.toThrow('process.exit:0');
      expect(mockConfirm).toHaveBeenCalledOnce();

      expect(mockPgQuery).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    }
  });

  it('MySQL: drops every table and re-applies migrations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-reset-mysql-'));
    rootsToClean.push(root);
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'migrations', '0000_init.sql'),
      'CREATE TABLE `users` (id INT);',
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'mysql' }));
    writeFileSync(join(root, '.env'), 'DATABASE_URL="mysql://root@127.0.0.1:3306/app"\n');
    mysqlQueries.length = 0;

    await runDbCommand(root, { action: 'reset' });

    expect(mysqlQueries).toContain('DROP TABLE IF EXISTS `_void_migrations`');
    expect(mysqlQueries).toContain('DROP TABLE IF EXISTS `users`');
    expect(mysqlQueries).toContain('CREATE TABLE `users` (id INT);');
  });
});

describe('void db export', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of rootsToClean.splice(0, rootsToClean.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('MySQL: exports every table with foreign key checks off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-export-mysql-'));
    rootsToClean.push(root);
    writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'mysql' }));
    writeFileSync(join(root, '.env'), 'DATABASE_URL="mysql://root@127.0.0.1:3306/app"\n');
    mysqlQueries.length = 0;
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });

    await runDbCommand(root, { action: 'export' });

    expect(mysqlQueries).toContain('SHOW CREATE TABLE `users`');
    expect(mysqlQueries).toContain('SELECT * FROM `users`');
    expect(mysqlQueries.join('\n')).not.toContain('`undefined`');
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe('SET FOREIGN_KEY_CHECKS = 0;');
    expect(lines.at(-1)).toBe('SET FOREIGN_KEY_CHECKS = 1;');
  });
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
    const root = mkdtempSync(join(tmpdir(), 'void-status-corrupt-journal-'));
    rootsToClean.push(root);

    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    writeFileSync(join(migrationsDir, '0001_a.sql'), '-- a\n');
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
    // afterEach resets these mocks, so reinstall the defaults.
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

  it('renames .sql files, journal tags and snapshots together (sqlite)', async () => {
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });
    const migrationsDir = join(root, 'db', 'migrations');
    const metaDir = join(migrationsDir, 'meta');
    const snapshotContentsA = '{"id":"snap-a","prevId":null}';
    const snapshotContentsB = '{"id":"snap-b","prevId":"snap-a"}';
    writeFileSync(join(metaDir, '0001_snapshot.json'), snapshotContentsA);
    writeFileSync(join(metaDir, '0002_snapshot.json'), snapshotContentsB);

    await runDbCommand(root, { action: 'rename-migrations' });

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\d{14}_a\.sql$/);
    expect(files[1]).toMatch(/^\d{14}_b\.sql$/);

    const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf-8'));
    expect(journal.version).toBe('7');
    expect(journal.dialect).toBe('sqlite');
    expect(journal.entries).toHaveLength(2);
    const tagsOnDisk = files.map((f) => f.replace(/\.sql$/, ''));
    expect(journal.entries.map((e: { tag: string }) => e.tag).sort()).toEqual(tagsOnDisk.sort());
    expect(journal.entries[0].idx).toBe(0);
    expect(journal.entries[1].idx).toBe(1);
    expect(journal.entries[0].when).toBe(1_700_000_000_000);
    expect(journal.entries[1].when).toBe(1_700_000_000_001);

    // Drizzle-kit names a snapshot after the tag's part before the first underscore.
    const [prefixA, prefixB] = tagsOnDisk.map((tag) => tag.split('_')[0]);
    const snapshots = readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'));
    expect(snapshots.sort()).toEqual([`${prefixA}_snapshot.json`, `${prefixB}_snapshot.json`]);
    expect(readFileSync(join(metaDir, `${prefixA}_snapshot.json`), 'utf-8')).toBe(
      snapshotContentsA,
    );
    expect(readFileSync(join(metaDir, `${prefixB}_snapshot.json`), 'utf-8')).toBe(
      snapshotContentsB,
    );

    const { collectMigrations } = await import('../../src/migrations/collect.ts');
    const { assertJournalCoherence } = await import('../../src/migrations/validate.ts');
    expect(() =>
      assertJournalCoherence(migrationsDir, collectMigrations(migrationsDir)),
    ).not.toThrow();
  });

  it('renames legacy bare projects without a journal (no _journal.json, no snapshots)', async () => {
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

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\d{14}_a\.sql$/);
    expect(files[1]).toMatch(/^\d{14}_b\.sql$/);

    expect(existsSync(journalPathOnDisk)).toBe(false);
    const metaDir = join(migrationsDir, 'meta');
    if (existsSync(metaDir)) {
      expect(readdirSync(metaDir)).toEqual([]);
    }

    const verify = new Database(dbPath);
    const names = verify.prepare('SELECT name FROM _void_migrations ORDER BY name').all() as Array<{
      name: string;
    }>;
    verify.close();
    expect(names).toHaveLength(2);
    expect(names[0].name).toMatch(/^\d{14}_a\.sql$/);
    expect(names[1].name).toMatch(/^\d{14}_b\.sql$/);
  }, 15_000);

  it('restores journal on rollback when sqlite tracking update fails', async () => {
    const root = createRenameProjectRoot({
      files: {
        '0001_a.sql': '-- a\n',
        '0002_b.sql': '-- b\n',
      },
    });

    const migrationsDir = join(root, 'db', 'migrations');
    writeFileSync(join(migrationsDir, 'meta', '0001_snapshot.json'), '{"id":"snap-a"}');
    writeFileSync(join(migrationsDir, 'meta', '0002_snapshot.json'), '{"id":"snap-b"}');
    const journalPathOnDisk = join(migrationsDir, 'meta', '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);

    // The SQLite tracking branch runs only when the database file exists.
    const fakeDbPath = join(root, '.void', 'fake.sqlite');
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(fakeDbPath, '');
    mockGetMiniflareDatabasePath.mockReturnValue(fakeDbPath);

    mockOpenSqliteDatabase.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toEqual(['0001_a.sql', '0002_b.sql']);

    const afterBytes = readFileSync(journalPathOnDisk);
    expect(afterBytes.equals(originalJournalBytes)).toBe(true);
  });

  it('renames bare-legacy placeholder journal projects (empty entries, no snapshots)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-rename-placeholder-'));
    rootsToClean.push(root);

    const migrationsDir = join(root, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    writeFileSync(join(migrationsDir, '0000_foo.sql'), '-- foo\n');
    writeFileSync(join(migrationsDir, '0001_bar.sql'), '-- bar\n');
    // An empty placeholder journal counts as bare legacy, so the snapshot check is skipped.
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }, null, 2) + '\n',
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({}));

    expect(readdirSync(join(migrationsDir, 'meta'))).toEqual(['_journal.json']);
    expect(existsSync(join(migrationsDir, 'migrations.js'))).toBe(false);

    await runDbCommand(root, { action: 'rename-migrations' });

    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toHaveLength(2);
    expect(sqlFiles[0]).toMatch(/^\d{14}_foo\.sql$/);
    expect(sqlFiles[1]).toMatch(/^\d{14}_bar\.sql$/);

    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).not.toContain('snapshot files are missing');
    expect(errorMessages).not.toContain('drizzle-managed project');
  });

  it('refuses to rename when db/migrations has journal/file drift (missing .sql)', async () => {
    // The journal lists 0002_second, which is not on disk.
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

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    const filesAfter = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(filesAfter).toEqual(['0001_first.sql']);
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);

    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('Migration drift detected');
    expect(errorMessages).toContain('db/migrations/0002_second.sql');
  });

  it('refuses to rename when db/migrations/migrations.js is present (bundled mode)', async () => {
    // The journal is coherent, so only the bundled-mode guard can stop this rename.
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

    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['0001_a.sql', '0002_b.sql']);

    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);
    expect(existsSync(bundledPath)).toBe(true);
    expect(readFileSync(bundledPath).equals(originalBundleBytes)).toBe(true);

    expect(mockOpenSqliteDatabase).not.toHaveBeenCalled();
    expect(mockWriteJournal).not.toHaveBeenCalled();

    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toMatch(/bundled migration format/);
    expect(errorMessages).toContain('db/migrations/migrations.js');
  });

  it('rollback restores .sql names, snapshots and journal bytes when the journal rewrite fails', async () => {
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

    mockWriteJournal.mockImplementation(() => {
      throw new Error('simulated writeJournal failure');
    });

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['0001_a.sql', '0002_b.sql']);

    const metaDir = join(migrationsDir, 'meta');
    expect(readFileSync(join(metaDir, '0001_snapshot.json'), 'utf-8')).toBe(snapshotContentsA);
    expect(readFileSync(join(metaDir, '0002_snapshot.json'), 'utf-8')).toBe(snapshotContentsB);
    const allSnapshots = readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'));
    expect(allSnapshots.sort()).toEqual(['0001_snapshot.json', '0002_snapshot.json']);

    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);
  });

  it('refuses a missing snapshot before renaming remote records (linked project)', async () => {
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
    // 0001_snapshot.json is missing.
    writeFileSync(join(metaDir, '0000_snapshot.json'), '{"id":"snap-0000","prevId":null}');

    const journalPathOnDisk = join(metaDir, '_journal.json');
    const originalJournalBytes = readFileSync(journalPathOnDisk);

    await expect(runDbCommand(root, { action: 'rename-migrations' })).rejects.toThrow(
      'process.exit:1',
    );

    expect(mockRenameMigrations).not.toHaveBeenCalled();

    const filesAfter = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(filesAfter).toEqual(['0000_foo.sql', '0001_bar.sql']);
    expect(readFileSync(journalPathOnDisk).equals(originalJournalBytes)).toBe(true);
    expect(existsSync(join(metaDir, '0000_snapshot.json'))).toBe(true);

    const errorMessages = mockLog.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('snapshot files are missing');
    expect(errorMessages).toContain('db/migrations/meta/0001_snapshot.json');
  });
});
