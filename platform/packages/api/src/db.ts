import {
  and,
  count,
  countDistinct,
  desc,
  asc,
  eq,
  ne,
  lt,
  gte,
  inArray,
  notInArray,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { generateId } from './id.ts';
import * as schema from './schema.ts';
import {
  users,
  oauthAccounts,
  projects,
  deployments,
  projectSecrets,
  resources,
  domains,
  emailDestinations,
  platformEvents,
  invitations,
  oauthNonces,
  authCodes,
  migrationRenames,
  projectMigrations,
  projectDatabaseCredentials,
  builds,
  githubConnections,
  githubInstallations,
  githubInstallationMembers,
  githubInstallationRevocations,
  githubWebhookRedeliveries,
} from './schema.ts';
import type { DomainVerificationData, GitHubInstallationRepository } from './schema.ts';
import type { AllowlistEntry } from './signup-allowlist.ts';
import type { PlanId } from './tiers.ts';
import type {
  Build,
  Deployment,
  DeploymentStatus,
  Domain,
  EmailDestination,
  GitHubConnection,
  GitHubInstallation,
  GitHubInstallationMember,
  Invitation,
  OAuthAccount,
  PlatformEvent,
  ProjectDatabaseCredentials,
  ProjectSecret,
  Project,
  Resource,
  User,
} from './types.ts';

export function createDb(connectionString: string) {
  return drizzle(connectionString, { schema });
}
export type Db = ReturnType<typeof createDb>;

export const TERMINAL_DEPLOYMENT_STATUSES: Array<DeploymentStatus> = ['live', 'failed', 'canceled'];
export const CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES: Array<DeploymentStatus> = [
  'canceling',
  'canceled',
];

export type AllowlistEntryStatus = AllowlistEntry & {
  accepted: boolean;
  deployed: boolean;
};

// --- Users ---

export async function createUser(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
): Promise<User> {
  const id = generateId('user');
  const [row] = await db
    .insert(users)
    .values({ id, provider, provider_id: providerId, login, email })
    .returning();
  return row;
}

export async function getUserByProvider(
  db: Db,
  provider: string,
  providerId: string,
): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.provider_id, providerId)))
    .limit(1);
  return row ?? null;
}

export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row ?? null;
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getUsersByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<User>> {
  if (ids.length === 0) {
    return [];
  }

  return db.select().from(users).where(inArray(users.id, ids));
}

export async function updateUser(
  db: Db,
  id: string,
  login: string,
  email: string | null,
): Promise<void> {
  await db.update(users).set({ login, email }).where(eq(users.id, id));
}

// --- OAuth Accounts ---

export async function getUserByOAuthAccount(
  db: Db,
  provider: string,
  providerId: string,
): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(oauthAccounts)
    .innerJoin(users, eq(oauthAccounts.user_id, users.id))
    .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.provider_id, providerId)))
    .limit(1);
  return row?.user ?? null;
}

export async function createOAuthAccount(
  db: Db,
  userId: string,
  provider: string,
  providerId: string,
): Promise<OAuthAccount> {
  const id = generateId('oa');
  const [row] = await db
    .insert(oauthAccounts)
    .values({ id, user_id: userId, provider, provider_id: providerId })
    .returning();
  return row;
}

/**
 * Thrown by {@link linkGitHubIdentity} when the requested GitHub identity is
 * already linked to a *different* Void user. Routes (RFC 0074, Task 2) map this
 * to HTTP 409 — it is the stable contract for that mapping.
 */
export class GitHubIdentityConflictError extends Error {
  constructor() {
    super('GitHub account already linked to another user');
    this.name = 'GitHubIdentityConflictError';
  }
}

/**
 * Thrown by {@link linkGitHubIdentity} when *this* Void user already has a
 * DIFFERENT GitHub identity linked. RFC 0074 models a single GitHub identity per
 * Void account; routes map this to HTTP 409 with a code distinct from
 * {@link GitHubIdentityConflictError} (which is the other-user case).
 */
export class GitHubIdentityAlreadyLinkedError extends Error {
  constructor() {
    super('Void account already has a different GitHub identity linked');
    this.name = 'GitHubIdentityAlreadyLinkedError';
  }
}

/** Postgres `unique_violation` SQLSTATE — surfaced by both `pg` and PGlite. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Link a GitHub OAuth identity to an *already-authenticated* Void user
 * (RFC 0074 — decouple GitHub-for-deploys from the login provider).
 *
 * Returns `'linked'` when a new row was created and `'already_linked'` when the
 * identity is already owned by `userId` (idempotent no-op). Throws
 * {@link GitHubIdentityConflictError} when the identity belongs to a different
 * user, and {@link GitHubIdentityAlreadyLinkedError} when this user already has a
 * DIFFERENT github identity (RFC 0074: one GitHub identity per Void account).
 *
 * Concurrency: the whole check-then-insert runs in a transaction that first
 * takes a `SELECT … FOR UPDATE` lock on the `userId` row. That serializes
 * concurrent links for the SAME user — `oauth_accounts` is unique only on
 * `(provider, provider_id)`, so without the lock two parallel links of DIFFERENT
 * github ids for one user could both pass the existing-github check and insert,
 * leaving two github rows (breaking RFC 0074's one-github-per-account invariant).
 * The lock makes the second link block until the first commits, then observe its
 * row and reject. A concurrent DIFFERENT-user link of the SAME github id is not
 * serialized by the per-user lock; that collides on the `(provider, provider_id)`
 * unique index instead — the insert raises a unique violation, we roll back,
 * re-resolve ownership OUTSIDE the aborted transaction, and map to the same
 * return/throw contract so a raw pg `23505` never escapes.
 */
export async function linkGitHubIdentity(
  db: Db,
  userId: string,
  providerId: string,
): Promise<'linked' | 'already_linked'> {
  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Serialize concurrent same-user links (see doc comment). Mirrors the
      // deploy/build per-user FOR UPDATE pattern.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update')
        .limit(1);

      const owner = await getUserByOAuthAccount(txDb, 'github', providerId);
      if (owner) {
        if (owner.id === userId) {
          return 'already_linked';
        }
        throw new GitHubIdentityConflictError();
      }

      // Enforce one github identity per Void account: a pre-existing github row
      // for this user must be a DIFFERENT provider_id (the same-id case is the
      // `owner.id === userId` short-circuit above), so reject.
      const existing = await txDb
        .select({ providerId: oauthAccounts.provider_id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')))
        .limit(1);
      if (existing.length > 0) {
        throw new GitHubIdentityAlreadyLinkedError();
      }

      await createOAuthAccount(txDb, userId, 'github', providerId);
      return 'linked';
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Lost the `(provider, provider_id)` insert race to a concurrent
    // DIFFERENT-user link of the same github id (the per-user FOR UPDATE lock
    // does not serialize across users). The transaction rolled back; re-resolve
    // ownership outside it.
    const winner = await getUserByOAuthAccount(db, 'github', providerId);
    if (winner?.id === userId) {
      return 'already_linked';
    }
    throw new GitHubIdentityConflictError();
  }
}

export async function updateUserPlan(db: Db, id: string, plan: PlanId): Promise<void> {
  await db.update(users).set({ plan }).where(eq(users.id, id));
}

export async function countUserDeploymentsToday(db: Db, userId: string): Promise<number> {
  // Excludes precheck placeholder rows (manifest IS NULL). Those represent
  // in-flight deploys that have passed serialization but not yet validated
  // against quota; counting them would charge a deploy against quota BEFORE
  // the quota check fires for that same request, dropping the effective
  // daily limit by one for both streamed-static and worker-backed paths.
  // See deploy.ts placeholder insert (~line 1306) and quota check sites
  // (~lines 1725 / 2206).
  const [result] = await db
    .select({ count: count() })
    .from(deployments)
    .innerJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      and(
        eq(projects.user_id, userId),
        sql`${deployments.created_at} >= CURRENT_DATE`,
        isNotNull(deployments.manifest),
      ),
    );
  return result?.count ?? 0;
}

// --- Projects ---

export async function createProject(
  db: Db,
  userId: string,
  slug: string,
  routing?: KVNamespace,
): Promise<Project> {
  const id = generateId('proj');
  const [row] = await db.insert(projects).values({ id, user_id: userId, slug }).returning();
  // Mirror projectId -> slug into KV so the email proxy can validate that
  // outbound `from` addresses belong to the calling project (the
  // account-level send_email binding has no per-project constraint, so
  // this mapping is the only thing preventing cross-project sender
  // spoofing). Slug is immutable today — written once at create-time.
  //
  // INVARIANT: project slugs are immutable. If a slug-rename feature
  // ever ships, every code path that mutates `projects.slug` MUST also
  //   (1) update `email-slug:<projectId>` in ROUTING KV (this key), AND
  //   (2) validate no `<oldslug>+...` send is in flight before the
  //       rename completes (otherwise an in-flight outbound POST could
  //       slip through with the old slug, then the proxy maps it back
  //       and the new owner of that slug appears to send mail).
  // TODO: revisit if/when project rename ships.
  if (routing) {
    try {
      await routing.put(`email-slug:${id}`, slug);
    } catch (err) {
      // Don't fail project creation on a transient KV blip. The proxy
      // will refuse sends with `project slug unknown` until this
      // converges, and the hourly cron backfill re-writes the mirror.
      console.error(`[createProject] failed to write email-slug:${id}:`, err);
    }
  }
  return row;
}

export async function getProject(db: Db, id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectBySlug(db: Db, slug: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return row ?? null;
}

export async function getProjectsByUserId(db: Db, userId: string): Promise<ReadonlyArray<Project>> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.user_id, userId))
    .orderBy(desc(projects.created_at));
}

export async function getLatestDeploymentsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<
  Map<
    string,
    Pick<
      Deployment,
      'id' | 'project_id' | 'status' | 'source' | 'commit' | 'created_at' | 'deployed_at'
    >
  >
> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: deployments.id,
      project_id: deployments.project_id,
      status: deployments.status,
      source: deployments.source,
      commit: deployments.commit,
      created_at: deployments.created_at,
      deployed_at: deployments.deployed_at,
    })
    .from(deployments)
    .where(inArray(deployments.project_id, projectIds))
    .orderBy(desc(deployments.created_at));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.project_id)) {
      latest.set(row.project_id, row);
    }
  }
  return latest;
}

export async function getProjectsByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<Project>> {
  if (ids.length === 0) {
    return [];
  }

  return db.select().from(projects).where(inArray(projects.id, ids));
}

export async function getProjectsWithOwnerByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<
  ReadonlyArray<
    Project & {
      owner_login: string | null;
    }
  >
> {
  if (ids.length === 0) {
    return [];
  }

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .where(inArray(projects.id, ids));
}

export async function updateProjectType(db: Db, id: string, type: Project['type']): Promise<void> {
  await db.update(projects).set({ type }).where(eq(projects.id, id));
}

export async function updateProjectWebSocketVersion(
  db: Db,
  id: string,
  websocketVersion: number,
): Promise<void> {
  await db.update(projects).set({ websocket_version: websocketVersion }).where(eq(projects.id, id));
}

// --- Deployments ---

export async function createDeployment(
  db: Db,
  projectId: string,
  manifest: string | null,
  source?: string | null,
  commit?: string | null,
  metadata?: {
    cliVersion?: string | null;
    commitUrl?: string | null;
    gitRef?: string | null;
    repositoryUrl?: string | null;
  },
): Promise<Deployment> {
  const id = generateId('dpl');
  const [row] = await db
    .insert(deployments)
    .values({
      id,
      project_id: projectId,
      manifest,
      source: source ?? null,
      commit: commit ?? null,
      repository_url: metadata?.repositoryUrl ?? null,
      commit_url: metadata?.commitUrl ?? null,
      git_ref: metadata?.gitRef ?? null,
      cli_version: metadata?.cliVersion ?? null,
    })
    .returning();
  return row;
}

/**
 * Fill in the manifest/source/git metadata on a deployment row that was inserted
 * pre-parse as an atomic concurrent-deploy claim (see the early FOR UPDATE
 * precheck in `routes/deploy.ts`). The row is created with NULL values for
 * these columns; this helper writes them once the multipart manifest has
 * been parsed and validated.
 */
export async function updateDeploymentManifest(
  db: Db,
  id: string,
  manifest: string,
  source: string | null,
  commit: string | null,
  metadata?: {
    cliVersion?: string | null;
    commitUrl?: string | null;
    gitRef?: string | null;
    repositoryUrl?: string | null;
  },
): Promise<Deployment> {
  const [row] = await db
    .update(deployments)
    .set({
      manifest,
      source,
      commit,
      repository_url: metadata?.repositoryUrl ?? null,
      commit_url: metadata?.commitUrl ?? null,
      git_ref: metadata?.gitRef ?? null,
      cli_version: metadata?.cliVersion ?? null,
      updated_at: sql`now()`,
    })
    .where(eq(deployments.id, id))
    .returning();
  return row;
}

export async function updateDeploymentStatus(
  db: Db,
  id: string,
  status: Deployment['status'],
  errorMessage?: string,
  options?: { force?: boolean },
): Promise<void> {
  await db
    .update(deployments)
    .set({
      status,
      updated_at: sql`now()`,
      deployed_at:
        status === 'live'
          ? sql`COALESCE(${deployments.deployed_at}, now())`
          : sql`${deployments.deployed_at}`,
      error_message: sql`COALESCE(${errorMessage ?? null}, ${deployments.error_message})`,
    })
    .where(
      options?.force
        ? eq(deployments.id, id)
        : and(
            eq(deployments.id, id),
            notInArray(deployments.status, CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES),
          ),
    );
}

export async function getDeployment(db: Db, id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectDeployments(
  db: Db,
  projectId: string,
  limit = 5,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at))
    .limit(limit);
}

export async function getAllProjectDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at));
}

export async function getAllDeploymentsWithProject(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  ReadonlyArray<Deployment & { project_slug: string | null; active_deployment_id: string | null }>
> {
  return db
    .select({
      ...getTableColumns(deployments),
      project_slug: projects.slug,
      active_deployment_id: projects.active_deployment_id,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .orderBy(desc(deployments.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countDeployments(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(deployments);
  return result?.count ?? 0;
}

export async function failStaleDeployments(db: Db): Promise<number> {
  const result = await db
    .update(deployments)
    .set({
      status: 'failed',
      updated_at: sql`now()`,
      error_message: sql`COALESCE(${deployments.error_message}, 'timed out')`,
    })
    .where(
      and(
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        sql`${deployments.updated_at} < now() - interval '30 minutes'`,
      ),
    );
  return result.rowCount ?? 0;
}

export async function getActiveDeployment(db: Db, projectId: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(1);
  return row ?? null;
}

export async function cancelDeployment(
  db: Db,
  deploymentId: string,
  errorMessage = 'canceled',
): Promise<Deployment | null> {
  const [row] = await db
    .update(deployments)
    .set({
      status: 'canceling',
      updated_at: sql`now()`,
      error_message: sql`COALESCE(${deployments.error_message}, ${errorMessage})`,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
}

export async function getLastLiveAssetManifest(
  db: Db,
  projectId: string,
): Promise<Record<string, { hash: string; size: number }> | null> {
  const [row] = await db
    .select({ asset_hashes: deployments.asset_hashes })
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.status, 'live')))
    .orderBy(desc(deployments.created_at))
    .limit(1);

  if (!row?.asset_hashes) {
    return null;
  }
  return JSON.parse(row.asset_hashes);
}

export async function setActiveDeployment(
  db: Db,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await db
    .update(projects)
    .set({ active_deployment_id: deploymentId })
    .where(eq(projects.id, projectId));
}

export async function markDeploymentRetained(
  db: Db,
  deploymentId: string,
  retained: boolean,
): Promise<void> {
  await db.update(deployments).set({ retained }).where(eq(deployments.id, deploymentId));
}

/**
 * Mark a deployment's worker bundle as durably persisted to R2 under
 * `worker-bundles/{project_id}/{deployment_id}/`. Set immediately AFTER
 * `persistWorkerBundle` resolves and BEFORE any cancellation check, so
 * the invariant `bundle_stored=true ⇒ rollbackable` holds: a future
 * rollback can validate the flag before invoking `replayWorkerBundle`.
 *
 * Static / SPA deploys never call this — they have no worker module to
 * bundle (their assets are content-addressed in R2 already), so their
 * `bundle_stored` correctly remains false.
 */
export async function markDeploymentBundleStored(db: Db, deploymentId: string): Promise<void> {
  await db.update(deployments).set({ bundle_stored: true }).where(eq(deployments.id, deploymentId));
}

export async function setAppliedMigrations(
  db: Db,
  deploymentId: string,
  migrations: ReadonlyArray<string>,
): Promise<void> {
  await db
    .update(deployments)
    .set({ applied_migrations: JSON.stringify(migrations) })
    .where(eq(deployments.id, deploymentId));
}

export async function getProjectMigrationNames(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .select({ name: projectMigrations.name })
    .from(projectMigrations)
    .where(eq(projectMigrations.project_id, projectId))
    .orderBy(asc(projectMigrations.applied_at), asc(projectMigrations.name));
  return rows.map((row) => row.name);
}

export async function getProjectMigrationRows(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<{ name: string; applied_at: string }>> {
  return db
    .select({ name: projectMigrations.name, applied_at: projectMigrations.applied_at })
    .from(projectMigrations)
    .where(eq(projectMigrations.project_id, projectId))
    .orderBy(asc(projectMigrations.applied_at), asc(projectMigrations.name));
}

export async function appendProjectMigrations(
  db: Db,
  projectId: string,
  names: ReadonlyArray<string>,
  sourceDeploymentId?: string,
): Promise<void> {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) {
    return;
  }
  await db
    .insert(projectMigrations)
    .values(
      uniqueNames.map((name) => ({
        name,
        project_id: projectId,
        source_deployment_id: sourceDeploymentId,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Atomically append newly-applied migration names to a deployment's
 * applied_migrations JSON text column, de-duping against what's already there.
 *
 * The previous read/merge/write pattern (fetch, JSON.parse, union, stringify,
 * UPDATE) lost entries under concurrent POST /migrations/apply requests: two
 * callers could both see the same pre-merge state and each overwrite with
 * their own partial union. Wrapping the read-then-write in a SERIALIZABLE
 * transaction with `SELECT … FOR UPDATE` serializes writers at the row level
 * so the second request waits for the first commit and observes its write.
 *
 * No-op when `newMigrations` is empty or the deployment row doesn't exist.
 */
export async function appendAppliedMigrations(
  db: Db,
  deploymentId: string,
  newMigrations: ReadonlyArray<string>,
): Promise<void> {
  if (newMigrations.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ applied_migrations: deployments.applied_migrations })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .for('update');
    if (rows.length === 0) {
      return;
    }
    const existing: Array<string> = rows[0]!.applied_migrations
      ? JSON.parse(rows[0]!.applied_migrations)
      : [];
    const existingSet = new Set(existing);
    const toAdd = newMigrations.filter((m) => !existingSet.has(m));
    if (toAdd.length === 0) {
      return;
    }
    const merged = [...existing, ...toAdd];
    await tx
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(merged) })
      .where(eq(deployments.id, deploymentId));
  });
}

/**
 * Check whether the CURRENT active deployment of a project has `migrationName`
 * present in its `applied_migrations` JSON array. Used by the rename endpoint
 * to corroborate ambiguous `!fromExists && toExists` classifications against
 * pg before rewriting metadata — a legitimate idempotent retry of a rename
 * that landed in D1 but failed to commit to pg will still reference the old
 * name on the active deployment.
 *
 * Scoped to the active deployment only. Stale retained deployment rows from
 * pre-R6 (when /migrations/rename only updated the active deployment's
 * `applied_migrations`) could be historically inaccurate and would silently
 * authorize incorrect rename requests that happen to name a
 * historically-present migration. The active deployment is the only source
 * of truth we can rely on for corroboration.
 *
 * The column is stored as text (see `setAppliedMigrations`), so the query
 * casts at read time. `jsonb ? text` returns true iff the JSON array has
 * `migrationName` as a top-level element.
 */
export async function activeDeploymentContainsMigration(
  db: Db,
  projectId: string,
  migrationName: string,
): Promise<boolean> {
  const result = (await db.execute(sql`
    SELECT 1
    FROM ${projects}
    INNER JOIN ${deployments} ON ${deployments.id} = ${projects.active_deployment_id}
    WHERE ${projects.id} = ${projectId}
      AND ${deployments.applied_migrations} IS NOT NULL
      AND (${deployments.applied_migrations})::jsonb ? ${migrationName}
    LIMIT 1
  `)) as { rows: ReadonlyArray<unknown> };
  return result.rows.length > 0;
}

/**
 * Rewrite `applied_migrations` entries across every deployment of a project.
 *
 * The rename endpoint updates remote `_void_migrations` rows in D1 and must
 * also keep the platform-side record consistent. A previous implementation
 * only rewrote the active deployment's `applied_migrations`, which left
 * retained and inactive deployments pointing at the old migration names and
 * broke rollback diffs that compare `applied_migrations` arrays. Rewriting
 * every project deployment in one transaction keeps all rows in sync.
 */
export async function renameAppliedMigrationsForProject(
  db: Db,
  projectId: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  if (renames.length === 0) {
    return;
  }
  const fromToMap = new Map(renames.map((r) => [r.from, r.to]));
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: deployments.id, applied_migrations: deployments.applied_migrations })
      .from(deployments)
      .where(eq(deployments.project_id, projectId))
      .for('update');
    for (const row of rows) {
      if (!row.applied_migrations) {
        continue;
      }
      const parsed: Array<string> = JSON.parse(row.applied_migrations);
      let changed = false;
      const next = parsed.map((m) => {
        const to = fromToMap.get(m);
        if (to !== undefined) {
          changed = true;
          return to;
        }
        return m;
      });
      if (changed) {
        await tx
          .update(deployments)
          .set({ applied_migrations: JSON.stringify(next) })
          .where(eq(deployments.id, row.id));
      }
    }
  });
}

export async function renameProjectMigrations(
  db: Db,
  projectId: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  for (const rename of renames) {
    await db
      .update(projectMigrations)
      .set({ name: rename.to })
      .where(
        and(eq(projectMigrations.project_id, projectId), eq(projectMigrations.name, rename.from)),
      );
  }
}

/**
 * Append committed /migrations/rename pairs to the audit log.
 *
 * The /rename partial-failure heal writes pg's `applied_migrations` before
 * surfacing a later pair's failure, which erases
 * `activeDeploymentContainsMigration(from)` as a corroboration source for
 * same-payload retries of an already-committed prefix. This audit log is
 * the durable, rename-specific second corroboration source:
 * `migrationRenameExists(project_id, from, to)` returning true means the
 * exact pair was already committed here in a previous locked tx, so an
 * idempotent retry must NOT be rejected as ambiguous.
 *
 * Called from the /rename handler inside the same locked tx as
 * `renameAppliedMigrationsForProject`, after every successful/idempotent
 * pair has been folded into `committed`. Uses ON CONFLICT DO NOTHING so
 * retries (and already-landed pairs from prior runs that land here again)
 * are no-ops. Note: the primary key is `(project_id, from_name, to_name)`
 * so this dedupes by the exact tuple — we never overwrite an existing row.
 */
export async function recordMigrationRenames(
  db: Db,
  projectId: string,
  pairs: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  if (pairs.length === 0) {
    return;
  }
  await db
    .insert(migrationRenames)
    .values(pairs.map((p) => ({ project_id: projectId, from_name: p.from, to_name: p.to })))
    .onConflictDoNothing();
}

/**
 * Returns true iff a committed rename from `from` to `to` has been recorded
 * for the given project. See `recordMigrationRenames` for the rationale.
 */
export async function migrationRenameExists(
  db: Db,
  projectId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const [row] = await db
    .select({ project_id: migrationRenames.project_id })
    .from(migrationRenames)
    .where(
      and(
        eq(migrationRenames.project_id, projectId),
        eq(migrationRenames.from_name, from),
        eq(migrationRenames.to_name, to),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Invalidate stale `migration_renames` rows whose `to_name` matches a
 * migration that is now being renamed AWAY.
 *
 * Migration names can be recycled: if `(a, a1)` is logged, then `a1` is
 * later renamed to `b`, then a different migration `x` is renamed INTO
 * `a1`, the original `(a, a1)` row is stale. A fat-fingered retry of
 * `a → a1` would then pass the classifier on corroborated-by-audit
 * grounds even though `a1` now represents `x`'s migration, not `a`'s
 * lineage — silently rewriting any retained-deployment rows that still
 * mention `a`.
 *
 * Invariant: whenever we record a new rename X→Y, delete any prior
 * `migration_renames` rows where `to_name = X`. Rationale: those rows
 * assume X is still the canonical landing spot, but X is now being
 * renamed away, so their "landed at X" claim is no longer valid.
 *
 * Only `to_name` is invalidated, not `from_name`. If the user previously
 * renamed `a → a1` and now renames `a → a2`, both intents should remain
 * auditable. The stale-lineage issue is specifically about a previously
 * logged LANDING being recycled as a new SOURCE.
 *
 * Must be called inside the same locked tx as `recordMigrationRenames`
 * and `renameAppliedMigrationsForProject` so a rollback also rolls back
 * the invalidation.
 */
export async function invalidateMigrationRenamesForOldName(
  db: Db,
  projectId: string,
  oldName: string,
): Promise<void> {
  await db
    .delete(migrationRenames)
    .where(and(eq(migrationRenames.project_id, projectId), eq(migrationRenames.to_name, oldName)));
}

export async function getRetainedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.retained, true)))
    .orderBy(desc(deployments.created_at));
}

export async function getRetainedDeploymentsExcluding(
  db: Db,
  projectId: string,
  excludeId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        eq(deployments.retained, true),
        ne(deployments.id, excludeId),
      ),
    )
    .orderBy(desc(deployments.created_at));
}

export async function getInFlightDeploymentsExcluding(
  db: Db,
  projectId: string,
  excludeId?: string | null,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        excludeId ? ne(deployments.id, excludeId) : undefined,
      ),
    )
    .orderBy(desc(deployments.created_at));
}

/**
 * Every deployment that has ever reached `live` (deployed_at IS NOT NULL),
 * regardless of current retention. Used by the rollback queue sweep to
 * union every queue that was ever owned by an activated deployment.
 */
export async function getActivatedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), isNotNull(deployments.deployed_at)))
    .orderBy(desc(deployments.created_at));
}

/**
 * Deployments that reached a terminal non-success state without ever
 * activating (deployed_at IS NULL, status in 'failed' | 'canceled').
 * Union'd with getActivatedDeployments at rollback to catch `queue:<name>`
 * KV routes a failed deploy wrote before the routing flip.
 */
export async function getTerminalFailedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        isNull(deployments.deployed_at),
        inArray(deployments.status, ['failed', 'canceled']),
      ),
    )
    .orderBy(desc(deployments.created_at));
}

// --- Project secrets ---

export async function listProjectSecretNames(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<{ name: string }>> {
  return db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(eq(projectSecrets.project_id, projectId))
    .orderBy(asc(projectSecrets.name));
}

export async function getProjectSecret(
  db: Db,
  projectId: string,
  name: string,
): Promise<ProjectSecret | null> {
  const [row] = await db
    .select()
    .from(projectSecrets)
    .where(and(eq(projectSecrets.project_id, projectId), eq(projectSecrets.name, name)))
    .limit(1);
  return row ?? null;
}

export async function getProjectSecrets(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectSecret>> {
  return db
    .select()
    .from(projectSecrets)
    .where(eq(projectSecrets.project_id, projectId))
    .orderBy(asc(projectSecrets.name));
}

export async function upsertProjectSecret(
  db: Db,
  projectId: string,
  name: string,
  ciphertext: string,
  iv: string,
  keyVersion: string,
  managedReason: string | null = null,
): Promise<ProjectSecret> {
  const [row] = await db
    .insert(projectSecrets)
    .values({
      id: generateId('psc'),
      project_id: projectId,
      name,
      ciphertext,
      iv,
      key_version: keyVersion,
      managed_reason: managedReason,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.project_id, projectSecrets.name],
      set: {
        ciphertext,
        iv,
        key_version: keyVersion,
        managed_reason: managedReason,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function deleteProjectSecret(db: Db, projectId: string, name: string): Promise<void> {
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.project_id, projectId), eq(projectSecrets.name, name)));
}

// --- Database credentials ---

export async function upsertProjectDatabaseUrl(
  db: Db,
  projectId: string,
  ciphertext: string,
  iv: string,
  keyVersion: string,
): Promise<ProjectDatabaseCredentials> {
  const [row] = await db
    .insert(projectDatabaseCredentials)
    .values({ project_id: projectId, ciphertext, iv, key_version: keyVersion })
    .onConflictDoUpdate({
      target: projectDatabaseCredentials.project_id,
      set: {
        ciphertext,
        iv,
        key_version: keyVersion,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getProjectDatabaseUrl(
  db: Db,
  projectId: string,
): Promise<ProjectDatabaseCredentials | null> {
  const [row] = await db
    .select()
    .from(projectDatabaseCredentials)
    .where(eq(projectDatabaseCredentials.project_id, projectId))
    .limit(1);
  return row ?? null;
}

export async function deleteProjectDatabaseUrl(db: Db, projectId: string): Promise<void> {
  await db
    .delete(projectDatabaseCredentials)
    .where(eq(projectDatabaseCredentials.project_id, projectId));
}

// --- Resources ---

export async function createResource(
  db: Db,
  projectId: string,
  type: Resource['type'],
  cfId: string,
  bindingName: string,
): Promise<Resource> {
  const id = generateId('res');
  const [row] = await db
    .insert(resources)
    .values({ id, project_id: projectId, type, cf_id: cfId, binding_name: bindingName })
    .returning();
  return row;
}

export async function getProjectResources(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Resource>> {
  return db.select().from(resources).where(eq(resources.project_id, projectId));
}

export async function getResourceByBinding(
  db: Db,
  projectId: string,
  type: 'd1' | 'kv' | 'r2' | 'queue',
  bindingName: string,
): Promise<{ cf_id: string } | undefined> {
  return db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, type),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);
}

/**
 * Upsert a `container` resource row, returning the prior `cf_id` when an
 * existing row's id was updated to a new application id.
 *
 * Container applications can be replaced out-of-band: the CF API can return
 * 404 when an operator deletes a stale same-name app (or the namespace-mismatch
 * remediation the deploy path now relies on tells the operator to delete it).
 * In those cases `upsertSandboxContainerApplication` POSTs a fresh app and
 * returns a new `application.id`. The old `createResource`-only path skipped
 * persistence whenever a row already existed for the binding, leaving the DB
 * pointing at a dead `cf_id` — cleanup later 404s on that id and the new app
 * leaks. This helper closes that hole by reconciling on the natural unique
 * key `(project_id, type, binding_name)`.
 *
 * Returns `{ priorCfId }` so callers can log the transition. `priorCfId` is
 * `null` when a new row was inserted, the same string as `cfId` when the row
 * already pointed at the same id (no-op), and the prior id when an existing
 * row was updated to point at a new application.
 */
export async function upsertContainerResource(
  db: Db,
  projectId: string,
  bindingName: string,
  cfId: string,
): Promise<{ priorCfId: string | null }> {
  // Read first so we can report the prior cf_id even on the update path.
  // Drizzle's RETURNING returns post-update columns; without this read we
  // could not distinguish "inserted" from "updated to same id" from
  // "updated to a new id" cleanly.
  const prior = await db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, 'container'),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);

  await db
    .insert(resources)
    .values({
      id: generateId('res'),
      project_id: projectId,
      type: 'container',
      cf_id: cfId,
      binding_name: bindingName,
    })
    .onConflictDoUpdate({
      target: [resources.project_id, resources.type, resources.binding_name],
      set: { cf_id: cfId },
    });

  return { priorCfId: prior?.cf_id ?? null };
}

// --- Domains ---

export async function createDomain(
  db: Db,
  projectId: string,
  hostname: string,
  cfHostnameId: string,
  verificationData?: DomainVerificationData | null,
): Promise<Domain> {
  const id = generateId('dom');
  const [row] = await db
    .insert(domains)
    .values({
      id,
      project_id: projectId,
      hostname,
      cf_hostname_id: cfHostnameId,
      verification_data: verificationData ?? null,
    })
    .returning();
  return row;
}

export async function getDomainsByProjectId(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.project_id, projectId))
    .orderBy(asc(domains.created_at));
}

export async function getDomainsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, ReadonlyArray<Domain>>> {
  const allDomains = await db
    .select()
    .from(domains)
    .where(inArray(domains.project_id, projectIds))
    .orderBy(asc(domains.created_at));

  const map = new Map<string, Array<Domain>>();
  for (const d of allDomains) {
    const list = map.get(d.project_id) ?? [];
    list.push(d);
    map.set(d.project_id, list);
  }
  return map;
}

export async function getDomainByHostname(db: Db, hostname: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.hostname, hostname)).limit(1);
  return row ?? null;
}

export async function getDomainByHostnameOrCfHostnameId(
  db: Db,
  hostname: string,
  cfHostnameId: string,
): Promise<Domain | null> {
  const [row] = await db
    .select()
    .from(domains)
    .where(or(eq(domains.hostname, hostname), eq(domains.cf_hostname_id, cfHostnameId)))
    .limit(1);
  return row ?? null;
}

export async function getDomain(db: Db, id: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
  return row ?? null;
}

// Stale custom hostnames that never verified — for the cleanup janitor. Only
// `pending` rows are eligible; `created_at` is a string-mode timestamp so the
// cutoff is compared as an ISO string. Capped at `limit` and ordered
// oldest-first (most overdue cleaned first) so a large stale backlog cannot
// starve later hourly maintenance.
export async function getPendingDomainsOlderThan(
  db: Db,
  isoCutoff: string,
  limit: number,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.status, 'pending'), lt(domains.created_at, isoCutoff)))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

// All pending custom-hostname rows (cron hourly reconciliation tier). Capped
// at `limit` and ordered oldest-first so domains nearest the 7-day cleanup are
// reconciled before the per-run cap truncates the batch.
export async function getPendingDomains(db: Db, limit: number): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.status, 'pending'))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

// Recently-created pending rows (cron 30-min fast reconciliation tier).
// `created_at` is a string-mode timestamp, compared as an ISO string. Capped at
// `limit` and ordered oldest-first so the per-run cap truncates the newest
// (least urgent) domains rather than starving older ones.
export async function getPendingDomainsNewerThan(
  db: Db,
  isoCutoff: string,
  limit: number,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.status, 'pending'), gte(domains.created_at, isoCutoff)))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

export async function updateDomainStatus(
  db: Db,
  id: string,
  status: Domain['status'],
): Promise<void> {
  await db.update(domains).set({ status }).where(eq(domains.id, id));
}

export async function updateDomainVerificationData(
  db: Db,
  id: string,
  data: DomainVerificationData | null,
): Promise<void> {
  await db.update(domains).set({ verification_data: data }).where(eq(domains.id, id));
}

export async function deleteDomain(db: Db, id: string): Promise<void> {
  await db.delete(domains).where(eq(domains.id, id));
}

// Atomically delete a domain row ONLY if it is still `pending`. Used by the
// cleanup janitor to "claim" a stale row: if a concurrent status poll has
// since activated the domain (status → 'active'), the delete is a no-op and
// returns false, so the janitor leaves the now-live domain (and its CF
// hostname) untouched. Returns true iff a pending row was deleted.
export async function deleteDomainIfPending(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(domains)
    .where(and(eq(domains.id, id), eq(domains.status, 'pending')))
    .returning({ id: domains.id });
  return deleted.length > 0;
}

export async function deleteProjectDomains(db: Db, projectId: string): Promise<void> {
  await db.delete(domains).where(eq(domains.project_id, projectId));
}

// --- Email destinations ---

/**
 * The human whose CF-side consent an owner-relaxed row inherits, captured
 * at insert-time. See `emailDestinations.verified_by_*` in `schema.ts`.
 */
export interface OwnerVerificationAudit {
  /** users.id of the human whose CF-side consent we inherited. */
  userId: string;
  /** That user's email address at insert-time (snapshot for revocation). */
  emailSnapshot: string;
}

/**
 * Insert a destination row, returning whether THIS call did the insert.
 *
 * Uses ON CONFLICT DO NOTHING + RETURNING so the inserter is
 * unambiguously identified. Two concurrent POSTs for the same
 * (project_id, address) would otherwise both pass through
 * `createEmailDestination` + the unique-constraint catch — but the loser
 * would then read back the winner's pending/platform row and ALSO fire a
 * platform-side verification email. With `inserted=false`, the route can
 * correctly gate the email send on the inserter only.
 *
 * Returns:
 *   { row, inserted: true }  — this call did the INSERT.
 *   { row, inserted: false } — a sibling call already inserted; we read
 *                              back their row.
 *   { row: null }            — extremely unlikely race where the row was
 *                              deleted between insert-failure and select.
 *                              Caller must treat as a hard error.
 */
export async function tryCreateEmailDestination(
  db: Db,
  projectId: string,
  address: string,
  cfDestinationId: string | null,
  status: EmailDestination['status'] = 'pending',
  verifiedAt?: string | null,
  verificationSource: EmailDestination['verification_source'] = 'cf',
  /**
   * Audit columns populated only on the owner-relaxed CF reuse branch
   * (Option C in design doc 0078) — when we inherit the project owner's
   * prior consent on a different project for THIS project. Pass
   * `undefined` for every other path; the helper writes NULL columns
   * so revocation only touches inherited-consent rows.
   */
  ownerAudit?: OwnerVerificationAudit,
): Promise<{ row: EmailDestination | null; inserted: boolean }> {
  const id = generateId('edst');
  const resolvedVerifiedAt =
    status === 'verified' ? (verifiedAt ?? new Date().toISOString()) : null;
  const inserted = await db
    .insert(emailDestinations)
    .values({
      id,
      project_id: projectId,
      address: address.toLowerCase(),
      cf_destination_id: cfDestinationId,
      status,
      verified_at: resolvedVerifiedAt,
      verification_source: verificationSource,
      verified_by_user_id: ownerAudit?.userId ?? null,
      verified_by_email_snapshot: ownerAudit?.emailSnapshot ?? null,
    })
    .onConflictDoNothing({ target: [emailDestinations.project_id, emailDestinations.address] })
    .returning();
  if (inserted.length > 0) {
    return { row: inserted[0]!, inserted: true };
  }
  // ON CONFLICT DO NOTHING didn't return a row, which means a sibling
  // request inserted concurrently. Read it back. If the sibling DELETED
  // their own row between insert-failure and select (extremely unlikely
  // — only the project owner can DELETE), we return `{ row: null }`.
  // The caller treats that as "concurrently modified, retry once".
  const existing = await getEmailDestinationByAddress(db, projectId, address);
  return { row: existing, inserted: false };
}

export async function createEmailDestination(
  db: Db,
  projectId: string,
  address: string,
  cfDestinationId: string | null,
  status: EmailDestination['status'] = 'pending',
  /**
   * Audit timestamp. Pass CF's `verified` field when recovering an
   * already-verified destination so the audit trail reflects the real
   * verification time rather than local now(). Omit / pass null to use
   * now() when status is verified.
   */
  verifiedAt?: string | null,
  /**
   * 'cf'       — the CF Email Routing verification email is the source of
   *              truth (the default; covers fresh adds AND owner-relaxed
   *              reuse, where the project owner had already verified the
   *              address on a prior project).
   * 'platform' — CF already had the address verified by a different
   *              project. We're issuing our own confirmation email; the
   *              row stays 'pending' until that link is clicked.
   *
   * Defaults to 'cf' to preserve the historical create-path behavior.
   */
  verificationSource: EmailDestination['verification_source'] = 'cf',
  /**
   * Audit columns for owner-relaxed CF reuse (Option C). See
   * `tryCreateEmailDestination` for the populate / NULL rules.
   */
  ownerAudit?: OwnerVerificationAudit,
): Promise<EmailDestination> {
  const id = generateId('edst');
  const resolvedVerifiedAt =
    status === 'verified' ? (verifiedAt ?? new Date().toISOString()) : null;
  const [row] = await db
    .insert(emailDestinations)
    .values({
      id,
      project_id: projectId,
      address: address.toLowerCase(),
      cf_destination_id: cfDestinationId,
      status,
      verified_at: resolvedVerifiedAt,
      verification_source: verificationSource,
      verified_by_user_id: ownerAudit?.userId ?? null,
      verified_by_email_snapshot: ownerAudit?.emailSnapshot ?? null,
    })
    .returning();
  return row;
}

/**
 * Revoke owner-inherited CF verification when the project owner's email
 * identity changes (e.g. OAuth email update on a re-link).
 *
 * Affects only rows where:
 *   - `verification_source = 'cf'` (we inherited a CF flag, not a
 *     platform-side click)
 *   - `verified_by_user_id = userId` (the same human consented)
 *   - `verified_by_email_snapshot = oldEmail` (the address they used)
 *
 * Such rows trace back to the owner-relaxed branch in `routes/email.ts`
 * (Option C). When the owner's email changes, the consent that
 * authorized those rows no longer represents the current identity, so
 * we flip them back to 'pending' (rather than hard-deleting) to give
 * the user a re-confirm path: re-clicking CF's existing verification
 * link OR triggering a fresh platform-side flow keeps the destination
 * usable without losing the row's history. We also clear the audit
 * columns so the row no longer claims to be owner-verified by a stale
 * identity.
 *
 * Returns the list of distinct project ids whose rows were touched, so
 * the caller can sync each project's allowlist KV (verified rows we
 * just demoted must drop out of `email-allowlist:<projectId>` so the
 * proxy stops accepting sends to them).
 *
 * NOTE: today users.email is set once on signup and never mutated
 * (`updateUser` is only called from the OAuth callback for the user's
 * primary provider, with a verified email — see `routes/auth.ts`). This
 * helper exists for the moment we add an OAuth re-link / email-change
 * flow. Wire it into that flow when the flow ships; today it's
 * exported and tested but never invoked from a write path.
 */
export async function revokeOwnerVerifiedDestinationsForUserChange(
  db: Db,
  userId: string,
  oldEmail: string,
): Promise<Array<string>> {
  const lowered = oldEmail.toLowerCase();
  const updated = await db
    .update(emailDestinations)
    .set({
      status: 'pending',
      verified_at: null,
      verified_by_user_id: null,
      verified_by_email_snapshot: null,
    })
    .where(
      and(
        eq(emailDestinations.verified_by_user_id, userId),
        sql`lower(${emailDestinations.verified_by_email_snapshot}) = ${lowered}`,
        eq(emailDestinations.verification_source, 'cf'),
      ),
    )
    .returning({ project_id: emailDestinations.project_id });
  return Array.from(new Set(updated.map((r) => r.project_id)));
}

export async function getEmailDestinationsByProjectId(
  db: Db,
  projectId: string,
): Promise<Array<EmailDestination>> {
  return db
    .select()
    .from(emailDestinations)
    .where(eq(emailDestinations.project_id, projectId))
    .orderBy(asc(emailDestinations.created_at));
}

export async function getVerifiedEmailDestinationsByProjectId(
  db: Db,
  projectId: string,
): Promise<Array<EmailDestination>> {
  return db
    .select()
    .from(emailDestinations)
    .where(
      and(eq(emailDestinations.project_id, projectId), eq(emailDestinations.status, 'verified')),
    )
    .orderBy(asc(emailDestinations.created_at));
}

export async function getEmailDestinationByAddress(
  db: Db,
  projectId: string,
  address: string,
): Promise<EmailDestination | null> {
  const [row] = await db
    .select()
    .from(emailDestinations)
    .where(
      and(
        eq(emailDestinations.project_id, projectId),
        eq(emailDestinations.address, address.toLowerCase()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Look up a single destination by its primary key. Used by the public
 * confirm endpoint to validate a token's `did` claim against the DB row.
 */
export async function getEmailDestinationById(
  db: Db,
  id: string,
): Promise<EmailDestination | null> {
  const [row] = await db
    .select()
    .from(emailDestinations)
    .where(eq(emailDestinations.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateEmailDestinationStatus(
  db: Db,
  id: string,
  status: EmailDestination['status'],
  cfDestinationId?: string | null,
  /**
   * Audit timestamp from CF's `verified` field. When status flips to
   * 'verified' and no value is supplied, defaults to now().
   */
  verifiedAt?: string | null,
  /**
   * Optional override for the row's `verification_source`. Useful when
   * promoting a 'platform' pending row to verified after the recipient
   * clicks the platform-side confirmation link — leave undefined to
   * preserve the existing source value rather than overwriting it.
   */
  verificationSource?: EmailDestination['verification_source'],
): Promise<void> {
  const patch: {
    status: EmailDestination['status'];
    verified_at?: string | null;
    cf_destination_id?: string | null;
    verification_source?: EmailDestination['verification_source'];
  } = {
    status,
  };
  if (status === 'verified') {
    patch.verified_at = verifiedAt ?? new Date().toISOString();
  }
  if (cfDestinationId !== undefined) {
    patch.cf_destination_id = cfDestinationId;
  }
  if (verificationSource !== undefined) {
    patch.verification_source = verificationSource;
  }
  await db.update(emailDestinations).set(patch).where(eq(emailDestinations.id, id));
}

export async function deleteEmailDestination(db: Db, id: string): Promise<void> {
  await db.delete(emailDestinations).where(eq(emailDestinations.id, id));
}

/**
 * How many DISTINCT projects still reference a CF destination. CF
 * destinations are account-level, so the CF-side address may only be
 * deleted once the last project stops referencing it.
 */
export async function countProjectsUsingDestination(
  db: Db,
  cfDestinationId: string,
): Promise<number> {
  const result = await db
    .select({ n: countDistinct(emailDestinations.project_id) })
    .from(emailDestinations)
    .where(eq(emailDestinations.cf_destination_id, cfDestinationId));
  return Number(result[0]?.n ?? 0);
}

// --- Deletion ---

export async function deleteProjectResources(db: Db, projectId: string): Promise<void> {
  await db.delete(resources).where(eq(resources.project_id, projectId));
}

export async function deleteProjectDeployments(db: Db, projectId: string): Promise<void> {
  await db.delete(deployments).where(eq(deployments.project_id, projectId));
}

export async function deleteProject(db: Db, id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}

/**
 * Cascade-delete a project and everything that references it. Returns:
 *  - `cancelledBuilds`: the in-flight builds terminalized here, so the caller can
 *    best-effort stop their still-running container BuildManager DOs (see
 *    {@link cancelContainerBuildDos}) AFTER this tx commits.
 *  - `deletedResources`: every `resources` row this tx removed. Because the
 *    project FOR UPDATE lock below conflicts with the `FOR KEY SHARE` a resources
 *    INSERT takes on the same project row (FK), this is the COMPLETE set of
 *    resources that ever committed — a row created concurrently either committed
 *    before this lock (so the DELETE sees it) or blocks then FK-fails. The caller
 *    deletes the CF object for any resource not already cleaned by the pre-cascade
 *    best-effort sweep, closing the orphan-on-concurrent-create window (a
 *    provisioning route or deploy that raced teardown and inserted a row after the
 *    sweep's one-time snapshot). See design-doc 0067 for the broader race.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string,
): Promise<{
  cancelledBuilds: ReadonlyArray<{
    id: string;
    executor: Build['executor'];
    status: Build['status'];
    instance_type: string | null;
  }>;
  deletedResources: ReadonlyArray<Resource>;
}> {
  return await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Lock the project row FOR UPDATE — the SAME lock the build-creation paths
    // take FIRST (supersedeAndCreateContainerBuild, createGithubActionsBuildWithinLimit)
    // — so a concurrent push/OIDC can't insert a fresh build BETWEEN the
    // terminalize below and the builds delete. A build that committed before this
    // lock is caught by terminateBuildsForProject; one that lost the race blocks
    // until this tx commits, then finds the project (and its ON DELETE CASCADE
    // github_connections row) gone and creates nothing.
    await tx.execute(sql`SELECT id FROM ${projects} WHERE id = ${projectId} FOR UPDATE`);
    // Terminalize + capture in-flight builds BEFORE deleting their rows. The build
    // row is the only durable handle the reaper/cancel path uses to stop a running
    // container DO; once the row is gone the DO (or a GitHub Actions runner) would
    // keep building until its own timeout, burning fleet/runner capacity for a
    // project that no longer exists. The caller stops the container DOs after this
    // tx commits; github_actions builds have no DO, so terminalizing (then
    // deleting) their row to revoke the deploy token is all that's possible.
    const cancelled = await terminateBuildsForProject(txDb, projectId, {
      reason: 'project deleted',
    });
    await tx.delete(domains).where(eq(domains.project_id, projectId));
    // RETURNING the deleted rows so the caller can clean up the CF object behind
    // any resource that raced teardown's one-time best-effort snapshot (its row
    // is removed here, so without this it would have no durable handle left).
    const deletedResources = await tx
      .delete(resources)
      .where(eq(resources.project_id, projectId))
      .returning();
    await tx.delete(projectSecrets).where(eq(projectSecrets.project_id, projectId));
    // builds reference both projects and deployments with ON DELETE NO ACTION,
    // so they must be removed before the deployments delete below (otherwise the
    // build->deployment FK aborts the teardown transaction).
    await tx.delete(builds).where(eq(builds.project_id, projectId));
    await tx.delete(deployments).where(eq(deployments.project_id, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
    return { cancelledBuilds: cancelled, deletedResources };
  });
}

// --- Counts ---

export async function countUsers(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(users);
  return result?.count ?? 0;
}

export async function countProjects(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(projects);
  return result?.count ?? 0;
}

// --- Admin ---

export async function getAllUsers(
  db: Db,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<User>> {
  return db.select().from(users).orderBy(desc(users.created_at)).limit(limit).offset(offset);
}

export async function searchUsers(db: Db, query: string): Promise<ReadonlyArray<User>> {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(users)
    .where(or(ilike(users.login, pattern), ilike(users.email, pattern), ilike(users.id, pattern)))
    .orderBy(desc(users.created_at))
    .limit(50);
}

export async function getSystemStats(
  db: Db,
): Promise<{ users: number; projects: number; deployments: number }> {
  const [[u], [p], [d]] = await Promise.all([
    db.select({ count: count() }).from(users),
    db.select({ count: count() }).from(projects),
    db.select({ count: count() }).from(deployments),
  ]);
  return {
    users: u?.count ?? 0,
    projects: p?.count ?? 0,
    deployments: d?.count ?? 0,
  };
}

export type CliVersionDeploymentStats = Readonly<{
  cli_version: string | null;
  deployments: number;
  projects: number;
  users: number;
  first_seen: string;
  last_seen: string;
}>;

export async function getCliVersionDeploymentStats(
  db: Db,
  options?: { sinceDays?: number },
): Promise<ReadonlyArray<CliVersionDeploymentStats>> {
  const sinceDays = options?.sinceDays;
  return db
    .select({
      cli_version: deployments.cli_version,
      deployments: sql<number>`count(*)::int`,
      projects: sql<number>`count(distinct ${deployments.project_id})::int`,
      users: sql<number>`count(distinct ${projects.user_id})::int`,
      first_seen: sql<string>`min(${deployments.created_at})`,
      last_seen: sql<string>`max(${deployments.created_at})`,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      sinceDays && sinceDays > 0
        ? sql`${deployments.created_at} >= now() - (${sinceDays} * interval '1 day')`
        : sql`true`,
    )
    .groupBy(deployments.cli_version)
    .orderBy(desc(sql`count(*)`));
}

export async function suspendUser(db: Db, id: string, reason: string): Promise<void> {
  await db.update(users).set({ suspended_reason: reason }).where(eq(users.id, id));
}

export async function unsuspendUser(db: Db, id: string): Promise<void> {
  await db.update(users).set({ suspended_reason: null }).where(eq(users.id, id));
}

export async function updateUserRole(db: Db, id: string, role: 'user' | 'admin'): Promise<void> {
  await db.update(users).set({ role }).where(eq(users.id, id));
}

export async function deleteUser(db: Db, id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}

export async function getAllProjects(
  db: Db,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<Project>> {
  return db.select().from(projects).orderBy(desc(projects.created_at)).limit(limit).offset(offset);
}

function getLatestDeploymentByProjectSubquery(db: Db) {
  return db
    .selectDistinctOn([deployments.project_id], {
      project_id: deployments.project_id,
      last_deploy: deployments.created_at,
      last_deploy_id: deployments.id,
      last_deploy_status: deployments.status,
    })
    .from(deployments)
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id))
    .as('last_deploy_sq');
}

export async function searchProjects(
  db: Db,
  query: string,
): Promise<
  ReadonlyArray<
    Project & {
      owner_login: string | null;
      last_deploy: string | null;
      last_deploy_id: string | null;
      last_deploy_status: string | null;
    }
  >
> {
  const pattern = `%${query}%`;
  const lastDeploy = getLatestDeploymentByProjectSubquery(db);

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
      last_deploy: lastDeploy.last_deploy,
      last_deploy_id: lastDeploy.last_deploy_id,
      last_deploy_status: lastDeploy.last_deploy_status,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id))
    .where(
      or(ilike(projects.slug, pattern), ilike(users.login, pattern), ilike(projects.id, pattern)),
    )
    .orderBy(desc(projects.created_at))
    .limit(50);
}

export async function searchDeployments(
  db: Db,
  query: string,
): Promise<
  ReadonlyArray<Deployment & { project_slug: string | null; active_deployment_id: string | null }>
> {
  const pattern = `%${query}%`;
  return db
    .select({
      ...getTableColumns(deployments),
      project_slug: projects.slug,
      active_deployment_id: projects.active_deployment_id,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      or(
        ilike(deployments.id, pattern),
        ilike(projects.slug, pattern),
        ilike(deployments.status, pattern),
        ilike(deployments.commit, pattern),
        ilike(deployments.source, pattern),
        ilike(deployments.cli_version, pattern),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(50);
}

export async function getAllProjectsWithOwner(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  ReadonlyArray<
    Project & {
      owner_login: string | null;
      last_deploy: string | null;
      last_deploy_id: string | null;
      last_deploy_status: string | null;
    }
  >
> {
  const lastDeploy = getLatestDeploymentByProjectSubquery(db);

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
      last_deploy: lastDeploy.last_deploy,
      last_deploy_id: lastDeploy.last_deploy_id,
      last_deploy_status: lastDeploy.last_deploy_status,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id))
    .orderBy(desc(projects.created_at))
    .limit(limit)
    .offset(offset);
}

// --- Consolidated queries (previously inline) ---

export async function getFirstAdmin(db: Db) {
  const [row] = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  return row ?? null;
}

export async function updateUserProviderId(db: Db, id: string, providerId: string): Promise<void> {
  await db.update(users).set({ provider_id: providerId }).where(eq(users.id, id));
}

export async function getAllUsersWithPlan(db: Db) {
  return db
    .select({
      id: users.id,
      plan: users.plan,
      billing_cycle_start: users.billing_cycle_start,
    })
    .from(users);
}

export async function getUsersWithProjectsBatch(db: Db, limit: number, offset: number) {
  const userRows = await db
    .select({
      id: users.id,
      plan: users.plan,
      billing_cycle_start: users.billing_cycle_start,
      suspended_reason: users.suspended_reason,
    })
    .from(users)
    .orderBy(asc(users.id))
    .limit(limit)
    .offset(offset);

  if (userRows.length === 0) {
    return [];
  }

  const userIds = userRows.map((u) => u.id);
  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug, user_id: projects.user_id })
    .from(projects)
    .where(inArray(projects.user_id, userIds));

  const projectsByUser = new Map<string, typeof projectRows>();
  for (const p of projectRows) {
    const list = projectsByUser.get(p.user_id) ?? [];
    list.push(p);
    projectsByUser.set(p.user_id, list);
  }

  return userRows.map((user) => ({
    user,
    projects: projectsByUser.get(user.id) ?? [],
  }));
}

export async function getAllowlistEntryStatuses(
  db: Db,
  entries: ReadonlyArray<AllowlistEntry>,
): Promise<ReadonlyArray<AllowlistEntryStatus>> {
  if (entries.length === 0) {
    return [];
  }

  const exactEmails = Array.from(
    new Set(
      entries
        .filter((entry) => entry.type === 'email' && !entry.pattern.startsWith('*@'))
        .map((entry) => entry.pattern.toLowerCase()),
    ),
  );
  const emailDomains = Array.from(
    new Set(
      entries
        .filter((entry) => entry.type === 'email' && entry.pattern.startsWith('*@'))
        .map((entry) => entry.pattern.slice(1).toLowerCase()),
    ),
  );
  const githubLogins = Array.from(
    new Set(
      entries
        .filter((entry) => entry.type === 'github')
        .map((entry) => entry.pattern.toLowerCase()),
    ),
  );

  const userConditions = [
    exactEmails.length > 0 ? inArray(sql<string>`lower(${users.email})`, exactEmails) : undefined,
    githubLogins.length > 0
      ? and(eq(users.provider, 'github'), inArray(sql<string>`lower(${users.login})`, githubLogins))
      : undefined,
    ...emailDomains.map((domain) => sql`lower(${users.email}) like ${`%${domain}`}`),
  ].filter((condition) => condition !== undefined);

  const matchingUsers =
    userConditions.length > 0
      ? await db
          .select({
            id: users.id,
            provider: users.provider,
            login: users.login,
            email: users.email,
          })
          .from(users)
          .where(or(...userConditions))
      : [];

  const invitationConditions = [
    exactEmails.length > 0
      ? inArray(sql<string>`lower(${invitations.email})`, exactEmails)
      : undefined,
    ...emailDomains.map((domain) => sql`lower(${invitations.email}) like ${`%${domain}`}`),
  ].filter((condition) => condition !== undefined);

  const acceptedInvitations =
    invitationConditions.length > 0
      ? await db
          .select({ email: invitations.email })
          .from(invitations)
          .where(and(eq(invitations.status, 'accepted'), or(...invitationConditions)))
      : [];

  const matchingUserIds = matchingUsers.map((user) => user.id);
  const deployedUserRows =
    matchingUserIds.length > 0
      ? await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(projects, eq(projects.user_id, users.id))
          .innerJoin(deployments, eq(deployments.project_id, projects.id))
          .where(and(inArray(users.id, matchingUserIds), isNotNull(deployments.deployed_at)))
      : [];
  const deployedUserIds = new Set(deployedUserRows.map((row) => row.id));

  function userMatchesEntry(user: (typeof matchingUsers)[number], entry: AllowlistEntry): boolean {
    if (entry.type === 'github') {
      return user.provider === 'github' && user.login.toLowerCase() === entry.pattern.toLowerCase();
    }

    if (!user.email) {
      return false;
    }

    const email = user.email.toLowerCase();
    const pattern = entry.pattern.toLowerCase();
    return pattern.startsWith('*@') ? email.endsWith(pattern.slice(1)) : email === pattern;
  }

  function invitationMatchesEntry(email: string, entry: AllowlistEntry): boolean {
    if (entry.type !== 'email') {
      return false;
    }

    const normalizedEmail = email.toLowerCase();
    const pattern = entry.pattern.toLowerCase();
    return pattern.startsWith('*@')
      ? normalizedEmail.endsWith(pattern.slice(1))
      : normalizedEmail === pattern;
  }

  return entries.map((entry) => {
    const usersForEntry = matchingUsers.filter((user) => userMatchesEntry(user, entry));
    const hasAcceptedInvitation = acceptedInvitations.some((invitation) =>
      invitationMatchesEntry(invitation.email, entry),
    );

    return {
      ...entry,
      accepted: usersForEntry.length > 0 || hasAcceptedInvitation,
      deployed: usersForEntry.some((user) => deployedUserIds.has(user.id)),
    };
  });
}

export async function unsuspendUserIfReason(db: Db, id: string, reason: string): Promise<void> {
  await db
    .update(users)
    .set({ suspended_reason: null })
    .where(and(eq(users.id, id), eq(users.suspended_reason, reason)));
}

// --- Platform Events ---

export async function createPlatformEvent(
  db: Db,
  event: Omit<PlatformEvent, 'created_at'>,
): Promise<PlatformEvent> {
  const [row] = await db.insert(platformEvents).values(event).returning();
  return row;
}

export async function updatePlatformEventStatus(
  db: Db,
  id: string,
  status: PlatformEvent['status'],
  errorMessage?: string,
): Promise<void> {
  await db
    .update(platformEvents)
    .set({ status, error_message: errorMessage ?? null })
    .where(eq(platformEvents.id, id));
}

export async function skipPendingBatchEvents(db: Db, batchId: string): Promise<void> {
  await db
    .update(platformEvents)
    .set({ status: 'skipped' })
    .where(and(eq(platformEvents.batch_id, batchId), eq(platformEvents.status, 'pending')));
}

export async function getPlatformEventsByBatchId(
  db: Db,
  batchId: string,
): Promise<ReadonlyArray<PlatformEvent>> {
  return db
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.batch_id, batchId))
    .orderBy(asc(platformEvents.created_at));
}

export async function getRecentPlatformEvents(
  db: Db,
  environment: PlatformEvent['environment'],
  limit = 20,
): Promise<ReadonlyArray<PlatformEvent>> {
  return db
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.environment, environment))
    .orderBy(desc(platformEvents.created_at))
    .limit(limit);
}

// --- Invitations ---

export async function createInvitation(
  db: Db,
  email: string,
  invitedBy: string,
): Promise<Invitation> {
  const id = generateId('inv');
  const [row] = await db
    .insert(invitations)
    .values({ id, email: email.toLowerCase(), invited_by: invitedBy })
    .returning();
  return row;
}

export async function revokeInvitation(db: Db, id: string, revokedBy: string): Promise<boolean> {
  const rows = await db
    .update(invitations)
    .set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: revokedBy })
    .where(and(eq(invitations.id, id), eq(invitations.status, 'pending')))
    .returning({ id: invitations.id });
  return rows.length > 0;
}

export async function acceptInvitationByEmail(
  db: Db,
  email: string,
  userId: string,
): Promise<void> {
  await db
    .update(invitations)
    .set({ status: 'accepted', accepted_by: userId, accepted_at: sql`now()` })
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        eq(invitations.status, 'pending'),
      ),
    );
}

export async function getAllInvitations(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  ReadonlyArray<Invitation & { invited_by_login: string | null; revoked_by_login: string | null }>
> {
  const invitedByUser = alias(users, 'invited_by_user');
  const revokedByUser = alias(users, 'revoked_by_user');
  return db
    .select({
      ...getTableColumns(invitations),
      invited_by_login: invitedByUser.login,
      revoked_by_login: revokedByUser.login,
    })
    .from(invitations)
    .leftJoin(invitedByUser, eq(invitations.invited_by, invitedByUser.id))
    .leftJoin(revokedByUser, eq(invitations.revoked_by, revokedByUser.id))
    .orderBy(desc(invitations.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countInvitations(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(invitations);
  return result?.count ?? 0;
}

export async function getInvitation(db: Db, id: string): Promise<Invitation | null> {
  const [row] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
  return row ?? null;
}

export async function getPendingInvitationByEmail(
  db: Db,
  email: string,
): Promise<Invitation | null> {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, email.toLowerCase()), eq(invitations.status, 'pending')))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// oauth nonces
// ---------------------------------------------------------------------------

export async function storeOAuthNonce(db: Db, nonce: string, ttlSeconds: number): Promise<void> {
  await db
    .insert(oauthNonces)
    .values({ nonce, expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'` });
}

/** Atomically consume a nonce — returns true if it existed and was not expired. */
export async function consumeOAuthNonce(db: Db, nonce: string): Promise<boolean> {
  const rows = await db
    .delete(oauthNonces)
    .where(and(eq(oauthNonces.nonce, nonce), sql`expires_at > now()`))
    .returning({ nonce: oauthNonces.nonce });
  return rows.length > 0;
}

/** Delete expired nonces left behind by abandoned login flows. */
export async function purgeExpiredOAuthNonces(db: Db): Promise<void> {
  await db.delete(oauthNonces).where(sql`expires_at <= now()`);
}

// ---------------------------------------------------------------------------
// auth codes (dashboard login code exchange)
// ---------------------------------------------------------------------------

export async function storeAuthCode(
  db: Db,
  code: string,
  jwt: string,
  ttlSeconds: number,
  options?: {
    cliState?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  },
): Promise<void> {
  await db.insert(authCodes).values({
    code,
    jwt,
    cli_state: options?.cliState,
    code_challenge: options?.codeChallenge,
    code_challenge_method: options?.codeChallengeMethod,
    expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'`,
  });
}

/** Atomically consume an auth code — returns the JWT if valid, null otherwise. */
export async function consumeAuthCode(db: Db, code: string): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        isNull(authCodes.cli_state),
        isNull(authCodes.code_challenge),
        isNull(authCodes.code_challenge_method),
        sql`expires_at > now()`,
      ),
    )
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Atomically consume a CLI auth code after matching its PKCE challenge. */
export async function consumeCliAuthCode(
  db: Db,
  code: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        eq(authCodes.cli_state, state),
        eq(authCodes.code_challenge, codeChallenge),
        eq(authCodes.code_challenge_method, codeChallengeMethod),
        sql`expires_at > now()`,
      ),
    )
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Delete expired auth codes left behind by abandoned login flows. */
export async function purgeExpiredAuthCodes(db: Db): Promise<void> {
  await db.delete(authCodes).where(sql`expires_at <= now()`);
}

// ---------------------------------------------------------------------------
// builds
// ---------------------------------------------------------------------------

/**
 * Build statuses that count as "in-flight" for per-user concurrency limits.
 * A build occupies a concurrency slot once it has been claimed (`starting`)
 * through to the moment it stops (`complete`/`failed`/`cancelled`). `queued`
 * builds are NOT counted — they have not yet been assigned a slot.
 */
export const ACTIVE_BUILD_STATUSES: Array<Build['status']> = ['starting', 'building', 'deploying'];

export async function createBuild(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    executor?: Build['executor'];
    commitSha?: string | null;
    branch?: string | null;
    githubRunId?: string | null;
    githubRunAttempt?: string | null;
    logsUrl?: string | null;
    instanceType?: string | null;
    status?: Build['status'];
  },
): Promise<Build> {
  const id = generateId('bld');
  const [row] = await db
    .insert(builds)
    .values({
      id,
      project_id: args.projectId,
      user_id: args.userId,
      executor: args.executor ?? 'container',
      status: args.status ?? 'queued',
      commit_sha: args.commitSha ?? null,
      branch: args.branch ?? null,
      github_run_id: args.githubRunId ?? null,
      github_run_attempt: args.githubRunAttempt ?? null,
      logs_url: args.logsUrl ?? null,
      instance_type: args.instanceType ?? null,
    })
    .returning();
  return row;
}

export async function getBuild(db: Db, id: string): Promise<Build | null> {
  const [row] = await db.select().from(builds).where(eq(builds.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectBuilds(
  db: Db,
  projectId: string,
  limit = 20,
): Promise<ReadonlyArray<Build>> {
  return db
    .select()
    .from(builds)
    .where(eq(builds.project_id, projectId))
    .orderBy(desc(builds.created_at))
    .limit(limit);
}

export async function updateBuildStatus(
  db: Db,
  id: string,
  status: Build['status'],
  opts?: {
    error?: string | null;
    exitCode?: number | null;
    instanceType?: string | null;
    startedAt?: string;
    completedAt?: string;
    deploymentId?: string | null;
  },
): Promise<void> {
  await db
    .update(builds)
    .set({
      status,
      error: opts?.error === undefined ? sql`${builds.error}` : opts.error,
      exit_code: opts?.exitCode === undefined ? sql`${builds.exit_code}` : opts.exitCode,
      instance_type:
        opts?.instanceType === undefined ? sql`${builds.instance_type}` : opts.instanceType,
      started_at: opts?.startedAt === undefined ? sql`${builds.started_at}` : opts.startedAt,
      completed_at:
        opts?.completedAt === undefined ? sql`${builds.completed_at}` : opts.completedAt,
      deployment_id:
        opts?.deploymentId === undefined ? sql`${builds.deployment_id}` : opts.deploymentId,
    })
    .where(eq(builds.id, id));
}

/**
 * Set status='building' ONLY if the row is still 'starting'. Returns true if it
 * updated. Prevents a delayed onStart from resurrecting a row that a fast-exit
 * onStop already drove terminal.
 *
 * `instanceType` is the container's resolved size. The scheduler now persists it
 * in the same claim tx (`queued -> starting`), so this is an idempotent safety-net
 * re-write — folded into the same guarded CAS so it can never resurrect a terminal
 * row (matches `updateBuildStatus`'s "keep current unless provided" merge: omit →
 * keep, value/null → write).
 */
export async function markBuildBuildingIfStarting(
  db: Db,
  id: string,
  opts?: { instanceType?: string | null },
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({
      status: 'building',
      instance_type:
        opts?.instanceType === undefined ? sql`${builds.instance_type}` : opts.instanceType,
    })
    .where(and(eq(builds.id, id), eq(builds.status, 'starting')));
  return updatedRowCount(result) > 0;
}

/**
 * Return a build to 'queued' ONLY if it is still 'starting'. Returns true if it
 * updated. Used by the scheduler's capacity-shed retry AND the BuildManager
 * freshness-recheck retry: if a concurrent terminalizer (push-supersede,
 * branch/executor change, disconnect, install removal) already drove the claimed
 * row terminal, this no-ops and the terminal status is preserved — so a
 * superseded commit can't be resurrected and redeployed. Leaving `started_at`
 * stamped is harmless: the next claim re-stamps it.
 */
export async function requeueBuildIfStarting(db: Db, id: string): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({ status: 'queued' })
    .where(and(eq(builds.id, id), eq(builds.status, 'starting')));
  return updatedRowCount(result) > 0;
}

/**
 * Apply a TERMINAL status ONLY if the row is currently active
 * (starting/building/deploying). Returns true if it updated. Prevents a
 * duplicate/late lifecycle event from clobbering an earlier terminal outcome.
 */
export async function markBuildTerminalIfActive(
  db: Db,
  id: string,
  status: 'complete' | 'failed' | 'cancelled',
  opts?: {
    error?: string | null;
    exitCode?: number | null;
    completedAt?: string;
    deploymentId?: string | null;
  },
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({
      status,
      error: opts?.error === undefined ? sql`${builds.error}` : opts.error,
      exit_code: opts?.exitCode === undefined ? sql`${builds.exit_code}` : opts.exitCode,
      completed_at:
        opts?.completedAt === undefined ? sql`${builds.completed_at}` : opts.completedAt,
      deployment_id:
        opts?.deploymentId === undefined ? sql`${builds.deployment_id}` : opts.deploymentId,
    })
    .where(and(eq(builds.id, id), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
  return updatedRowCount(result) > 0;
}

/**
 * Persist the GitHub Check Run id created for this build — FIRST-WRITER-WINS,
 * immutable once set (CAS on `check_run_id IS NULL`). The container path's DO is
 * the sole writer, but the github_actions path's writer is the OIDC exchange
 * route, where two TRULY CONCURRENT exchanges for the same (project, run,
 * attempt) can both observe a null id during the create+persist window. The CAS
 * makes a persisted id immutable, so the second (racing) write no-ops rather than
 * clobbering the first — the DB keeps ONE stable, completion-tracked id. It does
 * NOT prevent the pathological second GitHub POST itself (a bounded, cosmetic
 * residual documented in `routes/auth-oidc.ts`).
 */
export async function setBuildCheckRunId(db: Db, id: string, checkRunId: string): Promise<void> {
  await db
    .update(builds)
    .set({ check_run_id: checkRunId })
    .where(and(eq(builds.id, id), isNull(builds.check_run_id)));
}

/**
 * Apply a non-terminal PROGRESS status ('building'|'deploying') ONLY while the
 * row is still active. Returns true if it updated. Prevents a forged/late agent
 * progress report from resurrecting a row a concurrent terminalizer (push-supersede,
 * disconnect, branch/executor change, app removal) already drove `cancelled` — which
 * would re-enable the bound deploy token (the deploy-token guard treats any ACTIVE
 * status as valid).
 */
export async function markBuildProgressIfActive(
  db: Db,
  id: string,
  status: 'building' | 'deploying',
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({ status })
    .where(and(eq(builds.id, id), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
  return updatedRowCount(result) > 0;
}

/**
 * Number of rows an UPDATE/DELETE touched, normalized across drivers: pg
 * (Hyperdrive, production) reports `rowCount`; PGlite (integration tests)
 * reports `affectedRows`. A guarded CAS must read whichever the active driver
 * provides — without this, a successful CAS reads as `undefined`/0 under PGlite
 * and the caller wrongly treats it as a no-op.
 */
function updatedRowCount(result: { rowCount?: number | null; affectedRows?: number }): number {
  return result.rowCount ?? result.affectedRows ?? 0;
}

/**
 * Count a user's in-flight builds (statuses `starting`/`building`/`deploying`).
 * Used by the scheduler to enforce per-user tier build concurrency before
 * claiming a queued build.
 */
export async function countUserActiveBuilds(db: Db, userId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(builds)
    .where(and(eq(builds.user_id, userId), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
  return result?.count ?? 0;
}

/**
 * The oldest queued container build for each project that has NO active build
 * (at most one row per project per tick). Only `container` builds are scheduled
 * by the platform — `github_actions` builds run on GitHub's runners and never
 * sit in this queue.
 *
 * Fixes starvation: per-project serialization is enforced at claim time
 * (`claimBuildForStartWithinLimit` refuses to start a build if its project
 * already has an active build), so surfacing rows for an already-active project
 * just wastes the scan window and HIDES other projects' startable builds. The
 * correlated `NOT EXISTS` excludes any project with an active build, and one
 * row per idle project (its oldest queued build) is returned — so a genuinely
 * startable build is never starved behind a blocked one.
 *
 * Fixes per-user-cap starvation: the per-user concurrency cap is
 * plan-derived (TypeScript, not a DB column), so it is NOT enforced in SQL
 * here. Instead the scheduler computes which users are AT their cap and passes
 * those ids in `excludeUserIds`, so this scan never wastes its window on rows
 * the claim step would only reject. Without it, the lowest-`project_id` rows of
 * a capped tenant would fill the scan limit every tick and indefinitely delay
 * an unrelated under-cap tenant's builds.
 *
 * Ordering is AGE-FAIR: the outer query sorts by `created_at asc` (oldest
 * waiting work first) and applies `limit`, instead of the old
 * lowest-`project_id`-first order which let a low-id project monopolize the
 * scan window. Because `DISTINCT ON (project_id)` requires `project_id` to lead
 * its ORDER BY, the per-project "oldest queued build" pick is computed in an
 * inner subquery (`DISTINCT ON (project_id) ... ORDER BY project_id,
 * created_at asc`), then the OUTER query re-sorts those rows by `created_at asc`
 * and limits — surfacing the globally oldest-waiting startable builds.
 *
 * NOTE: this can return `[]` while queued builds still exist (all their
 * projects are active, or all their owners are capped). The scheduler's
 * reschedule recheck must therefore key its heartbeat off
 * `hasQueuedContainerBuilds` (any queued row), not off this function, so a
 * blocked-but-present queue keeps an alarm armed until a project frees or an
 * owner drops below their cap.
 */
export async function getQueuedBuilds(
  db: Db,
  limit = 50,
  excludeUserIds: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<Build>> {
  // Inner: each idle project's OLDEST queued container build. DISTINCT ON
  // requires its column (`project_id`) to lead the ORDER BY, so age fairness
  // can't be expressed here — it is applied by the outer query below.
  const oldestPerProject = db
    .selectDistinctOn([builds.project_id])
    .from(builds)
    .where(
      and(
        eq(builds.status, 'queued'),
        eq(builds.executor, 'container'),
        // Exclude projects that already have an active build (per-project
        // serialization is enforced at claim time; surfacing blocked rows just
        // wastes the scan window and hides other projects' startable builds).
        sql`not exists (
          select 1 from ${builds} as active_builds
          where active_builds.project_id = ${builds.project_id}
            and active_builds.status in ('starting', 'building', 'deploying')
        )`,
        // Skip rows owned by users the scheduler has computed to be AT their
        // plan's concurrency cap — the claim step would only reject them, and
        // surfacing them wastes the scan window (cap is plan-derived, so the
        // exclude set is computed in TS, never as a tier number in SQL). Omit
        // the clause entirely when empty: `NOT IN ()` is invalid SQL.
        excludeUserIds.length > 0 ? notInArray(builds.user_id, [...excludeUserIds]) : undefined,
      ),
    )
    .orderBy(builds.project_id, asc(builds.created_at))
    .as('oldest_per_project');

  // Outer: re-sort the per-project candidates oldest-first and limit, so the
  // scan surfaces the globally oldest-waiting startable builds rather than the
  // lowest project_ids.
  return db.select().from(oldestPerProject).orderBy(asc(oldestPerProject.created_at)).limit(limit);
}

/**
 * For each user that owns at least one QUEUED container build, returns their
 * plan plus the count of their builds currently in `ACTIVE_BUILD_STATUSES`
 * (`starting`/`building`/`deploying`). The scheduler uses this to decide which
 * owners are AT their plan's concurrency cap (cap is plan-derived in
 * `getPlanLimits`, NOT a DB column) and pass those ids to `getQueuedBuilds` as
 * `excludeUserIds`, so a capped tenant's rows never starve the scan window.
 *
 * Only `container` builds gate scheduling, so the queued-work filter is scoped
 * to that executor. The active-build count is NOT executor-scoped: an active
 * `github_actions` build also occupies a concurrency slot (mirroring
 * `claimBuildForStartWithinLimit`'s per-user count), so it must count toward the
 * cap.
 */
export async function getUsersWithQueuedContainerBuilds(
  db: Db,
): Promise<ReadonlyArray<{ userId: string; plan: string; activeBuilds: number }>> {
  const rows = await db
    .select({
      userId: users.id,
      plan: users.plan,
      // Correlated count of this user's in-flight builds (any executor). The
      // FILTER over a LEFT JOIN keeps users whose only builds are queued
      // (activeBuilds = 0) in the result.
      activeBuilds: sql<number>`count(${builds.id}) filter (
        where ${inArray(builds.status, ACTIVE_BUILD_STATUSES)}
      )`,
    })
    .from(users)
    .innerJoin(
      // Restrict to users who own at least one queued container build — the
      // only work this scan can ever start.
      sql`(
        select distinct ${builds.user_id} as user_id from ${builds}
        where ${builds.status} = 'queued' and ${builds.executor} = 'container'
      ) as queued_owners`,
      sql`queued_owners.user_id = ${users.id}`,
    )
    .leftJoin(builds, eq(builds.user_id, users.id))
    .groupBy(users.id, users.plan);
  return rows.map((r) => ({
    userId: r.userId,
    plan: r.plan,
    activeBuilds: Number(r.activeBuilds),
  }));
}

/**
 * Whether ANY queued container build exists (regardless of whether its project
 * is currently active). The build scheduler uses this for its reschedule
 * recheck: `getQueuedBuilds` can return `[]` while queued builds are merely
 * blocked behind active projects, so keying the heartbeat off this guarantees
 * the alarm stays armed until a project frees and the build becomes startable.
 */
export async function hasQueuedContainerBuilds(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.status, 'queued'), eq(builds.executor, 'container')))
    .limit(1);
  return row !== undefined;
}

/**
 * Supersede older queued container builds when a newer push arrives for the
 * same project+branch, so the newest commit wins instead of whichever build
 * happens to finish last. Only QUEUED rows are cancelled — already-running
 * builds are left alone (cancelling them would waste in-flight compute).
 */
export async function cancelQueuedBuildsForProjectBranch(
  db: Db,
  projectId: string,
  branch: string,
): Promise<void> {
  await db
    .update(builds)
    .set({ status: 'cancelled', error: 'superseded by newer push', completed_at: sql`now()` })
    .where(
      and(
        eq(builds.project_id, projectId),
        eq(builds.branch, branch),
        eq(builds.status, 'queued'),
        eq(builds.executor, 'container'),
      ),
    );
}

/**
 * The newest non-terminal (queued/starting/building/deploying) container build
 * for this exact commit on this project+branch, or null. Used to make webhook
 * redelivery idempotent — a redelivered push for a commit already in flight
 * must not create a duplicate build.
 */
export async function findNonTerminalBuildForCommit(
  db: Db,
  projectId: string,
  branch: string,
  commitSha: string,
): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.project_id, projectId),
        eq(builds.branch, branch),
        eq(builds.commit_sha, commitSha),
        inArray(builds.status, ['queued', 'starting', 'building', 'deploying']),
        eq(builds.executor, 'container'),
      ),
    )
    .orderBy(desc(builds.created_at))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically supersede older queued container builds and enqueue a new one for
 * a push, under a per-project FOR UPDATE lock so concurrent webhook deliveries
 * for the same project+branch can't interleave their supersede+create steps
 * (which previously let an older push cancel a newer queued build and then
 * enqueue the older commit). Semantics are LAST-PROCESSED-WINS — the honest
 * guarantee for unordered webhooks; the GitHub push payload carries no reliable
 * commit-ordering signal, so true latest-commit-wins under out-of-order delivery
 * of DIFFERENT commits is intentionally NOT attempted.
 *
 * Reuse vs. rebuild for this EXACT commit on this project+branch:
 *   - An ACTIVE build (queued/starting/building/deploying) is ALWAYS reused
 *     (in-flight idempotency for a redelivered push).
 *   - A `complete` build is reused ONLY when this commit is what the project is
 *     CURRENTLY LIVE ON (a true webhook redelivery). If the live deployment is a
 *     DIFFERENT commit — a force-push ROLLBACK to a previously-deployed SHA
 *     (deploy A, deploy B, force-push branch back to A) — the old `complete`
 *     build is NOT reused; a fresh `queued` build is enqueued so the rollback
 *     actually re-deploys A. "Live is this commit" is decided inside the same
 *     transaction under the project lock: prefer the authoritative
 *     `builds.deployment_id == projects.active_deployment_id` link, falling back
 *     to `deployments.commit == args.commitSha`. Container builds record NEITHER
 *     (`deployment_id` and `deployments.commit` are both NULL for the default
 *     executor), so a complete-SHA push that can't be PROVEN live conservatively
 *     rebuilds — at worst a redundant rebuild of an identical commit, never a
 *     missed rollback.
 *   - A prior `failed`/`cancelled` build does NOT block a new one, so re-pushing
 *     a commit after a failed build still retries.
 *
 * Conflicting active builds are ALWAYS terminated first — before the reuse
 * lookup — so this holds even on a `complete`-SHA reuse/rebuild: a force-push
 * ROLLBACK to a previously-deployed SHA still cancels any newer in-flight build
 * for the now-off-branch commit (which would otherwise keep a live deploy token
 * and publish the stale newer commit). `exceptCommitSha` spares this push's own
 * commit, so a same-commit redelivery still dedups with `cancelled: []` and
 * never self-cancels.
 *
 * Serializes against a concurrent `PATCH /projects/:id/github` (which locks
 * `github_connections`, can re-point the branch / switch executor, and
 * terminates old-config builds). After taking the project lock, this LOCKS and
 * RE-READS the project's single `github_connections` row (the column is UNIQUE
 * per project) and rejects — returning `{ build: null, skipped: 'config-changed' }`
 * with `cancelled: []` — when the connection no longer matches this push's
 * branch or its executor is no longer `container`. Either ordering is safe: a
 * PATCH that committed first is observed here (we see the new config and skip);
 * if we committed first, the PATCH's own terminate step (it holds the same lock)
 * catches the build we just enqueued. Lock order is projects -> github_connections
 * (no path inverts it), so no deadlock. This closes the gap where an orphan
 * queued build for a now-disabled branch/executor escaped both the scheduler and
 * the JIT freshness gate.
 */
/**
 * Re-check, INSIDE a build-creation transaction, that the GitHub App installation
 * still grants access to the repo. Both build txns already hold a `FOR UPDATE`
 * lock on the `github_connections` row, which serializes against the revocation
 * webhooks (App suspend/uninstall, repo removal) — they lock the same connection
 * rows BEFORE flipping `github_installations` status / repo set. So a PLAIN
 * (non-locking) read here, under READ COMMITTED, observes the committed
 * installation state: a revocation that committed AFTER the resolver's checks but
 * BEFORE this tx is caught. The same lock order in both paths means no deadlock,
 * and the plain read avoids any lock-order concern on `github_installations`.
 *
 * FAILS CLOSED: returns false unless the row exists AND `status === 'active'` AND
 * the repo is still in the install's selection — an `all`-repos install grants
 * every repo (membership not enforced, so the repo id is irrelevant), a `selected`
 * install requires the repo's immutable numeric id to be in the cached set. A null
 * `repositoryId` fails closed for a `selected` install (membership unprovable by
 * id) but an active `all` install still grants coverage. Mirrors the membership
 * predicate in `getGitHubActionsConnectionsByRepo` / `getGitHubConnectionsByRepo`.
 */
async function installationCoversRepoInTx(
  tx: Db,
  installationId: string,
  repositoryId: string | null,
): Promise<boolean> {
  // An `all`-repos install grants every repo regardless of id; only a `selected`
  // install needs the immutable numeric id in the cached set, so a null repo id
  // can't match there and fails closed via the `false` arm below. Checking null
  // BEFORE the `all` branch (the old unconditional `return false`) wrongly treated
  // a legacy null-id connection on an `all` install as install-revoked.
  const [row] = await tx
    .select({
      status: githubInstallations.status,
      repository_selection: githubInstallations.repository_selection,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'active'),
        or(
          eq(githubInstallations.repository_selection, 'all'),
          repositoryId === null
            ? sql`false`
            : sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Non-transaction sibling of `installationCoversRepoInTx`: a fresh, plain
 * (non-locking) read that the GitHub App installation still grants access to the
 * repo. Identical fail-closed predicate — returns false unless the
 * `github_installations` row exists AND `status === 'active'` AND the repo is
 * still in the install's selection (`repository_selection === 'all'`, or the
 * immutable numeric repo id is in the cached `repositories` set). A null
 * `repositoryId` fails closed for a `selected` install (membership unprovable by
 * id) but an active `all` install still grants coverage (id irrelevant).
 *
 * Used by the container `BuildManager.startBuild` to re-verify coverage at token
 * mint, AFTER a queue wait during which an uninstall/suspension/repo-removal
 * webhook may have committed an update to the row (a TOCTOU the enqueue-time
 * `installationCoversRepoInTx` check can't catch). Under READ COMMITTED this
 * plain read observes that committed revocation, so the build fails closed
 * before minting a deploy token.
 */
export async function installationCoversRepo(
  db: Db,
  installationId: string,
  repositoryId: string | null,
): Promise<boolean> {
  // An `all`-repos install grants every repo regardless of id; only a `selected`
  // install needs the immutable numeric id in the cached set, so a null repo id
  // can't match there and fails closed via the `false` arm below. Checking null
  // BEFORE the `all` branch (the old unconditional `return false`) wrongly treated
  // a legacy null-id connection on an `all` install as install-revoked.
  const [row] = await db
    .select({
      status: githubInstallations.status,
      repository_selection: githubInstallations.repository_selection,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'active'),
        or(
          eq(githubInstallations.repository_selection, 'all'),
          repositoryId === null
            ? sql`false`
            : sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function supersedeAndCreateContainerBuild(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    branch: string;
    commitSha: string;
    connectionId: string;
    installationId: string;
    repositoryId: string | null;
    /**
     * Container size of record for this build, resolved from the owner's plan at
     * enqueue (`getBuildInstanceType`). Persisted on the row so START routes to
     * the matching DO namespace deterministically; omit/null leaves a legacy-null
     * row that START recomputes from the plan.
     */
    instanceType?: string | null;
  },
): Promise<{
  build: Build | null;
  reused: boolean;
  cancelled: ReadonlyArray<{
    id: string;
    executor: Build['executor'];
    status: Build['status'];
    instance_type: string | null;
  }>;
  skipped?: 'config-changed' | 'install-revoked' | 'connection-replaced' | 'project-deleting';
}> {
  return db.transaction(async (tx) => {
    // Serialize all push processing for this project (project<->branch is 1:1 via
    // the unique github_connections.project_id; the project row always exists),
    // and re-read its status under the lock. teardownProject's lockAndMarkDeleting
    // takes the SAME projects FOR UPDATE then flips status='deleting' before the
    // later cascade deletes the connection; a push landing in that window would
    // otherwise enqueue a container build for a project being torn down — burning
    // a scarce build slot (the scheduler + JIT recheck don't reject deleting
    // projects; only the cascade's terminate eventually cancels it). Mirror the
    // GitHub Actions path (createGithubActionsBuildWithinLimit) and skip instead.
    // Lock order is unchanged (projects-first), so the round-4 40P01 class stays
    // closed.
    const [proj] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .for('update')
      .limit(1);
    if (!proj || proj.status === 'deleting') {
      return { build: null, reused: false, cancelled: [], skipped: 'project-deleting' };
    }

    // Serialize against PATCH /projects/:id/github: lock + re-read the single
    // connection (project_id is UNIQUE). If a concurrent config change committed
    // first, the row's branch/executor no longer matches this push — skip rather
    // than enqueue an orphan build for a now-disabled branch/executor that neither
    // the scheduler nor the JIT freshness gate would catch. The PATCH holds the
    // same lock and its terminate step handles old-build cleanup, so we return
    // `cancelled: []` here.
    const [conn] = await tx
      .select({
        id: githubConnections.id,
        branch: githubConnections.branch,
        executor: githubConnections.build_executor,
      })
      .from(githubConnections)
      .where(eq(githubConnections.project_id, args.projectId))
      .for('update')
      .limit(1);
    if (!conn || conn.branch !== args.branch || conn.executor !== 'container') {
      return { build: null, reused: false, cancelled: [], skipped: 'config-changed' };
    }

    // Assert the locked connection is the SAME row the caller resolved. project_id
    // is UNIQUE, so a disconnect+reconnect to a DIFFERENT repo (same branch/executor)
    // DELETEs the old row and CREATEs a new one with a fresh id between resolution and
    // this tx. The branch/executor guard above and the install check below both pass
    // for such a swap (the install check keys on the PASSED installationId), so the
    // id-match is the only guard that catches a cross-repo swap — without it the old
    // repo's push would enqueue a build + mint a deploy token for a project now bound
    // to a different repo. The reconnect/disconnect already terminalized old builds
    // under its own lock, so `cancelled: []` is correct.
    if (conn.id !== args.connectionId) {
      return { build: null, reused: false, cancelled: [], skipped: 'connection-replaced' };
    }

    // Re-check installation status + repo membership under the connection lock.
    // The push resolver checked the install at resolve time, but a revocation
    // (App suspend/uninstall, repo removal) can commit AFTER that check and BEFORE
    // this tx — within the installation-token cache window — and would otherwise
    // enqueue a build + mint a deploy token for a now-revoked install. The
    // revocation webhooks lock these same connection rows FIRST, so this plain
    // read (under READ COMMITTED) sees their committed status. Fails closed.
    if (
      !(await installationCoversRepoInTx(
        tx as unknown as Db,
        args.installationId,
        args.repositoryId,
      ))
    ) {
      return { build: null, reused: false, cancelled: [], skipped: 'install-revoked' };
    }

    // Supersede older queued AND active (starting/building/deploying) container
    // builds for this branch whose commit is NOT the new head — FIRST, before the
    // dedup/reuse lookup, so it runs even when this push reuses an already-`complete`
    // build. This closes the rollback gap: a force-push BACK to a previously-deployed
    // SHA reuses the old `complete` build, but a newer in-flight build for the
    // now-off-branch commit must still be cancelled — otherwise it keeps a live
    // deploy token (the final guard only checks active+project, not freshness) and
    // would publish the stale newer commit. `exceptCommitSha` spares this push's own
    // commit (so a same-commit redelivery never self-cancels and returns
    // `cancelled: []` when nothing else conflicts); the `branch` filter spares other
    // branches.
    const cancelled = await terminateBuildsForProject(tx as unknown as Db, args.projectId, {
      branch: args.branch,
      executor: 'container',
      exceptCommitSha: args.commitSha,
      reason: 'superseded by newer push',
    });

    // (a) active in-flight build for this commit → always reuse.
    const [activeExisting] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.project_id, args.projectId),
          eq(builds.branch, args.branch),
          eq(builds.commit_sha, args.commitSha),
          eq(builds.executor, 'container'),
          inArray(builds.status, ['queued', 'starting', 'building', 'deploying']),
        ),
      )
      .orderBy(desc(builds.created_at))
      .limit(1);
    if (activeExisting) {
      // Re-stamp created_at to now() on reuse, so a concurrent branch-delete fence
      // captured BEFORE this push cannot cancel a build this push just re-adopted.
      // The branch-delete path cancels active builds with created_at <= a fence it
      // sampled before confirming the branch absent. On a SAME-SHA recreate (delete
      // then recreate at the same commit), this reuse path returns the pre-existing
      // active row instead of inserting a fresh one — so without re-stamping, the
      // reused row keeps its pre-fence created_at and a delete that interleaves AFTER
      // this push (it lost the connection FOR UPDATE race) would wrongly terminalize
      // a valid build. Bumping created_at makes the row post-fence, closing that
      // TOCTOU. Safe for every other consumer: the container reaper keys on
      // started_at (not created_at), the github_actions reaper filters
      // executor != container, and the dedup lookups order by created_at desc (this
      // row stays newest, which is correct — it is the current build for the commit).
      const [refreshed] = await tx
        .update(builds)
        .set({ created_at: sql`now()` })
        .where(eq(builds.id, activeExisting.id))
        .returning();
      return { build: refreshed ?? activeExisting, reused: true, cancelled };
    }

    // (b) completed build for this commit → reuse only if this commit is already live.
    const [completeExisting] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.project_id, args.projectId),
          eq(builds.branch, args.branch),
          eq(builds.commit_sha, args.commitSha),
          eq(builds.executor, 'container'),
          eq(builds.status, 'complete'),
        ),
      )
      .orderBy(desc(builds.created_at))
      .limit(1);
    if (completeExisting) {
      const [proj] = await tx
        .select({ active: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, args.projectId))
        .limit(1);
      let liveIsThisCommit = false;
      if (proj?.active) {
        if (completeExisting.deployment_id && completeExisting.deployment_id === proj.active) {
          liveIsThisCommit = true;
        } else {
          const [dep] = await tx
            .select({ commit: deployments.commit })
            .from(deployments)
            .where(eq(deployments.id, proj.active))
            .limit(1);
          liveIsThisCommit = dep?.commit != null && dep.commit === args.commitSha;
        }
      }
      if (liveIsThisCommit) {
        return { build: completeExisting, reused: true, cancelled };
      }
      // else: rollback — fall through to insert a fresh queued build.
    }

    const id = generateId('bld');
    const [row] = await tx
      .insert(builds)
      .values({
        id,
        project_id: args.projectId,
        user_id: args.userId,
        executor: 'container',
        status: 'queued',
        commit_sha: args.commitSha,
        branch: args.branch,
        instance_type: args.instanceType ?? null,
      })
      .returning();
    return { build: row, reused: false, cancelled };
  });
}

/**
 * Atomically claim a queued build for starting. The `WHERE id=? AND
 * status='queued'` guard plus `RETURNING` removes the read-then-write race:
 * only one caller can flip a given build out of `queued`, so two schedulers
 * racing the same build will see exactly one non-null return. Stamps
 * `started_at` at claim time.
 */
export async function claimBuildForStart(db: Db, id: string): Promise<Build | null> {
  const [row] = await db
    .update(builds)
    .set({ status: 'starting', started_at: sql`now()` })
    .where(and(eq(builds.id, id), eq(builds.status, 'queued')))
    .returning();
  return row ?? null;
}

/**
 * Look up a build by its owning project and the GitHub Actions `workflow_run.id`
 * recorded on the row at OIDC-exchange time. A GitHub `run_id` is unique only
 * WITHIN a repository, not globally, so build identity is scoped to the
 * connection's project: matching by `run_id` alone would let a `workflow_run`
 * webhook (or an OIDC reuse lookup) from one repo resolve a different project's
 * build that happens to share the numeric id. Used by the `workflow_run`
 * webhook (after resolving the connection by repo) to mark an Actions build
 * complete/failed, and by the OIDC exchange to reuse an in-flight build.
 *
 * A GitHub RERUN of the same `run_id` creates a fresh build once the prior
 * attempt is terminal, so a (project, run_id) can have multiple rows (one
 * active rerun + older terminal attempts). Active builds are ordered first so
 * the `workflow_run` webhook finalizes the in-flight rerun rather than an old
 * terminal row even when `created_at` ties; `created_at desc` breaks ties
 * within each group.
 */
export async function getBuildByProjectAndRunId(
  db: Db,
  projectId: string,
  githubRunId: string,
): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.project_id, projectId), eq(builds.github_run_id, githubRunId)))
    .orderBy(sql`(${inArray(builds.status, ACTIVE_BUILD_STATUSES)}) desc`, desc(builds.created_at))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a build by `(project, run_id, run_attempt)` — the attempt-aware
 * counterpart of `getBuildByProjectAndRunId`. A GitHub RERUN reuses the same
 * `run_id` with an incremented `run_attempt`, so the `workflow_run` completion
 * handler must scope to the attempt: a redelivered/late completion for attempt
 * 1 must NOT resolve to attempt 2's active build (which would let it finalize
 * the wrong attempt). When `githubRunAttempt` is null (an old delivery whose
 * payload lacks `run_attempt`), it falls back to `IS NULL` so old null-attempt
 * rows still match. Active builds are ordered first (then `created_at desc`),
 * mirroring `getBuildByProjectAndRunId`, so the in-flight attempt wins on a tie.
 */
export async function getBuildByProjectRunIdAndAttempt(
  db: Db,
  projectId: string,
  githubRunId: string,
  githubRunAttempt: string | null,
): Promise<Build | null> {
  const attemptMatch =
    githubRunAttempt != null
      ? eq(builds.github_run_attempt, githubRunAttempt)
      : isNull(builds.github_run_attempt);
  const [row] = await db
    .select()
    .from(builds)
    .where(
      and(eq(builds.project_id, projectId), eq(builds.github_run_id, githubRunId), attemptMatch),
    )
    .orderBy(sql`(${inArray(builds.status, ACTIVE_BUILD_STATUSES)}) desc`, desc(builds.created_at))
    .limit(1);
  return row ?? null;
}

/**
 * Terminalize every ACTIVE (`starting`/`building`/`deploying`) GitHub Actions
 * build for a project, marking them `cancelled` and stamping `completed_at`.
 *
 * Called when a project's GitHub connection is deleted. GitHub Actions builds
 * are created ACTIVE by the OIDC exchange and finalized by the `workflow_run`
 * webhook, which first resolves the CURRENT connection — so if the connection
 * is gone, a completion webhook is ignored and the build would stay active
 * forever, permanently consuming one of the owner's concurrency slots. Scoped
 * to `executor = 'github_actions'`: container builds free their slot via the
 * BuildManager DO timeout and must not be touched here. Returns the number of
 * builds terminalized.
 */
export async function terminateActiveGithubActionsBuildsForProject(
  db: Db,
  projectId: string,
): Promise<number> {
  const result = await db
    .update(builds)
    .set({
      status: 'cancelled',
      error: sql`COALESCE(${builds.error}, 'github connection removed')`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(
      and(
        eq(builds.project_id, projectId),
        eq(builds.executor, 'github_actions'),
        inArray(builds.status, ACTIVE_BUILD_STATUSES),
      ),
    );
  return result.rowCount ?? 0;
}

/**
 * Terminalize (cancel) a project's QUEUED + ACTIVE builds, optionally filtered
 * by branch and/or executor. Used when a connection is disconnected or its
 * branch/executor changes, so in-flight builds for the old config can't keep a
 * live deploy token (the middleware guard rejects a token whose bound
 * build is no longer active). Returns the cancelled builds (id + executor +
 * prior status) so the caller can best-effort stop active container BuildManager
 * DOs.
 */
export async function terminateBuildsForProject(
  db: Db,
  projectId: string,
  opts?: {
    branch?: string;
    executor?: Build['executor'];
    exceptCommitSha?: string;
    reason?: string;
    // Only terminalize builds created at or before this timestamp. Used by the
    // branch-delete path as a monotonic fence: the caller confirms the branch is
    // absent, then cancels — but a build enqueued in that window (a branch
    // recreated + pushed before this UPDATE runs) is created AFTER the fence and
    // must survive. Without it, a stale/out-of-order delete could clobber a fresh
    // valid build for the recreated branch. The caller MUST source this from the
    // database clock (`select now()`), the same clock that stamps `created_at`, so
    // the two are never compared across independent (Worker vs Postgres) clocks.
    // The boundary is inclusive (`<=`): a build whose created_at lands exactly on
    // the fence existed when absence-checking began and is an orphan, so cancel it
    // — a recreate-race build is always created strictly after the fence. Compared
    // as an absolute instant (`::timestamptz`): `created_at` is `timestamp without
    // time zone`, so a naive compare against a UTC `...Z` string drops the offset
    // and misfires under any non-UTC session timezone.
    createdBefore?: string;
  },
): Promise<
  ReadonlyArray<{
    id: string;
    executor: Build['executor'];
    status: Build['status'];
    instance_type: string | null;
  }>
> {
  const conds = [
    eq(builds.project_id, projectId),
    inArray(builds.status, ['queued', 'starting', 'building', 'deploying']),
  ];
  if (opts?.branch !== undefined) {
    conds.push(eq(builds.branch, opts.branch));
  }
  if (opts?.executor !== undefined) {
    conds.push(eq(builds.executor, opts.executor));
  }
  if (opts?.exceptCommitSha !== undefined) {
    conds.push(ne(builds.commit_sha, opts.exceptCommitSha));
  }
  if (opts?.createdBefore !== undefined) {
    conds.push(sql`${builds.created_at} <= ${opts.createdBefore}::timestamptz`);
  }
  const affected = await db
    .update(builds)
    .set({
      status: 'cancelled',
      error: sql`COALESCE(${builds.error}, ${opts?.reason ?? 'connection changed'})`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(and(...conds))
    .returning({
      id: builds.id,
      executor: builds.executor,
      status: builds.status,
      // Carried out so the post-commit DO teardown can address the SAME
      // container-size namespace the scheduler started this build on
      // (`buildManagerNamespace`); a paid (standard-4) build cancelled against
      // the base namespace would miss its live container.
      instance_type: builds.instance_type,
    });
  return affected;
}

/**
 * Fail GitHub Actions builds stuck ACTIVE beyond `maxAgeMinutes` (measured from
 * `created_at`). A missed `workflow_run` completion webhook — or a disconnect
 * mid-run that a reaper tick raced — would otherwise leave an Actions build
 * active forever, permanently consuming a concurrency slot. Scoped to
 * `executor = 'github_actions'`: container builds are reaped by their own
 * BuildManager DO timeout, so they're intentionally excluded here. Marks them
 * `failed` and stamps `completed_at`. Returns the number of builds failed.
 */
export async function failStaleActiveGithubActionsBuilds(
  db: Db,
  maxAgeMinutes: number,
): Promise<number> {
  const result = await db
    .update(builds)
    .set({
      status: 'failed',
      error: sql`COALESCE(${builds.error}, 'build timed out')`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(
      and(
        eq(builds.executor, 'github_actions'),
        inArray(builds.status, ACTIVE_BUILD_STATUSES),
        sql`${builds.created_at} < now() - (${maxAgeMinutes} * interval '1 minute')`,
      ),
    );
  return result.rowCount ?? 0;
}

/**
 * Fail container builds stuck ACTIVE beyond `maxAgeMinutes` (measured from
 * `started_at`, NOT `created_at`). DB-only backstop for the BuildManager DO:
 * the timeout/cancel path tears down the container and pokes the scheduler
 * INDEPENDENT of the Postgres terminal-status write, so if `markBuildTerminalIfActive`
 * throws (Hyperdrive/Postgres transient failure) the row stays ACTIVE forever —
 * permanently consuming the owner's concurrency slot, blocking the project's
 * queue (`claimBuildForStartWithinLimit` / `getQueuedBuilds`), and honoring the
 * bound deploy token until JWT expiry. The github_actions reaper above
 * intentionally excludes container builds on the assumption their DO timeout
 * reaps them; this covers exactly the case that assumption violates.
 *
 * Age is keyed off `started_at` (stamped at claim by `claimBuildForStartWithinLimit`
 * and never cleared) because a container build can sit `queued` a long time
 * (up to ~30 min under capacity backoff) before starting — `created_at` would
 * risk reaping a build that hasn't started yet. A null `started_at` never
 * matches the `<` comparison, so queued/unstarted rows are implicitly guarded.
 *
 * The DB terminalize is the AUTHORITATIVE slot-freeing + token-revoking action:
 * it frees all three concurrency gates and (within TTL) revokes the bound deploy
 * token even if the DO is unreachable — that is the whole point of this backstop.
 * The motivating case (timeout path stopped the container before its failed DB
 * write threw) leaves no live container, so the DB write alone suffices. But the
 * `started_at > maxAge` predicate does NOT prove the container is gone: if the DO
 * was evicted or its timeout alarm was lost, the container may still be RUNNING.
 * So the caller best-effort issues a BuildManager `cancelBuild` for each returned
 * build AFTER this commits — stopping any still-alive orphan and converging
 * DO-local status. Returning the reaped builds (not just a count) is what enables
 * that, and each carries its `instance_type` so the cancel addresses the SAME
 * container-size namespace the scheduler started it on (`buildManagerNamespace`):
 * a paid (standard-4) build cancelled against the base namespace would miss its
 * live container. Executor is implicitly `container` (this reaper is scoped to it).
 *
 * Marks them `failed` and stamps `completed_at`. Returns the reaped builds.
 */
export async function failStaleActiveContainerBuilds(
  db: Db,
  maxAgeMinutes: number,
): Promise<ReadonlyArray<{ id: string; instance_type: string | null }>> {
  const rows = await db
    .update(builds)
    .set({
      status: 'failed',
      error: sql`COALESCE(${builds.error}, 'build exceeded max lifetime (stale reaper)')`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(
      and(
        eq(builds.executor, 'container'),
        inArray(builds.status, ACTIVE_BUILD_STATUSES),
        sql`${builds.started_at} < now() - (${maxAgeMinutes} * interval '1 minute')`,
      ),
    )
    .returning({ id: builds.id, instance_type: builds.instance_type });
  return rows;
}

/**
 * Atomically acquire a per-user build slot for a GitHub Actions `run_id` and
 * create the `building` row, all under a single transaction that holds a
 * `SELECT … FOR UPDATE` lock on the owner's `users` row.
 *
 * The previous count-then-insert flow (count active builds, then insert in a
 * SEPARATE op) was race-prone: two parallel OIDC exchanges for DIFFERENT
 * `run_id`s could each read capacity below the cap before either inserted, then
 * both insert — bypassing `concurrentBuilds`. The composite partial-unique
 * index only guards the SAME `run_id`, not the cross-run capacity check.
 *
 * Serializing slot acquisition per user (FOR UPDATE on the user row, mirroring
 * the deploy/migration FOR UPDATE pattern) closes that window: the second
 * exchange blocks until the first commits, then observes the updated count.
 *
 * Idempotent reuse of an already-ACTIVE build for the same `(project, run_id)`
 * neither counts against the cap nor double-inserts. `limit <= 0` means
 * unlimited. Returns `{ outcome: 'limit-exceeded' }` (no insert) when a NEW run
 * would exceed the cap; the caller maps that to 429.
 *
 * Per-project latest-wins supersede: after the idempotent same-run reuse check,
 * a NEWER run for the same project+branch (a DIFFERENT `run_id`) supersedes
 * older active Actions builds — marking them terminal so they free the owner's
 * concurrency slot and can't race `void deploy` for the project (the GitHub
 * Actions executor has no per-project active-build serialization like the
 * container scheduler's `claimBuildForStartWithinLimit`).
 */
export async function createGithubActionsBuildWithinLimit(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    limit: number;
    commitSha?: string | null;
    branch?: string | null;
    githubRunId: string;
    githubRunAttempt?: string | null;
    logsUrl?: string | null;
    connectionId: string;
    installationId: string;
    repositoryId: string | null;
    // The authorized workflow path the OIDC gate matched (the token's own
    // workflow file). Re-checked under the connection lock so a concurrent
    // PATCH that re-pins `workflow_path` can't let a now-de-authorized workflow
    // slip a build through the check→lock window. See the re-validation below.
    expectedWorkflowPath: string;
  },
): Promise<
  | { outcome: 'created' | 'reused'; build: Build }
  | { outcome: 'limit-exceeded' }
  | { outcome: 'connection-removed' }
  | { outcome: 'connection-replaced' }
  | { outcome: 'branch-mismatch' }
  | { outcome: 'workflow-mismatch' }
  | { outcome: 'install-revoked' }
  | { outcome: 'project-deleting' }
> {
  return db.transaction(async (tx) => {
    // Lock the PROJECT row FIRST — before the users + github_connections locks
    // below — so this path acquires projects-before-connection, the SAME order
    // as deleteProjectCascade / lockAndMarkDeleting (projects FOR UPDATE, then
    // the cascaded connection) and the push path (supersedeAndCreateContainerBuild).
    // Without it, the builds INSERT below takes an implicit FK `FOR KEY SHARE` on
    // the projects row AFTER we already hold the connection `FOR UPDATE`, inverting
    // the lock order against a concurrent teardown (which holds projects FOR UPDATE
    // then needs this connection) → a Postgres deadlock (40P01) aborts one of the
    // two. Reject a project being torn down (or already gone): minting a deploy
    // token for a deleting project would create an orphan build the cascade then
    // has to cancel.
    const [proj] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .for('update')
      .limit(1);
    if (!proj || proj.status === 'deleting') {
      return { outcome: 'project-deleting' };
    }

    // Serialize per-user slot acquisition. Concurrent exchanges for the same
    // owner block here until the holder commits, so the count below always
    // observes prior inserts.
    await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${args.userId} FOR UPDATE`);

    // Serialize against DELETE /projects/:id/github: lock + re-read the connection
    // inside this tx. If a concurrent disconnect committed first, the row is gone
    // and we must NOT create a build / mint a token for a removed connection —
    // otherwise an orphan active build would never be finalized (the workflow_run
    // webhook ignores a missing connection) and a just-disconnected repo could
    // still deploy. The disconnect path takes the SAME `FOR UPDATE` lock on this
    // row, so the two are mutually exclusive: disconnect-first => we see no row
    // and reject; build-first => the disconnect's terminate step then cancels the
    // build we just created. Lock order is projects -> users -> github_connections
    // (projects locked above so it matches teardown's projects-first order); the
    // disconnect locks only github_connections, so there is no opposite-order
    // acquirer and no deadlock.
    const [conn] = await tx
      .select({
        id: githubConnections.id,
        branch: githubConnections.branch,
        workflow_path: githubConnections.workflow_path,
      })
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.project_id, args.projectId),
          eq(githubConnections.build_executor, 'github_actions'),
        ),
      )
      .for('update')
      .limit(1);
    if (!conn) {
      return { outcome: 'connection-removed' };
    }

    // Assert the locked connection is the SAME row the caller resolved. project_id
    // is UNIQUE, so a disconnect+reconnect to a DIFFERENT repo (same branch/executor)
    // DELETEs the old row and CREATEs a new one with a fresh id between resolution and
    // this tx. The install check below keys on the PASSED installationId, so a
    // same-installation two-repo swap passes it — the id-match is the only guard that
    // catches a cross-repo swap. Without it the old repo's workflow would create a
    // build + mint a deploy token for a project now bound to a different repo. Placed
    // before the install check because an id mismatch is more specific.
    if (conn.id !== args.connectionId) {
      return { outcome: 'connection-replaced' };
    }

    // Re-check installation status + repo membership under the connection lock.
    // The OIDC resolver (and the live getRepoInstallation call) checked the install
    // earlier, but a revocation (App suspend/uninstall, repo removal) can commit
    // AFTER those checks and BEFORE this tx — within the installation-token cache
    // window — and would otherwise create a `building` row + mint a deploy token
    // for a now-revoked install. The revocation webhooks lock these same connection
    // rows FIRST, so this plain read (under READ COMMITTED) sees their committed
    // status. Fails closed.
    if (
      !(await installationCoversRepoInTx(
        tx as unknown as Db,
        args.installationId,
        args.repositoryId,
      ))
    ) {
      return { outcome: 'install-revoked' };
    }

    // Re-validate the branch under the row lock. auth-oidc's pre-tx branch check
    // can race a PATCH that re-points the branch after the check but before this
    // lock; the locked row is authoritative. Reject if the connected branch moved.
    if (args.branch != null && args.branch !== '' && conn.branch !== args.branch) {
      return { outcome: 'branch-mismatch' };
    }

    // Re-validate the authorized workflow path under the SAME row lock — the same
    // TOCTOU class as the branch check above. auth-oidc's pre-tx gate compares the
    // OIDC token's own workflow file against the connection SNAPSHOT; a PATCH that
    // re-pins workflow_path can commit between that check and this lock. A
    // workflow_path change cannot filter-cancel by workflow (builds don't record
    // the workflow that authorized them), so the locked row is the authority:
    // reject if the token's workflow no longer matches the current pin, closing the
    // window in which a just-de-authorized workflow could still mint a token.
    if (conn.workflow_path !== args.expectedWorkflowPath) {
      return { outcome: 'workflow-mismatch' };
    }

    // Idempotent reuse: an already in-flight build for this exact run ATTEMPT
    // does not consume a new slot and must not be double-inserted. Matching on
    // the attempt (not run_id alone) ensures a RERUN — same run_id, incremented
    // run_attempt — does NOT wrongly reuse the prior attempt's build. Falls back
    // to IS NULL when the attempt is null (backward-compat for tokens that lack
    // the claim).
    const attemptMatch =
      args.githubRunAttempt != null
        ? eq(builds.github_run_attempt, args.githubRunAttempt)
        : isNull(builds.github_run_attempt);
    const [existing] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.project_id, args.projectId),
          eq(builds.github_run_id, args.githubRunId),
          attemptMatch,
        ),
      )
      .orderBy(
        sql`(${inArray(builds.status, ACTIVE_BUILD_STATUSES)}) desc`,
        desc(builds.created_at),
      )
      .limit(1);
    if (existing && ACTIVE_BUILD_STATUSES.includes(existing.status)) {
      return { outcome: 'reused', build: existing };
    }

    // Latest-wins: a newer run for the same project+branch supersedes ALL other
    // active GitHub Actions builds — including an older ATTEMPT of the SAME
    // run_id (a rerun reuses run_id with an incremented run_attempt). The
    // idempotent-reuse check above already returned early for an ACTIVE exact
    // (run_id, attempt) row, and this row's INSERT happens AFTER this UPDATE, so
    // the current attempt can't self-cancel. Marking them terminal frees the
    // owner's concurrency slot and revokes their deploy token so they can't race
    // `void deploy` for the project — without this, a still-ACTIVE attempt-1
    // (whose completion webhook was missed) would survive until the 60m reaper.
    // (The scaffolded workflow's `concurrency: cancel-in-progress` cancels the
    // older RUN on GitHub's side; this is the server-side backstop.)
    if (args.branch != null && args.branch !== '') {
      await tx
        .update(builds)
        .set({ status: 'cancelled', error: 'superseded by newer run', completed_at: sql`now()` })
        .where(
          and(
            eq(builds.project_id, args.projectId),
            eq(builds.branch, args.branch),
            eq(builds.executor, 'github_actions'),
            inArray(builds.status, ACTIVE_BUILD_STATUSES),
          ),
        );
    }

    if (args.limit > 0) {
      const [result] = await tx
        .select({ count: count() })
        .from(builds)
        .where(and(eq(builds.user_id, args.userId), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
      if ((result?.count ?? 0) >= args.limit) {
        return { outcome: 'limit-exceeded' };
      }
    }

    const id = generateId('bld');
    const [row] = await tx
      .insert(builds)
      .values({
        id,
        project_id: args.projectId,
        user_id: args.userId,
        executor: 'github_actions',
        status: 'building',
        commit_sha: args.commitSha ?? null,
        branch: args.branch ?? null,
        github_run_id: args.githubRunId,
        github_run_attempt: args.githubRunAttempt ?? null,
        logs_url: args.logsUrl ?? null,
      })
      .returning();
    return { outcome: 'created', build: row };
  });
}

/**
 * Atomically claim a QUEUED container build for starting, enforcing the owner's
 * per-user active-build cap in the SAME transaction.
 *
 * This is the container-scheduler counterpart to
 * `createGithubActionsBuildWithinLimit`: it takes the SAME `SELECT … FOR UPDATE`
 * lock on the owner's `users` row, so the scheduler path and the OIDC path are
 * mutually exclusive per user and can't both observe sub-cap capacity and both
 * create active builds. The previous flow (`countUserActiveBuilds` then a
 * separate `claimBuildForStart`) read the count outside the claim, so a parallel
 * OIDC exchange could slip a build in between and bust the cap.
 *
 * Steps inside one transaction, under the per-user lock:
 *   1. `SELECT … FOR UPDATE` the owner's users row (serializes with the OIDC
 *      path and other scheduler scans for the same owner).
 *   2. If `limit > 0` and the owner already has `>= limit` active builds, return
 *      false WITHOUT claiming. `limit === 0` means unlimited (no cap).
 *   3. If the build's project already has an active build, return false WITHOUT
 *      claiming (leave this build queued for a later tick). This enforces AT
 *      MOST ONE active build per project at a time, which serializes
 *      same-branch deploys (project↔branch is 1:1 via the unique
 *      `github_connections.project_id`). Serializing per project avoids the
 *      project-level deploy guard's 409 (`getActiveDeployment` →
 *      `ConcurrentDeployError`) and gives latest-wins via FIFO queue drain:
 *      two rapid pushes no longer both reach `void deploy` and leave the older
 *      commit live. Liveness: a stuck active build is freed by the build
 *      wall-clock timeout (`enforceTimeout`) and the deploy stale reaper, so the
 *      queue can't deadlock.
 *   4. Otherwise flip THIS build `queued -> starting` only if it is STILL
 *      `queued` (guards the read-then-write race: only one caller wins), stamp
 *      `started_at`, and return true. Return false if it was no longer queued
 *      (already claimed elsewhere).
 *
 * Returns true iff this call claimed the build (caller should proceed to start
 * it); false when at cap, when the project already has an active build, or when
 * already claimed (caller leaves it for a later tick).
 */
export async function claimBuildForStartWithinLimit(
  db: Db,
  args: {
    buildId: string;
    userId: string;
    projectId: string;
    limit: number;
    // The effective container size the scheduler will route this start on (the
    // persisted value, or a plan recompute for a legacy-null row). Persisted in
    // THIS claim tx — before the DO is addressed — so a cancel/reap in the
    // START->onStart window reads the correct size and addresses the namespace
    // that actually owns the running container. onStart's CAS later lands the
    // same value (now idempotent).
    instanceType: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serialize per-user slot acquisition against the OIDC path and other
    // scheduler scans for the same owner.
    await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${args.userId} FOR UPDATE`);

    if (args.limit > 0) {
      const [result] = await tx
        .select({ count: count() })
        .from(builds)
        .where(and(eq(builds.user_id, args.userId), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
      if ((result?.count ?? 0) >= args.limit) {
        return false;
      }
    }

    // Per-project serialization: at most one active build per project. All
    // builds for a project share one owner (`projects.user_id`), so this read
    // is race-free under the per-user FOR UPDATE lock taken above. No executor
    // filtering on purpose: an active github_actions build also blocks starting
    // a container build for the same project, which is correct.
    const [active] = await tx
      .select({ count: count() })
      .from(builds)
      .where(
        and(eq(builds.project_id, args.projectId), inArray(builds.status, ACTIVE_BUILD_STATUSES)),
      );
    if ((active?.count ?? 0) > 0) {
      return false;
    }

    // Atomic claim: only flips the row if it is still `queued`, so two scans
    // racing the same build see exactly one non-empty RETURNING. Persist the
    // effective instance_type in the SAME SET so the size-of-record is correct
    // the instant the row goes `starting` — a cancel/reap in the START->onStart
    // window then addresses the right DO namespace instead of mapping a still-
    // NULL value to the base class and leaking the paid container.
    const claimed = await tx
      .update(builds)
      .set({ status: 'starting', started_at: sql`now()`, instance_type: args.instanceType })
      .where(and(eq(builds.id, args.buildId), eq(builds.status, 'queued')))
      .returning({ id: builds.id });
    return claimed.length > 0;
  });
}

/**
 * The most recent deployment for a project at a given commit SHA. Used to link
 * a finished build back to the deployment the `void deploy` CLI created.
 */
export async function getDeploymentByProjectAndCommit(
  db: Db,
  projectId: string,
  commitSha: string,
): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.commit, commitSha)))
    .orderBy(desc(deployments.created_at))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// github_connections
// ---------------------------------------------------------------------------

export async function createGitHubConnection(
  db: Db,
  args: {
    projectId: string;
    installationId: string;
    repoFullName: string;
    // The repo's immutable numeric GitHub id (as text), captured from the
    // installation's cached repository list at connect time. Optional only so
    // pre-existing callers/tests compile; the connect handler always supplies it
    // and webhook/OIDC resolution keys on it (full_name is mutable).
    repositoryId?: string | null;
    branch?: string;
    buildExecutor?: GitHubConnection['build_executor'];
    // The `.github/workflows/*.yml` file the OIDC exchange binds the deploy
    // token to. Optional: when omitted the column default applies (the
    // scaffolded `void-deploy.yml`). Validated by the connect route before it
    // reaches here.
    workflowPath?: string;
  },
): Promise<GitHubConnection> {
  const id = generateId('ghc');
  const [row] = await db
    .insert(githubConnections)
    .values({
      id,
      project_id: args.projectId,
      installation_id: args.installationId,
      repo_full_name: args.repoFullName,
      repository_id: args.repositoryId ?? null,
      branch: args.branch ?? 'main',
      build_executor: args.buildExecutor ?? 'container',
      ...(args.workflowPath !== undefined ? { workflow_path: args.workflowPath } : {}),
    })
    .returning();
  return row;
}

export async function getGitHubConnection(
  db: Db,
  projectId: string,
): Promise<GitHubConnection | null> {
  const [row] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.project_id, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * Look up the connection for a webhook-delivered repo within an installation,
 * joining `projects` to surface the owning `user_id` (needed to attribute a
 * build and enforce that user's tier concurrency). Returns the connection
 * fields plus `user_id`, or null when no project is connected to that repo.
 *
 * Resolution keys on the IMMUTABLE numeric repository id (`repository.id` in
 * webhook payloads) so a repo rename/delete/name-reuse under the same
 * installation can't match a DIFFERENT repository to this connection. When the
 * caller has a `repositoryId`, a connection is matched ONLY by that id — it
 * FAILS CLOSED: a `repository_id IS NULL` row is NOT matched by name fallback,
 * because a deleted/renamed-and-reused repo name under the same installation
 * could otherwise match a stale null-id connection and authorize the WRONG
 * project. Only when the caller has no `repositoryId` (malformed/partial
 * webhook) does every connection fall back to a `repo_full_name` match — the
 * pre-id behavior.
 *
 * Returns ALL connections for the repo within the installation: a repo may back
 * multiple projects (only `project_id` is unique), so the caller disambiguates
 * (e.g. by push branch or workflow run id).
 *
 * The push webhook is App-lifecycle driven but a SIGNED, redelivered/delayed
 * push can still arrive AFTER the App is suspended/uninstalled or the repo
 * dropped from the install — and within the ~55-min installation-token cache
 * window it would otherwise resolve a connection, mint a fresh deploy token, and
 * deploy. Guard against that by INNER JOINing `github_installations` (via the
 * connection's `installation_id`) and requiring `status = 'active'`, plus
 * confirming the repo is still in the installation's selection — mirroring the
 * OIDC resolver. An `all`-repos install grants every repo (the `repositories`
 * cache is irrelevant); a `selected` install requires membership in the cached
 * set (an empty array under `selected` means "no repos" and is rejected).
 *
 * Unlike the OIDC resolver, this does NOT bind to a repo-owner id: the push path
 * resolves by `installation_id` (a repo transfer creates a NEW installation) and
 * the push payload carries no owner field. It also does NOT filter by
 * `build_executor` — the push handler legitimately branches on both executors.
 */
export async function getGitHubConnectionsByRepo(
  db: Db,
  installationId: string,
  repoFullName: string,
  repositoryId?: string | null,
): Promise<Array<GitHubConnection & { user_id: string }>> {
  const matchClause =
    repositoryId === undefined || repositoryId === null
      ? eq(githubConnections.repo_full_name, repoFullName)
      : eq(githubConnections.repository_id, repositoryId);
  const rows = await db
    .select({
      ...getTableColumns(githubConnections),
      user_id: projects.user_id,
    })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.installation_id, installationId),
        matchClause,
        eq(githubInstallations.status, 'active'),
        or(
          // "all repositories" install => every repo is granted.
          eq(githubInstallations.repository_selection, 'all'),
          // "selected" install => enforce the repo is in the cached set. The
          // `repositories` jsonb stores `id` as a NUMBER, so when the caller has
          // the immutable repo id, check membership by id (rename-safe). Fall
          // back to name membership only when no id is available.
          repositoryId === undefined || repositoryId === null
            ? sql`${githubInstallations.repositories} @> ${JSON.stringify([{ full_name: repoFullName }])}::jsonb`
            : sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
        ),
      ),
    );
  return rows;
}

/**
 * Self-heal stored repo names after a GitHub repository rename. A push is routed
 * by the immutable repository id, but the container build fetches its source
 * tarball from the stored `repo_full_name`; correct every connection in this
 * installation that points at this repository id but carries a stale name.
 */
export async function updateGitHubConnectionRepoNamesByRepoId(
  db: Db,
  installationId: string,
  repositoryId: string,
  newRepoFullName: string,
): Promise<void> {
  await db
    .update(githubConnections)
    .set({ repo_full_name: newRepoFullName, updated_at: sql`now()` })
    .where(
      and(
        eq(githubConnections.installation_id, installationId),
        eq(githubConnections.repository_id, repositoryId),
        ne(githubConnections.repo_full_name, newRepoFullName),
      ),
    );
}

/**
 * Resolve the GitHub Actions connection for a repo at OIDC-exchange time.
 *
 * The Actions executor authenticates by presenting a GitHub OIDC token whose
 * `repository` claim names the repo; there is no installation id in that flow,
 * so we look up by `repo_full_name` alone and require `build_executor =
 * 'github_actions'` (a `container`-executor connection must never be driven by
 * the OIDC endpoint). Joins `projects` to surface the owning `user_id` (to
 * attribute the build) and `slug` (to cross-check the workflow's declared
 * `--project <slug>`). When multiple connections name the same repo, the
 * newest by `created_at` wins.
 *
 * GitHub Actions OIDC is independent of the GitHub App lifecycle, so a repo
 * workflow could otherwise keep exchanging OIDC tokens for Void deploy tokens
 * after the App is suspended/deleted or the repo dropped from the install.
 * Guard against that by INNER JOINing `github_installations` (via the
 * connection's `installation_id`) and requiring `status = 'active'`, plus
 * confirming the repo is still in the installation's selection. Selection is
 * keyed off GitHub's `repository_selection`: an `all`-repos install grants
 * every repo (membership is not enforced — the `repositories` cache is
 * irrelevant), while a `selected` install requires the repo to be a member of
 * the cached set. An empty `repositories` array under `selected` therefore
 * means "no repos" and is correctly rejected — it is no longer overloaded to
 * mean "all".
 *
 * Returns ALL github_actions connections for the repo; a repo may back multiple
 * projects (only `project_id` is unique). The caller disambiguates by the
 * workflow's requested project slug.
 *
 * When `repositoryOwnerId` (the OIDC `repository_owner_id` claim) is supplied,
 * an OIDC match additionally requires the repo's CURRENT owner account to equal
 * the installation's `account_id`. The `repository_id` is immutable across a
 * repo TRANSFER, so without this an org→org transfer (same id, new owner) would
 * match the OLD owner's stale `all`-repos connection and mint a deploy token for
 * the wrong project. A null/undefined owner id (legacy, no claim) skips the
 * owner check to preserve pre-claim behavior; the OIDC route always passes it.
 */
export async function getGitHubActionsConnectionsByRepo(
  db: Db,
  repoFullName: string,
  repositoryId?: string | null,
  repositoryOwnerId?: string | null,
): Promise<Array<GitHubConnection & { user_id: string; project_slug: string }>> {
  // Key on the IMMUTABLE numeric repository id (`claims.repository_id`) so a
  // rename/name-reuse can't point a stale `repo_full_name` at this connection.
  // When the claim carries an id, connections are matched ONLY by id and the
  // lookup FAILS CLOSED: a null-id row is NOT matched by name fallback, since a
  // renamed-and-reused repo name could otherwise match a stale null-id
  // connection and mint a deploy token for the WRONG project. Only a missing
  // claim id falls back to `repo_full_name` for every row (pre-id behavior).
  const repoMatch =
    repositoryId === undefined || repositoryId === null
      ? eq(githubConnections.repo_full_name, repoFullName)
      : eq(githubConnections.repository_id, repositoryId);
  const rows = await db
    .select({
      ...getTableColumns(githubConnections),
      user_id: projects.user_id,
      project_slug: projects.slug,
    })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        repoMatch,
        // Bind the connection's installation account to the OIDC repo owner. The
        // `repository_id` is immutable across a repo TRANSFER, so this top-level
        // condition (applies to BOTH the 'all' and 'selected' branches below)
        // rejects a transferred repo (same id, NEW owner) that would otherwise
        // match the old owner's stale connection. Skipped when no owner id is
        // supplied (legacy/no-claim).
        repositoryOwnerId === undefined || repositoryOwnerId === null || repositoryOwnerId === ''
          ? undefined
          : eq(githubInstallations.account_id, repositoryOwnerId),
        eq(githubConnections.build_executor, 'github_actions'),
        eq(githubInstallations.status, 'active'),
        or(
          // "all repositories" install => every repo is granted.
          eq(githubInstallations.repository_selection, 'all'),
          // "selected" install => enforce the repo is in the cached set. The
          // `repositories` jsonb stores `id` as a NUMBER (see
          // `GitHubInstallationRepository.id: number` and `normalizeRepositories`),
          // so when the caller has the immutable repo id, check membership by id
          // (rename-safe). Fall back to name membership only when no id is
          // available (legacy/no-claim).
          repositoryId === undefined || repositoryId === null
            ? sql`${githubInstallations.repositories} @> ${JSON.stringify([{ full_name: repoFullName }])}::jsonb`
            : sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
        ),
      ),
    );
  return rows;
}

export async function updateGitHubConnection(
  db: Db,
  projectId: string,
  updates: {
    branch?: string;
    buildExecutor?: GitHubConnection['build_executor'];
    workflowPath?: string;
  },
): Promise<void> {
  await db
    .update(githubConnections)
    .set({
      branch: updates.branch === undefined ? sql`${githubConnections.branch}` : updates.branch,
      build_executor:
        updates.buildExecutor === undefined
          ? sql`${githubConnections.build_executor}`
          : updates.buildExecutor,
      workflow_path:
        updates.workflowPath === undefined
          ? sql`${githubConnections.workflow_path}`
          : updates.workflowPath,
      updated_at: sql`now()`,
    })
    .where(eq(githubConnections.project_id, projectId));
}

export async function deleteGitHubConnection(db: Db, projectId: string): Promise<void> {
  await db.delete(githubConnections).where(eq(githubConnections.project_id, projectId));
}

// ---------------------------------------------------------------------------
// github_installations
// ---------------------------------------------------------------------------

export async function upsertGitHubInstallation(
  db: Db,
  args: {
    installationId: string;
    userId?: string | null;
    accountLogin: string;
    accountId: string;
    accountType: GitHubInstallation['account_type'];
    repositories: ReadonlyArray<GitHubInstallationRepository>;
    // GitHub's `repository_selection` (`all` | `selected`). Optional so callers
    // that don't carry it (e.g. the OAuth callback re-upsert) preserve the
    // existing value on conflict; defaults to `selected` on insert, the safe
    // direction (requires explicit membership unless proven all-repos).
    repositorySelection?: GitHubInstallation['repository_selection'];
    // When true, the conflict path ALSO rolls repo membership forward to the
    // fresh `repositories` / `repositorySelection` carried in args. Only the
    // OAuth callback caller sets this — it just refetched the LIVE membership via
    // `listInstallationRepositories`, so its data is authoritative on reconnect /
    // `setup_action=update`. The webhook `installation.created` caller leaves it
    // off (default), keeping the stale-`created` membership guard below intact.
    refreshMembership?: boolean;
  },
): Promise<GitHubInstallation> {
  const id = generateId('ghi');
  const [row] = await db
    .insert(githubInstallations)
    .values({
      id,
      installation_id: args.installationId,
      user_id: args.userId ?? null,
      account_login: args.accountLogin,
      account_id: args.accountId,
      account_type: args.accountType,
      repositories: args.repositories,
      repository_selection: args.repositorySelection ?? 'selected',
    })
    .onConflictDoUpdate({
      target: githubInstallations.installation_id,
      set: {
        // Preserve an already-linked user_id when a webhook upsert arrives with
        // no user (install-before-signin can be backfilled later). When a user
        // is provided, adopt it ONLY if the row is unowned or already owned by
        // the same user — never re-own a row linked to a DIFFERENT user. This
        // guards the concurrent-callback race (realistic for org installs) that
        // the non-transactional read-then-write backstop in routes/github.ts
        // cannot catch. (Done in the column expression, not setWhere: setWhere
        // would freeze repositories/status refreshes on the webhook re-upsert,
        // and `user_id = NULL` is never true.)
        user_id:
          args.userId === undefined || args.userId === null
            ? sql`${githubInstallations.user_id}`
            : sql`CASE WHEN ${githubInstallations.user_id} IS NULL OR ${githubInstallations.user_id} = ${args.userId} THEN ${args.userId} ELSE ${githubInstallations.user_id} END`,
        account_login: args.accountLogin,
        account_id: args.accountId,
        account_type: args.accountType,
        // By default, do NOT overwrite repo-membership (`repositories` /
        // `repository_selection`) on the conflict path. GitHub never reuses
        // installation_ids, so a `created` that conflicts with an existing row is
        // ALWAYS a stale/redelivered event and its payload membership is never
        // newer than what we already hold. The INSERT above seeds both on the
        // genuine first install, and the `installation_repositories` webhook
        // handler is the authoritative writer for every membership/selection
        // change thereafter (under a FOR UPDATE lock). Overwriting here would let
        // a redelivered original `created` (e.g. repos [A]) roll back a cache the
        // handler correctly advanced (e.g. [A, B]), or downgrade an `all`
        // selection back to `selected` — silently rejecting pushes/OIDC for the
        // dropped repos until the next selection refresh.
        //
        // EXCEPTION: the OAuth callback caller (routes/github.ts) sets
        // `refreshMembership: true`. It just refetched the LIVE membership via
        // `listInstallationRepositories`, so on reconnect / `setup_action=update`
        // its data IS authoritative and must roll the cache forward (otherwise
        // newly-added repos / a widen-to-`all` stay rejected until the next
        // webhook). The membership keys are spread in only for that caller, so the
        // generated SQL is byte-identical to the webhook path when the flag is off.
        ...(args.refreshMembership
          ? {
              repositories: args.repositories,
              // NULL-safe: never blank an existing selection if the caller omitted it.
              repository_selection:
                args.repositorySelection ?? sql`${githubInstallations.repository_selection}`,
            }
          : {}),
        // Do NOT let a conflict-update revive a terminal/suspended row. A genuine
        // reinstall ALWAYS gets a NEW installation_id from GitHub (ids are never
        // reused), so it hits the INSERT branch above (status defaults to active),
        // never this conflict path. Therefore a `created` that conflicts with an
        // existing row is always a stale/redelivered event — and if that row is
        // currently `deleted` (uninstalled) or `suspended`, a LATER lifecycle event
        // set it so. Flipping it back to `active` here would re-enable push/OIDC
        // resolution (the resolvers gate only on status='active') for an App the
        // user already removed. Keep `deleted`/`suspended` terminal; only the real
        // `installation.unsuspend` webhook (markGitHubInstallationStatus) clears a
        // suspension. `active` rows stay active (the common create-before-callback
        // backfill case is a no-op).
        status: sql`CASE WHEN ${githubInstallations.status} IN ('deleted', 'suspended') THEN ${githubInstallations.status} ELSE 'active' END`,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getGitHubInstallation(
  db: Db,
  installationId: string,
): Promise<GitHubInstallation | null> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installation_id, installationId))
    .limit(1);
  return row ?? null;
}

export async function getGitHubInstallationsByUser(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<GitHubInstallation>> {
  // Owner OR active member. The EXISTS correlates on the NUMERIC
  // `installation_id` (githubInstallations.installation_id) — the key the
  // membership cache is stored under — NOT the surrogate `.id`. The membership
  // arm honors the TTL (`expires_at > now()`, DB clock). owner-OR-EXISTS yields
  // each installation at most once (the row is from githubInstallations, deduped
  // by its own PK), so a caller who is both owner and member still sees one row.
  return db
    .select()
    .from(githubInstallations)
    .where(
      or(
        eq(githubInstallations.user_id, userId),
        sql`EXISTS (SELECT 1 FROM ${githubInstallationMembers} m
             WHERE m.installation_id = ${githubInstallations.installation_id}
               AND m.user_id = ${userId}
               AND m.expires_at > now())`,
      ),
    )
    .orderBy(desc(githubInstallations.created_at));
}

export async function setGitHubInstallationRepositories(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<GitHubInstallationRepository>,
  // Optional `repository_selection` (`all` | `selected`) delivered alongside the
  // installation_repositories delta. When provided it is updated atomically with
  // the cached set so an install that flips to `all` (or back to `selected`)
  // stays in sync; when omitted the stored selection is preserved.
  repositorySelection?: GitHubInstallation['repository_selection'],
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({
      repositories,
      repository_selection:
        repositorySelection === undefined
          ? sql`${githubInstallations.repository_selection}`
          : repositorySelection,
      updated_at: sql`now()`,
    })
    .where(eq(githubInstallations.installation_id, installationId));
}

export async function markGitHubInstallationStatus(
  db: Db,
  installationId: string,
  status: GitHubInstallation['status'],
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status, updated_at: sql`now()` })
    .where(eq(githubInstallations.installation_id, installationId));
}

/**
 * Apply a suspension (installation.suspend), guarded so it NEVER overwrites a
 * `deleted` row. A delayed/redelivered `suspend` landing AFTER a later
 * `installation.deleted` would otherwise walk the terminal row back to
 * `suspended`, which then re-satisfies unsuspendGitHubInstallation's
 * `status='suspended'` guard — letting a subsequent stale `unsuspend` reactivate
 * an App the user already removed. GitHub never reuses installation_ids, so a
 * suspend hitting a `deleted` row is always stale; leave it terminal. The
 * `deleted` webhook keeps using markGitHubInstallationStatus (deleted is the
 * terminalizing write and must apply unconditionally).
 */
export async function suspendGitHubInstallation(db: Db, installationId: string): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status: 'suspended', updated_at: sql`now()` })
    .where(
      and(
        eq(githubInstallations.installation_id, installationId),
        ne(githubInstallations.status, 'deleted'),
      ),
    );
}

/**
 * Clear a suspension (installation.unsuspend), guarded to the `suspended`→`active`
 * transition ONLY. A delayed or redelivered `unsuspend` that lands AFTER a later
 * `installation.deleted` must NOT revive the terminal row — the connection
 * resolvers gate solely on status='active', so reviving a deleted install would
 * let a removed App resume push/OIDC deploys (the same class as the stale-`created`
 * guard in upsertGitHubInstallation, which this path bypasses). GitHub never
 * reuses installation_ids, so a genuine reinstall is a NEW row, never an
 * unsuspend; an unsuspend hitting a `deleted` (or already-`active`) row is always
 * stale and is left untouched.
 */
export async function unsuspendGitHubInstallation(db: Db, installationId: string): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status: 'active', updated_at: sql`now()` })
    .where(
      and(
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'suspended'),
      ),
    );
}

/**
 * Backfill the owning user on installations created before sign-in. Matches by
 * `account_id` and only adopts the user where `user_id` is still NULL, so a
 * later sign-in by the GitHub account that performed the install claims its
 * unlinked installation(s) without clobbering already-linked ones.
 */
export async function linkGitHubInstallationToUser(
  db: Db,
  accountId: string,
  userId: string,
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ user_id: userId, updated_at: sql`now()` })
    .where(and(eq(githubInstallations.account_id, accountId), isNull(githubInstallations.user_id)));
}

/**
 * All installations under a GitHub account, scoped by type. Revocation resolves
 * an org's installs via (account_id, 'Organization').
 */
export async function getGitHubInstallationsByAccount(
  db: Db,
  accountId: string,
  accountType: GitHubInstallation['account_type'],
): Promise<ReadonlyArray<GitHubInstallation>> {
  return db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.account_id, accountId),
        eq(githubInstallations.account_type, accountType),
      ),
    );
}

/**
 * Guarded clear of the installer/owner pointer for a removed user. The
 * `user_id = userId` guard means a concurrent re-own or a different owner is
 * never clobbered. Membership rows are removed separately
 * (`deleteGitHubInstallationMembers`); this only nulls the single owner pointer.
 * No-op returning 0 on an empty id list so we never emit a `WHERE ... IN ()`.
 * The count is read through `updatedRowCount` so it is correct on both the
 * production pg driver (`rowCount`) and the PGlite test driver (`affectedRows`).
 */
export async function clearGitHubInstallationOwnerForUser(
  db: Db,
  installationIds: ReadonlyArray<string>,
  userId: string,
): Promise<number> {
  if (installationIds.length === 0) {
    return 0;
  }
  const result = await db
    .update(githubInstallations)
    .set({ user_id: null, updated_at: sql`now()` })
    .where(
      and(
        inArray(githubInstallations.installation_id, installationIds),
        eq(githubInstallations.user_id, userId),
      ),
    );
  return updatedRowCount(result);
}

// ---------------------------------------------------------------------------
// github_installation_members — cached org co-membership (TTL, no stored token)
//
// Canonical helper surface for the org-shared GitHub App flow. A row records
// that a Void user was verified as a member of the GitHub account behind a
// numeric installation. It is a TTL cache: access is re-verified per-repo, and
// these helpers only short-circuit the org-membership check while fresh.
// ---------------------------------------------------------------------------

/**
 * Insert (or refresh) a cached membership for `(installationId, userId)`.
 *
 * `expires_at` is computed from the DB clock (`now() + ttlSeconds`), never the
 * app clock, so a skewed worker cannot mint a longer- or shorter-lived
 * membership than intended. A re-join hits the unique `(installation_id,
 * user_id)` index and refreshes `github_account_id`/`verified_at`/`expires_at`
 * in place (count stays 1). Tolerates a null `githubAccountId` (the
 * backstop/JOIN callers may not carry a caller account id).
 */
export async function upsertGitHubInstallationMember(
  db: Db,
  args: {
    installationId: string;
    userId: string;
    githubAccountId: string | null;
    ttlSeconds: number;
  },
): Promise<GitHubInstallationMember> {
  const id = generateId('ghm');
  const [row] = await db
    .insert(githubInstallationMembers)
    .values({
      id,
      installation_id: args.installationId,
      user_id: args.userId,
      github_account_id: args.githubAccountId,
      expires_at: sql`now() + (${args.ttlSeconds} * interval '1 second')`,
    })
    .onConflictDoUpdate({
      target: [githubInstallationMembers.installation_id, githubInstallationMembers.user_id],
      set: {
        github_account_id: args.githubAccountId,
        verified_at: sql`now()`,
        expires_at: sql`now() + (${args.ttlSeconds} * interval '1 second')`,
      },
    })
    .returning();
  return row;
}

/**
 * TTL-checked membership predicate used by the connect gate: true iff a
 * non-expired row exists for `(installationId, userId)`.
 */
export async function hasActiveInstallationMembership(
  db: Db,
  installationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(githubInstallationMembers)
    .where(
      and(
        eq(githubInstallationMembers.installation_id, installationId),
        eq(githubInstallationMembers.user_id, userId),
        sql`${githubInstallationMembers.expires_at} > now()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** All cached memberships for a user, newest verification first. */
export async function getGitHubInstallationMembersByUser(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<GitHubInstallationMember>> {
  return db
    .select()
    .from(githubInstallationMembers)
    .where(eq(githubInstallationMembers.user_id, userId))
    .orderBy(desc(githubInstallationMembers.verified_at));
}

/** All cached members of an installation, newest verification first. */
export async function getGitHubInstallationMembers(
  db: Db,
  installationId: string,
): Promise<ReadonlyArray<GitHubInstallationMember>> {
  return db
    .select()
    .from(githubInstallationMembers)
    .where(eq(githubInstallationMembers.installation_id, installationId))
    .orderBy(desc(githubInstallationMembers.verified_at));
}

/** Remove one cached membership. Silent no-op when the row is absent. */
export async function deleteGitHubInstallationMember(
  db: Db,
  installationId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(githubInstallationMembers)
    .where(
      and(
        eq(githubInstallationMembers.installation_id, installationId),
        eq(githubInstallationMembers.user_id, userId),
      ),
    );
}

/**
 * Bulk-remove a user's cached memberships across several installations (used by
 * revocation). No-op on an empty id list so we never emit a `WHERE ... IN ()`.
 */
export async function deleteGitHubInstallationMembers(
  db: Db,
  installationIds: ReadonlyArray<string>,
  userId: string,
): Promise<void> {
  if (installationIds.length === 0) {
    return;
  }
  await db
    .delete(githubInstallationMembers)
    .where(
      and(
        inArray(githubInstallationMembers.installation_id, installationIds),
        eq(githubInstallationMembers.user_id, userId),
      ),
    );
}

/**
 * Bulk-remove the cached memberships across `installationIds` whose captured
 * browser proof (`github_account_id`) equals `githubAccountId`, regardless of
 * which Void user bears them. member_removed uses this to void the LISTING
 * memberships keyed by a removed GitHub identity X: these rows are TTL cache
 * metadata that NEVER back a `github_connections` row or an installation owner
 * pointer (those are backed by the connecting user's IMMUTABLE oauth GitHub id
 * and are severed via `getUserByOAuthAccount('github', X)` — the single insert
 * site `createGitHubConnection` is only ever reached after that oauth id is
 * proven). Deleting only the X-keyed rows therefore leaves every Z-keyed
 * membership and every connection untouched. No-op on an empty id list so we
 * never emit a `WHERE ... IN ()`.
 */
export async function deleteGitHubInstallationMembersByGithubAccount(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string,
): Promise<void> {
  if (installationIds.length === 0) {
    return;
  }
  await db
    .delete(githubInstallationMembers)
    .where(
      and(
        inArray(githubInstallationMembers.installation_id, installationIds),
        eq(githubInstallationMembers.github_account_id, githubAccountId),
      ),
    );
}

// ---------------------------------------------------------------------------
// github_installation_revocations — durable monotonic revocation tombstone
//
// A row records the high-water mark `revoked_at` for `(installation_id,
// user_id)`. `member_removed` upserts `revoked_at = greatest(existing, now())`
// (never regresses); join/complete + the connect gate compare an artifact's
// `iat` (mint time, DB-clock ms via `getDbNowMs`) against this to reject any
// artifact minted AT OR BEFORE the last revocation. A legit re-join AFTER re-add
// mints a fresh artifact (iat > revoked_at) → kept.
// ---------------------------------------------------------------------------

/**
 * Current DB time as EPOCH MILLISECONDS. Used to stamp an artifact's `iat` from
 * the SAME clock as the revocation tombstone's `revoked_at` (also DB `now()`),
 * so the `iat <= revoked_at` revocation check never crosses clock domains (a
 * Worker/DB skew could otherwise let a pre-removal artifact slip the check).
 *
 * Uses `db.execute` rather than the query builder: a from-less `db.select(...)`
 * returns a non-executable builder in drizzle, so `execute` is the driver-safe
 * way to run a from-less scalar select on BOTH the pg and PGlite drivers
 * (mirrors the `select now()` fence in routes/webhooks.ts). `extract(epoch from
 * now()) * 1000` returns numeric — a string over the wire on both drivers — so
 * `Number(...)` normalizes it to a JS millisecond number. A row is always
 * returned; the `?? 0` is a defensive fail-closed fallback (a 0 `iat` can only
 * ever be rejected by an existing tombstone, never let a stale artifact pass).
 */
export async function getDbNowMs(db: Db): Promise<number> {
  const result = (await db.execute(sql`select extract(epoch from now()) * 1000 as now_ms`)) as {
    rows: ReadonlyArray<{ now_ms: number | string }>;
  };
  const value = result.rows[0]?.now_ms;
  return value == null ? 0 : Number(value);
}

/**
 * Record (or advance) the revocation tombstone for a removed GitHub ACCOUNT id
 * across a set of installations. Upserts one row per install; the inserted
 * `revoked_at` is `clock_timestamp()` — the ACTUAL write moment, NOT Postgres
 * `now()` (which freezes at TRANSACTION-START). `member_removed` writes this
 * AFTER a possibly lock-waiting `FOR UPDATE` on the org install rows, so an
 * artifact (join_code/connect_grant) minted DURING that tx window has
 * `iat < revoked_at` and is rejected — closing the R5-2 contention-amplified
 * replay window that a tx-start `now()` would leave open. onConflict sets
 * `revoked_at` to `greatest(existing, excluded)`: a reordered/redelivered webhook
 * still carries a `clock_timestamp()` >= the earlier one, and `greatest(...)`
 * pins the high-water mark so it can only move forward. No-op on an empty id list
 * so we never emit a values-less insert. Id via `generateId('ghr')` (mirrors
 * `ghm` for members).
 *
 * Keyed by `githubAccountId` — the durable identity the stateless artifacts
 * carry — NOT a Void user id (which may not exist when a soon-to-be-removed member
 * pre-mints artifacts). `member_removed` calls this ONCE with the removed GitHub
 * id, always known from the webhook payload.
 */
export async function recordInstallationRevocations(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string,
): Promise<void> {
  if (installationIds.length === 0) {
    return;
  }
  await db
    .insert(githubInstallationRevocations)
    .values(
      installationIds.map((installationId) => ({
        id: generateId('ghr'),
        installation_id: installationId,
        github_account_id: githubAccountId,
        revoked_at: sql`clock_timestamp()`,
      })),
    )
    .onConflictDoUpdate({
      target: [
        githubInstallationRevocations.installation_id,
        githubInstallationRevocations.github_account_id,
      ],
      set: {
        revoked_at: sql`greatest(${githubInstallationRevocations.revoked_at}, excluded.revoked_at)`,
      },
    });
}

/**
 * The subset of `guids` we have already redelivered (i.e. already recorded in
 * the `github_webhook_redeliveries` ledger). Returns an empty Set for an empty
 * input WITHOUT issuing a query — a bare `inArray(col, [])` would emit `IN ()`.
 */
export async function getRedeliveredGuids(
  db: Db,
  guids: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (guids.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ guid: githubWebhookRedeliveries.guid })
    .from(githubWebhookRedeliveries)
    .where(inArray(githubWebhookRedeliveries.guid, [...guids]));
  return new Set(rows.map((r) => r.guid));
}

/**
 * Record a redelivered webhook in the ledger. Idempotent: `onConflictDoNothing`
 * on the `guid` unique index, so a concurrent run / re-scan that races on the
 * same guid never double-inserts (and the caller never double-redelivers).
 */
export async function recordWebhookRedelivery(
  db: Db,
  entry: {
    guid: string;
    deliveryId: string;
    event: string | null;
    statusCode: number | null;
  },
): Promise<void> {
  await db
    .insert(githubWebhookRedeliveries)
    .values({
      id: generateId('ghwr'),
      guid: entry.guid,
      delivery_id: entry.deliveryId,
      event: entry.event,
      status_code: entry.statusCode,
    })
    .onConflictDoNothing({ target: githubWebhookRedeliveries.guid });
}

/**
 * The revocation tombstone's `revoked_at` for `(installationId, githubAccountId)`
 * as EPOCH MILLISECONDS (so the caller can compare it directly to an artifact
 * `iat`, itself DB-clock ms via `getDbNowMs`), or null when no tombstone exists.
 * `extract(epoch from ...) * 1000` keeps the PGlite test driver and the pg
 * production driver in agreement on the millisecond value.
 */
export async function getInstallationRevocationAt(
  db: Db,
  installationId: string,
  githubAccountId: string,
): Promise<number | null> {
  const rows = await db
    .select({
      revokedAtMs: sql<number>`extract(epoch from ${githubInstallationRevocations.revoked_at}) * 1000`,
    })
    .from(githubInstallationRevocations)
    .where(
      and(
        eq(githubInstallationRevocations.installation_id, installationId),
        eq(githubInstallationRevocations.github_account_id, githubAccountId),
      ),
    )
    .limit(1);
  const value = rows[0]?.revokedAtMs;
  return value == null ? null : Number(value);
}

/**
 * True iff ANY revocation tombstone exists for this installation (any github account).
 * Used to tell a CLEARED-owner org install (member_removed wrote a tombstone atomically
 * with the owner-clear) apart from a FRESH webhook-precreated null-owner org install
 * (no tombstone), so the install callback never re-owns a cleared install (R15-1).
 */
export async function hasInstallationRevocation(db: Db, installationId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(githubInstallationRevocations)
    .where(eq(githubInstallationRevocations.installation_id, installationId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Batch revocation tombstones for `(installationIds, githubAccountId)` as a Map
 * installation_id → revoked_at-epoch-ms. Installs with no tombstone are simply
 * absent from the Map. Empty id list → empty Map (never emits `WHERE ... IN ()`).
 * A null/empty `githubAccountId` (a null-github artifact — e.g. a join_code with
 * no proven account id) also yields an empty Map: no tombstone can apply, and such
 * an artifact is deploy-inert anyway.
 */
export async function getInstallationRevocationsForAccount(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (installationIds.length === 0 || !githubAccountId) {
    return result;
  }
  const rows = await db
    .select({
      installationId: githubInstallationRevocations.installation_id,
      revokedAtMs: sql<number>`extract(epoch from ${githubInstallationRevocations.revoked_at}) * 1000`,
    })
    .from(githubInstallationRevocations)
    .where(
      and(
        inArray(githubInstallationRevocations.installation_id, installationIds),
        eq(githubInstallationRevocations.github_account_id, githubAccountId),
      ),
    );
  for (const row of rows) {
    result.set(row.installationId, Number(row.revokedAtMs));
  }
  return result;
}

/**
 * Resolve a Void user's linked GitHub account id (the numeric provider id, as
 * text), or null when the user has no linked GitHub identity. Exported reverse
 * lookup mirroring the inline query in `linkGitHubIdentity`; used for the audit
 * column on membership rows and the connect-authz caller-identity bind.
 */
export async function getGitHubAccountIdForUser(db: Db, userId: string): Promise<string | null> {
  const existing = await db
    .select({ providerId: oauthAccounts.provider_id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')))
    .limit(1);
  return existing[0]?.providerId ?? null;
}
