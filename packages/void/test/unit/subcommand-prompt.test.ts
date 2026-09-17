import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE, S_STEP_ACTIVE } from '@clack/prompts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { promptSubcommand, type SubcommandDef } from '../../src/cli/subcommand-prompt.ts';

vi.mock('../../src/cli/output.ts', async () => {
  const { default: colors } = await import('picocolors');
  return { pc: colors.createColors(true) };
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

function openPrompt(commands: Array<SubcommandDef>, columns = 80, rows = 24) {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
  const writes: Array<string> = [];
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
    }),
    { columns, rows },
  );
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);
  const result = promptSubcommand('', commands);
  const key = (value: string) => input.emit('data', Buffer.from(value));
  cleanup = async () => {
    key('\x03');
    await result;
    input.destroy();
    output.destroy();
  };
  return {
    key,
    result,
    writes,
    input,
    output,
    frame: () =>
      writes
        .map(stripVTControlCharacters)
        .reverse()
        .find((text) => text.startsWith(S_STEP_ACTIVE))!,
  };
}

it.each([
  [80, 24],
  [40, 12],
  [20, 8],
])(
  'limits the inline menu to seven single-line options at %i columns and %i rows',
  async (columns, rows) => {
    const commands = Array.from({ length: 17 }, (_, i) => ({
      name: `command-${i}`,
      description: 'Manage projects and deployments with the selected command',
      hint: 'status | link | list | logs | requests | rollback | cancel | delete | purge-cache',
    }));
    const prompt = openPrompt(commands, columns, rows);
    for (const command of commands) {
      const frame = prompt.frame();
      const lines = frame.trimEnd().split('\n');
      expect(
        lines.filter((line) => line.includes(S_RADIO_ACTIVE) || line.includes(S_RADIO_INACTIVE))
          .length,
      ).toBeLessThanOrEqual(7);
      expect(lines.length).toBeLessThan(rows);
      expect(lines.every((line) => line.length < columns)).toBe(true);
      expect(frame).toContain(`${S_RADIO_ACTIVE} ${command.name}`);
      prompt.key('\x1B[B');
    }
    expect(prompt.frame()).toContain(`${S_RADIO_ACTIVE} command-0`);
    prompt.key('\x1B[A');
    expect(prompt.frame()).toContain(`${S_RADIO_ACTIVE} command-16`);
    prompt.key('\x1B');
    expect(await prompt.result).toBeNull();
    expect(prompt.writes.join('')).not.toContain('\x1B[?1049');
    expect(prompt.writes.join('')).not.toContain('\x1B[2J');
    expect(prompt.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(prompt.output.listenerCount('resize')).toBe(0);
  },
);

it('shows the end of long input while submitting the complete value', async () => {
  const prompt = openPrompt(
    [{ name: 'connect', description: 'Connect to a platform', arg: '<url>' }],
    40,
    12,
  );
  const url = `https://${'long-platform-name-'.repeat(20)}example.com`;
  prompt.key(url);
  expect(prompt.frame()).toContain('example.com');
  prompt.key('\r');
  expect(await prompt.result).toEqual({ subcommand: 'connect', arg: url });
});

it('bounds repeat-input history while retaining every submitted entry', async () => {
  const prompt = openPrompt(
    [
      {
        name: 'allow',
        description: 'Allow domains',
        followUp: { type: 'repeat-input', placeholder: 'example.com' },
      },
    ],
    40,
    12,
  );
  prompt.key('\r');
  const entries = Array.from({ length: 20 }, (_, i) => `domain-${i}.example.com`);
  for (const entry of entries) {
    prompt.key(entry);
    prompt.key('\r');
    expect(prompt.frame().trimEnd().split('\n').length).toBeLessThan(12);
  }
  prompt.key('\r');
  expect(await prompt.result).toEqual({ subcommand: 'allow', arg: undefined, extraArgs: entries });
});
