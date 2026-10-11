import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runPlatformWrangler } from '../../src/cli/platform-installer-process.ts';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/cli/provision.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/provision.ts')>()),
  createDefaultRunWrangler: () => mocks.run,
}));
vi.mock('../../src/cli/preset.ts', () => ({
  resolveCloudflareOperationArgv: () => ['unused-test-launcher'],
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([true, false])(
  'keeps successful platform command output quiet (capture: %s)',
  async (capture) => {
    const result = {
      status: 0,
      stdout: 'Wrangler banner\nDeployed triggers\n',
      stderr: 'Experimental command warning\n',
    };
    mocks.run.mockResolvedValue(result);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(
      runPlatformWrangler({ type: 'triggers.deploy' }, 'account', '/test', capture),
    ).resolves.toEqual(result);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  },
);

it.each([1, null])(
  'preserves diagnostics from failed platform commands (status: %s)',
  async (status) => {
    const result = { status, stdout: 'Command context\n', stderr: 'Permission denied\n' };
    mocks.run.mockResolvedValue(result);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(
      runPlatformWrangler({ type: 'triggers.deploy' }, 'account', '/test', false),
    ).resolves.toEqual(result);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(result.stdout);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(result.stderr);
  },
);

it('returns captured failure diagnostics without printing JSON inspection output', async () => {
  const result = { status: 1, stdout: '{"error":"failed"}', stderr: 'Permission denied\n' };
  mocks.run.mockResolvedValue(result);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  await expect(
    runPlatformWrangler({ type: 'deployments.list' }, 'account', '/test', true),
  ).resolves.toEqual(result);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});
