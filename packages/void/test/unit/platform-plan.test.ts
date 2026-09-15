import { createHash } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  recordInstallationResource,
  recordInstallationStep,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformInstallPlan,
  platformProvisionIntentHash,
  revalidatePlatformInstallAction,
} from '../../src/cli/platform-plan.ts';

function client(overrides: Record<string, unknown> = {}) {
  return {
    verifyToken: async () => {},
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'example',
    getKvValue: async () => null,
    listAiGateways: async () => [],
    findZone: async () => null,
    findZoneForHostname: async () => null,
    listDnsRecords: async () => [],
    getR2Object: async () => null,
    getWorkerPlainTextBindings: async () => ({}),
    listKvNamespaces: async () => [],
    listR2Buckets: async () => [],
    listQueues: async () => [],
    listDispatchNamespaces: async () => [],
    listHyperdriveConfigs: async () => [],
    listWorkerNames: async () => [],
    listWorkerDomains: async () => [],
    listWorkerRoutes: async () => [],
    ...overrides,
  };
}

const input = {
  accountId: 'account',
  applicationDomain: 'apps.example.com',
  controlPlaneDomain: '',
  dedicatedZone: false,
  displayName: 'Example',
  installationSlug: 'example',
  zoneName: 'example.com',
};

function r2ConfigHash(name: string, fingerprint: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ fingerprint, kind: 'r2-bucket', name }))
    .digest('hex');
}

describe('platform installation planning', () => {
  it('builds a read-only core plan without containers', async () => {
    const fake = client();
    const plan = await createPlatformInstallPlan(fake, input, null);
    expect(plan.apiUrl).toBe(`https://${plan.deployment.resources.apiWorker}.example.workers.dev`);
    expect(plan.deployment.resources.apiWorker).toMatch(/^void-example-[a-f0-9]{12}-api$/);
    expect(plan.actions).toHaveLength(15);
    expect(plan.actions.every((action) => action.action === 'create')).toBe(true);
    expect(Object.keys(fake)).not.toContain('createZone');
  });

  it('keeps a fresh read-only plan stable for the later apply', async () => {
    const planned = await createPlatformInstallPlan(client(), input, null);
    const applied = await createPlatformInstallPlan(client(), input, null);
    expect(applied.installationId).toBe(planned.installationId);
    expect(applied.apiUrl).toBe(planned.apiUrl);
    expect(applied.deployment.resources).toEqual(planned.deployment.resources);
  });

  it('uses an explicit unpredictable suffix for a provisioning plan', async () => {
    const plan = await createPlatformInstallPlan(client(), input, null, {
      provisioningSuffix: '0123456789abcdef0123456789abcdef',
    });
    expect(plan.deployment.resources.apiWorker).toBe(
      'void-example-0123456789abcdef0123456789abcdef-api',
    );
    expect(plan.deployment.resources.dispatchWorker).toBe(
      'void-example-0123456789abcdef0123456789abcdef-dispatch',
    );
    expect(
      Math.max(...Object.values(plan.deployment.resources).map((name) => name.length)),
    ).toBeLessThanOrEqual(63);
  });

  it('fails closed on an unowned deterministic-name collision', async () => {
    const fake = client({
      listKvNamespaces: async (_account: string, title: string) =>
        title.endsWith('-routing') ? [{ id: 'someone-else', name: title }] : [],
    });
    await expect(createPlatformInstallPlan(fake, input, null)).rejects.toThrow('not owned');
  });

  it('refuses to replace an existing Worker custom domain or DNS record', async () => {
    const customInput = { ...input, controlPlaneDomain: 'api.platform.example.com' };
    await expect(
      createPlatformInstallPlan(
        client({
          listWorkerDomains: async () => [
            { hostname: customInput.controlPlaneDomain, id: 'domain', service: 'other-worker' },
          ],
        }),
        customInput,
        null,
      ),
    ).rejects.toThrow('already assigned');

    await expect(
      createPlatformInstallPlan(
        client({
          findZoneForHostname: async () => ({
            id: 'control-zone',
            name: 'example.com',
            nameServers: [],
            status: 'active',
          }),
          listDnsRecords: async (_zone: string, name: string) =>
            name === customInput.controlPlaneDomain
              ? [
                  {
                    content: '192.0.2.1',
                    id: 'existing-dns',
                    name,
                    proxied: true,
                    type: 'A',
                  },
                ]
              : [],
        }),
        customInput,
        null,
      ),
    ).rejects.toThrow('already has a DNS record');
  });

  it('refuses to take over an existing application Worker route', async () => {
    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => ({
            id: 'zone',
            name: 'example.com',
            nameServers: [],
            status: 'active',
          }),
          listWorkerRoutes: async () => [
            { id: 'route', pattern: '*.apps.example.com/*', script: 'other-worker' },
          ],
        }),
        input,
        null,
      ),
    ).rejects.toThrow('Application route');
  });

  it('does not treat a local provision intent as remote ownership proof', async () => {
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
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:routing-kv',
        resultHash: platformProvisionIntentHash(
          manifest,
          'routing-kv',
          'kv-namespace',
          'void-example-routing',
        ),
      },
      '2026-09-14T00:00:01.000Z',
    );
    await expect(
      createPlatformInstallPlan(
        client({
          listKvNamespaces: async (_account: string, title: string) =>
            title === 'void-example-routing' ? [{ id: 'created-before-crash', name: title }] : [],
        }),
        input,
        manifest,
      ),
    ).rejects.toThrow('not owned');
  });

  it('refuses an intent-only resource after an ambiguous create response', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null, {
      provisioningSuffix: '0123456789ab',
    });
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const resourceName = initial.deployment.resources.routingKv;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:routing-kv',
        resultHash: platformProvisionIntentHash(
          manifest,
          'routing-kv',
          'kv-namespace',
          resourceName,
        ),
      },
      '2026-09-14T00:00:01.000Z',
    );

    await expect(
      createPlatformInstallPlan(
        client({
          listKvNamespaces: async (_account: string, title: string) =>
            title === resourceName ? [{ id: 'created-before-crash', name: title }] : [],
        }),
        input,
        manifest,
      ),
    ).rejects.toThrow('not owned');

    const recovered = await createPlatformInstallPlan(
      client({
        listKvNamespaces: async (_account: string, title: string) =>
          title === resourceName ? [{ id: 'created-before-crash', name: title }] : [],
      }),
      input,
      manifest,
      { authoritativeProvisionIntents: true },
    );
    const retry = recovered.actions.find((action) => action.key === 'routing-kv');
    expect(retry).toMatchObject({
      action: 'create',
      id: null,
      reason:
        'Leave the ambiguous same-name resource untouched and create a fresh installer-scoped replacement.',
    });
    expect(retry?.name).not.toBe(resourceName);
    expect(recovered.deployment.resources.routingKv).toBe(retry?.name);
  });

  it('uses a fresh name after an interrupted repair create', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    const resourceName = initial.deployment.resources.routingKv;
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'old',
        id: 'missing-old-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: resourceName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const resultHash = platformProvisionIntentHash(
      manifest,
      'routing-kv',
      'kv-namespace',
      resourceName,
      'missing-old-id',
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:02.000Z',
        key: `provision-intent:routing-kv:${resultHash.slice(0, 16)}`,
        resultHash,
      },
      '2026-09-14T00:00:02.000Z',
    );

    const resumed = await createPlatformInstallPlan(
      client({
        listKvNamespaces: async (_account: string, title: string) =>
          title === resourceName ? [{ id: 'replacement-before-crash', name: title }] : [],
      }),
      input,
      manifest,
      { authoritativeProvisionIntents: true, repairMissing: true },
    );
    const retry = resumed.actions.find((action) => action.key === 'routing-kv');
    expect(retry).toMatchObject({ action: 'create', id: null });
    expect(retry?.name).not.toBe(resourceName);
  });

  it('retains a recorded R2 bucket whose ownership marker is missing', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null, {
      provisioningSuffix: '0123456789ab',
    });
    const bucketName = initial.deployment.resources.assetsBucket;
    const fingerprint = '2026-09-14T00:00:00.000Z';
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: fingerprint,
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: r2ConfigHash(bucketName, fingerprint),
        id: bucketName,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name: bucketName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );

    const resumed = await createPlatformInstallPlan(
      client({
        listR2Buckets: async () => [{ fingerprint, id: bucketName, name: bucketName }],
      }),
      input,
      manifest,
    );
    const replacement = resumed.actions.find((action) => action.key === 'assets-bucket');
    expect(replacement).toMatchObject({
      action: 'create',
      id: null,
      reason:
        'Retain the ambiguously owned resource and create a fresh installer-scoped replacement.',
    });
    expect(replacement?.name).toMatch(/-retry-[a-f0-9]{32}$/);
    expect(resumed.deployment.resources.assetsBucket).toBe(replacement?.name);
  });

  it('retains a marked R2 bucket whose creation fingerprint changed', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null, {
      provisioningSuffix: '0123456789ab',
    });
    const bucketName = initial.deployment.resources.assetsBucket;
    const fingerprint = '2026-09-14T00:00:00.000Z';
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: fingerprint,
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: r2ConfigHash(bucketName, fingerprint),
        id: bucketName,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name: bucketName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: manifest.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: bucketName,
        resourceKey: 'assets-bucket',
        resourceKind: 'r2-bucket',
        resourceName: bucketName,
      }),
    );

    const resumed = await createPlatformInstallPlan(
      client({
        getR2Object: async () => marker,
        listR2Buckets: async () => [
          { fingerprint: '2026-09-14T00:00:02.000Z', id: bucketName, name: bucketName },
        ],
      }),
      input,
      manifest,
    );
    expect(resumed.actions.find((action) => action.key === 'assets-bucket')).toMatchObject({
      action: 'create',
      id: null,
    });
  });

  it('recovers only an intent-only Worker with its matching durable marker', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, 'api-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: 'account',
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: workerName,
        resourceKey: 'api-worker',
        resourceKind: 'worker',
        resourceName: workerName,
      }),
    );
    const resumed = await createPlatformInstallPlan(
      client({
        getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
        listWorkerNames: async () => [workerName],
      }),
      input,
      manifest,
    );
    expect(resumed.actions.find((action) => action.key === 'api-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });

    await expect(
      createPlatformInstallPlan(
        client({
          getWorkerPlainTextBindings: async () => ({}),
          listWorkerNames: async () => [workerName],
        }),
        input,
        manifest,
      ),
    ).rejects.toThrow('not owned');
  });

  it('resumes an intent-owned dispatch Worker after its public route was uploaded', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const workerName = manifest.deployment.resources.dispatchWorker;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:dispatch-worker',
        resultHash: platformProvisionIntentHash(manifest, 'dispatch-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: manifest.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: workerName,
        resourceKey: 'dispatch-worker',
        resourceKind: 'worker',
        resourceName: workerName,
      }),
    );

    const resumed = await createPlatformInstallPlan(
      client({
        findZone: async () => ({
          id: 'zone',
          name: 'example.com',
          nameServers: [],
          status: 'active',
        }),
        getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
        listWorkerNames: async () => [workerName],
        listWorkerRoutes: async () => [
          { id: 'route', pattern: '*.apps.example.com/*', script: workerName },
        ],
      }),
      input,
      manifest,
    );

    expect(resumed.actions.find((action) => action.key === 'dispatch-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });
  });

  it('resumes an intent-owned API Worker after its custom domain was uploaded', async () => {
    const customInput = { ...input, controlPlaneDomain: 'api.platform.example.com' };
    const initial = await createPlatformInstallPlan(client(), customInput, null);
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, 'api-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: manifest.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: workerName,
        resourceKey: 'api-worker',
        resourceKind: 'worker',
        resourceName: workerName,
      }),
    );

    const resumed = await createPlatformInstallPlan(
      client({
        findZoneForHostname: async () => ({
          id: 'control-zone',
          name: 'example.com',
          nameServers: [],
          status: 'active',
        }),
        getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
        listDnsRecords: async (_zone: string, hostname: string) =>
          hostname === customInput.controlPlaneDomain
            ? [
                {
                  content: workerName,
                  id: 'custom-domain-dns',
                  name: hostname,
                  proxied: true,
                  type: 'CNAME',
                },
              ]
            : [],
        listWorkerDomains: async () => [
          { hostname: customInput.controlPlaneDomain, id: 'domain', service: workerName },
        ],
        listWorkerNames: async () => [workerName],
      }),
      customInput,
      manifest,
    );

    expect(resumed.actions.find((action) => action.key === 'api-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });
  });

  it('refuses to deploy over a Worker replaced after planning', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = createPlatformInstallationManifest({
      account: initial.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: initial.deployment,
      id: initial.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: workerName,
        key: 'api-worker',
        kind: 'worker',
        name: workerName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: manifest.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: workerName,
        resourceKey: 'api-worker',
        resourceKind: 'worker',
        resourceName: workerName,
      }),
    );
    let liveMarker: string | undefined = marker;
    const fake = client({
      getWorkerPlainTextBindings: async () =>
        liveMarker ? { PLATFORM_OWNERSHIP_MARKER: liveMarker } : {},
      listWorkerNames: async () => [workerName],
    });
    const original = await createPlatformInstallPlan(fake, input, manifest);
    const action = original.actions.find((entry) => entry.key === 'api-worker')!;
    liveMarker = undefined;

    await expect(revalidatePlatformInstallAction(fake, original, manifest, action)).rejects.toThrow(
      "no longer has this installation's ownership marker",
    );
  });

  it('resumes resources proven by the remote ownership checkpoint', async () => {
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
    const local = manifest;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'created-before-crash',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(
      client({
        getKvValue: async () => JSON.stringify(manifest),
        listKvNamespaces: async (_account: string, title: string) =>
          title === 'void-example-routing' ? [{ id: 'created-before-crash', name: title }] : [],
      }),
      input,
      local,
    );
    expect(plan.actions.find((action) => action.key === 'routing-kv')).toMatchObject({
      action: 'reuse',
      id: 'created-before-crash',
    });
  });

  it('adopts an existing zone without claiming ownership', async () => {
    const fake = client({
      findZone: async () => ({
        id: 'zone',
        name: 'example.com',
        nameServers: [],
        status: 'active',
      }),
    });
    const plan = await createPlatformInstallPlan(fake, input, null);
    expect(plan.actions[0]).toMatchObject({ action: 'adopt', id: 'zone', kind: 'zone' });
  });

  it('adopts only a compatible wildcard application DNS record', async () => {
    const zone = {
      id: 'zone',
      name: 'example.com',
      nameServers: [],
      status: 'active',
    };
    const plan = await createPlatformInstallPlan(
      client({
        findZone: async () => zone,
        listDnsRecords: async () => [
          {
            content: '100::',
            id: 'dns',
            name: '*.apps.example.com',
            proxied: true,
            type: 'AAAA',
          },
        ],
      }),
      input,
      null,
    );
    expect(plan.actions.find((action) => action.key === 'application-dns')).toMatchObject({
      action: 'adopt',
      id: 'dns',
    });

    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => zone,
          listDnsRecords: async () => [
            {
              content: '192.0.2.1',
              id: 'dns',
              name: '*.apps.example.com',
              proxied: false,
              type: 'A',
            },
          ],
        }),
        input,
        null,
      ),
    ).rejects.toThrow('unproxied record');
  });

  it('repairs a missing installer-owned resource', async () => {
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
        id: 'missing-routing',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(client(), input, manifest, {
      repairMissing: true,
    });
    expect(plan.actions.find((action) => action.key === 'routing-kv')).toMatchObject({
      action: 'create',
      id: null,
    });
  });

  it('revalidates a missing Worker with the approved repair policy', async () => {
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
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: workerName,
        key: 'api-worker',
        kind: 'worker',
        name: workerName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(client(), input, manifest, {
      repairMissing: true,
    });
    const action = plan.actions.find((entry) => entry.key === 'api-worker')!;

    await expect(
      revalidatePlatformInstallAction(client(), plan, manifest, action, {
        repairMissing: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses to recreate a missing adopted resource', async () => {
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
        id: 'external-routing',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'adopted',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    await expect(
      createPlatformInstallPlan(client(), input, manifest, { repairMissing: true }),
    ).rejects.toThrow('will not recreate');
  });
});
