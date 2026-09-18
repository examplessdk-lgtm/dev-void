import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from './db.ts';
import { projectMembers, projects, users } from './schema.ts';
import { isAdminSuspended } from './suspension.ts';
import type { Project, ProjectCapability, ProjectRole, User } from './types.ts';

export type ProjectAccess = Readonly<{
  project: Project;
  role: ProjectRole;
  owner: User;
}>;

export const PROJECT_ROLE_CAPABILITIES = {
  reader: ['read'],
  collaborator: ['read', 'deploy', 'configure'],
  admin: ['read', 'deploy', 'configure', 'settings', 'members'],
  owner: ['read', 'deploy', 'configure', 'settings', 'members', 'delete'],
} as const satisfies Record<ProjectRole, ReadonlyArray<ProjectCapability>>;

export function hasProjectCapability(role: ProjectRole, capability: ProjectCapability): boolean {
  return (PROJECT_ROLE_CAPABILITIES[role] as ReadonlyArray<ProjectCapability>).includes(capability);
}

const projectOwner = alias(users, 'project_owner');

async function selectProjectAccess(
  db: Db,
  projectId: string,
  actorUserId: string,
): Promise<Readonly<{ project: Project; owner: User; memberRole: ProjectRole | null }> | null> {
  const [row] = await db
    .select({
      project: projects,
      owner: projectOwner,
      memberRole: projectMembers.role,
    })
    .from(projects)
    .innerJoin(projectOwner, eq(projects.user_id, projectOwner.id))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.project_id, projects.id), eq(projectMembers.user_id, actorUserId)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    project: row.project,
    owner: row.owner,
    memberRole: row.project.user_id === actorUserId ? 'owner' : row.memberRole,
  };
}

export class ProjectNotFoundError extends Error {
  readonly status = 404 as const;

  constructor() {
    super('project not found');
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectAccessDeniedError extends Error {
  readonly status = 403 as const;

  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ProjectAccessDeniedError';
  }
}

export class ProjectOwnerSuspendedError extends ProjectAccessDeniedError {
  constructor() {
    super('project owner suspended');
    this.name = 'ProjectOwnerSuspendedError';
  }
}

/**
 * Assert a live project role and an owner not manually suspended. The owner is
 * returned separately so plan/quota callers do not consult the actor.
 */
export async function requireProjectCapability(
  db: Db,
  projectId: string,
  actorUserId: string,
  capability: ProjectCapability,
): Promise<ProjectAccess> {
  const row = await selectProjectAccess(db, projectId, actorUserId);
  if (!row) {
    throw new ProjectNotFoundError();
  }
  if (!row.memberRole || !hasProjectCapability(row.memberRole, capability)) {
    throw new ProjectAccessDeniedError();
  }
  if (isAdminSuspended(row.owner.suspended_reason)) {
    throw new ProjectOwnerSuspendedError();
  }
  return { project: row.project, role: row.memberRole, owner: row.owner };
}
