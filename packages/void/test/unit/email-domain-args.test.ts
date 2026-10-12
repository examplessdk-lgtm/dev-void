import { describe, expect, it } from 'vite-plus/test';
import { parseEmailArgs } from '../../src/cli/email-args.ts';

/**
 * The nested `void email domain <verb>` group. `runSubcommandGroup` handles one level,
 * so the group parses its own positionals: verb first, domain second.
 */
describe('parseEmailArgs — domain group', () => {
  it('parses domain add with a domain', () => {
    expect(parseEmailArgs(['domain', 'add', 'acme.com'])).toEqual({
      subcommand: 'domain',
      domainVerb: 'add',
      domain: 'acme.com',
      projectSlug: undefined,
      limit: undefined,
      platform: undefined,
    });
  });

  it('parses status, sync and remove with a domain, and list without one', () => {
    for (const verb of ['status', 'sync', 'remove'] as const) {
      expect(parseEmailArgs(['domain', verb, 'mail.acme.com'])).toMatchObject({
        subcommand: 'domain',
        domainVerb: verb,
        domain: 'mail.acme.com',
      });
    }
    expect(parseEmailArgs(['domain', 'list'])).toMatchObject({
      subcommand: 'domain',
      domainVerb: 'list',
      domain: undefined,
    });
  });

  it('parses --project on every domain verb', () => {
    expect(parseEmailArgs(['domain', 'add', 'acme.com', '--project', 'my-app'])).toMatchObject({
      domainVerb: 'add',
      domain: 'acme.com',
      projectSlug: 'my-app',
    });
    expect(parseEmailArgs(['domain', 'list', '--project=my-app'])).toMatchObject({
      domainVerb: 'list',
      projectSlug: 'my-app',
    });
  });

  it('parses --subdomain on domain add (space and = forms)', () => {
    expect(parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain', 'mx'])).toMatchObject({
      domainVerb: 'add',
      domain: 'acme.com',
      subdomain: 'mx',
    });
    expect(
      parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain=mail.acme.com']),
    ).toMatchObject({
      domainVerb: 'add',
      domain: 'acme.com',
      subdomain: 'mail.acme.com',
    });
  });

  it('errors on a missing or unknown domain verb', () => {
    expect(() => parseEmailArgs(['domain'])).toThrow(
      'email: Usage: void email domain <add|status|list|sync|rotate-secret|remove> [<domain>] [--project <name>].',
    );
    expect(() => parseEmailArgs(['domain', 'frobnicate', 'acme.com'])).toThrow(
      /Usage: void email domain/,
    );
  });

  it('errors when a domain verb is missing its domain', () => {
    for (const verb of ['add', 'status', 'sync', 'rotate-secret', 'remove']) {
      expect(() => parseEmailArgs(['domain', verb])).toThrow(
        `email: Usage: void email domain ${verb} <domain> [--project <name>].`,
      );
    }
  });

  it('errors when domain list receives a domain', () => {
    expect(() => parseEmailArgs(['domain', 'list', 'acme.com'])).toThrow(
      'email: `void email domain list` takes no domain argument.',
    );
  });

  it('errors on extra positionals, naming them like the allow rule does', () => {
    expect(() => parseEmailArgs(['domain', 'add', 'a.com', 'b.com'])).toThrow(
      /`void email domain add` takes exactly one domain argument \(got 2: "a.com", "b.com"\)/,
    );
    expect(() => parseEmailArgs(['domain', 'status', 'a.com', 'b.com', 'c.com'])).toThrow(
      /takes exactly one domain argument \(got 3/,
    );
  });

  it('rejects --subdomain on the other domain verbs and on non-domain subcommands', () => {
    for (const args of [
      ['domain', 'status', 'acme.com', '--subdomain', 'mx'],
      ['domain', 'list', '--subdomain=mx'],
      ['domain', 'remove', 'acme.com', '--subdomain', 'mx'],
      ['setup', '--platform', 'cloudflare', '--subdomain', 'mail'],
    ]) {
      expect(() => parseEmailArgs(args)).toThrow(
        'email: --subdomain applies to `void email domain add` only.',
      );
    }
    expect(() => parseEmailArgs(['usage', '--subdomain', 'mx'])).toThrow(
      'email: --subdomain applies to `void email domain add` only.',
    );
    expect(() => parseEmailArgs(['allow', 'a@x.dev', '--subdomain', 'mx'])).toThrow(
      'email: --subdomain applies to `void email domain add` only.',
    );
  });

  it('rejects --subdomain without a value, with an empty value, or repeated', () => {
    expect(() => parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain'])).toThrow(
      'email: --subdomain requires a value (a subdomain label or host).',
    );
    expect(() =>
      parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain', '--project', 'x']),
    ).toThrow(/--subdomain requires a value/);
    expect(() => parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain='])).toThrow(
      /--subdomain requires a value/,
    );
    expect(() =>
      parseEmailArgs(['domain', 'add', 'acme.com', '--subdomain', 'mx', '--subdomain', 'mg']),
    ).toThrow('email: --subdomain can only be specified once.');
  });

  it('rejects --platform cloudflare on the domain group, accepts --platform void', () => {
    expect(() => parseEmailArgs(['domain', 'add', 'acme.com', '--platform', 'cloudflare'])).toThrow(
      'email: --platform cloudflare applies to `void email status` and `void email setup` only (`domain` is a Void platform command).',
    );
    expect(parseEmailArgs(['domain', 'list', '--platform', 'void'])).toMatchObject({
      domainVerb: 'list',
      platform: 'void',
    });
  });
});
