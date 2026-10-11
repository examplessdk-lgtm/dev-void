import { describe, expect, it } from 'vite-plus/test';
import { parseEmailArgs } from '../../src/cli/email-args.ts';

describe('parseEmailArgs', () => {
  it('parses usage', () => {
    expect(parseEmailArgs(['usage'])).toEqual({
      subcommand: 'usage',
      projectSlug: undefined,
      limit: undefined,
      address: undefined,
    });
  });

  it('parses logs with --limit', () => {
    expect(parseEmailArgs(['logs', '--limit', '50'])).toEqual({
      subcommand: 'logs',
      projectSlug: undefined,
      limit: 50,
      address: undefined,
    });
  });

  it('parses destinations with --project', () => {
    expect(parseEmailArgs(['destinations', '--project', 'my-app'])).toEqual({
      subcommand: 'destinations',
      projectSlug: 'my-app',
      limit: undefined,
      address: undefined,
    });
  });

  it('parses allow with address and --project', () => {
    expect(parseEmailArgs(['allow', 'user@example.com', '--project', 'my-app'])).toEqual({
      subcommand: 'allow',
      projectSlug: 'my-app',
      limit: undefined,
      address: 'user@example.com',
    });
  });

  it('parses disallow with address', () => {
    expect(parseEmailArgs(['disallow', 'user@example.com'])).toEqual({
      subcommand: 'disallow',
      projectSlug: undefined,
      limit: undefined,
      address: 'user@example.com',
    });
  });

  it('errors on missing subcommand', () => {
    expect(() => parseEmailArgs([])).toThrow(/email: Usage:/);
  });

  it('errors on unknown subcommand', () => {
    expect(() => parseEmailArgs(['nope'])).toThrow(/email: Usage:/);
  });

  it('errors when allow is missing the address', () => {
    expect(() => parseEmailArgs(['allow'])).toThrow(/void email allow <address>/);
  });

  it('errors when disallow is missing the address', () => {
    expect(() => parseEmailArgs(['disallow'])).toThrow(/void email disallow <address>/);
  });

  it('errors on non-numeric --limit', () => {
    expect(() => parseEmailArgs(['logs', '--limit', 'abc'])).toThrow(
      /--limit must be a positive integer/,
    );
  });

  it('errors on zero --limit', () => {
    expect(() => parseEmailArgs(['logs', '--limit', '0'])).toThrow(
      /--limit must be a positive integer/,
    );
  });

  it('errors when allow receives more than one positional argument', () => {
    // Previously the second address was silently dropped — confusing UX
    // for users who typed `void email allow a@x.dev b@y.dev` and didn't
    // realize only the first took effect.
    expect(() => parseEmailArgs(['allow', 'a@x.dev', 'b@y.dev'])).toThrow(
      /takes exactly one positional argument/,
    );
  });

  it('errors when disallow receives more than one positional argument', () => {
    expect(() => parseEmailArgs(['disallow', 'a@x.dev', 'b@y.dev'])).toThrow(
      /takes exactly one positional argument/,
    );
  });

  // Mode B (design doc 0078): `status` and `setup` take `--platform cloudflare` and
  // read the local project, never a Void project.
  it('parses status and setup with --platform cloudflare (space and = forms)', () => {
    expect(parseEmailArgs(['status', '--platform', 'cloudflare'])).toEqual({
      subcommand: 'status',
      projectSlug: undefined,
      limit: undefined,
      address: undefined,
      platform: 'cloudflare',
    });
    expect(parseEmailArgs(['setup', '--platform=cloudflare'])).toEqual({
      subcommand: 'setup',
      projectSlug: undefined,
      limit: undefined,
      address: undefined,
      platform: 'cloudflare',
    });
  });

  it('parses --platform void as the platform shape (the "not available yet" exit for setup/status)', () => {
    expect(parseEmailArgs(['setup', '--platform', 'void'])).toEqual({
      subcommand: 'setup',
      projectSlug: undefined,
      limit: undefined,
      address: undefined,
      platform: 'void',
    });
    expect(parseEmailArgs(['status', '--platform=void']).platform).toBe('void');
    // The platform-only subcommands are the platform already, so naming it is a no-op
    // there — unlike `cloudflare`, which they reject.
    expect(parseEmailArgs(['usage', '--platform', 'void', '--project', 'my-app'])).toMatchObject({
      subcommand: 'usage',
      projectSlug: 'my-app',
      platform: 'void',
    });
  });

  it('parses status and setup without a platform (the platform shape)', () => {
    expect(parseEmailArgs(['status'])).toMatchObject({ subcommand: 'status' });
    expect(parseEmailArgs(['status']).platform).toBeUndefined();
    expect(parseEmailArgs(['setup', '--project', 'my-app'])).toMatchObject({
      subcommand: 'setup',
      projectSlug: 'my-app',
    });
  });

  it('errors on --platform without a value or with another value', () => {
    expect(() => parseEmailArgs(['setup', '--platform'])).toThrow(
      "email: --platform requires a value ('cloudflare' or 'void').",
    );
    expect(() => parseEmailArgs(['setup', '--platform', '--limit', '3'])).toThrow(
      /--platform requires a value/,
    );
    expect(() => parseEmailArgs(['setup', '--platform=', 'cloudflare'])).toThrow(
      "email: --platform must be 'cloudflare' or 'void'.",
    );
    expect(() => parseEmailArgs(['setup', '--platform', 'vercel'])).toThrow(
      "email: --platform must be 'cloudflare' or 'void'.",
    );
  });

  // `--project` and `--limit` take the same missing-value path as `--platform`. A bare
  // flag used to fall through as a positional, which the read-only subcommands never
  // reject: `void email usage --project` silently ran against the linked project and
  // `void email logs --limit` silently ignored the limit.
  it('errors on --project without a value', () => {
    expect(() => parseEmailArgs(['usage', '--project'])).toThrow(
      'email: --project requires a value (a project name).',
    );
    // A value that starts with `-` is the next flag, not a project name — previously
    // `--limit` became the slug and `5` the positional.
    expect(() => parseEmailArgs(['usage', '--project', '--limit', '5'])).toThrow(
      'email: --project requires a value (a project name).',
    );
    expect(() => parseEmailArgs(['destinations', '--project'])).toThrow(
      /--project requires a value/,
    );
  });

  // An empty slug is not nullish: `runEmailCommand` used to keep `''` over `VOID_PROJECT`
  // and then fall through to the linked project, so `--project=` (or `--project "$VAR"`
  // with the variable unset) silently mutated the linked project's allowlist.
  it('errors on --project with an empty or whitespace-only value, same message as a bare flag', () => {
    const message = 'email: --project requires a value (a project name).';
    expect(() => parseEmailArgs(['disallow', 'a@x.dev', '--project='])).toThrow(message);
    expect(() => parseEmailArgs(['disallow', 'a@x.dev', '--project', ''])).toThrow(message);
    expect(() => parseEmailArgs(['disallow', 'a@x.dev', '--project', '   '])).toThrow(message);
    expect(() => parseEmailArgs(['allow', 'a@x.dev', '--project=  '])).toThrow(message);
  });

  // Same rule as `void deploy` and this file's `--platform`: the last value never wins,
  // so a wrapper's override and a caller's cannot silently disagree about the target.
  it('errors when --project is repeated, even if the final value is valid', () => {
    const message = 'email: --project can only be specified once.';
    expect(() =>
      parseEmailArgs(['disallow', 'a@x.dev', '--project', 'a', '--project', 'b']),
    ).toThrow(message);
    expect(() => parseEmailArgs(['allow', 'a@x.dev', '--project=a', '--project=a'])).toThrow(
      message,
    );
    expect(() => parseEmailArgs(['destinations', '--project', 'a', '--project=b'])).toThrow(
      message,
    );
  });

  // The parser is shared, so the read-only subcommands reject the same shapes — they are
  // exactly the ones that never validate a positional and used to run against the wrong
  // project without a word.
  it('rejects an empty or repeated --project on the read-only subcommands too', () => {
    for (const sub of ['usage', 'logs']) {
      expect(() => parseEmailArgs([sub, '--project='])).toThrow(
        'email: --project requires a value (a project name).',
      );
      expect(() => parseEmailArgs([sub, '--project', 'a', '--project', 'b'])).toThrow(
        'email: --project can only be specified once.',
      );
    }
    // A single, non-empty value is still accepted as before.
    expect(parseEmailArgs(['usage', '--project', 'x'])).toMatchObject({
      subcommand: 'usage',
      projectSlug: 'x',
    });
    expect(parseEmailArgs(['logs', '--limit', '3', '--project=x'])).toMatchObject({
      subcommand: 'logs',
      projectSlug: 'x',
      limit: 3,
    });
  });

  it('errors on --limit without a value', () => {
    expect(() => parseEmailArgs(['logs', '--limit'])).toThrow(
      'email: --limit requires a value (a positive integer).',
    );
    expect(() => parseEmailArgs(['logs', '--limit', '--project', 'my-app'])).toThrow(
      'email: --limit requires a value (a positive integer).',
    );
    // The value check still applies once a value is present.
    expect(() => parseEmailArgs(['logs', '--limit=abc'])).toThrow(
      /--limit must be a positive integer \(got 'abc'\)/,
    );
  });

  it('parses --project=<name> and --limit=<n> (the = form --platform already takes)', () => {
    expect(parseEmailArgs(['usage', '--project=foo'])).toEqual({
      subcommand: 'usage',
      projectSlug: 'foo',
      limit: undefined,
      address: undefined,
      platform: undefined,
    });
    expect(parseEmailArgs(['logs', '--limit=5'])).toEqual({
      subcommand: 'logs',
      projectSlug: undefined,
      limit: 5,
      address: undefined,
      platform: undefined,
    });
  });

  it('still carries an unrelated stray positional on a read-only subcommand', () => {
    // Positional validation is unchanged: only allow/disallow require one, and only a
    // second one is rejected. A stray word is still parsed as `address` and left to the
    // command, exactly as before.
    expect(parseEmailArgs(['usage', 'stray'])).toMatchObject({
      subcommand: 'usage',
      address: 'stray',
      projectSlug: undefined,
    });
  });

  it('errors when --platform is repeated, even if the final value is valid', () => {
    expect(() =>
      parseEmailArgs(['setup', '--platform', 'cloudflare', '--platform', 'cloudflare']),
    ).toThrow('email: --platform can only be specified once.');
    expect(() => parseEmailArgs(['setup', '--platform', 'other', '--platform', 'void'])).toThrow(
      'email: --platform can only be specified once.',
    );
  });

  it('rejects --platform cloudflare on the platform-only subcommands', () => {
    for (const sub of ['usage', 'logs', 'destinations']) {
      expect(() => parseEmailArgs([sub, '--platform', 'cloudflare'])).toThrow(
        /--platform cloudflare applies to `void email status` and `void email setup` only/,
      );
    }
    expect(() => parseEmailArgs(['allow', 'a@x.dev', '--platform', 'cloudflare'])).toThrow(
      /applies to `void email status` and `void email setup` only/,
    );
  });

  it('rejects --project and a positional argument with --platform cloudflare', () => {
    expect(() => parseEmailArgs(['setup', '--platform', 'cloudflare', '--project', 'x'])).toThrow(
      /--project cannot be combined with --platform cloudflare/,
    );
    expect(() => parseEmailArgs(['status', 'acme.com', '--platform', 'cloudflare'])).toThrow(
      /`void email status --platform cloudflare` takes no argument/,
    );
  });
  it.each([
    ['status'],
    ['setup'],
    ['usage'],
    ['logs'],
    ['destinations'],
    ['allow', 'a@x.dev'],
    ['disallow', 'a@x.dev'],
    ['domain', 'add', 'acme.com', '--project', 'my-app'],
    ['domain', 'list'],
  ])('rejects the removed alias before invoking %j', (...command) => {
    for (const flags of [['--backend'], ['--backend', 'cloudflare'], ['--backend=cloudflare']]) {
      expect(() => parseEmailArgs([...command, ...flags])).toThrow(
        "email: Unknown option '--backend'.",
      );
    }
  });
});
