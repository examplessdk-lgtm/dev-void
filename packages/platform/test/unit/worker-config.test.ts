import { describe, expect, it } from 'vite-plus/test';
import { createPlatformDeploymentManifest } from '../../src/manifest.ts';
import { createPlatformWorkerConfigs } from '../../src/worker-config.ts';

describe('platform usage queue bindings', () => {
  it('routes shared mail through its configured zone, independent of the application zone', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      emailSharedZoneId: 'mail-zone-id',
      emailSenderDomain: 'mail.example.org',
      capabilities: { email: true },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
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
        zone: 'app-zone-id',
      },
      runtimeEntrypoints: {
        api: 'api.mjs',
        proxy: 'proxy.mjs',
        emailGateway: 'email-gateway.mjs',
        tail: 'tail.mjs',
        dispatch: 'dispatch.mjs',
      },
    });
    const expected = {
      EMAIL_SHARED_ACCOUNT_ID: 'account',
      EMAIL_SHARED_ZONE_ID: 'mail-zone-id',
      EMAIL_SHARED_INGRESS_NAME: deployment.resources.emailGatewayWorker,
    };
    expect(configs.api.vars).toMatchObject(expected);
    expect(configs.emailGateway.vars).toMatchObject(expected);
    expect(configs.emailGateway.vars).toHaveProperty('PLATFORM_VERSION', '1.0.0');
    expect(configs.api.vars).toHaveProperty('EMAIL_SENDER_DOMAIN', 'mail.example.org');
    expect(configs.proxy.vars).toHaveProperty('EMAIL_SENDER_DOMAIN', 'mail.example.org');
    expect(configs.emailGateway.vars).toHaveProperty('EMAIL_SENDER_DOMAIN', 'mail.example.org');
    expect(configs.emailGateway).toHaveProperty('send_email', [{ name: 'SEND_EMAIL' }]);
    expect(configs.api.compatibility_flags).toContain('global_fetch_strictly_public');
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
    'supports public health probes without adding bootstrap service dependencies: $apiUrl, $proxyUrl, workersDev=$workersDev',
    ({ apiUrl, proxyUrl, workersDev, publicFetch }) => {
      const deployment = createPlatformDeploymentManifest({
        application: workersDev
          ? {
              baseDomain: 'account.workers.dev',
              zoneName: '',
              workersDev: { subdomain: 'account', installationId: 'example-123456abcdef' },
            }
          : { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      });
      const configs = createPlatformWorkerConfigs({
        accountId: 'account',
        apiUrl,
        proxyUrl,
        emailGatewayUrl: 'https://email-gateway.account.workers.dev',
        deployment,
        healthProbeToken: 'probe',
        installationId: 'example-123456abcdef',
        ownershipNonce: 'ownership',
        platformVersion: '1.0.0',
        resources: {
          hyperdrive: 'db',
          isrCacheKv: 'isr',
          legacyAssetsKv: 'assets',
          routingKv: 'routing',
          zone: workersDev ? '' : 'zone',
        },
        runtimeEntrypoints: {
          api: 'api.mjs',
          proxy: 'proxy.mjs',
          emailGateway: 'email-gateway.mjs',
          dispatch: 'dispatch.mjs',
          tail: 'tail.mjs',
        },
      });
      expect(configs.api.compatibility_flags).toEqual([
        'nodejs_compat',
        ...(publicFetch ? ['global_fetch_strictly_public'] : []),
      ]);
      expect(configs.api.services).toBeUndefined();
      expect(configs.proxy.compatibility_flags).toEqual(['nodejs_compat']);
      expect(configs.proxy.services).toEqual([
        { binding: 'API', service: deployment.resources.apiWorker },
      ]);
      expect(Object.keys(configs).sort()).toEqual([
        'api',
        'dispatch',
        'emailGateway',
        'proxy',
        'tail',
      ]);
    },
  );

  it('binds the existing queue only to trusted platform producers', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://api.example.com',
      deployment,
      healthProbeToken: 'probe',
      installationId: 'installation',
      ownershipNonce: 'ownership',
      platformVersion: '1.0.0',
      proxyUrl: 'https://proxy.example.com',
      emailGatewayUrl: 'https://email-gateway.account.workers.dev',
      resources: {
        hyperdrive: 'hyperdrive-id',
        isrCacheKv: 'isr-id',
        legacyAssetsKv: 'assets-id',
        routingKv: 'routing-id',
        zone: 'zone-id',
      },
      runtimeEntrypoints: {
        api: 'api.mjs',
        dispatch: 'dispatch.mjs',
        proxy: 'proxy.mjs',
        emailGateway: 'email-gateway.mjs',
        tail: 'tail.mjs',
      },
    });

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

  it('creates core Durable Objects with SQLite while preserving migration tags', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://api.example.com',
      deployment,
      healthProbeToken: 'probe',
      installationId: 'installation',
      ownershipNonce: 'ownership',
      platformVersion: '1.0.0',
      proxyUrl: 'https://proxy.example.com',
      emailGatewayUrl: 'https://email-gateway.account.workers.dev',
      resources: {
        hyperdrive: 'hyperdrive-id',
        isrCacheKv: 'isr-id',
        legacyAssetsKv: 'assets-id',
        routingKv: 'routing-id',
        zone: 'zone-id',
      },
      runtimeEntrypoints: {
        api: 'api.mjs',
        dispatch: 'dispatch.mjs',
        proxy: 'proxy.mjs',
        emailGateway: 'email-gateway.mjs',
        tail: 'tail.mjs',
      },
    });

    expect(configs.api.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['UsageCounter'] },
      { tag: 'v2', new_sqlite_classes: ['CronScheduler'] },
      { tag: 'v3', new_sqlite_classes: ['ErrorAlertMonitor'] },
      { tag: 'v4', new_sqlite_classes: ['SandboxConcurrencyCounter'] },
    ]);
  });
});
