import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  createGitHubConnection,
  createOrRefreshProjectInvitation,
  createProject,
  deleteProjectCascade,
  deleteUser,
  getAccessibleProjectsByUserId,
  getOwnedProjectsByUserId,
  getBuild,
  getGitHubConnection,
  getProject,
  respondToProjectInvitation,
} from '../../src/db.ts';
import {
  projectAccessEvents,
  projectCleanupJobs,
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  users,
} from '../../src/schema.ts';
import {
  createTestBuild,
  captureQueries,
  clearTables,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

async function setEmail(userId: string, email: string): Promise<void> {
  await env.db.update(users).set({ email }).where(eq(users.id, userId));
}

describe('project team lifecycle', () => {
  it('locks invitation owner and target accounts together in stable order', async () => {
    const owner = await createTestUser(env.db, 'lock-owner');
    const target = await createTestUser(env.db, 'lock-target');
    await setEmail(target.id, 'lock-target@example.com');
    const project = await createProject(env.db, owner.id, 'invitation-user-locks');

    const { queries } = await captureQueries(env.db, () =>
      createOrRefreshProjectInvitation(env.db, {
        projectId: project.id,
        email: 'lock-target@example.com',
        role: 'reader',
        actorUserId: owner.id,
      }),
    );

    const projectLock = queries.findIndex(
      (query) => query.includes('from "projects"') && query.includes('for update'),
    );
    const accountLock = queries.findIndex(
      (query) =>
        query.includes('from "users"') &&
        query.includes('order by "users"."id" asc') &&
        query.includes('for update'),
    );
    expect(projectLock).toBeGreaterThanOrEqual(0);
    expect(accountLock).toBeGreaterThan(projectLock);
    expect(
      queries.some((query) => query.includes('from "users"') && query.includes('for share')),
    ).toBe(false);
  });

  it('deleting a non-owner revokes their GitHub authority and preserves access audit history', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const member = await createTestUser(env.db, 'member');
    await setEmail(member.id, 'member@example.com');
    const project = await createProject(env.db, owner.id, 'member-lifecycle');

    const { invitation } = await createOrRefreshProjectInvitation(env.db, {
      projectId: project.id,
      email: 'member@example.com',
      role: 'admin',
      actorUserId: owner.id,
    });
    await respondToProjectInvitation(env.db, {
      invitationId: invitation.id,
      actorUserId: member.id,
      response: 'accept',
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'member-authorized-installation',
      repoFullName: 'void/member-authorized',
      repositoryId: '101',
      authorizedByUserId: member.id,
    });
    const activeBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      status: 'building',
    });

    await deleteUser(env.db, member.id);

    expect(await getProject(env.db, project.id)).not.toBeNull();
    expect(
      await env.db.select().from(projectMembers).where(eq(projectMembers.user_id, member.id)),
    ).toEqual([]);
    expect(
      await env.db
        .select()
        .from(projectInvitations)
        .where(eq(projectInvitations.target_user_id, member.id)),
    ).toEqual([]);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    expect(await getBuild(env.db, activeBuild.id)).toMatchObject({
      status: 'cancelled',
      error: 'github connection authorizer account deleted',
      completed_at: expect.any(String),
    });

    const events = await env.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.project_id, project.id));
    expect(events.map((event) => event.action)).toEqual(['invited', 'accepted']);
    expect(events.every((event) => event.subject_user_id === member.id)).toBe(true);
  });

  it('rotates the proxy token of every project the deleted user could deploy to', async () => {
    const owner = await createTestUser(env.db, 'rotation-owner');
    const member = await createTestUser(env.db, 'rotation-member');
    const collaborated = await createProject(env.db, owner.id, 'rotation-collaborator');
    const read = await createProject(env.db, owner.id, 'rotation-reader');
    const administered = await createProject(env.db, owner.id, 'rotation-admin');
    await env.db.insert(projectMembers).values([
      { project_id: collaborated.id, user_id: member.id, role: 'collaborator' },
      { project_id: read.id, user_id: member.id, role: 'reader' },
      { project_id: administered.id, user_id: member.id, role: 'admin' },
    ]);

    await deleteUser(env.db, member.id);

    const jobs = await env.db.select().from(projectCleanupJobs);
    expect(jobs.map((job) => job.project_id).sort()).toEqual(
      [collaborated.id, administered.id].sort(),
    );
    for (const job of jobs) {
      expect(job).toMatchObject({
        kind: 'proxy-token-rotation',
        payload: { phase: 'requested', reason: 'user-deleted' },
      });
    }
  });

  it('atomically discovers and locks pending-invitation projects before user deletion', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const invitee = await createTestUser(env.db, 'invitee');
    await setEmail(invitee.id, 'invitee@example.com');
    const project = await createProject(env.db, owner.id, 'pending-invitation-delete');
    await createOrRefreshProjectInvitation(env.db, {
      projectId: project.id,
      email: 'invitee@example.com',
      role: 'admin',
      actorUserId: owner.id,
    });

    const { queries } = await captureQueries(env.db, () => deleteUser(env.db, invitee.id));

    const discovery = queries.findIndex(
      (query) =>
        query.includes('from "project_members"') &&
        query.includes('from "project_invitations"') &&
        query.includes('from "github_connections"') &&
        query.includes(' union '),
    );
    const projectLock = queries.findIndex(
      (query) => query.includes('from "projects"') && query.includes('for update'),
    );
    expect(discovery).toBeGreaterThanOrEqual(0);
    expect(projectLock).toBeGreaterThan(discovery);
    expect(
      await env.db
        .select()
        .from(projectInvitations)
        .where(eq(projectInvitations.target_user_id, invitee.id)),
    ).toEqual([]);
  });

  it('keeps owned-project lifecycle enumeration separate from accessible projects', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const member = await createTestUser(env.db, 'member');
    const owned = await createProject(env.db, member.id, 'member-owned');
    const shared = await createProject(env.db, owner.id, 'owner-shared');
    await env.db.insert(projectMembers).values({
      project_id: shared.id,
      user_id: member.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });

    expect(
      (await getOwnedProjectsByUserId(env.db, member.id)).map((project) => project.id),
    ).toEqual([owned.id]);
    const accessible = (await getAccessibleProjectsByUserId(env.db, member.id)).map(
      ({ project, role }) => ({ id: project.id, role }),
    );
    expect(accessible).toHaveLength(2);
    expect(accessible).toEqual(
      expect.arrayContaining([
        { id: shared.id, role: 'reader' },
        { id: owned.id, role: 'owner' },
      ]),
    );
  });

  it('project deletion cascades all team, invitation, ownership, and access-history rows', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const member = await createTestUser(env.db, 'member');
    const invitee = await createTestUser(env.db, 'invitee');
    await setEmail(invitee.id, 'invitee@example.com');
    const project = await createProject(env.db, owner.id, 'project-lifecycle');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: member.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await createOrRefreshProjectInvitation(env.db, {
      projectId: project.id,
      email: 'invitee@example.com',
      role: 'reader',
      actorUserId: owner.id,
    });

    expect(
      await env.db
        .select()
        .from(projectOwnershipPeriods)
        .where(eq(projectOwnershipPeriods.project_id, project.id)),
    ).toHaveLength(1);

    await deleteProjectCascade(env.db, project.id);

    expect(await getProject(env.db, project.id)).toBeNull();
    for (const table of [
      projectMembers,
      projectInvitations,
      projectOwnershipPeriods,
      projectAccessEvents,
    ] as const) {
      expect(await env.db.select().from(table).where(eq(table.project_id, project.id))).toEqual([]);
    }
  });

  it('requires owned projects to be torn down before deleting an owner, without deleting shared projects', async () => {
    const owner = await createTestUser(env.db, 'departing-owner');
    const otherOwner = await createTestUser(env.db, 'other-owner');
    const owned = await createProject(env.db, owner.id, 'departing-owned');
    const shared = await createProject(env.db, otherOwner.id, 'departing-shared');
    await env.db.insert(projectMembers).values({
      project_id: shared.id,
      user_id: owner.id,
      role: 'collaborator',
      added_by_user_id: otherOwner.id,
    });

    await expect(deleteUser(env.db, owner.id)).rejects.toThrow();
    expect(await getProject(env.db, owned.id)).not.toBeNull();
    expect(await getProject(env.db, shared.id)).not.toBeNull();

    await deleteProjectCascade(env.db, owned.id);
    await expect(deleteUser(env.db, owner.id)).resolves.toEqual([]);

    expect(await getProject(env.db, owned.id)).toBeNull();
    expect(await getProject(env.db, shared.id)).not.toBeNull();
    expect(
      await env.db.select().from(projectMembers).where(eq(projectMembers.user_id, owner.id)),
    ).toEqual([]);
  });
});
