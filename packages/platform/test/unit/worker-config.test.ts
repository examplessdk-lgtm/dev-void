import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';
import { deployment, deploymentInput, workerConfigs } from '../worker-config-fixture.ts';

describe('platform email deployment manifest', () => {
  it.each([{ emailSharedZoneId: 'mail-zone-id' }, { emailSenderDomain: 'mail.example.org' }])(
    'rejects incomplete shared email settings from the factory',
    (email) => {
      expect(() => createPlatformDeploymentManifest({ ...deploymentInput, ...email })).toThrow(
        'requires both emailSenderDomain and emailSharedZoneId',
      );
    },
  );

  it('rejects either incomplete shared email setting while parsing', () => {
    const complete = createPlatformDeploymentManifest({
      ...deploymentInput,
      emailSharedZoneId: 'mail-zone-id',
      emailSenderDomain: 'mail.example.org',
    });
    const { emailSenderDomain: _sender, ...zoneOnly } = complete;
    const { emailSharedZoneId: _zone, ...senderOnly } = complete;

    expect(() => parsePlatformDeploymentManifest(zoneOnly)).toThrow(
      'requires both emailSenderDomain and emailSharedZoneId',
    );
    expect(() => parsePlatformDeploymentManifest(senderOnly)).toThrow(
      'requires both emailSenderDomain and emailSharedZoneId',
    );
  });
});

describe('platform usage queue bindings', () => {
  it('binds the preview entrypoint only after the dispatcher exists at enabled cutover', () => {
    const staging = workerConfigs({ privatePreviews: true, trafficState: 'staging' });
    expect(staging.api.services).toBeUndefined();
    expect(staging.dispatch.services).toEqual([
      { binding: 'PREVIEW_API', service: deployment.resources.apiWorker },
    ]);
    const enabled = workerConfigs({ privatePreviews: true, trafficState: 'enabled' });
    expect(enabled.api.services).toEqual([
      {
        binding: 'PREVIEW_DISPATCH',
        service: deployment.resources.dispatchWorker,
        entrypoint: 'PreviewDispatcher',
      },
    ]);
  });
  it.each([
    { trafficState: 'staging' as const, publicEndpoints: true, bound: false },
    { trafficState: 'sandbox-drain' as const, publicEndpoints: true, bound: false },
    { trafficState: 'enabled' as const, publicEndpoints: false, bound: false },
    { trafficState: 'enabled' as const, publicEndpoints: true, bound: true },
  ])(
    'attaches private proxy health only at enabled cutover: $trafficState / $publicEndpoints',
    ({ trafficState, publicEndpoints, bound }) => {
      const configs = workerConfigs({ proxyHealthBinding: true, trafficState, publicEndpoints });
      expect(configs.api.services).toEqual(
        bound
          ? [{ binding: 'PLATFORM_PROXY', service: deployment.resources.proxyWorker }]
          : undefined,
      );
    },
  );

  it('adds no bootstrap service dependencies, assets or email bindings by default', () => {
    const configs = workerConfigs();
    expect(configs.api.services).toBeUndefined();
    expect(configs.api.assets).toBeUndefined();
    expect(configs.proxy.compatibility_flags).toEqual(['nodejs_compat']);
    expect(configs.proxy.services).toEqual([
      { binding: 'API', service: deployment.resources.apiWorker },
    ]);
    expect(configs.api).not.toHaveProperty('send_email');
    expect(configs.proxy).not.toHaveProperty('send_email');
    expect(configs.emailGateway).not.toHaveProperty('send_email');
    expect(Object.keys(configs).sort()).toEqual([
      'api',
      'dispatch',
      'emailGateway',
      'proxy',
      'tail',
    ]);
  });

  it('routes shared mail through its configured zone, independent of the application zone', () => {
    const mailDeployment = createPlatformDeploymentManifest({
      ...deploymentInput,
      emailSharedZoneId: 'mail-zone-id',
      emailSenderDomain: 'mail.example.org',
      authentication: { accessProtection: true },
      capabilities: { email: true },
    });
    const configs = workerConfigs({
      deployment: mailDeployment,
      runtimeApiAssetsDirectory: '/runtime/api/assets',
    });
    const expected = {
      EMAIL_SHARED_ACCOUNT_ID: 'account',
      EMAIL_SHARED_ZONE_ID: 'mail-zone-id',
      EMAIL_SHARED_INGRESS_NAME: mailDeployment.resources.emailGatewayWorker,
    };
    expect(configs.api.vars).toMatchObject(expected);
    expect(configs.emailGateway.vars).toMatchObject(expected);
    expect(configs.emailGateway.vars).toHaveProperty('PLATFORM_VERSION', '1.0.0');
    expect(configs.api.vars).toHaveProperty('EMAIL_SENDER_DOMAIN', 'mail.example.org');
    expect(configs.proxy.vars).toHaveProperty('EMAIL_SENDER_DOMAIN', 'mail.example.org');
    expect(configs.emailGateway.vars).toHaveProperty('EMAIL_SENDER_DOMAIN', 'mail.example.org');
    expect(configs.api).toHaveProperty('send_email', [{ name: 'EMAIL' }]);
    expect(configs.emailGateway).toHaveProperty('send_email', [{ name: 'SEND_EMAIL' }]);
    expect(configs.proxy).toHaveProperty('send_email', [{ name: 'SEND_EMAIL' }]);
    expect(configs.api.workers_dev).toBe(false);
    expect(configs.proxy.workers_dev).toBe(false);
    expect(configs.emailGateway.workers_dev).toBe(true);
    expect(configs.api.compatibility_flags).toContain('global_fetch_strictly_public');
    expect(configs.api.assets).toEqual({ directory: '/runtime/api/assets' });
    expect(configs.proxy.assets).toBeUndefined();
    expect(configs.api.vars).toHaveProperty(
      'EMAIL_GATEWAY_ORIGIN',
      'https://email-gateway.account.workers.dev',
    );
  });

  it.each([
    {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      workersDev: false,
      publicFetch: false,
    },
    {
      apiUrl: 'https://api.account.workers.dev',
      proxyUrl: 'https://proxy.example.com',
      workersDev: false,
      publicFetch: true,
    },
    {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.account.workers.dev',
      workersDev: false,
      publicFetch: true,
    },
    {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      workersDev: true,
      publicFetch: true,
    },
  ])(
    'adds global_fetch_strictly_public only for workers.dev probes: $apiUrl, $proxyUrl, workersDev=$workersDev',
    ({ apiUrl, proxyUrl, workersDev, publicFetch }) => {
      const configs = workerConfigs({
        apiUrl,
        proxyUrl,
        ...(workersDev
          ? {
              deployment: createPlatformDeploymentManifest({
                ...deploymentInput,
                application: {
                  baseDomain: 'account.workers.dev',
                  zoneName: '',
                  workersDev: { subdomain: 'account', installationId: 'example-123456abcdef' },
                },
              }),
            }
          : {}),
      });
      expect(configs.api.compatibility_flags).toEqual([
        'nodejs_compat',
        ...(publicFetch ? ['global_fetch_strictly_public'] : []),
      ]);
    },
  );

  it('binds the existing queue only to trusted platform producers', () => {
    const configs = workerConfigs();

    expect((configs.api.queues as { producers: Array<unknown> }).producers).toContainEqual({
      binding: 'USAGE_EVENTS_QUEUE',
      queue: deployment.resources.usageQueue,
    });
    expect((configs.dispatch.queues as { producers: Array<unknown> }).producers).toEqual([
      { binding: 'USAGE_QUEUE', queue: deployment.resources.usageQueue },
    ]);
    expect(configs.proxy.queues).toBeUndefined();
    expect(configs.proxy.durable_objects).toBeUndefined();
    expect(configs.tail.queues).toBeUndefined();
  });

  it('keeps the tail worker off workers.dev and preview URLs when endpoints are public', () => {
    const configs = workerConfigs({
      apiUrl: 'https://api.account.workers.dev',
      proxyUrl: 'https://proxy.account.workers.dev',
      publicEndpoints: true,
    });

    expect(configs.api.workers_dev).toBe(true);
    expect(configs.tail.workers_dev).toBe(false);
    expect(configs.tail.preview_urls).toBe(false);
  });

  it('creates core Durable Objects with SQLite while preserving migration tags', () => {
    expect(workerConfigs().api.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['UsageCounter'] },
      { tag: 'v2', new_sqlite_classes: ['CronScheduler'] },
      { tag: 'v3', new_sqlite_classes: ['ErrorAlertMonitor'] },
      { tag: 'v4', new_sqlite_classes: ['SandboxConcurrencyCounter'] },
    ]);
  });
});
