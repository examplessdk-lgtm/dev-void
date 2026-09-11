import { describe, expect, it } from 'vite-plus/test';
import { parseDeployArgs } from '../../src/cli/args.ts';

describe('parseDeployArgs', () => {
  it('parses --project slug', () => {
    expect(parseDeployArgs(['--project', 'my-app'])).toEqual({
      projectSlug: 'my-app',
      dir: undefined,
      spa: undefined,
      skipBuild: undefined,
      debug: undefined,
    });
  });

  it('returns empty args when no options are provided', () => {
    expect(parseDeployArgs([])).toEqual({
      projectSlug: undefined,
      dir: undefined,
      spa: undefined,
      skipBuild: undefined,
      debug: undefined,
    });
  });

  it('parses --debug flag', () => {
    const result = parseDeployArgs(['--debug']);
    expect(result.debug).toBe(true);
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

  it('parses --backend cloudflare', () => {
    const result = parseDeployArgs(['--backend', 'cloudflare']);
    expect(result.backend).toBe('cloudflare');
    expect(result.provision).toBeUndefined();
  });

  it('parses --backend cloudflare --provision', () => {
    const result = parseDeployArgs(['--backend', 'cloudflare', '--provision']);
    expect(result.backend).toBe('cloudflare');
    expect(result.provision).toBe(true);
  });

  it('throws when --provision is used without --backend cloudflare', () => {
    expect(() => parseDeployArgs(['--provision'])).toThrow(
      'deploy: --provision requires --backend cloudflare.',
    );
  });

  it('parses --backend cloudflare --require-email', () => {
    const result = parseDeployArgs(['--backend', 'cloudflare', '--require-email']);
    expect(result.backend).toBe('cloudflare');
    expect(result.requireEmail).toBe(true);
  });

  it('leaves requireEmail undefined when --require-email is not given', () => {
    const result = parseDeployArgs(['--backend', 'cloudflare']);
    expect(result.requireEmail).toBeUndefined();
  });

  it('throws when --require-email is used without --backend cloudflare', () => {
    expect(() => parseDeployArgs(['--require-email'])).toThrow(
      'deploy: --require-email requires --backend cloudflare.',
    );
  });

  it('throws for an invalid --backend value', () => {
    expect(() => parseDeployArgs(['--backend', 'node'])).toThrow(
      "deploy: --backend must be 'cloudflare'.",
    );
  });

  it('throws when --backend is repeated even if the final value is cloudflare', () => {
    expect(() => parseDeployArgs(['--backend', 'node', '--backend', 'cloudflare'])).toThrow(
      'deploy: --backend can only be specified once.',
    );
  });

  it('throws for duplicate --backend cloudflare flags', () => {
    expect(() => parseDeployArgs(['--backend', 'cloudflare', '--backend', 'cloudflare'])).toThrow(
      'deploy: --backend can only be specified once.',
    );
  });

  it('throws a backend-specific message when --backend has no value', () => {
    expect(() => parseDeployArgs(['--backend'])).toThrow(
      "deploy: --backend requires a value ('cloudflare').",
    );
  });

  it('parses --backend cloudflare together with --skip-build (rejected later, in deploy)', () => {
    const result = parseDeployArgs(['--backend', 'cloudflare', '--skip-build']);
    expect(result.backend).toBe('cloudflare');
    expect(result.skipBuild).toBe(true);
  });

  // The Cloudflare backend deploys to the user's own account via wrangler — it resolves no
  // Void project and takes no static-site path, so these flags cannot be honored. Accepting
  // and ignoring `--project` in particular looked like it chose a destination.
  it('throws when --project is used with --backend cloudflare', () => {
    expect(() => parseDeployArgs(['--backend', 'cloudflare', '--project', 'foo'])).toThrow(
      /--project is not supported with --backend cloudflare/,
    );
  });

  it('explains that no Void project is involved when rejecting --project', () => {
    expect(() => parseDeployArgs(['--backend', 'cloudflare', '--project', 'foo'])).toThrow(
      /no Void project is involved/,
    );
  });

  it('throws when --dir is used with --backend cloudflare', () => {
    expect(() => parseDeployArgs(['--backend', 'cloudflare', '--dir', 'dist'])).toThrow(
      /--dir is not supported with --backend cloudflare/,
    );
  });

  it('throws when --spa is used with --backend cloudflare', () => {
    expect(() => parseDeployArgs(['--backend', 'cloudflare', '--spa'])).toThrow(
      /--spa is not supported with --backend cloudflare/,
    );
  });

  it('still parses --project, --dir and --spa without --backend (managed path unaffected)', () => {
    const result = parseDeployArgs(['--project', 'foo', '--dir', 'dist', '--spa']);
    expect(result.backend).toBeUndefined();
    expect(result.projectSlug).toBe('foo');
    expect(result.dir).toBe('dist');
    expect(result.spa).toBe(true);
  });

  it('leaves backend undefined when no --backend is given (managed path)', () => {
    const result = parseDeployArgs([]);
    expect(result.backend).toBeUndefined();
    expect(result.provision).toBeUndefined();
  });
});
