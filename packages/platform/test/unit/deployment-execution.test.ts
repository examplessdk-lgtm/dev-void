import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformInstallationManifest,
  parsePlatformInstallationManifest,
} from '../../src/installation.ts';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';
import { workerConfigs } from '../worker-config-fixture.ts';

function configs(deploymentExecution?: 1) {
  return workerConfigs({
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Team',
      installationSlug: 'team',
    }),
    deploymentExecution,
  });
}

describe('durable platform deployment Queue', () => {
  it('records activated executor support while accepting older installation checkpoints', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Team',
      installationSlug: 'team',
    });
    const old = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      deployment,
      createdAt: '2026-10-01T00:00:00.000Z',
      id: 'team-12345678',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    expect(parsePlatformInstallationManifest(old).deploymentExecution).toBeUndefined();
    expect(
      parsePlatformInstallationManifest({ ...old, deploymentExecution: 1 }).deploymentExecution,
    ).toBe(1);
    expect(() => parsePlatformInstallationManifest({ ...old, deploymentExecution: 2 })).toThrow(
      'deployment execution protocol',
    );
  });
  it('upgrades old manifests without changing their existing resource identities', () => {
    const current = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Team',
      installationSlug: 'team',
      resources: { apiWorker: 'void-team-api-legacy', cronQueue: 'void-team-cron-fires-legacy' },
    });
    const { deploymentQueue: _deploymentQueue, ...legacyResources } = current.resources;
    const upgraded = parsePlatformDeploymentManifest({ ...current, resources: legacyResources });
    expect(upgraded.resources).toEqual({
      ...legacyResources,
      deploymentQueue: 'void-team-deployments',
    });
  });

  it('binds one deployment per delivery with bounded delayed retries only on the API', () => {
    const configured = configs(1);
    expect(configured.api.queues).toMatchObject({
      producers: expect.arrayContaining([
        { binding: 'DEPLOYMENTS_QUEUE', queue: 'void-team-deployments' },
      ]),
      consumers: expect.arrayContaining([
        {
          queue: 'void-team-deployments',
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 100,
          retry_delay: 60,
        },
      ]),
    });
    expect(configured.api.vars).toHaveProperty('DEPLOYMENTS_QUEUE_NAME', 'void-team-deployments');
    expect(configured.api.triggers).toEqual({ crons: ['0 * * * *', '*/2 * * * *'] });
    for (const [key, config] of Object.entries(configured)) {
      if (key !== 'api') {
        expect(JSON.stringify(config)).not.toContain('void-team-deployments');
      }
    }
  });

  it('omits producer, consumer and routing name when the target runtime has no executor', () => {
    expect(JSON.stringify(configs())).not.toContain('DEPLOYMENTS_QUEUE');
    expect(JSON.stringify(configs())).not.toContain('void-team-deployments');
    expect(configs().api.triggers).toEqual({ crons: ['0 * * * *'] });
  });
});
