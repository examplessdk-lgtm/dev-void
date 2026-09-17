import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  createDeployment,
  createOrRefreshProjectInvitation,
  createProject,
  getAccessibleProjectsByUserId,
  getProjectMember,
  removeProjectMember,
  respondToProjectInvitation,
  setProjectMemberRole,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { ProjectAccessDeniedError, requireProjectCapability } from '../../src/project-access.ts';
import {
  projectAccessEvents,
  projectMembers,
  projectOwnershipPeriods,
  users,
} from '../../src/schema.ts';
import {
  clearTables,
  createTestProject,
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

async function userWithEmail(login: string) {
  const user = await createTestUser(env.db, login);
  const email = `${login}@example.com`;
  await env.db.update(users).set({ email }).where(eq(users.id, user.id));
  return { ...user, email };
}

describe('project access', () => {
  it('grants implicit owner access to a legacy project with no member row', async () => {
    const owner = await createTestUser(env.db, 'legacy-owner');
    const project = await createTestProject(env.db, owner.id, 'legacy-access');

    const access = await requireProjectCapability(env.db, project.id, owner.id, 'delete');
    expect(access.role).toBe('owner');
    expect(access.owner.id).toBe(owner.id);
    expect(await getProjectMember(env.db, project.id, owner.id)).toBeNull();
  });

  it('enforces reader and collaborator capabilities using the owner for billing', async () => {
    const owner = await createTestUser(env.db, 'access-owner');
    const reader = await createTestUser(env.db, 'access-reader');
    const collaborator = await createTestUser(env.db, 'access-collaborator');
    const project = await createProject(env.db, owner.id, 'shared-access');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
    ]);

    expect((await requireProjectCapability(env.db, project.id, reader.id, 'read')).owner.id).toBe(
      owner.id,
    );
    await expect(
      requireProjectCapability(env.db, project.id, reader.id, 'deploy'),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(
      (await requireProjectCapability(env.db, project.id, collaborator.id, 'deploy')).role,
    ).toBe('collaborator');
    await expect(
      requireProjectCapability(env.db, project.id, collaborator.id, 'settings'),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);

    const accessible = await getAccessibleProjectsByUserId(env.db, reader.id);
    expect(accessible.map(({ project: item, role }) => [item.id, role])).toEqual([
      [project.id, 'reader'],
    ]);
  });

  it('requires a registered target, binds acceptance to it, and audits mutations', async () => {
    const owner = await userWithEmail('invite-owner');
    const target = await userWithEmail('invite-target');
    const forwardedTo = await userWithEmail('invite-forwarded');
    const project = await createProject(env.db, owner.id, 'invitation-security');

    await expect(
      createOrRefreshProjectInvitation(env.db, {
        projectId: project.id,
        email: 'missing@example.com',
        role: 'reader',
        actorUserId: owner.id,
      }),
    ).rejects.toMatchObject({ reason: 'target-user-not-found', status: 404 });

    const { invitation } = await createOrRefreshProjectInvitation(env.db, {
      projectId: project.id,
      email: target.email.toUpperCase(),
      role: 'reader',
      actorUserId: owner.id,
    });
    await expect(
      respondToProjectInvitation(env.db, {
        invitationId: invitation.id,
        actorUserId: forwardedTo.id,
        response: 'accept',
      }),
    ).rejects.toMatchObject({ reason: 'invitation-not-target', status: 403 });

    const accepted = await respondToProjectInvitation(env.db, {
      invitationId: invitation.id,
      actorUserId: target.id,
      response: 'accept',
    });
    expect(accepted.member?.role).toBe('reader');
    await setProjectMemberRole(env.db, {
      projectId: project.id,
      subjectUserId: target.id,
      role: 'collaborator',
      actorUserId: owner.id,
    });
    await removeProjectMember(env.db, {
      projectId: project.id,
      subjectUserId: target.id,
      actorUserId: target.id,
    });

    await expect(
      requireProjectCapability(env.db, project.id, target.id, 'read'),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    const events = await env.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.project_id, project.id))
      .orderBy(desc(projectAccessEvents.created_at));
    expect(events.map((event) => event.action)).toEqual([
      'left',
      'role_changed',
      'accepted',
      'invited',
    ]);
  });

  it('records owner attribution on new projects and deployments', async () => {
    const owner = await createTestUser(env.db, 'attribution-owner');
    const actor = await createTestUser(env.db, 'attribution-actor');
    const project = await createProject(env.db, owner.id, 'attribution');
    const [period] = await env.db
      .select()
      .from(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    expect(period).toMatchObject({ owner_user_id: owner.id, starts_at: project.created_at });

    const deployment = await createDeployment(env.db, project.id, '{}', 'manual', null, {
      initiatedByUserId: actor.id,
    });
    expect(deployment.billing_user_id).toBe(owner.id);
    expect(deployment.initiated_by_user_id).toBe(actor.id);
  });

  it('rejects a team mutation after the actor loses admin access', async () => {
    const owner = await userWithEmail('lock-owner');
    const admin = await userWithEmail('lock-admin');
    const target = await userWithEmail('lock-target');
    const project = await createProject(env.db, owner.id, 'locked-auth');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await setProjectMemberRole(env.db, {
      projectId: project.id,
      subjectUserId: admin.id,
      role: 'reader',
      actorUserId: owner.id,
    });

    await expect(
      createOrRefreshProjectInvitation(env.db, {
        projectId: project.id,
        email: target.email,
        role: 'reader',
        actorUserId: admin.id,
      }),
    ).rejects.toMatchObject({ reason: 'forbidden', status: 403 });
  });

  it('keeps the legacy internal verifier URL but live-checks deploy capability', async () => {
    const owner = await createTestUser(env.db, 'verify-owner');
    const reader = await createTestUser(env.db, 'verify-reader');
    const collaborator = await createTestUser(env.db, 'verify-collaborator');
    const project = await createProject(env.db, owner.id, 'verify-access');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
    ]);
    const internalAuth = await hmacSignState(project.id, env.JWT_SECRET);
    const verify = (userId: string) =>
      app.fetch(
        new Request(`http://localhost/internal/verify-owner/${project.id}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-void-internal': internalAuth,
          },
          body: JSON.stringify({ userId }),
        }),
        env,
      );

    expect((await verify(owner.id)).status).toBe(200);
    expect((await verify(collaborator.id)).status).toBe(200);
    expect((await verify(reader.id)).status).toBe(403);
    await removeProjectMember(env.db, {
      projectId: project.id,
      subjectUserId: collaborator.id,
      actorUserId: owner.id,
    });
    expect((await verify(collaborator.id)).status).toBe(403);
  });
});
