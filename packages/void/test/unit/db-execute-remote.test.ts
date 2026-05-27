import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// ---- hoisted mocks ---------------------------------------------------------

const mockGetToken = vi.fn<() => string | null>(() => null);
const mockReadProjectConfig = vi.fn<() => { projectId: string; slug: string } | null>(() => null);
const mockIsStagingMode = vi.fn<() => boolean>(() => false);

const mockGetResources = vi.fn<() => Promise<Array<{ type: string; binding_name: string }>>>(() =>
  Promise.resolve([]),
);
const mockGetDatabaseUrl = vi.fn<() => Promise<{ url: string }>>();

vi.mock('../../src/cli/auth', () => ({
  getToken: () => mockGetToken(),
  isStagingMode: () => mockIsStagingMode(),
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
  isVoidInternalStaging: () => false,
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    getResources() {
      return mockGetResources();
    }
    getDatabaseUrl() {
      return mockGetDatabaseUrl();
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

const mockPgConnect = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockPgEnd = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockPgQuery = vi.fn<() => Promise<{ rows: Array<Record<string, unknown>> }>>(() =>
  Promise.resolve({ rows: [] }),
);

vi.mock('pg', () => ({
  Client: class {
    connect = mockPgConnect;
    end = mockPgEnd;
    query = mockPgQuery;
  },
}));

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

const mockConfirm = vi.fn<() => Promise<boolean | symbol>>();
const mockIsCancel = vi.fn<(value: unknown) => boolean>((v) => typeof v === 'symbol');

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  isCancel: (v: unknown) => mockIsCancel(v),
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

function createProjectRoot(options: { database?: 'pg' } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-execute-remote-'));
  roots.push(root);

  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });

  const voidConfig = options.database === 'pg' ? { database: 'pg' } : {};
  writeFileSync(join(root, 'void.json'), JSON.stringify(voidConfig));

  // .void/project.json to satisfy readProjectConfig (the REAL one is mocked,
  // so this is just to ensure the root is a plausible project dir)
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({ projectId: 'proj-abc', slug: 'test-proj' }),
  );

  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('void db execute --remote (D1)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });
    mockIsStagingMode.mockReturnValue(false);
    mockGetResources.mockResolvedValue([]);
    // By default, confirm returns true (proceed)
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockImplementation((v) => typeof v === 'symbol');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('POSTs to /d1/query with correct URL, body, and auth headers', async () => {
    const root = createProjectRoot();
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.void.cloud/d1/query');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      projectId: 'proj-abc',
      binding: 'DB',
      sql: 'SELECT 1',
      params: [],
      method: 'all',
    });
  });

  it('uses the staging proxy URL when in staging mode', async () => {
    const root = createProjectRoot();
    mockIsStagingMode.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.staging.void.cloud/d1/query');
  });

  it('uses the D1 binding name from getResources when available', async () => {
    const root = createProjectRoot();
    mockGetResources.mockResolvedValue([{ type: 'd1', binding_name: 'MY_DB' }]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('MY_DB');
  });

  it('falls back to binding DB when getResources has no d1 resource', async () => {
    const root = createProjectRoot();
    mockGetResources.mockResolvedValue([{ type: 'kv', binding_name: 'KV_STORE' }]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('DB');
  });

  it('renders a table when results are returned', async () => {
    const root = createProjectRoot();
    const rows = [{ id: 1, name: 'Alice' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: rows, success: true }));

    const consoleSpy = vi.spyOn(console, 'log');
    await runDbCommand(root, { action: 'execute', command: 'SELECT * FROM users', remote: true });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('id');
    expect(output).toContain('name');
    expect(output).toContain('Alice');
  });

  it('errors when not logged in', async () => {
    const root = createProjectRoot();
    mockGetToken.mockReturnValue(null);

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors when no project is linked', async () => {
    const root = createProjectRoot();
    mockReadProjectConfig.mockReturnValue(null);

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors when --file is passed with --remote D1', async () => {
    const root = createProjectRoot();
    // The rejection fires before the file is read, so the file does not need to exist.
    await expect(
      runDbCommand(root, { action: 'execute', file: 'query.sql', remote: true }),
    ).rejects.toThrow('process.exit:1');
  });

  it('rejects --file before prompting for destructive confirmation (ordering regression guard)', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await expect(
      runDbCommand(root, { action: 'execute', file: 'delete.sql', remote: true }),
    ).rejects.toThrow('process.exit:1');

    // The confirmation prompt must NOT have fired — the error comes first.
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('errors on proxy non-OK response', async () => {
    const root = createProjectRoot();
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');
  });

  it('prompts for confirmation on destructive statement in TTY', async () => {
    const root = createProjectRoot();
    // Simulate a TTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(true);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'DELETE FROM users', remote: true });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmCall = mockConfirm.mock.calls[0][0] as { message: string };
    expect(confirmCall.message).toContain('deployed database');
  });

  it('aborts when user declines destructive confirmation', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(false);

    await expect(
      runDbCommand(root, { action: 'execute', command: 'DROP TABLE users', remote: true }),
    ).rejects.toThrow('process.exit:0');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips confirmation for SELECT statements even in TTY', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT * FROM users', remote: true });

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('skips confirmation for EXPLAIN statements', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, {
      action: 'execute',
      command: 'EXPLAIN SELECT * FROM users',
      remote: true,
    });

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('skips confirmation for WITH (CTE) statements', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, {
      action: 'execute',
      command: 'WITH cte AS (SELECT 1) SELECT * FROM cte',
      remote: true,
    });

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('includes CF Access service-token headers when env vars are set', async () => {
    const root = createProjectRoot();
    const originalId = process.env.CF_ACCESS_CLIENT_ID;
    const originalSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    process.env.CF_ACCESS_CLIENT_ID = 'test-client-id.access';
    process.env.CF_ACCESS_CLIENT_SECRET = 'test-client-secret';
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    try {
      await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });
    } finally {
      if (originalId === undefined) {
        delete process.env.CF_ACCESS_CLIENT_ID;
      } else {
        process.env.CF_ACCESS_CLIENT_ID = originalId;
      }
      if (originalSecret === undefined) {
        delete process.env.CF_ACCESS_CLIENT_SECRET;
      } else {
        process.env.CF_ACCESS_CLIENT_SECRET = originalSecret;
      }
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBe('test-client-id.access');
    expect(headers['CF-Access-Client-Secret']).toBe('test-client-secret');
  });

  it('skips confirmation for UPDATE when not in TTY (non-interactive)', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'DELETE FROM users', remote: true });

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('non-remote path is unaffected (regression: local SQLite still works)', async () => {
    // The non-remote path should not call fetch at all
    const root = createProjectRoot();
    // The SQLite path will fail because there's no local DB, but it should
    // try to open the local DB, not call fetch
    await expect(runDbCommand(root, { action: 'execute', command: 'SELECT 1' })).rejects.toThrow(
      'process.exit:1',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('void db execute --remote (PostgreSQL)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });
    mockIsStagingMode.mockReturnValue(false);
    mockPgConnect.mockResolvedValue(undefined);
    mockPgEnd.mockResolvedValue(undefined);
    mockPgQuery.mockResolvedValue({ rows: [] });
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockImplementation((v) => typeof v === 'symbol');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches the database URL via getDatabaseUrl and connects with it', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://user:pass@host:5432/mydb';
    mockGetDatabaseUrl.mockResolvedValue({ url: dbUrl });
    mockPgQuery.mockResolvedValue({ rows: [] });

    await runDbCommand(root, {
      action: 'execute',
      command: 'SELECT 1',
      remote: true,
    });

    expect(mockGetDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(mockPgConnect).toHaveBeenCalledTimes(1);
    expect(mockPgQuery).toHaveBeenCalledWith('SELECT 1');
    expect(mockPgEnd).toHaveBeenCalledTimes(1);
  });

  it('renders a table when rows are returned', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockGetDatabaseUrl.mockResolvedValue({ url: 'postgres://host/db' });
    mockPgQuery.mockResolvedValue({ rows: [{ id: 1, name: 'Bob' }] });

    const consoleSpy = vi.spyOn(console, 'log');
    await runDbCommand(root, {
      action: 'execute',
      command: 'SELECT * FROM users',
      remote: true,
    });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('id');
    expect(output).toContain('name');
    expect(output).toContain('Bob');
  });

  it('surfaces a friendly error on 404 (database URL not stored)', async () => {
    const root = createProjectRoot({ database: 'pg' });

    // Simulate the PlatformApiError that getDatabaseUrl throws on 404
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    mockGetDatabaseUrl.mockRejectedValue(new PlatformApiError('test', 404, '{}'));

    const { log: clackLog } = await import('@clack/prompts');

    await expect(
      runDbCommand(root, {
        action: 'execute',
        command: 'SELECT 1',
        remote: true,
      }),
    ).rejects.toThrow('process.exit:1');

    const errorCalls = (clackLog.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c: Array<unknown>) => String(c[0]))
      .join('\n');
    expect(errorCalls).toContain('void db set-url');
  });

  it('re-throws non-404 errors from getDatabaseUrl', async () => {
    const root = createProjectRoot({ database: 'pg' });

    const { PlatformApiError } = await import('../../src/cli/client.ts');
    mockGetDatabaseUrl.mockRejectedValue(new PlatformApiError('test', 403, '{}'));

    await expect(
      runDbCommand(root, {
        action: 'execute',
        command: 'SELECT 1',
        remote: true,
      }),
    ).rejects.toThrow(PlatformApiError);
  });

  it('prompts for confirmation on destructive statement (TTY)', async () => {
    const root = createProjectRoot({ database: 'pg' });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGetDatabaseUrl.mockResolvedValue({ url: 'postgres://host/db' });
    mockPgQuery.mockResolvedValue({ rows: [] });
    mockConfirm.mockResolvedValue(true);

    await runDbCommand(root, {
      action: 'execute',
      command: 'UPDATE users SET name = $1',
      remote: true,
    });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockPgQuery).toHaveBeenCalledTimes(1);
  });

  it('aborts destructive statement when user declines', async () => {
    const root = createProjectRoot({ database: 'pg' });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(false);

    await expect(
      runDbCommand(root, {
        action: 'execute',
        command: 'DROP TABLE users',
        remote: true,
      }),
    ).rejects.toThrow('process.exit:0');

    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockPgQuery).not.toHaveBeenCalled();
  });
});
