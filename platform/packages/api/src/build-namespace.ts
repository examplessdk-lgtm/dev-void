import type { ApiEnv } from './env.ts';
import { BUILD_INSTANCE_LARGE } from './tiers.ts';

/**
 * Picks the BuildManager DO namespace (and thus the container size) for a build
 * from its persisted instance_type.
 *
 * `@cloudflare/containers` has no per-start sizing, so each size is a distinct
 * container-enabled DO class with a fixed `instance_type` in wrangler.jsonc.
 * Routing is therefore just a string match on the build's recorded size:
 *
 *   - `BUILD_INSTANCE_LARGE` (`standard-4`, paid) → `BUILD_MANAGER_LARGE`
 *   - everything else → the base `BUILD_MANAGER` (free `standard-3`)
 *
 * The base namespace is the safe, cheaper default and where any legacy build
 * actually runs: free (`standard-3`), legacy sizes (`standard-1`/`standard-2`),
 * and null/unknown values all resolve there. Only an exact `standard-4` match
 * routes to the large class,
 * so an unrecognized or missing instance_type never accidentally lands a build
 * on the bigger (more expensive) container.
 */
export function buildManagerNamespace(
  env: ApiEnv['Bindings'],
  instanceType: string | null | undefined,
): DurableObjectNamespace {
  return instanceType === BUILD_INSTANCE_LARGE ? env.BUILD_MANAGER_LARGE : env.BUILD_MANAGER;
}
