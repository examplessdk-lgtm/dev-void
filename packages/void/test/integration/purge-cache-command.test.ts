import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempHomes: string[] = [];
const tempRoots: string[] = [];

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'void-home-'));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function createLinkedProject(root: string): void {
  const voidDir = join(root, '.void');
  mkdirSync(voidDir, { recursive: true });
  writeFileSync(
    join(voidDir, 'project.json'),
    JSON.stringify({ projectId: 'proj_123', slug: 'my-app' }),
  );
}

function captureOutput(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const writeMock = vi.spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    const chunk = args[0];
    if (typeof chunk === 'string') {
      chunks.push(chunk);
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk.toString());
    }
    return true;
  });
  const logMock = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  });
  return {
    output: () => chunks.join(''),
    restore: () => {
      writeMock.mockRestore();
      logMock.mockRestore();
    },
  };
}

async function importRunPurgeCacheCommand() {
  vi.resetModules();
  const mod = await import('../../src/cli/cache');
  return mod.runPurgeCacheCommand;
}

describe('runPurgeCacheCommand', () => {
  afterEach(() => {
    delete process.env.VOID_TOKEN;
    delete process.env.VOID_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('purges cache for linked project', async () => {
    setIsolatedHome();
    process.env.VOID_TOKEN = 'test-token';
    process.env.VOID_API_URL = 'https://api.example.test';

    const root = mkdtempSync(join(tmpdir(), 'void-root-'));
    tempRoots.push(root);
    createLinkedProject(root);

    const fetchMock = vi.fn(async () => Response.json({ purged: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    const capture = captureOutput();
    const runPurgeCacheCommand = await importRunPurgeCacheCommand();
    await runPurgeCacheCommand(root);
    const out = capture.output();
    capture.restore();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/projects/proj_123/revalidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ all: true }),
      },
    );
    expect(out).toContain('5 cached page(s)');
  });

  it('exits with error when not logged in', async () => {
    setIsolatedHome();

    const root = mkdtempSync(join(tmpdir(), 'void-root-'));
    tempRoots.push(root);

    const capture = captureOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runPurgeCacheCommand = await importRunPurgeCacheCommand();
    await expect(runPurgeCacheCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('Not logged in');
    expect(exitSpy).toHaveBeenCalled();
  });

  it('exits with error when no linked project', async () => {
    setIsolatedHome();
    process.env.VOID_TOKEN = 'test-token';

    const root = mkdtempSync(join(tmpdir(), 'void-root-'));
    tempRoots.push(root);

    const capture = captureOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runPurgeCacheCommand = await importRunPurgeCacheCommand();
    await expect(runPurgeCacheCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('No linked project');
    expect(exitSpy).toHaveBeenCalled();
  });

  it('exits with error when API returns an error', async () => {
    setIsolatedHome();
    process.env.VOID_TOKEN = 'test-token';
    process.env.VOID_API_URL = 'https://api.example.test';

    const root = mkdtempSync(join(tmpdir(), 'void-root-'));
    tempRoots.push(root);
    createLinkedProject(root);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 })),
    );

    const capture = captureOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runPurgeCacheCommand = await importRunPurgeCacheCommand();
    await expect(runPurgeCacheCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('Cache purge failed');
    expect(exitSpy).toHaveBeenCalled();
  });
});
