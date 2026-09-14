import { afterEach, expect, it, vi } from 'vite-plus/test';
import { createWindowsResourceReporter } from '../../../../test/windows-resource-diagnostics.ts';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

afterEach(() => {
  vi.restoreAllMocks();
  execFileMock.mockReset();
});

it('shares one bounded snapshot across concurrent failures', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const report = createWindowsResourceReporter();
  const first = report();
  const second = report();

  expect(second).toBe(first);
  expect(execFileMock).toHaveBeenCalledOnce();
  const [command, args, options, finish] = execFileMock.mock.calls[0]!;
  expect(command).toBe('powershell.exe');
  expect(args).toEqual([
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    expect.stringMatching(/windows-resource-diagnostics\.ps1$/),
  ]);
  expect(options).toEqual({
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  finish(null, 'TCP connections: 12', '');
  await Promise.all([first, second, report()]);
  expect(execFileMock).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledExactlyOnceWith('Windows resource snapshot:\nTCP connections: 12');
});

it('retains partial output without rejecting when collection times out', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  execFileMock.mockImplementation((_command, _args, _options, finish) => {
    finish(new Error('timed out'), 'Memory (KiB): partial snapshot', 'TCP query interrupted');
  });

  await expect(createWindowsResourceReporter()()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith(
    'Windows resource snapshot:\nMemory (KiB): partial snapshot\nTCP query interrupted\nSnapshot incomplete: timed out',
  );
});

it('does not turn a process startup failure into another test failure', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  execFileMock.mockImplementation(() => {
    throw new Error('unable to spawn');
  });

  await expect(createWindowsResourceReporter()()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith(
    'Windows resource snapshot:\nSnapshot incomplete: unable to spawn',
  );
});
