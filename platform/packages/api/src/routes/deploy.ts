import {
  MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES,
  MAX_ROUTING_RULES,
  planWebSocketMigrations,
  MIGRATION_CLASSIFIER_VERSION,
  validateManifestShape,
  isSandboxRegistryImage,
} from '@void/deploy-core';
import { isrCacheKey, isrCachePrefix, isrLegacyCachePrefix } from '@void/isr';
import {
  hasSharedCacheOptOut,
  resolvePageTtl,
  resolveRevalidateTtl,
  SHARED_CACHE_POLICY_VERSION,
  type IsrCacheMetadata,
} from '@void/isr/core';
import {
  platformProjectHostname,
  platformProjectHostnames,
  readPlatformApplication,
} from '@void/platform';
import { and, eq, or, sql as drizzleSql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { findMissingR2Assets, findR2Assets, persistedR2AssetSizes } from '../asset-inventory.ts';
import {
  computeAssetHash,
  createAssetUploadSession,
  deleteWorkerBundle,
  KV_THRESHOLD,
  normalizeForCfAssetSession,
  scanProjectAssetOrphanCandidates,
  uploadAssetBuckets,
  buildAssetMetadata,
  deleteUnreferencedAssets,
  resolveAssetContentTypes,
  type AssetEntry,
  type AssetManifestEntry,
} from '../assets.ts';
import { paginatedR2Delete } from '../assets.ts';
import { hmacSignState } from '../auth/hmac.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { deleteDispatchScript, retryWithBackoff } from '../cf-api.ts';
import { R2_CONCURRENCY, uploadPool } from '../concurrency.ts';
import {
  clearCronScheduler,
  restoreCronScheduler,
  snapshotCronScheduler,
  syncCronScheduler,
  type CronSyncState,
} from '../cron-scheduler-client.ts';
import {
  getProject,
  getUser,
  getDeployment,
  cancelDeployment,
  createDeployment,
  updateDeploymentManifest,
  updateDeploymentStatus,
  deleteRollbackLease,
  updateRollbackLeaseState,
  beginDeploymentCompensation,
  beginDeploymentCutover,
  updateProjectType,
  updateProjectWebSocketVersion,
  getDomainsByProjectId,
  countUserDeploymentsToday,
  getActiveDeployment,
  getInFlightDeploymentsExcluding,
  setActiveDeployment,
  markDeploymentRetained,
  setAppliedMigrations,
  appendProjectMigrations,
  getRetainedDeploymentsExcluding,
  getProjectSecrets,
  getProjectResources,
  getAllProjectDeployments,
  upsertProjectSecret,
  getBuild,
  ACTIVE_BUILD_STATUSES,
  CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
  type Db,
} from '../db.ts';
import {
  appendDeploymentEvent,
  assertDeploymentExecutionAuthority,
  deploymentEventPage,
  deploymentReceiptResponse,
  dispatchDeploymentOperation,
  findDeploymentOperation,
  getDeploymentOperation,
  installationDeploymentAdmissionClosed,
  prepareDeploymentInput,
  type DeploymentOperation,
} from '../deployment-execution.ts';
import { sendDeployFailedEmail } from '../email.ts';
import {
  getSharedEmailRecipientReadiness,
  reconcileSharedEmailRecipient,
} from '../email/shared-recipient-service.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { checkCliVersionOrRespond } from '../middleware/cli-version.ts';
import { getProjectQueueName } from '../naming.ts';
import { createDeployLogger, type DeployLogger } from '../observability/logger.ts';
import { PLAN_CATALOG_SETTING, resolvePlanLimits } from '../plans.ts';
import { getPlatformSetting } from '../platform-settings.ts';
import {
  ProjectAccessDeniedError,
  projectAccessErrorBody,
  requireProjectCapability,
} from '../project-access.ts';
import { ensureProjectIngress } from '../project-ingress.ts';
import {
  BETTER_AUTH_SECRET_NAME,
  decryptProjectSecret,
  generateManagedAuthSecret,
  encryptProjectSecret,
} from '../project-secrets.ts';
import { ProjectRequiresNormalizationError, requireNormalizedProject } from '../project-state.ts';
import {
  addQueueConsumer,
  removeQueueConsumer,
  restoreQueueConsumer,
  snapshotQueueConsumer,
  getDispatchWorkerProxyToken,
  type QueueConsumerInfo,
} from '../provisioning/cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
} from '../provisioning/containers.ts';
import { provisionBindings } from '../provisioning/provision.ts';
import {
  assertManagedSandboxEntitlement,
  deleteSandboxController,
  isManagedSandbox,
  provisionSandboxController,
  sandboxControllerWorkerName,
} from '../provisioning/sandbox-controller.ts';
import { presignAssetPut } from '../r2-presign.ts';
import { RESERVED_BINDING_NAMES } from '../reserved-bindings.ts';
import {
  buildRoutingJson,
  buildStaticRoutingJson,
  computeDispatchLimits,
  resolveRoutingUndo,
} from '../routing.ts';
import { builds, deployments, deploymentOperations } from '../schema.ts';
import { REASON_REQUESTS_EXCEEDED, routingSuspensionReason } from '../suspension.ts';
import { isWithinLimit, STATIC_RETENTION_LIMIT } from '../tiers.ts';
import {
  SUPPORTED_MANIFEST_VERSIONS,
  type DeployManifest,
  type DeployEvent,
  type Deployment,
  type Project,
  type DeploymentStatus,
  type LiveMigrationMeta,
  type WebSocketMigrationMeta,
} from '../types.ts';
import { zeroTrustNotReadyMessage } from '../zero-trust/errors.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
  rewriteProjectRouteMetadata,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { requireProjectRouteCapability } from './project-access.ts';

export { MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES, MAX_ROUTING_RULES, validateManifestShape };

const DEFAULT_DISPATCH_NAMESPACE = 'void-users';
const DEFAULT_TAIL_SERVICE_NAME = 'void-tail';
const CUTOVER_RECOVERY_STALE_MS = 90 * 60 * 1000;
const DEPLOYMENT_CANCEL_STALE_MS = 10 * 60 * 1000;
const cutoverIntentKey = (deploymentId: string): string => `cutover-intent:${deploymentId}`;
const cutoverReadyKey = (deploymentId: string): string => `cutover-ready:${deploymentId}`;
const cutoverCompensatedKey = (deploymentId: string): string =>
  `cutover-compensated:${deploymentId}`;

async function requireActiveDeployAccess(db: Db, projectId: string, actorUserId: string) {
  return requireProjectCapability(db, projectId, actorUserId, 'deploy');
}

export function databaseTimestampMs(value: string): number | null {
  const withSeparator = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /[+-]\d{2}$/.test(withSeparator)
    ? `${withSeparator}:00`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withSeparator)
      ? withSeparator
      : `${withSeparator}Z`;
  const parsed = new Date(withZone).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

type CutoverMarker = {
  projectId: string;
  ownerId: string;
  buildId: string | null;
};

function parseCutoverMarker(raw: string | null): CutoverMarker | null {
  if (!raw) {
    return null;
  }
  try {
    const marker = JSON.parse(raw) as Partial<CutoverMarker>;
    if (
      typeof marker.projectId !== 'string' ||
      typeof marker.ownerId !== 'string' ||
      (marker.buildId !== null && typeof marker.buildId !== 'string')
    ) {
      return null;
    }
    return marker as CutoverMarker;
  } catch {
    return null;
  }
}

function resolvePersistedDeploymentType(
  manifest: DeployManifest,
  deployment: Deployment,
  committedProjectType?: Project['type'],
): 'void' | 'spa' | 'static' | 'framework' {
  if (manifest.type) {
    return manifest.type;
  }
  if (manifest.framework) {
    return 'framework';
  }
  if (deployment.bundle_stored || manifest.workerMain) {
    return 'void';
  }
  if (committedProjectType) {
    return committedProjectType;
  }
  return manifest.assetConfig?.not_found_handling === 'single-page-application' ? 'spa' : 'static';
}

async function resolveCutoverProxyToken(
  env: ApiEnv['Bindings'],
  workerName: string,
  projectId: string,
): Promise<string> {
  const lookup = await getDispatchWorkerProxyToken(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
    workerName,
  );
  if (lookup.kind === 'found') {
    return lookup.token;
  }
  if (lookup.kind === 'error') {
    throw lookup.error;
  }
  return hmacSignState(projectId, env.JWT_SECRET);
}

/** Make every persisted custom-domain key match one authoritative route. */
async function reconcileProjectDomainRoutes(
  env: ApiEnv['Bindings'],
  domains: Awaited<ReturnType<typeof getDomainsByProjectId>>,
  routingJson: string | null,
): Promise<void> {
  for (const domain of domains) {
    const key = `domain:${domain.hostname}`;
    if (domain.status === 'active' && routingJson !== null) {
      await env.ROUTING.put(key, routingJson);
    } else {
      // A hostname can become active at Cloudflare and have its route written
      // immediately before the PostgreSQL status update is interrupted. Treat
      // every persisted domain row as an authoritative key inventory so
      // recovery removes that pending-row/live-KV crash residue as well as
      // updating currently active domains.
      await env.ROUTING.delete(key);
    }
  }
}

/** Idempotently make every authoritative external surface match one deployment. */
async function replayDeploymentCutover(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Project,
  deployment: Deployment,
  committedProjectType?: Project['type'],
  options: Readonly<{ restoreCommitted?: boolean }> = {},
): Promise<void> {
  const currentOwner = await getUser(db, project.user_id);
  if (!currentOwner) {
    throw new Error('project owner is unavailable during routing publication');
  }
  const planLimits = await resolvePlanLimits(db, currentOwner.plan);
  if (!deployment.manifest) {
    throw new Error(`deployment ${deployment.id} has no manifest for cutover recovery`);
  }
  const manifest = JSON.parse(deployment.manifest) as DeployManifest;
  const targetType = resolvePersistedDeploymentType(manifest, deployment, committedProjectType);
  const isStatic = targetType === 'static' || targetType === 'spa';
  const workerName = `user-${project.slug}-${deployment.id}`;
  const existingRouting = await env.ROUTING.get(project.slug);
  const existingEntry = existingRouting
    ? (JSON.parse(existingRouting) as { suspended?: string })
    : {};
  // Restoring committed code must not wait for Zero Trust reconciliation. The
  // publication resolver fails closed, as deploy compensation does. Promoting
  // a new deployment keeps the strict readiness gate.
  const zeroTrust = options.restoreCommitted
    ? await resolveProjectZeroTrustRoutingForPublication(db, project.id)
    : await resolveProjectZeroTrustRouting(db, project.id);
  let hasAssets = false;
  if (deployment.asset_hashes) {
    const assetHashes = JSON.parse(deployment.asset_hashes) as Record<string, unknown>;
    hasAssets = Object.keys(assetHashes).length > 0;
  }
  const routingJson = isStatic
    ? buildStaticRoutingJson({
        projectId: project.id,
        userId: project.user_id,
        deploymentId: deployment.id,
        assetConfig:
          manifest.assetConfig ??
          ({
            not_found_handling: targetType === 'spa' ? 'single-page-application' : '404-page',
          } as const),
        manifest,
        suspended: existingEntry.suspended,
        zeroTrust,
      })
    : buildRoutingJson({
        workerName,
        projectId: project.id,
        userId: project.user_id,
        manifest,
        deploymentId: deployment.id,
        dispatchLimits: computeDispatchLimits(planLimits, manifest.limits),
        suspended: existingEntry.suspended,
        hasCrons: !!manifest.schedules?.length,
        assetManifestId: hasAssets ? deployment.id : undefined,
        assetConfig: hasAssets ? manifest.assetConfig : undefined,
        zeroTrust,
      });

  // Complete every PostgreSQL read and validation before the first external
  // mutation. A failed statement aborts its surrounding recovery transaction;
  // if it happened after a KV/DO/Queue write, that same transaction could no
  // longer persist `compensating` or restore the authoritative deployment.
  const domains = await getDomainsByProjectId(db, project.id);
  const resources = await getProjectResources(db, project.id);
  const historicalQueueNames = new Set<string>();
  for (const row of await getAllProjectDeployments(db, project.id)) {
    try {
      const rowManifest = row.manifest ? (JSON.parse(row.manifest) as DeployManifest) : null;
      for (const queue of rowManifest?.queues ?? []) {
        historicalQueueNames.add(queue.name);
      }
    } catch {
      // Corrupt historical metadata cannot authorize a queue write.
    }
  }
  const desiredQueues = isStatic ? [] : (manifest.queues ?? []);
  const desiredQueueNames = new Set(desiredQueues.map((queue) => queue.name));
  const desiredQueueResources = new Map<string, (typeof resources)[number]>();
  for (const queue of desiredQueues) {
    const resource = resources.find(
      (entry) => entry.type === 'queue' && entry.binding_name === queue.name,
    );
    if (!resource) {
      throw new Error(`cutover recovery is missing queue resource ${queue.name}`);
    }
    desiredQueueResources.set(queue.name, resource);
  }
  const needsProxyToken = !isStatic && (!!manifest.schedules?.length || desiredQueues.length > 0);
  const proxyToken = needsProxyToken
    ? await resolveCutoverProxyToken(env, workerName, project.id)
    : null;

  await env.ROUTING.put(project.slug, routingJson);
  await reconcileProjectDomainRoutes(env, domains, routingJson);
  if (!isStatic && manifest.schedules?.length) {
    await syncCronScheduler(env, project.id, {
      workerName,
      schedules: manifest.schedules,
      proxyToken: proxyToken!,
    });
  } else {
    await clearCronScheduler(env, project.id);
  }

  const dispatchWorkerName = env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
  for (const queue of desiredQueues) {
    const resource = desiredQueueResources.get(queue.name)!;
    const consumer = await addQueueConsumer(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      resource.cf_id,
      dispatchWorkerName,
      {
        ...(queue.maxBatchSize != null && { batch_size: queue.maxBatchSize }),
        ...(queue.maxBatchTimeout != null && { max_wait_time_ms: queue.maxBatchTimeout * 1000 }),
        ...(queue.maxRetries != null && { max_retries: queue.maxRetries }),
        ...(queue.retryDelay != null && { retry_delay: queue.retryDelay }),
      },
    );
    if (consumer.status === 'conflict') {
      throw new Error(`queue consumer conflict: ${queue.name} owned by ${consumer.ownerScript}`);
    }
    await env.ROUTING.put(
      `queue:${getProjectQueueName(project.id, queue.name)}`,
      JSON.stringify({ workerName, projectId: project.id, queueName: queue.name, proxyToken }),
    );
  }

  for (const queueName of historicalQueueNames) {
    if (desiredQueueNames.has(queueName)) {
      continue;
    }
    const resource = resources.find(
      (entry) => entry.type === 'queue' && entry.binding_name === queueName,
    );
    if (resource) {
      await removeQueueConsumer(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        resource.cf_id,
        dispatchWorkerName,
      );
    }
    await env.ROUTING.delete(`queue:${getProjectQueueName(project.id, queueName)}`);
  }
}

async function clearProjectExternalState(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Project,
): Promise<void> {
  // As in replayDeploymentCutover, finish DB work before any external delete
  // so a PostgreSQL error cannot strand a partially-cleared project while also
  // preventing the caller from persisting its compensation fence.
  const domains = await getDomainsByProjectId(db, project.id);
  const resources = await getProjectResources(db, project.id);
  const queueNames = new Set<string>();
  for (const row of await getAllProjectDeployments(db, project.id)) {
    try {
      const rowManifest = row.manifest ? (JSON.parse(row.manifest) as DeployManifest) : null;
      for (const queue of rowManifest?.queues ?? []) {
        queueNames.add(queue.name);
      }
    } catch {
      // Invalid historical metadata cannot authorize a queue write.
    }
  }

  await env.ROUTING.delete(project.slug);
  await reconcileProjectDomainRoutes(env, domains, null);
  await clearCronScheduler(env, project.id);
  const dispatchWorkerName = env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
  for (const queueName of queueNames) {
    const resource = resources.find(
      (entry) => entry.type === 'queue' && entry.binding_name === queueName,
    );
    if (resource) {
      await removeQueueConsumer(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        resource.cf_id,
        dispatchWorkerName,
      );
    }
    await env.ROUTING.delete(`queue:${getProjectQueueName(project.id, queueName)}`);
  }
}

export type SandboxDrainDeploymentSettlement = Readonly<{
  state: 'terminal' | 'cancel_requested' | 'waiting' | 'recovery_incomplete';
}>;

/**
 * Settle one abandoned deployment before the managed Sandbox drain deletes its
 * container. Ordinary requests receive the same two-phase cancellation grace
 * used by deploy admission. Protected cutovers are fenced by replacing their
 * owner marker under the project lock, then compensating every external
 * surface back to PostgreSQL's committed active deployment.
 */
export async function settleDeploymentForSandboxDrain(
  env: ApiEnv['Bindings'],
  db: Db,
  deploymentId: string,
  options: { expiredInvocation?: boolean; reason?: string } = {},
): Promise<SandboxDrainDeploymentSettlement> {
  const reason = options.reason ?? 'legacy managed Sandbox drain';
  const initial = await getDeployment(db, deploymentId);
  if (!initial || TERMINAL_DEPLOYMENT_STATUSES.includes(initial.status)) {
    return { state: 'terminal' };
  }

  const markerKeys: Array<string> = [];
  const settlement = await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT id FROM projects WHERE id = ${initial.project_id} FOR UPDATE`,
    );
    const txDb = tx as unknown as Db;
    const deployment = await getDeployment(txDb, deploymentId);
    if (!deployment || TERMINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      return { state: 'terminal' } as const;
    }
    const updatedAtMs = databaseTimestampMs(deployment.updated_at);
    if (updatedAtMs === null) {
      return { state: 'waiting' } as const;
    }
    const ageMs = Date.now() - updatedAtMs;
    if (deployment.source === 'rollback-lease') {
      const project = await getProject(txDb, deployment.project_id);
      if (!project || project.status === 'deleting' || !deployment.manifest) {
        return { state: 'recovery_incomplete' } as const;
      }
      let lease: {
        targetDeploymentId: string;
        state: 'running' | 'retryable' | 'applied';
        ownerId: string;
      };
      try {
        const parsed = JSON.parse(deployment.manifest) as Partial<typeof lease>;
        if (
          typeof parsed.targetDeploymentId !== 'string' ||
          typeof parsed.ownerId !== 'string' ||
          (parsed.state !== 'running' && parsed.state !== 'retryable' && parsed.state !== 'applied')
        ) {
          return { state: 'recovery_incomplete' } as const;
        }
        lease = parsed as typeof lease;
      } catch {
        return { state: 'recovery_incomplete' } as const;
      }
      if (lease.state === 'applied') {
        if (project.active_deployment_id !== lease.targetDeploymentId) {
          return { state: 'recovery_incomplete' } as const;
        }
        return {
          state: (await deleteRollbackLease(txDb, deployment.id, lease.ownerId))
            ? 'terminal'
            : 'waiting',
        } as const;
      }
      if (lease.state === 'running' && ageMs < 30 * 60 * 1000) {
        return { state: 'waiting' } as const;
      }

      try {
        await requireNormalizedProject(txDb, project);
      } catch (error) {
        if (error instanceof ProjectRequiresNormalizationError) {
          return { state: 'recovery_incomplete' } as const;
        }
        throw error;
      }
      const owner = await getUser(txDb, project.user_id);
      if (!owner) {
        return { state: 'recovery_incomplete' } as const;
      }
      const recoveryOwnerId = crypto.randomUUID();
      const adopted = await updateRollbackLeaseState(
        txDb,
        deployment.id,
        lease.targetDeploymentId,
        'running',
        recoveryOwnerId,
        lease.ownerId,
      );
      if (!adopted) {
        return { state: 'waiting' } as const;
      }
      const committedActive = project.active_deployment_id
        ? await getDeployment(txDb, project.active_deployment_id)
        : null;
      try {
        if (committedActive) {
          await replayDeploymentCutover(env, txDb, project, committedActive, project.type, {
            restoreCommitted: true,
          });
        } else {
          await clearProjectExternalState(env, txDb, project);
        }
      } catch {
        await updateRollbackLeaseState(
          txDb,
          deployment.id,
          lease.targetDeploymentId,
          'retryable',
          recoveryOwnerId,
          recoveryOwnerId,
        );
        return { state: 'recovery_incomplete' } as const;
      }
      return {
        state: (await deleteRollbackLease(txDb, deployment.id, recoveryOwnerId))
          ? 'terminal'
          : 'recovery_incomplete',
      } as const;
    }

    if (deployment.status !== 'cutover' && deployment.status !== 'compensating') {
      if (deployment.status !== 'canceling') {
        const requested = await cancelDeployment(txDb, deployment.id, reason);
        return { state: requested ? 'cancel_requested' : 'waiting' } as const;
      }
      if (!options.expiredInvocation && ageMs < DEPLOYMENT_CANCEL_STALE_MS) {
        return { state: 'waiting' } as const;
      }
      await updateDeploymentStatus(txDb, deployment.id, 'canceled', reason, { force: true });
      return { state: 'terminal' } as const;
    }

    const project = await getProject(txDb, deployment.project_id);
    if (!project || project.status === 'deleting') {
      return { state: 'waiting' } as const;
    }
    const compensatedKey = cutoverCompensatedKey(deployment.id);
    const [intentRaw, compensated] = await Promise.all([
      env.ROUTING.get(cutoverIntentKey(deployment.id)),
      env.ROUTING.get(compensatedKey),
    ]);
    if (compensated === project.id) {
      await updateDeploymentStatus(
        txDb,
        deployment.id,
        options.expiredInvocation ? 'canceling' : 'failed',
        options.reason ?? 'cutover compensation completed',
        { force: true },
      );
      markerKeys.push(
        cutoverIntentKey(deployment.id),
        cutoverReadyKey(deployment.id),
        compensatedKey,
      );
      return { state: 'terminal' } as const;
    }
    if (
      !options.expiredInvocation &&
      deployment.status === 'cutover' &&
      ageMs < CUTOVER_RECOVERY_STALE_MS
    ) {
      return { state: 'waiting' } as const;
    }

    try {
      await requireNormalizedProject(txDb, project);
    } catch (error) {
      if (error instanceof ProjectRequiresNormalizationError) {
        return { state: 'recovery_incomplete' } as const;
      }
      throw error;
    }
    const committedActiveDeploymentId = project.active_deployment_id;
    if (committedActiveDeploymentId === deployment.id) {
      return { state: 'waiting' } as const;
    }
    const owner = await getUser(txDb, project.user_id);
    if (!owner) {
      return { state: 'recovery_incomplete' } as const;
    }

    const intent = parseCutoverMarker(intentRaw);
    const recoveryMarker: CutoverMarker = {
      projectId: project.id,
      ownerId: crypto.randomUUID(),
      buildId: intent?.buildId ?? null,
    };
    // This durable owner change is the fence checked by the original cutover
    // and by its compensation path before either may mutate another surface.
    await env.ROUTING.put(cutoverIntentKey(deployment.id), JSON.stringify(recoveryMarker));

    const committedActive = committedActiveDeploymentId
      ? await getDeployment(txDb, committedActiveDeploymentId)
      : null;
    try {
      if (committedActive) {
        await replayDeploymentCutover(env, txDb, project, committedActive, project.type, {
          restoreCommitted: true,
        });
      } else {
        await clearProjectExternalState(env, txDb, project);
      }
      // Persist this before the database transition so a lost COMMIT
      // acknowledgement can be completed safely by the next drain request.
      await env.ROUTING.put(compensatedKey, project.id);
    } catch {
      await updateDeploymentStatus(
        txDb,
        deployment.id,
        'compensating',
        options.reason ?? 'Sandbox drain cutover compensation incomplete',
        { force: true },
      );
      return { state: 'recovery_incomplete' } as const;
    }
    await updateDeploymentStatus(
      txDb,
      deployment.id,
      options.expiredInvocation ? 'canceling' : 'failed',
      options.reason ?? 'abandoned cutover recovered for managed Sandbox disable',
      { force: true },
    );
    markerKeys.push(
      cutoverIntentKey(deployment.id),
      cutoverReadyKey(deployment.id),
      compensatedKey,
    );
    return { state: 'terminal' } as const;
  });

  for (const markerKey of markerKeys) {
    await env.ROUTING.delete(markerKey).catch(() => {
      // The acknowledged database transition is authoritative. A later
      // recovery can safely remove any stale marker left by a failed cleanup.
    });
  }
  return settlement;
}

// CF's worker script size limit (free plan 1 MiB, paid plan 10 MiB compressed).
// Enforced per worker module so a single runaway worker file cannot OOM the
// request before the upload to CF ever happens.
const MAX_WORKER_FILE_BYTES = 32 * 1024 * 1024; // 32 MiB
/**
 * Detect the known CF WfP bug where APIs return plain text about asset state
 * instead of JSON. CF returns different messages depending on propagation state
 * (e.g. "Assets have already been uploaded", "Assets have not yet been deployed").
 * Valid JSON always starts with `{` or `[`, so `startsWith` avoids false positives.
 */
function isCfAssetPlainText(text: string): boolean {
  return text.trimStart().startsWith('Assets have');
}

type UserWorkerMigrationResult = Readonly<{
  ok: boolean;
  protocolVersion?: 2;
  attemptId?: string;
  migrations: ReadonlyArray<{
    name: string;
    applied: boolean;
    durationMs: number;
    error?: string;
    status?: 'applied' | 'skipped' | 'failed';
    stability?: 'stable' | 'legacy';
  }>;
  confirmedApplied?: ReadonlyArray<string>;
  confirmedSkipped?: ReadonlyArray<string>;
  stability?: 'stable' | 'legacy';
  warnings?: ReadonlyArray<string>;
  error?: string;
}>;

function normalizeUserWorkerMigrationResult(
  value: unknown,
  bodyPreview: string,
): UserWorkerMigrationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      migrations: [],
      error: `migration endpoint returned invalid response: ${bodyPreview}`,
    };
  }

  const data = value as Record<string, unknown>;
  if (Array.isArray(data.migrations)) {
    return data as UserWorkerMigrationResult;
  }

  return {
    ok: false,
    migrations: [],
    error: `migration endpoint returned invalid response: missing migrations array (${bodyPreview})`,
  };
}

type WorkerMigrationCapabilities = Readonly<{
  protocolVersion: 2;
  endpoints: {
    app: string;
    auth?: string;
    reconcile: string;
  };
  dialect: 'sqlite' | 'postgresql' | 'mysql';
  classifierVersion: number;
  migrationListHash: string;
  destructiveValidation: 'passed';
}>;

function formatMigrationFailure(result: UserWorkerMigrationResult): string {
  const failedMigration = result.migrations.find((migration) => migration.error);
  if (failedMigration?.error) {
    const detailed = `migration ${failedMigration.name} failed: ${failedMigration.error}`;
    return result.error?.includes(failedMigration.error) ? result.error : detailed;
  }
  return result.error ?? 'unknown error';
}

type CapabilityProbeResult =
  | { ok: true; caps: WorkerMigrationCapabilities }
  | { ok: false; reason: string };

async function probeWorkerMigrationCapabilities(
  userWorker: Fetcher,
  token: string,
  logger: DeployLogger,
): Promise<CapabilityProbeResult> {
  try {
    const response = await userWorker.fetch(
      new Request('https://internal/__void/migrate/capabilities', {
        headers: { 'x-void-internal': token },
        signal: AbortSignal.timeout(10_000),
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        reason: `worker capabilities probe HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }
    if (isCfAssetPlainText(text)) {
      return {
        ok: false,
        reason: 'worker not serving its own code yet (Cloudflare asset stub)',
      };
    }
    let data: WorkerMigrationCapabilities;
    try {
      data = JSON.parse(text) as WorkerMigrationCapabilities;
    } catch {
      return {
        ok: false,
        reason: `worker capabilities probe returned non-JSON: ${text.slice(0, 200)}`,
      };
    }
    if (
      data?.protocolVersion !== 2 ||
      (data?.dialect !== 'sqlite' && data?.dialect !== 'postgresql' && data?.dialect !== 'mysql') ||
      typeof data.classifierVersion !== 'number' ||
      typeof data.migrationListHash !== 'string' ||
      data.destructiveValidation !== 'passed'
    ) {
      return {
        ok: false,
        reason: `worker capabilities probe shape invalid: ${text.slice(0, 200)}`,
      };
    }
    return { ok: true, caps: data };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('migrate', 'capability_probe_failed', {
      err: errMsg,
    });
    return {
      ok: false,
      reason: `worker capabilities probe request failed: ${errMsg}`,
    };
  }
}

async function dispatchStableAppMigration(
  userWorker: Fetcher,
  token: string,
  attemptId: string,
  deploymentId: string,
  logger: DeployLogger,
): Promise<UserWorkerMigrationResult> {
  const request = new Request('https://internal/__void/migrate/app', {
    body: JSON.stringify({ attemptId, deploymentId }),
    headers: { 'content-type': 'application/json', 'x-void-internal': token },
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
  });
  try {
    const response = await userWorker.fetch(request);
    const text = await response.text();
    if (isCfAssetPlainText(text)) {
      return reconcileStableAppMigration(userWorker, token, attemptId);
    }
    try {
      return normalizeUserWorkerMigrationResult(JSON.parse(text), text.slice(0, 500));
    } catch {
      return reconcileStableAppMigration(userWorker, token, attemptId);
    }
  } catch (err) {
    logger.warn('migrate', 'app_attempt_unknown', {
      attemptId,
      err: err instanceof Error ? err.message : String(err),
    });
    return reconcileStableAppMigration(userWorker, token, attemptId);
  }
}

async function reconcileStableAppMigration(
  userWorker: Fetcher,
  token: string,
  attemptId: string,
): Promise<UserWorkerMigrationResult> {
  const response = await userWorker.fetch(
    new Request(`https://internal/__void/migrate/app/attempt/${encodeURIComponent(attemptId)}`, {
      headers: { 'x-void-internal': token },
      signal: AbortSignal.timeout(30_000),
    }),
  );
  const text = await response.text();
  try {
    return normalizeUserWorkerMigrationResult(JSON.parse(text), text.slice(0, 500));
  } catch {
    return {
      ok: false,
      protocolVersion: 2,
      attemptId,
      migrations: [],
      error: `migration outcome unknown and reconciliation returned ${response.status}: ${text.slice(0, 200)}`,
    };
  }
}

async function dispatchStableAuthMigration(userWorker: Fetcher, token: string): Promise<void> {
  const response = await userWorker.fetch(
    new Request('https://internal/__void/migrate/auth', {
      headers: { 'x-void-internal': token },
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
    }),
  );
  const text = await response.text();
  let data: { ok?: boolean; error?: string };
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    throw new Error(`auth migration failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.ok !== true) {
    throw new Error(`auth migration failed: ${data.error ?? response.status}`);
  }
}

/**
 * Decode a base64 string to bytes with the lowest peak residency the
 * runtime allows. Prefers the (TC39 stage-4) `Uint8Array.fromBase64` helper
 * which performs the decode in a single allocation; falls back to the
 * `atob` + per-byte copy path on runtimes that don't expose it (notably
 * Node, where the integration tests run — the production CF Workers compat
 * date is 2026-02-12 and ships the helper natively).
 *
 * For a 32 MiB module the fast path drops peak residency from
 * roughly `raw + bin + decoded ≈ 86 + 64 + 32 = 182 MiB` to
 * `raw + decoded ≈ 86 + 32 = 118 MiB`, which fits under the 128 MiB
 * isolate cap with margin. The fallback path matches the previous behaviour.
 */
function decodeBase64ToBytes(raw: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array })
    .fromBase64;
  if (typeof fromBase64 === 'function') {
    return fromBase64(raw);
  }
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

const CF_RETRY = { maxRetries: 3, delayMs: 1000 };
// Readiness probe: confirms the new worker is live in the dispatch namespace
// before dispatching migrations. Absorbs CF's WfP propagation delay.
// Backoff: 0 + 1 + 2 + 4 + 8 + 16 + 32 = ~63s max window.
const CF_READINESS_RETRY = { maxRetries: 6, delayMs: 1000 };
// Migration dispatch: propagation lag is handled by the readiness probe,
// so this only retries genuine transient failures (e.g. network blips).
const CF_MIGRATION_RETRY = { maxRetries: 2, delayMs: 1000 };
const app = new Hono<ApiEnv>();

function sortUnique(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function parseManifest(raw: string | null | undefined): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

function parseAssetManifest(raw: string | null): Record<string, AssetManifestEntry> | null {
  if (raw === null || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, AssetManifestEntry>;
  } catch {
    return null;
  }
}

function equalAssetManifests(
  a: Record<string, AssetManifestEntry> | null,
  b: Record<string, AssetManifestEntry> | null,
): boolean {
  if (!a || !b) {
    return false;
  }
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  for (const [path, entry] of aEntries) {
    const other = b[path];
    if (!other || other.hash !== entry.hash || other.size !== entry.size) {
      return false;
    }
  }
  return true;
}

function sanitizeDeployErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (
    isCfAssetPlainText(trimmed) ||
    // JSON.parse SyntaxError truncates the original text (e.g. `Unexpected token 'A', "Assets hav"...`)
    // so the full substring won't match — detect the truncated form too
    /Unexpected token.*"Assets hav/.test(trimmed)
  ) {
    return 'asset upload returned an unexpected Cloudflare response';
  }
  return message;
}

async function assertDeploymentNotCanceled(db: Db, deploymentId: string): Promise<void> {
  const latest = await getDeployment(db, deploymentId);
  if (
    !latest ||
    latest.status === 'compensating' ||
    CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status) ||
    TERMINAL_DEPLOYMENT_STATUSES.includes(latest.status)
  ) {
    throw new Error('deployment canceled');
  }
}

// Race guard against concurrent project teardown (design-doc 0067 §7).
// Teardown takes a project-row lock and flips `projects.status='deleting'`
// before tearing down CF state. A concurrent deploy that has already passed
// `assertDeploymentNotCanceled` could still race the route flip and recreate
// routing for a deleted project. Calling this alongside every cancellation
// check (and re-checking under FOR UPDATE at the final commit) closes that
// window. The atomic precheck-and-claim transaction below holds the same
// FOR UPDATE lock teardown uses, serializing the two flows.
const PROJECT_DELETING_ERROR_MESSAGE = 'project deletion in progress';

/**
 * Sentinel error thrown by the atomic precheck-and-claim transaction to
 * signal "another deploy is already in flight". The route handler catches
 * this and returns HTTP 409. Defined as a class (not a string sentinel) so
 * the catch-path can do an `instanceof` check without colliding with
 * arbitrary error messages from elsewhere in the transaction.
 */
class ConcurrentDeployError extends Error {
  constructor(public readonly deploymentId: string) {
    super(`deploy in progress: ${deploymentId}`);
    this.name = 'ConcurrentDeployError';
  }
}

class StaticAssetDisappearedError extends Error {
  constructor(hashes: ReadonlyArray<string>) {
    super(`static assets disappeared before cutover: ${hashes.slice(0, 10).join(', ')}`);
    this.name = 'StaticAssetDisappearedError';
  }
}

function inferPersistedAssetStore(
  entry: { size?: unknown; store?: unknown },
  manifest: DeployManifest | null,
): 'kv' | 'r2' | null {
  if (entry.store === 'kv' || entry.store === 'r2') {
    return entry.store;
  }
  if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) {
    return null;
  }
  // New JSON/direct-upload cutovers persist placement before publishing the
  // ready marker. A v2 row without it is incomplete/corrupt: it may contain a
  // small legacy KV carry-forward, so guessing R2 would publish a broken path.
  if (manifest?.assetManifestVersion === 2) {
    return null;
  }
  // Older multipart deployments did not persist placement and deterministically
  // used the static uploader's 2 MiB size split.
  return entry.size >= KV_THRESHOLD ? 'r2' : 'kv';
}

function attachServingStoreMetadata(
  assetManifest: Readonly<Record<string, AssetManifestEntry>>,
  servingManifest: Readonly<Record<string, string>>,
  scopedR2 = false,
): Record<string, AssetManifestEntry> {
  const persisted: Record<string, AssetManifestEntry> = {};
  const missing: Array<string> = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    if (path.startsWith('/.void-deploy/')) {
      persisted[path] = entry;
      continue;
    }
    const serving = servingManifest[path];
    const hash = serving?.startsWith('!') ? serving.slice(1) : serving;
    if (!serving || hash !== entry.hash) {
      missing.push(path);
      continue;
    }
    persisted[path] = {
      ...entry,
      store: serving.startsWith('!') ? 'r2' : 'kv',
      ...(scopedR2 ? { scope: 'project' as const } : {}),
    };
  }
  if (missing.length > 0) {
    throw new StaticAssetDisappearedError(missing);
  }
  return persisted;
}

function reconstructPersistedServingManifest(
  deployment: Deployment,
  assetManifest: Readonly<Record<string, { hash?: unknown; size?: unknown; store?: unknown }>>,
): Record<string, string> {
  const deployManifest = parseManifest(deployment.manifest);
  const servingManifest: Record<string, string> = {};
  const invalid: Array<string> = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    if (path.startsWith('/.void-deploy/')) {
      continue;
    }
    const store = inferPersistedAssetStore(entry, deployManifest);
    if (typeof entry.hash !== 'string' || !store) {
      invalid.push(path);
      continue;
    }
    servingManifest[path] = store === 'r2' ? `!${entry.hash}` : entry.hash;
  }
  if (invalid.length > 0) {
    throw new StaticAssetDisappearedError(invalid);
  }
  return servingManifest;
}

async function assertPersistedDeploymentServingAssetsExist(
  env: ApiEnv['Bindings'],
  deployment: Deployment,
): Promise<void> {
  const assetManifest = deployment.asset_hashes
    ? (JSON.parse(deployment.asset_hashes) as Record<string, { hash?: unknown }>)
    : null;
  if (!assetManifest || Object.keys(assetManifest).length === 0) {
    return;
  }
  const servingManifestKey = `manifest:${deployment.id}`;
  const servingManifestRaw = await env.ROUTING.get(servingManifestKey);
  let servingManifest: Record<string, string>;
  if (servingManifestRaw) {
    servingManifest = JSON.parse(servingManifestRaw) as Record<string, string>;
  } else {
    // The ready marker and serving manifest are separate KV keys and can
    // propagate at different speeds. Reconstruct a missing read from the
    // durable path/hash manifest instead of compensating a healthy cutover
    // merely because this colo saw `ready` first. New rows persist placement;
    // legacy multipart rows deterministically used the 2 MiB KV/R2 split.
    servingManifest = reconstructPersistedServingManifest(deployment, assetManifest);
    await env.ROUTING.put(servingManifestKey, JSON.stringify(servingManifest));
  }
  // Verify metadata coherence, not object-store presence. Platform GC is
  // serialized on the project row and protects every nonterminal deployment;
  // legacy unscoped keys are never collected. Out-of-band bucket deletion
  // cannot be diagnosed with bounded per-request probes for a 5,000-file app.
  attachServingStoreMetadata(assetManifest as Record<string, AssetManifestEntry>, servingManifest);
}

async function assertProjectNotDeleting(db: Db, projectId: string): Promise<void> {
  const project = await getProject(db, projectId);
  // Fail closed: a missing project row is treated the same as `status='deleting'`.
  // After teardown flips status='deleting' and `deleteProjectCascade` removes the
  // project row, an in-flight deploy that observes the missing row would otherwise
  // sail past this guard and recreate routing/worker state for an already-deleted
  // project. Throwing here funnels both cases into the same catch-path branch
  // (PROJECT_DELETING_ERROR_MESSAGE) which rolls back KV writes and the worker.
  if (!project || project.status === 'deleting') {
    throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
  }
}

// Sentinel thrown by the final-publish transaction when the deploy token's
// bound build is no longer active. The up-front guard in
// `handleManifestOnlyDeploy` checks the build once at request entry, but the
// request then spends minutes parsing the body, prechecking, uploading assets
// to R2, and provisioning. During that window a newer GitHub Actions run's
// OIDC exchange can mark the OLD bound build `cancelled` (the "superseded by
// newer run" UPDATE in `createGithubActionsBuildWithinLimit`). Without a
// re-check the superseded runner would still publish stale code. This message
// is routed through the SAME rollback branch as PROJECT_DELETING_ERROR_MESSAGE
// so the deployment never goes live.
const SUPERSEDED_BUILD_ERROR_MESSAGE = 'bound build was superseded';

/**
 * Re-check the deploy token's bound build under a row lock, inside the final
 * publish transaction, immediately before the deployment flips to `live`. The
 * `FOR UPDATE` lock serializes against the supersede UPDATE in
 * `createGithubActionsBuildWithinLimit` (which row-locks the matching `builds`
 * rows as it cancels them), so a build that gets superseded mid-flight is
 * observed as terminal here and the publish is aborted.
 *
 * No-op when the token carries no `build` claim (full-API tokens, CI
 * credential tokens). Throws SUPERSEDED_BUILD_ERROR_MESSAGE on a non-active or
 * project-mismatched build, mirroring the up-front guard's reject semantics.
 */
async function assertBoundBuildStillActive(
  txDb: Db,
  deployBuild: string | undefined,
  projectId: string,
): Promise<void> {
  if (!deployBuild) {
    return;
  }
  const [boundBuild] = await txDb
    .select()
    .from(builds)
    .where(eq(builds.id, deployBuild))
    .for('update')
    .limit(1);
  if (!boundBuild || !ACTIVE_BUILD_STATUSES.includes(boundBuild.status)) {
    throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
  }
  if (boundBuild.project_id !== projectId) {
    throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
  }
}

export function buildDurableObjectUploadMigrations(
  websocketMigrations: ReadonlyArray<WebSocketMigrationMeta> | undefined,
  liveMigrations: ReadonlyArray<LiveMigrationMeta> | undefined = undefined,
):
  | {
      new_tag: string;
      steps: ReadonlyArray<{
        new_classes?: ReadonlyArray<string>;
        new_sqlite_classes?: ReadonlyArray<string>;
        deleted_classes?: ReadonlyArray<string>;
      }>;
    }
  | undefined {
  const steps: Array<{
    tag: string;
    index: number;
    new_classes?: ReadonlyArray<string>;
    new_sqlite_classes?: ReadonlyArray<string>;
    deleted_classes?: ReadonlyArray<string>;
  }> = [];

  for (const migration of websocketMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newClasses?.length ? { new_classes: migration.newClasses } : {}),
      ...(migration.newSqliteClasses?.length
        ? { new_sqlite_classes: migration.newSqliteClasses }
        : {}),
      ...(migration.deletedClasses?.length ? { deleted_classes: migration.deletedClasses } : {}),
    });
  }

  for (const migration of liveMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newSqliteClasses?.length
        ? { new_sqlite_classes: migration.newSqliteClasses }
        : {}),
    });
  }

  if (steps.length === 0) {
    return undefined;
  }

  const sortedSteps = [...steps].sort(compareDurableObjectMigrationSteps);

  return {
    new_tag: sortedSteps[sortedSteps.length - 1].tag,
    steps: sortedSteps.map(({ tag: _tag, index: _index, ...step }) => step),
  };
}

function compareDurableObjectMigrationSteps(
  firstStep: { tag: string; index: number },
  secondStep: { tag: string; index: number },
): number {
  const firstVersion = parseMigrationTagVersion(firstStep.tag);
  const secondVersion = parseMigrationTagVersion(secondStep.tag);
  if (firstVersion !== null && secondVersion !== null && firstVersion !== secondVersion) {
    return firstVersion - secondVersion;
  }
  return firstStep.index - secondStep.index;
}

function parseMigrationTagVersion(tag: string): number | null {
  const match = /-v(\d+)$/.exec(tag);
  return match ? Number(match[1]) : null;
}

export function buildWebSocketUploadBindings(
  websocket: DeployManifest['websocket'] | undefined,
): ReadonlyArray<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!websocket) {
    return [];
  }

  const bindings = new Map<string, string>();

  for (const route of websocket.routes) {
    const bindingName = route.bindingName ?? route.className;
    bindings.set(bindingName, route.className);
  }

  const boundClasses = new Set(bindings.values());
  for (const className of sortUnique(websocket.classes)) {
    if (!boundClasses.has(className)) {
      bindings.set(className, className);
    }
  }

  return Array.from(bindings, ([name, class_name]) => ({
    type: 'durable_object_namespace',
    name,
    class_name,
  }));
}

/**
 * Tenant code receives only the controller service. It cannot access the raw
 * container namespace, accounting control, or lifecycle callbacks.
 */
export function buildSandboxUploadBindings(
  sandbox: DeployManifest['sandbox'] | undefined,
  controllerWorkerName?: string,
): ReadonlyArray<{
  type: 'service';
  name: string;
  service: string;
}> {
  if (!sandbox) {
    return [];
  }
  if (!controllerWorkerName) {
    throw new Error('Sandbox controller Worker name is required.');
  }
  return [
    {
      type: 'service',
      name: '__VOID_SANDBOX',
      service: controllerWorkerName,
    },
  ];
}

export function buildLiveUploadBindings(live: DeployManifest['live'] | undefined): ReadonlyArray<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!live) {
    return [];
  }
  return [
    {
      type: 'durable_object_namespace',
      name: live.bindingName,
      class_name: live.className,
    },
  ];
}

export function enrichWebSocketManifest(
  manifest: DeployManifest,
  previousManifest: DeployManifest | null,
  currentVersion: number,
): { manifest: DeployManifest; changed: boolean; nextVersion: number } {
  const previousMigrations = previousManifest?.websocket?.migrations ?? [];
  const planned = planWebSocketMigrations({
    nextClasses: manifest.websocket?.classes,
    previousClasses: previousManifest?.websocket?.classes,
    previousMigrations,
    currentVersion,
  });

  if (!planned.changed) {
    if (!manifest.websocket && previousMigrations.length === 0) {
      return { manifest, changed: false, nextVersion: currentVersion };
    }
    return {
      manifest: {
        ...manifest,
        websocket: manifest.websocket
          ? {
              ...manifest.websocket,
              classes: planned.classes,
              migrations: planned.migrations,
            }
          : previousManifest?.websocket,
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  return {
    manifest: {
      ...manifest,
      websocket: {
        routes: manifest.websocket?.routes ?? [],
        classes: planned.classes,
        migrations: planned.migrations,
      },
    },
    changed: true,
    nextVersion: planned.nextVersion,
  };
}

export function enrichLiveManifest(
  manifest: DeployManifest,
  previousManifest: DeployManifest | null,
  currentVersion: number,
): { manifest: DeployManifest; changed: boolean; nextVersion: number } {
  if (!manifest.live) {
    return { manifest, changed: false, nextVersion: currentVersion };
  }

  const previousLive = previousManifest?.live;
  const previousMigrations = previousLive?.migrations ?? [];
  const nextClasses = sortUnique(manifest.live.classes);
  const nextClass = manifest.live.className;

  if (previousLive?.className === nextClass && previousMigrations.length > 0) {
    return {
      manifest: {
        ...manifest,
        live: {
          ...manifest.live,
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const existingClasses = new Set<string>();
  if (previousLive?.className) {
    existingClasses.add(previousLive.className);
  }
  for (const className of previousLive?.classes ?? []) {
    existingClasses.add(className);
  }
  for (const migration of previousMigrations) {
    for (const className of migration.newSqliteClasses ?? []) {
      existingClasses.add(className);
    }
  }

  if (existingClasses.has(nextClass)) {
    return {
      manifest: {
        ...manifest,
        live: {
          ...manifest.live,
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const migration: LiveMigrationMeta = {
    tag: `live-v${nextVersion}`,
    newSqliteClasses: [nextClass],
  };

  return {
    manifest: {
      ...manifest,
      live: {
        ...manifest.live,
        classes: nextClasses,
        migrations: [...previousMigrations, migration],
      },
    },
    changed: true,
    nextVersion,
  };
}

// Cap on the number of presign requests in a single batch. Presigning is
// CPU-light (one HMAC chain per call) but unbounded fanout still costs
// memory and lets a malformed CLI burn server CPU without bound. 5000
// matches the largest realistic dist/ asset count we've observed (memora
// repro: 570; design doc 0068's TBD ceiling). Asset manifests on the
// JSON-mode deploy share the same cap for symmetry.
const MAX_UPLOAD_URLS_BATCH = 5000;
// Body cap for `POST /:id/deploy/upload-urls`. The body is dominated by
// `assets[]` entries — each entry is ~150 bytes (blake3 + md5 + size +
// contentType). 5000 entries × ~150 bytes ≈ 750 KB, so 4 MiB carries a
// 4× safety margin. Asset BYTES never travel this endpoint — they go
// direct-to-R2 via the presigned PUTs this endpoint issues.
const MAX_UPLOAD_URLS_BODY_BYTES = 4 * 1024 * 1024;
// Bounded concurrency for the presign batch. Presigning is CPU-light;
// 50 in-flight is generous and keeps tail latency bounded without
// fanning out to 5000 simultaneous async tasks.
const PRESIGN_BATCH_CONCURRENCY = 50;
// Bounded concurrency for the R2 head check that verifies declared assets
// were actually uploaded by the CLI before the JSON-mode deploy proceeds.
// 20 matches R2's typical head-throughput sweet spot — verifying 5000
// assets at this concurrency completes in well under the deploy heartbeat
// interval.
const R2_HEAD_VERIFY_CONCURRENCY = 20;
// Keep each project-row-lock tenure bounded while reconciling external asset
// stores. A fresh retained/in-flight hash snapshot is taken for every batch.
const ASSET_GC_LOCK_BATCH = 100;
// Retention is post-cutover and best-effort. Bound all eviction + orphan work
// across one request so cleanup can never consume the Worker's 1,000 external
// operation budget before the already-live deployment emits `done`.
const ASSET_GC_MAX_HASHES_PER_DEPLOY = 200;
// Per-blake3 / per-md5 validation: 32 lowercase hex characters.
const HEX_32_REGEX = /^[0-9a-f]{32}$/;
// Generous body cap for JSON-mode deploy POSTs. The body is dominated by
// `workerFiles` (base64-encoded user worker modules); MAX_WORKER_FILE_BYTES
// is 32 MiB per module and a worker can ship ~10 modules in practice.
//
// Base64 expansion is ~33%, so a single 32 MiB raw module weighs ~43 MiB
// on the wire. 64 MiB comfortably accommodates one full-size module (with
// safety margin) plus the manifest, assetManifest, vars, and source/commit
// JSON, while staying well under the 128 MiB Worker memory limit. Asset
// BYTES are NOT in this body — they go direct-to-R2 via presigned PUTs,
// which is the whole reason this endpoint exists.
const MAX_JSON_DEPLOY_BODY_BYTES = 64 * 1024 * 1024;

type UploadUrlsRequestAsset = Readonly<{
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
}>;

/**
 * Validate a single `assets[]` entry from `POST /:id/deploy/upload-urls`.
 * Returns an error message on failure, `null` on success. Mirrors the
 * presigner's MD5 validation so a malformed input is rejected at the
 * platform boundary rather than inside `presignAssetPut`.
 */
function validateUploadUrlsAsset(asset: unknown, index: number): string | null {
  if (asset == null || typeof asset !== 'object' || Array.isArray(asset)) {
    return `invalid assets[${index}]: must be an object`;
  }
  const assetObject = asset as Record<string, unknown>;
  if (typeof assetObject.blake3 !== 'string' || !HEX_32_REGEX.test(assetObject.blake3)) {
    return `invalid assets[${index}].blake3: must be 32 lowercase hex characters`;
  }
  if (typeof assetObject.md5 !== 'string' || !HEX_32_REGEX.test(assetObject.md5)) {
    return `invalid assets[${index}].md5: must be 32 lowercase hex characters`;
  }
  if (
    typeof assetObject.size !== 'number' ||
    !Number.isInteger(assetObject.size) ||
    assetObject.size < 0 ||
    !Number.isFinite(assetObject.size)
  ) {
    return `invalid assets[${index}].size: must be a non-negative integer`;
  }
  if (typeof assetObject.contentType !== 'string' || assetObject.contentType.length === 0) {
    return `invalid assets[${index}].contentType: must be a non-empty string`;
  }
  return null;
}

/**
 * Issue presigned R2 PUT URLs for a batch of declared assets.
 *
 * Project access is handled the same way as `/deploy/preflight`: the actor
 * needs deploy capability and the current owner must be active.
 * Each asset's blake3 keys it under `assets/${projectId}/${blake3}`; MD5
 * is signed into the URL's headers so R2 enforces "uploaded bytes' MD5
 * matches declared MD5" at write time. URLs expire in 30 minutes.
 *
 * Returns `{ urls: { [blake3]: { url, headers } } }`. Note: when two
 * assets in the batch share a blake3 (deduplicated content under
 * different paths), the second write to the result map wins — both are
 * pointed at the same key, so this is the intended dedupe behaviour.
 *
 * FOLLOW-UP: For very slow deploys (large bundles + low bandwidth + low
 * upload concurrency), a 30-min TTL can still expire on the tail of the
 * upload pool before that asset's PUT runs. The next iteration of this
 * endpoint should re-presign on `SignatureExpired` 403 from R2 — keyed
 * off a CLI-side retry against `/deploy/upload-urls` for the affected
 * blake3s. Tracking issue: see meta/design-docs/0068 follow-up.
 */
// Sentinel thrown out of the upload-urls FOR-SHARE transaction to signal
// "project flipped to status='deleting' before we acquired the lock".
// Caught at the awaiting site to surface a 410 to the CLI. Mirrors the
// `PROJECT_DELETING_ERROR_MESSAGE` pattern used by `handleManifestOnlyDeploy`.
const UPLOAD_URLS_PROJECT_DELETING = 'upload_urls:project_deleting';

app.post('/:id/deploy/upload-urls', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }
  const project = access.project;
  // Fast 410 — mirror `handleManifestOnlyDeploy`. The unlocked read here
  // is a TOCTOU best-effort: it short-circuits the common case (project
  // already marked `deleting` before this request arrived). The
  // authoritative status check happens inside the FOR-SHARE transaction
  // below so a teardown that lands AFTER this read but BEFORE we issue
  // presigns is forced to wait until our share lock releases — and any
  // teardown that already committed before we acquired the lock will be
  // observed by the in-tx re-read and surface as a 410.
  if (project.status === 'deleting') {
    return context.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs BEFORE body parsing so a stale CLI sending a
  // multipart body gets the friendly 426 upgrade message instead of an
  // opaque "invalid JSON body" 400 from the JSON parse below. Runs AFTER
  // the unlocked 410 fast-path so a stale CLI hitting an already-deleting
  // project still sees the more specific 410 ("upgrading won't bring the
  // project back"). The remaining 426-vs-410 race window — where the
  // status flips to `deleting` between the unlocked check and this gate
  // — is microseconds (no I/O between them) and surfaces as 426 to the
  // CLI; that's a UX wart, not a correctness bug, since the user does
  // need to upgrade anyway.
  const versionReject = checkCliVersionOrRespond(context);
  if (versionReject) {
    return versionReject;
  }
  try {
    await requireNormalizedProject(context.get('db'), project);
  } catch (error) {
    if (error instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: error.code, message: error.message }, 409);
    }
    throw error;
  }
  // TODO(orphan-gc): authenticated users can upload bytes via upload-urls
  // without ever finalizing a deploy, leaving durable orphans. Teardown
  // cleans these up; for active projects, abandoned uploads accumulate
  // until a future deploy's retention cleanup happens to walk over them.
  // Track in a follow-up: add a periodic per-project R2 sweep that diffs
  // `assets/${projectId}/*` against the union of retained manifests.

  const startedAt = Date.now();
  const logger = createDeployLogger({
    projectId,
    projectSlug: project.slug,
    userId: context.get('user').id,
    branch: null,
  });

  // Stream the body with a hard size cap before JSON.parse — `context.req.json()`
  // would otherwise buffer arbitrary bytes from a malicious / buggy client
  // before parsing, peaking at body bytes plus a UTF-16 string plus the
  // parsed object. The cap is enforced via TransformStream so we abort the
  // moment the threshold is crossed; native `Response.json()` then handles
  // streaming + parsing efficiently. Mirrors `handleManifestOnlyDeploy`.
  if (!context.req.raw.body) {
    return context.json({ error: 'request body is required' }, 400);
  }
  let totalBytes = 0;
  let overflowed = false;
  const limited = context.req.raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_UPLOAD_URLS_BODY_BYTES) {
          overflowed = true;
          controller.error(new Error('body too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let parsed: unknown;
  try {
    parsed = await new Response(limited, {
      headers: { 'Content-Type': 'application/json' },
    }).json();
  } catch (err) {
    if (overflowed) {
      return context.json(
        {
          error: `request body exceeds ${MAX_UPLOAD_URLS_BODY_BYTES} bytes`,
        },
        413,
      );
    }
    return context.json(
      { error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return context.json({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  if (!Array.isArray(body.assets)) {
    return context.json({ error: 'request body must include an `assets` array' }, 400);
  }
  if (body.assets.length > MAX_UPLOAD_URLS_BATCH) {
    return context.json(
      {
        error: `assets[] has ${body.assets.length} entries, exceeds the ${MAX_UPLOAD_URLS_BATCH} per-request limit`,
      },
      400,
    );
  }
  for (let i = 0; i < body.assets.length; i++) {
    const err = validateUploadUrlsAsset(body.assets[i], i);
    if (err) {
      return context.json({ error: err }, 400);
    }
  }
  const assets = body.assets as ReadonlyArray<UploadUrlsRequestAsset>;

  logger.info('upload_urls', 'request', { assetCount: assets.length });

  const urls: Record<string, { url: string; headers: Record<string, string> }> = {};
  try {
    // Serialize against project teardown. `lockAndMarkDeleting` takes
    // FOR UPDATE on the project row in `provisioning/cleanup.ts`; we take
    // FOR SHARE here, which is compatible with concurrent upload-urls /
    // deploy precheck calls (also FOR SHARE / FOR UPDATE on the same row,
    // queueing as Postgres allows) but blocks teardown until this
    // transaction commits. Once the lock is acquired we re-read the
    // project row inside the transaction; if status flipped to `deleting`
    // between the unlocked early-out above and the lock acquisition,
    // throw the sentinel to surface a 410 to the CLI.
    //
    // Lock window: presigning is pure HMAC (no R2 / DB / network I/O
    // beyond the initial SELECT FOR SHARE). A 5000-entry batch fans out
    // to 50 concurrent crypto.subtle signs and finishes in ~250 ms, so
    // teardown never waits long for the share lock to release.
    await context.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR SHARE`);
      const txDb = tx as unknown as Db;
      const lockedProject = await getProject(txDb, projectId);
      if (!lockedProject || lockedProject.status === 'deleting') {
        throw new Error(UPLOAD_URLS_PROJECT_DELETING);
      }
      // Derived signing keys are identical within this request. Keep the cache
      // request-local so credentials and derived keys are released with the batch.
      const signingKeyCache = new Map<string, ArrayBuffer>();
      await requireActiveDeployAccess(txDb, projectId, context.get('user').id);
      await requireNormalizedProject(txDb, lockedProject);
      await uploadPool(assets, PRESIGN_BATCH_CONCURRENCY, async (asset) => {
        const result = await presignAssetPut(
          {
            accountId: context.env.CF_ACCOUNT_ID,
            accessKeyId: context.env.R2_ACCESS_KEY_ID,
            secretAccessKey: context.env.R2_SECRET_ACCESS_KEY,
            bucket: context.env.R2_STATIC_ASSETS_BUCKET,
            key: `assets/${projectId}/${asset.blake3}`,
            md5: asset.md5,
            contentType: asset.contentType,
            // 30 minutes. With ~570 assets, concurrency=10, and a slow uplink
            // a tail asset can sit in the pool for >10 min before its first
            // PUT — 600s expired and R2 returned 403 SignatureExpired which
            // the CLI treats as terminal. 1800s covers all realistic
            // deploys; pathological multi-hour deploys are deferred to the
            // re-presign-on-expiry follow-up noted in the docstring above.
            ttlSeconds: 1800,
          },
          signingKeyCache,
        );
        // Last-write-wins on duplicate blake3 — see docstring above. Map
        // assignment is synchronous so concurrent pool tasks do not race
        // beyond a benign last-writer.
        urls[asset.blake3] = result;
      });
    });
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) {
      return context.json(projectAccessErrorBody(err), 403);
    }
    if (err instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: err.code, message: err.message }, 409);
    }
    if (err instanceof Error && err.message === UPLOAD_URLS_PROJECT_DELETING) {
      return context.json({ error: 'project is being deleted' }, 410);
    }
    logger.error('upload_urls', 'presign_error', err, { assetCount: assets.length });
    return context.json(
      {
        error: `failed to presign upload URLs: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  logger.info('upload_urls', 'response', {
    urlsIssued: Object.keys(urls).length,
    durationMs: Date.now() - startedAt,
  });

  return context.json({ urls });
});

// Deploy to a project
app.post('/:id/deploy', handleManifestOnlyDeploy);

/**
 * JSON-mode (manifest-only) deploy handler — direct-to-R2 asset upload flow.
 *
 * Operates on a JSON request body. The CLI uploads asset bytes directly
 * to R2 via presigned PUTs (issued by the `/deploy/upload-urls` endpoint
 * above) BEFORE calling this handler, so the request body carries only:
 *   - `manifest` (DeployManifest, must declare `assetManifestVersion: 2`)
 *   - `assetManifest` (path → { blake3, md5, size })
 *   - `source`, `commit`, `repositoryUrl`, `commitUrl`, `gitRef`, `preflight`
 *   - `vars` (optional plain-text bindings — same as `manifest.vars`)
 *   - `workerFiles` (base64-encoded module bytes for WfP deploys; absent for
 *     static-only deploys)
 *
 * The bytes for declared assets MUST already be in `STATIC_ASSETS_R2` under
 * `assets/${projectId}/${blake3}` — the handler does parallel `R2.head` to
 * verify before the deploy proceeds. A missing hash is a hard 400.
 *
 * For static deploys, every asset's serving-manifest entry is `!{hash}` —
 * direct-to-R2 always lands in R2. For WfP deploys, asset bytes are fetched
 * back from `STATIC_ASSETS_R2` to populate the in-memory `assetsByHash` map
 * that `uploadAssetBuckets` consumes — server-internal R2-to-CF traffic
 * bypasses the user's request pipe, which is the whole point of the
 * direct-to-R2 flow.
 */
async function handleManifestOnlyDeploy(context: Context<ApiEnv>): Promise<Response> {
  // Hono's `context.req.param('id')` types as `string | undefined` when called
  // from a non-route-typed context (we receive `Context<ApiEnv>` rather
  // than the route-typed callback Hono synthesises for `app.post`). The
  // route literal is `/:id/deploy`, so this is always a string at
  // runtime — narrow by hand. The ApiEnv route registry guarantees the
  // path matched.
  const projectId = context.req.param('id') as string;
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }
  let project = access.project;
  // Scoped deploy tokens (aud:'deploy') are pinned to a single project. Reject
  // any attempt to use one against a different project. Full api tokens leave
  // deployScope unset and skip this guard.
  const deployScope = context.get('deployScope');
  if (deployScope && deployScope !== projectId) {
    return context.json(
      {
        error: 'forbidden',
        message:
          'This deploy credential belongs to a different project. Use a credential issued for the project you want to deploy.',
      },
      403,
    );
  }
  // A scoped deploy token may carry the build it was minted for. Reject it once
  // that build is no longer active (e.g. superseded/cancelled by a newer push or
  // run), so a stale runner can't deploy an older commit after being superseded.
  // Tokens without a build claim (full-API tokens, CI credential tokens) skip this.
  const deployBuild = context.get('deployBuild');
  if (deployBuild) {
    const build = await getBuild(context.get('db'), deployBuild);
    if (!build || !ACTIVE_BUILD_STATUSES.includes(build.status)) {
      return context.json(
        {
          error: 'forbidden',
          message:
            'This build is no longer active. Start a new build to deploy the current version.',
        },
        403,
      );
    }
  }
  if (project.status === 'deleting') {
    return context.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs AFTER project authz so a stale CLI hitting a
  // missing/foreign/deleting project still gets the more specific
  // 404/403/410 first. The multipart sniff inside the helper is
  // header-only — it does not read the request body, so calling it
  // here does not interfere with the streaming JSON parse below.
  const versionReject = checkCliVersionOrRespond(context);
  if (versionReject) {
    return versionReject;
  }
  try {
    await requireNormalizedProject(context.get('db'), project);
  } catch (error) {
    if (error instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: error.code, message: error.message }, 409);
    }
    throw error;
  }
  const cliVersion = context.req.header('x-void-cli-version') ?? null;

  const actor = context.get('user');
  let owner = access.owner;

  let logger: DeployLogger = createDeployLogger({
    projectId,
    projectSlug: project.slug,
    userId: actor.id,
    branch: null,
  });

  // Parse + validate the JSON body BEFORE the precheck-and-claim transaction.
  // A malformed body should not consume the project's active-deploy slot —
  // the JSON body can be validated up-front and rejected without ever
  // inserting a placeholder row.
  //
  // Stream the body through a counting TransformStream and let
  // `Response.json()` handle the parse natively. The previous implementation
  // collected chunks into an Array, copied them into a Uint8Array, decoded
  // to a UTF-16 string, and ran JSON.parse — peaking at ~4× the body size
  // in residency for a body that can legitimately reach 64 MiB. Native
  // Response.json() consumes the stream incrementally and reuses internal
  // buffers; the only retained allocation at the end is the parsed object.
  if (!context.req.raw.body) {
    return context.json({ error: 'request body is required' }, 400);
  }
  let totalBytes = 0;
  let overflowed = false;
  const limited = context.req.raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_JSON_DEPLOY_BODY_BYTES) {
          overflowed = true;
          controller.error(new Error('body too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let parsedBody: unknown;
  try {
    parsedBody = await new Response(limited, {
      headers: { 'Content-Type': 'application/json' },
    }).json();
  } catch (err) {
    if (overflowed) {
      return context.json(
        {
          error: `request body exceeds ${MAX_JSON_DEPLOY_BODY_BYTES} bytes (asset bytes must be uploaded direct-to-R2, not in the request body)`,
        },
        413,
      );
    }
    return context.json(
      { error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  if (parsedBody == null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return context.json({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsedBody as Record<string, unknown>;

  // Manifest validation. `validateManifestShape` is the canonical source of
  // truth for what's accepted; the `assetManifestVersion === 2` check below
  // requires the v2 wire shape (blake3 + md5 + size per asset) that
  // direct-to-R2 deploys depend on.
  if (body.manifest == null || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
    return context.json(
      { event: 'error', message: 'manifest is required and must be an object' },
      400,
    );
  }
  const shapeError = validateManifestShape(body.manifest);
  if (shapeError) {
    return context.json({ event: 'error', message: shapeError }, 400);
  }
  const incomingManifest = body.manifest as DeployManifest;
  // Stored deployment manifests remain readable without this contract. Only
  // new SQLite builds that run migrations must include their verified plan.
  const migrations = incomingManifest.migrations;
  if (
    migrations &&
    migrations.pending > 0 &&
    (migrations.dialect === 'sqlite' || migrations.dialect === undefined) &&
    (migrations.protocolVersion !== 2 ||
      migrations.classifierVersion !== MIGRATION_CLASSIFIER_VERSION ||
      !/^sha256:[a-f0-9]{64}$/.test(migrations.migrationListHash ?? '') ||
      (migrations.stability !== 'stable' && migrations.stability !== 'legacy'))
  ) {
    return context.json(
      {
        event: 'error',
        message:
          'SQLite migrations require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.',
      },
      400,
    );
  }
  if (
    incomingManifest.emailProtocolVersion === 1 &&
    getPlatformCapabilities(context.env).email &&
    context.env.EMAIL_SENDER_DOMAIN
  ) {
    await reconcileSharedEmailRecipient(
      context.get('db'),
      context.env,
      projectId,
      incomingManifest,
    );
    const readiness = await getSharedEmailRecipientReadiness(
      context.get('db'),
      context.env,
      projectId,
    );
    if (readiness?.status !== 'ready') {
      return context.json(
        {
          event: 'error',
          message:
            readiness?.reason ??
            'Shared email recipient routing is not ready; ask a platform administrator to reconcile shared email',
        },
        409,
      );
    }
  }
  if (incomingManifest.sandbox && incomingManifest.sandbox.controllerProtocol !== 2) {
    return context.json(
      {
        event: 'error',
        message:
          'Managed Sandboxes require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.',
      },
      400,
    );
  }
  if (
    incomingManifest.sandbox &&
    ((incomingManifest.sandbox.image !== 'cloudflare/debian-trixie' &&
      !isSandboxRegistryImage(incomingManifest.sandbox.image)) ||
      (incomingManifest.sandbox.instanceType !== undefined &&
        !['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4'].includes(
          incomingManifest.sandbox.instanceType,
        )))
  ) {
    return context.json(
      {
        event: 'error',
        message:
          'Sandbox requires a digest-pinned Cloudflare registry image and a supported instance type.',
      },
      400,
    );
  }
  if (incomingManifest.sandbox && 'runtime' in incomingManifest.sandbox) {
    return context.json(
      { event: 'error', message: 'sandbox.runtime is reserved for the platform.' },
      400,
    );
  }
  if (incomingManifest.sandbox && !getPlatformCapabilities(context.env).sandbox) {
    return context.json(
      {
        event: 'error',
        message: 'This Void platform does not enable sandbox deployments.',
      },
      501,
    );
  }
  // Reject before any paid or slow work (Sandbox controllers, uploads,
  // migrations) when routing could not carry this project's protection yet.
  // The cutover fence repeats this check with the authoritative lock.
  try {
    await resolveProjectZeroTrustRouting(context.get('db'), projectId);
  } catch (error) {
    const message = zeroTrustNotReadyMessage(error);
    if (!message) {
      throw error;
    }
    return context.json({ event: 'error', error: 'zero trust not ready', message }, 409);
  }
  if (incomingManifest.sandbox) {
    try {
      await assertManagedSandboxEntitlement(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN);
    } catch (error) {
      return context.json(
        {
          event: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Cloudflare Containers access could not be verified.',
        },
        403,
      );
    }
  }
  if (
    incomingManifest.version == null ||
    !SUPPORTED_MANIFEST_VERSIONS.includes(incomingManifest.version)
  ) {
    return context.json(
      { event: 'error', message: 'Unsupported deploy manifest version. Please update void.' },
      400,
    );
  }
  if (incomingManifest.assetManifestVersion !== 2) {
    return context.json(
      {
        event: 'error',
        message: 'deploy requires assetManifestVersion: 2; please upgrade your void CLI',
      },
      400,
    );
  }

  // Validate the v2 asset manifest. Each entry MUST carry a 32-hex blake3
  // (storage key), 32-hex md5 (R2 PUT integrity check), and a non-negative
  // integer size. We translate the v2 entries into the v1 shape
  // (`{ hash: blake3, size }`) the rest of the pipeline expects — this
  // keeps the existing dedupe / retention / serving-manifest code paths
  // unchanged. The md5 isn't carried into the persisted manifest because
  // BLAKE3 is the storage-key identifier and md5 is purely a write-time
  // R2 integrity primitive.
  if (
    body.assetManifest == null ||
    typeof body.assetManifest !== 'object' ||
    Array.isArray(body.assetManifest)
  ) {
    return context.json(
      { event: 'error', message: 'assetManifest is required and must be an object' },
      400,
    );
  }
  const rawAssetManifest = body.assetManifest as Record<string, unknown>;
  const assetEntries = Object.entries(rawAssetManifest);
  if (assetEntries.length > MAX_UPLOAD_URLS_BATCH) {
    return context.json(
      {
        event: 'error',
        message: `assetManifest has ${assetEntries.length} entries, exceeds the ${MAX_UPLOAD_URLS_BATCH} per-deploy limit`,
      },
      400,
    );
  }
  const incomingAssetManifest: Record<string, AssetManifestEntry> = {};
  for (const [path, raw] of assetEntries) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return context.json(
        { event: 'error', message: `invalid assetManifest entry for ${path}: must be an object` },
        400,
      );
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.blake3 !== 'string' || !HEX_32_REGEX.test(entry.blake3)) {
      return context.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: blake3 must be 32 lowercase hex characters`,
        },
        400,
      );
    }
    if (typeof entry.md5 !== 'string' || !HEX_32_REGEX.test(entry.md5)) {
      return context.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: md5 must be 32 lowercase hex characters`,
        },
        400,
      );
    }
    if (
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isFinite(entry.size)
    ) {
      return context.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: size must be a non-negative integer`,
        },
        400,
      );
    }
    incomingAssetManifest[path] = { hash: entry.blake3, size: entry.size };
  }

  // Optional metadata fields.
  const source = typeof body.source === 'string' ? body.source : null;
  const commit = typeof body.commit === 'string' ? body.commit : null;
  const repositoryUrl = typeof body.repositoryUrl === 'string' ? body.repositoryUrl : null;
  const commitUrl = typeof body.commitUrl === 'string' ? body.commitUrl : null;
  const gitRef = typeof body.gitRef === 'string' ? body.gitRef : null;

  // workerFiles is the only meaningful body content beyond the manifest
  // tuples. Each entry is a base64-encoded module body keyed by relative
  // path with a per-module cap of MAX_WORKER_FILE_BYTES (32 MiB). Absent or
  // empty means a static-only deploy.
  const execution = context.get('deploymentExecution');
  const workerFiles: Array<{ name: string; content: Blob }> = execution?.workerFiles ?? [];
  if (!execution && body.workerFiles !== undefined) {
    if (
      body.workerFiles == null ||
      typeof body.workerFiles !== 'object' ||
      Array.isArray(body.workerFiles)
    ) {
      return context.json(
        { event: 'error', message: 'workerFiles must be an object mapping relative path → base64' },
        400,
      );
    }
    // Decode each base64 module to bytes and drop the source string from the
    // parsed body before moving to the next entry. The previous implementation
    // walked `for…of Object.entries(...)` over a captured snapshot, holding
    // the entire `workerFiles` map (and thus every base64 string) live for
    // the full loop. For a near-cap module that source string alone is ~43
    // MiB UTF-16 (≈86 MiB), and the explicit `atob` + per-byte loop added a
    // second 64 MiB latin1 string before the `Uint8Array` allocation —
    // enough peak residency to push the isolate past 128 MiB on a single
    // 32 MiB module. Iterating through `body.workerFiles` directly and
    // `delete`-ing each property after decode lets V8 reclaim the source
    // string before peak. We also prefer the (now-stage-4) `fromBase64`
    // helper — single-allocation, no intermediate string — falling back to
    // the previous loop for runtimes that don't expose it (e.g. Node-based
    // tests; the production CF Workers compat date is 2026-02-12 and ships
    // the helper natively).
    const workerFilesMap = body.workerFiles as Record<string, unknown>;
    for (const filePath of Object.keys(workerFilesMap)) {
      const raw = workerFilesMap[filePath];
      if (typeof raw !== 'string') {
        return context.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} must be a base64-encoded string`,
          },
          400,
        );
      }
      let decoded: Uint8Array;
      try {
        decoded = decodeBase64ToBytes(raw);
      } catch (err) {
        return context.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
      }
      // Release the source string back to GC now that the bytes are
      // materialized — see the block comment above.
      delete workerFilesMap[filePath];
      if (decoded.byteLength > MAX_WORKER_FILE_BYTES) {
        return context.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} exceeds ${MAX_WORKER_FILE_BYTES} bytes`,
          },
          413,
        );
      }
      // Hand the bytes directly to a `Blob` so we never name the
      // `Uint8Array` past this scope — keeps per-iteration memory residency
      // bounded by one decoded module at a time.
      workerFiles.push({
        name: filePath,
        content: new Blob([decoded as unknown as BlobPart], {
          type: moduleContentType(filePath),
        }),
      });
    }
  }
  const hasWorkerFiles = workerFiles.length > 0;

  // Reject worker files for static manifest types. Without this check a
  // malformed CLI could send `workerFiles` for a `'spa'` / `'static'`
  // manifest and end up deploying a WfP worker, breaking the project type
  // invariants. Done BEFORE placeholder insert so a rejected request
  // doesn't leave a phantom row to reap.
  if (hasWorkerFiles && (incomingManifest.type === 'spa' || incomingManifest.type === 'static')) {
    return context.json(
      {
        event: 'error',
        message: 'worker parts are not allowed when manifest.type is spa or static',
      },
      400,
    );
  }

  // (env vars travel inside `manifest.vars`; the JSON-mode wire contract
  // never accepted a top-level `body.vars` — every CLI version that ever
  // hit this endpoint populated `manifest.vars` instead.)

  // Pre-validation done — now run the atomic precheck-and-claim
  // transaction. FOR UPDATE on the project row, 10-minute stale-deploy
  // reaper, placeholder insert. Once the placeholder row exists, every
  // later failure must route through the catch / finally below to avoid
  // leaving it stranded in `pending`.
  const durable = !execution && context.env.DEPLOYMENTS_QUEUE !== undefined;
  const idempotencyKey = context.req.header('x-void-deploy-idempotency-key') ?? crypto.randomUUID();
  if (durable && !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
    return context.json({ error: 'invalid deployment idempotency key' }, 400);
  }
  const stagedInput = durable
    ? await prepareDeploymentInput(
        context.env.STATIC_ASSETS_R2,
        projectId,
        body,
        workerFiles,
        context.get('deployCredential'),
      )
    : null;
  const cutoverOwnerId = execution?.operation.owner_id ?? crypto.randomUUID();
  let precheckResult:
    | {
        deployment: Awaited<ReturnType<typeof createDeployment>>;
        currentLiveDeployment: Awaited<ReturnType<typeof getDeployment>>;
        project: Project;
        owner: typeof owner;
        reconciledMarkerKeys?: ReadonlyArray<string>;
      }
    | { receipt: string }
    | { canceling: string }
    | { recoveryFailed: string }
    | { cpuLimit: Readonly<{ requested: number; maximum: number }> };
  try {
    precheckResult = await context.get('db').transaction(async (tx) => {
      if (
        durable &&
        (await installationDeploymentAdmissionClosed(tx, context.env.PLATFORM_INSTALLATION_ID))
      ) {
        throw new Error('deployment admission closed for platform maintenance');
      }
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const txDb = tx as unknown as Db;
      const lockedProject = await getProject(txDb, projectId);
      if (!lockedProject || lockedProject.status === 'deleting') {
        throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
      }
      const lockedAccess = await requireActiveDeployAccess(txDb, projectId, actor.id);
      const requestedCpuMs = incomingManifest.limits?.cpuMs;
      const maxCpuMs = (await resolvePlanLimits(tx, lockedAccess.owner.plan)).maxCpuMsPerRequest;
      if (requestedCpuMs !== undefined && maxCpuMs > 0 && requestedCpuMs > maxCpuMs) {
        return { cpuLimit: { requested: requestedCpuMs, maximum: maxCpuMs } } as const;
      }
      await requireNormalizedProject(txDb, lockedProject);
      if (execution) {
        await assertDeploymentExecutionAuthority(txDb, execution.operation);
        const operation = await getDeploymentOperation(txDb, execution.operation.id);
        const deployment = await getDeployment(txDb, execution.operation.id);
        if (
          !operation ||
          operation.owner_id !== execution.operation.owner_id ||
          operation.status !== 'running' ||
          !deployment ||
          deployment.status !== 'pending'
        ) {
          throw new Error('deployment execution claim is no longer active');
        }
        return {
          deployment,
          currentLiveDeployment: operation.original_active_id
            ? await getDeployment(txDb, operation.original_active_id)
            : null,
          project: lockedAccess.project,
          owner: lockedAccess.owner,
        } as const;
      }
      if (stagedInput) {
        const existing = await findDeploymentOperation(txDb, projectId, actor.id, idempotencyKey);
        if (existing) {
          if (
            existing.input_digest !== stagedInput.digest ||
            existing.build_id !== (deployBuild ?? null)
          ) {
            throw new Error('deployment idempotency key was reused for different input');
          }
          return { receipt: existing.id } as const;
        }
      }
      const [unfinishedOperation] = await txDb
        .select({ id: deploymentOperations.id })
        .from(deploymentOperations)
        .where(
          and(
            eq(deploymentOperations.project_id, projectId),
            drizzleSql`${deploymentOperations.status} <> 'terminal'`,
          ),
        )
        .limit(1);
      if (unfinishedOperation) {
        throw new ConcurrentDeployError(unfinishedOperation.id);
      }
      const committedActiveDeploymentId = lockedProject.active_deployment_id;
      let activeDeploy = await getActiveDeployment(txDb, projectId);
      if (activeDeploy) {
        const operation = await getDeploymentOperation(txDb, activeDeploy.id);
        if (operation && operation.status !== 'terminal') {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
      }
      let recoveredCutover: Deployment | null = null;
      let recoveryFailedDeploymentId: string | null = null;
      const reconciledMarkerKeys: Array<string> = [];
      if (
        activeDeploy &&
        (activeDeploy.status === 'cutover' || activeDeploy.status === 'compensating')
      ) {
        const protectedDeployment = activeDeploy;
        const [intentRaw, readyRaw, compensated] = await Promise.all([
          context.env.ROUTING.get(cutoverIntentKey(protectedDeployment.id)),
          context.env.ROUTING.get(cutoverReadyKey(protectedDeployment.id)),
          context.env.ROUTING.get(cutoverCompensatedKey(protectedDeployment.id)),
        ]);
        const intent = parseCutoverMarker(intentRaw);
        const ready = parseCutoverMarker(readyRaw);
        const readyMatchesIntent =
          protectedDeployment.status === 'cutover' &&
          intent?.projectId === projectId &&
          ready?.projectId === projectId &&
          ready.ownerId === intent.ownerId;
        let protectedBuildInactive = false;
        let protectedAssetsMissing = false;

        if (compensated === projectId) {
          await updateDeploymentStatus(
            txDb,
            protectedDeployment.id,
            'failed',
            'cutover compensation completed',
            { force: true },
          );
          reconciledMarkerKeys.push(
            cutoverIntentKey(protectedDeployment.id),
            cutoverReadyKey(protectedDeployment.id),
            cutoverCompensatedKey(protectedDeployment.id),
          );
          activeDeploy = null;
        }

        if (activeDeploy && readyMatchesIntent) {
          let buildIsActive = true;
          if (ready.buildId) {
            try {
              await assertBoundBuildStillActive(txDb, ready.buildId, projectId);
            } catch (error) {
              if (error instanceof Error && error.message === SUPERSEDED_BUILD_ERROR_MESSAGE) {
                buildIsActive = false;
                protectedBuildInactive = true;
              } else {
                throw error;
              }
            }
          }
          if (buildIsActive) {
            try {
              await assertPersistedDeploymentServingAssetsExist(context.env, protectedDeployment);
            } catch (error) {
              if (error instanceof StaticAssetDisappearedError) {
                buildIsActive = false;
                protectedAssetsMissing = true;
              } else {
                throw error;
              }
            }
            if (buildIsActive) {
              const cutoverManifest = JSON.parse(protectedDeployment.manifest!) as DeployManifest;
              await updateDeploymentStatus(txDb, protectedDeployment.id, 'live', undefined, {
                force: true,
              });
              await updateProjectType(
                txDb,
                projectId,
                resolvePersistedDeploymentType(cutoverManifest, protectedDeployment),
              );
              await setActiveDeployment(txDb, projectId, protectedDeployment.id);
              await markDeploymentRetained(txDb, protectedDeployment.id, true);
              recoveredCutover = { ...protectedDeployment, status: 'live', retained: true };
              reconciledMarkerKeys.push(
                cutoverIntentKey(protectedDeployment.id),
                cutoverReadyKey(protectedDeployment.id),
              );
              activeDeploy = null;
            }
          }
        }

        if (activeDeploy) {
          if (!protectedBuildInactive && intent?.buildId) {
            try {
              await assertBoundBuildStillActive(txDb, intent.buildId, projectId);
            } catch (error) {
              if (error instanceof Error && error.message === SUPERSEDED_BUILD_ERROR_MESSAGE) {
                protectedBuildInactive = true;
              } else {
                throw error;
              }
            }
          }
          const protectedUpdatedAtMs = databaseTimestampMs(protectedDeployment.updated_at);
          if (
            protectedDeployment.status !== 'compensating' &&
            !protectedBuildInactive &&
            !protectedAssetsMissing &&
            (protectedUpdatedAtMs === null ||
              Date.now() - protectedUpdatedAtMs < CUTOVER_RECOVERY_STALE_MS)
          ) {
            throw new ConcurrentDeployError(protectedDeployment.id);
          }

          // Take ownership from a request that has exceeded the platform's
          // maximum build lifetime. The old owner validates this marker before
          // every later external/final/compensation step and must stand down.
          const recoveryMarker: CutoverMarker = {
            projectId,
            ownerId: cutoverOwnerId,
            buildId: intent?.buildId ?? null,
          };
          await context.env.ROUTING.put(
            cutoverIntentKey(protectedDeployment.id),
            JSON.stringify(recoveryMarker),
          );

          const committedActive = committedActiveDeploymentId
            ? await getDeployment(txDb, committedActiveDeploymentId)
            : null;
          const compensateRecovery = async (
            reason: string,
            originalError?: unknown,
          ): Promise<boolean> => {
            try {
              if (committedActive) {
                await replayDeploymentCutover(
                  context.env,
                  txDb,
                  lockedProject,
                  committedActive,
                  lockedProject.type,
                  { restoreCommitted: true },
                );
              } else {
                await clearProjectExternalState(context.env, txDb, lockedProject);
              }
              // Write the durable marker before the PostgreSQL transition. If
              // COMMIT acknowledgement is lost, the next recovery knows the
              // authoritative deployment was already restored and must never
              // replay the abandoned target again.
              await context.env.ROUTING.put(
                cutoverCompensatedKey(protectedDeployment.id),
                projectId,
              );
            } catch (compensationError) {
              await updateDeploymentStatus(
                txDb,
                protectedDeployment.id,
                'compensating',
                'cutover recovery compensation incomplete',
                { force: true },
              );
              recoveryFailedDeploymentId = protectedDeployment.id;
              logger.error('precheck', 'cutover_recovery_compensation_failed', compensationError, {
                deploymentId: protectedDeployment.id,
                ...(originalError !== undefined && {
                  originalError:
                    originalError instanceof Error ? originalError.message : String(originalError),
                }),
              });
              return false;
            }
            await updateDeploymentStatus(txDb, protectedDeployment.id, 'failed', reason, {
              force: true,
            });
            return true;
          };
          let replayProtectedDeployment =
            protectedDeployment.status === 'cutover' &&
            !protectedBuildInactive &&
            !protectedAssetsMissing;
          if (replayProtectedDeployment && recoveryMarker.buildId) {
            try {
              await assertBoundBuildStillActive(txDb, recoveryMarker.buildId, projectId);
            } catch (error) {
              if (error instanceof Error && error.message === SUPERSEDED_BUILD_ERROR_MESSAGE) {
                replayProtectedDeployment = false;
              } else {
                throw error;
              }
            }
          }
          if (replayProtectedDeployment) {
            let replayError: unknown;
            try {
              await replayDeploymentCutover(context.env, txDb, lockedProject, protectedDeployment);
              await assertPersistedDeploymentServingAssetsExist(context.env, protectedDeployment);
              await context.env.ROUTING.put(
                cutoverReadyKey(protectedDeployment.id),
                JSON.stringify(recoveryMarker),
              );
            } catch (error) {
              replayError = error;
            }
            if (replayError === undefined) {
              const cutoverManifest = JSON.parse(protectedDeployment.manifest!) as DeployManifest;
              await updateDeploymentStatus(txDb, protectedDeployment.id, 'live', undefined, {
                force: true,
              });
              await updateProjectType(
                txDb,
                projectId,
                resolvePersistedDeploymentType(cutoverManifest, protectedDeployment),
              );
              await setActiveDeployment(txDb, projectId, protectedDeployment.id);
              await markDeploymentRetained(txDb, protectedDeployment.id, true);
              recoveredCutover = { ...protectedDeployment, status: 'live', retained: true };
            } else {
              await compensateRecovery('cutover replay failed and was compensated', replayError);
            }
          } else {
            await compensateRecovery(
              compensated === projectId
                ? 'cutover compensation recovered'
                : 'abandoned cutover recovered',
            );
          }
          reconciledMarkerKeys.push(
            cutoverIntentKey(protectedDeployment.id),
            cutoverReadyKey(protectedDeployment.id),
            cutoverCompensatedKey(protectedDeployment.id),
          );
          activeDeploy = null;
        }
      }
      if (recoveryFailedDeploymentId) {
        return { recoveryFailed: recoveryFailedDeploymentId } as const;
      }
      if (activeDeploy) {
        if (activeDeploy.source === 'rollback-lease') {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const activeUpdatedAtMs = databaseTimestampMs(activeDeploy.updated_at);
        if (activeUpdatedAtMs === null) {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const ageMs = Date.now() - activeUpdatedAtMs;
        if (ageMs < 10 * 60 * 1000) {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const staleNext = activeDeploy.status === 'canceling' ? 'canceled' : 'canceling';
        logger.info('status_transition', 'status_change', {
          deploymentId: activeDeploy.id,
          from: activeDeploy.status,
          to: staleNext,
          reason: 'precheck_reap_timeout',
        });
        await updateDeploymentStatus(txDb, activeDeploy.id, staleNext, 'timed out', {
          force: true,
        });
        if (staleNext === 'canceling') {
          return { canceling: activeDeploy.id } as const;
        }
      }
      const currentLiveDeployment =
        recoveredCutover ??
        (committedActiveDeploymentId
          ? await getDeployment(txDb, committedActiveDeploymentId)
          : null);
      const deployment = await createDeployment(txDb, projectId, null, null, null, {
        cliVersion,
        // Protect reused objects before the first inventory read. Unlike new
        // PUTs, old objects have no recent-upload grace period. GC acquires this
        // same project lock and includes nonterminal rows in its protected set.
        ...(hasWorkerFiles ? { assetHashes: JSON.stringify(incomingAssetManifest) } : {}),
        billingUserId: lockedAccess.owner.id,
        initiatedByUserId: actor.id,
      });
      if (stagedInput) {
        await txDb.insert(deploymentOperations).values({
          id: deployment.id,
          project_id: projectId,
          actor_id: actor.id,
          build_id: deployBuild ?? null,
          original_active_id: currentLiveDeployment?.id ?? null,
          cli_version: cliVersion,
          idempotency_key: idempotencyKey,
          input_digest: stagedInput.digest,
          input_prefix: stagedInput.prefix,
          payload: stagedInput.input,
        });
      }
      return {
        deployment,
        currentLiveDeployment,
        project: lockedAccess.project,
        owner: lockedAccess.owner,
        ...(reconciledMarkerKeys.length > 0 && { reconciledMarkerKeys }),
      } as const;
    });
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) {
      return context.json(projectAccessErrorBody(err), 403);
    }
    if (err instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: err.code, message: err.message }, 409);
    }
    if (err instanceof ConcurrentDeployError) {
      return context.json({ error: 'deploy in progress', deployment: err.deploymentId }, 409);
    }
    if (
      err instanceof Error &&
      (err.message === 'deployment admission closed for platform maintenance' ||
        err.message === 'deployment idempotency key was reused for different input')
    ) {
      return context.json({ error: err.message }, 409);
    }
    if (err instanceof Error && err.message === PROJECT_DELETING_ERROR_MESSAGE) {
      return context.json({ error: 'project is being deleted' }, 410);
    }
    throw err;
  }
  if (stagedInput && !('deployment' in precheckResult)) {
    await paginatedR2Delete(context.env.STATIC_ASSETS_R2, stagedInput.prefix).catch(() => {});
  }
  if ('receipt' in precheckResult) {
    return deploymentReceiptResponse(context.get('db'), precheckResult.receipt);
  }
  if ('recoveryFailed' in precheckResult) {
    return context.json(
      {
        error: 'deployment recovery is incomplete; retry the deploy',
        deployment: precheckResult.recoveryFailed,
      },
      503,
    );
  }
  if ('cpuLimit' in precheckResult) {
    return context.json(
      {
        event: 'error',
        message: `limits.cpuMs ${precheckResult.cpuLimit.requested} exceeds your plan maximum of ${precheckResult.cpuLimit.maximum}`,
      },
      400,
    );
  }
  if ('canceling' in precheckResult) {
    return context.json(
      { error: 'deploy cancellation requested', deployment: precheckResult.canceling },
      409,
    );
  }
  for (const markerKey of precheckResult.reconciledMarkerKeys ?? []) {
    await context.env.ROUTING.delete(markerKey).catch(() => {
      // Once the PostgreSQL recovery transaction is acknowledged, stale
      // marker bytes are harmless and can be removed by a later attempt.
    });
  }
  const preDeployment = precheckResult.deployment;
  const currentLiveDeployment = precheckResult.currentLiveDeployment;
  project = precheckResult.project;
  owner = precheckResult.owner;
  const originalActiveDeploymentId = currentLiveDeployment?.id ?? null;

  if (durable) {
    await dispatchDeploymentOperation(context.env, context.get('db'), preDeployment.id).catch(
      (error) => {
        // The committed outbox will retry a missing/lost Queue acknowledgement.
        logger.warn('queue', 'dispatch_pending', { err: String(error) });
      },
    );
    return deploymentReceiptResponse(context.get('db'), preDeployment.id);
  }
  const planLimits = await resolvePlanLimits(context.get('db'), owner.plan);

  // Construct the response stream — same NDJSON wire contract as the
  // multipart path (heartbeats, progress events, `done`/`error`).
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let streamOpen = true;
  let currentStep = 'parsing';
  let currentDeploymentId: string = preDeployment.id;
  let currentStatus: DeploymentStatus = 'pending';
  let cutoverProtected = false;
  let phaseName = 'parsing';
  let phaseStartMs = Date.now();
  const markPhase = (next: string): void => {
    const now = Date.now();
    logger.info(phaseName, 'phase_end', { durationMs: now - phaseStartMs });
    phaseName = next;
    phaseStartMs = now;
    logger.info(next, 'phase_start');
  };
  let persistedEvents = Promise.resolve();
  let terminalEvent: DeployEvent | undefined;
  const emit = (event: DeployEvent): void => {
    if (execution) {
      if (event.event === 'done' || event.event === 'error') {
        terminalEvent = event;
        return;
      }
      persistedEvents = persistedEvents.then(async () => {
        // Intermediate progress is best effort. Retry a transient database
        // failure once, but never let it poison later events or prevent the
        // authoritative terminal result from being committed after execution.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await appendDeploymentEvent(context.get('db'), preDeployment.id, cutoverOwnerId, event);
            return;
          } catch (error) {
            if (attempt === 1) {
              logger.warn('progress', 'persist_failed', { event: event.event, err: String(error) });
            }
          }
        }
      });
      return;
    }
    logger.info('emit', 'ndjson_event', event as unknown as Record<string, unknown>);
    if (!streamOpen) {
      return;
    }
    writer.write(encoder.encode(JSON.stringify(event) + '\n')).catch((err) => {
      streamOpen = false;
      logger.warn('emit', 'stream_closed', { event: event.event, err: String(err) });
    });
  };
  const heartbeatOverride = context.env.DEPLOY_HEARTBEAT_INTERVAL_MS;
  const heartbeatIntervalMs =
    typeof heartbeatOverride === 'number' &&
    Number.isFinite(heartbeatOverride) &&
    heartbeatOverride > 0
      ? Math.max(1, heartbeatOverride)
      : 15_000;

  const pipeline = (async () => {
    logger.info('json_validate', 'phase_start');
    phaseName = 'json_validate';
    phaseStartMs = Date.now();
    let routingSwitched = false;
    let cutoverCommitted = false;
    const writtenRoutingKeys: Array<string> = [];
    const routingValuesBeforeWrite = new Map<string, string | null>();
    const routingValuesWritten = new Map<string, string | null>();
    const snapshotRoutingValue = async (key: string): Promise<void> => {
      if (!routingValuesBeforeWrite.has(key)) {
        routingValuesBeforeWrite.set(key, await context.env.ROUTING.get(key));
        writtenRoutingKeys.push(key);
      }
    };
    const putTrackedRouting = async (key: string, value: string): Promise<void> => {
      await snapshotRoutingValue(key);
      // Record the intended mutation before awaiting KV. A write can commit at
      // Cloudflare and still reject locally when its acknowledgement is lost;
      // compensation must then inspect and undo that possibly-landed value.
      routingValuesWritten.set(key, value);
      await context.env.ROUTING.put(key, value);
    };
    const deleteTrackedRouting = async (key: string): Promise<void> => {
      await snapshotRoutingValue(key);
      routingValuesWritten.set(key, null);
      await context.env.ROUTING.delete(key);
    };
    const withProjectCutoverFence = async <T>(
      deploymentId: string,
      mutate: (
        txDb: Db,
        currentOwner: Awaited<ReturnType<typeof requireActiveDeployAccess>>['owner'],
      ) => Promise<T>,
    ): Promise<T> => {
      return await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const lockedProject = await getProject(txDb, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
        }
        const currentAccess = await requireActiveDeployAccess(txDb, projectId, actor.id);
        if (execution) {
          await assertDeploymentExecutionAuthority(txDb, execution.operation);
        }
        await assertDeploymentNotCanceled(txDb, deploymentId);
        if (cutoverProtected) {
          const intent = parseCutoverMarker(
            await context.env.ROUTING.get(cutoverIntentKey(deploymentId)),
          );
          if (intent?.ownerId !== cutoverOwnerId || intent.projectId !== projectId) {
            throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
          }
        }
        return await mutate(txDb, currentAccess.owner);
      });
    };
    // Compensation must serialize with every project cutover, not only
    // teardown. Once a newer deploy or rollback owns the project, restoring
    // this attempt's snapshots would overwrite its routing, cron, and queue
    // state while PostgreSQL points at the newer deployment. Under the shared
    // project lock, require both the original active deployment provenance and
    // the absence of a competing in-flight operation. Teardown's `deleting`
    // state and a missing row likewise make absence authoritative.
    const withProjectCompensationFence = async (
      restore: (txDb: Db) => Promise<void>,
    ): Promise<void> => {
      await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const lockedProject = await getProject(txDb, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          return;
        }
        if (lockedProject.active_deployment_id !== originalActiveDeploymentId) {
          return;
        }
        if (cutoverProtected) {
          const ownedDeployment = await getDeployment(txDb, currentDeploymentId);
          if (
            !ownedDeployment ||
            ownedDeployment.status !== 'compensating' ||
            TERMINAL_DEPLOYMENT_STATUSES.includes(ownedDeployment.status)
          ) {
            return;
          }
          const intent = parseCutoverMarker(
            await context.env.ROUTING.get(cutoverIntentKey(currentDeploymentId)),
          );
          if (intent?.projectId !== projectId || intent.ownerId !== cutoverOwnerId) {
            return;
          }
        }
        const competingOperation = await getActiveDeployment(txDb, projectId);
        if (competingOperation && competingOperation.id !== currentDeploymentId) {
          return;
        }
        await restore(txDb);
      });
    };
    const withProjectAssetGcFence = async <T>(
      knownRetainedHashes: ReadonlySet<string>,
      cleanup: (retainedHashes: Set<string>) => Promise<T>,
    ): Promise<T | null> => {
      return await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const lockedProject = await getProject(txDb, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          return null;
        }

        // Retention selection happens after go-live, so another deployment or
        // rollback can become authoritative before external GC begins. Rebuild
        // the protected hash set under the same lock used by final cutover and
        // keep that lock through R2 deletion. A following static deploy performs
        // its last R2 existence check under this lock before committing live.
        const protectedHashes = new Set(knownRetainedHashes);
        // Migrated stored bundles still reference their asset copies even when
        // their historical deployment failed or is no longer retained.
        const retained = await txDb
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.project_id, projectId),
              or(eq(deployments.retained, true), eq(deployments.bundle_stored, true)),
            ),
          );
        if (
          lockedProject.active_deployment_id &&
          !retained.some((deployment) => deployment.id === lockedProject.active_deployment_id)
        ) {
          const active = await getDeployment(txDb, lockedProject.active_deployment_id);
          if (active) {
            retained.push(active);
          }
        }
        // A direct upload lands in R2 before its deployment can become live.
        // Once the row has placement-bearing asset_hashes, protect it through
        // every nonterminal state (including canceling/compensating). The
        // recent-upload timestamp guard covers the short pre-persistence gap.
        for (const inFlight of await getInFlightDeploymentsExcluding(txDb, projectId)) {
          if (!retained.some((deployment) => deployment.id === inFlight.id)) {
            retained.push(inFlight);
          }
        }
        for (const protectedDeployment of retained) {
          if (!protectedDeployment.asset_hashes) {
            if (protectedDeployment.id === lockedProject.active_deployment_id) {
              return null;
            }
            continue;
          }
          try {
            const retainedManifest = JSON.parse(protectedDeployment.asset_hashes) as Record<
              string,
              { hash: string }
            >;
            for (const entry of Object.values(retainedManifest)) {
              protectedHashes.add(entry.hash);
            }
          } catch {
            // Corrupt retained metadata cannot prove an object is unreferenced.
            return null;
          }
        }
        return await cleanup(protectedHashes);
      });
    };
    const evictStoredWorkerBundle = async (deploymentId: string): Promise<void> => {
      await deleteWorkerBundle(context.env.STATIC_ASSETS_R2, projectId, deploymentId);
      // Stored history protects its migrated asset copy until the bundle is
      // actually gone. The following orphan sweep can now collect those bytes.
      await context
        .get('db')
        .update(deployments)
        .set({ bundle_stored: false })
        .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId)));
    };
    let remainingAssetGcHashBudget = ASSET_GC_MAX_HASHES_PER_DEPLOY;
    let orphanSweepAfterResponse: (() => Promise<void>) | null = null;
    const finishOrphanSweep = async (): Promise<void> => {
      const sweep = orphanSweepAfterResponse;
      if (!sweep) {
        return;
      }
      const work = Promise.resolve().then(sweep);
      try {
        context.executionCtx.waitUntil(work);
      } catch {
        // app.fetch() has no ExecutionContext in integration tests. Await the
        // same work there so cleanup remains observable and deterministic.
        await work;
      }
    };
    const deleteAssetHashesWithProjectFence = async (
      knownRetainedHashes: ReadonlySet<string>,
      hashes: ReadonlyArray<string>,
    ): Promise<number> => {
      let deleted = 0;
      const budgetedHashes = hashes.slice(0, remainingAssetGcHashBudget);
      for (let index = 0; index < budgetedHashes.length; index += ASSET_GC_LOCK_BATCH) {
        const batch = budgetedHashes.slice(index, index + ASSET_GC_LOCK_BATCH);
        remainingAssetGcHashBudget -= batch.length;
        const batchDeleted = await withProjectAssetGcFence(
          knownRetainedHashes,
          (currentRetainedHashes) =>
            deleteUnreferencedAssets(
              context.env.STATIC_ASSETS,
              context.env.STATIC_ASSETS_R2,
              batch,
              currentRetainedHashes,
              projectId,
            ),
        );
        deleted += batchDeleted ?? 0;
      }
      return deleted;
    };
    const sweepAssetOrphansWithProjectFence = async (
      knownRetainedHashes: ReadonlySet<string>,
    ): Promise<number> => {
      let deleted = 0;
      await scanProjectAssetOrphanCandidates(
        context.env.STATIC_ASSETS_R2,
        projectId,
        async (candidates) => {
          deleted += await deleteAssetHashesWithProjectFence(knownRetainedHashes, candidates);
        },
        { maxCandidates: remainingAssetGcHashBudget },
      );
      return deleted;
    };
    const restoreTrackedRouting = async (): Promise<void> => {
      await withProjectCompensationFence(async (txDb) => {
        const zeroTrust = await resolveProjectZeroTrustRoutingForPublication(txDb, projectId);
        const currentProject = await getProject(txDb, projectId);
        const currentOwner = currentProject ? await getUser(txDb, currentProject.user_id) : null;
        if (!currentProject || !currentOwner) {
          throw new Error('project owner is unavailable during routing compensation');
        }
        const refreshPolicy =
          currentOwner.id !== owner.id ||
          currentOwner.plan !== owner.plan ||
          (await getPlatformSetting(txDb, PLAN_CATALOG_SETTING)) !== null;
        const committedDeployment =
          refreshPolicy && currentProject.active_deployment_id
            ? await getDeployment(txDb, currentProject.active_deployment_id)
            : null;
        const committedManifest = committedDeployment?.manifest
          ? (JSON.parse(committedDeployment.manifest) as DeployManifest)
          : null;
        const currentLimits = refreshPolicy
          ? computeDispatchLimits(
              await resolvePlanLimits(txDb, currentOwner.plan),
              committedManifest?.limits,
            )
          : null;
        const errors: Array<unknown> = [];
        for (const [key, previous] of [...routingValuesBeforeWrite].reverse()) {
          try {
            if (!routingValuesWritten.has(key)) {
              continue;
            }
            const undo = resolveRoutingUndo(
              await context.env.ROUTING.get(key),
              routingValuesWritten.get(key)!,
              previous,
            );
            if (!undo.restore) {
              continue;
            }
            if (undo.value === null) {
              await context.env.ROUTING.delete(key);
            } else {
              let value = undo.value;
              if (key === project.slug || key.startsWith('domain:')) {
                value = refreshPolicy
                  ? rewriteProjectRouteMetadata(JSON.parse(value) as Record<string, unknown>, {
                      projectId,
                      userId: currentOwner.id,
                      limits: currentLimits,
                      suspended: routingSuspensionReason(currentOwner.suspended_reason),
                      zeroTrust,
                    })
                  : withProjectZeroTrustRouting(value, zeroTrust, projectId);
              }
              await context.env.ROUTING.put(key, value);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'one or more routing entries could not be restored');
        }
      });
    };
    let cronStateBeforeWrite: CronSyncState | null | undefined;
    let cronSchedulerWriteAttempted = false;
    const snapshotCronState = async (): Promise<void> => {
      if (cronStateBeforeWrite === undefined) {
        cronStateBeforeWrite = await snapshotCronScheduler(context.env, projectId);
      }
    };
    const restoreTrackedCronState = async (): Promise<void> => {
      if (cronSchedulerWriteAttempted && cronStateBeforeWrite !== undefined) {
        await withProjectCompensationFence(() =>
          restoreCronScheduler(context.env, projectId, cronStateBeforeWrite!),
        );
      }
    };
    const queueConsumerSnapshots = new Map<
      string,
      { queueId: string; scriptName: string; state: QueueConsumerInfo | null }
    >();
    const snapshotTrackedQueueConsumer = async (
      queueId: string,
      scriptName: string,
    ): Promise<void> => {
      const key = `${queueId}\0${scriptName}`;
      if (!queueConsumerSnapshots.has(key)) {
        queueConsumerSnapshots.set(key, {
          queueId,
          scriptName,
          state: await snapshotQueueConsumer(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            queueId,
            scriptName,
          ),
        });
      }
    };
    const restoreTrackedQueueConsumers = async (): Promise<void> => {
      await withProjectCompensationFence(async () => {
        const errors: Array<unknown> = [];
        for (const snapshot of [...queueConsumerSnapshots.values()].reverse()) {
          try {
            await restoreQueueConsumer(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              snapshot.queueId,
              snapshot.scriptName,
              snapshot.state,
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'one or more queue consumers could not be restored');
        }
      });
    };
    let workerUploaded = false;
    let workerUploadUrl: string | undefined;
    let sandboxControllerAttempted = false;
    let manifest: DeployManifest | undefined;
    let workerName: string | undefined;
    let dispatchNamespace: string | undefined;
    let deployment: Awaited<ReturnType<typeof createDeployment>> | undefined;
    let projectDomains: Awaited<ReturnType<typeof getDomainsByProjectId>> | undefined;

    // Bytes uploaded directly to R2 by the CLI before this request landed.
    // For static deploys this map stays empty (the static branch reads
    // them straight from R2 by hash). For WfP deploys it gets populated
    // from R2 fetches further down — the CF asset upload session needs
    // the actual bytes to fan into upload buckets.
    const assetsByHash = new Map<string, AssetEntry>();
    const heartbeat = setInterval(() => {
      emit(
        currentDeploymentId
          ? { event: 'heartbeat', deploymentId: currentDeploymentId, step: currentStep }
          : { event: 'heartbeat', step: currentStep },
      );
    }, heartbeatIntervalMs);

    let wfpMirroredManifestDeploymentId: string | null = null;

    try {
      // New deployments use only project-scoped R2 assets. Historical KV and
      // unscoped objects remain readable by their existing deployments, but a
      // redeploy must upload any bytes not present in the current store.
      currentStep = 'asset_verify';
      markPhase('asset_verify');
      const declaredHashes = Array.from(
        new Set(Object.values(incomingAssetManifest).map((e) => e.hash)),
      );
      // The active deployment's placement-bearing manifest is protected from
      // platform GC. Reusing those exact R2 hashes avoids inventorying the
      // whole project prefix again on an unchanged Worker redeploy. New or
      // legacy entries still require the existing object-store verification.
      const activeR2Sizes =
        currentLiveDeployment?.status === 'live' && currentLiveDeployment.project_id === projectId
          ? persistedR2AssetSizes(currentLiveDeployment.asset_hashes)
          : new Map<string, number>();
      const declaredSizeByHash = new Map<string, number | null>();
      for (const entry of Object.values(incomingAssetManifest)) {
        if (!declaredSizeByHash.has(entry.hash)) {
          declaredSizeByHash.set(entry.hash, entry.size);
        } else if (declaredSizeByHash.get(entry.hash) !== entry.size) {
          declaredSizeByHash.set(entry.hash, null);
        }
      }
      // Only scoped placement verified by this runtime (or the migration)
      // can skip inventory. Legacy store:'r2' alone does not prove scoping.
      const unverifiedHashes = declaredHashes.filter(
        (hash) => activeR2Sizes.get(hash) !== declaredSizeByHash.get(hash),
      );
      const missingHashes: Array<string> = [];
      // R2 binding operations count toward a Worker's per-request subrequest
      // budget. A valid manifest may contain 5,000 assets, so one HEAD per hash
      // can fail a healthy deployment before validation. Inventory the scoped
      // project prefix in paginated calls instead; this runs outside every
      // PostgreSQL transaction and stops as soon as all required hashes appear.
      const foundAssets = await findR2Assets(
        context.env.STATIC_ASSETS_R2,
        projectId,
        new Set(unverifiedHashes),
      );
      for (const hash of unverifiedHashes) {
        const object = foundAssets.get(hash);
        if (!object || object.size !== declaredSizeByHash.get(hash)) {
          missingHashes.push(hash);
        }
      }
      if (missingHashes.length > 0) {
        const cap = 10;
        const sample = missingHashes.slice(0, cap);
        const more = missingHashes.length > cap ? ` (+${missingHashes.length - cap} more)` : '';
        emit({
          event: 'error',
          message:
            `${missingHashes.length} declared asset hash${missingHashes.length === 1 ? '' : 'es'} not found in R2: ${sample.join(', ')}${more}. ` +
            `Upload may have been skipped, or presigned URLs may have expired (10 min TTL). Re-run preflight + upload-urls.`,
          step: currentStep,
        });
        return;
      }

      await ensureProjectIngress(context.env, project);

      // === MANIFEST VALIDATION & DEDUPE ===
      currentStep = 'validating';
      markPhase('manifest_validate');

      const previousManifest = parseManifest(currentLiveDeployment?.manifest);
      const websocketManifestResult = enrichWebSocketManifest(
        incomingManifest,
        previousManifest,
        project.websocket_version,
      );
      const liveManifestResult = enrichLiveManifest(
        websocketManifestResult.manifest,
        previousManifest,
        websocketManifestResult.nextVersion,
      );
      const manifestVersionChanged = websocketManifestResult.changed || liveManifestResult.changed;
      manifest = liveManifestResult.manifest;
      if (manifest.sandbox) {
        manifest = { ...manifest, sandbox: { ...manifest.sandbox, runtime: { protocol: 2 } } };
      }
      if (hasWorkerFiles && manifest.type === undefined) {
        // Rollback identifies retained Workers from their manifest, including
        // older clients that omit type and workerMain but configure asset fallbacks.
        manifest = { ...manifest, type: manifest.framework ? 'framework' : 'void' };
      }
      const finalManifestRaw = JSON.stringify(manifest);

      // Host-scoped routing rules — same logic as multipart path.
      const hostScopedRedirects = manifest.redirectRules?.some((r) => r.host) ?? false;
      const hostScopedFallbacks = manifest.fallbackRules?.some((r) => r.host) ?? false;
      if (hostScopedRedirects || hostScopedFallbacks) {
        const application = readPlatformApplication(context.env);
        projectDomains ??= await getDomainsByProjectId(context.get('db'), projectId);
        const boundHosts = new Set<string>(platformProjectHostnames(project, application));
        for (const d of projectDomains) {
          boundHosts.add(d.hostname);
        }
        const unbound = [...(manifest.redirectRules ?? []), ...(manifest.fallbackRules ?? [])]
          .map((r) => r.host)
          .filter((h): h is string => typeof h === 'string' && !boundHosts.has(h));
        if (unbound.length > 0) {
          const unique = Array.from(new Set(unbound));
          emit({
            event: 'error',
            message: `routing rule host not bound to project: ${unique.join(', ')} — add the domain (\`void domain add\`) before deploying rules scoped to it`,
            step: currentStep,
          });
          return;
        }
      }

      if (!hasWorkerFiles && currentLiveDeployment && currentLiveDeployment.status === 'live') {
        const sameManifest = currentLiveDeployment.manifest === finalManifestRaw;
        const sameAssets = equalAssetManifests(
          incomingAssetManifest,
          parseAssetManifest(currentLiveDeployment.asset_hashes),
        );
        const sameScopedAssets = declaredHashes.every(
          (hash) => activeR2Sizes.get(hash) === declaredSizeByHash.get(hash),
        );
        if (sameManifest && sameAssets && sameScopedAssets) {
          const application = readPlatformApplication(context.env);
          projectDomains ??= await getDomainsByProjectId(context.get('db'), projectId);
          const activeDomains = projectDomains.filter((d) => d.status === 'active');
          const fullUrl =
            activeDomains.length > 0
              ? `https://${activeDomains[0].hostname}`
              : `https://${platformProjectHostname(project, application)}`;

          emit({ event: 'start', deploymentId: currentLiveDeployment.id });
          emit({
            event: 'done',
            deployment: currentLiveDeployment.id,
            url: fullUrl,
            urls: [
              ...activeDomains.map((d) => `https://${d.hostname}`),
              `https://${platformProjectHostname(project, application)}`,
            ],
            assets: 0,
            workers: 0,
          });
          // Release the placeholder row — verified no-op.
          await context.get('db').delete(deployments).where(eq(deployments.id, preDeployment.id));
          return;
        }
      }

      // Daily deploy-count limit. JSON-mode deploys don't write any KV/R2
      // bytes during this request (assets pre-existed direct-to-R2), so
      // we can defer the cap check until AFTER the dedupe short-circuit
      // — same as the multipart path's worker-backed branch.
      if (planLimits.deploysPerDay > 0) {
        const todayCount = await countUserDeploymentsToday(context.get('db'), owner.id);
        if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
          emit({ event: 'error', message: 'deploy limit exceeded', step: currentStep });
          return;
        }
      }

      // Fill in the deployment record (same FOR UPDATE pattern as
      // multipart). Once this completes the deployment row is no longer
      // a precheck placeholder — every subsequent failure must transition
      // it to a terminal status via the catch path.
      deployment = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const lockedProject = await getProject(txDb, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
        }
        return await updateDeploymentManifest(
          txDb,
          preDeployment.id,
          finalManifestRaw,
          source,
          commit,
          {
            cliVersion,
            repositoryUrl,
            commitUrl,
            gitRef,
          },
        );
      });
      currentDeploymentId = deployment.id;
      logger = logger.with({ deploymentId: deployment.id });
      if (manifestVersionChanged) {
        await updateProjectWebSocketVersion(
          context.get('db'),
          projectId,
          liveManifestResult.nextVersion,
        );
      }
      dispatchNamespace = context.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      workerName = `user-${project.slug}-${deployment.id}`;

      const pipelineDeployment = deployment;
      const pipelineManifest = manifest;
      const pipelineWorkerName = workerName;
      const pipelineDispatchNamespace = dispatchNamespace;

      try {
        const deployment = pipelineDeployment;
        const manifest = pipelineManifest;
        const workerName = pipelineWorkerName;
        const dispatchNamespace = pipelineDispatchNamespace;

        emit({ event: 'start', deploymentId: deployment.id });

        // === ASSET UPLOAD PHASE ===
        currentStep = 'asset_upload';
        markPhase('asset_upload');
        logger.info('status_transition', 'status_change', {
          from: currentStatus,
          to: 'uploading',
        });
        if (!cutoverProtected) {
          await updateDeploymentStatus(context.get('db'), deployment.id, 'uploading');
          currentStatus = 'uploading';
        }
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        // JSON-mode CLI always sends the full assetManifest including
        // preflight-skipped paths; no server-side fill-in needed. Clone so
        // the cache-buster injection below mutates a fresh object rather
        // than the validated incoming map.
        const assetManifest: Record<string, AssetManifestEntry> = { ...incomingAssetManifest };
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        const isStaticOnly = !hasWorkerFiles;
        logger = logger.with({ branch: isStaticOnly ? 'static' : 'wfp' });

        // CF dedupe-poisoning workaround: same as multipart path. WfP
        // deploys with non-empty asset manifests inject a unique cache
        // buster so CF's asset session always sees at least one novel
        // hash. The buster's bytes still need to reach CF, so we put
        // them directly into `assetsByHash` (not into our R2 — they're
        // a deploy-local artifact, not a CLI-uploaded asset).
        if (!isStaticOnly && Object.keys(assetManifest).length > 0) {
          const bustPath = `/.void-deploy/${deployment.id}.txt`;
          const bustContent = `${deployment.id}\n${Date.now()}\n`;
          const bustBytes = new TextEncoder().encode(bustContent);
          const bustBuffer = bustBytes.buffer.slice(
            bustBytes.byteOffset,
            bustBytes.byteOffset + bustBytes.byteLength,
          );
          const bustHash = computeAssetHash(bustBuffer, bustPath);
          assetManifest[bustPath] = { hash: bustHash, size: bustBytes.byteLength };
          assetsByHash.set(bustHash, {
            bytes: bustBytes,
            contentType: 'text/plain; charset=utf-8',
          });
        }

        const assetCount = Object.keys(assetManifest).length;

        projectDomains ??= await getDomainsByProjectId(context.get('db'), projectId);

        if (isStaticOnly) {
          // Static-only branch: bytes already in R2; build the serving
          // manifest with `!{hash}` for every entry (direct-to-R2 always
          // lands in R2). No KV/R2 writes for asset bodies — only the
          // serving manifest under `manifest:{deploymentId}` and the
          // routing entry under `project.slug`.
          currentStep = 'asset_upload';
          const assetConfig = manifest.assetConfig ?? {
            not_found_handling: 'single-page-application',
          };

          // We didn't upload anything new this request — every asset was
          // pre-uploaded direct-to-R2 by the CLI. `new` and `cached`
          // here represent "verified existing in R2" and convey the
          // same information shape as the multipart path's
          // `streamedStaticAssets` branch.
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: 0,
            cached: assetCount,
          });
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
          emit({ event: 'asset_upload_done' });

          const servingManifest = Object.fromEntries(
            Object.entries(assetManifest).map(([path, entry]) => [path, `!${entry.hash}`]),
          );

          await context.env.ROUTING.put(
            `manifest:${deployment.id}`,
            JSON.stringify(servingManifest),
          );

          await context
            .get('db')
            .update(deployments)
            .set({
              asset_hashes: JSON.stringify(
                attachServingStoreMetadata(assetManifest, servingManifest, true),
              ),
            })
            .where(eq(deployments.id, deployment.id));

          const type =
            manifest.type ??
            (assetConfig.not_found_handling === 'single-page-application' ? 'spa' : 'static');

          currentStep = 'cutover_intent';
          const cutoverMarker: CutoverMarker = {
            projectId,
            ownerId: cutoverOwnerId,
            buildId: deployBuild ?? null,
          };
          await context.env.ROUTING.put(
            cutoverIntentKey(deployment.id),
            JSON.stringify(cutoverMarker),
          );
          if (!cutoverProtected) {
            const claimed = await beginDeploymentCutover(context.get('db'), deployment.id);
            if (!claimed) {
              throw new Error('deployment canceled');
            }
            cutoverProtected = true;
            currentStatus = 'cutover';
          }
          const dispatchWorkerName = context.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
          const projectResources = await getProjectResources(context.get('db'), projectId);
          await withProjectCutoverFence(deployment.id, async () => {
            for (const previousQueue of previousManifest?.queues ?? []) {
              const resource = projectResources.find(
                (entry) => entry.type === 'queue' && entry.binding_name === previousQueue.name,
              );
              if (resource) {
                await snapshotTrackedQueueConsumer(resource.cf_id, dispatchWorkerName);
                await removeQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                );
              }
              await deleteTrackedRouting(
                `queue:${getProjectQueueName(projectId, previousQueue.name)}`,
              );
            }
          });
          await snapshotCronState();
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
          markPhase('routing_switch');
          await withProjectCutoverFence(deployment.id, async (txDb, currentOwner) => {
            const existingRouting = await context.env.ROUTING.get(project.slug);
            const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
            const zeroTrust = await resolveProjectZeroTrustRouting(txDb, projectId);
            const routingJson = buildStaticRoutingJson({
              projectId,
              userId: project.user_id,
              deploymentId: deployment.id,
              assetConfig,
              manifest,
              suspended:
                existingEntry?.suspended ??
                (currentOwner.suspended_reason === REASON_REQUESTS_EXCEEDED
                  ? REASON_REQUESTS_EXCEEDED
                  : undefined),
              zeroTrust,
            });
            const cutoverDomains = await getDomainsByProjectId(txDb, projectId);
            await putTrackedRouting(project.slug, routingJson);
            routingSwitched = true;
            logger = logger.with({ routingSwitched: true });
            logger.info('routing_switch', 'slug_routed', { slug: project.slug });

            for (const domain of cutoverDomains) {
              if (domain.status === 'active') {
                const domainKey = `domain:${domain.hostname}`;
                await putTrackedRouting(domainKey, routingJson);
              }
            }

            currentStep = 'cron_setup';
            markPhase('cron_sync');
            cronSchedulerWriteAttempted = true;
            await clearCronScheduler(context.env, projectId);
          });

          currentStep = 'db_finalize';
          markPhase('db_finalize');
          await context.env.ROUTING.put(
            cutoverReadyKey(deployment.id),
            JSON.stringify(cutoverMarker),
          );
          logger.info('status_transition', 'status_change', {
            from: currentStatus,
            to: 'live',
            reason: 'static_deploy',
          });
          await context.get('db').transaction(async (tx) => {
            await tx.execute(
              drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
            );
            const txDb = tx as unknown as Db;
            const lockedProject = await getProject(txDb, projectId);
            if (!lockedProject || lockedProject.status === 'deleting') {
              throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
            }
            await requireActiveDeployAccess(txDb, projectId, actor.id);
            const [intent, ready] = await Promise.all([
              context.env.ROUTING.get(cutoverIntentKey(deployment.id)).then(parseCutoverMarker),
              context.env.ROUTING.get(cutoverReadyKey(deployment.id)).then(parseCutoverMarker),
            ]);
            if (
              intent?.ownerId !== cutoverOwnerId ||
              ready?.ownerId !== cutoverOwnerId ||
              intent.projectId !== projectId ||
              ready.projectId !== projectId
            ) {
              throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
            }
            await assertDeploymentNotCanceled(txDb, deployment.id);
            // Re-check the bound build under a row lock before going live. The
            // up-front guard can pass and then a newer GitHub Actions run
            // supersede (cancel) this build while we spent minutes building and
            // uploading; without this re-check a superseded runner would still
            // go live with stale code. See `assertBoundBuildStillActive`.
            await assertBoundBuildStillActive(txDb, deployBuild, projectId);

            // Asset GC takes this same project lock and protects hashes from
            // every nonterminal deployment. Once placement-bearing
            // asset_hashes is persisted, no final object-store scan is needed.
            await updateDeploymentStatus(txDb, deployment.id, 'live', undefined, {
              force: true,
            });
            await updateProjectType(txDb, projectId, type);
            await setActiveDeployment(txDb, projectId, deployment.id);
            await markDeploymentRetained(txDb, deployment.id, true);
          });
          cutoverCommitted = true;
          currentStatus = 'live';
          await Promise.all([
            context.env.ROUTING.delete(cutoverIntentKey(deployment.id)),
            context.env.ROUTING.delete(cutoverReadyKey(deployment.id)),
          ]).catch(() => {
            // Stale markers are harmless once PostgreSQL is live.
          });

          const retained = await getRetainedDeploymentsExcluding(
            context.get('db'),
            projectId,
            deployment.id,
          );

          markPhase('retention_cleanup');
          if (STATIC_RETENTION_LIMIT > 0) {
            const toEvict = retained.slice(STATIC_RETENTION_LIMIT - 1);
            // Build the post-eviction retained-hashes union once. Always
            // built (independent of `toEvict.length`) because the R2
            // keyspace sweep below uses it to opportunistically GC
            // direct-to-R2 orphans (bytes uploaded via presigned PUTs that
            // never finalized into a live deploy).
            const retainedHashes = new Set<string>();
            for (const [, entry] of Object.entries(assetManifest)) {
              retainedHashes.add(entry.hash);
            }
            const keptDeployments = retained.slice(0, STATIC_RETENTION_LIMIT - 1);
            for (const kept of keptDeployments) {
              if (kept.asset_hashes) {
                try {
                  const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  for (const entry of Object.values(keptManifest)) {
                    retainedHashes.add(entry.hash);
                  }
                } catch (e) {
                  logger.warn('retention_cleanup', 'retained_asset_hashes_parse_failed', {
                    retainedDeploymentId: kept.id,
                    err: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }

            const { evictable, activeToKeep } = await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const txDb = tx as unknown as Db;
              const lockedProject = await getProject(txDb, projectId);
              const evictable: typeof toEvict = [];
              let activeToKeep: (typeof toEvict)[number] | undefined;
              for (const old of toEvict) {
                if (lockedProject?.active_deployment_id === old.id) {
                  activeToKeep = old;
                  continue;
                }
                await markDeploymentRetained(txDb, old.id, false);
                evictable.push(old);
              }
              return { evictable, activeToKeep };
            });

            // A rollback can make a row selected for eviction active before
            // this lock is acquired. Preserve its hashes before deleting any
            // other deployment's assets or running the orphan sweep. Missing
            // legacy metadata fails closed by disabling asset GC for this
            // pass; retaining extra bytes is safer than deleting live bytes.
            let assetCleanupSafe = true;
            if (activeToKeep) {
              if (!activeToKeep.asset_hashes) {
                assetCleanupSafe = false;
              } else {
                try {
                  const activeManifest = JSON.parse(activeToKeep.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  for (const entry of Object.values(activeManifest)) {
                    retainedHashes.add(entry.hash);
                  }
                } catch (e) {
                  assetCleanupSafe = false;
                  logger.warn('retention_cleanup', 'active_asset_hashes_parse_failed', {
                    retainedDeploymentId: activeToKeep.id,
                    err: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }

            for (const old of evictable) {
              await deleteDispatchScript(
                context.env.CF_ACCOUNT_ID,
                context.env.CF_API_TOKEN,
                dispatchNamespace,
                `user-${project.slug}-${old.id}`,
              );
              if (assetCleanupSafe && old.asset_hashes) {
                const evictedManifest = JSON.parse(old.asset_hashes) as Record<
                  string,
                  { hash: string }
                >;
                const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
                await deleteAssetHashesWithProjectFence(retainedHashes, evictedHashes);
              }
              await context.env.ROUTING.delete(`manifest:${old.id}`);
              if (old.bundle_stored) {
                try {
                  await evictStoredWorkerBundle(old.id);
                } catch (e) {
                  logger.error('retention_cleanup', 'evicted_worker_bundle_delete_failed', e, {
                    evictedDeploymentId: old.id,
                  });
                }
              }
            }

            // Presigned uploads without a finalized manifest become orphans.
            // Sweep after the terminal event so R2 history does not delay a
            // successful deploy. The project fence still protects live hashes.
            if (assetCleanupSafe) {
              orphanSweepAfterResponse = async () => {
                try {
                  const orphans = await sweepAssetOrphansWithProjectFence(retainedHashes);
                  if (orphans > 0) {
                    logger.info('retention_cleanup', 'r2_orphans_swept', { count: orphans });
                  }
                } catch (e) {
                  logger.warn('retention_cleanup', 'r2_orphan_sweep_failed', {
                    err: e instanceof Error ? e.message : String(e),
                  });
                }
              };
            }
          }

          const application = readPlatformApplication(context.env);
          const activeDomains = projectDomains.filter((d) => d.status === 'active');
          const url =
            activeDomains.length > 0
              ? `https://${activeDomains[0].hostname}`
              : `https://${platformProjectHostname(project, application)}`;

          emit({
            event: 'done',
            deployment: deployment.id,
            url,
            urls: [
              ...activeDomains.map((d) => `https://${d.hostname}`),
              `https://${platformProjectHostname(project, application)}`,
            ],
            assets: assetCount,
            workers: 0,
          });
          await finishOrphanSweep();
          return;
        }

        // === WfP branch ===
        // Direct-to-R2 doesn't change anything about CF's asset upload
        // session: CF still wants the actual bytes to fan into upload
        // buckets. We fetch the bytes back from OUR R2 (where the CLI
        // just uploaded them) — server-internal R2-to-CF traffic that
        // doesn't go through the user's pipe. The fetch concurrency
        // matches the existing R2 head verify pool.
        currentStep = 'provisioning';
        markPhase('provisioning');

        const bindingLabels: Array<string> = [];
        for (const name of manifest.bindings.d1 ?? []) {
          bindingLabels.push(`d1:${name}`);
        }
        for (const name of manifest.bindings.kv ?? []) {
          bindingLabels.push(`kv:${name}`);
        }
        for (const name of manifest.bindings.r2 ?? []) {
          bindingLabels.push(`r2:${name}`);
        }
        for (const queue of manifest.queues ?? []) {
          bindingLabels.push(`queue:${queue.name}`);
        }
        if (bindingLabels.length > 0) {
          emit({ event: 'provisioning', bindings: bindingLabels });
        }

        const workerBindings = await provisionBindings(
          context.get('db'),
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          projectId,
          manifest,
          context.env.JWT_SECRET,
          context.env.VOID_PROXY_SERVICE ?? 'void-proxy',
          {
            projectSlug: project.slug,
            emailSenderDomain: context.env.EMAIL_SENDER_DOMAIN,
            deploymentId: deployment.id,
          },
        );
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        if (bindingLabels.length > 0) {
          emit({ event: 'provisioning_done' });
        }

        if (typeof manifest.vars?.[BETTER_AUTH_SECRET_NAME] === 'string') {
          throw new Error(
            `${BETTER_AUTH_SECRET_NAME} must be configured via project secrets, not manifest.vars`,
          );
        }

        let projectSecretRows = await getProjectSecrets(context.get('db'), projectId);
        if (manifest.auth) {
          const existingAuthSecret = projectSecretRows.find(
            (row) => row.name === BETTER_AUTH_SECRET_NAME,
          );
          if (!existingAuthSecret) {
            const managedSecret = generateManagedAuthSecret();
            const encrypted = await encryptProjectSecret(
              context.env,
              projectId,
              BETTER_AUTH_SECRET_NAME,
              managedSecret,
            );
            await upsertProjectSecret(
              context.get('db'),
              projectId,
              BETTER_AUTH_SECRET_NAME,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.keyVersion,
              'auth-default',
            );
            projectSecretRows = await getProjectSecrets(context.get('db'), projectId);
          }
        }
        const secretBindings = await Promise.all(
          projectSecretRows.map(async (row) => ({
            type: 'secret_text' as const,
            name: row.name,
            text: await decryptProjectSecret(context.env, projectId, row),
          })),
        );

        let completionJwt: string | undefined;
        if (assetCount > 0) {
          currentStep = 'asset_upload';
          markPhase('asset_upload');
          const session = await createAssetUploadSession(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            dispatchNamespace,
            workerName,
            // Strip extras (e.g. v2 `blake3`/`md5`) at the CF API boundary —
            // CF documents only `{ hash, size }` and may strictly validate.
            normalizeForCfAssetSession(assetManifest),
          );
          logger.info('asset_upload', 'session_created', {
            manifestEntries: Object.keys(assetManifest).length,
            buckets: session.buckets.length,
            blobsAvailable: assetsByHash.size,
          });

          // Every declared asset was verified in scoped R2 before provisioning.
          // Hydrate only the bytes Cloudflare actually requests; the cachebuster
          // already has its deploy-local bytes in assetsByHash.
          const hashesNeedingBytes = Array.from(new Set(session.buckets.flat())).filter(
            (hash) => !assetsByHash.has(hash),
          );
          const contentTypes = resolveAssetContentTypes(incomingAssetManifest, hashesNeedingBytes);
          await uploadPool(hashesNeedingBytes, R2_HEAD_VERIFY_CONCURRENCY, async (hash) => {
            const object = await context.env.STATIC_ASSETS_R2.get(`assets/${projectId}/${hash}`);
            if (!object) {
              throw new StaticAssetDisappearedError([hash]);
            }
            assetsByHash.set(hash, {
              bytes: new Uint8Array(await object.arrayBuffer()),
              contentType: contentTypes.get(hash)!,
            });
          });
          // `new` reflects "newly uploaded by the CLI this deploy" —
          // for direct-to-R2 we don't re-upload, so we report 0 new
          // (every byte was pre-uploaded). The CF asset upload session
          // still dedupes against its own server-side index, which is
          // what the WfP path's `cached` semantic refers to.
          const newAssets = 0;
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: newAssets,
            cached: assetCount - newAssets,
          });

          completionJwt = await uploadAssetBuckets(
            context.env.CF_ACCOUNT_ID,
            session.jwt,
            session.buckets,
            assetsByHash,
          );
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
          logger.info('asset_upload', 'upload_complete', {
            hasCompletionJwt: completionJwt !== undefined,
          });
          emit({ event: 'asset_upload_done' });

          // Mirror serving manifest. Direct-to-R2 already lands assets
          // in our R2; we just need to write the per-deploy serving
          // manifest so dispatch's WfP fallback can read them when CF's
          // asset store returns the dedupe-poisoning stub.
          const servingManifest = Object.fromEntries(
            Object.entries(assetManifest)
              .filter(([path]) => !path.startsWith('/.void-deploy/'))
              .map(([path, entry]) => [path, `!${entry.hash}`]),
          );
          const persistedAssetManifest = attachServingStoreMetadata(
            assetManifest,
            servingManifest,
            true,
          );
          // Persist exact placement before the serving manifest/ready marker.
          // GC protects every nonterminal row with asset_hashes, and recovery
          // can reconstruct a lagging KV manifest without probing 5,000 keys.
          await context
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(persistedAssetManifest) })
            .where(eq(deployments.id, deployment.id));
          await context.env.ROUTING.put(
            `manifest:${deployment.id}`,
            JSON.stringify(servingManifest),
          );
          wfpMirroredManifestDeploymentId = deployment.id;
        }

        // 1. Worker upload
        currentStep = 'worker_upload';
        markPhase('worker_upload');
        const workerFormData = new FormData();
        emit({ event: 'worker_upload', modules: workerFiles.length });

        // Reserved-name set lives in `../reserved-bindings.ts` so the secrets
        // route can reject before persisting; see the invariant test there.
        const userVarNames = Object.keys(manifest.vars ?? {});
        const userSecretNames = secretBindings.map((s) => s.name);
        // Check BOTH vars and project secrets. A secret is uploaded in the
        // same `metadata.bindings` array, so a secret named e.g. `SEND_EMAIL`
        // or `__VOID_PROJECT_SLUG` either shadows a platform binding or is
        // shadowed by one — CF resolves duplicates last-wins with no error.
        // The secrets route now rejects these at PUT time, but rows stored
        // before that guard existed still reach here. Failing the deploy with
        // a named binding beats shipping a worker that silently reads the
        // wrong value.
        const reserved = [
          ...userVarNames.filter((n) => RESERVED_BINDING_NAMES.has(n)).map((n) => `vars.${n}`),
          ...userSecretNames.filter((n) => RESERVED_BINDING_NAMES.has(n)).map((n) => `secret.${n}`),
        ];
        if (reserved.length > 0) {
          throw new Error(`reserved binding names: ${reserved.join(', ')}`);
        }
        const secretNames = new Set(userSecretNames);
        const collisions = userVarNames.filter((n) => secretNames.has(n));
        if (collisions.length > 0) {
          logger.warn('worker_upload', 'var_secret_collisions', { collisions });
        }
        const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
          type: 'plain_text' as const,
          name,
          text,
        }));
        const websocketBindings = buildWebSocketUploadBindings(manifest.websocket);
        if (manifest.sandbox) {
          currentStep = 'sandbox_container';
          markPhase('sandbox_container');
          sandboxControllerAttempted = true;
          await provisionSandboxController({
            accountId: context.env.CF_ACCOUNT_ID,
            apiToken: context.env.CF_API_TOKEN,
            apiService: context.env.SANDBOX_CONTROL_SERVICE ?? 'void-api',
            identity: {
              projectId,
              deploymentId: deployment.id,
              userId: owner.id,
              slug: project.slug,
            },
            sandbox: manifest.sandbox,
          });
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
        }
        const sandboxBindings = buildSandboxUploadBindings(
          manifest.sandbox,
          sandboxControllerWorkerName(projectId, deployment.id),
        );
        const liveBindings = buildLiveUploadBindings(manifest.live);
        // No per-project `send_email` binding is uploaded. The framework's
        // `sendEmail()` POSTs MIME + recipients to `__VOID_PROXY/email/send`;
        // the proxy holds the account-level send_email binding and enforces
        // the per-project verified-destination policy through SQL admission. See
        // `meta/design-docs/0078-email-cf-native.md` and `packages/proxy/src/email.ts`.
        const allBindings = [
          ...plainTextBindings,
          ...secretBindings,
          ...workerBindings,
          ...websocketBindings,
          ...sandboxBindings,
          ...liveBindings,
          ...(completionJwt ? [{ name: 'ASSETS', type: 'assets' }] : []),
        ];

        if (!manifest.compatibilityDate) {
          logger.warn('worker_upload', 'missing_compatibility_date');
        }
        const assetConfig = manifest.assetConfig ?? { not_found_handling: 'none' };
        const durableObjectMigrations = buildDurableObjectUploadMigrations(
          manifest.websocket?.migrations,
          manifest.live?.migrations,
        );
        const tailServiceName = context.env.TAIL_SERVICE_NAME ?? DEFAULT_TAIL_SERVICE_NAME;
        const metadata: Record<string, unknown> = {
          main_module: manifest.workerMain ?? 'index.js',
          compatibility_date: manifest.compatibilityDate ?? '2026-02-12',
          compatibility_flags: manifest.compatibilityFlags ?? ['nodejs_compat'],
          bindings: allBindings,
          ...(durableObjectMigrations ? { migrations: durableObjectMigrations } : {}),
          ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
          observability: {
            enabled: true,
            logs: { invocation_logs: true, head_sampling_rate: 1 },
          },
          tail_consumers: [{ service: tailServiceName }],
        };
        workerFormData.append(
          'metadata',
          new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
        );
        for (const file of workerFiles) {
          workerFormData.append(file.name, file.content, file.name);
        }

        workerUploadUrl = `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`;
        await retryWithBackoff(
          async (attempt) => {
            const attemptStart = Date.now();
            const cfResponse = await fetch(workerUploadUrl!, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` },
              body: workerFormData,
            });

            if (!cfResponse.ok) {
              const error = await cfResponse.text();
              logger.error('worker_upload', 'attempt_failed', new Error(error), {
                attempt,
                maxAttempts: CF_RETRY.maxRetries + 1,
                latencyMs: Date.now() - attemptStart,
                status: cfResponse.status,
                bodyPreview: error.slice(0, 500),
              });
              throw new Error(`worker upload failed: ${error}`);
            }

            const cfBody = await cfResponse.text();
            if (isCfAssetPlainText(cfBody)) {
              logger.warn('worker_upload', 'attempt_failed', {
                attempt,
                maxAttempts: CF_RETRY.maxRetries + 1,
                latencyMs: Date.now() - attemptStart,
                code: 'cf_plain_text',
                bodyPreview: cfBody.slice(0, 100),
              });
              return undefined;
            }
            return true;
          },
          {
            ...CF_RETRY,
            errorMessage: 'worker upload returned an unexpected Cloudflare response',
          },
        );
        workerUploaded = true;

        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        emit({ event: 'worker_upload_done' });

        // Migrations
        let migrationsApplied = 0;
        if (manifest.migrations && manifest.migrations.pending > 0) {
          currentStep = 'migration';
          markPhase('migrate');
          logger.info('status_transition', 'status_change', {
            from: currentStatus,
            to: 'migrating',
          });
          if (!cutoverProtected) {
            await updateDeploymentStatus(context.get('db'), deployment.id, 'migrating');
            currentStatus = 'migrating';
          }
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
          emit({ event: 'worker_readiness' });

          const proxyTokenBinding = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN');
          const readinessError =
            'worker readiness probe failed: new worker not reachable after retries';
          let readinessFailure = 'no readiness attempts completed';
          try {
            await retryWithBackoff<true>(
              async (attempt) => {
                const attemptStart = Date.now();
                const maxAttempts = CF_READINESS_RETRY.maxRetries + 1;
                try {
                  const userWorker = context.env.DISPATCH.get(workerName);
                  const readyResponse = await userWorker.fetch(
                    new Request('https://internal/__void/ready', {
                      signal: AbortSignal.timeout(10_000),
                    }),
                  );
                  const text = await readyResponse.text();
                  if (isCfAssetPlainText(text)) {
                    readinessFailure =
                      'last readiness response was a Cloudflare asset propagation stub';
                    logger.warn('migrate', 'readiness_probe_attempt_failed', {
                      attempt,
                      maxAttempts,
                      latencyMs: Date.now() - attemptStart,
                      code: 'cf_plain_text',
                      bodyPreview: text.slice(0, 200),
                    });
                    return undefined;
                  }
                  try {
                    const data = JSON.parse(text);
                    if (data.ready === true) {
                      return true;
                    }
                  } catch {
                    // fall through
                  }
                  readinessFailure = `last readiness response was HTTP ${readyResponse.status}: ${text.slice(0, 200)}`;
                  logger.warn('migrate', 'readiness_probe_attempt_failed', {
                    attempt,
                    maxAttempts,
                    latencyMs: Date.now() - attemptStart,
                    status: readyResponse.status,
                    bodyPreview: text.slice(0, 200),
                  });
                  return undefined;
                } catch (err) {
                  readinessFailure = `last readiness request threw: ${err instanceof Error ? err.message : String(err)}`;
                  logger.warn('migrate', 'readiness_probe_attempt_failed', {
                    attempt,
                    maxAttempts,
                    latencyMs: Date.now() - attemptStart,
                    code: 'threw',
                    err: err instanceof Error ? err.message : String(err),
                  });
                  return undefined;
                }
              },
              {
                ...CF_READINESS_RETRY,
                errorMessage: readinessError,
              },
            );
          } catch {
            throw new Error(`${readinessError} (${readinessFailure})`);
          }

          const manifestProtocol = manifest.migrations.protocolVersion;
          const probe =
            manifestProtocol === 2
              ? await probeWorkerMigrationCapabilities(
                  context.env.DISPATCH.get(workerName),
                  proxyTokenBinding?.text ?? '',
                  logger,
                )
              : null;
          const stableCapabilities = probe && probe.ok ? probe.caps : null;
          const canUseStable =
            stableCapabilities &&
            stableCapabilities.protocolVersion === 2 &&
            stableCapabilities.dialect === manifest.migrations.dialect &&
            stableCapabilities.classifierVersion === manifest.migrations.classifierVersion &&
            stableCapabilities.migrationListHash === manifest.migrations.migrationListHash &&
            stableCapabilities.destructiveValidation === 'passed';

          if (manifestProtocol === 2 && !canUseStable) {
            const reason = !probe
              ? 'no capability probe performed'
              : !probe.ok
                ? probe.reason
                : (() => {
                    const c = probe.caps;
                    const m = manifest.migrations;
                    const diffs: Array<string> = [];
                    if (c.protocolVersion !== 2) {
                      diffs.push(`protocolVersion worker=${c.protocolVersion} manifest=2`);
                    }
                    if (c.dialect !== m.dialect) {
                      diffs.push(`dialect worker=${c.dialect} manifest=${m.dialect}`);
                    }
                    if (c.classifierVersion !== m.classifierVersion) {
                      diffs.push(
                        `classifierVersion worker=${c.classifierVersion} manifest=${m.classifierVersion}`,
                      );
                    }
                    if (c.migrationListHash !== m.migrationListHash) {
                      diffs.push(
                        `migrationListHash worker=${c.migrationListHash} manifest=${m.migrationListHash}`,
                      );
                    }
                    if (c.destructiveValidation !== 'passed') {
                      diffs.push(`destructiveValidation=${c.destructiveValidation}`);
                    }
                    return `deployed worker build differs from manifest (${diffs.join('; ')})`;
                  })();
            logger.warn('migrate', 'capability_negotiation_failed', { reason });
            throw new Error(`migration protocol v2 capability negotiation failed: ${reason}`);
          }

          emit({ event: 'migration_start', pending: manifest.migrations.pending });

          if (canUseStable) {
            const attemptId = generateId('migatt');
            const stableOutcome = await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const txDb = tx as unknown as Db;
              await requireActiveDeployAccess(txDb, projectId, actor.id);
              const appResult = await dispatchStableAppMigration(
                context.env.DISPATCH.get(workerName),
                proxyTokenBinding?.text ?? '',
                attemptId,
                deployment.id,
                logger,
              );
              const confirmed = [
                ...(appResult.confirmedApplied ?? []),
                ...(appResult.confirmedSkipped ?? []),
              ];
              if (confirmed.length > 0) {
                await appendProjectMigrations(txDb, projectId, confirmed, deployment.id);
                await setAppliedMigrations(txDb, deployment.id, confirmed);
              }
              return { confirmed, result: appResult };
            });

            for (const warning of stableOutcome.result.warnings ?? []) {
              logger.warn('migrate', 'warning', { message: warning });
              emit({ event: 'migration_warning', message: warning });
            }
            if (!stableOutcome.result.ok) {
              throw new Error(`migration failed: ${formatMigrationFailure(stableOutcome.result)}`);
            }
            for (const m of stableOutcome.result.migrations) {
              if (m.status === 'applied' || m.applied) {
                emit({
                  event: 'migration',
                  name: m.name,
                  durationMs: m.durationMs,
                  stability: m.stability,
                });
                migrationsApplied++;
              }
            }
            if (stableCapabilities.endpoints.auth) {
              // Persist the remotely committed app result before auth runs, and
              // release the project lock before this request's 300-second timeout.
              await context.get('db').transaction(async (tx) => {
                await tx.execute(
                  drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
                );
                await requireActiveDeployAccess(tx as unknown as Db, projectId, actor.id);
              });
              await dispatchStableAuthMigration(
                context.env.DISPATCH.get(workerName),
                proxyTokenBinding?.text ?? '',
              );
            }
          } else {
            const result = await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const txDb = tx as unknown as Db;
              await requireActiveDeployAccess(txDb, projectId, actor.id);
              const externalResult = await retryWithBackoff<UserWorkerMigrationResult>(
                async (attempt) => {
                  const attemptStart = Date.now();
                  const maxAttempts = CF_MIGRATION_RETRY.maxRetries + 1;
                  const userWorker = context.env.DISPATCH.get(workerName);
                  const migrateResponse = await userWorker.fetch(
                    new Request('https://internal/__void/migrate', {
                      method: 'POST',
                      headers: { 'x-void-internal': proxyTokenBinding?.text ?? '' },
                      signal: AbortSignal.timeout(300_000),
                    }),
                  );

                  const text = await migrateResponse.text();
                  if (isCfAssetPlainText(text)) {
                    logger.warn('migrate', 'attempt_failed', {
                      attempt,
                      bodyPreview: text.slice(0, 200),
                      code: 'cf_plain_text',
                      latencyMs: Date.now() - attemptStart,
                      maxAttempts,
                    });
                    return undefined;
                  }

                  try {
                    return normalizeUserWorkerMigrationResult(JSON.parse(text), text.slice(0, 500));
                  } catch {
                    if (migrateResponse.ok) {
                      logger.warn('migrate', 'attempt_failed', {
                        attempt,
                        bodyPreview: text.slice(0, 500),
                        code: 'non_json_2xx',
                        latencyMs: Date.now() - attemptStart,
                        maxAttempts,
                        status: migrateResponse.status,
                      });
                      return undefined;
                    }
                    throw new Error(
                      `migration failed (${migrateResponse.status}): ${text.slice(0, 200)}`,
                    );
                  }
                },
                {
                  ...CF_MIGRATION_RETRY,
                  errorMessage: 'migration dispatch failed after retries',
                },
              );
              const allApplied = externalResult.migrations
                .filter((migration) => !migration.error)
                .map((migration) => migration.name);
              if (allApplied.length > 0) {
                await appendProjectMigrations(txDb, projectId, allApplied, deployment.id);
                await setAppliedMigrations(txDb, deployment.id, allApplied);
              }
              return externalResult;
            });

            if (!result.ok) {
              throw new Error(`migration failed: ${formatMigrationFailure(result)}`);
            }
            for (const m of result.migrations) {
              if (m.applied) {
                emit({ event: 'migration', name: m.name, durationMs: m.durationMs });
                migrationsApplied++;
              }
            }
          }
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
        }

        // Queue setup is the first authoritative external mutation for a
        // Worker deploy. Persist a protected intent before it so no reaper can
        // terminalize a request whose queue/routing cutover may have landed.
        currentStep = 'cutover_intent';
        const cutoverMarker: CutoverMarker = {
          projectId,
          ownerId: cutoverOwnerId,
          buildId: deployBuild ?? null,
        };
        await context.env.ROUTING.put(
          cutoverIntentKey(deployment.id),
          JSON.stringify(cutoverMarker),
        );
        if (!cutoverProtected) {
          const claimed = await beginDeploymentCutover(context.get('db'), deployment.id);
          if (!claimed) {
            throw new Error('deployment canceled');
          }
          cutoverProtected = true;
          currentStatus = 'cutover';
        }

        // Queue setup
        currentStep = 'queue_setup';
        markPhase('queue_setup');
        const queueNames = (manifest.queues ?? []).map((q) => q.name);
        if (queueNames.length > 0) {
          emit({ event: 'queue_setup', queues: queueNames });
        }
        const dispatchWorkerName = context.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
        const queueProxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;
        const queueConflicts: Array<{ queue: string; ownerScript: string }> = [];
        const projectResources = await getProjectResources(context.get('db'), projectId);
        await withProjectCutoverFence(deployment.id, async () => {
          for (const q of manifest.queues ?? []) {
            const queueBinding = workerBindings.find(
              (binding) => binding.type === 'queue' && binding.name === q.bindingName,
            );
            if (queueBinding?.queue_id) {
              await snapshotTrackedQueueConsumer(queueBinding.queue_id, dispatchWorkerName);
            }
          }
          const settledConsumerOutcomes = await Promise.allSettled(
            (manifest.queues ?? []).map(async (q) => {
              const queueBinding = workerBindings.find(
                (b) => b.type === 'queue' && b.name === q.bindingName,
              );
              if (!queueBinding?.queue_id) {
                return null;
              }
              const consumerResult = await addQueueConsumer(
                context.env.CF_ACCOUNT_ID,
                context.env.CF_API_TOKEN,
                queueBinding.queue_id,
                dispatchWorkerName,
                {
                  ...(q.maxBatchSize != null && { batch_size: q.maxBatchSize }),
                  ...(q.maxBatchTimeout != null && {
                    max_wait_time_ms: q.maxBatchTimeout * 1000,
                  }),
                  ...(q.maxRetries != null && { max_retries: q.maxRetries }),
                  ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
                },
              );
              if (consumerResult.status === 'conflict') {
                emit({
                  event: 'queue_consumer_conflict',
                  queue: q.name,
                  ownerScript: consumerResult.ownerScript,
                });
                queueConflicts.push({ queue: q.name, ownerScript: consumerResult.ownerScript });
              }
              return { q, queueBinding, status: consumerResult.status };
            }),
          );
          const consumerErrors = settledConsumerOutcomes
            .filter((outcome) => outcome.status === 'rejected')
            .map((outcome) => outcome.reason);
          if (consumerErrors.length > 0) {
            throw new AggregateError(consumerErrors, 'one or more queue consumers failed to sync');
          }
          const consumerOutcomes = settledConsumerOutcomes
            .filter((outcome) => outcome.status === 'fulfilled')
            .map((outcome) => outcome.value);
          if (queueConflicts.length > 0) {
            const details = queueConflicts
              .map((conflict) => `${conflict.queue} owned by ${conflict.ownerScript}`)
              .join('; ');
            throw new Error(`queue consumer conflict: ${details}`);
          }
          for (const outcome of consumerOutcomes) {
            if (!outcome) {
              continue;
            }
            const queueKey = `queue:${outcome.queueBinding.queue_name}`;
            await putTrackedRouting(
              queueKey,
              JSON.stringify({
                workerName,
                projectId,
                queueName: outcome.q.name,
                proxyToken: queueProxyToken,
              }),
            );
          }
          const desiredQueueNames = new Set((manifest.queues ?? []).map((queue) => queue.name));
          for (const previousQueue of previousManifest?.queues ?? []) {
            if (!desiredQueueNames.has(previousQueue.name)) {
              const resource = projectResources.find(
                (entry) => entry.type === 'queue' && entry.binding_name === previousQueue.name,
              );
              if (resource) {
                await snapshotTrackedQueueConsumer(resource.cf_id, dispatchWorkerName);
                await removeQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                );
              }
              await deleteTrackedRouting(
                `queue:${getProjectQueueName(projectId, previousQueue.name)}`,
              );
            }
          }
        });
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        const hasCrons = manifest.schedules && manifest.schedules.length > 0;

        await clearIsrCache(context.env.ISR_CACHE, projectId, deployment.id);
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        currentStep = 'prerender';
        if (
          manifest.prerender &&
          manifest.prerender.length > 0 &&
          (manifest.revalidate || (manifest.pages && manifest.pages.length > 0))
        ) {
          markPhase('prerender');
          emit({ event: 'prerender', pages: manifest.prerender.length });
          logger.info('status_transition', 'status_change', {
            from: currentStatus,
            to: 'prerendering',
          });
          if (!cutoverProtected) {
            await updateDeploymentStatus(context.get('db'), deployment.id, 'prerendering');
            currentStatus = 'prerendering';
          }
          await assertDeploymentNotCanceled(context.get('db'), deployment.id);
          await assertProjectNotDeleting(context.get('db'), projectId);
          const application = readPlatformApplication(context.env);

          await uploadPool(manifest.prerender, 3, async (pathname) => {
            const ttl = resolvePageTtl(
              manifest.pages,
              manifest.revalidate,
              manifest.pathRevalidate,
              pathname,
            );
            if (ttl <= 0) {
              return;
            }
            try {
              const userWorker = context.env.DISPATCH.get(workerName);
              const slugHost = platformProjectHostname(project, application);
              const url = `https://${slugHost}${pathname}`;
              const response = await userWorker.fetch(new Request(url));
              // Mirror dispatch's live-miss / background write gate so prewarm
              // cannot seed an entry the edge would refuse. A render that opts
              // out — `x-revalidate: 0` (→ effectiveTtl 0) or `Cache-Control:
              // private/no-store/no-cache` — must NOT be warmed: dispatch serves
              // a HIT without re-checking opt-out, and `serializePrerenderHeaders`
              // strips `Cache-Control`, so the opt-out is only visible HERE,
              // before the write. `x-revalidate` overrides the TTL exactly as
              // dispatch's `resolveRevalidateTtl` does; a full 200 is required
              // (parity with the dispatch write sites — no partial/redirect body).
              const effectiveTtl = resolveRevalidateTtl(response, ttl);
              if (
                response.status === 200 &&
                effectiveTtl > 0 &&
                !hasSharedCacheOptOut(response) &&
                (manifest.type !== 'framework' ||
                  response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim() ===
                    'text/html')
              ) {
                // Host-scope the warmed key to the slug host implied by the
                // fetch URL — dispatch reads `<pid>/isr/v3/<did>/<host>/<path>`
                // keyed on the request hostname, so without this the warmed
                // bytes are a permanent cold miss (see @void/isr `isrCacheKey`).
                const key = isrCacheKey(projectId, deployment.id, slugHost, pathname);
                const headers = serializePrerenderHeaders(response);
                const body = await response.arrayBuffer();
                const packed = packIsrValue(headers, body);
                await context.env.ISR_CACHE.put(key, packed, {
                  // `c` (createdAt) + `t` (ttl) are REQUIRED by dispatch's
                  // `readIsrCache` — it returns null (permanent cold miss)
                  // without them. `satisfies IsrCacheMetadata` makes any field
                  // drift a typecheck error (this once wrote `context`, silently
                  // making every warmed entry unreadable).
                  metadata: {
                    s: response.status,
                    c: Date.now(),
                    t: effectiveTtl,
                    p: SHARED_CACHE_POLICY_VERSION,
                  } satisfies IsrCacheMetadata,
                });
              }
            } catch {
              // non-blocking
            }
          });
          emit({ event: 'prerender_done' });
        }
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);

        // Routing switch
        await snapshotCronState();
        await assertDeploymentNotCanceled(context.get('db'), deployment.id);
        await assertProjectNotDeleting(context.get('db'), projectId);
        markPhase('routing_switch');
        await withProjectCutoverFence(deployment.id, async (txDb, currentOwner) => {
          const dispatchLimits = computeDispatchLimits(
            await resolvePlanLimits(txDb, currentOwner.plan),
            manifest.limits,
          );
          const existingRouting = await context.env.ROUTING.get(project.slug);
          const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
          const zeroTrust = await resolveProjectZeroTrustRouting(txDb, projectId);
          const routingJson = buildRoutingJson({
            workerName,
            projectId,
            userId: project.user_id,
            manifest,
            deploymentId: deployment.id,
            dispatchLimits,
            suspended:
              existingEntry?.suspended ??
              (currentOwner.suspended_reason === REASON_REQUESTS_EXCEEDED
                ? REASON_REQUESTS_EXCEEDED
                : undefined),
            hasCrons,
            assetManifestId: assetCount > 0 ? deployment.id : undefined,
            assetConfig: assetCount > 0 ? assetConfig : undefined,
            zeroTrust,
          });
          const cutoverDomains = await getDomainsByProjectId(txDb, projectId);
          await putTrackedRouting(project.slug, routingJson);
          routingSwitched = true;
          logger = logger.with({ routingSwitched: true });
          logger.info('routing_switch', 'slug_routed', { slug: project.slug });

          for (const domain of cutoverDomains) {
            if (domain.status === 'active') {
              const domainKey = `domain:${domain.hostname}`;
              await putTrackedRouting(domainKey, routingJson);
            }
          }

          currentStep = 'cron_setup';
          markPhase('cron_sync');
          cronSchedulerWriteAttempted = true;
          if (hasCrons) {
            const cronProxyToken = workerBindings.find(
              (binding) => binding.name === '__VOID_PROXY_TOKEN',
            )?.text;
            await syncCronScheduler(context.env, projectId, {
              workerName,
              schedules: manifest.schedules!,
              proxyToken: cronProxyToken,
            });
          } else {
            await clearCronScheduler(context.env, projectId);
          }
        });

        currentStep = 'db_finalize';
        markPhase('db_finalize');
        await context.env.ROUTING.put(
          cutoverReadyKey(deployment.id),
          JSON.stringify(cutoverMarker),
        );
        logger.info('status_transition', 'status_change', {
          from: currentStatus,
          to: 'live',
          reason: 'wfp_deploy',
        });
        await context.get('db').transaction(async (tx) => {
          await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
          const txDb = tx as unknown as Db;
          const lockedProject = await getProject(txDb, projectId);
          if (!lockedProject || lockedProject.status === 'deleting') {
            throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
          }
          await requireActiveDeployAccess(txDb, projectId, actor.id);
          const [intent, ready] = await Promise.all([
            context.env.ROUTING.get(cutoverIntentKey(deployment.id)).then(parseCutoverMarker),
            context.env.ROUTING.get(cutoverReadyKey(deployment.id)).then(parseCutoverMarker),
          ]);
          if (
            intent?.ownerId !== cutoverOwnerId ||
            ready?.ownerId !== cutoverOwnerId ||
            intent.projectId !== projectId ||
            ready.projectId !== projectId
          ) {
            throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
          }
          await assertDeploymentNotCanceled(txDb, deployment.id);
          // Re-check the bound build under a row lock before going live. The
          // up-front guard can pass and then a newer GitHub Actions run
          // supersede (cancel) this build while we spent minutes building and
          // uploading; without this re-check a superseded runner would still
          // go live with stale code. See `assertBoundBuildStillActive`.
          await assertBoundBuildStillActive(txDb, deployBuild, projectId);
          // Asset GC takes this same project lock and protects hashes from
          // every nonterminal deployment. Serving placement was persisted
          // before cutover began, so no storage scan belongs here.
          await updateDeploymentStatus(txDb, deployment.id, 'live', undefined, {
            force: true,
          });
          await updateProjectType(
            txDb,
            projectId,
            manifest.type ?? (manifest.framework ? 'framework' : 'void'),
          );
          await setActiveDeployment(txDb, projectId, deployment.id);
          await markDeploymentRetained(txDb, deployment.id, true);
        });
        cutoverCommitted = true;
        currentStatus = 'live';
        await Promise.all([
          context.env.ROUTING.delete(cutoverIntentKey(deployment.id)),
          context.env.ROUTING.delete(cutoverReadyKey(deployment.id)),
        ]).catch(() => {
          // Stale markers are harmless once PostgreSQL is live.
        });

        markPhase('retention_cleanup');
        const retentionLimit = planLimits.retainedDeployments;
        if (retentionLimit > 0) {
          const retained = await getRetainedDeploymentsExcluding(
            context.get('db'),
            projectId,
            deployment.id,
          );
          const toEvict = retained.slice(retentionLimit - 1);

          // Build the union of hashes that must remain in R2 after this deploy:
          // this deploy's manifest plus every kept retained deployment's
          // manifest. Always built (independent of `toEvict.length`) because
          // the post-eviction R2 keyspace sweep below uses it to opportunistically
          // GC direct-to-R2 orphans (bytes uploaded via presigned PUTs that
          // never finalized into a live deploy).
          const retainedHashes = new Set<string>();
          for (const [, entry] of Object.entries(assetManifest)) {
            retainedHashes.add(entry.hash);
          }
          const keptDeployments = retained.slice(0, retentionLimit - 1);
          for (const kept of keptDeployments) {
            if (kept.asset_hashes) {
              try {
                const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                  string,
                  { hash: string }
                >;
                for (const entry of Object.values(keptManifest)) {
                  retainedHashes.add(entry.hash);
                }
              } catch (e) {
                // A single corrupt asset_hashes blob must not poison the
                // sweep — skip the bad row and keep walking. The orphan sweep
                // is best-effort either way.
                logger.warn('retention_cleanup', 'retained_asset_hashes_parse_failed', {
                  retainedDeploymentId: kept.id,
                  err: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }

          const { evictable, activeToKeep } = await context.get('db').transaction(async (tx) => {
            await tx.execute(
              drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
            );
            const txDb = tx as unknown as Db;
            const lockedProject = await getProject(txDb, projectId);
            const evictable: typeof toEvict = [];
            let activeToKeep: (typeof toEvict)[number] | undefined;
            for (const old of toEvict) {
              if (lockedProject?.active_deployment_id === old.id) {
                activeToKeep = old;
                continue;
              }
              await markDeploymentRetained(txDb, old.id, false);
              evictable.push(old);
            }
            return { evictable, activeToKeep };
          });

          let assetCleanupSafe = true;
          if (activeToKeep) {
            if (!activeToKeep.asset_hashes) {
              assetCleanupSafe = false;
            } else {
              try {
                const activeManifest = JSON.parse(activeToKeep.asset_hashes) as Record<
                  string,
                  { hash: string }
                >;
                for (const entry of Object.values(activeManifest)) {
                  retainedHashes.add(entry.hash);
                }
              } catch (e) {
                assetCleanupSafe = false;
                logger.warn('retention_cleanup', 'active_asset_hashes_parse_failed', {
                  retainedDeploymentId: activeToKeep.id,
                  err: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }

          for (const old of evictable) {
            try {
              const oldWorkerName = `user-${project.slug}-${old.id}`;
              await deleteDispatchScript(
                context.env.CF_ACCOUNT_ID,
                context.env.CF_API_TOKEN,
                dispatchNamespace,
                oldWorkerName,
              ).catch((e) => {
                logger.warn('retention_cleanup', 'evicted_dispatch_script_delete_failed', {
                  evictedDeploymentId: old.id,
                  err: e instanceof Error ? e.message : String(e),
                });
              });
              if (assetCleanupSafe && old.asset_hashes) {
                try {
                  const evictedManifest = JSON.parse(old.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
                  await deleteAssetHashesWithProjectFence(retainedHashes, evictedHashes).catch(
                    (e) => {
                      logger.warn(
                        'retention_cleanup',
                        'evicted_unreferenced_assets_delete_failed',
                        {
                          evictedDeploymentId: old.id,
                          err: e instanceof Error ? e.message : String(e),
                        },
                      );
                    },
                  );
                  await context.env.ROUTING.delete(`manifest:${old.id}`).catch((e) => {
                    logger.warn('retention_cleanup', 'evicted_routing_manifest_delete_failed', {
                      evictedDeploymentId: old.id,
                      err: e instanceof Error ? e.message : String(e),
                    });
                  });
                } catch (e) {
                  logger.warn('retention_cleanup', 'evicted_asset_hashes_parse_failed', {
                    evictedDeploymentId: old.id,
                    err: e instanceof Error ? e.message : String(e),
                  });
                }
              }
              if (old.manifest) {
                try {
                  const oldManifest = JSON.parse(old.manifest) as DeployManifest;
                  if (oldManifest.sandbox) {
                    if (isManagedSandbox(oldManifest)) {
                      await deleteSandboxController(
                        context.env.CF_ACCOUNT_ID,
                        context.env.CF_API_TOKEN,
                        projectId,
                        old.id,
                        oldManifest.sandbox,
                        context.env.SANDBOX_CONCURRENCY_COUNTER,
                        context.get('db'),
                      );
                    } else {
                      const oldContainerAppName = perDeployContainerApplicationName(
                        projectId,
                        old.id,
                        oldManifest.sandbox.containerName ?? 'void-sandbox',
                      );
                      const existing = await findContainerApplication(
                        context.env.CF_ACCOUNT_ID,
                        context.env.CF_API_TOKEN,
                        oldContainerAppName,
                      );
                      if (existing) {
                        await deleteContainerApplicationIdempotent(
                          context.env.CF_ACCOUNT_ID,
                          context.env.CF_API_TOKEN,
                          existing.id,
                        );
                      }
                    }
                  }
                } catch (e) {
                  logger.error('retention_cleanup', 'evicted_sandbox_container_delete_failed', e, {
                    evictedDeploymentId: old.id,
                  });
                }
              }
              if (old.bundle_stored) {
                try {
                  await evictStoredWorkerBundle(old.id);
                } catch (e) {
                  logger.error('retention_cleanup', 'evicted_worker_bundle_delete_failed', e, {
                    evictedDeploymentId: old.id,
                  });
                }
              }
              await clearIsrCache(context.env.ISR_CACHE, projectId, old.id).catch((e) =>
                logger.error('retention_cleanup', 'evicted_isr_cache_clear_failed', e, {
                  evictedDeploymentId: old.id,
                }),
              );
            } catch (e) {
              logger.warn('retention_cleanup', 'eviction_partial_failure', {
                evictedDeploymentId: old.id,
                err: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }

          // Presigned uploads without a finalized manifest become orphans.
          // Sweep after the terminal event so R2 history does not delay a
          // successful deploy. The project fence still protects live hashes.
          if (assetCleanupSafe) {
            orphanSweepAfterResponse = async () => {
              try {
                const orphans = await sweepAssetOrphansWithProjectFence(retainedHashes);
                if (orphans > 0) {
                  logger.info('retention_cleanup', 'r2_orphans_swept', { count: orphans });
                }
              } catch (e) {
                logger.warn('retention_cleanup', 'r2_orphan_sweep_failed', {
                  err: e instanceof Error ? e.message : String(e),
                });
              }
            };
          }
        }

        const application = readPlatformApplication(context.env);
        const activeDomains = projectDomains.filter((d) => d.status === 'active');
        const fullUrl =
          activeDomains.length > 0
            ? `https://${activeDomains[0].hostname}`
            : `https://${platformProjectHostname(project, application)}`;

        emit({
          event: 'done',
          deployment: deployment.id,
          url: fullUrl,
          urls: [
            ...activeDomains.map((d) => `https://${d.hostname}`),
            `https://${platformProjectHostname(project, application)}`,
          ],
          assets: assetCount,
          workers: workerFiles.length,
          ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
        });
        await finishOrphanSweep();
      } catch (err) {
        const raw =
          err instanceof ProjectAccessDeniedError
            ? err.userMessage
            : err instanceof Error
              ? err.message
              : String(err);
        const msg = sanitizeDeployErrorMessage(raw);
        if (msg !== raw) {
          logger.error('catch', 'raw_error_before_sanitization', err, {
            workerName,
            currentPhase: currentStep,
          });
        }
        logger.error('catch', 'pipeline_error', err, {
          currentPhase: currentStep,
          routingSwitched,
          workerUploaded,
        });

        // Wfp mirror manifest cleanup on pre-routing failure (mirror of
        // multipart `cleanupStreamedAssetsOnAbort`'s mirror-only branch).
        if (!routingSwitched && wfpMirroredManifestDeploymentId) {
          const id = wfpMirroredManifestDeploymentId;
          wfpMirroredManifestDeploymentId = null;
          await context.env.ROUTING.delete(`manifest:${id}`).catch((e) =>
            logger.warn('catch', 'mirrored_manifest_evict_failed', {
              deploymentId: id,
              err: e instanceof Error ? e.message : String(e),
            }),
          );
        }

        const failedDeployment = deployment!;
        const failedManifest = manifest!;
        const failedWorkerName = workerName!;
        const failedDispatchNamespace = dispatchNamespace!;

        // A connection can fail after PostgreSQL has committed the go-live
        // transaction but before the client receives COMMIT's acknowledgement.
        // Before undoing any external state, reconcile that ambiguous outcome
        // from the durable deployment row. A readable non-live row after three
        // checks proves the callback did not commit. A live row proves it did,
        // even when a newer deploy/rollback has since changed project.active.
        // If PostgreSQL remains unreadable, preserve external state: leaking a
        // version temporarily is recoverable, deleting a possibly-live Worker
        // and restoring stale tenant routing is not.
        const supersededBuild = raw === SUPERSEDED_BUILD_ERROR_MESSAGE;
        const teardownRaceLost = routingSwitched && raw === PROJECT_DELETING_ERROR_MESSAGE;
        const deploymentCanceled = raw === 'deployment canceled';
        const staticAssetsMissing = err instanceof StaticAssetDisappearedError;
        let ambiguousCutoverOutcome:
          | 'committed'
          | 'pending_reconcile'
          | 'not_committed'
          | 'unknown'
          | undefined;
        if (
          routingSwitched &&
          !cutoverCommitted &&
          currentStep === 'db_finalize' &&
          !supersededBuild &&
          !teardownRaceLost &&
          !deploymentCanceled &&
          !staticAssetsMissing
        ) {
          let durableReadSucceeded = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const latest = await getDeployment(context.get('db'), failedDeployment.id);
              durableReadSucceeded = true;
              if (latest?.status === 'live') {
                ambiguousCutoverOutcome = 'committed';
                break;
              }
              if (latest?.status === 'cutover') {
                ambiguousCutoverOutcome = 'pending_reconcile';
                break;
              }
            } catch (readError) {
              logger.warn('catch', 'cutover_outcome_read_failed', {
                deploymentId: failedDeployment.id,
                attempt: attempt + 1,
                err: readError instanceof Error ? readError.message : String(readError),
              });
            }
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
            }
          }
          ambiguousCutoverOutcome ??= durableReadSucceeded ? 'not_committed' : 'unknown';
          logger.warn('catch', 'cutover_outcome_reconciled', {
            deploymentId: failedDeployment.id,
            outcome: ambiguousCutoverOutcome,
          });
        }
        let readyMarkerConfirmed: boolean | undefined;
        if (ambiguousCutoverOutcome === 'pending_reconcile') {
          try {
            const ready = parseCutoverMarker(
              await context.env.ROUTING.get(cutoverReadyKey(failedDeployment.id)),
            );
            readyMarkerConfirmed =
              ready?.projectId === projectId && ready.ownerId === cutoverOwnerId;
          } catch {
            // An unreadable marker leaves the protected intent fenced. A
            // later deploy can retry this proof under the project lock.
          }
        }
        const preserveAmbiguousCutover =
          ambiguousCutoverOutcome === 'committed' ||
          (ambiguousCutoverOutcome === 'pending_reconcile' && readyMarkerConfirmed !== false) ||
          ambiguousCutoverOutcome === 'unknown';

        // SUPERSEDED is thrown only inside the go-live tx (by
        // `assertBoundBuildStillActive`), so the message alone identifies it.
        // A teardown race is PROJECT_DELETING thrown AFTER routing was switched
        // (the in-tx delete re-check). Both abort the go-live: roll back the
        // routing keys this attempt wrote and tear down the worker/bundle/
        // container state, then mark the deployment failed (never live).
        const cutoverFailed = cutoverProtected && !cutoverCommitted && !preserveAmbiguousCutover;
        if (teardownRaceLost || supersededBuild || cutoverFailed) {
          const failureEvent = supersededBuild
            ? 'superseded_build'
            : teardownRaceLost
              ? 'teardown_race_lost'
              : 'cutover_failed';
          logger.error('catch', failureEvent, err, {
            workerName: failedWorkerName,
            writtenRoutingKeyCount: writtenRoutingKeys.length,
          });

          // Once a protected cutover intent exists, claim an explicit
          // compensation state under the project lock before undoing or
          // deleting anything. A concurrent recovery that already published
          // this deployment makes the conditional claim fail, in which case
          // this stale request must not touch its external state or artifacts.
          const needsProtectedClaim = !teardownRaceLost && currentStatus === 'cutover';
          if (needsProtectedClaim) {
            const claimed = await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const intent = parseCutoverMarker(
                await context.env.ROUTING.get(cutoverIntentKey(failedDeployment.id)),
              );
              if (intent?.projectId !== projectId || intent.ownerId !== cutoverOwnerId) {
                return false;
              }
              return await beginDeploymentCompensation(tx as unknown as Db, failedDeployment.id);
            });
            if (!claimed) {
              logger.warn('catch', 'cutover_compensation_claim_lost', {
                deploymentId: failedDeployment.id,
              });
              emit({ event: 'error', message: msg, step: currentStep });
              return;
            }
            currentStatus = 'compensating';
          }

          const compensationErrors: Array<unknown> = [];
          if (!cutoverCommitted) {
            await restoreTrackedQueueConsumers().catch((e) => {
              compensationErrors.push(e);
              logger.error('catch', 'queue_consumer_rollback_failed', e);
            });
          }
          await restoreTrackedRouting().catch((e) => {
            compensationErrors.push(e);
            logger.error('catch', 'routing_rollback_failed', e);
          });
          await restoreTrackedCronState().catch((e) => {
            compensationErrors.push(e);
            logger.error('catch', 'cron_rollback_failed', e);
          });

          // Snapshot compensation is best-effort per surface. Retry once when
          // one of those exact undos failed, then normalize the whole project
          // back to PostgreSQL's committed active deployment if exact restore
          // is still incomplete.
          if (needsProtectedClaim && compensationErrors.length > 0) {
            compensationErrors.length = 0;
            await restoreTrackedQueueConsumers().catch((error) => compensationErrors.push(error));
            await restoreTrackedRouting().catch((error) => compensationErrors.push(error));
            await restoreTrackedCronState().catch((error) => compensationErrors.push(error));
          }
          if (needsProtectedClaim && (compensationErrors.length > 0 || routingSwitched)) {
            await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const txDb = tx as unknown as Db;
              const lockedProject = await getProject(txDb, projectId);
              if (!lockedProject || lockedProject.status === 'deleting') {
                return;
              }
              if (compensationErrors.length > 0) {
                const committedActive = lockedProject.active_deployment_id
                  ? await getDeployment(txDb, lockedProject.active_deployment_id)
                  : null;
                if (committedActive) {
                  await replayDeploymentCutover(
                    context.env,
                    txDb,
                    lockedProject,
                    committedActive,
                    lockedProject.type,
                    { restoreCommitted: true },
                  );
                } else {
                  await clearProjectExternalState(context.env, txDb, lockedProject);
                }
              } else {
                // Exact undo succeeded, but a domain activation may have
                // committed after the earlier snapshot and copied this failed
                // deployment's slug route. Reconcile only domain keys to the
                // restored route; touching cron/queues here would regress
                // pre-routing failures that never changed those surfaces.
                const currentDomains = await getDomainsByProjectId(txDb, projectId);
                const rawRouting = await context.env.ROUTING.get(lockedProject.slug);
                const restoredRouting =
                  rawRouting === null
                    ? null
                    : withProjectZeroTrustRouting(
                        rawRouting,
                        await resolveProjectZeroTrustRoutingForPublication(txDb, projectId),
                        projectId,
                      );
                await reconcileProjectDomainRoutes(context.env, currentDomains, restoredRouting);
              }
            });
          }
          if (workerUploaded && workerUploadUrl) {
            await fetch(workerUploadUrl, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` },
            }).catch((e) =>
              logger.error('catch', 'orphan_worker_delete_failed', e, {
                workerName: failedWorkerName,
              }),
            );
          }
          if (sandboxControllerAttempted && deployment && manifest?.sandbox) {
            await deleteSandboxController(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              projectId,
              deployment.id,
              manifest.sandbox,
              context.env.SANDBOX_CONCURRENCY_COUNTER,
              context.get('db'),
            ).catch((error) =>
              logger.error('catch', 'sandbox_controller_cleanup_failed', error, {
                deploymentId: deployment?.id,
              }),
            );
          }

          if (needsProtectedClaim) {
            const compensatedKey = cutoverCompensatedKey(failedDeployment.id);
            try {
              await context.env.ROUTING.put(compensatedKey, projectId);
            } catch (markerError) {
              const confirmed = await context.env.ROUTING.get(compensatedKey).catch(() => null);
              if (confirmed !== projectId) {
                throw markerError;
              }
            }
          }
          const latestAfterFailure = await getDeployment(context.get('db'), failedDeployment.id);
          const wasCanceled =
            latestAfterFailure !== null &&
            CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latestAfterFailure.status);
          logger.info('status_transition', 'status_change', {
            deploymentId: failedDeployment.id,
            from: currentStatus,
            to: wasCanceled ? 'canceled' : 'failed',
            reason: failureEvent,
          });
          await updateDeploymentStatus(
            context.get('db'),
            failedDeployment.id,
            wasCanceled ? 'canceled' : 'failed',
            msg,
            wasCanceled ? { force: true } : undefined,
          ).catch(() => {});
          currentStatus = wasCanceled ? 'canceled' : 'failed';
          const terminal = await getDeployment(context.get('db'), failedDeployment.id).catch(
            () => null,
          );
          if (terminal && TERMINAL_DEPLOYMENT_STATUSES.includes(terminal.status)) {
            await Promise.all([
              context.env.ROUTING.delete(cutoverIntentKey(failedDeployment.id)),
              context.env.ROUTING.delete(cutoverReadyKey(failedDeployment.id)),
              context.env.ROUTING.delete(cutoverCompensatedKey(failedDeployment.id)),
            ]).catch(() => {
              // Terminal PostgreSQL state makes stale markers harmless.
            });
          }
          emit({ event: 'error', message: msg, step: currentStep });
        } else if (preserveAmbiguousCutover) {
          logger.warn('catch', 'ambiguous_cutover_preserved', {
            deploymentId: failedDeployment.id,
            outcome: ambiguousCutoverOutcome,
          });
          if (ambiguousCutoverOutcome === 'committed') {
            currentStatus = 'live';
            await Promise.all([
              context.env.ROUTING.delete(cutoverIntentKey(failedDeployment.id)),
              context.env.ROUTING.delete(cutoverReadyKey(failedDeployment.id)),
            ]).catch(() => {
              // Stale markers are harmless once PostgreSQL is live.
            });
            const application = readPlatformApplication(context.env);
            const slugUrl = `https://${platformProjectHostname(project, application)}`;
            emit({
              event: 'done',
              deployment: failedDeployment.id,
              url: slugUrl,
              urls: [slugUrl],
              assets: 0,
              workers: 0,
            });
          } else {
            emit({ event: 'error', message: msg, step: currentStep });
          }
        } else if (routingSwitched) {
          logger.error('catch', 'post_routing_step_failed', err, {
            workerName: failedWorkerName,
            currentPhase: currentStep,
          });
          logger.info('status_transition', 'status_change', {
            deploymentId: failedDeployment.id,
            from: currentStatus,
            to: 'live',
            reason: 'post_routing_recovery',
          });
          await updateDeploymentStatus(context.get('db'), failedDeployment.id, 'live', undefined, {
            force: true,
          }).catch(() => {});
          currentStatus = 'live';
          await updateProjectType(
            context.get('db'),
            projectId,
            failedManifest.type ?? (failedManifest.framework ? 'framework' : 'void'),
          ).catch(() => {});
          await setActiveDeployment(context.get('db'), projectId, failedDeployment.id).catch(
            () => {},
          );
          await markDeploymentRetained(context.get('db'), failedDeployment.id, true).catch(
            () => {},
          );
          const application = readPlatformApplication(context.env);
          const slugUrl = `https://${platformProjectHostname(project, application)}`;
          emit({
            event: 'done',
            deployment: failedDeployment.id,
            url: slugUrl,
            urls: [slugUrl],
            assets: 0,
            workers: 0,
          });
        } else {
          const latest = await getDeployment(context.get('db'), failedDeployment.id);
          const wasCanceled =
            latest && CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status);
          await restoreTrackedRouting().catch((e) =>
            logger.error('catch', 'routing_rollback_failed', e),
          );
          await deleteDispatchScript(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            failedDispatchNamespace,
            failedWorkerName,
          ).catch((e) =>
            logger.error('catch', 'worker_script_cleanup_failed', e, {
              workerName: failedWorkerName,
            }),
          );
          if (sandboxControllerAttempted && deployment && manifest?.sandbox) {
            await deleteSandboxController(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              projectId,
              deployment.id,
              manifest.sandbox,
              context.env.SANDBOX_CONCURRENCY_COUNTER,
              context.get('db'),
            ).catch((error) =>
              logger.error('catch', 'sandbox_controller_cleanup_failed', error, {
                deploymentId: deployment?.id,
              }),
            );
          }
          await clearIsrCache(context.env.ISR_CACHE, projectId, failedDeployment.id).catch((e) =>
            logger.error('catch', 'isr_cache_clear_failed', e, {
              deploymentId: failedDeployment.id,
            }),
          );
          logger.info('status_transition', 'status_change', {
            deploymentId: failedDeployment.id,
            from: currentStatus,
            to: wasCanceled ? 'canceled' : 'failed',
            reason: 'pre_routing_failure',
            wasCanceled,
          });
          if (!wasCanceled) {
            await updateDeploymentStatus(context.get('db'), failedDeployment.id, 'failed', msg);
            currentStatus = 'failed';
          } else {
            await updateDeploymentStatus(context.get('db'), failedDeployment.id, 'canceled', msg, {
              force: true,
            });
            currentStatus = 'canceled';
          }
          emit({ event: 'error', message: msg, step: currentStep });
          if (!wasCanceled && context.env.EMAIL && owner.email) {
            const notification = sendDeployFailedEmail(
              context.env,
              owner.email,
              project.slug,
              msg,
            ).catch((err) =>
              logger.error('catch', 'failed_email_send_failed', err, {
                projectSlug: project.slug,
              }),
            );
            try {
              context.executionCtx.waitUntil(notification);
            } catch {
              await notification;
            }
          }
        }
      }
    } catch (err) {
      logger.error('catch', 'unhandled_pipeline_error', err, { currentPhase: currentStep });
      emit({
        event: 'error',
        message: 'deploy failed due to an internal error',
        step: currentStep,
      });
    } finally {
      clearInterval(heartbeat);
      // Reap the placeholder deployment row if it never advanced past the
      // initial 'pending' + null-manifest state. Same invariant as
      // multipart: a row stuck at 'pending' with a manifest set is the
      // bug class we want surfaced.
      //
      // A `canceling` placeholder means a `cancelDeployment` API call
      // raced an early-return path (asset-verify failure, quota check,
      // etc.) AFTER the precheck-and-claim insert but BEFORE the manifest
      // update. The two-phase cancellation flip sets status='canceling'
      // but the pipeline's catch never reached a force-finalize path.
      // DELETE alongside `pending` placeholders — both represent no real
      // deploy attempt (manifest is still null).
      try {
        const latest = await getDeployment(context.get('db'), preDeployment.id);
        if (
          latest &&
          (latest.status === 'pending' || latest.status === 'canceling') &&
          latest.manifest === null
        ) {
          await context.get('db').delete(deployments).where(eq(deployments.id, preDeployment.id));
          logger.info('placeholder_reap', 'placeholder_deleted', {
            placeholderId: preDeployment.id,
            priorStatus: latest.status,
          });
        } else if (latest && latest.status === 'pending' && latest.manifest !== null) {
          logger.warn('placeholder_reap', 'stranded_pending_row', {
            placeholderId: preDeployment.id,
            latestStatus: latest.status,
            hasManifest: latest.manifest !== null,
          });
        }
      } catch (err) {
        logger.warn('placeholder_reap', 'reap_failed', {
          placeholderId: preDeployment.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await persistedEvents;
      streamOpen = false;
      try {
        if (!execution) {
          await writer.close();
        }
      } catch {
        // ignore
      }
    }
  })();

  if (execution) {
    await pipeline;
    if (terminalEvent) {
      await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const candidate = await getDeployment(txDb, preDeployment.id);
        const event = terminalEvent!;
        if (event.event === 'done') {
          const completed = await getDeployment(txDb, event.deployment);
          if (completed?.status === 'live') {
            await appendDeploymentEvent(txDb, preDeployment.id, cutoverOwnerId, event);
          }
        } else if (
          event.event === 'error' &&
          (!candidate || candidate.status === 'failed' || candidate.status === 'canceled')
        ) {
          await appendDeploymentEvent(txDb, preDeployment.id, cutoverOwnerId, event);
        }
        // An unresolved cutover/compensation is still an owned operation. The
        // Queue outbox reconciles it after the invocation's hard lifetime.
      });
    }
    return new Response(null, { status: 204 });
  }
  void pipeline;
  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

export async function executeQueuedDeployment(
  env: ApiEnv['Bindings'],
  db: Db,
  operation: DeploymentOperation,
): Promise<void> {
  const actor = await getUser(db, operation.actor_id);
  if (!actor) {
    await updateDeploymentStatus(
      db,
      operation.id,
      'failed',
      'Deployment actor is no longer active',
      { force: true },
    );
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: 'Deployment actor is no longer active',
      step: 'authorization',
    });
    return;
  }
  const initial = await getDeployment(db, operation.id);
  if (initial?.status === 'canceling' || initial?.status === 'canceled') {
    await updateDeploymentStatus(db, operation.id, 'canceled', undefined, { force: true });
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: initial.error_message ?? 'Deployment was canceled',
      step: 'canceled',
    });
    return;
  }
  try {
    await assertDeploymentExecutionAuthority(db, operation);
  } catch {
    await updateDeploymentStatus(
      db,
      operation.id,
      'failed',
      'Deployment actor or credential is no longer active',
      { force: true },
    );
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: 'Deployment actor or credential is no longer active',
      step: 'authorization',
    });
    return;
  }
  const workerFiles: Array<{ name: string; content: Blob }> = [];
  for (const module of operation.payload.modules) {
    const object = await env.STATIC_ASSETS_R2.get(module.key);
    if (!object) {
      throw new Error('Durable deployment input is missing');
    }
    const bytes = await object.arrayBuffer();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== module.digest) {
      throw new Error('Durable deployment input digest mismatch');
    }
    workerFiles.push({ name: module.name, content: new Blob([bytes], { type: module.type }) });
  }
  const executor = new Hono<ApiEnv>()
    .onError((error) => {
      throw error;
    })
    .use('*', async (context, next) => {
      context.set('db', db);
      context.set('user', actor);
      context.set('deployScope', operation.project_id);
      if (operation.payload.credentialId) {
        context.set('deployCredential', operation.payload.credentialId);
      }
      if (operation.build_id) {
        context.set('deployBuild', operation.build_id);
      }
      context.set('deploymentExecution', { operation, workerFiles });
      await next();
    })
    .post('/:id/deploy', handleManifestOnlyDeploy);
  const response = await executor.fetch(
    new Request(`https://deployment.invalid/${operation.project_id}/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(operation.cli_version ? { 'x-void-cli-version': operation.cli_version } : {}),
      },
      body: JSON.stringify(operation.payload.body),
    }),
    env,
  );
  if (response.status !== 204) {
    // A rejected admitted input never entered the pipeline. No provider write
    // occurred, so its placeholder can be finalized without replaying it.
    await db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT id FROM projects WHERE id = ${operation.project_id} FOR UPDATE`,
      );
      const candidate = await getDeployment(tx as unknown as Db, operation.id);
      if (!candidate || candidate.manifest !== null || candidate.status !== 'pending') {
        throw new Error('Admitted deployment needs reconciliation');
      }
      await updateDeploymentStatus(
        tx as unknown as Db,
        operation.id,
        'failed',
        'Admitted deployment is no longer authorized or valid',
        { force: true },
      );
    });
    await appendDeploymentEvent(db, operation.id, operation.owner_id!, {
      event: 'error',
      message: 'Admitted deployment is no longer authorized or valid',
      step: 'authorization',
    });
  }
}

app.get('/:id/deployments/:deploymentId/events', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'read');
  if (access instanceof Response) {
    return access;
  }
  if (context.get('deployScope') && context.get('deployScope') !== projectId) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const since = Number(context.req.query('since') ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) {
    return context.json({ error: 'invalid progress cursor' }, 400);
  }
  const operation = await getDeploymentOperation(
    context.get('db'),
    context.req.param('deploymentId'),
  );
  if (!operation || operation.project_id !== projectId) {
    return context.json({ error: 'deployment receipt not found' }, 404);
  }
  return context.json(deploymentEventPage(operation, since));
});

// Deploy preflight — returns which assets need uploading based on diff with last deploy
app.post('/:id/deploy/preflight', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }
  const project = access.project;
  // Mirror /upload-urls and handleManifestOnlyDeploy: short-circuit when
  // the project is being torn down so callers get the more specific 410
  // before any body parsing or version-gate work. A stale CLI on a
  // deleting project should see "project is being deleted", not "upgrade
  // your CLI" — upgrading won't make the project come back.
  if (project.status === 'deleting') {
    return context.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs AFTER project authz + status so a stale CLI
  // hitting a missing/foreign/deleting project gets the more specific
  // 404/403/410 first instead of a misleading "upgrade your CLI" 426.
  const versionReject = checkCliVersionOrRespond(context);
  if (versionReject) {
    return versionReject;
  }
  try {
    await requireNormalizedProject(context.get('db'), project);
  } catch (error) {
    if (error instanceof ProjectRequiresNormalizationError) {
      return context.json({ error: error.code, message: error.message }, 409);
    }
    throw error;
  }

  const body = await context.req.json<{
    assetManifest: Record<string, { hash: string; size: number }>;
    hasWorker?: boolean;
  }>();
  const { assetManifest } = body;
  const total = Object.keys(assetManifest).length;
  // Both static and Worker deployments require the platform-owned scoped R2
  // copy. Provider asset deduplication and historical KV placement are not
  // evidence that the current serving store has these bytes.
  const valid =
    total <= MAX_UPLOAD_URLS_BATCH &&
    Object.values(assetManifest).every(
      (entry) =>
        entry &&
        typeof entry.hash === 'string' &&
        HEX_32_REGEX.test(entry.hash) &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0,
    );
  if (!valid) {
    return context.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
  }
  const active = project.active_deployment_id
    ? await getDeployment(context.get('db'), project.active_deployment_id)
    : null;
  const activeR2Sizes =
    active?.status === 'live' && active.project_id === projectId
      ? persistedR2AssetSizes(active.asset_hashes)
      : new Map<string, number>();
  const unverified = Object.fromEntries(
    Object.entries(assetManifest).filter(
      ([, entry]) => activeR2Sizes.get(entry.hash) !== entry.size,
    ),
  );
  const needed = await findMissingR2Assets(context.env.STATIC_ASSETS_R2, projectId, unverified);
  return context.json({ needed, total, skipped: total - needed.length });
});

export async function clearIsrCache(
  kv: KVNamespace,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  // `deploymentId` is required so a bare call cannot fall through to the
  // project-wide prefix and wipe every deployment's ISR namespace.
  //
  // Sweep BOTH the current v3 (host-scoped) namespace AND the legacy v2
  // (hostless) namespace. A deployment created before the v3 rollout can still
  // hold orphaned v2 ISR entries, and ISR KV puts set no `expirationTtl`; once
  // this deployment id is evicted (retention / failed-deploy cleanup), no later
  // active-route revalidation ever names it again, so `clearIsrCache` is the
  // last path that can reap them. Mirrors the legacy-aware purge in
  // `revalidate-core.ts`. The two prefixes are disjoint (`…/isr/v3/…` vs
  // `…/isr/v2/…`), so nothing is listed or deleted twice. Transition-only:
  // drop the v2 sweep once no v2 entries remain in production.
  await deleteIsrKeysByPrefix(kv, isrCachePrefix(projectId, deploymentId));
  await deleteIsrKeysByPrefix(kv, isrLegacyCachePrefix(projectId, deploymentId));
}

async function deleteIsrKeysByPrefix(kv: KVNamespace, prefix: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const listed = await kv.list({ prefix, cursor });
    if (listed.keys.length > 0) {
      await uploadPool(listed.keys, R2_CONCURRENCY, (key) => kv.delete(key.name));
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

// --- ISR prerender helpers ---

/**
 * Pack response headers + body into a single ArrayBuffer.
 * Format: [4 bytes uint32 LE header length][UTF-8 header JSON][raw body]
 */
function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
function serializePrerenderHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

  response.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

function moduleContentType(filename: string): string {
  if (filename.endsWith('.wasm')) {
    return 'application/wasm';
  }
  if (filename.endsWith('.map')) {
    return 'application/source-map';
  }
  if (filename.endsWith('.json')) {
    return 'application/json';
  }
  if (filename.endsWith('.txt')) {
    return 'text/plain';
  }
  return 'application/javascript+module';
}

export default app;
