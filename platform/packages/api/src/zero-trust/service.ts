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
import { ZeroTrustCloudflareClient, bypassPolicy, reusablePolicyReferences } from './cloudflare.ts';
import {
  ZERO_TRUST_CREDENTIAL_ID,
  type ManagedAccessApplication,
  type ZeroTrustConfiguration,
  ZeroTrustConfigurationError,
  type ZeroTrustConfigureInput,
  type ZeroTrustOperation,
  parseZeroTrustApplicationTarget,
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
      state: 'reconciling',
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

type PublicProjectZeroTrustState = Readonly<
  Pick<
    ProjectZeroTrust,
    | 'project_id'
    | 'desired_protected'
    | 'effective_protected'
    | 'state'
    | 'last_error'
    | 'updated_at'
  >
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
    state: row.state,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

/** Project protection can change only on a ready installation with no running operation. */
export function projectZeroTrustAvailable(configuration: ZeroTrustConfiguration | null): boolean {
  return (
    !!configuration?.enabled &&
    configuration.status === 'ready' &&
    !configuration.operation &&
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
      (!row.bypass_application_id || (!allowReconcilingPublic && row.state !== 'public'))
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

/** Read current protection inside the caller's project-row transaction before publishing KV. */
export async function resolveProjectZeroTrustRoutingForPublication(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectZeroTrustRouting | null> {
  try {
    // A durable bypass makes PUBLIC intent safe even while paginated cleanup
    // is unfinished. Reintroducing a deny marker behind its routing cursor
    // would strand already-completed keys. Deploys retain the stricter gate.
    return await readProjectZeroTrustRouting(db, projectId, true);
  } catch (error) {
    if (
      error instanceof ZeroTrustUnavailableError ||
      error instanceof ZeroTrustConfigurationError
    ) {
      // Metadata rewrites must remain possible during recovery. An empty
      // audience set makes dispatch deny access until reconciliation finishes.
      return { teamDomain: '', audiences: [] };
    }
    throw error;
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
    ...(!complete ? { state: 'reconciling' as const } : {}),
  });
  return complete;
}

async function markProjectError(db: DbOrTx, projectId: string, error: unknown): Promise<void> {
  await db
    .update(projectZeroTrust)
    .set({ state: 'error', last_error: errorMessage(error), updated_at: sql`now()` })
    .where(eq(projectZeroTrust.project_id, projectId));
}

function sameConfiguration(
  expected: ZeroTrustConfiguration,
  current: ZeroTrustConfiguration | null,
): current is ZeroTrustConfiguration {
  return (
    current !== null &&
    current.revision === expected.revision &&
    current.status === expected.status &&
    current.operation?.owner === expected.operation?.owner &&
    current.wildcardApplication?.id === expected.wildcardApplication?.id
  );
}

function operationCompletionKey(operation: ZeroTrustOperation): string {
  return operation.id ?? `${operation.kind}:${operation.startedAt}`;
}

function completedProjectOperation(configuration: ZeroTrustConfiguration): string | null {
  const operation = configuration.operation;
  return operation?.phase === 'projects' && operation.kind !== 'disable'
    ? operationCompletionKey(operation)
    : null;
}

async function checkpointProjectReconciliation(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: {
    configuration?: ZeroTrustConfiguration;
    desiredProtection?: boolean;
  },
): Promise<ProjectZeroTrust> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
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
      (!options?.configuration &&
        (!saved?.enabled || saved.status !== 'ready' || !saved.wildcardApplication))
    ) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not ready on this platform.');
    }
    const existing = await getProjectZeroTrustState(lockedDb, projectId);
    const desired =
      options?.desiredProtection ?? existing?.desired_protected ?? configuration.protectNewProjects;
    const destinations = await projectDestinations(env, lockedDb, project, desired);
    const values: Partial<typeof projectZeroTrust.$inferInsert> = {
      desired_protected: desired,
      state: 'reconciling',
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

async function reconcileProjectZeroTrustLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  projectId: string,
  options?: {
    configuration?: ZeroTrustConfiguration;
    client?: ZeroTrustCloudflareClient;
    routingBudget?: { remaining: number };
  },
): Promise<ProjectZeroTrust> {
  const saved = await readZeroTrustConfigurationStrict(lockedDb);
  const configuration = options?.configuration ?? saved;
  if (
    !saved ||
    !configuration ||
    !saved.enabled ||
    !saved.wildcardApplication ||
    saved.operation?.kind === 'disable' ||
    (!options?.configuration && saved.status !== 'ready') ||
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
      if (!row.bypass_application_name) {
        throw new Error('The project public application checkpoint is missing.');
      }
      const bypass = await client.ensureApplication(
        {
          name: row.bypass_application_name,
          destinations: destinations.platform,
          policies: bypassPolicy('Void project is public'),
        },
        projectApplicationReference(row, 'bypass'),
      );
      row = await updateProjectState(lockedDb, projectId, {
        bypass_application_id: bypass.id,
        bypass_application_name: bypass.name,
      });
      if (
        !(await publishProjectZeroTrustRoutingLocked(
          env,
          lockedDb,
          project,
          null,
          options?.routingBudget,
        ))
      ) {
        return (await getProjectZeroTrustState(lockedDb, projectId))!;
      }
      row = await updateProjectState(lockedDb, projectId, { effective_protected: false });
      await client.deleteApplication(row.protected_application_id, row.protected_application_name);
      return updateProjectState(lockedDb, projectId, {
        effective_protected: false,
        state: 'public',
        reconciled_operation: completedProjectOperation(configuration),
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
        last_error: null,
      });
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
    await publishProjectZeroTrustRoutingLocked(
      env,
      lockedDb,
      project,
      routingProtection(configuration, protectedApplication),
      options?.routingBudget,
    );
    row = await updateProjectState(lockedDb, projectId, { effective_protected: true });
    await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
    return updateProjectState(lockedDb, projectId, {
      effective_protected: true,
      state: 'protected',
      reconciled_operation: completedProjectOperation(configuration),
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
  options?: {
    configuration?: ZeroTrustConfiguration;
    client?: ZeroTrustCloudflareClient;
    desiredProtection?: boolean;
    routingBudget?: { remaining: number };
  },
): Promise<ProjectZeroTrust> {
  await checkpointProjectReconciliation(env, db, projectId, options);
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
): Promise<ProjectZeroTrust> {
  return reconcileProjectZeroTrust(env, db, projectId, {
    desiredProtection: protectedProject,
  });
}

async function ensurePublicProjectBeforeWildcard(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  configuration: ZeroTrustConfiguration,
  client: ZeroTrustCloudflareClient,
  initializing = false,
): Promise<ProjectZeroTrust | null> {
  await checkpointProjectReconciliation(env, db, projectId, { configuration });
  let operationError: unknown;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    if (!sameConfiguration(configuration, await readZeroTrustConfigurationStrict(lockedDb))) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    try {
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
        state: initializing && configuration.operation ? 'reconciling' : 'public',
        last_error: null,
      });
    } catch (error) {
      await markProjectError(lockedDb, projectId, error);
      operationError = error;
      return null;
    }
  });
  if (operationError !== undefined) {
    throw operationError;
  }
  return result;
}

export async function initializeNewProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<ProjectZeroTrust | null> {
  const configuration = await readZeroTrustConfigurationStrict(db);
  if (
    !configuration ||
    configuration.operation?.kind === 'disable' ||
    (!configuration.enabled && configuration.operation?.kind !== 'configure')
  ) {
    return null;
  }
  const initialized = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx);
    const lockedDb = tx as unknown as Db;
    const project = await getProject(lockedDb, projectId);
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (
      !project ||
      project.status === 'deleting' ||
      !saved ||
      saved.revision !== configuration.revision
    ) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration changed.');
    }
    // Project creation commits before this initializer runs. A platform batch
    // may already have seeded or reconciled it, including its ownership handles.
    const existing = await getProjectZeroTrustState(lockedDb, projectId);
    if (existing) {
      return { row: existing, created: false };
    }
    const operation = saved.operation;
    const existingSelection =
      operation?.kind === 'configure' &&
      operation.existingProjects !== null &&
      Date.parse(project.created_at) <= Date.parse(operation.startedAt)
        ? operation.existingProjects
        : null;
    const desired = existingSelection
      ? existingSelection === 'protected'
      : saved.protectNewProjects;
    return {
      row: await putProjectState(lockedDb, projectId, {
        desired_protected: desired,
        effective_protected: desired && !!saved.wildcardApplication && !operation,
        state: desired && saved.wildcardApplication && !operation ? 'protected' : 'reconciling',
        ...(!desired
          ? { bypass_application_name: await applicationName(env, `public-${project.id}`) }
          : {}),
      }),
      created: true,
    };
  });
  const { row } = initialized;
  if (!initialized.created) {
    return row;
  }
  if (!row.desired_protected) {
    const client = await clientForConfiguration(env, configuration);
    return ensurePublicProjectBeforeWildcard(env, db, projectId, configuration, client, true);
  }
  return row;
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

async function publicBypassCandidates(
  db: Db,
  limit: number,
  operation?: ZeroTrustOperation,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        eq(projectZeroTrust.desired_protected, false),
        or(
          isNull(projectZeroTrust.bypass_application_id),
          sql`${projectZeroTrust.state} <> 'public'`,
          ...(operation?.applicationTarget
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
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${operationCompletionKey(operation)}`,
          sql`${projectZeroTrust.state} IN ('reconciling', 'error')`,
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
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${operationCompletionKey(operation)}`,
          eq(projectZeroTrust.effective_protected, true),
          sql`${projectZeroTrust.state} <> 'public'`,
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
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
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
      state: 'reconciling',
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

async function claimConfiguration(
  db: Db,
  claim: (
    current: ZeroTrustConfiguration | null,
    owner: string,
    startedAt: string,
  ) => ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`);
    const current = await readZeroTrustConfigurationStrict(tx);
    if (current?.operation && leaseActive(current.operation)) {
      throw new ZeroTrustUnavailableError('Another Zero Trust operation is already running.');
    }
    const claimed = claim(current, crypto.randomUUID(), await operationStartedAt(tx));
    const configuration: ZeroTrustConfiguration = claimed.operation
      ? {
          ...claimed,
          operation: {
            ...claimed.operation,
            id:
              current?.operation?.kind === claimed.operation.kind &&
              current.operation.startedAt === claimed.operation.startedAt
                ? (current.operation.id ?? crypto.randomUUID())
                : crypto.randomUUID(),
          },
        }
      : claimed;
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
    status: 'error',
    lastError: errorMessage(error),
    operation: current.operation
      ? { ...current.operation, owner: null, leaseExpiresAt: null }
      : null,
  }).catch(() => undefined);
}

function isDeletedProject(error: unknown): boolean {
  return error instanceof ZeroTrustUnavailableError && error.message === 'Project is unavailable.';
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
      status: 'ready',
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
    const now = new Date().toISOString();
    const configuration: ZeroTrustConfiguration = {
      ...current,
      revision: current.revision + 1,
      status: 'configuring',
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
  const routingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
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
              operation.existingProjects === 'protected',
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
          const isInitial =
            operation.existingProjects !== null &&
            Date.parse(candidate.project.created_at) <= Date.parse(operation.startedAt);
          await setInitialProjectProtection(
            db,
            candidate.project.id,
            isInitial
              ? operation.existingProjects === 'protected'
              : configuration.protectNewProjects,
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
          try {
            if (configuration.wildcardApplication) {
              await reconcileProjectZeroTrust(env, db, candidate.project.id, {
                configuration,
                client,
                routingBudget,
              });
            } else {
              await ensurePublicProjectBeforeWildcard(
                env,
                db,
                candidate.project.id,
                configuration,
                client,
              );
            }
          } catch (error) {
            if (!isDeletedProject(error)) {
              throw error;
            }
          }
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (routingBudget.remaining === 0) {
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
        if (!configuration.wildcardApplicationName) {
          throw new Error('The platform Access application checkpoint is missing.');
        }
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
          const row = await getProjectZeroTrustState(db, candidate.project.id);
          if (
            routingBudget.remaining <
            (row?.desired_protected ? MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT + 1 : 1)
          ) {
            stoppedForRoutingBudget = true;
            break;
          }
          try {
            await reconcileProjectZeroTrust(env, db, candidate.project.id, {
              configuration,
              client,
              routingBudget,
            });
          } catch (error) {
            if (!isDeletedProject(error)) {
              throw error;
            }
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
  routingBudget: { remaining: number },
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
        state: 'reconciling',
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
        state: 'public',
        reconciled_operation: operationCompletionKey(saved.operation),
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
        state: 'public',
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
  const routingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
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
          await disableProjectZeroTrust(
            env,
            db,
            candidate.project.id,
            client,
            routingBudget,
            configuration,
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
            configuration.wildcardApplicationName ?? configuration.wildcardApplication?.name,
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
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        for (const candidate of candidates) {
          await deleteProjectZeroTrustBypass(db, candidate.project.id, client, configuration);
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
          if ((await bypassCleanupCandidates(lockedDb, 1)).length > 0) {
            return configuration;
          }
          return patchConfiguration(lockedDb, configuration, {
            status: 'ready',
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

export async function configurePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  input: ZeroTrustConfigureInput,
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  if (input.accountId !== env.CF_ACCOUNT_ID) {
    throw new ZeroTrustUnavailableError(
      'Zero Trust must use the Cloudflare account that owns this Void installation.',
    );
  }
  env = await resolveZeroTrustApplicationEnvironment(env, db);
  const destinations = zeroTrustWildcardDestinations(readPlatformApplication(env));
  if (destinations.length === 0) {
    throw new ZeroTrustUnavailableError(
      'Project Zero Trust needs a platform domain or workers.dev application hostname.',
    );
  }
  const client = new ZeroTrustCloudflareClient(input.accountId, input.apiToken);
  const previous = await readZeroTrustConfigurationStrict(db);
  const replacingDisableCredential = previous?.operation?.kind === 'disable';
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
  const generatedApplicationName = await applicationName(env, 'project-zero-trust');
  const configuration = await claimConfiguration(db, (current, owner, startedAt) => {
    if (
      replacingDisableCredential &&
      (current?.revision !== previous.revision || current.operation?.kind !== 'disable')
    ) {
      throw new ZeroTrustUnavailableError(
        'The saved Zero Trust operation changed. Retry configuration.',
      );
    }
    if (current?.operation) {
      const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
        left.length === right.length && left.every((id) => right.includes(id));
      if (
        current.accountId !== input.accountId ||
        current.protectNewProjects !== input.protectNewProjects ||
        !sameIds(current.identityProviderIds, input.identityProviderIds) ||
        !sameIds(current.policyIds, input.policyIds) ||
        (current.operation.existingProjects !== null &&
          current.operation.existingProjects !== input.existingProjects)
      ) {
        throw new ZeroTrustUnavailableError(
          'A saved Zero Trust operation is pending. To replace its API token, configure again with the same account, identity providers, policies, and project selections.',
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        status: current.operation.kind === 'disable' ? 'disabling' : 'configuring',
        credential,
        teamDomain: selection.teamDomain,
        operation: { ...current.operation, owner, leaseExpiresAt: leaseExpiresAt() },
        lastError: null,
        updatedAt: new Date().toISOString(),
      };
    }
    const enabling = !current?.enabled;
    const now = new Date().toISOString();
    return {
      version: 1,
      revision: (current?.revision ?? 0) + 1,
      status: 'configuring',
      enabled: current?.enabled ?? false,
      protectNewProjects: input.protectNewProjects,
      accountId: input.accountId,
      teamDomain: selection.teamDomain,
      identityProviderIds: [...input.identityProviderIds],
      policyIds: [...input.policyIds],
      credential,
      wildcardApplicationName:
        current?.wildcardApplicationName ??
        current?.wildcardApplication?.name ??
        generatedApplicationName,
      wildcardApplication: current?.wildcardApplication ?? null,
      operation: {
        kind: 'configure',
        phase: 'seed',
        owner,
        leaseExpiresAt: leaseExpiresAt(),
        startedAt,
        existingProjects: enabling ? input.existingProjects : null,
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
        status: current.operation.kind === 'disable' ? 'disabling' : 'configuring',
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
      status: 'configuring',
      operation: {
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
      status: 'disabling',
      operation:
        current.operation?.kind === 'disable'
          ? { ...current.operation, owner, leaseExpiresAt: leaseExpiresAt() }
          : {
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

export async function zeroTrustStatus(env: ApiEnv['Bindings'], db: Db) {
  const projectCounts = await db
    .select({
      desiredProtected: projectZeroTrust.desired_protected,
      effectiveProtected: projectZeroTrust.effective_protected,
      state: projectZeroTrust.state,
      count: sql<number>`count(*)::int`,
    })
    .from(projectZeroTrust)
    .groupBy(
      projectZeroTrust.desired_protected,
      projectZeroTrust.effective_protected,
      projectZeroTrust.state,
    );
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
      live: null,
      projects: projectCounts,
    };
  }
  let live: { present: boolean; drifted: boolean } | null = null;
  if (configuration?.enabled && configuration.wildcardApplication) {
    try {
      env = await resolveZeroTrustApplicationEnvironment(env, db, configuration);
      const client = await clientForConfiguration(env, configuration);
      const selection = await client.validateSelection({
        identityProviderIds: configuration.identityProviderIds,
        policyIds: configuration.policyIds,
      });
      live = await client.inspectApplication(configuration.wildcardApplication, {
        name: configuration.wildcardApplicationName ?? configuration.wildcardApplication.name,
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
  return reconcileProjectZeroTrust(env, db, projectId, { configuration });
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
    await resumePlatformZeroTrustOperation(env, db, configuration);
    return;
  }
  if (!configuration.enabled || configuration.status !== 'ready') {
    return;
  }
  const rows = await candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.state} IN ('reconciling', 'error')`,
        ),
      ),
    )
    .orderBy(projectZeroTrust.updated_at, projects.created_at)
    .limit(limit);
  if (rows.length === 0) {
    return;
  }
  const client = await clientForConfiguration(env, configuration);
  const routingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  for (const row of rows) {
    if (routingBudget.remaining < MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT + 1) {
      break;
    }
    await reconcileProjectZeroTrust(env, db, row.project.id, {
      configuration,
      client,
      routingBudget,
    }).catch((error) =>
      console.error('[zero-trust] scheduled project reconciliation failed', {
        projectId: row.project.id,
        error,
      }),
    );
  }
}

export async function resumePlatformZeroTrustOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  saved?: ZeroTrustConfiguration,
): Promise<boolean> {
  const configuration = saved ?? (await readZeroTrustConfigurationStrict(db));
  if (configuration?.operation && !leaseActive(configuration.operation)) {
    const result = await reconcilePlatformZeroTrust(env, db);
    // Only a batch that made progress owns the invocation; a failed one must
    // not starve the rest of the scheduled work.
    return !('status' in result && result.status === 'error');
  }
  return false;
}
