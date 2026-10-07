import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// ---- hoisted mocks ---------------------------------------------------------

const mockGetToken = vi.fn<() => string | null>(() => null);
const mockReadProjectConfig = vi.fn<() => { projectId: string; slug: string } | null>(() => null);

const mockGetDatabaseUrl = vi.fn<() => Promise<{ url: string }>>();

vi.mock('../../src/cli/auth', () => ({
  getToken: () => mockGetToken(),
  isStagingMode: () => false,
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
  readDeploymentPlatform: () => 'void',
  isVoidInternalStaging: () => false,
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    getDatabaseUrl() {
      return mockGetDatabaseUrl();
    }
    getResources() {
      return Promise.resolve([]);
    }
  },
  PlatformApiError: class extends Error {
    status: number;
    body: string;
    constructor(action: string, status: number, body: string) {
      super(`${action}: ${status} ${body}`);
      this.status = status;
      this.body = body;
    }
  },
}));

// Mock the drizzle config writers to avoid needing a real schema on disk.
const mockWriteDrizzleConfig = vi.fn<(root: string, dbPath: string, dialect?: string) => string>(
  (root, _dbPath, _dialect) => join(root, '.void', 'drizzle.config.json'),
);
const mockWithPrivateDrizzleConfig = vi.fn(
  (_root: string, _dbUrl: string, _dialect: string, run: (configPath: string) => unknown) =>
    run(join(tmpdir(), 'void-drizzle-test', 'drizzle.config.json')),
);

vi.mock('../../src/drizzle/config.ts', () => ({
  writeDrizzleConfig: (...args: Array<unknown>) =>
    mockWriteDrizzleConfig(...(args as Parameters<typeof mockWriteDrizzleConfig>)),
  withPrivateDrizzleConfig: (...args: Array<unknown>) =>
    mockWithPrivateDrizzleConfig(...(args as Parameters<typeof mockWithPrivateDrizzleConfig>)),
}));

// Mock execFileSync (used by runDrizzleKit) so no child process is spawned.
const mockExecFileSync = vi.fn<() => void>(() => undefined);

vi.mock('node:child_process', () => ({
  execFileSync: (...args: Array<unknown>) =>
    mockExecFileSync(...(args as Parameters<typeof mockExecFileSync>)),
}));

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => typeof v === 'symbol'),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const roots: Array<string> = [];

function expectConfigOutsideRoot(root: string): void {
  expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  const cliArgs = (mockExecFileSync.mock.calls[0] as unknown as [string, Array<string>])[1];
  const configPath = cliArgs[cliArgs.indexOf('--config') + 1];
  expect(configPath).toBeDefined();
  expect(relative(root, configPath!).startsWith('..')).toBe(true);
}

function createProjectRoot(options: { database?: 'pg' } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-studio-remote-'));
  roots.push(root);

  // db/migrations + schema (schema is needed only in the non-mocked local path)
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });

  const voidConfig = options.database === 'pg' ? { database: 'pg' } : {};
  writeFileSync(join(root, 'void.json'), JSON.stringify(voidConfig));

  // .void dir
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({ projectId: 'proj-abc', slug: 'test-proj' }),
  );

  return root;
}

// ---------------------------------------------------------------------------
// Suite — PG remote
// ---------------------------------------------------------------------------

describe('void db studio --remote (PostgreSQL)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });

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
  });

  it('fetches the database URL via getDatabaseUrl and keeps it out of the project directory', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://user:pass@host:5432/mydb';
    mockGetDatabaseUrl.mockResolvedValue({ url: dbUrl });

    await runDbCommand(root, { action: 'studio', remote: true });

    expect(mockGetDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledWith(
      root,
      dbUrl,
      'postgresql',
      expect.any(Function),
    );
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expectConfigOutsideRoot(root);
  });

  it('exits with code 1 when drizzle-kit studio fails', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockGetDatabaseUrl.mockResolvedValue({ url: 'postgres://user:pass@host:5432/mydb' });
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('Command failed');
    });

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );
    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledTimes(1);
  });

  it('spawns drizzle-kit studio --config <configPath>', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://user:pass@host:5432/mydb';
    mockGetDatabaseUrl.mockResolvedValue({ url: dbUrl });

    await runDbCommand(root, { action: 'studio', remote: true });

    // execFileSync is called with (node, [drizzleKitBin, 'studio', '--config', configPath], opts)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const execCallArgs = mockExecFileSync.mock.calls[0] as unknown as [
      string,
      Array<string>,
      unknown,
    ];
    const cliArgs = execCallArgs[1];
    expect(cliArgs).toContain('studio');
    expect(cliArgs).toContain('--config');
  });

  it('surfaces the friendly 404 message when the URL is not stored', async () => {
    const root = createProjectRoot({ database: 'pg' });

    const { PlatformApiError } = await import('../../src/cli/client.ts');
    mockGetDatabaseUrl.mockRejectedValue(new PlatformApiError('test', 404, '{}'));

    const { log: clackLog } = await import('@voidzero-dev/vite-plus-prompts');

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    const errorCalls = (clackLog.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c: Array<unknown>) => String(c[0]))
      .join('\n');
    expect(errorCalls).toContain('void db set-url');
    // No config may be written and drizzle-kit must NOT have been spawned
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expect(mockWithPrivateDrizzleConfig).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('re-throws non-404 errors from getDatabaseUrl', async () => {
    const root = createProjectRoot({ database: 'pg' });

    const { PlatformApiError } = await import('../../src/cli/client.ts');
    mockGetDatabaseUrl.mockRejectedValue(new PlatformApiError('test', 403, '{}'));

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      PlatformApiError,
    );
  });

  it('errors when not logged in', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockGetToken.mockReturnValue(null);

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('errors when no project is linked', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockReadProjectConfig.mockReturnValue(null);

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite — D1 remote (not yet supported)
// ---------------------------------------------------------------------------

describe('void db studio --remote (D1)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });

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
  });

  it('errors with "not yet supported" message and does not call writeDrizzleConfig or execFileSync', async () => {
    const root = createProjectRoot(); // D1 project (no database: 'pg')

    const { log: clackLog } = await import('@voidzero-dev/vite-plus-prompts');

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    const errorCalls = (clackLog.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c: Array<unknown>) => String(c[0]))
      .join('\n');
    expect(errorCalls).toContain('not yet supported');
    expect(errorCalls).toContain('void db execute --remote');

    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expect(mockWithPrivateDrizzleConfig).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite — local (regression: --remote unset)
// ---------------------------------------------------------------------------

describe('void db studio (local, regression)', () => {
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
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('local D1 studio fails (no local DB) without calling getDatabaseUrl', async () => {
    const root = createProjectRoot(); // D1, no local DB file

    // The local D1 path checks for the DB file and exits. Confirm that:
    // - getDatabaseUrl is NOT called (it's remote-only)
    await expect(runDbCommand(root, { action: 'studio' })).rejects.toThrow('process.exit:1');

    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
  });

  it('local PG studio keeps the .env database URL out of the project directory', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://local:pass@localhost:5432/dev';
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dbUrl}\n`);

    await runDbCommand(root, { action: 'studio' });

    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledWith(
      root,
      dbUrl,
      'postgresql',
      expect.any(Function),
    );
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expectConfigOutsideRoot(root);
  });

  it('PG push keeps the .env database URL out of the project directory', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://local:pass@localhost:5432/dev';
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dbUrl}\n`);

    await runDbCommand(root, { action: 'push' });

    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledWith(
      root,
      dbUrl,
      'postgresql',
      expect.any(Function),
    );
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    const cliArgs = (mockExecFileSync.mock.calls[0] as unknown as [string, Array<string>])[1];
    expect(cliArgs).toContain('push');
    expectConfigOutsideRoot(root);
  });

  it('local PG studio does not call getDatabaseUrl (uses local URL path)', async () => {
    const root = createProjectRoot({ database: 'pg' });

    // The local PG path calls getPgUrl (reads .env). No DATABASE_URL set, so it throws.
    // Regardless, getDatabaseUrl must NOT be called — it's only used for --remote.
    await expect(runDbCommand(root, { action: 'studio' })).rejects.toThrow();

    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
  });
});
