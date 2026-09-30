import type { PlanLimits } from './tiers.ts';
import type { DeployManifest } from './types.ts';

/**
 * Compute the `dispatchLimits` blob `buildRoutingJson` embeds in a routing
 * entry, honoring an optional per-project `manifest.limits.cpuMs` override.
 *
 * - Override present: clamp to the plan's `maxCpuMsPerRequest` when that
 *   ceiling is non-zero (rollback under a downgraded plan clamps, never
 *   rejects — ingest is where over-ceiling requests get a 400), otherwise
 *   pass it through verbatim.
 * - No override: fall back to the plan default `cpuMsPerRequest` (0 = no
 *   cpuMs key), byte-identical in shape to the historical inline expression.
 * - An override that is not a safe integer >= 1 is treated as absent and
 *   falls back to the plan default. A rollback replays a stored manifest,
 *   and a manifest stored before ingest validated `limits` can carry an
 *   out-of-domain value that must not erase or corrupt the plan cap.
 * - `subRequests` always comes from the plan (0 = no key).
 *
 * Returns `null` when neither limit is set so the routing entry omits the
 * `limits` key entirely.
 */
export function computeDispatchLimits(
  planLimits: PlanLimits,
  manifestLimits: DeployManifest['limits'] | null | undefined,
): { cpuMs?: number; subRequests?: number } | null {
  const rawRequested = manifestLimits?.cpuMs;
  const requested =
    typeof rawRequested === 'number' && Number.isSafeInteger(rawRequested) && rawRequested >= 1
      ? rawRequested
      : undefined;
  const max = planLimits.maxCpuMsPerRequest;
  const cpuMs =
    requested !== undefined
      ? max > 0
        ? Math.min(requested, max)
        : requested
      : planLimits.cpuMsPerRequest > 0
        ? planLimits.cpuMsPerRequest
        : undefined;
  const subRequests =
    planLimits.subRequestsPerInvocation > 0 ? planLimits.subRequestsPerInvocation : undefined;
  if (!cpuMs && !subRequests) {
    return null;
  }
  return {
    ...(cpuMs ? { cpuMs } : {}),
    ...(subRequests ? { subRequests } : {}),
  };
}
