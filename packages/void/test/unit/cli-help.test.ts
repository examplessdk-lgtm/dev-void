import { describe, expect, it } from 'vitest';
import { getHelpPath, hasHelpPage } from '../../src/cli/help.ts';

describe('CLI help resolver', () => {
  it('resolves top-level help requests', () => {
    expect(getHelpPath(['help'])).toEqual([]);
    expect(getHelpPath(['--help'])).toEqual([]);
    expect(getHelpPath(['-h'])).toEqual([]);
  });

  it('resolves command help requests', () => {
    expect(getHelpPath(['help', 'deploy'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', '--help'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', '-h'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', '--project', 'my-app', '--help'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', 'my-app', '--help'])).toEqual(['deploy']);
  });

  it('resolves grouped subcommand help requests', () => {
    expect(getHelpPath(['help', 'db', 'execute'])).toEqual(['db', 'execute']);
    expect(getHelpPath(['db', 'help', 'execute'])).toEqual(['db', 'execute']);
    expect(getHelpPath(['db', 'execute', '--help'])).toEqual(['db', 'execute']);
    expect(getHelpPath(['db', 'execute', '--file', 'query.sql', '--help'])).toEqual([
      'db',
      'execute',
    ]);
    expect(getHelpPath(['db', 'execute', 'select 1', '--help'])).toEqual(['db', 'execute']);
  });

  it('preserves unknown grouped subcommands in help requests', () => {
    expect(getHelpPath(['help', 'db', 'stats'])).toEqual(['db', 'stats']);
    expect(getHelpPath(['db', 'stats', '--help'])).toEqual(['db', 'stats']);
    expect(getHelpPath(['project', 'missing', '--help'])).toEqual(['project', 'missing']);
  });

  it('returns null when no help was requested', () => {
    expect(getHelpPath([])).toBeNull();
    expect(getHelpPath(['deploy'])).toBeNull();
    expect(getHelpPath(['db', 'status'])).toBeNull();
  });

  it('tracks known and unknown help pages', () => {
    expect(hasHelpPage(['deploy'])).toBe(true);
    expect(hasHelpPage(['db', 'execute'])).toBe(true);
    expect(hasHelpPage(['missing'])).toBe(false);
    expect(hasHelpPage(['db', 'missing'])).toBe(false);
  });
});
