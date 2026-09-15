import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  transitionInstallation,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';

function manifestAt(status: 'deploying' | 'verifying') {
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
  manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
  manifest = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
  manifest = transitionInstallation(manifest, 'deploying', '2026-09-14T00:00:03.000Z');
  if (status === 'verifying') {
    manifest = transitionInstallation(manifest, 'verifying', '2026-09-14T00:00:04.000Z');
  }
  return manifest;
}

describe('platform installation resume states', () => {
  it.each(['deploying', 'verifying'] as const)(
    're-enters provisioning from an interrupted %s checkpoint',
    (status) => {
      const resumed = transitionInstallation(
        manifestAt(status),
        'provisioning',
        '2026-09-14T00:00:05.000Z',
      );
      expect(resumed.status).toBe('provisioning');
    },
  );
});
