import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const tempHomes: Array<string> = [];
const mockGetToken = vi.fn<() => string | null>();

vi.mock('../../src/cli/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => mockGetToken(),
  getApiUrl: () => 'https://api.example.test',
}));

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'void-home-'));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

async function importRunListCommand() {
  vi.resetModules();
  const mod = await import('../../src/cli/list.ts');
  return mod.runListCommand;
}

function captureOutput(): { output: () => string; restore: () => void } {
  const chunks: Array<string> = [];
  const writeMock = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((...args: Array<unknown>) => {
      const chunk = args[0];
      if (typeof chunk === 'string') {
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk.toString());
      }
      return true;
    });
  const logMock = vi.spyOn(console, 'log').mockImplementation((...args: Array<unknown>) => {
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
  beforeEach(() => {
    mockGetToken.mockReset().mockReturnValue(null);
  });

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
    mockGetToken.mockReturnValue('test-token');

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

  it('summarizes per-path revalidation rules in the isr column', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(
      join(root, '.void', 'project.json'),
      JSON.stringify({
        projectId: 'proj-1',
        slug: 'demo',
      }),
    );
    const deployment = (id: string, manifest: Record<string, unknown>) => ({
      id,
      status: 'live',
      source: 'cli',
      commit: null,
      manifest: JSON.stringify(manifest),
      error_message: null,
      retained: true,
      applied_migrations: null,
      created_at: '2026-01-01T00:00:00Z',
      deployed_at: '2026-01-01T00:00:00Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          deployments: [
            deployment('dep-one-rule', { type: 'ssr', pathRevalidate: { '/a': 60 } }),
            deployment('dep-two-rules', { type: 'ssr', pathRevalidate: { '/a': 60, '/b': 30 } }),
            deployment('dep-global', {
              type: 'ssr',
              revalidate: 120,
              pathRevalidate: { '/a': 60 },
            }),
            deployment('dep-none', { type: 'ssr' }),
          ],
          activeDeploymentId: 'dep-one-rule',
        }),
      ),
    );

    const capture = captureOutput();
    const runListCommand = await importRunListCommand();
    await runListCommand(root);
    const out = capture.output();
    capture.restore();

    const rowFor = (id: string) => out.split('\n').find((line) => line.includes(id)) ?? '';
    expect(rowFor('dep-one-rule')).toMatch(/\b1 rule\b/);
    expect(rowFor('dep-two-rules')).toMatch(/\b2 rules\b/);
    expect(rowFor('dep-global')).toMatch(/\b120s\b/);
    expect(rowFor('dep-none')).not.toMatch(/rule|\d+s\b/);
  });
});
