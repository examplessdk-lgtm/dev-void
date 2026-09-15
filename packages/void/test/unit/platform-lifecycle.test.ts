import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
} from '@void/platform';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resolvePlatformInstallDatabaseUrl } from '../../src/cli/platform-lifecycle.ts';

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.VOID_PLATFORM_DATABASE_URL;
});

describe('platform lifecycle', () => {
  it('lets explicit database input replace an unverified install checkpoint', () => {
    const checkpoint = { databaseUrl: 'postgres://unreachable.example/void' };

    process.env.DATABASE_URL = 'postgres://corrected.example/void';
    expect(resolvePlatformInstallDatabaseUrl(checkpoint)).toBe('postgres://corrected.example/void');

    process.env.VOID_PLATFORM_DATABASE_URL = 'postgres://explicit.example/void';
    expect(resolvePlatformInstallDatabaseUrl(checkpoint)).toBe('postgres://explicit.example/void');
  });

  it('pins a successfully claimed database across resume attempts', () => {
    const checkpoint = {
      databaseClaimState: 'claimed',
      databaseUrl: 'postgres://recorded.example/void',
    };

    process.env.DATABASE_URL = checkpoint.databaseUrl;
    expect(resolvePlatformInstallDatabaseUrl(checkpoint)).toBe(checkpoint.databaseUrl);

    process.env.DATABASE_URL = 'postgres://replacement.example/void';
    expect(() => resolvePlatformInstallDatabaseUrl(checkpoint)).toThrow(
      'already bound to its recorded PostgreSQL database',
    );
  });

  it('pins legacy recovery state once Hyperdrive has been provisioned', () => {
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'hyperdrive-id',
        key: 'hyperdrive',
        kind: 'hyperdrive',
        name: 'void-example-api',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const checkpoint = { databaseUrl: 'postgres://recorded.example/void' };
    process.env.DATABASE_URL = 'postgres://replacement.example/void';

    expect(() => resolvePlatformInstallDatabaseUrl(checkpoint, manifest)).toThrow(
      'already bound to its recorded PostgreSQL database',
    );

    delete process.env.DATABASE_URL;
    expect(() => resolvePlatformInstallDatabaseUrl(null, manifest)).toThrow(
      'Export VOID_PLATFORM_DATABASE_URL',
    );
    process.env.VOID_PLATFORM_DATABASE_URL = 'postgres://recorded.example/void';
    expect(resolvePlatformInstallDatabaseUrl(null, manifest)).toBe(
      'postgres://recorded.example/void',
    );
  });
});
