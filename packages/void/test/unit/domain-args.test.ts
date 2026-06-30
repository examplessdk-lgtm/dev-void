import { describe, expect, it } from 'vite-plus/test';
import { parseDomainArgs } from '../../src/cli/domain-args.ts';

describe('parseDomainArgs', () => {
  it('parses a hostname positional', () => {
    expect(parseDomainArgs(['add', 'example.com'])).toEqual({
      subcommand: 'add',
      hostname: 'example.com',
      projectSlug: undefined,
      verbose: false,
    });
  });

  it('parses --project and --verbose', () => {
    expect(parseDomainArgs(['status', 'example.com', '--project', 'my-app', '--verbose'])).toEqual({
      subcommand: 'status',
      hostname: 'example.com',
      projectSlug: 'my-app',
      verbose: true,
    });
  });

  it('rejects an unknown flag instead of capturing it as the hostname', () => {
    expect(() => parseDomainArgs(['add', '--foo', 'example.com'])).toThrow(
      "domain: Unknown flag '--foo'.",
    );
  });

  it('rejects an unknown flag even when a hostname is already present', () => {
    expect(() => parseDomainArgs(['status', 'example.com', '--foo'])).toThrow(
      "domain: Unknown flag '--foo'.",
    );
  });
});
