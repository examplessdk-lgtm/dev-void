import type { ProjectZeroTrustRouting } from '@void/edge';
import {
  PLATFORM_APPLICATION_KEY,
  platformProjectHostnames,
  readPlatformApplication,
  type PlatformApplication,
} from '@void/platform';
import { and, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import {
  getActiveDeployment,
  getDeployment,
  getDomainsByProjectId,
  getLatestLiveDeployment,
  getProject,
  getUser,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { requireProjectCapability } from '../project-access.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import { computeDispatchLimits } from '../routing-limits.ts';
import { domains, projects, projectZeroTrust } from '../schema.ts';
import { routingSuspensionReason } from '../suspension.ts';
import { PLAN_LIMITS } from '../tiers.ts';
import type { DeployManifest, Project, ProjectZeroTrust } from '../types.ts';
import {
  applicationTargetEnvironment,
  PLATFORM_APPLICATION_SETTING,
  resolveZeroTrustApplicationEnvironment,
} from './application.ts';
import {
  ZeroTrustCloudflareClient,
  ZeroTrustCloudflareError,
  bypassPolicy,
  reusablePolicyReferences,
} from './cloudflare.ts';
import {
  ZERO_TRUST_CREDENTIAL_ID,
  type ManagedAccessApplication,
  type ZeroTrustConfiguration,
  ZeroTrustConfigurationError,
  type ZeroTrustConfigureInput,
  type ZeroTrustOperation,
  parseZeroTrustApplicationTarget,
  zeroTrustConfigurationStatus,
  readZeroTrustConfigurationStrict,
  redactedZeroTrustConfiguration,
  replaceZeroTrustConfiguration,
  writeZeroTrustConfiguration,
  zeroTrustWildcardDestinations,
} from './configuration.ts';

export class ZeroTrustUnavailableError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = 'ZeroTrustUnavailableError';
  }
}

const OPERATION_LEASE_MS = 15 * 60 * 1000;
const MAX_PROJECTS_PER_RUN = 100;
const MAX_ROUTING_KEYS_PER_RUN = 300;
export const MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT = 100;

/** Routing writes left in one invocation. `exhausted` stops the batch before another project. */
type RoutingBudget = { remaining: number; exhausted?: boolean };

function requiredRoutingBudget(row: Pick<ProjectZeroTrust, 'desired_protected'>): number {
  // Protected routes are published in one pass: slug plus every capped custom domain.
  return row.desired_protected ? MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT + 1 : 1;
}

/** Explain a deploy or rollback rejected because project routing cannot carry protection yet. */
export function zeroTrustNotReadyMessage(error: unknown): string | null {
  if (error instanceof ZeroTrustConfigurationError) {
    return 'The platform Zero Trust configuration is invalid. Ask a platform administrator to repair it, then retry.';
  }
  if (error instanceof ZeroTrustUnavailableError) {
    return `Zero Trust protection for this project is not ready: ${error.message} Run \`void project zero-trust status\` for details. A project admin or owner can run \`void project zero-trust reconcile\` once the platform is ready, then retry.`;
  }
  return null;
}

async function lockZeroTrustConfiguration(db: DbOrTx): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext('zero-trust:configuration'))`);
}

function installationId(env: ApiEnv['Bindings']): string {
  return env.PLATFORM_INSTALLATION_ID ?? 'installation';
}

async function applicationName(env: ApiEnv['Bindings'], suffix: string): Promise<string> {
  const installation = installationId(env);
  const identity = installation
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 32);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installation)),
  );
  const fingerprint = Array.from(digest.subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return `void-${identity}-${fingerprint}-${nonce}-${suffix}`.slice(0, 120);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}

async function clientForConfiguration(
  env: ApiEnv['Bindings'],
  configuration: ZeroTrustConfiguration,
): Promise<ZeroTrustCloudflareClient> {
  const token = await decryptPlatformCredential(
    env,
    installationId(env),
    ZERO_TRUST_CREDENTIAL_ID,
    configuration.credential,
  );
  return new ZeroTrustCloudflareClient(configuration.accountId, token);
}

function projectApplicationReference(row: ProjectZeroTrust, kind: 'bypass' | 'protected') {
  return kind === 'bypass'
    ? { id: row.bypass_application_id, name: row.bypass_application_name }
    : { id: row.protected_application_id, name: row.protected_application_name };
}

async function putProjectState(
  db: DbOrTx,
  projectId: string,
  values: Partial<typeof projectZeroTrust.$inferInsert>,
): Promise<ProjectZeroTrust> {
  const [row] = await db
    .insert(projectZeroTrust)
    .values({
      project_id: projectId,
      desired_protected: values.desired_protected ?? values.effective_protected ?? false,
      effective_protected: false,
      status: 'reconciling',
      ...values,
    })
    .onConflictDoUpdate({
      target: projectZeroTrust.project_id,
      set: { ...values, updated_at: sql`now()` },
    })
    .returning();
  return row!;
}

export async function getProjectZeroTrustState(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectZeroTrust | null> {
  const [row] = await db
    .select()
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, projectId))
    .limit(1);
  return row ?? null;
}

export type ProjectZeroTrustState = 'public' | 'protected' | 'reconciling' | 'error';

/** The one label shown to users: a settled row reports its protection. */
export function projectZeroTrustState(
  row: Pick<ProjectZeroTrust, 'status' | 'desired_protected'>,
): ProjectZeroTrustState {
  if (row.status !== 'ready') {
    return row.status;
  }
  return row.desired_protected ? 'protected' : 'public';
}

type PublicProjectZeroTrustState = Readonly<
  Pick<
    ProjectZeroTrust,
    'project_id' | 'desired_protected' | 'effective_protected' | 'last_error' | 'updated_at'
  > & { state: ProjectZeroTrustState }
>;

export function publicProjectZeroTrustState(
  row: ProjectZeroTrust | null,
): PublicProjectZeroTrustState | null {
  if (!row) {
    return null;
  }
  return {
    project_id: row.project_id,
    desired_protected: row.desired_protected,
    effective_protected: row.effective_protected,
    state: projectZeroTrustState(row),
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

/** The user-facing project shape plus the handles only platform operators see. */
export function operatorProjectZeroTrustState(row: ProjectZeroTrust | null) {
  if (!row) {
    return null;
  }
  return {
    ...publicProjectZeroTrustState(row)!,
    bypass_application_id: row.bypass_application_id,
    bypass_application_name: row.bypass_application_name,
    protected_application_id: row.protected_application_id,
    protected_application_name: row.protected_application_name,
    protected_application_audience: row.protected_application_audience,
    routing_cursor: row.routing_cursor,
    reconciled_operation: row.reconciled_operation,
    created_at: row.created_at,
  };
}

/** Project protection can change only on a ready installation with no running operation. */
export function projectZeroTrustAvailable(configuration: ZeroTrustConfiguration | null): boolean {
  return (
    !!configuration?.enabled &&
    zeroTrustConfigurationStatus(configuration) === 'ready' &&
    !!configuration.wildcardApplication
  );
}

async function updateProjectState(
  db: DbOrTx,
  projectId: string,
  values: Partial<typeof projectZeroTrust.$inferInsert>,
): Promise<ProjectZeroTrust> {
  const [row] = await db
    .update(projectZeroTrust)
    .set({ ...values, updated_at: sql`now()` })
    .where(eq(projectZeroTrust.project_id, projectId))
    .returning();
  if (!row) {
    throw new ZeroTrustUnavailableError('Project is unavailable.');
  }
  return row;
}

async function projectDestinations(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Pick<Project, 'id' | 'slug'>,
  protectedProject: boolean,
): Promise<{ platform: ReadonlyArray<string>; custom: ReadonlyArray<string> }> {
  const application = readPlatformApplication(
    await resolveZeroTrustApplicationEnvironment(env, db),
  );
  const platform = [...new Set(platformProjectHostnames(project, application))];
  if (!protectedProject) {
    return { platform, custom: [] };
  }
  const custom = [
    ...new Set((await getDomainsByProjectId(db, project.id)).map((domain) => domain.hostname)),
  ];
  if (custom.length > MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT) {
    throw new ZeroTrustUnavailableError(
      `Project Zero Trust supports at most ${MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT} custom domains per project.`,
    );
  }
  return { platform, custom };
}

function routingProtection(
  configuration: ZeroTrustConfiguration,
  protectedApplication: ManagedAccessApplication | null,
): ProjectZeroTrustRouting {
  if (!configuration.wildcardApplication) {
    throw new ZeroTrustUnavailableError('The platform Access application is unavailable.');
  }
  return {
    teamDomain: configuration.teamDomain,
    audiences: [
      ...configuration.wildcardApplication.destinations.map((hostname) => ({
        hostname,
        audience: configuration.wildcardApplication!.audience,
      })),
      ...(protectedApplication
        ? protectedApplication.destinations.map((hostname) => ({
            hostname,
            audience: protectedApplication.audience,
          }))
        : []),
    ],
  };
}

function managedProtectedApplication(
  row: ProjectZeroTrust,
  destinations: ReadonlyArray<string>,
): ManagedAccessApplication | null {
  return row.protected_application_id &&
    row.protected_application_name &&
    row.protected_application_audience
    ? {
        id: row.protected_application_id,
        name: row.protected_application_name,
        audience: row.protected_application_audience,
        destinations,
      }
    : null;
}

export async function resolveProjectZeroTrustRouting(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectZeroTrustRouting | null> {
  return readProjectZeroTrustRouting(db, projectId, false);
}

async function readProjectZeroTrustRouting(
  db: DbOrTx,
  projectId: string,
  allowReconcilingPublic: boolean,
): Promise<ProjectZeroTrustRouting | null> {
  await lockZeroTrustConfiguration(db);
  const [configuration, row] = await Promise.all([
    readZeroTrustConfigurationStrict(db),
    getProjectZeroTrustState(db, projectId),
  ]);
  if (!configuration) {
    return null;
  }
  if (!row) {
    if (
      configuration.enabled ||
      (configuration.operation !== null && configuration.operation.kind !== 'disable')
    ) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is still being initialized.');
    }
    return null;
  }
  if (!row.desired_protected) {
    if (
      configuration.enabled &&
      configuration.operation?.kind !== 'disable' &&
      (!row.bypass_application_id || (!allowReconcilingPublic && row.status !== 'ready'))
    ) {
      throw new ZeroTrustUnavailableError('The project public exception is still reconciling.');
    }
    return null;
  }
  if (!configuration.enabled || !configuration.wildcardApplication) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is still being initialized.');
  }
  if (!row.effective_protected) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is still reconciling.');
  }
  const protectedApplication = managedProtectedApplication(
    row,
    (await getDomainsByProjectId(db as Db, projectId)).map((domain) => domain.hostname),
  );
  return routingProtection(configuration, protectedApplication);
}

/** An empty audience set makes dispatch deny every request until reconciliation finishes. */
const DENY_ALL_ROUTING: ProjectZeroTrustRouting = { teamDomain: '', audiences: [] };

/**
 * Read current protection inside the caller's project-row transaction before
 * publishing KV. When protection is not settled:
 * - a desired or effectively protected project gets the deny-all marker;
 * - a public project with a durable bypass stays public;
 * - anything else is unknown. A writer that can retry later (`retryable`)
 *   gets the error; every other writer must publish now and gets deny-all.
 */
export async function resolveProjectZeroTrustRoutingForPublication(
  db: DbOrTx,
  projectId: string,
  options: Readonly<{ retryable?: boolean }> = {},
): Promise<ProjectZeroTrustRouting | null> {
  try {
    // A durable bypass makes PUBLIC intent safe even while paginated cleanup
    // is unfinished. Reintroducing a deny marker behind its routing cursor
    // would strand already-completed keys. Deploys retain the stricter gate.
    return await readProjectZeroTrustRouting(db, projectId, true);
  } catch (error) {
    if (
      !(error instanceof ZeroTrustUnavailableError) &&
      !(error instanceof ZeroTrustConfigurationError)
    ) {
      throw error;
    }
    const row = await getProjectZeroTrustState(db, projectId);
    if (row && (row.desired_protected || row.effective_protected)) {
      return DENY_ALL_ROUTING;
    }
    if (row?.bypass_application_id) {
      return null;
    }
    if (options.retryable) {
      throw error;
    }
    return DENY_ALL_ROUTING;
  }
}

export function withProjectZeroTrustRouting(
  raw: string,
  protection: ProjectZeroTrustRouting | null,
): string {
  const entry = JSON.parse(raw) as Record<string, unknown>;
  if (protection) {
    entry.zeroTrust = protection;
  } else {
    delete entry.zeroTrust;
  }
  return JSON.stringify(entry);
}

function routingMatchesDeployment(
  entry: Record<string, unknown>,
  projectSlug: string,
  deploymentId: string,
): boolean {
  const identifiers = [entry.version, entry.staticDeploymentId, entry.deploymentId];
  if (typeof entry.workerName === 'string' && entry.workerName.length > 0) {
    if (entry.workerName !== `user-${projectSlug}-${deploymentId}`) {
      return false;
    }
    identifiers.push(deploymentId);
  }
  // Canonical builders identify the target. Unknown legacy snapshots cannot
  // prove freshness after a committed deployment, and conflicting fields must
  // not be hidden by another field that happens to match.
  const knownIdentifiers = identifiers.filter(
    (identifier) => typeof identifier === 'string' && identifier.length > 0,
  );
  return (
    knownIdentifiers.length > 0 &&
    knownIdentifiers.every((identifier) => identifier === deploymentId)
  );
}

async function publishProjectZeroTrustRoutingLocked(
  env: Pick<ApiEnv['Bindings'], 'ROUTING'>,
  db: Db,
  project: Pick<Project, 'id' | 'slug' | 'user_id' | 'active_deployment_id'>,
  protection: ProjectZeroTrustRouting | null,
  budget = { remaining: MAX_ROUTING_KEYS_PER_RUN },
): Promise<boolean> {
  const row = await getProjectZeroTrustState(db, project.id);
  // Cutover publishes before committing the project pointer. Read its target
  // once under the project lock so metadata changes can accompany that route,
  // but cannot republish a stale previous deployment from KV.
  const [activeDeployment, owner] = await Promise.all([
    getActiveDeployment(db, project.id),
    getUser(db, project.user_id),
  ]);
  if (!owner) {
    throw new ZeroTrustUnavailableError('Project owner is unavailable.');
  }
  const routeDeployment =
    activeDeployment?.status === 'cutover'
      ? activeDeployment
      : project.active_deployment_id
        ? await getDeployment(db, project.active_deployment_id)
        : await getLatestLiveDeployment(db, project.id);
  const expectedDeploymentId =
    activeDeployment?.status === 'cutover'
      ? activeDeployment.id
      : (project.active_deployment_id ?? routeDeployment?.id);
  const manifest = routeDeployment?.manifest
    ? (JSON.parse(routeDeployment.manifest) as DeployManifest)
    : null;
  const dispatchLimits = computeDispatchLimits(PLAN_LIMITS[owner.plan], manifest?.limits);
  const suspensionReason = routingSuspensionReason(owner.suspended_reason);
  // Protected destinations are capped separately. Clearing public routing has
  // no domain cap and checkpoints progress while holding the project lock.
  const cursor = protection ? null : (row?.routing_cursor ?? null);
  const domainBudget = Math.max(0, budget.remaining - (cursor === null ? 1 : 0));
  const projectDomains = await db
    .select({ hostname: domains.hostname, status: domains.status })
    .from(domains)
    .where(
      and(
        eq(domains.project_id, project.id),
        cursor === null ? undefined : gt(domains.hostname, cursor),
      ),
    )
    .orderBy(domains.hostname)
    .limit(domainBudget + 1);
  const page = projectDomains.slice(0, domainBudget);
  const keys = [
    ...(cursor === null
      ? [{ key: project.slug, expected: !!expectedDeploymentId, pending: false }]
      : []),
    ...page.map((domain) => ({
      key: `domain:${domain.hostname}`,
      expected: domain.status === 'active',
      pending: domain.status === 'pending',
    })),
  ];
  for (const { key, expected, pending } of keys) {
    budget.remaining -= 1;
    const raw = await env.ROUTING.get(key);
    if (!raw) {
      // KV can return a cached miss even after a route was published. Keep its
      // cleanup checkpoint retryable instead of permanently skipping live keys.
      if (expected) {
        throw new ZeroTrustUnavailableError(
          `Live routing for ${key} is temporarily unavailable. Retry Zero Trust reconciliation.`,
        );
      }
      continue;
    }
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (entry.projectId !== undefined && entry.projectId !== project.id) {
      // A reused slug or hostname may still return the previous project's KV
      // value, even when this project has never deployed. Never republish or
      // delete another project's route based on that stale read.
      throw new ZeroTrustUnavailableError(
        `Live routing for ${key} is temporarily unavailable. Retry Zero Trust reconciliation.`,
      );
    }
    if (
      expectedDeploymentId &&
      !routingMatchesDeployment(entry, project.slug, expectedDeploymentId)
    ) {
      if (pending) {
        // Activation may have crashed before marking this domain active. Drop
        // obsolete residue so its next activation can publish the current slug
        // without getting stuck on reconciliation of the old deployment.
        await env.ROUTING.delete(key);
        continue;
      }
      throw new ZeroTrustUnavailableError(
        `Live routing for ${key} is temporarily unavailable. Retry Zero Trust reconciliation.`,
      );
    }
    // The deployment payload is immutable, but these fields can change after
    // deployment. A fresh project lock does not make a cached KV snapshot fresh.
    entry.userId = owner.id;
    if ('workerName' in entry) {
      if (dispatchLimits) {
        entry.limits = dispatchLimits;
      } else {
        delete entry.limits;
      }
    }
    if (suspensionReason) {
      entry.suspended = suspensionReason;
    } else {
      delete entry.suspended;
    }
    if (protection) {
      entry.zeroTrust = protection;
    } else {
      delete entry.zeroTrust;
    }
    await env.ROUTING.put(key, JSON.stringify(entry));
  }
  const complete = projectDomains.length <= domainBudget;
  await putProjectState(db, project.id, {
    routing_cursor: complete ? null : (page.at(-1)?.hostname ?? cursor ?? ''),
    ...(!complete ? { status: 'reconciling' as const } : {}),
  });
  return complete;
}

async function markProjectError(db: DbOrTx, projectId: string, error: unknown): Promise<void> {
  await db
    .update(projectZeroTrust)
    .set({ status: 'error', last_error: errorMessage(error), updated_at: sql`now()` })
    .where(eq(projectZeroTrust.project_id, projectId));
}

/** Like markProjectError, but leaves rows that settled since the failure alone. */
async function markPendingProjectError(db: Db, projectId: string, error: unknown): Promise<void> {
  await db
    .update(projectZeroTrust)
    .set({ status: 'error', last_error: errorMessage(error), updated_at: sql`now()` })
    .where(
      and(eq(projectZeroTrust.project_id, projectId), sql`${projectZeroTrust.status} <> 'ready'`),
    );
}

/** Every configuration write increments the revision, so it alone identifies a snapshot. */
function sameConfiguration(
  expected: ZeroTrustConfiguration,
  current: ZeroTrustConfiguration | null,
): current is ZeroTrustConfiguration {
  return current !== null && current.revision === expected.revision;
}

/**
 * The operation a reconciled row completes. A public row is complete once its
 * bypass and routes are done, which the public-bypass phase already does. A
 * protected row depends on the wildcard audience, so it completes only after
 * the wildcard phase.
 */
function completedProjectOperation(
  configuration: ZeroTrustConfiguration,
  publicProject: boolean,
): string | null {
  const operation = configuration.operation;
  if (!operation || operation.kind === 'disable') {
    return null;
  }
  return operation.phase === 'projects' || (publicProject && operation.phase === 'public-bypasses')
    ? operation.id
    : null;
}

type ProjectReconciliationOptions = {
  /** Snapshot owned by an installation operation; it must still match under the lock. */
  configuration?: ZeroTrustConfiguration;
  client?: ZeroTrustCloudflareClient;
  desiredProtection?: boolean;
  routingBudget?: RoutingBudget;
  /** Recheck this user's `settings` capability under the project lock. */
  actorUserId?: string;
  /**
   * Use the configuration saved under the lock even while an installation
   * operation runs. Domain changes must not wait for the whole operation.
   */
  duringOperation?: boolean;
};

function savedConfigurationAllows(
  saved: ZeroTrustConfiguration | null,
  options?: ProjectReconciliationOptions,
): saved is ZeroTrustConfiguration {
  return options?.duringOperation
    ? !!saved?.enabled && !!saved.wildcardApplication && saved.operation?.kind !== 'disable'
    : projectZeroTrustAvailable(saved);
}

async function checkpointProjectReconciliation(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: ProjectReconciliationOptions,
): Promise<ProjectZeroTrust> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    // The route precheck can go stale. Team and ownership changes share this
    // lock, so authorize again before committing the new intent. Platform
    // callers (operators, maintenance, domain hooks) have no actor here.
    if (options?.actorUserId) {
      await requireProjectCapability(lockedDb, projectId, options.actorUserId, 'settings');
    }
    const project = await getProject(lockedDb, projectId);
    if (!project || project.status === 'deleting') {
      throw new ZeroTrustUnavailableError('Project is unavailable.');
    }
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    const configuration = options?.configuration ?? saved;
    if (
      !configuration ||
      configuration.operation?.kind === 'disable' ||
      (options?.configuration && !sameConfiguration(configuration, saved)) ||
      (!options?.configuration && !savedConfigurationAllows(saved, options))
    ) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not ready on this platform.');
    }
    const existing = await getProjectZeroTrustState(lockedDb, projectId);
    const desired =
      options?.desiredProtection ??
      existing?.desired_protected ??
      initialProjectProtection(configuration, project);
    const destinations = await projectDestinations(env, lockedDb, project, desired);
    const values: Partial<typeof projectZeroTrust.$inferInsert> = {
      desired_protected: desired,
      status: 'reconciling',
      last_error: null,
      ...(existing?.desired_protected !== desired ? { routing_cursor: null } : {}),
    };
    if (!desired && !existing?.bypass_application_name) {
      values.bypass_application_name = await applicationName(env, `public-${project.id}`);
    }
    if (desired && destinations.custom.length > 0 && !existing?.protected_application_name) {
      values.protected_application_name = await applicationName(env, `protected-${project.id}`);
    }
    return putProjectState(lockedDb, projectId, values);
  });
}

/**
 * Public transition, under the project lock: ensure the bypass, publish every
 * route without enforcement, mark the project effectively public, then delete
 * its protected custom-domain application. It needs no wildcard application.
 */
async function reconcilePublicProjectLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  project: Project,
  current: ProjectZeroTrust,
  platformDestinations: ReadonlyArray<string>,
  client: ZeroTrustCloudflareClient,
  configuration: ZeroTrustConfiguration,
  routingBudget?: RoutingBudget,
): Promise<ProjectZeroTrust> {
  if (!current.bypass_application_name) {
    throw new Error('The project public application checkpoint is missing.');
  }
  const bypass = await client.ensureApplication(
    {
      name: current.bypass_application_name,
      destinations: platformDestinations,
      policies: bypassPolicy('Void project is public'),
    },
    projectApplicationReference(current, 'bypass'),
  );
  await updateProjectState(lockedDb, project.id, {
    bypass_application_id: bypass.id,
    bypass_application_name: bypass.name,
  });
  if (!(await publishProjectZeroTrustRoutingLocked(env, lockedDb, project, null, routingBudget))) {
    return (await getProjectZeroTrustState(lockedDb, project.id))!;
  }
  const row = await updateProjectState(lockedDb, project.id, { effective_protected: false });
  await client.deleteApplication(row.protected_application_id, row.protected_application_name);
  return updateProjectState(lockedDb, project.id, {
    effective_protected: false,
    status: 'ready',
    reconciled_operation: completedProjectOperation(configuration, true),
    protected_application_id: null,
    protected_application_name: null,
    protected_application_audience: null,
    last_error: null,
  });
}

async function reconcileProjectZeroTrustLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  projectId: string,
  options?: ProjectReconciliationOptions,
): Promise<ProjectZeroTrust> {
  const saved = await readZeroTrustConfigurationStrict(lockedDb);
  const configuration = options?.configuration ?? saved;
  if (
    !saved ||
    !configuration ||
    !saved.enabled ||
    !saved.wildcardApplication ||
    saved.operation?.kind === 'disable' ||
    (!options?.configuration && !savedConfigurationAllows(saved, options)) ||
    (options?.configuration && !sameConfiguration(configuration, saved))
  ) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is not enabled on this platform.');
  }
  const project = await getProject(lockedDb, projectId);
  if (!project || project.status === 'deleting') {
    throw new ZeroTrustUnavailableError('Project is unavailable.');
  }
  let row = await getProjectZeroTrustState(lockedDb, projectId);
  if (!row) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is still being initialized.');
  }
  const client = options?.client ?? (await clientForConfiguration(env, configuration));
  const destinations = await projectDestinations(env, lockedDb, project, row.desired_protected);

  try {
    if (!row.desired_protected) {
      return await reconcilePublicProjectLocked(
        env,
        lockedDb,
        project,
        row,
        destinations.platform,
        client,
        configuration,
        options?.routingBudget,
      );
    }

    let protectedApplication: ManagedAccessApplication | null = null;
    if (destinations.custom.length > 0) {
      if (!row.protected_application_name) {
        throw new Error('The project protected application checkpoint is missing.');
      }
      protectedApplication = await client.ensureApplication(
        {
          name: row.protected_application_name,
          destinations: destinations.custom,
          allowedIdentityProviderIds: configuration.identityProviderIds,
          policies: reusablePolicyReferences(configuration.policyIds),
        },
        projectApplicationReference(row, 'protected'),
      );
      row = await updateProjectState(lockedDb, projectId, {
        protected_application_id: protectedApplication.id,
        protected_application_name: protectedApplication.name,
        protected_application_audience: protectedApplication.audience,
      });
    } else if (row.protected_application_id || row.protected_application_name) {
      await client.deleteApplication(row.protected_application_id, row.protected_application_name);
      row = await updateProjectState(lockedDb, projectId, {
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
      });
    }
    if (
      !(await publishProjectZeroTrustRoutingLocked(
        env,
        lockedDb,
        project,
        routingProtection(configuration, protectedApplication),
        options?.routingBudget,
      ))
    ) {
      // Unpublished keys still lack the audience set. Keep the public
      // exception and stay reconciling until every route carries it.
      return (await getProjectZeroTrustState(lockedDb, projectId))!;
    }
    row = await updateProjectState(lockedDb, projectId, { effective_protected: true });
    await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
    return updateProjectState(lockedDb, projectId, {
      effective_protected: true,
      status: 'ready',
      reconciled_operation: completedProjectOperation(configuration, false),
      bypass_application_id: null,
      bypass_application_name: null,
      last_error: null,
    });
  } catch (error) {
    await markProjectError(lockedDb, projectId, error);
    throw error;
  }
}

export async function reconcileProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: ProjectReconciliationOptions,
): Promise<ProjectZeroTrust> {
  const checkpointed = await checkpointProjectReconciliation(env, db, projectId, options);
  const budget = options?.routingBudget;
  if (budget && budget.remaining < requiredRoutingBudget(checkpointed)) {
    // The committed checkpoint keeps this project reconciling for the next batch.
    budget.exhausted = true;
    return checkpointed;
  }
  let reconciliationError: unknown;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    try {
      return await reconcileProjectZeroTrustLocked(env, tx as unknown as Db, projectId, options);
    } catch (error) {
      reconciliationError = error;
      return null;
    }
  });
  if (reconciliationError !== undefined) {
    throw reconciliationError;
  }
  return result!;
}

export async function setProjectZeroTrustProtection(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  protectedProject: boolean,
  options?: Pick<ProjectReconciliationOptions, 'actorUserId'>,
): Promise<ProjectZeroTrust> {
  return reconcileProjectZeroTrust(env, db, projectId, {
    desiredProtection: protectedProject,
    actorUserId: options?.actorUserId,
  });
}

async function ensureProjectBypassLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  status: 'ready' | 'reconciling',
): Promise<ProjectZeroTrust | null> {
  const project = await getProject(lockedDb, projectId);
  const row = await getProjectZeroTrustState(lockedDb, projectId);
  if (!project || project.status === 'deleting' || !row || row.desired_protected) {
    return null;
  }
  if (!row.bypass_application_name) {
    throw new Error('The project public application checkpoint is missing.');
  }
  const destinations = await projectDestinations(env, lockedDb, project, false);
  const bypass = await client.ensureApplication(
    {
      name: row.bypass_application_name,
      destinations: destinations.platform,
      policies: bypassPolicy('Void project is public'),
    },
    projectApplicationReference(row, 'bypass'),
  );
  return putProjectState(lockedDb, project.id, {
    bypass_application_id: bypass.id,
    bypass_application_name: bypass.name,
    desired_protected: false,
    effective_protected: false,
    status,
    last_error: null,
  });
}

/**
 * Public-bypass phase: finish one public project before the wildcard changes.
 * The row then counts as done for this operation, so the projects phase does
 * not repeat its Access and routing writes.
 */
async function reconcilePublicProjectForOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  configuration: ZeroTrustConfiguration,
  client: ZeroTrustCloudflareClient,
  routingBudget: RoutingBudget,
): Promise<ProjectZeroTrust> {
  await checkpointProjectReconciliation(env, db, projectId, { configuration });
  let operationError: unknown;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    if (!sameConfiguration(configuration, await readZeroTrustConfigurationStrict(lockedDb))) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    const project = await getProject(lockedDb, projectId);
    const row = await getProjectZeroTrustState(lockedDb, projectId);
    if (!project || project.status === 'deleting' || !row) {
      throw new ZeroTrustUnavailableError('Project is unavailable.');
    }
    if (row.desired_protected) {
      return row;
    }
    try {
      const destinations = await projectDestinations(env, lockedDb, project, false);
      return await reconcilePublicProjectLocked(
        env,
        lockedDb,
        project,
        row,
        destinations.platform,
        client,
        configuration,
        routingBudget,
      );
    } catch (error) {
      await markProjectError(lockedDb, projectId, error);
      operationError = error;
      return null;
    }
  });
  if (operationError !== undefined) {
    throw operationError;
  }
  return result!;
}

/**
 * Initial protection for a project that has no row yet. Projects that existed
 * when an enabling configure operation started follow its existing-project
 * choice; every later project follows the default for new projects.
 */
function initialProjectProtection(
  configuration: ZeroTrustConfiguration,
  project: Pick<Project, 'created_at'>,
): boolean {
  const operation = configuration.operation;
  return operation?.kind === 'configure' &&
    operation.existingProjects !== null &&
    Date.parse(project.created_at) <= Date.parse(operation.startedAt)
    ? operation.existingProjects === 'protected'
    : configuration.protectNewProjects;
}

/** A running configure operation may start before the project exists or be seeded later. */
function initializesProjectZeroTrust(configuration: ZeroTrustConfiguration | null): boolean {
  return (
    !!configuration &&
    configuration.operation?.kind !== 'disable' &&
    (configuration.enabled || configuration.operation?.kind === 'configure')
  );
}

export async function initializeNewProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<ProjectZeroTrust | null> {
  if (!initializesProjectZeroTrust(await readZeroTrustConfigurationStrict(db))) {
    return null;
  }
  // Operation heartbeats advance the saved revision. Decide from the
  // configuration read under the lock, never from the unlocked snapshot above.
  const initialized = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    const project = await getProject(lockedDb, projectId);
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!project || project.status === 'deleting') {
      throw new ZeroTrustUnavailableError('Project is unavailable.');
    }
    if (!saved || !initializesProjectZeroTrust(saved)) {
      return null;
    }
    // Project creation commits before this initializer runs. A platform batch
    // may already have seeded or reconciled it, including its ownership handles.
    const existing = await getProjectZeroTrustState(lockedDb, projectId);
    if (existing) {
      return { row: existing, created: false };
    }
    const desired = initialProjectProtection(saved, project);
    // A new protected project has no route or custom domain yet, so the
    // wildcard alone settles it when no operation is running.
    const settled = desired && !!saved.wildcardApplication && !saved.operation;
    return {
      row: await putProjectState(lockedDb, projectId, {
        desired_protected: desired,
        effective_protected: settled,
        status: settled ? 'ready' : 'reconciling',
        ...(!desired
          ? { bypass_application_name: await applicationName(env, `public-${project.id}`) }
          : {}),
      }),
      created: true,
    };
  });
  if (!initialized) {
    return null;
  }
  const { row } = initialized;
  if (!initialized.created || row.desired_protected) {
    return row;
  }
  let bypassError: unknown;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!saved || !initializesProjectZeroTrust(saved)) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration changed.');
    }
    try {
      // A running operation still owns this row; its batch finishes the transition.
      return await ensureProjectBypassLocked(
        env,
        lockedDb,
        projectId,
        await clientForConfiguration(env, saved),
        saved.operation ? 'reconciling' : 'ready',
      );
    } catch (error) {
      await markProjectError(lockedDb, projectId, error);
      bypassError = error;
      return null;
    }
  });
  if (bypassError !== undefined) {
    throw bypassError;
  }
  return result;
}

type ProjectCandidate = Readonly<{ project: Project }>;

function candidateQuery(db: Db) {
  return db
    .select({ project: projects })
    .from(projects)
    .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id));
}

async function seedCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  initial: boolean,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  const missing = isNull(projectZeroTrust.project_id);
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        initial
          ? and(
              lte(projects.created_at, operation.startedAt),
              or(missing, lt(projectZeroTrust.updated_at, operation.startedAt)),
            )
          : missing,
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

/** Marks a project this operation skipped after a project-specific failure. */
function skippedOperationKey(operation: ZeroTrustOperation): string {
  return `skipped:${operation.id}`;
}

/**
 * A project skipped by this operation keeps its error for the scheduled
 * per-project retry. Selecting it again would stall the operation. Failures
 * that stop the whole operation leave no marker, so a resumed run retries them.
 */
function notSkippedByOperation(operation: ZeroTrustOperation) {
  return sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${skippedOperationKey(operation)}`;
}

async function publicBypassCandidates(
  db: Db,
  limit: number,
  operation: ZeroTrustOperation,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        eq(projectZeroTrust.desired_protected, false),
        notSkippedByOperation(operation),
        or(
          isNull(projectZeroTrust.bypass_application_id),
          sql`${projectZeroTrust.status} <> 'ready'`,
          ...(operation.applicationTarget
            ? [lt(projectZeroTrust.updated_at, operation.startedAt)]
            : []),
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

async function reconciliationCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        notSkippedByOperation(operation),
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${operation.id}`,
          sql`${projectZeroTrust.status} <> 'ready'`,
          sql`${projectZeroTrust.desired_protected} <> ${projectZeroTrust.effective_protected}`,
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

async function disableCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        notSkippedByOperation(operation),
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${operation.id}`,
          eq(projectZeroTrust.effective_protected, true),
          eq(projectZeroTrust.desired_protected, true),
          sql`${projectZeroTrust.status} <> 'ready'`,
          sql`${projectZeroTrust.protected_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.protected_application_name} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

async function bypassCleanupCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        notSkippedByOperation(operation),
        or(
          sql`${projectZeroTrust.bypass_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.bypass_application_name} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

async function setInitialProjectProtection(
  db: Db,
  projectId: string,
  protectedProject: boolean,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    if (!sameConfiguration(configuration, await readZeroTrustConfigurationStrict(lockedDb))) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    const project = await getProject(lockedDb, projectId);
    if (!project || project.status === 'deleting') {
      return;
    }
    await putProjectState(lockedDb, projectId, {
      desired_protected: protectedProject,
      status: 'reconciling',
      last_error: null,
    });
  });
}

function leaseExpiresAt(): string {
  return new Date(Date.now() + OPERATION_LEASE_MS).toISOString();
}

function leaseActive(operation: ZeroTrustOperation): boolean {
  const expiry = operation.leaseExpiresAt ? Date.parse(operation.leaseExpiresAt) : Number.NaN;
  return operation.owner !== null && Number.isFinite(expiry) && expiry > Date.now();
}

async function operationStartedAt(db: DbOrTx): Promise<string> {
  // Project timestamps are stored without a time zone. Use their database clock,
  // rather than a Worker clock/UTC literal that may compare in a different zone.
  const result = await db.execute<{ startedAt: string }>(
    sql`SELECT now()::timestamp::text AS "startedAt"`,
  );
  return result.rows[0]!.startedAt;
}

/**
 * Claim the installation operation under the exclusive lock. A resumed
 * operation keeps its id; a new one gets a fresh id from the claim callback.
 */
async function claimConfiguration(
  db: Db,
  claim: (
    current: ZeroTrustConfiguration | null,
    owner: string,
    startedAt: string,
  ) => ZeroTrustConfiguration | Promise<ZeroTrustConfiguration>,
): Promise<ZeroTrustConfiguration> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`);
    const current = await readZeroTrustConfigurationStrict(tx);
    if (current?.operation && leaseActive(current.operation)) {
      throw new ZeroTrustUnavailableError('Another Zero Trust operation is already running.');
    }
    const configuration = await claim(current, crypto.randomUUID(), await operationStartedAt(tx));
    await writeZeroTrustConfiguration(tx, configuration);
    return configuration;
  });
}

async function patchConfiguration(
  db: Db,
  current: ZeroTrustConfiguration,
  values: Partial<ZeroTrustConfiguration>,
): Promise<ZeroTrustConfiguration> {
  const next: ZeroTrustConfiguration = {
    ...current,
    ...values,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  if (!(await replaceZeroTrustConfiguration(db, current.revision, next))) {
    throw new ZeroTrustUnavailableError('A newer Zero Trust operation replaced this request.');
  }
  return next;
}

async function heartbeatConfiguration(
  db: Db,
  current: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  if (!current.operation?.owner) {
    throw new ZeroTrustUnavailableError('The Zero Trust operation lease was lost.');
  }
  return patchConfiguration(db, current, {
    operation: { ...current.operation, leaseExpiresAt: leaseExpiresAt() },
  });
}

async function advanceOperation(
  db: Db,
  current: ZeroTrustConfiguration,
  phase: ZeroTrustOperation['phase'],
  values: Partial<ZeroTrustConfiguration> = {},
): Promise<ZeroTrustConfiguration> {
  if (!current.operation?.owner) {
    throw new ZeroTrustUnavailableError('The Zero Trust operation lease was lost.');
  }
  return patchConfiguration(db, current, {
    ...values,
    operation: { ...current.operation, phase, leaseExpiresAt: leaseExpiresAt() },
  });
}

async function releaseOperation(
  db: Db,
  current: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  if (!current.operation) {
    return current;
  }
  return patchConfiguration(db, current, {
    operation: { ...current.operation, owner: null, leaseExpiresAt: null },
  });
}

async function failOperation(
  db: Db,
  current: ZeroTrustConfiguration,
  error: unknown,
): Promise<void> {
  await patchConfiguration(db, current, {
    lastError: errorMessage(error),
    operation: current.operation
      ? { ...current.operation, owner: null, leaseExpiresAt: null }
      : null,
  }).catch(() => undefined);
}

function isDeletedProject(error: unknown): boolean {
  return error instanceof ZeroTrustUnavailableError && error.message === 'Project is unavailable.';
}

/** Credential, rate-limit and provider outages affect every project; the whole operation retries. */
function isOperationWideFailure(error: unknown): boolean {
  if (error instanceof ZeroTrustCloudflareError) {
    return (
      error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500
    );
  }
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

/**
 * Record a project failure and let the operation continue. The row keeps a
 * skip marker so later batches pass over it; scheduled per-project maintenance
 * retries it after the operation finishes. Failed protection stays effective
 * or denied: this never marks a project public.
 */
async function skipFailedProject(
  db: Db,
  projectId: string,
  configuration: ZeroTrustConfiguration & { operation: ZeroTrustOperation },
  error: unknown,
): Promise<void> {
  const reconciledOperation = skippedOperationKey(configuration.operation);
  const lastError = errorMessage(error);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const project = await getProject(tx as unknown as Db, projectId);
    if (!project || project.status === 'deleting') {
      return;
    }
    await tx
      .insert(projectZeroTrust)
      .values({
        project_id: projectId,
        desired_protected:
          configuration.operation.kind !== 'disable' &&
          initialProjectProtection(configuration, project),
        effective_protected: false,
        status: 'error',
        reconciled_operation: reconciledOperation,
        last_error: lastError,
      })
      .onConflictDoUpdate({
        target: projectZeroTrust.project_id,
        set: {
          status: 'error',
          reconciled_operation: reconciledOperation,
          last_error: lastError,
          updated_at: sql`now()`,
        },
      });
  });
  console.error('[zero-trust] installation operation skipped a failed project', {
    projectId,
    error,
  });
}

/** Run one project's work inside an installation batch; only operation-wide failures escape. */
async function runOperationProjectStep(
  db: Db,
  configuration: ZeroTrustConfiguration,
  projectId: string,
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (isDeletedProject(error)) {
      return;
    }
    const operation = configuration.operation;
    if (
      !operation ||
      isOperationWideFailure(error) ||
      !sameConfiguration(configuration, await readZeroTrustConfigurationStrict(db))
    ) {
      throw error;
    }
    await skipFailedProject(db, projectId, { ...configuration, operation }, error);
  }
}

async function withZeroTrustOperationLock(
  db: Db,
  configuration: ZeroTrustConfiguration,
  mutate: (lockedDb: Db) => Promise<ZeroTrustConfiguration>,
): Promise<ZeroTrustConfiguration> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`);
    const saved = await readZeroTrustConfigurationStrict(tx);
    if (!sameConfiguration(configuration, saved) || !saved.operation?.owner) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    // The provider write and its checkpoint share the claim lock. A CAS after
    // the provider call alone cannot stop a stale request restoring old policy
    // or deleting the application used by a newer operation.
    return mutate(tx as unknown as Db);
  });
}

async function completeConfigureOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  configuration: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`);
    const saved = await readZeroTrustConfigurationStrict(tx);
    if (!sameConfiguration(configuration, saved) || !saved.operation) {
      throw new ZeroTrustUnavailableError('A newer Zero Trust operation replaced this request.');
    }
    // Project mutation/deployment holds the shared lock. Recheck under its exclusive
    // counterpart so the final publication cannot overtake an in-flight reconciliation.
    if ((await reconciliationCandidates(tx as unknown as Db, saved.operation, 1)).length) {
      return null;
    }
    if (saved.operation.applicationTarget) {
      const application = saved.operation.applicationTarget;
      await setPlatformSetting(tx, PLATFORM_APPLICATION_SETTING, application);
      await env.ROUTING.put(PLATFORM_APPLICATION_KEY, JSON.stringify(application));
    }
    return patchConfiguration(tx as unknown as Db, saved, {
      operation: null,
      lastError: null,
    });
  });
}

/** The installer calls this only after DNS, token permissions and HTTPS are verified. */
export async function activatePlatformApplication(
  env: ApiEnv['Bindings'],
  db: Db,
  value: PlatformApplication,
): Promise<{ ready: boolean }> {
  const target = parseZeroTrustApplicationTarget(value);
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`);
    const current = await readZeroTrustConfigurationStrict(tx);
    const currentEnv = await resolveZeroTrustApplicationEnvironment(env, tx, current);
    applicationTargetEnvironment(currentEnv, target);
    if (current?.operation) {
      if (
        !current.operation.applicationTarget ||
        JSON.stringify(current.operation.applicationTarget) !== JSON.stringify(target)
      ) {
        throw new ZeroTrustUnavailableError(
          'Finish the saved Zero Trust operation before adding this domain.',
        );
      }
      if (leaseActive(current.operation)) {
        return { ready: false, configuration: null };
      }
    } else {
      const completed = await getPlatformSetting(tx, PLATFORM_APPLICATION_SETTING);
      if (
        !current?.enabled ||
        (completed &&
          JSON.stringify(parseZeroTrustApplicationTarget(completed)) === JSON.stringify(target))
      ) {
        await setPlatformSetting(tx, PLATFORM_APPLICATION_SETTING, target);
        await env.ROUTING.put(PLATFORM_APPLICATION_KEY, JSON.stringify(target));
        return { ready: true, configuration: null };
      }
    }
    if (!current) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration is unavailable.');
    }
    assertWildcardExcludesControlPlane(env, zeroTrustWildcardDestinations(target));
    const now = new Date().toISOString();
    const configuration: ZeroTrustConfiguration = {
      ...current,
      revision: current.revision + 1,
      operation: {
        ...(current.operation ?? {
          id: crypto.randomUUID(),
          kind: 'reconcile' as const,
          phase: 'seed' as const,
          startedAt: await operationStartedAt(tx),
          existingProjects: null,
          applicationTarget: target,
        }),
        owner: crypto.randomUUID(),
        leaseExpiresAt: leaseExpiresAt(),
      },
      lastError: null,
      updatedAt: now,
    };
    await writeZeroTrustConfiguration(tx, configuration);
    return { ready: false, configuration };
  });
  if (!claim.configuration) {
    return { ready: claim.ready };
  }
  const completed = await runConfigureOperation(env, db, claim.configuration);
  return { ready: completed.operation === null };
}

async function runConfigureOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  initial: ZeroTrustConfiguration,
  suppliedClient?: ZeroTrustCloudflareClient,
  suppliedSelection?: { teamDomain: string },
): Promise<ZeroTrustConfiguration> {
  let configuration = initial;
  let projectsProcessed = 0;
  const routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  try {
    env = await resolveZeroTrustApplicationEnvironment(env, db, configuration);
    const client = suppliedClient ?? (await clientForConfiguration(env, configuration));
    const selection =
      suppliedSelection ??
      (await client.validateSelection({
        identityProviderIds: configuration.identityProviderIds,
        policyIds: configuration.policyIds,
      }));
    if (selection.teamDomain !== configuration.teamDomain) {
      configuration = await patchConfiguration(db, configuration, {
        teamDomain: selection.teamDomain,
      });
    }

    while (configuration.operation && configuration.operation.kind !== 'disable') {
      const operation = configuration.operation;
      if (operation.phase === 'seed') {
        if (operation.existingProjects) {
          const existing = await seedCandidates(
            db,
            operation,
            true,
            MAX_PROJECTS_PER_RUN - projectsProcessed,
          );
          for (const candidate of existing) {
            await setInitialProjectProtection(
              db,
              candidate.project.id,
              initialProjectProtection(configuration, candidate.project),
              configuration,
            );
            projectsProcessed += 1;
            configuration = await heartbeatConfiguration(db, configuration);
          }
          if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
            return releaseOperation(db, configuration);
          }
        }
        const missing = await seedCandidates(
          db,
          operation,
          false,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        for (const candidate of missing) {
          await setInitialProjectProtection(
            db,
            candidate.project.id,
            initialProjectProtection(configuration, candidate.project),
            configuration,
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
        }
        if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        configuration = await advanceOperation(
          db,
          configuration,
          configuration.wildcardApplication && !operation.applicationTarget
            ? 'wildcard'
            : 'public-bypasses',
        );
        continue;
      }

      if (operation.phase === 'public-bypasses') {
        const candidates = await publicBypassCandidates(
          db,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
          operation,
        );
        for (const candidate of candidates) {
          const batch = configuration;
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            reconcilePublicProjectForOperation(
              env,
              db,
              candidate.project.id,
              batch,
              client,
              routingBudget,
            ),
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (routingBudget.exhausted || routingBudget.remaining === 0) {
            return releaseOperation(db, configuration);
          }
        }
        if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        configuration = await advanceOperation(db, configuration, 'wildcard');
        continue;
      }

      if (operation.phase === 'wildcard') {
        const name = configuration.wildcardApplicationName;
        configuration = await withZeroTrustOperationLock(db, configuration, async (lockedDb) => {
          const wildcard = await client.ensureApplication(
            {
              name,
              destinations: zeroTrustWildcardDestinations(readPlatformApplication(env)),
              allowedIdentityProviderIds: configuration.identityProviderIds,
              policies: reusablePolicyReferences(configuration.policyIds),
            },
            { id: configuration.wildcardApplication?.id, name },
          );
          return advanceOperation(lockedDb, configuration, 'projects', {
            enabled: true,
            wildcardApplication: wildcard,
            lastError: null,
          });
        });
        continue;
      }

      if (operation.phase === 'projects') {
        const candidates = await reconciliationCandidates(
          db,
          operation,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        if (candidates.length === 0) {
          const completed = await completeConfigureOperation(env, db, configuration);
          if (completed) {
            return completed;
          }
          continue;
        }
        let stoppedForRoutingBudget = false;
        for (const candidate of candidates) {
          const batch = configuration;
          // The budget check runs after the project checkpoint, which may
          // create the row or change its intent.
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            reconcileProjectZeroTrust(env, db, candidate.project.id, {
              configuration: batch,
              client,
              routingBudget,
            }),
          );
          if (routingBudget.exhausted) {
            stoppedForRoutingBudget = true;
            break;
          }
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
            break;
          }
        }
        if (stoppedForRoutingBudget || projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        continue;
      }

      throw new Error(`Invalid configure operation phase: ${operation.phase}`);
    }
    throw new Error('The Zero Trust configure operation was replaced.');
  } catch (error) {
    await failOperation(db, configuration, error);
    throw error;
  }
}

async function disableProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  routingBudget: RoutingBudget,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  let operationError: unknown;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!sameConfiguration(configuration, saved) || saved.operation?.kind !== 'disable') {
      throw new ZeroTrustUnavailableError('The Zero Trust disable operation was replaced.');
    }
    try {
      const project = await getProject(lockedDb, projectId);
      if (!project || project.status === 'deleting') {
        return;
      }
      const row = await getProjectZeroTrustState(lockedDb, projectId);
      // Record public intent before any routing write. Partial pages and caught
      // provider failures commit this checkpoint, so later metadata writes cannot
      // restore protection behind the cleanup cursor. Unvisited projects retain
      // their existing protection until their own disable batch starts.
      await putProjectState(lockedDb, projectId, {
        desired_protected: false,
        status: 'reconciling',
        // Replay older partial checkpoints that still recorded protected intent;
        // readers may have restored protection to keys before their saved cursor.
        ...(row?.desired_protected ? { routing_cursor: null } : {}),
      });
      if (
        !(await publishProjectZeroTrustRoutingLocked(env, lockedDb, project, null, routingBudget))
      ) {
        return;
      }
      if (row) {
        await client.deleteApplication(
          row.protected_application_id,
          row.protected_application_name,
        );
      }
      await putProjectState(lockedDb, projectId, {
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        reconciled_operation: saved.operation.id,
        // Public exceptions must outlive the wildcard, including when a later
        // project or wildcard deletion fails. The final phase clears these handles.
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
        last_error: null,
      });
    } catch (error) {
      await markProjectError(lockedDb, projectId, error);
      operationError = error;
    }
  });
  if (operationError !== undefined) {
    throw operationError;
  }
}

async function deleteProjectZeroTrustBypass(
  db: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  let operationError: unknown;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const saved = await readZeroTrustConfigurationStrict(tx);
    if (!sameConfiguration(configuration, saved) || saved.operation?.phase !== 'bypass-delete') {
      throw new ZeroTrustUnavailableError('The Zero Trust disable operation was replaced.');
    }
    const row = await getProjectZeroTrustState(tx, projectId);
    if (!row) {
      return;
    }
    try {
      await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
      await updateProjectState(tx, projectId, {
        bypass_application_id: null,
        bypass_application_name: null,
        status: 'ready',
        last_error: null,
      });
    } catch (error) {
      await markProjectError(tx, projectId, error);
      operationError = error;
    }
  });
  if (operationError !== undefined) {
    throw operationError;
  }
}

async function runDisableOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  initial: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  let configuration = initial;
  let projectsProcessed = 0;
  const routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  try {
    const client = await clientForConfiguration(env, configuration);
    if (configuration.operation?.phase === 'seed') {
      configuration = await advanceOperation(db, configuration, 'projects');
    }
    while (configuration.operation?.kind === 'disable') {
      const operation = configuration.operation;
      if (operation.phase === 'projects') {
        const candidates = await disableCandidates(
          db,
          operation,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        if (candidates.length === 0) {
          configuration = await advanceOperation(db, configuration, 'wildcard-delete');
          continue;
        }
        let stoppedForRoutingBudget = false;
        for (const candidate of candidates) {
          if (routingBudget.remaining < 1) {
            stoppedForRoutingBudget = true;
            break;
          }
          const batch = configuration;
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            disableProjectZeroTrust(env, db, candidate.project.id, client, routingBudget, batch),
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
            break;
          }
        }
        if (stoppedForRoutingBudget || projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        continue;
      }
      if (operation.phase === 'wildcard-delete') {
        configuration = await withZeroTrustOperationLock(db, configuration, async (lockedDb) => {
          // A resumed cleanup must drain late/legacy project work before losing
          // the wildcard checkpoint, including work left by an errored request.
          if ((await disableCandidates(lockedDb, operation, 1)).length > 0) {
            return advanceOperation(lockedDb, configuration, 'projects');
          }
          await client.deleteApplication(
            configuration.wildcardApplication?.id,
            configuration.wildcardApplicationName,
          );
          return advanceOperation(lockedDb, configuration, 'bypass-delete', {
            enabled: false,
            wildcardApplication: null,
            lastError: null,
          });
        });
        continue;
      }
      if (operation.phase === 'bypass-delete') {
        const candidates = await bypassCleanupCandidates(
          db,
          operation,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        for (const candidate of candidates) {
          const batch = configuration;
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            deleteProjectZeroTrustBypass(db, candidate.project.id, client, batch),
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
        }
        if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        configuration = await withZeroTrustOperationLock(db, configuration, async (lockedDb) => {
          // Recheck late project work under the lock used by project mutations
          // before releasing the disable operation and allowing configuration again.
          if ((await disableCandidates(lockedDb, operation, 1)).length > 0) {
            return advanceOperation(lockedDb, configuration, 'projects');
          }
          if ((await bypassCleanupCandidates(lockedDb, operation, 1)).length > 0) {
            return configuration;
          }
          return patchConfiguration(lockedDb, configuration, {
            operation: null,
            lastError: null,
          });
        });
        if (configuration.operation) {
          continue;
        }
        return configuration;
      }
      throw new Error(`Invalid disable operation phase: ${operation.phase}`);
    }
    throw new Error('The Zero Trust disable operation was replaced.');
  } catch (error) {
    await failOperation(db, configuration, error);
    throw error;
  }
}

function wildcardDestinationMatches(pattern: string, hostname: string): boolean {
  // Treat `*` as any non-empty text, including dots. Over-matching only
  // rejects a configuration; under-matching could gate the control plane.
  const expression = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return new RegExp(`^${expression}$`).test(hostname);
}

/**
 * The project wildcard must never cover the API, proxy or email gateway. CLI,
 * webhooks and project Workers call them without an Access session.
 */
function assertWildcardExcludesControlPlane(
  env: ApiEnv['Bindings'],
  destinations: ReadonlyArray<string>,
  requestUrl?: string,
): void {
  const hostnames = new Set<string>();
  for (const url of [requestUrl, env.AUTH_REDIRECT_URI, env.PROXY_URL, env.EMAIL_GATEWAY_ORIGIN]) {
    if (url && URL.canParse(url)) {
      hostnames.add(new URL(url).hostname.toLowerCase());
    }
  }
  for (const hostname of hostnames) {
    const pattern = destinations.find((destination) =>
      wildcardDestinationMatches(destination, hostname),
    );
    if (pattern) {
      throw new ZeroTrustUnavailableError(
        `Project Zero Trust would put the platform control plane (${hostname}) behind the project Access application ${pattern}. Serve the API, proxy and email gateway from hostnames outside the project application domain, then configure Zero Trust again.`,
      );
    }
  }
}

/**
 * The existing-project choice applies only when a configure starts from
 * disabled, or when it resumes such an operation with a replacement token.
 */
export function assertExistingProjectsChoice(
  current: ZeroTrustConfiguration | null,
  input: ZeroTrustConfigureInput,
): void {
  const operation = current?.operation;
  if (operation) {
    if (
      input.existingProjects === undefined ||
      input.existingProjects === operation.existingProjects
    ) {
      return;
    }
    throw new ZeroTrustUnavailableError(
      operation.existingProjects === null
        ? 'The pending Zero Trust operation does not choose protection for existing projects. Configure again without an existing-projects choice.'
        : `The pending Zero Trust operation keeps existing projects ${operation.existingProjects}. Configure again with that choice or without one.`,
    );
  }
  if (!current?.enabled && input.existingProjects === undefined) {
    throw new ZeroTrustUnavailableError(
      'Enabling Zero Trust needs a choice for existing projects: protected or public.',
    );
  }
  if (current?.enabled && input.existingProjects !== undefined) {
    throw new ZeroTrustUnavailableError(
      'Zero Trust is already enabled, so existing projects keep their protection. Omit the existing-projects choice, and change individual projects with `void platform zero-trust project-protect` or `project-public`.',
    );
  }
}

export async function configurePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  input: ZeroTrustConfigureInput,
  options: Readonly<{ requestUrl?: string }> = {},
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  // Zero Trust always uses the Cloudflare account that owns the installation.
  const accountId = env.CF_ACCOUNT_ID;
  env = await resolveZeroTrustApplicationEnvironment(env, db);
  const destinations = zeroTrustWildcardDestinations(readPlatformApplication(env));
  if (destinations.length === 0) {
    throw new ZeroTrustUnavailableError(
      'Project Zero Trust needs a platform domain or workers.dev application hostname.',
    );
  }
  const previous = await readZeroTrustConfigurationStrict(db);
  // Fail before any Cloudflare call; the claim below checks again under the lock.
  assertExistingProjectsChoice(previous, input);
  const replacingDisableCredential = previous?.operation?.kind === 'disable';
  // A disable removes the wildcard, so a replacement credential for it must
  // not be blocked by hostnames that moved under the wildcard afterwards.
  if (!replacingDisableCredential) {
    assertWildcardExcludesControlPlane(env, destinations, options.requestUrl);
  }
  const client = new ZeroTrustCloudflareClient(accountId, input.apiToken);
  // Teardown needs the account credential, not the IdPs/policies being removed.
  // Those selections may themselves have disappeared while cleanup was pending.
  const selection = replacingDisableCredential
    ? await client.getOrganization()
    : await client.validateSelection(input);
  const credential = await encryptPlatformCredential(
    env,
    installationId(env),
    ZERO_TRUST_CREDENTIAL_ID,
    input.apiToken,
  );
  const configuration = await claimConfiguration(db, async (current, owner, startedAt) => {
    if (
      replacingDisableCredential &&
      (current?.revision !== previous.revision || current.operation?.kind !== 'disable')
    ) {
      throw new ZeroTrustUnavailableError(
        'The saved Zero Trust operation changed. Retry configuration.',
      );
    }
    assertExistingProjectsChoice(current, input);
    if (current?.operation) {
      const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
        left.length === right.length && left.every((id) => right.includes(id));
      if (
        current.accountId !== accountId ||
        current.protectNewProjects !== input.protectNewProjects ||
        !sameIds(current.identityProviderIds, input.identityProviderIds) ||
        !sameIds(current.policyIds, input.policyIds)
      ) {
        throw new ZeroTrustUnavailableError(
          'A saved Zero Trust operation is pending. To replace its API token, configure again with the same identity providers, policies, and project selections.',
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        credential,
        teamDomain: selection.teamDomain,
        operation: { ...current.operation, owner, leaseExpiresAt: leaseExpiresAt() },
        lastError: null,
        updatedAt: new Date().toISOString(),
      };
    }
    const now = new Date().toISOString();
    return {
      version: 1,
      revision: (current?.revision ?? 0) + 1,
      enabled: current?.enabled ?? false,
      protectNewProjects: input.protectNewProjects,
      accountId,
      teamDomain: selection.teamDomain,
      identityProviderIds: [...input.identityProviderIds],
      policyIds: [...input.policyIds],
      credential,
      // The name is kept for the installation's lifetime so a retry or a later
      // re-enable can recover the same wildcard application.
      wildcardApplicationName:
        current?.wildcardApplicationName ?? (await applicationName(env, 'project-zero-trust')),
      wildcardApplication: current?.wildcardApplication ?? null,
      operation: {
        id: crypto.randomUUID(),
        kind: 'configure',
        phase: 'seed',
        owner,
        leaseExpiresAt: leaseExpiresAt(),
        startedAt,
        existingProjects: input.existingProjects ?? null,
      },
      lastError: null,
      updatedAt: now,
    };
  });
  return redactedZeroTrustConfiguration(
    configuration.operation?.kind === 'disable'
      ? await runDisableOperation(env, db, configuration)
      : await runConfigureOperation(env, db, configuration, client, selection),
  );
}

async function claimReconcileOperation(db: Db): Promise<ZeroTrustConfiguration> {
  return claimConfiguration(db, (current, owner, startedAt) => {
    if (!current) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not configured.');
    }
    const now = new Date().toISOString();
    if (current.operation) {
      return {
        ...current,
        revision: current.revision + 1,
        operation: {
          ...current.operation,
          owner,
          leaseExpiresAt: leaseExpiresAt(),
        },
        lastError: null,
        updatedAt: now,
      };
    }
    if (!current.enabled) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not enabled.');
    }
    return {
      ...current,
      revision: current.revision + 1,
      operation: {
        id: crypto.randomUUID(),
        kind: 'reconcile',
        phase: 'seed',
        owner,
        leaseExpiresAt: leaseExpiresAt(),
        startedAt,
        existingProjects: null,
      },
      lastError: null,
      updatedAt: now,
    };
  });
}

export async function reconcilePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  const configuration = await claimReconcileOperation(db);
  const result =
    configuration.operation?.kind === 'disable'
      ? await runDisableOperation(env, db, configuration)
      : await runConfigureOperation(env, db, configuration);
  return redactedZeroTrustConfiguration(result);
}

export async function disablePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  const saved = await readZeroTrustConfigurationStrict(db);
  if (!saved) {
    return redactedZeroTrustConfiguration(null);
  }
  if (!saved.enabled && !saved.operation) {
    return redactedZeroTrustConfiguration(saved);
  }
  const configuration = await claimConfiguration(db, (current, owner, startedAt) => {
    if (!current) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not configured.');
    }
    const now = new Date().toISOString();
    return {
      ...current,
      revision: current.revision + 1,
      operation:
        current.operation?.kind === 'disable'
          ? { ...current.operation, owner, leaseExpiresAt: leaseExpiresAt() }
          : {
              id: crypto.randomUUID(),
              kind: 'disable',
              phase: 'seed',
              owner,
              leaseExpiresAt: leaseExpiresAt(),
              startedAt,
              existingProjects: null,
            },
      lastError: null,
      updatedAt: now,
    };
  });
  return redactedZeroTrustConfiguration(await runDisableOperation(env, db, configuration));
}

/**
 * Installation status from saved state. `check` also asks Cloudflare whether
 * the account, selections, and wildcard application still match; it makes
 * several Access API calls, so reads leave it off unless an operator asks.
 */
export async function zeroTrustStatus(
  env: ApiEnv['Bindings'],
  db: Db,
  options: Readonly<{ check?: boolean }> = {},
) {
  const groups = await db
    .select({
      desiredProtected: projectZeroTrust.desired_protected,
      effectiveProtected: projectZeroTrust.effective_protected,
      status: projectZeroTrust.status,
      count: sql<number>`count(*)::int`,
    })
    .from(projectZeroTrust)
    .groupBy(
      projectZeroTrust.desired_protected,
      projectZeroTrust.effective_protected,
      projectZeroTrust.status,
    );
  const projectCounts = groups.map(({ desiredProtected, effectiveProtected, status, count }) => ({
    desiredProtected,
    effectiveProtected,
    state: projectZeroTrustState({ status, desired_protected: desiredProtected }),
    count,
  }));
  let configuration: ZeroTrustConfiguration | null;
  try {
    configuration = await readZeroTrustConfigurationStrict(db);
  } catch (error) {
    if (!(error instanceof ZeroTrustConfigurationError)) {
      throw error;
    }
    return {
      configured: true,
      enabled: false,
      status: 'invalid_configuration' as const,
      lastError: error.message,
      checked: false,
      live: null,
      projects: projectCounts,
    };
  }
  const checked =
    !!options.check && !!configuration?.enabled && !!configuration.wildcardApplication;
  let live: { present: boolean; drifted: boolean } | null = null;
  if (checked && configuration?.wildcardApplication) {
    try {
      env = await resolveZeroTrustApplicationEnvironment(env, db, configuration);
      const client = await clientForConfiguration(env, configuration);
      const selection = await client.validateSelection({
        identityProviderIds: configuration.identityProviderIds,
        policyIds: configuration.policyIds,
      });
      live = await client.inspectApplication(configuration.wildcardApplication, {
        name: configuration.wildcardApplicationName,
        destinations: zeroTrustWildcardDestinations(readPlatformApplication(env)),
        allowedIdentityProviderIds: configuration.identityProviderIds,
        policies: reusablePolicyReferences(configuration.policyIds),
      });
      if (selection.teamDomain !== configuration.teamDomain) {
        live = { ...live, drifted: true };
      }
    } catch (error) {
      live = { present: false, drifted: true };
      console.error('[zero-trust] live status check failed', error);
    }
  }
  return {
    ...redactedZeroTrustConfiguration(configuration),
    checked,
    live,
    projects: projectCounts,
  };
}

export async function cleanupProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<void> {
  const [configuration, row] = await Promise.all([
    readZeroTrustConfigurationStrict(db),
    getProjectZeroTrustState(db, projectId),
  ]);
  if (
    !row ||
    (!row.bypass_application_id &&
      !row.bypass_application_name &&
      !row.protected_application_id &&
      !row.protected_application_name)
  ) {
    return;
  }
  if (!configuration) {
    throw new ZeroTrustUnavailableError(
      'Zero Trust configuration is unavailable; managed Access applications cannot be safely deleted.',
    );
  }
  const client = await clientForConfiguration(env, configuration);
  await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
  await client.deleteApplication(row.protected_application_id, row.protected_application_name);
}

export async function reconcileProjectZeroTrustDomains(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<ProjectZeroTrust | null> {
  const [configuration, row] = await Promise.all([
    readZeroTrustConfigurationStrict(db),
    getProjectZeroTrustState(db, projectId),
  ]);
  if (!configuration?.enabled || configuration.operation?.kind === 'disable' || !row) {
    return row;
  }
  // Operation heartbeats advance the saved revision, so this unlocked read
  // only filters. Reconciliation uses the configuration saved under the lock.
  return reconcileProjectZeroTrust(env, db, projectId, { duringOperation: true });
}

/** Clear protection left on a project after the installation finished disabling. */
async function retireDisabledProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  routingBudget: RoutingBudget,
): Promise<void> {
  let retirementError: unknown;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!saved || saved.enabled || saved.operation) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration changed.');
    }
    const project = await getProject(lockedDb, projectId);
    const row = await getProjectZeroTrustState(lockedDb, projectId);
    if (!project || project.status === 'deleting' || !row) {
      return;
    }
    try {
      await putProjectState(lockedDb, projectId, {
        desired_protected: false,
        status: 'reconciling',
        ...(row.desired_protected ? { routing_cursor: null } : {}),
      });
      if (
        !(await publishProjectZeroTrustRoutingLocked(env, lockedDb, project, null, routingBudget))
      ) {
        routingBudget.exhausted = true;
        return;
      }
      // The wildcard is gone, so neither exception application still guards anything.
      await client.deleteApplication(row.protected_application_id, row.protected_application_name);
      await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
      await updateProjectState(lockedDb, projectId, {
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
        bypass_application_id: null,
        bypass_application_name: null,
        last_error: null,
      });
    } catch (error) {
      await markProjectError(lockedDb, projectId, error);
      retirementError = error;
    }
  });
  if (retirementError !== undefined) {
    throw retirementError;
  }
}

async function retirePendingDisabledProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  configuration: ZeroTrustConfiguration,
  limit: number,
): Promise<void> {
  const rows = await candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        or(
          sql`${projectZeroTrust.status} <> 'ready'`,
          eq(projectZeroTrust.desired_protected, true),
          eq(projectZeroTrust.effective_protected, true),
          sql`${projectZeroTrust.protected_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.protected_application_name} IS NOT NULL`,
          sql`${projectZeroTrust.bypass_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.bypass_application_name} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(projectZeroTrust.updated_at, projects.created_at)
    .limit(limit);
  if (rows.length === 0) {
    return;
  }
  const client = await clientForConfiguration(env, configuration);
  const routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  for (const row of rows) {
    if (routingBudget.exhausted || routingBudget.remaining < 1) {
      break;
    }
    await retireDisabledProjectZeroTrust(env, db, row.project.id, client, routingBudget).catch(
      (error) =>
        console.error('[zero-trust] scheduled project cleanup failed', {
          projectId: row.project.id,
          error,
        }),
    );
  }
}

export async function reconcilePendingProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  limit = 20,
): Promise<void> {
  const configuration = await readZeroTrustConfigurationStrict(db);
  if (!configuration) {
    return;
  }
  if (configuration.operation) {
    // The hourly tier also retries an operation that failed; the fast tier does not.
    await resumePlatformZeroTrustOperation(env, db, { saved: configuration, retryFailed: true });
    return;
  }
  if (!configuration.enabled) {
    // Projects skipped by a completed disable operation still hold protection.
    await retirePendingDisabledProjectZeroTrust(env, db, configuration, limit);
    return;
  }
  if (zeroTrustConfigurationStatus(configuration) !== 'ready') {
    return;
  }
  const rows = await candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        or(isNull(projectZeroTrust.project_id), sql`${projectZeroTrust.status} <> 'ready'`),
      ),
    )
    .orderBy(projectZeroTrust.updated_at, projects.created_at)
    .limit(limit);
  if (rows.length === 0) {
    return;
  }
  const client = await clientForConfiguration(env, configuration);
  const routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  for (const row of rows) {
    if (
      routingBudget.exhausted ||
      routingBudget.remaining < MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT + 1
    ) {
      break;
    }
    await reconcileProjectZeroTrust(env, db, row.project.id, {
      configuration,
      client,
      routingBudget,
    }).catch(async (error) => {
      console.error('[zero-trust] scheduled project reconciliation failed', {
        projectId: row.project.id,
        error,
      });
      // A checkpoint failure rolls back without touching the row. Record it
      // so the row moves behind other pending rows in the next run.
      await markPendingProjectError(db, row.project.id, error).catch((markError) =>
        console.error('[zero-trust] could not record scheduled reconciliation failure', {
          projectId: row.project.id,
          error: markError,
        }),
      );
    });
  }
}

/**
 * Resume an installation operation whose lease is free. Returns true only when
 * a batch ran to its checkpoint; a batch that throws is recorded on the
 * operation and does not own the scheduled invocation. The fast tier leaves a
 * failed operation to the hourly tier or an explicit reconcile, so a
 * persistent failure is not retried every two minutes.
 */
export async function resumePlatformZeroTrustOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  options: Readonly<{ saved?: ZeroTrustConfiguration; retryFailed?: boolean }> = {},
): Promise<boolean> {
  const configuration = options.saved ?? (await readZeroTrustConfigurationStrict(db));
  if (
    !configuration?.operation ||
    leaseActive(configuration.operation) ||
    (zeroTrustConfigurationStatus(configuration) === 'error' && !options.retryFailed)
  ) {
    return false;
  }
  await reconcilePlatformZeroTrust(env, db);
  return true;
}
