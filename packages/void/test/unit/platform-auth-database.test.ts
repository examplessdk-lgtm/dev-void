import type { InstallationResource } from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  verifyExternalPlatformHyperdrive,
  verifyPlatformAuthenticationDatabase,
} from '../../src/cli/platform-auth-database.ts';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';

const databaseUrl = 'postgresql://user:password@db.example.com/platform';
const resource: InstallationResource = {
  key: 'hyperdrive',
  kind: 'hyperdrive',
  id: 'database',
  name: 'void-platform-db',
  ownership: 'created',
  state: 'ready',
  configHash: 'hash',
};
const config = {
  id: resource.id,
  name: resource.name,
  origin: hyperdriveOriginFromConnectionString(databaseUrl),
  cachingDisabled: true,
};

describe('fresh platform authentication database reads', () => {
  it('pins an uncached Terraform-managed origin while migrations use the owner connection', async () => {
    const ownerDatabaseUrl = `${databaseUrl}?sslmode=disable`;
    const external = {
      ...config,
      origin: {
        ...config.origin,
        host: 'hyperdrive-productiondb.databases.cfdata.org/itdb/primary',
        user: 'hyperdrive_void_platform_service',
      },
    };
    const hash = verifyExternalPlatformHyperdrive({
      config: external,
      databaseUrl: ownerDatabaseUrl,
      expected: {
        id: resource.id,
        name: resource.name,
        host: external.origin.host,
        user: external.origin.user,
      },
    });
    expect(hash).toBe(hyperdriveOriginConfigHash(external.origin));
    const client = {
      getHyperdriveConfig: vi.fn(async () => external),
      disableHyperdriveCaching: vi.fn(),
    };
    await verifyPlatformAuthenticationDatabase(
      client,
      'account',
      { ...resource, ownership: 'adopted', configHash: hash },
      ownerDatabaseUrl,
    );
    expect(client.disableHyperdriveCaching).not.toHaveBeenCalled();
    expect(() =>
      verifyExternalPlatformHyperdrive({
        config: { ...external, origin: { ...external.origin, database: 'other' } },
        databaseUrl: ownerDatabaseUrl,
        expected: {
          id: resource.id,
          name: resource.name,
          host: external.origin.host,
          user: external.origin.user,
        },
      }),
    ).toThrow('expected database origin');
    await expect(
      verifyPlatformAuthenticationDatabase(
        client,
        'account',
        { ...resource, ownership: 'adopted', configHash: '0'.repeat(64) },
        ownerDatabaseUrl,
      ),
    ).rejects.toThrow('pinned database');
  });
  it('accepts a verified uncached database without changing it', async () => {
    const client = {
      getHyperdriveConfig: vi.fn(async () => config),
      disableHyperdriveCaching: vi.fn(),
    };
    await verifyPlatformAuthenticationDatabase(client, 'account', resource, databaseUrl);
    expect(client.disableHyperdriveCaching).not.toHaveBeenCalled();
  });
  it('disables caching only on owned resources and verifies the resulting configuration', async () => {
    const client = {
      getHyperdriveConfig: vi
        .fn()
        .mockResolvedValueOnce({ ...config, cachingDisabled: false })
        .mockResolvedValueOnce(config),
      disableHyperdriveCaching: vi.fn(),
    };
    await verifyPlatformAuthenticationDatabase(client, 'account', resource, databaseUrl);
    expect(client.disableHyperdriveCaching).toHaveBeenCalledExactlyOnceWith('account', 'database');
    expect(client.getHyperdriveConfig).toHaveBeenCalledTimes(2);
  });
  it('refuses to mutate adopted resources or a connection pointed at another database', async () => {
    const client = {
      getHyperdriveConfig: vi.fn(async () => ({ ...config, cachingDisabled: false })),
      disableHyperdriveCaching: vi.fn(),
    };
    await expect(
      verifyPlatformAuthenticationDatabase(
        client,
        'account',
        {
          ...resource,
          ownership: 'adopted',
          configHash: hyperdriveOriginConfigHash(config.origin),
        },
        databaseUrl,
      ),
    ).rejects.toThrow('by its owner');
    await expect(
      verifyPlatformAuthenticationDatabase(
        client,
        'account',
        resource,
        'postgresql://user:password@another.example.com/platform',
      ),
    ).rejects.toThrow('pinned database');
    expect(client.disableHyperdriveCaching).not.toHaveBeenCalled();
  });
  it('fails closed when the API accepts an update without actually disabling caching', async () => {
    const client = {
      getHyperdriveConfig: vi.fn(async () => ({ ...config, cachingDisabled: false })),
      disableHyperdriveCaching: vi.fn(),
    };
    await expect(
      verifyPlatformAuthenticationDatabase(client, 'account', resource, databaseUrl),
    ).rejects.toThrow('Could not verify');
    expect(client.disableHyperdriveCaching).toHaveBeenCalledTimes(1);
  });
  it('changes only the Hyperdrive cache policy without resending database credentials', async () => {
    const calls: Array<{ method?: string; body: unknown }> = [];
    const client = new PlatformCloudflareClient('management-token', {
      fetcher: async (_url, options) => {
        calls.push({
          method: options?.method,
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
        });
        return Response.json({ success: true, result: {} });
      },
    });
    await client.disableHyperdriveCaching('account', 'database');
    expect(calls).toEqual([{ method: 'PATCH', body: { caching: { disabled: true } } }]);
  });
});
