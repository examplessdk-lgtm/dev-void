import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
  type ResourceOwnership,
} from '@void/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  disablePlatform,
  resolvePlatformRuntimeTokenToPreflight,
  resolveInstalledPlatformManifest,
  selectAuthoritativePlatformManifest,
  uninstallPlatform,
  verifyPlatformInstallationOwnership,
} from '../../src/cli/platform-management.ts';
import {
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
} from '../../src/cli/platform-plan.ts';
import {
  listInstallationManifests,
  promoteInstallationSecrets,
  readInstallationRecoverySecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';
import { recordPlatformWorkerTraffic } from '../../src/cli/platform-traffic.ts';

const directories: Array<string> = [];

beforeEach(() => {
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function installedManifest(zoneOwnership: ResourceOwnership = 'created') {
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
  const resources: Array<[string, InstallationResourceKind, ResourceOwnership]> = [
    ['zone', 'zone', zoneOwnership],
    ['application-dns', 'dns-record', 'created'],
    ['ai-gateway', 'ai-gateway', 'created'],
    ['routing-kv', 'kv-namespace', 'created'],
    ['isr-cache-kv', 'kv-namespace', 'created'],
    ['legacy-assets-kv', 'kv-namespace', 'created'],
    ['assets-bucket', 'r2-bucket', 'created'],
    ['usage-queue', 'queue', 'created'],
    ['cron-queue', 'queue', 'created'],
    ['dispatch-namespace', 'dispatch-namespace', 'created'],
    ['hyperdrive', 'hyperdrive', 'created'],
    ['api-worker', 'worker', 'created'],
    ['proxy-worker', 'worker', 'created'],
    ['tail-worker', 'worker', 'created'],
    ['dispatch-worker', 'worker', 'created'],
  ];
  for (const [key, kind, ownership] of resources) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash:
          kind === 'dns-record'
            ? createHash('sha256')
                .update(
                  JSON.stringify({
                    content: '100::',
                    kind: 'dns-record',
                    name: key,
                    proxied: true,
                    type: 'AAAA',
                  }),
                )
                .digest('hex')
            : kind === 'r2-bucket'
              ? createHash('sha256')
                  .update(
                    JSON.stringify({
                      fingerprint: '2026-09-14T00:00:00.000Z',
                      kind: 'r2-bucket',
                      name: key,
                    }),
                  )
                  .digest('hex')
              : 'hash',
        id: kind === 'worker' ? `void-example-${key.replace('-worker', '')}` : `${key}-id`,
        key,
        kind,
        name: key,
        ownership,
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
  }
  for (const status of [
    'planned',
    'provisioning',
    'deploying',
    'verifying',
    'installed',
  ] as const) {
    manifest = transitionInstallation(manifest, status, '2026-09-14T00:00:02.000Z');
  }
  return manifest;
}

function persist(manifest: PlatformInstallationManifest): void {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-management-test-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
  writeInstallationManifest(manifest);
  writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://recovery' });
  promoteInstallationSecrets(manifest);
}

function client(manifest: PlatformInstallationManifest) {
  const deleted: Array<[string, string]> = [];
  const emptiedBuckets: Array<string> = [];
  const preservedBucketKeys: Array<ReadonlyArray<string>> = [];
  const deletedBucketMarkers: Array<string> = [];
  const remoteWrites: Array<string> = [];
  const disabledWrites: Array<string> = [];
  const deletedKvValues: Array<string> = [];
  let removedRoutes = 0;
  const fake = {
    deleted,
    emptiedBuckets,
    preservedBucketKeys,
    deletedBucketMarkers,
    remoteWrites,
    disabledWrites,
    deletedKvValues,
    get removedRoutes() {
      return removedRoutes;
    },
    deleteResource: async (_account: string, kind: string, id: string): Promise<void> => {
      // Like Cloudflare, refuse to delete a Queue while a platform Worker
      // still binds it.
      const bindingWorker = (await fake.listWorkerNames())[0];
      if (kind === 'queue' && bindingWorker) {
        throw new Error(
          `Cloudflare API error: Cannot delete queue '${id}' that is still referenced by a binding in a Worker. Unbind queue '${id}' from the Workers '${bindingWorker}'; then try again. (HTTP 400)`,
        );
      }
      deleted.push([kind, id]);
    },
    deleteKvValue: async (_account: string, _namespace: string, key: string) => {
      deletedKvValues.push(key);
    },
    deleteR2Object: async (_account: string, bucket: string) => {
      deletedBucketMarkers.push(bucket);
    },
    emptyR2Bucket: async (
      _account: string,
      bucket: string,
      preservedKeys?: ReadonlySet<string>,
    ) => {
      emptiedBuckets.push(bucket);
      preservedBucketKeys.push([...(preservedKeys ?? [])]);
    },
    findZone: async (_account: string, name: string) => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'zone' && entry.name === name && entry.state === 'ready',
      );
      return resource
        ? { id: resource.id, name: resource.name, nameServers: [], status: 'active' }
        : null;
    },
    getHyperdriveConfig: async (_account: string, id: string) => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'hyperdrive' && entry.id === id && entry.state === 'ready',
      );
      if (!resource) {
        throw new Error('missing Hyperdrive');
      }
      return {
        id: resource.id,
        name: resource.name,
        origin: {
          database: 'void',
          host: 'db.example.com',
          port: 5432,
          scheme: 'postgresql' as const,
          user: 'user',
        },
      };
    },
    getKvValue: async (): Promise<string | null> => JSON.stringify(manifest),
    getR2Object: async () => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'r2-bucket' && entry.state === 'ready',
      );
      return resource ? ownershipMarker(manifest, resource) : null;
    },
    getWorkerPlainTextBindings: async (
      _account: string,
      name: string,
    ): Promise<Record<string, string>> => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name && entry.state === 'ready',
      );
      if (!resource) {
        return {};
      }
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    },
    listAiGateways: async () => namedResources(manifest, 'ai-gateway'),
    listDispatchNamespaces: async () => namedResources(manifest, 'dispatch-namespace'),
    listDnsRecords: async (_zone: string, name: string) =>
      namedResources(manifest, 'dns-record')
        .filter((resource) => resource.name === name)
        .map((resource) => ({ ...resource, content: '100::', proxied: true, type: 'AAAA' })),
    listHyperdriveConfigs: async () => namedResources(manifest, 'hyperdrive'),
    listKvNamespaces: async () => namedResources(manifest, 'kv-namespace'),
    listQueues: async (_account: string, name: string) =>
      namedResources(manifest, 'queue').filter((resource) => resource.name === name),
    listR2Buckets: async () =>
      namedResources(manifest, 'r2-bucket').map((resource) => ({
        ...resource,
        fingerprint: '2026-09-14T00:00:00.000Z',
      })),
    listWorkerDomains: async (): Promise<
      Array<{ hostname: string; id: string; service: string }>
    > => [],
    listWorkerNames: async () =>
      namedResources(manifest, 'worker').map((resource) => resource.name),
    listWorkerServiceRoutes: async (
      _accountId: string,
      _workerName: string,
    ): Promise<Array<{ pattern: string; zoneName: string }>> => [],
    putKvValue: async (_account: string, _namespace: string, key: string, value: string) => {
      if (key === PLATFORM_DISABLED_KEY) {
        disabledWrites.push(value);
      } else {
        remoteWrites.push(value);
      }
    },
    removeRoutes: async (_account: string, _zone: string | null, _managed: unknown) => {
      removedRoutes++;
    },
  };
  return fake;
}

function namedResources(manifest: PlatformInstallationManifest, kind: InstallationResourceKind) {
  return manifest.resources
    .filter((resource) => resource.kind === kind && resource.state === 'ready')
    .map((resource) => ({ id: resource.id, name: resource.name }));
}

function ownershipMarker(
  manifest: PlatformInstallationManifest,
  resource: PlatformInstallationManifest['resources'][number],
): string {
  return JSON.stringify(
    createPlatformResourceOwnershipMarker({
      accountId: manifest.account.id,
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      resourceId: resource.id,
      resourceKey: resource.key,
      resourceKind: resource.kind,
      resourceName: resource.name,
    }),
  );
}

const uninstallArgs = {
  subcommand: 'uninstall' as const,
  selector: '',
  plan: false,
  purgeData: false,
  deleteZone: null,
  yes: true,
};

describe('platform lifecycle management', () => {
  it('preflights only a runtime token that will be applied', () => {
    const updatePlan = {
      actions: [{ action: 'update', key: 'api-worker', kind: 'worker' }],
    };
    expect(
      resolvePlatformRuntimeTokenToPreflight(updatePlan, {
        cloudflareApiToken: 'stale-checkpoint-token',
        workerSecretUpdates: {},
      }),
    ).toBe('');
    expect(
      resolvePlatformRuntimeTokenToPreflight(updatePlan, {
        cloudflareApiToken: 'stale-checkpoint-token',
        workerSecretUpdates: { CF_API_TOKEN: 'explicit-rotation-token' },
      }),
    ).toBe('explicit-rotation-token');
    expect(
      resolvePlatformRuntimeTokenToPreflight(
        { actions: [{ action: 'create', key: 'api-worker', kind: 'worker' }] },
        {
          cloudflareApiToken: 'recovery-token',
          workerSecretUpdates: {},
        },
      ),
    ).toBe('recovery-token');
    expect(
      resolvePlatformRuntimeTokenToPreflight(
        { actions: [{ action: 'create', key: 'email-gateway-worker', kind: 'worker' }] },
        {
          cloudflareApiToken: 'stale-checkpoint-token',
          workerSecretUpdates: {},
        },
      ),
    ).toBe('');
  });

  it('requires explicit acknowledgement for a non-interactive uninstall', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);

    await expect(
      uninstallPlatform(fake, manifest, { ...uninstallArgs, yes: false }, { interactive: false }),
    ).rejects.toThrow('requires --yes');
    expect(fake.deleted).toEqual([]);
    expect(fake.removedRoutes).toBe(0);
  });

  it('prompts for an installation when a lifecycle selector is omitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-management-selection-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const first = installedManifest();
    const second = {
      ...installedManifest(),
      deployment: {
        ...installedManifest().deployment,
        displayName: 'Second',
        installationSlug: 'second',
      },
      id: 'second-b2c3d4e5',
    };
    writeInstallationManifest(first);
    writeInstallationManifest(second);

    await expect(
      resolveInstalledPlatformManifest('', {
        interactive: true,
        selectInstallation: async (manifests) => {
          expect(manifests.map((manifest) => manifest.id)).toEqual([first.id, second.id]);
          return second.id;
        },
      }),
    ).resolves.toMatchObject({ id: second.id });
    await expect(resolveInstalledPlatformManifest('', { interactive: false })).rejects.toThrow(
      'specify an installation id',
    );
  });

  it('retries an eventually consistent ownership checkpoint before mutation', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'api-worker'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    let reads = 0;
    fake.getKvValue = async () => JSON.stringify(++reads === 1 ? stale : manifest);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('rejects Hyperdrive origin drift from the pinned lifecycle database', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getHyperdriveConfig = async (_account: string, id: string) => ({
      id,
      name: 'hyperdrive',
      origin: {
        database: 'replacement',
        host: 'db2.example.com',
        port: 5432,
        scheme: 'postgresql' as const,
        user: 'user',
      },
    });

    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        databaseUrl: 'postgres://user:secret@db.example.com/void',
      }),
    ).rejects.toThrow('different PostgreSQL origin');
  });

  it('allows authoritative repair to recreate a confirmed-missing routing checkpoint', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;
    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote installation checkpoint is missing',
    );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowMissingRoutingCheckpoint: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('restores an uninitialized live routing checkpoint only from database authority', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote installation checkpoint is missing',
    );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowUninitializedRoutingCheckpoint: true,
      }),
    ).resolves.toBeUndefined();

    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').map((resource) =>
        resource.id === 'routing-kv-id' ? { ...resource, id: 'replacement-id' } : resource,
      );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowUninitializedRoutingCheckpoint: true,
      }),
    ).rejects.toThrow('remote installation checkpoint is missing');
  });

  it('still rejects a replacement R2 bucket while repairing a missing routing checkpoint', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;
    fake.getR2Object = async () => null;
    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );

    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowMissingRoutingCheckpoint: true,
      }),
    ).rejects.toThrow('r2-bucket assets-bucket has no ownership marker');
  });

  it('rejects an R2 bucket whose live creation fingerprint changed', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.listR2Buckets = async () =>
      namedResources(manifest, 'r2-bucket').map((resource) => ({
        ...resource,
        fingerprint: '2026-09-14T00:00:02.000Z',
      }));

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'r2-bucket assets-bucket changed creation fingerprint',
    );
  });

  it('accepts a live immutable resource recorded ahead of stale routing KV', async () => {
    let manifest = installedManifest();
    const resource = manifest.resources.find((entry) => entry.key === 'isr-cache-kv')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `provision-intent:${resource.key}`,
      resultHash: platformProvisionIntentHash(manifest, resource.key, resource.kind, resource.name),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((resource) => resource.key !== 'isr-cache-kv'),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
  });

  it('rejects a locally appended live resource without a remote provision intent', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'cron-queue'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote checkpoint does not own queue cron-queue',
    );
  });

  it('accepts an exact adopted resource recorded ahead of its remote checkpoint', async () => {
    let manifest = installedManifest('adopted');
    const resource = manifest.resources.find((entry) => entry.key === 'zone')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `adoption-intent:${resource.key}`,
      resultHash: platformAdoptionIntentHash(
        manifest,
        resource.key,
        resource.kind,
        resource.id,
        resource.name,
      ),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((entry) => entry.key !== resource.key),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
  });

  it('rejects an adopted resource id changed after its remote intent', async () => {
    let manifest = installedManifest('adopted');
    const resource = manifest.resources.find((entry) => entry.key === 'zone')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `adoption-intent:${resource.key}`,
      resultHash: platformAdoptionIntentHash(
        manifest,
        resource.key,
        resource.kind,
        resource.id,
        resource.name,
      ),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((entry) => entry.key !== resource.key),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const changed = {
      ...manifest,
      resources: manifest.resources.map((entry) =>
        entry.key === resource.key ? { ...entry, id: 'replacement-zone-id' } : entry,
      ),
    };
    const fake = client(changed);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, changed)).rejects.toThrow(
      'remote checkpoint does not own zone zone',
    );
  });

  it('never recovers a reusable AI Gateway name from stale routing KV', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'ai-gateway'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'does not own ai-gateway',
    );
  });

  it('refuses to resume installation over a replacement Worker', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getWorkerPlainTextBindings = async () => ({});

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'has no ownership marker',
    );
  });

  it('refuses to resume installation into a replacement R2 bucket', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getR2Object = async () => null;

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'has no ownership marker',
    );
  });

  it('disables routes without deleting resources', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    const databaseCheckpoints: Array<PlatformInstallationManifest> = [];
    await disablePlatform(fake, manifest, false, {
      checkpoint: async (checkpoint) => {
        databaseCheckpoints.push(checkpoint);
      },
    });
    expect(fake.removedRoutes).toBe(1);
    expect(fake.disabledWrites).toEqual([PLATFORM_DISABLED_VALUE]);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
    expect(JSON.parse(fake.remoteWrites[0]!)).toMatchObject({ status: 'disabling' });
    expect(JSON.parse(fake.remoteWrites.at(-1)!)).toMatchObject({ status: 'disabled' });
    expect(databaseCheckpoints.at(-1)?.status).toBe('disabled');
  });

  it('selects cross-host disabled and uninstalled state over a stale local manifest', () => {
    const local = installedManifest();
    const disabled = { ...local, desiredState: 'disabled' as const, status: 'disabled' as const };
    const uninstalled = { ...disabled, status: 'uninstalled' as const };

    expect(selectAuthoritativePlatformManifest(local, disabled)).toBe(disabled);
    expect(selectAuthoritativePlatformManifest(local, uninstalled)).toBe(uninstalled);
  });

  it('removes public endpoints again after a platform is re-enabled', async () => {
    let manifest = installedManifest();
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'traffic-enabled:1',
        resultHash: '1',
      },
      '2026-09-14T00:00:03.000Z',
    );
    persist(manifest);
    const first = client(manifest);
    await disablePlatform(first, manifest, false);

    let reenabled = listInstallationManifests()[0]!;
    reenabled = recordInstallationStep(
      reenabled,
      {
        completedAt: '2026-09-14T00:00:04.000Z',
        key: 'traffic-enabled:2',
        resultHash: '2',
      },
      '2026-09-14T00:00:04.000Z',
    );
    reenabled = { ...reenabled, desiredState: 'enabled', status: 'installed' };
    writeInstallationManifest(reenabled);

    const second = client(reenabled);
    await disablePlatform(second, reenabled, false);
    expect(second.removedRoutes).toBe(1);
    expect(second.disabledWrites).toHaveLength(1);
  });

  it('disables public Workers from an interrupted deployment', async () => {
    const manifest = { ...installedManifest(), status: 'deploying' as const };
    persist(manifest);
    const fake = client(manifest);

    await disablePlatform(fake, manifest, false);

    expect(fake.removedRoutes).toBe(1);
    expect(fake.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('uses routing storage when one recorded Worker is missing', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.listWorkerNames = async () => ['api-worker', 'proxy-worker', 'tail-worker'];

    await disablePlatform(fake, manifest, false);

    expect(fake.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables workers.dev through routing storage when the recorded zone is missing', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.findZone = async () => null;
    let routeZone: string | null | undefined;
    fake.removeRoutes = async (_account, zone) => {
      routeZone = zone;
    };

    await disablePlatform(fake, manifest, false);

    expect(routeZone).toBeNull();
    expect(fake.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables a marked Worker deployed before its local resource checkpoint', async () => {
    let manifest = installedManifest();
    const recordedApi = manifest.resources.find((resource) => resource.key === 'api-worker')!;
    const api = {
      ...recordedApi,
      id: manifest.deployment.resources.apiWorker,
      name: manifest.deployment.resources.apiWorker,
    };
    manifest = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'api-worker'),
      status: 'deploying',
    };
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, api.key, api.kind, api.name),
      },
      '2026-09-14T00:00:03.000Z',
    );
    persist(manifest);
    const fake = client(manifest);
    fake.listWorkerNames = async () => [
      api.name,
      ...manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.name),
    ];
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource =
        name === api.name
          ? api
          : manifest.resources.find((entry) => entry.kind === 'worker' && entry.name === name)!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    };

    await disablePlatform(fake, manifest, false);

    expect(fake.disabledWrites).toHaveLength(1);
    expect(
      listInstallationManifests()[0]?.resources.find((resource) => resource.key === api.key),
    ).toMatchObject({
      id: api.id,
      kind: api.kind,
      name: api.name,
      ownership: 'created',
      state: 'ready',
    });
  });

  it('retains installer-owned data and the zone by default', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
    });
    expect(fake.deleted).toEqual([]);
    expect(fake.deleted.some(([kind]) => kind === 'zone')).toBe(false);
    const result = listInstallationManifests()[0]!;
    expect(result.status).toBe('uninstalled');
    expect(result.resources.find((resource) => resource.key === 'zone')?.state).toBe('retained');
    expect(readInstallationRecoverySecrets(result)).toEqual({
      databaseUrl: 'postgres://recovery',
    });
  });

  it('retains observed traffic attachments when disabling', async () => {
    let manifest = installedManifest();
    const dispatchWorker = manifest.deployment.resources.dispatchWorker;
    manifest = recordPlatformWorkerTraffic(
      manifest,
      dispatchWorker,
      {
        customDomains: [],
        routes: [
          {
            id: 'route-one',
            pattern: '*.apps.example.com/*',
            script: dispatchWorker,
          },
          {
            id: 'route-two',
            pattern: '*.apps.example.com',
            script: dispatchWorker,
          },
        ],
      },
      '2026-09-14T00:00:03.000Z',
    );
    persist(manifest);
    const fake = client(manifest);
    let removed: unknown;
    fake.removeRoutes = async (_account: string, _zone: string | null, traffic: unknown) => {
      removed = traffic;
    };

    await disablePlatform(fake, manifest, false);

    expect(removed).toEqual({ customDomains: [], routes: [] });
    expect(
      listInstallationManifests()[0]
        ?.resources.filter((resource) => resource.kind === 'worker-route')
        .map((resource) => resource.state),
    ).toEqual(['retained', 'retained']);
  });

  it('retains Workers and their unmanaged traffic for manual cleanup', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.listWorkerServiceRoutes = async (_accountId: string, workerName: string) =>
      workerName === 'api-worker'
        ? [
            {
              pattern: 'manual.other.example/*',
              zoneName: 'other.example',
            },
          ]
        : [];
    fake.listWorkerDomains = async () => [
      { hostname: 'manual.example.com', id: 'manual-domain', service: 'proxy-worker' },
    ];

    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });

    expect(fake.deleted.some(([kind]) => kind === 'worker')).toBe(false);
    expect(fake.removedRoutes).toBe(4);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('retains an installer DNS record even when it was repurposed', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.listDnsRecords = async (_zone: string, name: string) =>
      namedResources(manifest, 'dns-record')
        .filter((resource) => resource.name === name)
        .map((resource) => ({
          ...resource,
          content: 'origin.unrelated.example',
          proxied: false,
          type: 'CNAME',
        }));

    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });

    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(
      listInstallationManifests()[0]?.resources.find(
        (resource) => resource.key === 'application-dns',
      ),
    ).toMatchObject({ state: 'retained' });
  });

  it('records the completed uninstall in retained routing storage', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
    });
    expect(fake.deleted).toEqual([]);
    expect(fake.remoteWrites.map((value) => JSON.parse(value).status)).toContain('uninstalled');
    const retained = listInstallationManifests()[0]!.resources.filter(
      (resource) => resource.state === 'retained',
    );
    expect(retained).toHaveLength(15);
  });

  it('refuses automatic deletion of an installer-created zone', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);

    await expect(
      uninstallPlatform(
        fake,
        manifest,
        { ...uninstallArgs, deleteZone: true },
        { interactive: false },
      ),
    ).rejects.toThrow('Refusing to delete Cloudflare zone');
    expect(fake.deleted).toEqual([]);
    expect(fake.removedRoutes).toBe(0);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('purges installer-owned data while never deleting an adopted zone', async () => {
    const manifest = installedManifest('adopted');
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true, deleteZone: true },
      {
        interactive: false,
      },
    );
    expect(fake.deleted).toHaveLength(5);
    expect(fake.deleted.some(([kind]) => kind === 'queue')).toBe(false);
    expect(fake.deleted).not.toContainEqual(['ai-gateway', 'ai-gateway-id']);
    expect(fake.emptiedBuckets).toEqual([]);
    expect(fake.preservedBucketKeys).toEqual([]);
    expect(fake.deletedBucketMarkers).toEqual([]);
    expect(fake.deleted).not.toContainEqual(['r2-bucket', 'assets-bucket-id']);
    expect(fake.deleted.some(([kind]) => kind === 'zone')).toBe(false);
    expect(readInstallationRecoverySecrets(listInstallationManifests()[0]!)).toBeNull();
  });

  it('retains R2 during purge because bucket generation cannot be pinned', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );
    expect(fake.emptiedBuckets).toEqual([]);
    expect(fake.deletedBucketMarkers).toEqual([]);
    expect(fake.deleted).not.toContainEqual(['r2-bucket', 'assets-bucket-id']);
    expect(
      listInstallationManifests()[0]?.resources.find((resource) => resource.key === 'assets-bucket')
        ?.state,
    ).toBe('retained');
  });

  it('refuses every mutation when the remote installation identity changed', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.getKvValue = async () =>
      JSON.stringify({ ...manifest, ownershipNonce: 'different-ownership-nonce-000000' });

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false }),
    ).rejects.toThrow('remote installation identity does not match');
    expect(fake.removedRoutes).toBe(0);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('refuses to delete a replacement Worker with a reused name', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    const replacement = {
      ...manifest,
      ownershipNonce: 'replacement-owner-nonce-00000000',
    };
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource = replacement.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name,
      )!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(replacement, resource) };
    };

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false }),
    ).rejects.toThrow('belongs to another installation');
    expect(fake.removedRoutes).toBe(0);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('does not inspect or mutate R2 during purge', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.getR2Object = async () => null;

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );
    expect(fake.emptiedBuckets).toEqual([]);
    expect(fake.deleted).not.toContainEqual(['r2-bucket', 'assets-bucket-id']);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('resumes safely after a deletion failure without retrying completed deletions', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account, kind, id) => {
      if (kind === 'dispatch-namespace') {
        throw new Error('temporary deletion failure');
      }
      await originalDelete(account, kind, id);
    };
    await expect(
      uninstallPlatform(
        first,
        manifest,
        { ...uninstallArgs, purgeData: true },
        { interactive: false },
      ),
    ).rejects.toThrow('temporary deletion failure');
    const checkpoint = listInstallationManifests()[0]!;
    expect(checkpoint.status).toBe('failed');
    expect(checkpoint.resources.filter((resource) => resource.state === 'deleted')).toHaveLength(0);

    const second = client(checkpoint);
    await uninstallPlatform(
      second,
      checkpoint,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );
    expect(second.deleted.filter(([kind]) => kind === 'worker')).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('retains Queues that retained Workers still use', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );

    expect(fake.deleted.some(([kind]) => kind === 'queue')).toBe(false);
    const result = listInstallationManifests()[0]!;
    expect(result.status).toBe('uninstalled');
    expect(
      result.resources
        .filter((resource) => resource.kind === 'queue')
        .map((resource) => resource.state),
    ).toEqual(['retained', 'retained']);
  });

  it('finishes an uninstall that stopped on a Queue still bound to a retained Worker', async () => {
    let manifest = installedManifest();
    manifest = transitionInstallation(manifest, 'uninstalling', '2026-09-14T00:00:03.000Z');
    manifest = transitionInstallation(
      {
        ...manifest,
        resources: manifest.resources.map((resource) =>
          resource.kind === 'worker' ? { ...resource, state: 'retained' as const } : resource,
        ),
      },
      'failed',
      '2026-09-14T00:00:04.000Z',
    );
    persist(manifest);
    const fake = client(manifest);
    fake.listWorkerNames = async () =>
      manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.name);

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );

    expect(fake.deleted.some(([kind]) => kind === 'queue')).toBe(false);
    const result = listInstallationManifests()[0]!;
    expect(result.status).toBe('uninstalled');
    expect(
      result.resources
        .filter((resource) => resource.kind === 'queue')
        .map((resource) => resource.state),
    ).toEqual(['retained', 'retained']);
  });

  it('deletes Queues once no installation Worker remains', async () => {
    const installed = installedManifest();
    const manifest = {
      ...installed,
      resources: installed.resources.filter((resource) => resource.kind !== 'worker'),
    };
    persist(manifest);
    const fake = client(manifest);

    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });

    expect(fake.deleted).toEqual([
      ['queue', 'cron-queue-id'],
      ['queue', 'usage-queue-id'],
    ]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('resumes a purge after the final routing checkpoint was ambiguously deleted', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account, kind, id) => {
      await originalDelete(account, kind, id);
      if (kind === 'kv-namespace' && id === 'routing-kv-id') {
        throw new Error('connection closed after routing deletion');
      }
    };
    await expect(
      uninstallPlatform(
        first,
        manifest,
        { ...uninstallArgs, purgeData: true },
        { interactive: false },
      ),
    ).rejects.toThrow('connection closed after routing deletion');
    const checkpoint = listInstallationManifests()[0]!;
    expect(checkpoint.status).toBe('failed');
    expect(checkpoint.resources.find((resource) => resource.key === 'routing-kv')?.state).toBe(
      'ready',
    );
    expect(
      checkpoint.resources.every(
        (resource) => resource.key === 'routing-kv' || resource.state !== 'ready',
      ),
    ).toBe(true);

    const second = client(checkpoint);
    second.getKvValue = async () => null;
    second.listKvNamespaces = async () =>
      namedResources(checkpoint, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );
    await uninstallPlatform(
      second,
      checkpoint,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );
    expect(second.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('cleans up a partial installation without PostgreSQL or a recorded zone', async () => {
    const manifest = {
      ...installedManifest(),
      resources: installedManifest().resources.filter((resource) => resource.key !== 'zone'),
    };
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });
    expect(fake.removedRoutes).toBe(0);
    expect(fake.deleted.some(([kind]) => kind === 'worker')).toBe(false);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(
      listInstallationManifests()[0]?.resources.find(
        (resource) => resource.key === 'application-dns',
      )?.state,
    ).toBe('retained');
  });

  it('safely uninstalls a DNS-wait checkpoint created before routing storage', async () => {
    const manifest = {
      ...installedManifest(),
      endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
      resources: installedManifest().resources.filter((resource) => resource.key === 'zone'),
      status: 'waiting-for-dns' as const,
    };
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]).toMatchObject({ status: 'uninstalled' });
    expect(listInstallationManifests()[0]!.resources[0]).toMatchObject({ state: 'retained' });
  });

  it('resumes after routes were removed but remote disable checkpointing failed', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    first.putKvValue = async () => {
      throw new Error('temporary KV failure');
    };
    await expect(disablePlatform(first, manifest, false)).rejects.toThrow('temporary KV failure');
    expect(listInstallationManifests()[0]?.status).toBe('failed');

    const failed = listInstallationManifests()[0]!;
    const second = client(failed);
    await disablePlatform(second, failed, false);
    expect(second.removedRoutes).toBe(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('reasserts every public endpoint when disabling an already-disabled installation', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    await disablePlatform(first, manifest, false);

    const disabled = listInstallationManifests()[0]!;
    const second = client(disabled);
    await disablePlatform(second, disabled, false);

    expect(second.removedRoutes).toBe(1);
    expect(second.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });
});
