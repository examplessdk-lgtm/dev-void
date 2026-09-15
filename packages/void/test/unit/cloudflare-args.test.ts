import { describe, expect, it } from 'vite-plus/test';
import { parseCloudflareArgs } from '../../src/cli/cloudflare-args.ts';

describe('parseCloudflareArgs', () => {
  it.each(['login', 'status', 'logout'] as const)('parses %s', (subcommand) => {
    expect(parseCloudflareArgs([subcommand])).toEqual({ subcommand });
  });

  it('rejects missing, unknown, and extra arguments', () => {
    expect(() => parseCloudflareArgs([])).toThrow('void cloudflare');
    expect(() => parseCloudflareArgs(['whoami'])).toThrow('void cloudflare');
    expect(() => parseCloudflareArgs(['login', 'extra'])).toThrow('Unexpected argument');
  });
});
