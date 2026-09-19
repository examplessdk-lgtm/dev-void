import { sql as drizzleSql, and, eq, notInArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteProjectAssets, deleteWorkerBundle } from '../assets.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { clearCronScheduler } from '../cron-scheduler-client.ts';
import {
  TERMINAL_DEPLOYMENT_STATUSES,
  type Db,
  deleteProjectCascade,
  deleteProjectEmailDestinations,
  getAllProjectDeployments,
  getActiveDeployment,
  getDomainsByProjectId,
  getProject,
  getProjectResources,
  terminateBuildsForProject,
} from '../db.ts';
import { drainProjectEmailAdmissions } from '../email/admission.ts';
import { emailDomainRoutes } from '../email/connection-schema.ts';
import { requestEmailDomainRemove, runEmailOperation } from '../email/connection-service.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import {
  getLegacyProjectWorkerName,
  getProjectDeploymentWorkerName,
  getProjectQueueName,
} from '../naming.ts';
import { deployments as deploymentsTable, projects as projectsTable } from '../schema.ts';
import type { Build, DeployManifest, Project, Resource } from '../types.ts';
import {
  deleteCustomHostname,
  deleteD1Database,
  deleteHyperdrive,
  deleteKVNamespace,
  deleteQueue,
  deleteR2Bucket,
} from './cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
} from './containers.ts';
import { runEmailDestinationCleanup } from './email-destination-cleanup.ts';

function deleteCloudflareResource(
  accountId: string,
  apiToken: string,
  resource: Pick<Resource, 'type' | 'cf_id'>,
): Promise<void> {
  const resourceType = resource.type;

  switch (resourceType) {
    case 'd1':
      return deleteD1Database(accountId, apiToken, resource.cf_id);
    case 'kv':
      return deleteKVNamespace(accountId, apiToken, resource.cf_id);
    case 'r2':
      return deleteR2Bucket(accountId, apiToken, resource.cf_id);
    case 'queue':
      return deleteQueue(accountId, apiToken, resource.cf_id);
    case 'hyperdrive':
      return deleteHyperdrive(accountId, apiToken, resource.cf_id);
    case 'container':
      return deleteContainerApplicationIdempotent(accountId, apiToken, resource.cf_id);
    default:
      resourceType satisfies never;
      throw new Error(`Unsupported resource type: ${resourceType}`);
  }
}

/**
 * Critical CF cleanup. These deletes MUST succeed before the DB cascade,
 * otherwise we orphan CF state with no DB pointer left for retry.
 *
 * Currently:
 *   - Container application(s) referenced by `resources` rows of type
 *     `container`.
 *   - Per-deploy container application orphans located by deterministic name
 *     (recovery for deploys whose container POST succeeded but whose resources
 *     UPSERT did not commit before the deploy rolled back).
 *
 * Throws on the first non-404 failure. The caller MUST NOT proceed to
 * `deleteProjectCascade` if this throws.
 */
async function cleanupCriticalResources(
  context: Context<ApiEnv>,
  projectId: string,
  _project: Pick<Project, 'slug'>,
): Promise<void> {
  const resources = await getProjectResources(context.get('db'), projectId);
  for (const resource of resources) {
    if (resource.type !== 'container') {
      continue;
    }
    await deleteContainerApplicationIdempotent(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      resource.cf_id,
    );
  }

  // Orphan-recovery fallback: a past `provisionPerDeployContainer` failure
  // could have left a CF container app behind without a corresponding
  // `resources` row (e.g. CF POST succeeded, DB UPSERT failed, deploy rolled
  // back). The primary loop above only catches container apps that have a
  // row; this fallback enumerates every deployment for the project, parses
  // its manifest, and locates per-deploy container orphans by deterministic
  // name (`perDeployContainerApplicationName`).
  //
  // Runs unconditionally because the failure mode this catches (resources
  // row missing) means we can't gate on resources presence without
  // defeating the recovery's purpose. Per-deployment GETs are cheap enough
  // to absorb on every teardown — and teardown is rare relative to deploy.
  //
  // Race-mitigation (full fix is project-level locking — see design-doc 0067):
  // an in-flight deploy whose container POST lands AFTER our first scan
  // would leak as an orphan once the DB cascade nulls its deployment row.
  // Run the scan TWICE with a short delay; the second pass catches any POST
  // that completed during the gap. `assertProjectNotDeleting` /
  // `assertDeploymentNotCanceled` checks in the deploy pipeline mean an
  // in-flight deploy aborts shortly after `lockAndMarkDeleting` flips the
  // status, so a 2s delay is comfortably longer than the worst-case
  // post-status-flip container POST tail.
  const alreadyDeletedCfIds = new Set(
    resources.filter((r) => r.type === 'container').map((r) => r.cf_id),
  );
  await sweepPerDeployContainerOrphans(context, projectId, alreadyDeletedCfIds);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await sweepPerDeployContainerOrphans(context, projectId, alreadyDeletedCfIds);
}

/**
 * Locate per-deploy container orphans by deterministic name and delete any
 * not already in `alreadyDeletedCfIds`. Mutates the set with each new id so
 * subsequent passes skip already-handled orphans.
 */
async function sweepPerDeployContainerOrphans(
  context: Context<ApiEnv>,
  projectId: string,
  alreadyDeletedCfIds: Set<string>,
): Promise<void> {
  const allDeployments = await getAllProjectDeployments(context.get('db'), projectId);
  for (const deployment of allDeployments) {
    const manifest = parseDeploymentManifest(deployment.manifest);
    if (!manifest?.sandbox) {
      continue;
    }
    const orphanName = perDeployContainerApplicationName(
      projectId,
      deployment.id,
      manifest.sandbox.containerName ?? 'void-sandbox',
    );
    const orphan = await findContainerApplication(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      orphanName,
    );
    if (orphan && !alreadyDeletedCfIds.has(orphan.id)) {
      await deleteContainerApplicationIdempotent(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        orphan.id,
      );
      alreadyDeletedCfIds.add(orphan.id);
    }
  }
}

/**
 * Best-effort manifest parse for orphan-recovery enumeration. Manifests are
 * stored as JSON-encoded text on `deployments.manifest`. Returns `null` for
 * absent or unparseable bodies so the caller can skip those rows.
 */
function parseDeploymentManifest(raw: string | null): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

/**
 * Best-effort CF cleanup. Failures here become warnings but DO NOT block the
 * DB cascade. These resources are either independently re-derivable (KV
 * routing entries, deployment-scoped worker scripts) or come with their own
 * recovery story (D1 / KV / R2 retention via CF account-level cleanup).
 */
async function cleanupBestEffortResources(
  context: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug'>,
): Promise<{ warnings: ReadonlyArray<string>; cleanedCfIds: ReadonlySet<string> }> {
  const warnings: Array<string> = [];
  const warn = (msg: string) => (err: unknown) => {
    warnings.push(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
  };
  // cf_ids whose CF object this sweep attempted to delete, so the post-cascade
  // race-window cleanup can skip them (it only needs the rows created AFTER the
  // snapshot below).
  const cleanedCfIds = new Set<string>();

  const [projectDeployments, resources, projectDomains] = await Promise.all([
    getAllProjectDeployments(context.get('db'), projectId),
    getProjectResources(context.get('db'), projectId),
    getDomainsByProjectId(context.get('db'), projectId),
  ]);

  const dispatchNamespace = context.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerNames = new Set([
    getLegacyProjectWorkerName(project.slug),
    ...projectDeployments.map((deployment) =>
      getProjectDeploymentWorkerName(project.slug, deployment.id),
    ),
  ]);

  // Delete user-facing worker scripts before queue resources so CF no longer
  // sees queue bindings in attached Workers.
  await Promise.all(
    Array.from(workerNames, (workerName) =>
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` } },
      )
        .then(async (cfRes) => {
          if (!cfRes.ok && cfRes.status !== 404) {
            warnings.push(`Failed to delete worker ${workerName}: ${await cfRes.text()}`);
          }
        })
        .catch(warn(`Failed to delete worker ${workerName}`)),
    ),
  );

  // Delete R2 worker bundle objects under `worker-bundles/{projectId}/{deploymentId}/...`
  // for every deployment. Without this, project teardown leaves these objects
  // permanently orphaned in STATIC_ASSETS_R2 (the cascade only drops DB rows).
  // `deleteWorkerBundle` is idempotent — listing returns no objects for deploys
  // that never stored a bundle, so we don't need to gate on `bundle_stored`.
  await Promise.all(
    projectDeployments.map((deployment) =>
      deleteWorkerBundle(context.env.STATIC_ASSETS_R2, projectId, deployment.id).catch(
        warn(`Failed to delete worker bundle for deployment ${deployment.id}`),
      ),
    ),
  );

  // Delete R2 static-asset objects under `assets/{projectId}/...`. The retention
  // cleanup loop only walks hashes referenced by retained manifests, so any
  // bytes uploaded via the direct-to-R2 presigned PUTs that never landed in a
  // finalized deploy (TOCTOU race against teardown, abandoned upload, etc.)
  // are durable orphans without this sweep. Best-effort: failures here become
  // warnings — the surrounding teardown still cascades the DB rows.
  await deleteProjectAssets(context.env.STATIC_ASSETS_R2, projectId).catch(
    warn(`Failed to delete static assets for project ${projectId}`),
  );

  const cleanup: Array<Promise<void>> = [];

  // Best-effort CF resource cleanup (D1, KV, R2, Queue, Hyperdrive — user-
  // provisioned resources). Container resources were handled as critical above.
  for (const resource of resources) {
    if (resource.type === 'container') {
      continue;
    }
    cleanedCfIds.add(resource.cf_id);
    const del = deleteCloudflareResource(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      resource,
    );
    cleanup.push(del.catch(warn(`Failed to delete ${resource.type} resource ${resource.cf_id}`)));
  }

  // Clear cron scheduler DO unconditionally — /clear is idempotent
  // (deleteAll + deleteAlarm). KV `hasCrons` is omitted when false and
  // missing on older entries; the PG manifest is the authoritative source,
  // and unconditional clear avoids a stale-KV gate.
  cleanup.push(
    clearCronScheduler(context.env, projectId).catch(
      warn(`Failed to clear cron scheduler for project ${projectId}`),
    ),
  );

  // KV routing entry
  cleanup.push(
    context.env.ROUTING.delete(project.slug).catch(warn('Failed to delete routing entry')),
  );

  // NOTE: `projectAccountKey(projectId)` (`project:{projectId}`) is intentionally
  // NOT deleted here — the sandbox gate's release path in `packages/proxy/src/sandbox.ts`
  // needs `{userId, plan}` to address the per-account SandboxConcurrencyCounter DO.
  // Leaving it durable across project deletion prevents lease leaks until the 1h stale-slot sweep.

  // Queue routing KV entries
  for (const q of resources.filter((r) => r.type === 'queue')) {
    cleanup.push(
      context.env.ROUTING.delete(`queue:${getProjectQueueName(projectId, q.binding_name)}`).catch(
        warn('Failed to delete queue routing entry'),
      ),
    );
  }

  // Custom hostnames from CF + KV
  for (const domain of projectDomains) {
    cleanup.push(
      deleteCustomHostname(
        context.env.CF_ZONE_ID,
        context.env.CF_API_TOKEN,
        domain.cf_hostname_id,
      ).catch(warn(`Failed to delete custom hostname ${domain.hostname}`)),
    );
    cleanup.push(
      context.env.ROUTING.delete(`domain:${domain.hostname}`).catch(
        warn('Failed to delete domain routing entry'),
      ),
    );
  }

  await Promise.all(cleanup);
  return { warnings, cleanedCfIds };
}

/**
 * Acquire the project-row lock, flip status='deleting' (if not already), mark
 * every non-terminal deployment as 'canceling', and terminalize every in-flight
 * build. Returns the terminalized builds so the caller can stop their container
 * DOs. Idempotent for repeated teardown attempts.
 *
 * Holding the FOR UPDATE lock across the status flip + deployment cancellation
 * serializes with the deploy pipeline's atomic precheck-and-claim transaction,
 * which also locks the project row and checks status. Any in-flight deploy
 * that already passed its own status check will observe status='canceling' on
 * its NEXT `assertDeploymentNotCanceled` / `assertProjectNotDeleting` call
 * inside `routes/deploy.ts` and abort before issuing further CF mutations
 * (worker PUT, asset session, routing flip, etc.).
 *
 * Builds are terminalized HERE — at the very start of teardown, before any CF
 * cleanup — rather than only in `deleteProjectCascade` at the end. A build-scoped
 * deploy token is accepted while its bound build row is active
 * (`middleware/auth.ts`), so leaving builds active through the (multi-second) CF
 * cleanup window would let a still-live token keep hitting deploy-token
 * provisioning routes (e.g. POST /:id/database) and create CF resources the
 * cascade then orphans. The CAS in `terminateBuildsForProject` revokes each
 * token now; the caller stops the container DOs immediately after this commit.
 * The project FOR UPDATE lock is the one build-creation takes, so a racing
 * push/OIDC either committed before this lock (caught here) or serializes after
 * it (caught by `deleteProjectCascade`'s own terminate at the end).
 */
async function lockAndMarkDeleting(
  db: Db,
  projectId: string,
): Promise<
  ReadonlyArray<{
    id: string;
    executor: Build['executor'];
    status: Build['status'];
    instance_type: string | null;
  }>
> {
  return await db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const txDb = tx as unknown as Db;
    const lockedProject = await getProject(txDb, projectId);
    if (!lockedProject) {
      throw new Error('project disappeared during deletion');
    }
    const activeDeployment = await getActiveDeployment(txDb, projectId);
    if (activeDeployment?.source === 'rollback-lease') {
      throw new ProjectOperationInProgressError();
    }
    if (lockedProject.status !== 'deleting') {
      await tx
        .update(projectsTable)
        .set({ status: 'deleting' })
        .where(eq(projectsTable.id, projectId));
    }
    // Mark every non-terminal deployment as 'canceling' so the deploy
    // pipeline's `assertDeploymentNotCanceled` checks observe the cancellation
    // and abort before further CF mutations. We do this regardless of whether
    // the project status was already 'deleting' to cover replays where the
    // status flip succeeded but the deployment cancellation didn't commit
    // (e.g. earlier teardown crashed mid-tx).
    await tx
      .update(deploymentsTable)
      .set({
        status: 'canceling',
        updated_at: drizzleSql`now()`,
        error_message: drizzleSql`COALESCE(${deploymentsTable.error_message}, 'project deleted')`,
      })
      .where(
        and(
          eq(deploymentsTable.project_id, projectId),
          notInArray(deploymentsTable.status, TERMINAL_DEPLOYMENT_STATUSES),
        ),
      );
    // Revoke in-flight build deploy tokens up front (see doc above). Idempotent
    // on replay (already-terminal builds are not re-matched by the CAS).
    return await terminateBuildsForProject(txDb, projectId, { reason: 'project deleted' });
  });
}

export class ProjectOperationInProgressError extends Error {
  constructor(message = 'project operation in progress') {
    super(message);
    this.name = 'ProjectOperationInProgressError';
  }
}

/**
 * Delete the CF object (and queue routing KV entry) behind any resource whose row
 * the cascade removed but whose cf_id the pre-cascade best-effort sweep did NOT
 * already handle. These are orphan-on-concurrent-create races: a provisioning
 * route (`POST/PUT /:id/database`) or a deploy (`provisionBindings`) that inserted
 * a `resources` row AFTER `cleanupBestEffortResources` took its one-time snapshot
 * but before the cascade — so the CF object was never deleted, yet its only
 * durable handle (the row) is now gone. `deleteProjectCascade` returns the
 * COMPLETE set of committed resources (its FOR UPDATE conflicts with the INSERT's
 * FK FOR KEY SHARE), so this catches every such straggler. Containers are excluded
 * — they have their own deterministic-name double-sweep in
 * `cleanupCriticalResources`. Best-effort: failures become warnings. Normally a
 * no-op (no concurrent create → every row was in the snapshot). See design-doc 0067.
 */
async function cleanupRaceWindowResourceOrphans(
  context: Context<ApiEnv>,
  projectId: string,
  deletedResources: ReadonlyArray<Resource>,
  cleanedCfIds: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> {
  const warnings: Array<string> = [];
  const warn = (msg: string) => (err: unknown) => {
    warnings.push(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
  };
  const orphans = deletedResources.filter(
    (r) => r.type !== 'container' && !cleanedCfIds.has(r.cf_id),
  );
  await Promise.all(
    orphans.flatMap((r) => {
      const tasks = [
        deleteCloudflareResource(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN, r).catch(
          warn(`Failed to delete race-window ${r.type} resource ${r.cf_id}`),
        ),
      ];
      if (r.type === 'queue') {
        tasks.push(
          context.env.ROUTING.delete(
            `queue:${getProjectQueueName(projectId, r.binding_name)}`,
          ).catch(warn(`Failed to delete race-window queue routing entry for ${r.cf_id}`)),
        );
      }
      return tasks;
    }),
  );
  return warnings;
}

/**
 * Tear down a project end-to-end:
 *   1. Take FOR UPDATE on the project row, flip status='deleting' (if not
 *      already), mark all non-terminal deployments as 'canceling' so any
 *      in-flight deploy aborts before further CF mutations, and terminalize all
 *      in-flight builds (revoking their deploy tokens). Then stop the container
 *      DOs of those builds — BEFORE any CF cleanup runs, so a still-running build
 *      can't keep acting on its now-revoked token during the cleanup window.
 *   2. Run critical CF cleanup (container apps + per-deploy container
 *      orphan recovery). Throws on non-404 failure; the caller should surface
 *      a 5xx and the DB row remains, allowing retry.
 *   3. Run best-effort CF cleanup (D1, KV, R2, queues, hyperdrive, custom
 *      hostnames, routing entries, deployment workers). Failures become
 *      warnings.
 *   4. Cascade-delete the project from the DB (terminalize any build that raced
 *      in after step 1 → domains → resources → secrets → builds → deployments →
 *      project), then best-effort stop the container DOs of any such late build
 *      and delete the CF object behind any resource that raced the step-3
 *      snapshot (a provisioning route / deploy that inserted a row after it).
 *
 * This is the ONLY caller of `cleanupCriticalResources`,
 * `cleanupBestEffortResources`, and `deleteProjectCascade` for the project-
 * teardown flow. Route handlers must use this helper instead of calling those
 * pieces directly so the lock + status flip + deployment/build cancellation
 * cannot be bypassed.
 */
export async function teardownProject(
  context: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug' | 'status'>,
): Promise<{ warnings: ReadonlyArray<string> }> {
  // Always run lock + mark — idempotent for `status='deleting'` (the helper
  // skips the flip and just (re-)marks any non-terminal deployments + builds).
  // This covers retried teardown after partial failure where the previous
  // attempt crashed before the cancellations committed.
  const cancelledOnLock = await lockAndMarkDeleting(context.get('db'), projectId);
  // Stop the container DOs for the builds revoked above BEFORE any CF cleanup
  // begins (post-commit, never under the row lock — it's a DO round-trip), so
  // their tokens are dead and their containers stopped before we touch CF.
  await cancelContainerBuildDos(context.env, cancelledOnLock, 'project deleted');

  const emailDrain = await drainProjectEmailAdmissions(context.get('db'), projectId);
  if (emailDrain.inFlight > 0) {
    throw new ProjectOperationInProgressError(
      `${emailDrain.inFlight} email provider attempt(s) have unresolved outcomes`,
    );
  }

  await cleanupCriticalResources(context, projectId, project);
  // Customer-side cleanup is durable and may continue after project deletion.
  await cleanupProjectEmailAssignments(context, projectId);
  const { warnings: bestEffortWarnings, cleanedCfIds } = await cleanupBestEffortResources(
    context,
    projectId,
    project,
  );
  // MUST run before `deleteProjectCascade`: the cascade destroys the
  // `email_destinations` rows the cross-project reference count is computed
  // from, so afterwards there is no way to tell whether an account-level CF
  // destination is still in use — the orphan becomes unrecoverable. Lives
  // here rather than in `routes/delete.ts` so the two admin teardown paths
  // (admin project delete, admin user delete) get it too.
  await cleanupProjectEmailDestinations(context, projectId);
  // deleteProjectCascade re-terminalizes under the project lock to catch a build
  // that raced in after step 1 committed (build creation takes the same lock),
  // and returns both that build and every resource row it deleted.
  const { cancelledBuilds, deletedResources } = await deleteProjectCascade(
    context.get('db'),
    projectId,
  );
  await cancelContainerBuildDos(context.env, cancelledBuilds, 'project deleted');
  // Close the orphan-on-concurrent-create window: delete the CF object behind any
  // resource whose row was created AFTER the best-effort snapshot above (so its
  // cf_id isn't in `cleanedCfIds`) and just cascade-deleted. Normally empty.
  const orphanWarnings = await cleanupRaceWindowResourceOrphans(
    context,
    projectId,
    deletedResources,
    cleanedCfIds,
  );
  return { warnings: [...bestEffortWarnings, ...orphanWarnings] };
}

/** Revoke project consent and hand last-reference tags to durable cleanup. */
async function cleanupProjectEmailDestinations(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<void> {
  const db = context.get('db');
  const tags = await deleteProjectEmailDestinations(db, projectId);
  for (const tag of tags) {
    await runEmailDestinationCleanup(
      db,
      { accountId: context.env.CF_ACCOUNT_ID, apiToken: context.env.CF_API_TOKEN },
      tag,
    );
  }
}

/** Disable project email assignments and record durable provider cleanup. */
async function cleanupProjectEmailAssignments(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<void> {
  const db = context.get('db');
  // New connection-backed assignments are independent of project cascade.
  // Disable authority first; provider cleanup remains in the operation ledger
  // even if project teardown later removes its owning row.
  const assignments = await db
    .select()
    .from(emailDomainRoutes)
    .where(eq(emailDomainRoutes.project_id, projectId));
  for (const assignment of assignments) {
    if (assignment.desired_state === 'removed') {
      continue;
    }
    // The durable intent must exist before the project can cascade away.
    // A provider failure after that point is safe to reconcile later.
    const opId = await requestEmailDomainRemove(
      db,
      context.env,
      assignment.id,
      { kind: 'system' },
      `teardown:${projectId}:${assignment.id}`,
    );
    try {
      await runEmailOperation(db, context.env, opId);
    } catch (error) {
      // The disabled assignment and connection survive project deletion; the
      // scheduled reconciler or operator can inspect and resume the cleanup.
      console.error(
        '[email] project teardown left pending connection cleanup',
        assignment.id,
        error,
      );
    }
  }
}
