import { parsePlatformResourceOwnershipMarker } from '@void/platform';

/** Attribute infrastructure uploads using the installer's existing ownership proof. */
export function platformWorkerUploadAttribution(
  config: Record<string, unknown>,
): string | undefined {
  const vars = config.vars as Record<string, unknown> | undefined;
  if (typeof vars?.PLATFORM_OWNERSHIP_MARKER !== 'string') {
    return undefined;
  }
  try {
    const marker = parsePlatformResourceOwnershipMarker(JSON.parse(vars.PLATFORM_OWNERSHIP_MARKER));
    if (
      marker.resourceKind !== 'worker' ||
      marker.accountId !== config.account_id ||
      marker.resourceName !== config.name ||
      ![
        'api-worker',
        'proxy-worker',
        'dispatch-worker',
        'tail-worker',
        'email-gateway-worker',
      ].includes(marker.resourceKey)
    ) {
      return undefined;
    }
    const version = typeof vars.PLATFORM_VERSION === 'string' ? vars.PLATFORM_VERSION : 'unknown';
    // Keep each field one token. Never include the ownership nonce in request headers.
    return `void-platform-install/${encodeURIComponent(version)} void-role/${marker.resourceKey} void-installation/${encodeURIComponent(marker.installationId)}`;
  } catch {
    // Attribution cannot make an otherwise valid upload fail.
    return undefined;
  }
}
