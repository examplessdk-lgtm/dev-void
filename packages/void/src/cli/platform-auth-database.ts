import type { InstallationResource } from '@void/platform';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  hyperdriveOriginMatches,
  type CloudflareHyperdriveConfig,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';

/** Pin an externally managed Hyperdrive without treating the owner URL as its runtime origin. */
export function verifyExternalPlatformHyperdrive(input: {
  config: CloudflareHyperdriveConfig;
  databaseUrl: string;
  expected: { id: string; name: string; host: string; user: string };
  recordedHash?: string;
}): string {
  const { config, expected } = input;
  const database = hyperdriveOriginFromConnectionString(input.databaseUrl).database;
  const hash = hyperdriveOriginConfigHash(config.origin);
  if (
    config.id !== expected.id ||
    config.name !== expected.name ||
    config.origin.host !== expected.host.toLowerCase() ||
    config.origin.user !== expected.user ||
    config.origin.database !== database ||
    (input.recordedHash && input.recordedHash !== hash)
  ) {
    throw new Error(
      'platform: The Terraform-managed Hyperdrive does not match the expected database origin.',
    );
  }
  if (config.cachingDisabled !== true) {
    throw new Error(
      'platform: Disable SQL result caching on the Terraform-managed Hyperdrive before installing.',
    );
  }
  return hash;
}

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
      (resource.ownership === 'adopted'
        ? current.origin.database !== expected.database ||
          hyperdriveOriginConfigHash(current.origin) !== resource.configHash
        : !hyperdriveOriginMatches(current.origin, expected))
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
