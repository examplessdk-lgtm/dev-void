import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vite-plus/test';
import { note } from '../../src/cli/output.ts';

function renderNote(columns: number): Array<string> {
  let text = '';
  const output = {
    columns,
    write(chunk: string) {
      text += chunk;
      return true;
    },
  } as unknown as Writable;
  note('Disable all platform traffic.\nNever delete the zone.', 'Uninstall plan', { output });
  return stripVTControlCharacters(text).trimEnd().split('\n');
}

it('draws a note at the default width when the terminal reports zero columns', () => {
  const lines = renderNote(0);
  expect(lines[0]).toContain('Uninstall plan');
  expect(lines.join('\n')).toContain('Disable all platform traffic.');
  expect(lines.at(-1)).toMatch(/^╰─+╯$/);
});

it('draws a note in a terminal narrower than the box', () => {
  const lines = renderNote(2);
  expect(lines[0]).toMatch(/^╭.*╮$/);
  expect(lines.at(-1)).toMatch(/^╰─+╯$/);
});
