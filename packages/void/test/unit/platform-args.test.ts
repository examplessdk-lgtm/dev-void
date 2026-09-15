import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { assertNoninteractivePlatformMutationAcknowledged } from '../../src/cli/platform-lifecycle.ts';

describe('platform args', () => {
  it('parses connection and lifecycle selectors', () => {
    expect(parsePlatformArgs(['connect', 'https://api.example.com'])).toEqual({
      subcommand: 'connect',
      url: 'https://api.example.com',
    });
    expect(parsePlatformArgs(['repair', 'example-a1b2c3d4', '--plan'])).toEqual({
      subcommand: 'repair',
      selector: 'example-a1b2c3d4',
      plan: true,
      runtime: '',
      yes: false,
    });
    expect(parsePlatformArgs(['enable', 'example-a1b2c3d4'])).toEqual({
      subcommand: 'enable',
      selector: 'example-a1b2c3d4',
      plan: false,
      runtime: '',
      yes: false,
    });
    expect(parsePlatformArgs(['discover', '--account', 'account-id'])).toEqual({
      subcommand: 'discover',
      account: 'account-id',
      selector: '',
    });
    expect(
      parsePlatformArgs([
        'discover',
        '--installation',
        'staging-a1b2c3d4',
        '--account',
        'account-id',
      ]),
    ).toEqual({
      subcommand: 'discover',
      account: 'account-id',
      selector: 'staging-a1b2c3d4',
    });
  });

  it('parses custom runtimes for lifecycle commands that deploy Workers', () => {
    expect(
      parsePlatformArgs([
        'upgrade',
        'example-a1b2c3d4',
        '--runtime',
        'packages/platform/dist/runtime',
        '--yes',
      ]),
    ).toEqual({
      subcommand: 'upgrade',
      selector: 'example-a1b2c3d4',
      plan: false,
      runtime: 'packages/platform/dist/runtime',
      yes: true,
    });
    expect(
      parsePlatformArgs(['install', '--runtime', '/tmp/void-runtime', '--plan']),
    ).toMatchObject({ runtime: '/tmp/void-runtime' });
    expect(() => parsePlatformArgs(['disable', '--runtime', '/tmp/void-runtime'])).toThrow(
      "Unknown flag '--runtime'",
    );
  });

  it('parses safe uninstall choices explicitly', () => {
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--keep-zone'])).toEqual({
      subcommand: 'uninstall',
      selector: '',
      plan: false,
      purgeData: true,
      deleteZone: false,
      yes: false,
    });
    expect(() => parsePlatformArgs(['uninstall', '--delete-zone', '--keep-zone'])).toThrow();
  });

  it('parses explicit lifecycle acknowledgement', () => {
    expect(parsePlatformArgs(['upgrade', '--yes'])).toMatchObject({
      subcommand: 'upgrade',
      yes: true,
    });
    expect(parsePlatformArgs(['install', '--yes'])).toMatchObject({
      subcommand: 'install',
      yes: true,
    });
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--yes'])).toMatchObject({
      subcommand: 'uninstall',
      purgeData: true,
      yes: true,
    });
  });

  it('parses a non-interactive installation', () => {
    expect(
      parsePlatformArgs([
        'install',
        '--name',
        'company',
        '--application-domain',
        'apps.example.com',
        '--zone',
        'example.com',
        '--account',
        'abc',
        '--plan',
      ]),
    ).toMatchObject({ subcommand: 'install', name: 'company', plan: true });
  });

  it('fails closed for every unacknowledged non-interactive mutation', () => {
    for (const command of ['install', 'upgrade', 'repair', 'disable', 'enable', 'uninstall']) {
      const parsed = parsePlatformArgs([command]);
      expect(() => assertNoninteractivePlatformMutationAcknowledged(parsed, false)).toThrow(
        'requires --yes',
      );
      expect(() =>
        assertNoninteractivePlatformMutationAcknowledged(
          parsePlatformArgs([command, '--yes']),
          false,
        ),
      ).not.toThrow();
      expect(() =>
        assertNoninteractivePlatformMutationAcknowledged(
          parsePlatformArgs([command, '--plan']),
          false,
        ),
      ).not.toThrow();
    }
  });
});
