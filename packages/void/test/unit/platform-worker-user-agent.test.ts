import { expect, it } from 'vite-plus/test';
import { getCfCliVersion } from '../../src/cli/cf-user-agent.ts';
import { platformWorkerUploadAttribution } from '../../src/cli/platform-worker-user-agent.ts';

function workerConfig(role = 'api-worker'): Record<string, unknown> {
  return {
    account_id: 'test-account',
    name: 'test-worker',
    vars: {
      PLATFORM_VERSION: '0.27.0 custom',
      PLATFORM_OWNERSHIP_MARKER: JSON.stringify({
        schemaVersion: 1,
        accountId: 'test-account',
        installationId: 'installation-one',
        ownershipNonce: 'private-ownership-proof',
        resourceId: 'test-worker',
        resourceName: 'test-worker',
        resourceKey: role,
        resourceKind: 'worker',
      }),
    },
  };
}

it.each(['api-worker', 'proxy-worker', 'dispatch-worker', 'tail-worker', 'email-gateway-worker'])(
  'attributes %s uploads to the stable installation without exposing its ownership nonce',
  (role) => {
    const config = workerConfig(role);
    const before = JSON.stringify(config);
    const attribution = platformWorkerUploadAttribution(config);
    expect(attribution).toBe(
      `void-platform-install/0.27.0%20custom void-role/${role} void-installation/installation-one`,
    );
    expect(attribution).not.toContain('private-ownership-proof');
    expect(JSON.stringify(config)).toBe(before);
    const ordinaryVersion = getCfCliVersion();
    expect(getCfCliVersion(attribution)).toBe(`${ordinaryVersion} ${attribution}`);
    expect(getCfCliVersion()).toBe(ordinaryVersion);
  },
);

it.each([
  {},
  { vars: { PLATFORM_INSTALLATION_ID: 'installation-one' } },
  { vars: { PLATFORM_OWNERSHIP_MARKER: 'invalid-json' } },
  { ...workerConfig(), account_id: 'another-account' },
  { ...workerConfig(), name: 'another-worker' },
  workerConfig('application-worker'),
])('leaves ordinary or unverified Worker uploads with their existing attribution', (config) => {
  expect(platformWorkerUploadAttribution(config)).toBeUndefined();
});
