import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { existsSync, spawnSync } = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  spawnSync: vi.fn(() => ({ status: 0, error: undefined as Error | undefined })),
}));

vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('node:fs', () => ({ existsSync }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  spawnSync.mockReturnValue({ status: 0, error: undefined });
  vi.stubEnv('VOID_API_URL', '');
  process.argv = [process.execPath, '/health.ts'];
  process.exitCode = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('platform health script', () => {
  it('uses the selected operator connection without selecting a hosted destination', async () => {
    process.argv.push('--connection', 'https://platform.example.com', '--json');
    await import('../scripts/health.ts');
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringContaining('/packages/void/dist/cli/cli.mjs'),
        'platform',
        'system',
        'health',
        '--connection',
        'https://platform.example.com',
        '--json',
      ],
      { stdio: 'inherit' },
    );
    expect(process.exitCode).toBe(0);
  });

  it('keeps the explicit Void Cloud staging shortcut', async () => {
    process.argv.push('--staging');
    await import('../scripts/health.ts');
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.any(String),
        'platform',
        'system',
        'health',
        '--connection',
        'https://api.staging.void.cloud',
      ],
      { stdio: 'inherit' },
    );
  });

  it('refuses conflicting destinations before invoking the CLI', async () => {
    process.argv.push('--staging');
    vi.stubEnv('VOID_API_URL', 'https://platform.example.com');
    await import('../scripts/health.ts');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('requires a built SDK without invoking another installed void binary', async () => {
    existsSync.mockReturnValue(false);
    await import('../scripts/health.ts');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('preserves a failed health check exit code', async () => {
    spawnSync.mockReturnValue({ status: 2, error: undefined });
    await import('../scripts/health.ts');
    expect(process.exitCode).toBe(2);
  });
});
