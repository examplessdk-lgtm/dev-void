import type { InstallationResource } from '@void/platform';
import {
  hyperdriveOriginFromConnectionString,
  hyperdriveOriginMatches,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';

/** Authentication requires fresh reads; mutate only the installation-owned configuration. */
export async function verifyPlatformAuthenticationDatabase(
  client: Pick<PlatformCloudflareClient, 'getHyperdriveConfig' | 'disableHyperdriveCaching'>,
  accountId: string,
  resource: InstallationResource,
  databaseUrl: string,
): Promise<void> {
  if (
    resource.kind !== 'hyperdrive' ||
    resource.key !== 'hyperdrive' ||
    resource.state !== 'ready'
  ) {
    throw new Error(
      'platform: Authentication database verification requires the platform Hyperdrive resource.',
    );
  }
  const expected = hyperdriveOriginFromConnectionString(databaseUrl);
  const read = async () => {
    const current = await client.getHyperdriveConfig(accountId, resource.id);
    if (
      current.id !== resource.id ||
      current.name !== resource.name ||
      !hyperdriveOriginMatches(current.origin, expected)
    ) {
      throw new Error(
        'platform: Hyperdrive does not match this installation’s pinned database. No authentication configuration was activated.',
      );
    }
    return current;
  };
  if ((await read()).cachingDisabled === true) {
    return;
  }
  if (resource.ownership !== 'created') {
    throw new Error(
      'platform: The adopted Hyperdrive must have SQL result caching disabled by its owner before authentication can be configured.',
    );
  }
  await client.disableHyperdriveCaching(accountId, resource.id);
  if ((await read()).cachingDisabled !== true) {
    throw new Error(
      'platform: Could not verify uncached Hyperdrive reads. Authentication setup remains closed.',
    );
  }
}
