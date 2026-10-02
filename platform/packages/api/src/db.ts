import {
  and,
  count,
  countDistinct,
  desc,
  asc,
  eq,
  ne,
  lt,
  gt,
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
import { ACTIVE_BUILD_STATUSES } from './build-status.ts';
export { ACTIVE_BUILD_STATUSES } from './build-status.ts';
import { lockAuthSettings } from './auth/configuration.ts';
import { lockEmailPolicy } from './email/admission.ts';
import { generateId } from './id.ts';
import { getProjectQueueName } from './naming.ts';
import { getDefaultPlan, lockPlanCatalog, requireAssignablePlan, resolvePlan } from './plans.ts';
import { requireProjectCapability } from './project-access.ts';
import * as schema from './schema.ts';
import {
  users,
  oauthAccounts,
  projects,
  projectMembers,
  projectInvitations,
  projectOwnershipPeriods,
  projectAccessEvents,
  deployments,
  projectSecrets,
  projectCleanupJobs,
  resources,
  domains,
  emailDestinations,
  emailDestinationCleanups,
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
  platformLoginIdentities,
} from './schema.ts';
import type { DomainVerificationData, GitHubInstallationRepository } from './schema.ts';
import type { AllowlistEntry } from './signup-allowlist.ts';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
} from './suspension.ts';
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
  ProjectAccessEventAction,
  ProjectDatabaseCredentials,
  ProjectInvitation,
  ProjectMember,
  ProjectMemberRole,
  ProjectOwnershipPeriod,
  ProjectRole,
  ProjectSecret,
  Project,
  Resource,
  User,
} from './types.ts';

export function createDb(connectionString: string) {
  return drizzle(connectionString, { schema });
}
export type Db = ReturnType<typeof createDb>;
/** The transaction handle inside `db.transaction` — same query surface, savepoint-nested. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

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
  role: 'user' | 'admin' = 'user',
  plan?: PlanId,
): Promise<User> {
  return db.transaction(async (tx) => {
    await lockPlanCatalog(tx);
    const assignedPlan =
      plan === undefined ? await getDefaultPlan(tx) : await requireAssignablePlan(tx, plan);
    const id = generateId('user');
    const [row] = await tx
      .insert(users)
      .values({ id, provider, provider_id: providerId, login, email, role, plan: assignedPlan.id })
      .returning();
    return row;
  });
}

/**
 * Creates a user and grants the first account on a self-hosted installation
 * the admin role. Call this inside the same transaction that links the OAuth
 * identity. The table lock makes concurrent first logins observe one winner.
 * Hosted Void Cloud retains its existing user default. Both paths reject an
 * old callback racing the migration to configurable authentication.
 */
export async function createUserForPlatform(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
  installationId?: string,
  options?: {
    additionalSignupAllowed: boolean;
    bootstrapGitHubId: string;
  },
): Promise<User> {
  await lockPlanCatalog(db);
  if (await lockAuthSettings(db)) {
    throw new SelfHostedSignupRestrictedError();
  }
  if (!installationId) {
    return createUser(db, provider, providerId, login, email);
  }
  await db.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (!existing) {
    if (
      provider !== 'github' ||
      !options?.bootstrapGitHubId ||
      providerId !== options.bootstrapGitHubId
    ) {
      throw new SelfHostedSignupRestrictedError();
    }
  } else if (!options?.additionalSignupAllowed) {
    throw new SelfHostedSignupRestrictedError();
  }
  const defaultPlan = await getDefaultPlan(db, 'custom');
  return createUser(
    db,
    provider,
    providerId,
    login,
    email,
    existing ? 'user' : 'admin',
    defaultPlan.id,
  );
}

/** Bootstrap the configured owner through admin OAuth without opening general signup. */
export async function bootstrapPlatformAdmin(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
  installationId?: string,
  bootstrapGitHubId?: string,
): Promise<User | null> {
  if (
    !installationId ||
    provider !== 'github' ||
    !bootstrapGitHubId ||
    providerId !== bootstrapGitHubId
  ) {
    return null;
  }
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    let user: User;
    try {
      // Share the first-user lock and identity check with normal signup. Keep
      // the user and OAuth identity in one transaction so neither can be orphaned.
      user = await createUserForPlatform(txDb, provider, providerId, login, email, installationId, {
        additionalSignupAllowed: false,
        bootstrapGitHubId,
      });
    } catch (error) {
      if (!(error instanceof SelfHostedSignupRestrictedError)) {
        throw error;
      }
      // A concurrent dashboard/CLI login may have created the owner after the
      // callback's initial lookup. Re-read under the lock, never promote a user.
      return getUserByOAuthAccount(txDb, provider, providerId);
    }
    await createOAuthAccount(txDb, user.id, provider, providerId);
    return user;
  });
}

export class SelfHostedSignupRestrictedError extends Error {
  constructor() {
    super('Self-hosted platform signup is restricted.');
    this.name = 'SelfHostedSignupRestrictedError';
  }
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
  await db.transaction(async (tx) => {
    await lockPlanCatalog(tx);
    await requireAssignablePlan(tx, plan);
    await tx.update(users).set({ plan }).where(eq(users.id, id));
  });
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
        // billing_user_id is authoritative after the team migration. Keep the
        // owner fallback during the additive rollout for a placeholder created
        // by an older API revision before the backfill converges.
        sql`COALESCE(${deployments.billing_user_id}, ${projects.user_id}) = ${userId}`,
        sql`${deployments.created_at} >= CURRENT_DATE`,
        isNotNull(deployments.manifest),
      ),
    );
  return result?.count ?? 0;
}

// --- Projects ---

export async function createProject(db: Db, userId: string, slug: string): Promise<Project> {
  const id = generateId('proj');
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(projects).values({ id, user_id: userId, slug }).returning();
    await tx
      .insert(projectOwnershipPeriods)
      .values({
        id: generateId('pown'),
        project_id: created.id,
        owner_user_id: userId,
        starts_at: created.created_at,
      })
      .onConflictDoNothing();
    return created;
  });
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

export async function getOwnedProjectsByUserId(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<Project>> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.user_id, userId))
    .orderBy(desc(projects.created_at));
}

type AccessibleProject = Readonly<{
  project: Project;
  role: ProjectRole;
  owner: User;
}>;

const accessibleProjectOwner = alias(users, 'accessible_project_owner');

/** Accessible projects whose billing owner is not manually suspended. */
export async function getAccessibleProjectsByUserId(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<AccessibleProject>> {
  const rows = await db
    .select({ project: projects, memberRole: projectMembers.role, owner: accessibleProjectOwner })
    .from(projects)
    .innerJoin(accessibleProjectOwner, eq(projects.user_id, accessibleProjectOwner.id))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.project_id, projects.id), eq(projectMembers.user_id, userId)),
    )
    .where(or(eq(projects.user_id, userId), eq(projectMembers.user_id, userId)))
    .orderBy(desc(projects.created_at));

  return rows
    .filter((row) => !isAdminSuspended(row.owner.suspended_reason))
    .map((row) => ({
      project: row.project,
      role: row.project.user_id === userId ? 'owner' : row.memberRole!,
      owner: row.owner,
    }));
}

/** Resolve one accessible project without loading the user's project list. */
export async function getAccessibleProjectBySlug(
  db: Db,
  userId: string,
  slug: string,
): Promise<AccessibleProject | null> {
  const [row] = await db
    .select({ project: projects, memberRole: projectMembers.role, owner: accessibleProjectOwner })
    .from(projects)
    .innerJoin(accessibleProjectOwner, eq(projects.user_id, accessibleProjectOwner.id))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.project_id, projects.id), eq(projectMembers.user_id, userId)),
    )
    .where(
      and(
        eq(projects.slug, slug),
        or(eq(projects.user_id, userId), eq(projectMembers.user_id, userId)),
      ),
    )
    .limit(1);

  if (!row || isAdminSuspended(row.owner.suspended_reason)) {
    return null;
  }
  return {
    project: row.project,
    role: row.project.user_id === userId ? 'owner' : row.memberRole!,
    owner: row.owner,
  };
}

// --- Project team membership and invitations ---

type ProjectMemberWithUser = Readonly<{ member: ProjectMember; user: User }>;

async function getProjectMember(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectMember | null> {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  return row ?? null;
}

export async function getProjectMembers(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectMemberWithUser>> {
  return db
    .select({ member: projectMembers, user: users })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.user_id, users.id))
    .where(eq(projectMembers.project_id, projectId))
    .orderBy(asc(projectMembers.created_at), asc(projectMembers.user_id));
}

type ProjectTeamMutationErrorReason =
  | 'project-not-found'
  | 'project-deleting'
  | 'target-user-not-found'
  | 'owner-conflict'
  | 'member-conflict'
  | 'member-not-found'
  | 'invitation-not-found'
  | 'invitation-not-pending'
  | 'invitation-not-target'
  | 'invitation-expired'
  | 'pending-invitation-limit'
  | 'owner-suspended'
  | 'forbidden';

export class ProjectTeamMutationError extends Error {
  readonly status: 403 | 404 | 409;

  constructor(readonly reason: ProjectTeamMutationErrorReason) {
    super(reason);
    this.name = 'ProjectTeamMutationError';
    this.status =
      reason === 'invitation-not-target' || reason === 'owner-suspended' || reason === 'forbidden'
        ? 403
        : reason.endsWith('not-found')
          ? 404
          : 409;
  }
}

async function lockProject(db: Db, projectId: string): Promise<Project> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!project) {
    throw new ProjectTeamMutationError('project-not-found');
  }
  if (project.status === 'deleting') {
    throw new ProjectTeamMutationError('project-deleting');
  }
  return project;
}

/** Re-check team-management access while the project lock is held. */
async function requireLockedMembersCapability(
  db: Db,
  project: Project,
  actorUserId: string,
  platformAdmin = false,
): Promise<void> {
  await requireLockedProjectOwnerActive(db, project);
  if (platformAdmin || project.user_id === actorUserId) {
    return;
  }
  const actorMember = await getProjectMember(db, project.id, actorUserId);
  if (actorMember?.role !== 'admin') {
    throw new ProjectTeamMutationError('forbidden');
  }
}

async function requireLockedProjectOwnerActive(db: Db, project: Project): Promise<void> {
  const [owner] = await db
    .select({ suspendedReason: users.suspended_reason })
    .from(users)
    .where(eq(users.id, project.user_id))
    .for('share')
    .limit(1);
  if (owner && isAdminSuspended(owner.suspendedReason)) {
    throw new ProjectTeamMutationError('owner-suspended');
  }
}

async function createProjectAccessEvent(
  db: Db,
  args: {
    projectId: string;
    actorUserId: string;
    action: ProjectAccessEventAction;
    subjectUserId?: string | null;
    invitationEmailSnapshot?: string | null;
    previousRole?: ProjectMemberRole | null;
    newRole?: ProjectMemberRole | null;
  },
): Promise<void> {
  await db.insert(projectAccessEvents).values({
    id: generateId('pae'),
    project_id: args.projectId,
    actor_user_id: args.actorUserId,
    subject_user_id: args.subjectUserId ?? null,
    invitation_email_snapshot: args.invitationEmailSnapshot ?? null,
    previous_role: args.previousRole ?? null,
    new_role: args.newRole ?? null,
    action: args.action,
  });
}

export async function addProjectMember(
  db: Db,
  args: {
    projectId: string;
    subjectUserId: string;
    role: ProjectMemberRole;
    actorUserId: string;
    platformAdmin?: boolean;
  },
): Promise<ProjectMember> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, args.projectId);
    await requireLockedMembersCapability(txDb, project, args.actorUserId, args.platformAdmin);
    if (project.user_id === args.subjectUserId) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    const [target] = await txDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, args.subjectUserId))
      .for('share')
      .limit(1);
    if (!target) {
      throw new ProjectTeamMutationError('target-user-not-found');
    }
    if (await getProjectMember(txDb, args.projectId, args.subjectUserId)) {
      throw new ProjectTeamMutationError('member-conflict');
    }

    // A direct grant supersedes an invitation. The project lock also serializes
    // this with an attempt to accept that invitation.
    const [pending] = await txDb
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.project_id, args.projectId),
          eq(projectInvitations.target_user_id, args.subjectUserId),
          eq(projectInvitations.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);
    if (pending) {
      await txDb
        .update(projectInvitations)
        .set({ status: 'revoked', revoked_at: sql`now()`, revoked_by_user_id: args.actorUserId })
        .where(eq(projectInvitations.id, pending.id));
      await createProjectAccessEvent(txDb, {
        projectId: args.projectId,
        actorUserId: args.actorUserId,
        subjectUserId: args.subjectUserId,
        invitationEmailSnapshot: pending.target_email_snapshot,
        action: 'invitation_revoked',
        previousRole: pending.role,
      });
    }

    const [member] = await txDb
      .insert(projectMembers)
      .values({
        project_id: args.projectId,
        user_id: args.subjectUserId,
        role: args.role,
        added_by_user_id: args.actorUserId,
      })
      .returning();
    await createProjectAccessEvent(txDb, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: args.subjectUserId,
      action: 'member_added',
      newRole: args.role,
    });
    return member;
  });
}

export async function setProjectMemberRole(
  db: Db,
  args: {
    projectId: string;
    subjectUserId: string;
    role: ProjectMemberRole;
    actorUserId: string;
    platformAdmin?: boolean;
  },
): Promise<{ member: ProjectMember; cancelledBuilds: ReadonlyArray<TerminatedBuild> }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, args.projectId);
    await requireLockedMembersCapability(txDb, project, args.actorUserId, args.platformAdmin);
    if (project.user_id === args.subjectUserId) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    const current = await getProjectMember(txDb, args.projectId, args.subjectUserId);
    if (!current) {
      throw new ProjectTeamMutationError('member-not-found');
    }
    if (current.role === args.role) {
      return { member: current, cancelledBuilds: [] };
    }
    const [member] = await txDb
      .update(projectMembers)
      .set({ role: args.role, updated_at: sql`now()` })
      .where(
        and(
          eq(projectMembers.project_id, args.projectId),
          eq(projectMembers.user_id, args.subjectUserId),
        ),
      )
      .returning();
    await createProjectAccessEvent(txDb, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: args.subjectUserId,
      action: 'role_changed',
      previousRole: current.role,
      newRole: args.role,
    });
    const cancelledBuilds =
      args.role === 'admin'
        ? []
        : await invalidateGitHubConnectionAuthorizedBy(
            txDb,
            args.projectId,
            args.subjectUserId,
            'github connection authorizer lost admin access',
          );
    return { member, cancelledBuilds };
  });
}

export async function removeProjectMember(
  db: Db,
  args: { projectId: string; subjectUserId: string; actorUserId: string; platformAdmin?: boolean },
): Promise<{ cancelledBuilds: ReadonlyArray<TerminatedBuild> }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, args.projectId);
    if (project.user_id === args.subjectUserId) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    const current = await getProjectMember(txDb, args.projectId, args.subjectUserId);
    if (!current) {
      throw new ProjectTeamMutationError('member-not-found');
    }
    if (args.platformAdmin || args.actorUserId !== args.subjectUserId) {
      await requireLockedMembersCapability(txDb, project, args.actorUserId, args.platformAdmin);
    } else {
      await requireLockedProjectOwnerActive(txDb, project);
    }
    const [member] = await txDb
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.project_id, args.projectId),
          eq(projectMembers.user_id, args.subjectUserId),
        ),
      )
      .returning();
    if (!member) {
      throw new ProjectTeamMutationError('member-not-found');
    }
    await createProjectAccessEvent(txDb, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: args.subjectUserId,
      action:
        !args.platformAdmin && args.actorUserId === args.subjectUserId ? 'left' : 'member_removed',
      previousRole: member.role,
    });
    const cancelledBuilds = await invalidateGitHubConnectionAuthorizedBy(
      txDb,
      args.projectId,
      args.subjectUserId,
      'github connection authorizer removed from project',
    );
    return { cancelledBuilds };
  });
}

async function getProjectInvitation(
  db: Db,
  invitationId: string,
): Promise<ProjectInvitation | null> {
  const [row] = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.id, invitationId))
    .limit(1);
  return row ?? null;
}

export async function getProjectInvitations(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectInvitation>> {
  return db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.project_id, projectId))
    .orderBy(desc(projectInvitations.created_at));
}

export async function getPendingProjectInvitations(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectInvitation>> {
  return db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.project_id, projectId),
        eq(projectInvitations.status, 'pending'),
        gt(projectInvitations.expires_at, sql`now()`),
      ),
    )
    .orderBy(desc(projectInvitations.created_at))
    .limit(100);
}

export async function getPendingProjectInvitationsByUserId(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<ProjectInvitation>> {
  const rows = await db
    .select({ invitation: projectInvitations })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.project_id))
    .where(
      and(
        eq(projectInvitations.target_user_id, userId),
        eq(projectInvitations.status, 'pending'),
        gt(projectInvitations.expires_at, sql`now()`),
        eq(projects.status, 'active'),
      ),
    )
    .orderBy(desc(projectInvitations.created_at));
  return rows.map((row) => row.invitation);
}

/** The project lock must be held while checking capacity and writing the invitation. */
async function requireLockedProjectInvitationCapacity(
  db: Db,
  projectId: string,
  existingInvitationId?: string,
): Promise<void> {
  const [pendingCount] = await db
    .select({ count: count() })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.project_id, projectId),
        eq(projectInvitations.status, 'pending'),
        gt(projectInvitations.expires_at, sql`now()`),
        // A live invitation already occupies its slot; an expired one needs a free slot.
        existingInvitationId ? ne(projectInvitations.id, existingInvitationId) : undefined,
      ),
    );
  if ((pendingCount?.count ?? 0) >= 100) {
    throw new ProjectTeamMutationError('pending-invitation-limit');
  }
}

export async function createOrRefreshProjectInvitation(
  db: Db,
  args: {
    projectId: string;
    email: string;
    role: ProjectMemberRole;
    actorUserId: string;
    platformAdmin?: boolean;
  },
): Promise<Readonly<{ invitation: ProjectInvitation; target: User; refreshed: boolean }>> {
  const normalizedEmail = args.email.trim().toLowerCase();
  const targets = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizedEmail}`)
    .limit(2);
  if (targets.length !== 1) {
    throw new ProjectTeamMutationError('target-user-not-found');
  }
  const target = targets[0]!;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, args.projectId);
    const lockedUsers = await txDb
      .select()
      .from(users)
      .where(inArray(users.id, [...new Set([project.user_id, target.id])].sort()))
      .orderBy(asc(users.id))
      .for('update');
    const lockedById = new Map(lockedUsers.map((user) => [user.id, user]));
    const lockedOwner = lockedById.get(project.user_id);
    const lockedTarget = lockedById.get(target.id);
    if (!lockedTarget || lockedTarget.email?.trim().toLowerCase() !== normalizedEmail) {
      throw new ProjectTeamMutationError('target-user-not-found');
    }
    if (lockedOwner && isAdminSuspended(lockedOwner.suspended_reason)) {
      throw new ProjectTeamMutationError('owner-suspended');
    }
    if (!args.platformAdmin && project.user_id !== args.actorUserId) {
      const actorMember = await getProjectMember(txDb, project.id, args.actorUserId);
      if (actorMember?.role !== 'admin') {
        throw new ProjectTeamMutationError('forbidden');
      }
    }
    if (project.user_id === target.id) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    if (await getProjectMember(txDb, args.projectId, target.id)) {
      throw new ProjectTeamMutationError('member-conflict');
    }
    const [pending] = await txDb
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.project_id, args.projectId),
          eq(projectInvitations.target_user_id, target.id),
          eq(projectInvitations.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);

    await requireLockedProjectInvitationCapacity(txDb, args.projectId, pending?.id);

    let invitation: ProjectInvitation;
    if (pending) {
      [invitation] = await txDb
        .update(projectInvitations)
        .set({
          role: args.role,
          target_email_snapshot: normalizedEmail,
          invited_by_user_id: args.actorUserId,
          expires_at: expiresAt,
        })
        .where(eq(projectInvitations.id, pending.id))
        .returning();
    } else {
      [invitation] = await txDb
        .insert(projectInvitations)
        .values({
          id: generateId('pinv'),
          project_id: args.projectId,
          target_user_id: target.id,
          target_email_snapshot: normalizedEmail,
          role: args.role,
          invited_by_user_id: args.actorUserId,
          expires_at: expiresAt,
        })
        .returning();
    }
    await createProjectAccessEvent(txDb, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: target.id,
      invitationEmailSnapshot: normalizedEmail,
      action: 'invited',
      previousRole: pending?.role,
      newRole: args.role,
    });
    return { invitation, target: lockedTarget, refreshed: !!pending };
  });
}

export async function resendProjectInvitation(
  db: Db,
  args: { projectId: string; invitationId: string; actorUserId: string },
): Promise<Readonly<{ invitation: ProjectInvitation; target: User }>> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, args.projectId);
    await requireLockedMembersCapability(txDb, project, args.actorUserId);
    const [invitation] = await txDb
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.id, args.invitationId),
          eq(projectInvitations.project_id, args.projectId),
        ),
      )
      .for('update')
      .limit(1);
    if (!invitation) {
      throw new ProjectTeamMutationError('invitation-not-found');
    }
    if (invitation.status !== 'pending') {
      throw new ProjectTeamMutationError('invitation-not-pending');
    }
    const [target] = await txDb
      .select()
      .from(users)
      .where(eq(users.id, invitation.target_user_id))
      .for('share')
      .limit(1);
    if (!target?.email) {
      throw new ProjectTeamMutationError('target-user-not-found');
    }
    await requireLockedProjectInvitationCapacity(txDb, args.projectId, invitation.id);
    const normalizedEmail = target.email.trim().toLowerCase();
    const [updated] = await txDb
      .update(projectInvitations)
      .set({ target_email_snapshot: normalizedEmail, expires_at: expiresAt })
      .where(eq(projectInvitations.id, invitation.id))
      .returning();
    await createProjectAccessEvent(txDb, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: target.id,
      invitationEmailSnapshot: normalizedEmail,
      action: 'invitation_resent',
      newRole: invitation.role,
    });
    return { invitation: updated, target };
  });
}

export async function revokeProjectInvitation(
  db: Db,
  args: { projectId: string; invitationId: string; actorUserId: string; platformAdmin?: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, args.projectId);
    await requireLockedMembersCapability(txDb, project, args.actorUserId, args.platformAdmin);
    const [invitation] = await txDb
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.id, args.invitationId),
          eq(projectInvitations.project_id, args.projectId),
        ),
      )
      .for('update')
      .limit(1);
    if (!invitation) {
      throw new ProjectTeamMutationError('invitation-not-found');
    }
    if (invitation.status !== 'pending') {
      throw new ProjectTeamMutationError('invitation-not-pending');
    }
    await txDb
      .update(projectInvitations)
      .set({
        status: 'revoked',
        revoked_at: sql`now()`,
        revoked_by_user_id: args.actorUserId,
      })
      .where(eq(projectInvitations.id, invitation.id));
    await createProjectAccessEvent(txDb, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: invitation.target_user_id,
      invitationEmailSnapshot: invitation.target_email_snapshot,
      action: 'invitation_revoked',
      previousRole: invitation.role,
    });
  });
}

export async function respondToProjectInvitation(
  db: Db,
  args: { invitationId: string; actorUserId: string; response: 'accept' | 'decline' },
): Promise<Readonly<{ member: ProjectMember | null }>> {
  const locator = await getProjectInvitation(db, args.invitationId);
  if (!locator) {
    throw new ProjectTeamMutationError('invitation-not-found');
  }

  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const project = await lockProject(txDb, locator.project_id);
    const [locked] = await txDb
      .select({
        invitation: projectInvitations,
        expired: sql<boolean>`${projectInvitations.expires_at} <= now()`,
      })
      .from(projectInvitations)
      .where(eq(projectInvitations.id, args.invitationId))
      .for('update')
      .limit(1);
    if (!locked) {
      throw new ProjectTeamMutationError('invitation-not-found');
    }
    const invitation = locked.invitation;
    if (invitation.target_user_id !== args.actorUserId) {
      throw new ProjectTeamMutationError('invitation-not-target');
    }
    const resultingStatus = args.response === 'accept' ? 'accepted' : 'declined';
    if (invitation.status === resultingStatus) {
      if (args.response === 'accept' && project.user_id === args.actorUserId) {
        throw new ProjectTeamMutationError('owner-conflict');
      }
      const member =
        args.response === 'accept'
          ? await getProjectMember(txDb, project.id, args.actorUserId)
          : null;
      // Acceptance is idempotent only while the access it created still
      // exists. Once an administrator removes that member, replaying the old
      // invitation must not produce a 500 or recreate access; a fresh invite
      // is required.
      if (args.response === 'accept' && !member) {
        throw new ProjectTeamMutationError('invitation-not-pending');
      }
      return { member };
    }
    if (invitation.status !== 'pending') {
      throw new ProjectTeamMutationError('invitation-not-pending');
    }
    if (locked.expired) {
      await txDb
        .update(projectInvitations)
        .set({ status: 'expired' })
        .where(eq(projectInvitations.id, invitation.id));
      return { error: 'invitation-expired' as const };
    }
    let member: ProjectMember | null = null;
    if (args.response === 'accept') {
      if (project.user_id === args.actorUserId) {
        throw new ProjectTeamMutationError('owner-conflict');
      }
      if (await getProjectMember(txDb, project.id, args.actorUserId)) {
        throw new ProjectTeamMutationError('member-conflict');
      }
      await requireLockedProjectOwnerActive(txDb, project);
      [member] = await txDb
        .insert(projectMembers)
        .values({
          project_id: project.id,
          user_id: args.actorUserId,
          role: invitation.role,
          added_by_user_id: invitation.invited_by_user_id,
        })
        .returning();
    }
    await txDb
      .update(projectInvitations)
      .set({
        status: resultingStatus,
        accepted_by_user_id: args.response === 'accept' ? args.actorUserId : null,
        accepted_at: args.response === 'accept' ? sql`now()` : null,
      })
      .where(eq(projectInvitations.id, invitation.id));
    await createProjectAccessEvent(txDb, {
      projectId: project.id,
      actorUserId: args.actorUserId,
      subjectUserId: args.actorUserId,
      invitationEmailSnapshot: invitation.target_email_snapshot,
      action: args.response === 'accept' ? 'accepted' : 'declined',
      newRole: args.response === 'accept' ? invitation.role : null,
    });
    return { member };
  });

  if ('error' in result) {
    throw new ProjectTeamMutationError(result.error!);
  }
  return result;
}

// --- Project ownership history ---

export async function getProjectOwnershipPeriodsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<ProjectOwnershipPeriod>> {
  if (projectIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(projectOwnershipPeriods)
    .where(inArray(projectOwnershipPeriods.project_id, projectIds))
    .orderBy(asc(projectOwnershipPeriods.project_id), asc(projectOwnershipPeriods.starts_at));
}

export async function getProjectUsageOwnershipSnapshot(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<
  Readonly<{
    projects: ReadonlyArray<Project>;
    ownershipPeriods: ReadonlyArray<ProjectOwnershipPeriod>;
  }>
> {
  const ids = [...new Set(projectIds)].sort();
  if (ids.length === 0) {
    return { projects: [], ownershipPeriods: [] };
  }
  return db.transaction(async (tx) => {
    const lockedProjects = await tx
      .select()
      .from(projects)
      .where(inArray(projects.id, ids))
      .orderBy(asc(projects.id))
      .for('share');
    const lockedProjectIds = lockedProjects.map((project) => project.id);
    const ownershipPeriods =
      lockedProjectIds.length === 0
        ? []
        : await tx
            .select()
            .from(projectOwnershipPeriods)
            .where(inArray(projectOwnershipPeriods.project_id, lockedProjectIds))
            .orderBy(
              asc(projectOwnershipPeriods.project_id),
              asc(projectOwnershipPeriods.starts_at),
            );
    return { projects: lockedProjects, ownershipPeriods };
  });
}

export async function getOpenProjectOwnershipPeriodsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<ProjectOwnershipPeriod>> {
  if (projectIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(projectOwnershipPeriods)
    .where(
      and(
        inArray(projectOwnershipPeriods.project_id, projectIds),
        isNull(projectOwnershipPeriods.ends_at),
      ),
    );
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
    .selectDistinctOn([deployments.project_id], {
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
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id));

  return new Map(rows.map((row) => [row.project_id, row]));
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
    assetHashes?: string;
    billingUserId?: string | null;
    initiatedByUserId?: string | null;
  },
): Promise<Deployment> {
  const id = generateId('dpl');
  const billingUserId =
    metadata?.billingUserId ?? (await getProject(db, projectId))?.user_id ?? null;
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
      asset_hashes: metadata?.assetHashes ?? null,
      billing_user_id: billingUserId,
      initiated_by_user_id: metadata?.initiatedByUserId ?? null,
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

/** Claim a protected cutover for compensation before reverting external state. */
export async function beginDeploymentCompensation(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set({ status: 'compensating', updated_at: sql`now()` })
    .where(and(eq(deployments.id, id), eq(deployments.status, 'cutover')))
    .returning({ id: deployments.id });
  return updated.length === 1;
}

/** Atomically protect an owned nonterminal deployment before external cutover. */
export async function beginDeploymentCutover(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set({ status: 'cutover', updated_at: sql`now()` })
    .where(
      and(
        eq(deployments.id, id),
        inArray(deployments.status, ['pending', 'uploading', 'migrating', 'prerendering']),
      ),
    )
    .returning({ id: deployments.id });
  return updated.length === 1;
}

export async function getDeployment(db: Db, id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return row ?? null;
}

/** Remove an internal rollback fence only when this request still owns it. */
export async function deleteRollbackLease(db: Db, id: string, ownerId: string): Promise<boolean> {
  const deleted = await db
    .delete(deployments)
    .where(
      and(
        eq(deployments.id, id),
        eq(deployments.source, 'rollback-lease'),
        sql`${deployments.manifest}::jsonb ->> 'ownerId' = ${ownerId}`,
      ),
    )
    .returning({ id: deployments.id });
  return deleted.length === 1;
}

export async function updateRollbackLeaseState(
  db: Db,
  id: string,
  targetDeploymentId: string,
  state: 'running' | 'retryable' | 'applied',
  ownerId: string,
  expectedOwnerId: string,
  migrationDiff?: ReadonlyArray<string>,
): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set({
      manifest: JSON.stringify({
        version: 1,
        targetDeploymentId,
        state,
        ownerId,
        ...(migrationDiff ? { migrationDiff } : {}),
      }),
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(deployments.id, id),
        eq(deployments.source, 'rollback-lease'),
        sql`${deployments.manifest}::jsonb ->> 'ownerId' = ${expectedOwnerId}`,
      ),
    )
    .returning({ id: deployments.id });
  return updated.length === 1;
}

export async function getProjectDeployments(
  db: Db,
  projectId: string,
  limit = 5,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
      ),
    )
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
        ne(deployments.status, 'cutover'),
        ne(deployments.status, 'compensating'),
        or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
        sql`${deployments.updated_at} < now() - interval '30 minutes'`,
        sql`NOT EXISTS (SELECT 1 FROM deployment_operations op WHERE op.id = ${deployments.id} AND op.status <> 'terminal')`,
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

export async function getPendingDeploymentOperation(
  db: Db,
  projectId: string,
): Promise<{ id: string } | null> {
  const [operation] = await db
    .select({ id: schema.deploymentOperations.id })
    .from(schema.deploymentOperations)
    .where(
      and(
        eq(schema.deploymentOperations.project_id, projectId),
        ne(schema.deploymentOperations.status, 'terminal'),
      ),
    )
    .limit(1);
  return operation ?? null;
}

/** Newest historical live row for verifying legacy Zero Trust routing freshness. */
export async function getLatestLiveDeployment(
  db: Db,
  projectId: string,
): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.status, 'live')))
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
        ne(deployments.status, 'cutover'),
        ne(deployments.status, 'compensating'),
        or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
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

type EmailDestinationMutationOptions = Readonly<{
  ownerAudit?: OwnerVerificationAudit;
  actorUserId?: string;
}>;

async function requireEmailDestinationSettingsAccess(
  db: DbOrTx,
  projectId: string,
  actorUserId: string | undefined,
): Promise<void> {
  if (actorUserId) {
    await requireProjectCapability(db as Db, projectId, actorUserId, 'settings');
  }
}

/**
 * RETURNING identifies the sole inserter so only it sends a verification email.
 * A missing row means it was concurrently deleted; callers must retry.
 *
 * Inherited owner consent requires a FOR SHARE lock on users: an email change
 * must either commit before this check or revoke the inserted row afterward.
 * Lock projects first to match build transactions and avoid a lock-order cycle.
 * A supplied actor is reauthorized after that project lock is acquired.
 */
export async function tryCreateEmailDestination(
  db: Db,
  projectId: string,
  address: string,
  cfDestinationId: string | null,
  status: EmailDestination['status'] = 'pending',
  verifiedAt?: string | null,
  verificationSource: EmailDestination['verification_source'] = 'cf',
  options: EmailDestinationMutationOptions = {},
): Promise<{ row: EmailDestination | null; inserted: boolean; ownerEmailChanged?: true }> {
  const { actorUserId, ownerAudit } = options;
  const values = {
    id: generateId('edst'),
    project_id: projectId,
    address: address.toLowerCase(),
    cf_destination_id: cfDestinationId,
    status,
    verified_at: status === 'verified' ? (verifiedAt ?? new Date().toISOString()) : null,
    verification_source: verificationSource,
    verified_by_user_id: ownerAudit?.userId ?? null,
    verified_by_email_snapshot: ownerAudit?.emailSnapshot ?? null,
  };
  const insertRow = async (via: DbOrTx): Promise<EmailDestination | undefined> => {
    if (cfDestinationId) {
      const [retired] = await via
        .select({ id: emailDestinationCleanups.cf_destination_id })
        .from(emailDestinationCleanups)
        .where(eq(emailDestinationCleanups.cf_destination_id, cfDestinationId))
        .limit(1);
      if (retired) {
        return undefined;
      }
    }
    const [row] = await via
      .insert(emailDestinations)
      .values(values)
      .onConflictDoNothing({ target: [emailDestinations.project_id, emailDestinations.address] })
      .returning();
    return row;
  };
  let inserted: EmailDestination | undefined;
  if (!ownerAudit) {
    const outcome = await db.transaction(async (tx) => {
      await lockEmailPolicy(tx);
      const [project] = await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      if (!project || project.status === 'deleting') {
        return 'project-unavailable' as const;
      }
      await requireEmailDestinationSettingsAccess(tx, projectId, actorUserId);
      return insertRow(tx);
    });
    if (outcome === 'project-unavailable') {
      return { row: null, inserted: false };
    }
    inserted = outcome;
  } else {
    const outcome = await db.transaction(async (tx) => {
      await lockEmailPolicy(tx);
      const [project] = await tx
        .select({ status: projects.status, ownerUserId: projects.user_id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      if (!project || project.status === 'deleting') {
        return 'project-unavailable' as const;
      }
      await requireEmailDestinationSettingsAccess(tx, projectId, actorUserId);
      if (project.ownerUserId !== ownerAudit.userId) {
        return 'owner-email-changed' as const;
      }
      const [owner] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, ownerAudit.userId))
        .for('share')
        .limit(1);
      if ((owner?.email?.toLowerCase() ?? null) !== ownerAudit.emailSnapshot.toLowerCase()) {
        return 'owner-email-changed';
      }
      return insertRow(tx);
    });
    if (outcome === 'owner-email-changed') {
      return { row: null, inserted: false, ownerEmailChanged: true };
    }
    if (outcome === 'project-unavailable') {
      return { row: null, inserted: false };
    }
    inserted = outcome;
  }
  if (inserted) {
    return { row: inserted, inserted: true };
  }
  // A concurrent insert may have won, or cleanup retired the provider tag.
  // Return an existing project row if present; otherwise the caller retries.
  const existing = await getEmailDestinationByAddress(db, projectId, address);
  return { row: existing, inserted: false };
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
 * we flip them back to 'pending' / 'platform' (rather than
 * hard-deleting) to give the user a re-confirm path: a repeat
 * `void email allow <address>` re-sends our own confirmation link and
 * the confirm route flips the row back, without losing its history. We
 * also clear the audit columns so the row no longer claims to be
 * owner-verified by a stale identity.
 *
 * Called from the OAuth callback in `routes/auth.ts`, which re-reads the
 * provider's current email on every login and writes it straight back
 * via `updateUser` — so the stored address really does change under us.
 * The caller runs this in the same transaction as `updateUser` so consent
 * and the owner's current address change together.
 */
export async function revokeOwnerVerifiedDestinationsForUserChange(
  db: Db,
  userId: string,
  oldEmail: string,
): Promise<void> {
  const lowered = oldEmail.toLowerCase();
  // The caller holds the policy lock in its surrounding profile transaction.
  // Lock affected projects before changing consent so admission cannot read
  // their old verified destinations after this revocation commits.
  const affected = await db
    .selectDistinct({ project_id: emailDestinations.project_id })
    .from(emailDestinations)
    .where(
      and(
        eq(emailDestinations.verified_by_user_id, userId),
        sql`lower(${emailDestinations.verified_by_email_snapshot}) = ${lowered}`,
        eq(emailDestinations.verification_source, 'cf'),
      ),
    );
  for (const projectId of affected.map((row) => row.project_id).sort()) {
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
  }
  await db
    .update(emailDestinations)
    .set({
      status: 'pending',
      verified_at: null,
      verified_by_user_id: null,
      verified_by_email_snapshot: null,
      // Re-sourcing the row to 'platform' is what makes the demotion
      // STICK. The destinations GET in `routes/email.ts` refreshes every
      // row matching `status = 'pending' && verification_source !== 'platform'`
      // against CF's account-level list — and nothing deleted the address
      // on CF's side, so CF still reports it verified. A row left as 'cf'
      // therefore drops straight back into that filter and the very next
      // `void email destinations` re-promotes it to 'verified', undoing
      // this revoke entirely. 'platform' is also the correct state on the
      // merits: the account-level CF flag is exactly the consent we just
      // decided we can no longer inherit, so the only thing that may
      // re-verify the row is a per-recipient click on our own confirmation
      // link (a repeat `void email allow <address>` re-sends it).
      //
      // Safe inside this statement: Postgres evaluates the WHERE predicate
      // against the PRE-update row, so narrowing `verification_source` to
      // 'platform' here cannot de-select the `= 'cf'` clause below.
      verification_source: 'platform',
    })
    .where(
      and(
        eq(emailDestinations.verified_by_user_id, userId),
        sql`lower(${emailDestinations.verified_by_email_snapshot}) = ${lowered}`,
        eq(emailDestinations.verification_source, 'cf'),
      ),
    );
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
): Promise<boolean> {
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
  const [existing] = await db
    .select({ project_id: emailDestinations.project_id })
    .from(emailDestinations)
    .where(eq(emailDestinations.id, id))
    .limit(1);
  if (!existing) {
    return false;
  }
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, existing.project_id))
      .for('update');
    if (cfDestinationId) {
      const [retired] = await tx
        .select({ id: emailDestinationCleanups.cf_destination_id })
        .from(emailDestinationCleanups)
        .where(eq(emailDestinationCleanups.cf_destination_id, cfDestinationId))
        .limit(1);
      if (retired) {
        return false;
      }
    }
    const updated = await tx
      .update(emailDestinations)
      .set(patch)
      .where(
        and(eq(emailDestinations.id, id), eq(emailDestinations.project_id, existing.project_id)),
      )
      .returning({ id: emailDestinations.id });
    return updated.length > 0;
  });
}

async function queueDestinationCleanupTx(tx: Tx, cfDestinationId: string): Promise<void> {
  await tx
    .insert(emailDestinationCleanups)
    .values({ cf_destination_id: cfDestinationId })
    .onConflictDoNothing();
}

/** Revoke one project's consent and durably queue the last provider tag. */
export async function deleteEmailDestination(
  db: Db,
  id: string,
  actorUserId?: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [existing] = await tx
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, id))
      .for('update');
    if (!existing) {
      return null;
    }
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, existing.project_id))
      .for('update');
    await requireEmailDestinationSettingsAccess(tx, existing.project_id, actorUserId);
    await tx
      .delete(emailDestinations)
      .where(
        and(eq(emailDestinations.id, id), eq(emailDestinations.project_id, existing.project_id)),
      );
    if (!existing.cf_destination_id) {
      return null;
    }
    const [references] = await tx
      .select({ n: countDistinct(emailDestinations.project_id) })
      .from(emailDestinations)
      .where(eq(emailDestinations.cf_destination_id, existing.cf_destination_id));
    if (Number(references?.n ?? 0) !== 0) {
      return null;
    }
    await queueDestinationCleanupTx(tx, existing.cf_destination_id);
    return existing.cf_destination_id;
  });
}

/** Revoke all project consent rows and queue provider tags with no live sibling. */
export async function deleteProjectEmailDestinations(
  db: Db,
  projectId: string,
): Promise<Array<string>> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    const rows = await tx
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, projectId))
      .for('update');
    await tx.delete(emailDestinations).where(eq(emailDestinations.project_id, projectId));
    const queued: Array<string> = [];
    for (const tag of new Set(rows.map((row) => row.cf_destination_id).filter(Boolean))) {
      const [references] = await tx
        .select({ n: countDistinct(emailDestinations.project_id) })
        .from(emailDestinations)
        .where(eq(emailDestinations.cf_destination_id, tag!));
      if (Number(references?.n ?? 0) === 0) {
        await queueDestinationCleanupTx(tx, tag!);
        queued.push(tag!);
      }
    }
    return queued;
  });
}

/** Queue an allocated tag that never gained a SQL consent row. */
export async function queueUnreferencedEmailDestinationCleanup(
  db: Db,
  cfDestinationId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [references] = await tx
      .select({ n: countDistinct(emailDestinations.project_id) })
      .from(emailDestinations)
      .where(eq(emailDestinations.cf_destination_id, cfDestinationId));
    if (Number(references?.n ?? 0) !== 0) {
      return false;
    }
    await queueDestinationCleanupTx(tx, cfDestinationId);
    return true;
  });
}

/**
 * Promote a pending row to `verified` by INHERITING the project owner's
 * Cloudflare-side consent from a destination this row did not register.
 *
 * The listing refresh in `routes/email.ts` reaches for this when the row's
 * own CF destination is gone and the account now carries the same address
 * under a new tag that somebody else's registration verified. For the
 * owner's own address that is Option C (design doc 0078): the human who
 * clicked is the human who owns the project. The row adopts the live tag
 * and records whose consent it inherited, exactly as the create paths do
 * (`autoAddOwnerDestination`, the owner branch of the POST), so a later
 * owner-email change can revoke it through
 * `revokeOwnerVerifiedDestinationsForUserChange`.
 *
 * `verification_source` stays `'cf'`: the consent is still Cloudflare's
 * click, only attributed. Non-owner rows never take this path.
 *
 * Same gate as the owner-audited insert in `tryCreateEmailDestination`, for
 * the same reason: the listing decided "this is the owner's address" from an
 * unlocked read, and a login that rotates the address can commit between
 * that read and this write — its revoke skips a `pending` row, and no later
 * login looks again. So the promotion runs in one transaction behind
 * `SELECT … FOR SHARE` on the owner's `users` row (after `projects`, in the
 * lock order the build transactions use) and writes nothing when
 * `users.email` no longer equals the snapshot, or the row is no longer
 * `pending`. Returns whether the row was promoted.
 */
export async function promoteEmailDestinationWithOwnerAudit(
  db: Db,
  projectId: string,
  id: string,
  cfDestinationId: string,
  verifiedAt: string | null,
  ownerAudit: OwnerVerificationAudit,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [project] = await tx
      .select({ ownerUserId: projects.user_id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    if (project?.ownerUserId !== ownerAudit.userId) {
      return false;
    }
    const [retired] = await tx
      .select({ id: emailDestinationCleanups.cf_destination_id })
      .from(emailDestinationCleanups)
      .where(eq(emailDestinationCleanups.cf_destination_id, cfDestinationId))
      .limit(1);
    if (retired) {
      return false;
    }
    const [owner] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ownerAudit.userId))
      .for('share')
      .limit(1);
    if ((owner?.email?.toLowerCase() ?? null) !== ownerAudit.emailSnapshot.toLowerCase()) {
      return false;
    }
    const promoted = await tx
      .update(emailDestinations)
      .set({
        status: 'verified',
        cf_destination_id: cfDestinationId,
        verified_at: verifiedAt ?? new Date().toISOString(),
        verified_by_user_id: ownerAudit.userId,
        verified_by_email_snapshot: ownerAudit.emailSnapshot,
      })
      .where(and(eq(emailDestinations.id, id), eq(emailDestinations.status, 'pending')))
      .returning({ id: emailDestinations.id });
    return promoted.length > 0;
  });
}

// --- Deletion ---

export type ProjectCleanupJobInput = typeof projectCleanupJobs.$inferInsert;

export function cleanupJobsForResource(
  projectId: string,
  resource: Resource,
): Array<ProjectCleanupJobInput> {
  if (resource.type === 'container') {
    return [];
  }
  const jobs: Array<ProjectCleanupJobInput> = [
    {
      target: `cf-resource:${projectId}:${resource.type}:${resource.cf_id}`,
      project_id: projectId,
      kind: 'cf-resource',
      payload: { type: resource.type, cfId: resource.cf_id },
    },
  ];
  if (resource.type === 'queue') {
    const key = `queue:${getProjectQueueName(projectId, resource.binding_name)}`;
    jobs.push({
      target: `routing-key:${projectId}:${key}`,
      project_id: projectId,
      kind: 'routing-key',
      payload: { key },
    });
  }
  return jobs;
}

export async function enqueueProjectCleanupJobs(
  db: DbOrTx,
  jobs: ReadonlyArray<ProjectCleanupJobInput>,
): Promise<void> {
  if (jobs.length === 0) {
    return;
  }
  await db
    .insert(projectCleanupJobs)
    .values([...jobs])
    .onConflictDoNothing();
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
  processedResourceCfIds: ReadonlySet<string> = new Set(),
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
    // Record resources that appeared after the pre-cascade cleanup snapshot in
    // the same transaction that removes their only durable handles. A failed
    // provider delete after COMMIT can then be retried by the scheduled worker.
    await enqueueProjectCleanupJobs(
      txDb,
      deletedResources
        .filter((resource) => !processedResourceCfIds.has(resource.cf_id))
        .flatMap((resource) => cleanupJobsForResource(projectId, resource)),
    );
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

export class LastAdminError extends Error {
  constructor() {
    super('The last active administrator cannot be deleted, suspended, or demoted.');
    this.name = 'LastAdminError';
  }
}

/** Keep this transaction limited to database work, never external cleanup. */
async function withAdminRemovalGuard<T>(
  db: Db,
  id: string,
  change: (db: Db, user: User | null) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Serialize the check and access change with other removals and bootstrap.
    // A count outside this lock lets two administrators remove each other.
    const authSettings = await lockAuthSettings(tx as unknown as Db);
    await tx.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
    const transactionDb = tx as unknown as Db;
    const user = await getUser(transactionDb, id);
    if (user?.role === 'admin') {
      let others = await tx
        .select({ suspended_reason: users.suspended_reason })
        .from(users)
        .where(and(eq(users.role, 'admin'), ne(users.id, id)));
      if (authSettings?.sessions_required) {
        others = await tx
          .select({ suspended_reason: users.suspended_reason })
          .from(users)
          .innerJoin(
            schema.platformLoginIdentities,
            eq(schema.platformLoginIdentities.user_id, users.id),
          )
          .innerJoin(
            schema.platformLoginConnections,
            eq(schema.platformLoginConnections.id, schema.platformLoginIdentities.connection_id),
          )
          .where(
            and(
              eq(users.role, 'admin'),
              ne(users.id, id),
              eq(schema.platformLoginConnections.enabled, true),
            ),
          );
      }
      if (!others.some((admin) => !isAdminSuspended(admin.suspended_reason))) {
        throw new LastAdminError();
      }
    }
    return change(transactionDb, user);
  });
}

/**
 * Revoke administrator access before external deletion/suspension work begins.
 * This durable change prevents another removal from counting this administrator
 * while cleanup is in flight. Keep it on cleanup failure so retries stay safe.
 */
export async function prepareUserRemoval(
  db: Db,
  id: string,
  action: { kind: 'delete' } | { kind: 'suspend'; reason: string },
  dryRun = false,
): Promise<User | null> {
  return withAdminRemovalGuard(db, id, async (tx, user) => {
    if (user?.role === 'admin' && !dryRun) {
      await tx
        .update(users)
        .set(action.kind === 'delete' ? { role: 'user' } : { suspended_reason: action.reason })
        .where(eq(users.id, id));
    }
    return user;
  });
}

export async function suspendUser(db: Db, id: string, reason: string): Promise<void> {
  const suspend = async (target: Db) => {
    await target.update(users).set({ suspended_reason: reason }).where(eq(users.id, id));
  };
  if (isAdminSuspended(reason)) {
    await withAdminRemovalGuard(db, id, suspend);
  } else {
    // Usage limits suspend app traffic, not administrator access. A delayed
    // quota write must not undo an administrator's manual access revocation.
    await db
      .update(users)
      .set({ suspended_reason: reason })
      .where(
        and(
          eq(users.id, id),
          or(
            isNull(users.suspended_reason),
            inArray(users.suspended_reason, [
              REASON_REQUESTS_EXCEEDED,
              REASON_SANDBOX_RUNTIME_EXCEEDED,
            ]),
          ),
        ),
      );
  }
}

export async function unsuspendUser(db: Db, id: string): Promise<void> {
  await db.update(users).set({ suspended_reason: null }).where(eq(users.id, id));
}

export async function deleteUser(db: Db, id: string): Promise<ReadonlyArray<TerminatedBuild>> {
  return withAdminRemovalGuard(db, id, async (tx) => {
    const cancelledBuilds: Array<TerminatedBuild> = [];
    // Discover every project from one statement snapshot. Separate reads could
    // miss an invitation accepted between the membership and invitation reads.
    const affectedProjects = await tx
      .select({ projectId: projectMembers.project_id })
      .from(projectMembers)
      .where(eq(projectMembers.user_id, id))
      .union(
        tx
          .select({ projectId: projectInvitations.project_id })
          .from(projectInvitations)
          .where(
            and(
              eq(projectInvitations.target_user_id, id),
              eq(projectInvitations.status, 'pending'),
            ),
          ),
      )
      .union(
        tx
          .select({ projectId: githubConnections.project_id })
          .from(githubConnections)
          .where(eq(githubConnections.authorized_by_user_id, id)),
      );
    const projectIds = affectedProjects.map(({ projectId }) => projectId).sort();
    if (projectIds.length > 0) {
      // GitHub connection CRUD and build creation take the project lock before
      // the connection lock. Preserve that order here so deleting an
      // authorizing member serializes with both paths without deadlocking.
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.id, projectIds))
        .orderBy(asc(projects.id))
        .for('update');

      // Pending invitations are in the lock set so acceptance cannot add a
      // membership after discovery. Re-read the connections under every lock:
      // a creator that acquired a project lock first may have inserted after
      // discovery and would otherwise block the user delete below.
      const authorizedConnections = await tx
        .select({ projectId: githubConnections.project_id })
        .from(githubConnections)
        .where(
          and(
            eq(githubConnections.authorized_by_user_id, id),
            inArray(githubConnections.project_id, projectIds),
          ),
        )
        .orderBy(asc(githubConnections.project_id));
      for (const { projectId } of authorizedConnections) {
        cancelledBuilds.push(
          ...(await invalidateGitHubConnectionAuthorizedBy(
            tx,
            projectId,
            id,
            'github connection authorizer account deleted',
          )),
        );
      }
    }
    await tx.delete(users).where(eq(users.id, id));
    return cancelledBuilds;
  });
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
      or(
        ilike(projects.slug, pattern),
        ilike(users.login, pattern),
        ilike(projects.id, pattern),
        ilike(projects.type, pattern),
        ilike(lastDeploy.last_deploy_status, pattern),
      ),
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
        ilike(deployments.error_message, pattern),
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
  const [projectRows, ownershipRows] = await Promise.all([
    db
      .select({
        id: projects.id,
        slug: projects.slug,
        user_id: projects.user_id,
        created_at: projects.created_at,
      })
      .from(projects)
      .where(inArray(projects.user_id, userIds)),
    db
      .selectDistinct({ user_id: projectOwnershipPeriods.owner_user_id })
      .from(projectOwnershipPeriods)
      .where(inArray(projectOwnershipPeriods.owner_user_id, userIds)),
  ]);

  const projectsByUser = new Map<string, typeof projectRows>();
  for (const p of projectRows) {
    const list = projectsByUser.get(p.user_id) ?? [];
    list.push(p);
    projectsByUser.set(p.user_id, list);
  }

  const usersWithOwnership = new Set(ownershipRows.map((row) => row.user_id));
  return userRows.map((user) => {
    const projects = projectsByUser.get(user.id) ?? [];
    return {
      user,
      projects,
      needsUsageReconciliation: projects.length > 0 || usersWithOwnership.has(user.id),
    };
  });
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
      entries.flatMap((entry) =>
        entry.type === 'email' && !entry.pattern.startsWith('*@')
          ? [entry.pattern.toLowerCase()]
          : [],
      ),
    ),
  );
  const emailDomains = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.type === 'email' && entry.pattern.startsWith('*@')
          ? [entry.pattern.slice(1).toLowerCase()]
          : [],
      ),
    ),
  );
  const githubLogins = Array.from(
    new Set(
      entries.flatMap((entry) => (entry.type === 'github' ? [entry.pattern.toLowerCase()] : [])),
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

  const identityEntries = entries.filter((entry) => entry.type === 'identity');
  const matchingIdentities =
    identityEntries.length > 0
      ? await db
          .select({
            userId: platformLoginIdentities.user_id,
            connectionId: platformLoginIdentities.connection_id,
            subject: platformLoginIdentities.subject,
          })
          .from(platformLoginIdentities)
          .where(
            or(
              ...identityEntries.map((entry) =>
                and(
                  eq(platformLoginIdentities.connection_id, entry.connectionId),
                  eq(platformLoginIdentities.subject, entry.subject),
                ),
              ),
            ),
          )
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

  const matchingUserIds = Array.from(
    new Set([
      ...matchingUsers.map((user) => user.id),
      ...matchingIdentities.map((row) => row.userId),
    ]),
  );
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
    if (entry.type === 'identity') {
      return false;
    }
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
    if (entry.type === 'identity') {
      const userIds = matchingIdentities
        .filter(
          (identity) =>
            identity.connectionId === entry.connectionId && identity.subject === entry.subject,
        )
        .map((identity) => identity.userId);
      return {
        ...entry,
        accepted: userIds.length > 0,
        deployed: userIds.some((userId) => deployedUserIds.has(userId)),
      };
    }
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

export async function setInvitationEmailDeliveryStatus(
  db: Db,
  id: string,
  status: NonNullable<Invitation['email_delivery_status']>,
): Promise<Invitation> {
  const [row] = await db
    .update(invitations)
    .set({ email_delivery_status: status })
    .where(eq(invitations.id, id))
    .returning();
  if (!row) {
    throw new Error(`Invitation ${id} disappeared before its email status could be saved.`);
  }
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
 * plan, suspension reason, and count of builds in `ACTIVE_BUILD_STATUSES`
 * (`starting`/`building`/`deploying`). The scheduler uses this to decide which
 * owners are AT their plan's concurrency cap (cap is plan-derived in
 * the effective plan catalog, NOT a user DB column) and pass those ids to `getQueuedBuilds` as
 * `excludeUserIds`, so a capped tenant's rows never starve the scan window.
 *
 * Only `container` builds gate scheduling, so the queued-work filter is scoped
 * to that executor. The active-build count is NOT executor-scoped: an active
 * `github_actions` build also occupies a concurrency slot (mirroring
 * `claimBuildForStartWithinLimit`'s per-user count), so it must count toward the
 * cap.
 */
export async function getUsersWithQueuedContainerBuilds(db: Db): Promise<
  ReadonlyArray<{
    userId: string;
    plan: string;
    suspendedReason: string | null;
    activeBuilds: number;
  }>
> {
  const activeBuilds = alias(builds, 'active_builds');
  const rows = await db
    .select({
      userId: users.id,
      plan: users.plan,
      suspendedReason: users.suspended_reason,
      // Count only active rows through idx_builds_user_status. Joining the
      // entire builds table here would touch every historical build belonging
      // to each queued owner on every scheduler tick.
      activeBuilds: sql<number>`(
        select count(*) from ${builds} as active_builds
        where ${activeBuilds.user_id} = ${users.id}
          and ${inArray(activeBuilds.status, ACTIVE_BUILD_STATUSES)}
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
    );
  return rows.map((r) => ({
    userId: r.userId,
    plan: r.plan,
    suspendedReason: r.suspendedReason,
    activeBuilds: Number(r.activeBuilds),
  }));
}

/** Cancel queued container work only for users who are still manually suspended. */
export async function cancelQueuedContainerBuildsForUsers(
  db: Db,
  userIds: ReadonlyArray<string>,
): Promise<number> {
  if (userIds.length === 0) {
    return 0;
  }
  const suspendedOwners = db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, [...userIds]),
        isNotNull(users.suspended_reason),
        notInArray(users.suspended_reason, [
          REASON_REQUESTS_EXCEEDED,
          REASON_SANDBOX_RUNTIME_EXCEEDED,
        ]),
      ),
    );
  const cancelled = await db
    .update(builds)
    .set({
      status: 'cancelled',
      error: 'project owner suspended',
      completed_at: sql`now()`,
    })
    .where(
      and(
        inArray(builds.user_id, suspendedOwners),
        eq(builds.executor, 'container'),
        eq(builds.status, 'queued'),
      ),
    )
    .returning({ id: builds.id });
  return cancelled.length;
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
 * FAILS CLOSED unless the exact connection still belongs to the project, has
 * durable authority, and its active installation still covers the repo. Every
 * connection records the project owner/admin who completed the repository proof;
 * that authorizer must still be the owner or an admin.
 * An `all` install covers every repo; a `selected` install requires the immutable
 * repo id in its cache. This is the shared predicate used by webhook and OIDC
 * resolvers as well as enqueue and final startup checks.
 */
function githubConnectionAuthorityClause() {
  return or(
    eq(githubConnections.authorized_by_user_id, projects.user_id),
    sql`exists (
      select 1
      from ${projectMembers}
      where ${projectMembers.project_id} = ${projects.id}
        and ${projectMembers.user_id} = ${githubConnections.authorized_by_user_id}
        and ${projectMembers.role} = 'admin'
    )`,
  );
}

/**
 * Invalidate provenance that no longer names a project owner/admin. Membership
 * mutations call this while holding the project row lock, so they serialize with
 * connection CRUD/build creation (which use the same project-first order).
 * Active build rows are terminalized before the connection is removed,
 * which immediately revokes their build-bound deploy tokens.
 */
async function invalidateGitHubConnectionAuthorizedBy(
  db: Db,
  projectId: string,
  userId: string,
  reason: string,
): Promise<ReadonlyArray<TerminatedBuild>> {
  const [connection] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.project_id, projectId),
        eq(githubConnections.authorized_by_user_id, userId),
      ),
    )
    .for('update')
    .limit(1);
  if (!connection) {
    return [];
  }
  const cancelledBuilds = await terminateBuildsForProject(db, projectId, { reason });
  await db.delete(githubConnections).where(eq(githubConnections.id, connection.id));
  return cancelledBuilds;
}

async function installationCoversRepoInTx(
  tx: Db,
  connectionId: string,
  projectId: string,
  installationId: string,
  repositoryId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.id, connectionId),
        eq(githubConnections.project_id, projectId),
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        or(
          eq(githubInstallations.repository_selection, 'all'),
          sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
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
 * immutable numeric repo id is in the cached `repositories` set). A stored
 * build config without a connection id fails closed.
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
  connectionId: string,
  projectId: string,
  installationId: string,
  repositoryId: string,
): Promise<boolean> {
  if (!connectionId) {
    return false;
  }
  const [row] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.id, connectionId),
        eq(githubConnections.project_id, projectId),
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        or(
          eq(githubInstallations.repository_selection, 'all'),
          sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Serialize webhook enqueue with project and connection changes. The last
 * processed push wins; an active identical commit is reused, while a completed
 * commit is reused only when it is still live so force-push rollbacks rebuild.
 * Connection configuration and repository authority are rechecked under lock.
 */
export async function supersedeAndCreateContainerBuild(
  db: Db,
  args: {
    projectId: string;
    branch: string;
    commitSha: string;
    connectionId: string;
    installationId: string;
    repositoryId: string;
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
  skipped?:
    | 'config-changed'
    | 'install-revoked'
    | 'connection-replaced'
    | 'project-deleting'
    | 'owner-suspended';
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
      .select({ status: projects.status, user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .for('update')
      .limit(1);
    if (!proj || proj.status === 'deleting') {
      return { build: null, reused: false, cancelled: [], skipped: 'project-deleting' };
    }
    const [ownerState] = await tx
      .select({ plan: users.plan, suspendedReason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, proj.user_id))
      .for('update')
      .limit(1);
    if (ownerState && isAdminSuspended(ownerState.suspendedReason)) {
      return { build: null, reused: false, cancelled: [], skipped: 'owner-suspended' };
    }
    // Resolve the size of record from the same owner row whose lock serializes
    // admission. A plan change that lands while webhook processing is doing its
    // network checks must take effect before this enqueue commits.
    const instanceType = ownerState
      ? (await resolvePlan(tx, ownerState.plan)).buildInstanceType
      : null;

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
        args.connectionId,
        args.projectId,
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
        user_id: proj.user_id,
        executor: 'container',
        status: 'queued',
        commit_sha: args.commitSha,
        branch: args.branch,
        instance_type: instanceType,
      })
      .returning();
    return { build: row, reused: false, cancelled };
  });
}

/**
 * Resolve a build by `(project, run_id, run_attempt)`. A GitHub RERUN reuses
 * the same `run_id` with an incremented `run_attempt`, so the `workflow_run` completion
 * handler must scope to the attempt: a redelivered/late completion for attempt
 * 1 must NOT resolve to attempt 2's active build (which would let it finalize
 * the wrong attempt). Active builds are ordered first (then `created_at desc`),
 * so the in-flight attempt wins on a tie.
 */
export async function getBuildByProjectRunIdAndAttempt(
  db: Db,
  projectId: string,
  githubRunId: string,
  githubRunAttempt: string,
): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.project_id, projectId),
        eq(builds.github_run_id, githubRunId),
        eq(builds.github_run_attempt, githubRunAttempt),
      ),
    )
    .orderBy(sql`(${inArray(builds.status, ACTIVE_BUILD_STATUSES)}) desc`, desc(builds.created_at))
    .limit(1);
  return row ?? null;
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
type TerminatedBuild = Readonly<{
  id: string;
  executor: Build['executor'];
  status: Build['status'];
  instance_type: string | null;
}>;

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
): Promise<ReadonlyArray<TerminatedBuild>> {
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
    commitSha?: string | null;
    branch?: string | null;
    githubRunId: string;
    githubRunAttempt: string;
    logsUrl?: string | null;
    connectionId: string;
    installationId: string;
    repositoryId: string;
    // The authorized workflow path the OIDC gate matched (the token's own
    // workflow file). Re-checked under the connection lock so a concurrent
    // PATCH that re-pins `workflow_path` can't let a now-de-authorized workflow
    // slip a build through the check→lock window. See the re-validation below.
    expectedWorkflowPath: string;
  },
): Promise<
  | { outcome: 'created'; build: Build; timeoutMinutes: number }
  | { outcome: 'reused'; build: Build }
  | { outcome: 'limit-exceeded' }
  | { outcome: 'connection-removed' }
  | { outcome: 'connection-replaced' }
  | { outcome: 'branch-mismatch' }
  | { outcome: 'workflow-mismatch' }
  | { outcome: 'install-revoked' }
  | { outcome: 'project-deleting' }
  | { outcome: 'owner-suspended' }
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
      .select({ status: projects.status, user_id: projects.user_id })
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
    const [ownerState] = await tx
      .select({ plan: users.plan, suspendedReason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, proj.user_id))
      .for('update')
      .limit(1);
    if (ownerState && isAdminSuspended(ownerState.suspendedReason)) {
      return { outcome: 'owner-suspended' };
    }
    const ownerPlan = ownerState ? await resolvePlan(tx, ownerState.plan) : null;
    const limit = ownerPlan?.limits.concurrentBuilds ?? 0;

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
        args.connectionId,
        args.projectId,
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
    // run_attempt — does NOT wrongly reuse the prior attempt's build.
    const [existing] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.project_id, args.projectId),
          eq(builds.github_run_id, args.githubRunId),
          eq(builds.github_run_attempt, args.githubRunAttempt),
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
    // (whose completion webhook was missed) would survive until the stale-build reaper.
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

    if (limit > 0) {
      const [result] = await tx
        .select({ count: count() })
        .from(builds)
        .where(
          and(eq(builds.user_id, proj.user_id), inArray(builds.status, ACTIVE_BUILD_STATUSES)),
        );
      if ((result?.count ?? 0) >= limit) {
        return { outcome: 'limit-exceeded' };
      }
    }

    const id = generateId('bld');
    const [row] = await tx
      .insert(builds)
      .values({
        id,
        project_id: args.projectId,
        user_id: proj.user_id,
        executor: 'github_actions',
        status: 'building',
        commit_sha: args.commitSha ?? null,
        branch: args.branch ?? null,
        github_run_id: args.githubRunId,
        github_run_attempt: args.githubRunAttempt,
        logs_url: args.logsUrl ?? null,
      })
      .returning();
    return {
      outcome: 'created',
      build: row,
      timeoutMinutes: ownerPlan?.limits.buildTimeoutMinutes ?? 0,
    };
  });
}

/**
 * Claims a queued container build under the same owner lock used by GitHub
 * Actions admission. The lock protects both the per-owner limit and the
 * one-active-build-per-project invariant.
 */
export async function claimBuildForStartWithinLimit(
  db: Db,
  args: {
    buildId: string;
    userId: string;
    projectId: string;
  },
): Promise<{ instanceType: string; ownerPlan: PlanId; timeoutMinutes: number } | null> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ plan: users.plan, suspendedReason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, args.userId))
      .for('update')
      .limit(1);
    if (!owner || isAdminSuspended(owner.suspendedReason)) {
      return null;
    }

    const plan = await resolvePlan(tx, owner.plan);
    const limit = plan.limits.concurrentBuilds;
    if (limit > 0) {
      const [result] = await tx
        .select({ count: count() })
        .from(builds)
        .where(and(eq(builds.user_id, args.userId), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
      if ((result?.count ?? 0) >= limit) {
        return null;
      }
    }

    // All builds for a project share an owner, so this is protected by the
    // owner lock. GitHub Actions builds count because deployments serialize at
    // the project level regardless of executor.
    const [active] = await tx
      .select({ count: count() })
      .from(builds)
      .where(
        and(eq(builds.project_id, args.projectId), inArray(builds.status, ACTIVE_BUILD_STATUSES)),
      );
    if ((active?.count ?? 0) > 0) {
      return null;
    }

    const [claimed] = await tx
      .update(builds)
      .set({
        status: 'starting',
        started_at: sql`now()`,
        instance_type: sql`coalesce(${builds.instance_type}, ${plan.buildInstanceType})`,
      })
      .where(and(eq(builds.id, args.buildId), eq(builds.status, 'queued')))
      .returning();
    if (!claimed) {
      return null;
    }
    if (!claimed.instance_type) {
      throw new Error('claimed build has no instance type');
    }
    return {
      instanceType: claimed.instance_type,
      ownerPlan: owner.plan,
      timeoutMinutes: plan.limits.buildTimeoutMinutes,
    };
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
    // The repo's immutable numeric GitHub id (as text), resolved at connect time.
    // Webhook/OIDC resolution keys on it (full_name is mutable).
    repositoryId: string;
    // The project owner or administrator who proved repository access while
    // connecting. Runtime authority requires this user to remain the owner or
    // an administrator.
    authorizedByUserId: string;
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
      repository_id: args.repositoryId,
      authorized_by_user_id: args.authorizedByUserId,
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

export async function hasGitHubConnectionAuthority(
  db: Db,
  connectionId: string,
  projectId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.id, connectionId),
        eq(githubConnections.project_id, projectId),
        githubConnectionAuthorityClause(),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Look up the connection for a webhook-delivered repo within an installation,
 * joining `projects` to surface the owning `user_id` (needed to attribute a
 * build and enforce that user's tier concurrency). Returns the connection
 * fields plus `user_id`, or null when no project is connected to that repo.
 *
 * Resolution keys ONLY on the IMMUTABLE numeric repository id (`repository.id`
 * in webhook payloads) so a repo rename/delete/name-reuse under the same
 * installation can't match a DIFFERENT repository to this connection. The
 * mutable `repo_full_name` is never a routing key.
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
  repositoryId: string,
): Promise<Array<GitHubConnection & { user_id: string }>> {
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
        eq(githubConnections.repository_id, repositoryId),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        or(
          // "all repositories" install => every repo is granted.
          eq(githubInstallations.repository_selection, 'all'),
          // "selected" install => enforce the repo is in the cached set. The
          // `repositories` jsonb stores `id` as a NUMBER; check membership by
          // the immutable id (rename-safe).
          sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
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
 * `repository_id` claim names the repo; there is no installation id in that
 * flow, so we look up by the immutable repository id and require
 * `build_executor = 'github_actions'` (a `container`-executor connection must
 * never be driven by the OIDC endpoint). Joins `projects` to surface the owning `user_id` (to
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
 * A match also requires the repo's CURRENT owner account (the OIDC
 * `repository_owner_id` claim) to equal the installation's `account_id`. The
 * `repository_id` is immutable across a repo TRANSFER, so without this an
 * org→org transfer (same id, new owner) would match the OLD owner's stale
 * `all`-repos connection and mint a deploy token for the wrong project.
 */
export async function getGitHubActionsConnectionsByRepo(
  db: Db,
  repositoryId: string,
  repositoryOwnerId: string,
): Promise<Array<GitHubConnection & { user_id: string; project_slug: string }>> {
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
        eq(githubConnections.repository_id, repositoryId),
        // Bind the connection's installation account to the OIDC repo owner. The
        // `repository_id` is immutable across a repo TRANSFER, so this top-level
        // condition (applies to BOTH the 'all' and 'selected' branches below)
        // rejects a transferred repo (same id, NEW owner) that would otherwise
        // match the old owner's stale connection.
        eq(githubInstallations.account_id, repositoryOwnerId),
        eq(githubConnections.build_executor, 'github_actions'),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        or(
          // "all repositories" install => every repo is granted.
          eq(githubInstallations.repository_selection, 'all'),
          // "selected" install => enforce the repo is in the cached set. The
          // `repositories` jsonb stores `id` as a NUMBER (see
          // `GitHubInstallationRepository.id: number` and `normalizeRepositories`);
          // check membership by the immutable id (rename-safe).
          sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
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
        // Only personal (account_type='User') installs carry an owner. A
        // personal account converted into an organization arrives here with the
        // organization type, so it drops its owner. Otherwise preserve an
        // already-linked user_id when a webhook upsert arrives with no user
        // (install-before-signin can be backfilled later). When a user is
        // provided, adopt it ONLY if the row is unowned or already owned by the
        // same user — never re-own a row linked to a DIFFERENT user, even if two
        // callbacks race. (Done in the column expression, not setWhere: setWhere
        // would freeze repositories/status refreshes on the webhook re-upsert,
        // and `user_id = NULL` is never true.)
        user_id:
          args.accountType === 'Organization'
            ? null
            : args.userId === undefined || args.userId === null
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
  // Personal-account owner OR active member. Organization installs have no
  // owner (`user_id` is null), so they are visible only through a live
  // membership. The EXISTS correlates on the NUMERIC
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
        and(eq(githubInstallations.account_type, 'User'), eq(githubInstallations.user_id, userId)),
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
    .where(
      and(
        eq(githubInstallations.account_id, accountId),
        eq(githubInstallations.account_type, 'User'),
        isNull(githubInstallations.user_id),
      ),
    );
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
 * in place (count stays 1).
 */
export async function upsertGitHubInstallationMember(
  db: Db,
  args: {
    installationId: string;
    userId: string;
    githubAccountId: string;
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
 * Batch revocation tombstones for `(installationIds, githubAccountId)` as a Map
 * installation_id → revoked_at-epoch-ms. Installs with no tombstone are simply
 * absent from the Map. Empty id list → empty Map (never emits `WHERE ... IN ()`).
 */
export async function getInstallationRevocationsForAccount(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (installationIds.length === 0) {
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
