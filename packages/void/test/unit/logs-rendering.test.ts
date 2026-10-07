import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { intro, outro } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runLogsCommand } from '../../src/cli/logs.ts';
import { sanitizeTerminalLogText } from '../../src/cli/terminal-log-text.ts';

const logsFixture = vi.hoisted(() => ({ entries: undefined as Array<unknown> | undefined }));

vi.mock('../../src/cli/auth.ts', () => ({ getToken: () => 'fixture-token' }));
vi.mock('../../src/cli/project.ts', () => ({
  readDeploymentPlatform: () => 'void',
  readProjectConfig: () => ({ projectId: 'fixture-project', slug: 'my-app' }),
}));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    async getLogs() {
      if (logsFixture.entries) {
        return logsFixture.entries;
      }
      return [
        {
          timestamp: 0,
          method: 'POST',
          url: '/api/comments',
          status: '500',
          outcome: 'exception',
          logs: [
            {
              level: 'warn',
              message: ['Cache miss. Refreshing the published page in the background.'],
            },
            {
              level: 'error',
              message: ['Comment could not be saved.\nPlease retry after signing in.'],
            },
          ],
          exceptions: [
            { name: 'Error', message: 'DATABASE_URL is not configured for this deployment.' },
          ],
        },
      ];
    }
  },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  intro: vi.fn(),
  outro: vi.fn(),
}));
vi.mock('../../src/cli/output.ts', async (original) => {
  const { default: colors } = await import('picocolors');
  const pc = colors.createColors(true);
  return {
    ...(await original<typeof import('../../src/cli/output.ts')>()),
    pc,
    dim: pc.dim,
  };
});

afterEach(() => {
  logsFixture.entries = undefined;
  vi.restoreAllMocks();
});

it.each([40, 80])('aligns wrapped log messages and exceptions at %i columns', async (columns) => {
  const output = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { columns },
  );
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as typeof process.stdout);
  const print = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runLogsCommand('/fixture', '', '1h');
  expect(intro).not.toHaveBeenCalled();
  expect(stripVTControlCharacters(vi.mocked(outro).mock.calls.at(-1)![0]!)).toBe('1 log entry');
  const messages = print.mock.calls.map((args) => String(args[0] ?? ''));
  const warn = messages.find((line) => line.includes('[warn]'))!;
  const error = messages.find((line) => line.includes('[error]'))!;
  const exception = messages.find((line) => line.includes('[exception]'))!;
  expect(warn).toContain('\x1b[33m[warn]');
  expect(error).toContain('\x1b[31m[error]');
  expect(exception).toContain('\x1b[31m[exception]');
  expect(error).toContain('\n          Please retry');
  for (const [message, indent] of [
    [warn, 9],
    [error, 10],
    [exception, 14],
  ] as const) {
    const lines = stripVTControlCharacters(message).split('\n');
    expect(lines.every((line) => line.length <= columns)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith(' '.repeat(indent)))).toBe(true);
  }
});

it('drops terminal control sequences from app log text but keeps colors and line breaks', async () => {
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '/search?q=\x1b]52;c;ZXZpbA==\x07',
      status: '500',
      outcome: 'exception',
      logs: [
        {
          level: 'error',
          message: ['a\x1b]52;c;ZXZpbA==\x07b\x1b[2J\rc\n\x1b[31mred\x1b[0m'],
        },
      ],
      exceptions: [
        {
          name: 'Error',
          message: 'see \x1b]8;;https://evil.example\x07click\x1b]8;;\x07 then \u009b2J',
        },
      ],
    },
  ];
  const output = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { columns: 120 },
  );
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as typeof process.stdout);
  const print = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runLogsCommand('/fixture', '', '1h');

  const printed = print.mock.calls.map((args) => String(args[0] ?? '')).join('\n');
  for (const unsafe of ['\x1b]', '\x1b[2J', '\r', '\x07', '\u009b']) {
    expect(printed).not.toContain(unsafe);
  }
  expect(printed).toContain('\x1b[31mred');
  expect(printed).toContain('https://evil.example');
  const error = print.mock.calls
    .map((args) => String(args[0] ?? ''))
    .find((line) => line.includes('[error]'))!;
  expect(stripVTControlCharacters(error).split('\n')).toEqual([
    '  [error] a]52;c;ZXZpbA==b[2Jc',
    '          red',
  ]);
});

it('keeps color codes, newlines and tabs, and drops other control characters', () => {
  expect(sanitizeTerminalLogText('\x1b[1;38;2;255;0;0mbold\x1b[0m\tcol\nnext')).toBe(
    '\x1b[1;38;2;255;0;0mbold\x1b[0m\tcol\nnext',
  );
  expect(sanitizeTerminalLogText('a\x1b]52;c;ZXZpbA==\x07b')).toBe('a]52;c;ZXZpbA==b');
  expect(sanitizeTerminalLogText('x\x1b[2J\x1b[?25l\x1b[1Ay')).toBe('x[2J[?25l[1Ay');
  expect(sanitizeTerminalLogText('over\rwrite')).toBe('overwrite');
  expect(sanitizeTerminalLogText('\u009b2J\u0085\u007f\u0000\u0008end')).toBe('2Jend');
  expect(sanitizeTerminalLogText('plain text, ünïcode ✓')).toBe('plain text, ünïcode ✓');
});
