import { describe, expect, it } from 'vite-plus/test';
import { parseDbArgs } from '../../src/cli/db-args.ts';

describe('parseDbArgs', () => {
  it('parses status', () => {
    expect(parseDbArgs(['status'])).toEqual({ action: 'status' });
  });

  it('parses reset', () => {
    expect(parseDbArgs(['reset'])).toEqual({ action: 'reset' });
  });

  it('parses seed', () => {
    expect(parseDbArgs(['seed'])).toEqual({ action: 'seed', file: undefined });
  });

  it('parses seed with --file', () => {
    expect(parseDbArgs(['seed', '--file', 'custom.sql'])).toEqual({
      action: 'seed',
      file: 'custom.sql',
    });
  });

  it('parses execute with inline SQL', () => {
    expect(parseDbArgs(['execute', 'SELECT * FROM users'])).toEqual({
      action: 'execute',
      command: 'SELECT * FROM users',
      file: undefined,
      remote: undefined,
    });
  });

  it('parses execute with --file', () => {
    expect(parseDbArgs(['execute', '--file', 'query.sql'])).toEqual({
      action: 'execute',
      command: undefined,
      file: 'query.sql',
      remote: undefined,
    });
  });

  it('parses execute with --remote flag', () => {
    expect(parseDbArgs(['execute', 'SELECT 1', '--remote'])).toEqual({
      action: 'execute',
      command: 'SELECT 1',
      file: undefined,
      remote: true,
    });
  });

  it('errors on execute with no SQL and no --file', () => {
    expect(() => parseDbArgs(['execute'])).toThrow(
      'db: Usage: void db execute <sql> or void db execute --file <path>.',
    );
  });

  it('errors on execute with both SQL and --file', () => {
    expect(() => parseDbArgs(['execute', 'SELECT 1', '--file', 'query.sql'])).toThrow(
      'db: Provide either SQL inline or --file, not both.',
    );
  });

  it('parses migrate', () => {
    expect(parseDbArgs(['migrate'])).toEqual({ action: 'migrate' });
  });

  it('errors on migrate with extra positional', () => {
    expect(() => parseDbArgs(['migrate', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses push', () => {
    expect(parseDbArgs(['push'])).toEqual({ action: 'push' });
  });

  it('errors on push with extra positional', () => {
    expect(() => parseDbArgs(['push', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses generate', () => {
    expect(parseDbArgs(['generate'])).toEqual({ action: 'generate' });
  });

  it('errors on generate with extra positional', () => {
    expect(() => parseDbArgs(['generate', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses export with no flags', () => {
    expect(parseDbArgs(['export'])).toEqual({
      action: 'export',
      output: undefined,
      noData: undefined,
      noSchema: undefined,
      table: undefined,
    });
  });

  it('parses export with --no-schema', () => {
    expect(parseDbArgs(['export', '--no-schema'])).toEqual({
      action: 'export',
      output: undefined,
      noData: undefined,
      noSchema: true,
      table: undefined,
    });
  });

  it('parses export with all flags', () => {
    expect(
      parseDbArgs(['export', '--output', 'dump.sql', '--no-data', '--table', 'users']),
    ).toEqual({
      action: 'export',
      output: 'dump.sql',
      noData: true,
      noSchema: undefined,
      table: 'users',
    });
  });

  it('errors on export with extra positional', () => {
    expect(() => parseDbArgs(['export', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('errors on export with --remote (not yet supported — must not silently fall through to local export)', () => {
    expect(() => parseDbArgs(['export', '--remote'])).toThrow(
      '`void db export --remote` is not yet supported. Local export only for now.',
    );
  });

  it('parses studio', () => {
    expect(parseDbArgs(['studio'])).toEqual({ action: 'studio', remote: undefined });
  });

  it('parses studio with --remote flag', () => {
    expect(parseDbArgs(['studio', '--remote'])).toEqual({ action: 'studio', remote: true });
  });

  it('errors on studio with extra positional', () => {
    expect(() => parseDbArgs(['studio', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses a direct database connection', () => {
    expect(parseDbArgs(['connect', 'postgresql://localhost/app', '--local-only'])).toEqual({
      action: 'connect',
      url: 'postgresql://localhost/app',
      provider: undefined,
      name: undefined,
      region: undefined,
      localOnly: true,
    });
  });

  it('parses provider provisioning options', () => {
    expect(
      parseDbArgs([
        'connect',
        '--provider',
        'neon',
        '--name',
        'my-app',
        '--region',
        'aws-us-east-1',
      ]),
    ).toEqual({
      action: 'connect',
      url: undefined,
      provider: 'neon',
      name: 'my-app',
      region: 'aws-us-east-1',
      localOnly: undefined,
    });
  });

  it('rejects a URL combined with a provider', () => {
    expect(() =>
      parseDbArgs(['connect', 'postgresql://localhost/app', '--provider', 'neon']),
    ).toThrow('Provide either a connection string or --provider');
  });

  it('errors on unknown subcommand', () => {
    expect(() => parseDbArgs(['unknown'])).toThrow(
      'db: Usage: void db <push|generate|status|reset|seed|execute|migrate|studio|export|connect|set-url|rename-migrations>.',
    );
  });

  it('errors on extra positional', () => {
    expect(() => parseDbArgs(['status', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });
});
