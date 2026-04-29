import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockLog = {
  error: vi.fn(),
  info: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
};
const mockGetMiniflareDatabasePath = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockRunMigrations = vi.fn();

vi.mock('@clack/prompts', () => ({
  intro: (...args: Array<unknown>) => mockIntro(...args),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  log: {
    error: (...args: Array<unknown>) => mockLog.error(...args),
    info: (...args: Array<unknown>) => mockLog.info(...args),
    step: (...args: Array<unknown>) => mockLog.step(...args),
    success: (...args: Array<unknown>) => mockLog.success(...args),
  },
}));

vi.mock('../../src/migrations/runner', () => ({
  getMiniflareDatabasePath: (...args: Array<unknown>) => mockGetMiniflareDatabasePath(...args),
  getAppliedMigrations: (...args: Array<unknown>) => mockGetAppliedMigrations(...args),
  runMigrations: (...args: Array<unknown>) => mockRunMigrations(...args),
}));

const roots: Array<string> = [];

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

describe('void db migrate', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetMiniflareDatabasePath.mockReturnValue(join(tmpdir(), 'void-db-migrate.sqlite'));
    mockGetAppliedMigrations.mockResolvedValue([]);
    mockRunMigrations.mockResolvedValue([]);
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
      join(root, 'db', 'migrations'),
      join(tmpdir(), 'void-db-migrate.sqlite'),
    );
    expect(mockLog.success).toHaveBeenCalledWith('Applied 1 migration(s).');
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
});
