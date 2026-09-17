import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  createBuild,
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
  getProjectsByUserId,
  respondToProjectInvitation,
} from '../../src/db.ts';
import {
  projectAccessEvents,
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  users,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

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
    const activeBuild = await createBuild(env.db, {
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
    expect((await getProjectsByUserId(env.db, member.id)).map((project) => project.id)).toEqual([
      owned.id,
    ]);
    expect(
      (await getAccessibleProjectsByUserId(env.db, member.id)).map(({ project, role }) => ({
        id: project.id,
        role,
      })),
    ).toEqual([
      { id: shared.id, role: 'reader' },
      { id: owned.id, role: 'owner' },
    ]);
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
