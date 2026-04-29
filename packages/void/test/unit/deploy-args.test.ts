import { describe, expect, it } from 'vitest';
import { parseDeployArgs } from '../../src/cli/args.ts';

describe('parseDeployArgs', () => {
  it('parses --project slug', () => {
    expect(parseDeployArgs(['--project', 'my-app'])).toEqual({
      projectSlug: 'my-app',
      dir: undefined,
      spa: undefined,
      skipBuild: undefined,
    });
  });

  it('returns empty args when no options are provided', () => {
    expect(parseDeployArgs([])).toEqual({
      projectSlug: undefined,
      dir: undefined,
      spa: undefined,
      skipBuild: undefined,
    });
  });

  it('parses --dir flag', () => {
    const result = parseDeployArgs(['--dir', 'public']);
    expect(result.dir).toBe('public');
  });

  it('parses --spa flag', () => {
    const result = parseDeployArgs(['--spa']);
    expect(result.spa).toBe(true);
  });

  it('parses --dir and --spa together', () => {
    const result = parseDeployArgs(['--dir', 'dist', '--spa']);
    expect(result.dir).toBe('dist');
    expect(result.spa).toBe(true);
  });

  it('parses --skip-build flag', () => {
    const result = parseDeployArgs(['--skip-build']);
    expect(result.skipBuild).toBe(true);
  });

  it('parses --skip-build with --project', () => {
    const result = parseDeployArgs(['--project', 'my-app', '--skip-build']);
    expect(result.projectSlug).toBe('my-app');
    expect(result.skipBuild).toBe(true);
  });

  it('parses all flags together', () => {
    const result = parseDeployArgs([
      '--project',
      'my-app',
      '--dir',
      'dist',
      '--spa',
      '--skip-build',
    ]);
    expect(result.projectSlug).toBe('my-app');
    expect(result.dir).toBe('dist');
    expect(result.spa).toBe(true);
    expect(result.skipBuild).toBe(true);
  });

  it('throws when --project has no value', () => {
    expect(() => parseDeployArgs(['--project'])).toThrow('deploy: --project requires a slug.');
  });

  it('throws when --project value looks like another flag', () => {
    expect(() => parseDeployArgs(['--project', '--foo'])).toThrow(
      'deploy: --project requires a slug.',
    );
  });

  it('throws for duplicate --project flags', () => {
    expect(() => parseDeployArgs(['--project', 'a', '--project', 'b'])).toThrow(
      'deploy: --project can only be specified once.',
    );
  });

  it('throws for unknown options', () => {
    expect(() => parseDeployArgs(['--foo'])).toThrow("deploy: Unknown option '--foo'.");
  });

  it('throws for unexpected positional arguments', () => {
    expect(() => parseDeployArgs(['my-app'])).toThrow("deploy: Unexpected argument 'my-app'.");
  });
});
