import { describe, expect, it } from 'vite-plus/test';
import { parseBuildArgs } from '../../src/cli/build-args.ts';

describe('parseBuildArgs', () => {
  it('parses bare logs', () => {
    expect(parseBuildArgs(['logs'])).toEqual({
      subcommand: 'logs',
      buildId: undefined,
      follow: false,
      output: undefined,
      projectName: undefined,
    });
  });

  it('captures a positional build id', () => {
    expect(parseBuildArgs(['logs', 'bld_1']).buildId).toBe('bld_1');
  });

  it('parses -f and --follow', () => {
    expect(parseBuildArgs(['logs', '-f']).follow).toBe(true);
    expect(parseBuildArgs(['logs', '--follow']).follow).toBe(true);
  });

  it('parses -o/--output and -p/--project values', () => {
    const a = parseBuildArgs(['logs', '-o', 'out.log', '-p', 'my-app']);
    expect(a.output).toBe('out.log');
    expect(a.projectName).toBe('my-app');
    const b = parseBuildArgs(['logs', '--output', 'x.log', '--project', 'app2']);
    expect(b.output).toBe('x.log');
    expect(b.projectName).toBe('app2');
  });

  it('parses a full combination', () => {
    expect(parseBuildArgs(['logs', 'bld_9', '-f', '-o', 'f.log', '-p', 'app'])).toEqual({
      subcommand: 'logs',
      buildId: 'bld_9',
      follow: true,
      output: 'f.log',
      projectName: 'app',
    });
  });

  it('throws when --output has no value', () => {
    expect(() => parseBuildArgs(['logs', '-o'])).toThrow('--output requires a value');
  });

  it('throws when --project has no value', () => {
    expect(() => parseBuildArgs(['logs', '--project'])).toThrow('--project requires a value');
  });

  it('throws on an unknown flag', () => {
    expect(() => parseBuildArgs(['logs', '--nope'])).toThrow("Unexpected argument '--nope'");
  });

  it('throws on a second positional', () => {
    expect(() => parseBuildArgs(['logs', 'bld_1', 'bld_2'])).toThrow("Unexpected argument 'bld_2'");
  });

  it('throws on an unknown subcommand', () => {
    expect(() => parseBuildArgs(['bogus'])).toThrow('Usage: void build logs');
  });
});
