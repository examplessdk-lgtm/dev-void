import { sql as drizzleSql } from 'drizzle-orm';
import { getDomainsByProjectIds, getProject, getProjectsByUserId, getUser, type Db } from './db.ts';
import type { PlanLimits } from './tiers.ts';
import type { AssetConfig, DeployManifest } from './types.ts';

/**
 * KV key + payload shape for the per-project routing entry consumed by the
 * proxy's `/sandbox/acquire` lookup (`packages/proxy/src/sandbox.ts`). The
 * proxy parses `{ userId, plan }` to resolve the sandbox concurrency cap +
 * runtime-block lookup for the authenticated `projectId`. Field casing is
 * camelCase to match the rest of the routing-entry conventions in this
 * module — `buildRoutingJson` and `buildStaticRoutingJson` both emit
 * `projectId` / `userId`.
 */
export type ProjectAccountEntry = Readonly<{
  userId: string;
  plan: string;
}>;

export function projectAccountKey(projectId: string): string {
  return `project:${projectId}`;
}

export function sandboxBlockKey(userId: string): string {
  return `sandbox-block:${userId}`;
}

export function buildProjectAccountJson(entry: ProjectAccountEntry): string {
  return JSON.stringify({ userId: entry.userId, plan: entry.plan });
}

/**
 * Re-publish every `project:{projectId}` routing entry for `userId`. Invoked
 * after a plan-change so the proxy's sandbox gate sees the new concurrency
 * cap on the next acquire without waiting for the user to redeploy. Best-
 * effort: KV writes are idempotent and bounded by the user's project count,
 * but a failure here means stale plan data lives in KV until the next deploy
 * for that project — callers should log on failure.
 */
export async function refreshProjectKvForUser(
  db: Db,
  routing: KVNamespace,
  userId: string,
): Promise<void> {
  const user = await getUser(db, userId);
  if (!user) {
    return;
  }
  const projects = await getProjectsByUserId(db, userId);
  if (projects.length === 0) {
    return;
  }
  const payload = buildProjectAccountJson({ userId, plan: user.plan });
  for (const project of projects) {
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
      const current = await getProject(tx as unknown as Db, project.id);
      // The owned-project list was read before this lock. An ownership transfer
      // can commit in between; in that ordering its project-account entry is now
      // authoritative and a stale plan refresh must not overwrite it.
      if (current?.user_id !== userId) {
        return;
      }
      await routing.put(projectAccountKey(project.id), payload);
    });
  }
}

/**
 * A reason-aware mutation of the `suspended` marker on a routing KV entry.
 *
 * The `suspended` field is shared by two unrelated suspension sources with a
 * precedence rule: an admin suspension (`admin_suspended` / a custom reason)
 * outranks an automatic usage suspension (`requests_exceeded`). Usage paths
 * must therefore NEVER clobber an admin marker, while admin actions are
 * authoritative and overwrite/clear anything. The discriminant encodes that:
 *
 *  - `{ op: 'suspend', reason, force }` — set `suspended = reason`. `force`
 *    (admin) overwrites a different existing reason; non-`force` (usage) only
 *    stamps when no marker exists, so it can't downgrade an admin suspension.
 *  - `{ op: 'unsuspend', matchReason }` — clear the marker. `matchReason: null`
 *    (admin) clears any reason; a string (usage) clears ONLY when the existing
 *    marker equals it, so a usage clear can't lift an admin suspension.
 */
export type RoutingSuspensionUpdate =
  | { op: 'suspend'; reason: string; force: boolean }
  | { op: 'unsuspend'; matchReason: string | null };

/**
 * Resolve a routing undo without overwriting a later authoritative mutation.
 * Exact matches restore directly. A suspension-only rewrite still belongs to
 * the attempted deployment, so restore its prior route while carrying the
 * newest `suspended` marker. Any other change (including deletion) wins and
 * suppresses the stale undo.
 */
export function resolveRoutingUndo(
  current: string | null,
  written: string | null,
  previous: string | null,
): { restore: boolean; value: string | null } {
  if (current === written) {
    return { restore: true, value: previous };
  }
  if (current === null || written === null) {
    return { restore: false, value: null };
  }
  try {
    const currentEntry = JSON.parse(current) as Record<string, unknown>;
    const writtenEntry = JSON.parse(written) as Record<string, unknown>;
    const hasCurrentSuspension = Object.hasOwn(currentEntry, 'suspended');
    const currentSuspension = currentEntry.suspended;
    delete currentEntry.suspended;
    delete writtenEntry.suspended;
    if (JSON.stringify(currentEntry) !== JSON.stringify(writtenEntry)) {
      return { restore: false, value: null };
    }
    if (previous === null) {
      return { restore: true, value: null };
    }
    const restoredEntry = JSON.parse(previous) as Record<string, unknown>;
    if (hasCurrentSuspension) {
      restoredEntry.suspended = currentSuspension;
    } else {
      delete restoredEntry.suspended;
    }
    return { restore: true, value: JSON.stringify(restoredEntry) };
  } catch {
    return { restore: false, value: null };
  }
}

/**
 * Apply a {@link RoutingSuspensionUpdate} to each given routing KV entry. A
 * project's suspension lives on EVERY routing entry dispatch serves it from —
 * its slug route AND one `domain:<host>` route per active custom domain — so
 * callers pass the full key set (see {@link setProjectsRoutingSuspension}).
 *
 * Skips keys with no entry (a pending domain has no KV route yet; a slug may be
 * mid-deploy), and skips the write whenever the entry already satisfies the
 * update (set → same reason / weaker reason preserved, clear → no matching
 * marker) so repeated suspend/unsuspend is a cheap no-op.
 */
export async function applyRoutingSuspension(
  routing: KVNamespace,
  keys: ReadonlyArray<string>,
  update: RoutingSuspensionUpdate,
): Promise<void> {
  for (const key of keys) {
    const raw = await routing.get(key);
    if (!raw) {
      continue;
    }
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (update.op === 'suspend') {
      if (entry.suspended === update.reason) {
        continue; // already carries this reason
      }
      if (!update.force && entry.suspended) {
        continue; // usage suspend must not overwrite a stronger (admin) reason
      }
      entry.suspended = update.reason;
    } else {
      if (!('suspended' in entry)) {
        continue; // nothing to clear
      }
      if (update.matchReason !== null && entry.suspended !== update.matchReason) {
        continue; // usage clear must not lift a different (admin) reason
      }
      delete entry.suspended;
    }
    await routing.put(key, JSON.stringify(entry));
  }
}

/**
 * Apply a {@link RoutingSuspensionUpdate} across a set of projects' routing
 * entries — each project's slug route plus EVERY `domain:<host>` route the
 * project has. This is the single source of truth for which KV keys carry a
 * project's suspension; dispatch enforces `routing.suspended` on all of them,
 * so suspending only the slug (the historical behaviour) left custom domains
 * serving past the cap, and unsuspending only the slug left them 429'd.
 *
 * We deliberately do NOT filter to `status === 'active'`. `tryActivateDomain`
 * writes the `domain:<host>` KV route BEFORE flipping the DB row to `active`
 * (self-healing ordering — see provisioning/activate-domain.ts), so a crash in
 * that window leaves a `pending` row whose KV route is already live and served
 * by dispatch. Filtering to active would skip that route and let a suspended
 * project keep serving on the hostname. Fanning out to every domain is safe:
 * {@link applyRoutingSuspension} skips any key with no KV entry, so a pending
 * domain that was never published is just a cheap no-op read.
 *
 * Each project's KV mutation runs under its project-row lock so deploy,
 * rollback, domain lifecycle, and failure compensation cannot overwrite a
 * newer suspension decision with a stale routing snapshot. No-ops for an
 * empty project list.
 */
export async function setProjectsRoutingSuspension(
  routing: KVNamespace,
  db: Db,
  projects: ReadonlyArray<{ id: string; slug: string; user_id?: string }>,
  update: RoutingSuspensionUpdate,
): Promise<void> {
  if (projects.length === 0) {
    return;
  }
  for (const project of projects) {
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
      if (project.user_id !== undefined) {
        const current = await getProject(tx as unknown as Db, project.id);
        // User-level suspension/restore callers pass Project snapshots from an
        // owned-project query. If ownership changed before this lock, transfer
        // convergence owns the route and this stale fan-out must stand down.
        if (current?.user_id !== project.user_id) {
          return;
        }
      }
      // Resolve domains only after the project lock. Domain activation takes
      // the same lock before publishing a route, so this read must happen
      // behind it or a domain activated between the eager read and this lock
      // could escape the suspension entirely.
      const domainMap = await getDomainsByProjectIds(tx as unknown as Db, [project.id]);
      const domainKeys = (domainMap.get(project.id) ?? []).map(
        (domain) => `domain:${domain.hostname}`,
      );
      await applyRoutingSuspension(routing, [project.slug, ...domainKeys], update);
    });
  }
}

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

export function buildRoutingJson(opts: {
  workerName: string;
  projectId: string;
  userId: string;
  manifest: DeployManifest | null;
  deploymentId: string;
  dispatchLimits: { cpuMs?: number; subRequests?: number } | null;
  suspended?: string;
  hasCrons?: boolean;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    workerName: opts.workerName,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? (manifest?.framework ? 'framework' : 'void'),
    ...(manifest?.ssr ? { ssr: true } : {}),
    ...(manifest?.revalidate ? { revalidate: manifest.revalidate } : {}),
    ...(manifest?.pages?.length ? { pages: manifest.pages } : {}),
    ...(manifest?.pathRevalidate && Object.keys(manifest.pathRevalidate).length > 0
      ? { pathRevalidate: manifest.pathRevalidate }
      : {}),
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    version: opts.deploymentId,
    ...(opts.dispatchLimits ? { limits: opts.dispatchLimits } : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
    ...(opts.hasCrons ? { hasCrons: true } : {}),
    ...(opts.assetManifestId ? { assetManifestId: opts.assetManifestId } : {}),
    ...(opts.assetConfig ? { assetConfig: opts.assetConfig } : {}),
  });
}

export function buildStaticRoutingJson(opts: {
  projectId: string;
  userId: string;
  deploymentId: string;
  assetConfig: AssetConfig;
  manifest: DeployManifest | null;
  suspended?: string;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    staticDeploymentId: opts.deploymentId,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? 'static',
    assetConfig: opts.assetConfig,
    version: opts.deploymentId,
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
  });
}
