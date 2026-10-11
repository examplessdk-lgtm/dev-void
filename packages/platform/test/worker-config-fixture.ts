import { createPlatformDeploymentManifest } from '../src/manifest.ts';
import { createPlatformWorkerConfigs } from '../src/worker-config.ts';

export const deploymentInput = {
  application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
  displayName: 'Example',
  installationSlug: 'example',
};

export const deployment = createPlatformDeploymentManifest(deploymentInput);

export function workerConfigs(
  overrides: Partial<Parameters<typeof createPlatformWorkerConfigs>[0]> = {},
): ReturnType<typeof createPlatformWorkerConfigs> {
  return createPlatformWorkerConfigs({
    accountId: 'account',
    apiUrl: 'https://api.example.com',
    proxyUrl: 'https://proxy.example.com',
    emailGatewayUrl: 'https://email-gateway.account.workers.dev',
    deployment,
    healthProbeToken: 'probe',
    installationId: 'installation',
    ownershipNonce: 'ownership',
    platformVersion: '1.0.0',
    resources: {
      hyperdrive: 'db',
      isrCacheKv: 'isr',
      legacyAssetsKv: 'assets',
      routingKv: 'routing',
      zone: 'zone',
    },
    runtimeEntrypoints: {
      api: 'api.mjs',
      dispatch: 'dispatch.mjs',
      emailGateway: 'email-gateway.mjs',
      proxy: 'proxy.mjs',
      tail: 'tail.mjs',
    },
    ...overrides,
  });
}
