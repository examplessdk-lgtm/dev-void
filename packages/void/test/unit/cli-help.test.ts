import { note } from '@clack/prompts';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseEmailArgs } from '../../src/cli/email-args.ts';
import { getHelpPath, hasHelpPage, printHelpPage } from '../../src/cli/help.ts';

vi.mock('@clack/prompts', () => ({
  note: vi.fn(),
  outro: vi.fn(),
}));

describe('CLI help resolver', () => {
  beforeEach(() => {
    vi.mocked(note).mockClear();
  });

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
    expect(hasHelpPage(['connect'])).toBe(true);
    expect(hasHelpPage(['platform', 'connect'])).toBe(false);
    expect(getHelpPath(['connect', 'https://platform.example.com', '--help'])).toEqual(['connect']);
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

  it('resolves local resource discovery help and documents JSON output', () => {
    expect(getHelpPath(['info', '--help'])).toEqual(['info']);
    expect(hasHelpPage(['info'])).toBe(true);
    printHelpPage(['info']);
    expect(vi.mocked(note).mock.calls[0]?.[0]).toContain('void info [--json]');
  });

  it('tracks Cloudflare authentication help pages', () => {
    expect(hasHelpPage(['cloudflare'])).toBe(true);
    expect(hasHelpPage(['cloudflare', 'login'])).toBe(true);
    expect(hasHelpPage(['cloudflare', 'status'])).toBe(true);
    expect(hasHelpPage(['cloudflare', 'logout'])).toBe(true);
  });

  it.each(['upgrade', 'repair', 'disable', 'enable'] as const)(
    'prints the correct platform %s usage',
    (command) => {
      printHelpPage(['platform', command]);

      expect(vi.mocked(note).mock.calls[0]?.[0]).toContain(
        `void platform ${command} [id] [--plan]`,
      );
    },
  );
});

describe('rendered help advertises the flags the parser honours', () => {
  it('shows both Git initialization flags on init', () => {
    const page = render(['init']);
    expect(page).toContain('--git');
    expect(page).toContain('--no-git');
  });
  /** The page as handed to clack's `note` (mocked above), ANSI stripped, so an assertion reads like the terminal. */
  function render(path: Array<string>): string {
    vi.mocked(note).mockClear();
    printHelpPage(path);
    const lines = vi.mocked(note).mock.calls.map((call) => String(call[0]));
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

  // Mode B: `status` / `setup` read the local project + wrangler session, never a Void
  // project, so their pages carry `--platform cloudflare` and no `--project`.
  it('shows --platform cloudflare, and no --project, on `email status` and `email setup`', () => {
    for (const sub of ['status', 'setup']) {
      expect(parseEmailArgs([sub, '--platform', 'cloudflare'])).toMatchObject({
        subcommand: sub,
        platform: 'cloudflare',
      });
      const page = render(['email', sub]);
      expect(page).toContain(`void email ${sub} --platform cloudflare`);
      expect(page).toContain('--platform cloudflare');
      expect(page).not.toContain('--backend');
      expect(page).not.toContain('--project');
    }
    const group = render(['email']);
    expect(group).toContain('status --platform cloudflare');
    expect(group).toContain('setup --platform cloudflare');
  });

  // The nested `domain` group is the one email command with its own verbs; the
  // group entry is on the email page, and every verb keeps its own page so the
  // printed `void help email domain <command>` hint actually resolves.
  it('lists `email domain` on the email page and resolves the domain help pages', () => {
    expect(
      parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain', 'mail', '--project', 'acme']),
    ).toMatchObject({
      subcommand: 'domain',
      domainVerb: 'add',
      domain: 'acme.com',
      subdomain: 'mail',
      projectSlug: 'acme',
    });

    const group = render(['email']);
    expect(group).toContain('domain <add|status|list|sync|rotate-secret|remove>');

    expect(hasHelpPage(['email', 'domain'])).toBe(true);
    expect(getHelpPath(['email', 'domain', '--help'])).toEqual(['email', 'domain']);
    const page = render(['email', 'domain']);
    for (const verb of [
      'add <domain>',
      'status <domain>',
      'list',
      'sync <domain>',
      'rotate-secret <domain>',
      'remove <domain>',
    ]) {
      expect(page).toContain(verb);
    }
    expect(page).not.toContain('--subdomain');
    expect(page).toContain('--project <name>');

    for (const verb of ['add', 'status', 'list', 'sync', 'rotate-secret', 'remove']) {
      expect(hasHelpPage(['email', 'domain', verb])).toBe(true);
    }
    expect(render(['email', 'domain', 'add'])).toContain(
      'void email domain add <domain> [options]',
    );
    expect(render(['email', 'domain', 'add'])).not.toContain('--subdomain');
    expect(render(['email', 'domain', 'add'])).toContain('--project <name>');

    const removePage = render(['email', 'domain', 'remove']);
    expect(removePage).not.toContain('--force');
    expect(removePage).toContain('--project <name>');
  });
});
