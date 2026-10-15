/**
 * Hostless `v2` ISR keys: `<proj>/isr/v2/<D>/<path>[#rw=<token>]`. Dispatch
 * writes only host-scoped `v3` keys, so these exist only to purge old entries.
 * Transition-only: delete this module once hosted production holds no `v2` keys.
 */
import { normalizeIsrPath } from '@void/isr';

/** Prefix for listing/purging a deployment's `v2` keys. */
export function legacyIsrCachePrefix(projectId: string, deploymentId: string): string {
  return `${projectId}/isr/v2/${deploymentId}/`;
}

/** `v2` direct-hit key for a pathname. */
export function legacyIsrCacheKey(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${legacyIsrCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}`;
}

/** Prefix for listing/purging the `#rw=` variant keys of a pathname under `v2`. */
export function legacyIsrCacheVariantPrefix(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${legacyIsrCacheKey(projectId, deploymentId, pathname)}#rw=`;
}
