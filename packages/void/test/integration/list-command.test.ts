import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempHomes: string[] = [];

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'void-home-'));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

async function importRunListCommand() {
  vi.resetModules();
  const mod = await import('../../src/cli/list');
  return mod.runListCommand;
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

describe('runListCommand', () => {
  afterEach(() => {
    delete process.env.VOID_TOKEN;
    delete process.env.VOID_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits with error when not logged in', async () => {
    setIsolatedHome();

    const capture = captureOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    await expect(runListCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('Not logged in');
    expect(exitSpy).toHaveBeenCalled();
  });

  it('exits with error when no linked project and no slug', async () => {
    setIsolatedHome();
    process.env.VOID_TOKEN = 'test-token';

    const capture = captureOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    await expect(runListCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('No linked project found');
    expect(exitSpy).toHaveBeenCalled();
  });
});
