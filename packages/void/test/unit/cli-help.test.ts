import { describe, expect, it, vi } from 'vite-plus/test';
import { parseEmailArgs } from '../../src/cli/email-args.ts';
import { getHelpPath, hasHelpPage, printHelpPage } from '../../src/cli/help.ts';

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

  it('resolves github command help requests', () => {
    expect(getHelpPath(['help', 'github'])).toEqual(['github']);
    expect(getHelpPath(['github', '--help'])).toEqual(['github']);
    expect(getHelpPath(['github', '-h'])).toEqual(['github']);
  });

  it('resolves github subcommand help requests', () => {
    expect(getHelpPath(['help', 'github', 'install'])).toEqual(['github', 'install']);
    expect(getHelpPath(['help', 'github', 'installations'])).toEqual(['github', 'installations']);
    expect(getHelpPath(['help', 'github', 'connect'])).toEqual(['github', 'connect']);
    expect(getHelpPath(['github', 'connect', '--help'])).toEqual(['github', 'connect']);
    expect(getHelpPath(['github', 'status', '--help'])).toEqual(['github', 'status']);
  });

  it('tracks known github help pages', () => {
    expect(hasHelpPage(['github'])).toBe(true);
    expect(hasHelpPage(['github', 'install'])).toBe(true);
    expect(hasHelpPage(['github', 'installations'])).toBe(true);
    expect(hasHelpPage(['github', 'connect'])).toBe(true);
    expect(hasHelpPage(['github', 'status'])).toBe(true);
    expect(hasHelpPage(['github', 'disconnect'])).toBe(true);
    expect(hasHelpPage(['github', 'missing'])).toBe(false);
  });
});

describe('rendered help advertises the flags the parser honours', () => {
  /** The page as printed, ANSI stripped, so an assertion reads like the terminal. */
  function render(path: Array<string>): string {
    const lines: Array<string> = [];
    // The page renders through clack's `note`, which writes to stdout, not
    // through console.log.
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      printHelpPage(path);
    } finally {
      spy.mockRestore();
    }
    // eslint-disable-next-line no-control-regex
    return lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  }

  // `void email logs --limit <n>` is parsed, honoured, and documented in the
  // CLI reference, but the help page was built with the shared project-only
  // helper, so the flag was invisible in every help surface. Nothing asserted
  // rendered help content before, so nothing would have caught it.
  it('shows --limit on `email logs`, which is the only email flag that does anything', () => {
    expect(parseEmailArgs(['logs', '--limit', '7'])).toMatchObject({
      subcommand: 'logs',
      limit: 7,
    });

    const page = render(['email', 'logs']);

    expect(page).toContain('--limit <n>');
    expect(page).toContain('--project <name>');
  });

  it('still shows --project on the email subcommands that take only that', () => {
    for (const sub of ['usage', 'destinations', 'allow', 'disallow']) {
      const page = render(['email', sub]);
      expect(page).toContain('--project <name>');
      expect(page).not.toContain('--limit');
    }
  });
});
