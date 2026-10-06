import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { assertNoninteractivePlatformMutationAcknowledged } from '../../src/cli/platform-lifecycle.ts';

describe('platform args', () => {
  it('accepts explicit planned choices and rejects contradictory configuration', () => {
    expect(
      parsePlatformArgs([
        'install',
        '--no-control-plane-domain',
        '--no-dedicated-zone',
        '--hyperdrive',
        'drive-id',
        '--login-methods',
        'google,oidc',
        '--no-access-protection',
      ]),
    ).toMatchObject({
      noControlPlaneDomain: true,
      dedicatedZoneSpecified: true,
      hyperdrive: 'drive-id',
      loginMethods: ['google', 'oidc'],
      accessProtection: false,
    });
    for (const flags of [
      ['--control-plane-domain', 'api.example.com', '--no-control-plane-domain'],
      ['--dedicated-zone', '--no-dedicated-zone'],
      ['--access-protection', '--no-access-protection'],
      ['--auth-config', 'auth.json', '--login-methods', 'github'],
      ['--auth-config', 'auth.json', '--access-protection'],
      ['--login-methods', 'unknown'],
      ['--login-methods', 'github,'],
    ]) {
      expect(() => parsePlatformArgs(['install', ...flags])).toThrow();
    }
  });

  it('configures dashboard origins only in install, upgrade, and repair', () => {
    for (const command of ['install', 'upgrade', 'repair']) {
      expect(
        parsePlatformArgs([command, '--dashboard-url', 'https://DASH.example.com:8443/']),
      ).toMatchObject({ dashboardUrl: 'https://dash.example.com:8443' });
      expect(parsePlatformArgs([command])).not.toHaveProperty('dashboardUrl');
      expect(() =>
        parsePlatformArgs([command, '--dashboard-url', 'https://dash.example.com/account']),
      ).toThrow('HTTPS origin');
      expect(() => parsePlatformArgs([command, '--dashboard-url'])).toThrow('requires a value');
    }
    for (const command of ['enable', 'disable', 'rollback', 'uninstall']) {
      expect(() =>
        parsePlatformArgs([command, '--dashboard-url', 'https://dash.example.com']),
      ).toThrow();
    }
  });
  it('parses resumable domain setup without confusing app-domain commands', () => {
    expect(
      parsePlatformArgs(['domain', 'set', 'example.com', '--installation', 'team', '--plan']),
    ).toEqual({
      subcommand: 'domain',
      domain: 'example.com',
      selector: 'team',
      zone: '',
      dedicatedZone: false,
      plan: true,
      yes: false,
    });
    expect(() => parsePlatformArgs(['domain', 'set'])).toThrow('requires an application domain');
    expect(() => parsePlatformArgs(['domain', 'set', 'example.com', '--plan', '--yes'])).toThrow(
      'either',
    );
  });
  it('makes testing explicit and rejects competing domain choices', () => {
    expect(parsePlatformArgs(['install', '--workers-dev', '--plan'])).toMatchObject({
      workersDev: true,
      plan: true,
    });
    expect(parsePlatformArgs(['install'])).not.toHaveProperty('workersDev');
    for (const flags of [
      ['--zone', 'example.com'],
      ['--application-domain', 'example.com'],
      ['--dedicated-zone'],
    ]) {
      expect(() => parsePlatformArgs(['install', '--workers-dev', ...flags])).toThrow(
        'cannot be combined',
      );
    }
  });
  it('parses connection and lifecycle selectors', () => {
    expect(() => parsePlatformArgs(['connect', 'https://api.example.com'])).toThrow();
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
    expect(
      parsePlatformArgs([
        'rollback',
        'example-a1b2c3d4',
        '--runtime',
        '/tmp/earlier-runtime',
        '--from-runtime',
        '/tmp/current-runtime',
        '--plan',
      ]),
    ).toEqual({
      fromRuntime: '/tmp/current-runtime',
      plan: true,
      runtime: '/tmp/earlier-runtime',
      selector: 'example-a1b2c3d4',
      subcommand: 'rollback',
      yes: false,
    });
    expect(() => parsePlatformArgs(['rollback', 'example-a1b2c3d4'])).toThrow(
      'rollback requires --runtime',
    );
  });

  it('parses safe uninstall choices explicitly', () => {
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--keep-zone'])).toEqual({
      subcommand: 'uninstall',
      selector: '',
      plan: false,
      purgeData: true,
      purgeResources: false,
      deleteZone: false,
      yes: false,
    });
    expect(() => parsePlatformArgs(['uninstall', '--delete-zone', '--keep-zone'])).toThrow();
  });

  it('treats --purge-resources as a purge of data and every other created resource', () => {
    expect(parsePlatformArgs(['uninstall', 'team', '--purge-resources', '--plan'])).toEqual({
      subcommand: 'uninstall',
      selector: 'team',
      plan: true,
      purgeData: true,
      purgeResources: true,
      deleteZone: null,
      yes: false,
    });
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--purge-resources'])).toMatchObject({
      purgeData: true,
      purgeResources: true,
    });
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
    for (const command of [
      'install',
      'upgrade',
      'rollback',
      'repair',
      'disable',
      'enable',
      'uninstall',
    ]) {
      const runtime = command === 'rollback' ? ['--runtime', '/tmp/earlier'] : [];
      const parsed = parsePlatformArgs([command, ...runtime]);
      expect(() => assertNoninteractivePlatformMutationAcknowledged(parsed, false)).toThrow(
        'requires --yes',
      );
      expect(() =>
        assertNoninteractivePlatformMutationAcknowledged(
          parsePlatformArgs([command, ...runtime, '--yes']),
          false,
        ),
      ).not.toThrow();
      expect(() =>
        assertNoninteractivePlatformMutationAcknowledged(
          parsePlatformArgs([command, ...runtime, '--plan']),
          false,
        ),
      ).not.toThrow();
    }
  });
});
