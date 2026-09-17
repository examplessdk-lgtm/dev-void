import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import {
  projectAccessEvents,
  projectInvitations,
  projectMembers,
  projects,
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

function request(
  path: string,
  jwt: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

async function setEmail(userId: string, email: string): Promise<void> {
  await env.db.update(users).set({ email }).where(eq(users.id, userId));
}

async function invite(
  projectId: string,
  ownerJwt: string,
  email: string,
  role: 'reader' | 'collaborator' | 'admin',
): Promise<{ id: string; refreshed: boolean; delivery: { status: string } }> {
  const response = await app.fetch(
    request(`/projects/${projectId}/invitations`, ownerJwt, {
      method: 'POST',
      body: { email, role },
    }),
    env,
  );
  expect([200, 201]).toContain(response.status);
  const body = (await response.json()) as {
    invitation: { id: string };
    refreshed: boolean;
    delivery: { status: string };
  };
  return { id: body.invitation.id, refreshed: body.refreshed, delivery: body.delivery };
}

describe('project team API', () => {
  it('lists the implicit owner and lets every member view the roster', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const reader = await createTestUser(env.db, 'reader');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(reader.id, 'reader@example.com');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: reader.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });

    const response = await app.fetch(request(`/projects/${project.id}/members`, reader.jwt), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      members: [
        { user: { id: owner.id, login: 'owner' }, role: 'owner' },
        { user: { id: reader.id, login: 'reader' }, role: 'reader' },
      ],
    });

    const forbidden = await app.fetch(
      request(`/projects/${project.id}/invitations`, reader.jwt),
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'forbidden' });
  });

  it('requires an existing registered user and supports target-only acceptance', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    const bystander = await createTestUser(env.db, 'bystander');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(target.id, 'Target@Example.com');
    await setEmail(bystander.id, 'bystander@example.com');
    const project = await createTestProject(env.db, owner.id, 'shared-app');

    const unknown = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'missing@example.com', role: 'reader' },
      }),
      env,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'registered user not found' });

    const created = await invite(project.id, owner.jwt, 'target@example.com', 'collaborator');
    expect(created.delivery).toEqual({ status: 'not_configured' });

    const pending = await app.fetch(request('/me/project-invitations', target.jwt), env);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      invitations: [
        {
          id: created.id,
          project: { id: project.id, slug: 'shared-app', owner: { id: owner.id } },
          invited_by: { id: owner.id },
          role: 'collaborator',
        },
      ],
    });

    const forwarded = await app.fetch(
      request(`/project-invitations/${created.id}/accept`, bystander.jwt, { method: 'POST' }),
      env,
    );
    expect(forwarded.status).toBe(403);

    const accepted = await app.fetch(
      request(`/project-invitations/${created.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      member: { user: { id: target.id }, role: 'collaborator' },
    });

    const acceptedAgain = await app.fetch(
      request(`/project-invitations/${created.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptedAgain.status).toBe(200);

    const events = await env.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.project_id, project.id));
    expect(events.map((event) => event.action)).toEqual(['invited', 'accepted']);
  });

  it('binds invitations to exactly one registered account and rejects owner/member conflicts', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const member = await createTestUser(env.db, 'member');
    const duplicateA = await createTestUser(env.db, 'duplicate-a');
    const duplicateB = await createTestUser(env.db, 'duplicate-b');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(member.id, 'member@example.com');
    await setEmail(duplicateA.id, 'duplicate@example.com');
    await setEmail(duplicateB.id, 'duplicate@example.com');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: member.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });

    const inviteOwner = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'OWNER@example.com', role: 'admin' },
      }),
      env,
    );
    expect(inviteOwner.status).toBe(409);
    expect(await inviteOwner.json()).toEqual({
      error: 'the project owner cannot be invited or changed as a member',
    });

    const inviteMember = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'member@example.com', role: 'admin' },
      }),
      env,
    );
    expect(inviteMember.status).toBe(409);
    expect(await inviteMember.json()).toEqual({ error: 'user is already a project member' });

    const ambiguous = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'duplicate@example.com', role: 'reader' },
      }),
      env,
    );
    expect(ambiguous.status).toBe(404);
    expect(await ambiguous.json()).toEqual({ error: 'registered user not found' });
    expect(await env.db.select().from(projectInvitations)).toEqual([]);
  });

  it('serializes concurrent acceptance and records one membership and event', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(project.id, owner.jwt, 'target@example.com', 'collaborator');

    const responses = await Promise.all([
      app.fetch(
        request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
        env,
      ),
      app.fetch(
        request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
        env,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      await env.db
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, target.id)),
        ),
    ).toHaveLength(1);
    const events = await env.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.project_id, project.id));
    expect(events.map((event) => event.action)).toEqual(['invited', 'accepted']);
  });

  it('does not let an accepted invitation recreate access after member removal', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(project.id, owner.jwt, 'target@example.com', 'reader');

    expect(
      (
        await app.fetch(
          request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          request(`/projects/${project.id}/members/${target.id}`, owner.jwt, {
            method: 'DELETE',
          }),
          env,
        )
      ).status,
    ).toBe(204);

    const replay = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'project invitation is no longer pending' });
    expect(
      await env.db
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, target.id)),
        ),
    ).toEqual([]);

    const fresh = await invite(project.id, owner.jwt, 'target@example.com', 'admin');
    expect(fresh.id).not.toBe(invitation.id);
    const acceptedFresh = await app.fetch(
      request(`/project-invitations/${fresh.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptedFresh.status).toBe(200);
    expect(await acceptedFresh.json()).toMatchObject({ member: { role: 'admin' } });
  });

  it('rejects forwarded response and cross-project management IDs without consuming the invite', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    const bystander = await createTestUser(env.db, 'bystander');
    await setEmail(target.id, 'target@example.com');
    const source = await createTestProject(env.db, owner.id, 'source-project');
    const other = await createTestProject(env.db, owner.id, 'other-project');
    const invitation = await invite(source.id, owner.jwt, 'target@example.com', 'reader');

    for (const action of ['accept', 'decline']) {
      const response = await app.fetch(
        request(`/project-invitations/${invitation.id}/${action}`, bystander.jwt, {
          method: 'POST',
        }),
        env,
      );
      expect(response.status).toBe(403);
    }
    const crossProjectResend = await app.fetch(
      request(`/projects/${other.id}/invitations/${invitation.id}/resend`, owner.jwt, {
        method: 'POST',
      }),
      env,
    );
    expect(crossProjectResend.status).toBe(404);
    const crossProjectRevoke = await app.fetch(
      request(`/projects/${other.id}/invitations/${invitation.id}`, owner.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(crossProjectRevoke.status).toBe(404);

    const targetAccept = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(targetAccept.status).toBe(200);
  });

  it('refreshes, resends to the current account email, and revokes invitations', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(target.id, 'old@example.com');
    const project = await createTestProject(env.db, owner.id);

    const first = await invite(project.id, owner.jwt, 'old@example.com', 'reader');
    const refreshed = await invite(project.id, owner.jwt, 'OLD@example.com', 'admin');
    expect(refreshed).toMatchObject({ id: first.id, refreshed: true });

    await setEmail(target.id, 'new@example.com');
    const resentResponse = await app.fetch(
      request(`/projects/${project.id}/invitations/${first.id}/resend`, owner.jwt, {
        method: 'POST',
      }),
      env,
    );
    expect(resentResponse.status).toBe(200);
    expect(await resentResponse.json()).toMatchObject({
      invitation: {
        id: first.id,
        target: { id: target.id, email: 'new@example.com' },
        target_email: 'new@example.com',
        role: 'admin',
      },
      delivery: { status: 'not_configured' },
    });

    const revoked = await app.fetch(
      request(`/projects/${project.id}/invitations/${first.id}`, owner.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(revoked.status).toBe(204);

    const acceptRevoked = await app.fetch(
      request(`/project-invitations/${first.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptRevoked.status).toBe(409);
  });

  it('lets project admins manage any non-owner member and members leave', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const admin = await createTestUser(env.db, 'admin');
    const collaborator = await createTestUser(env.db, 'collaborator');
    const peerAdmin = await createTestUser(env.db, 'peer-admin');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: peerAdmin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);

    const changed = await app.fetch(
      request(`/projects/${project.id}/members/${collaborator.id}`, admin.jwt, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      env,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ member: { role: 'admin' } });

    const removedPeerAdmin = await app.fetch(
      request(`/projects/${project.id}/members/${peerAdmin.id}`, admin.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(removedPeerAdmin.status).toBe(204);

    const ownerConflict = await app.fetch(
      request(`/projects/${project.id}/members/${owner.id}`, admin.jwt, {
        method: 'PATCH',
        body: { role: 'reader' },
      }),
      env,
    );
    expect(ownerConflict.status).toBe(409);

    const ownerRemovalConflict = await app.fetch(
      request(`/projects/${project.id}/members/${owner.id}`, admin.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(ownerRemovalConflict.status).toBe(409);

    const leave = await app.fetch(
      request(`/projects/${project.id}/leave`, collaborator.jwt, { method: 'POST' }),
      env,
    );
    expect(leave.status).toBe(204);
    const [remaining] = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, collaborator.id)),
      );
    expect(remaining).toBeUndefined();

    const ownerLeave = await app.fetch(
      request(`/projects/${project.id}/leave`, owner.jwt, { method: 'POST' }),
      env,
    );
    expect(ownerLeave.status).toBe(409);
  });

  it('filters expired invitations and allows the target to decline a live invitation', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const expired = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    await env.db
      .update(projectInvitations)
      .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(projectInvitations.id, expired.id));

    const pending = await app.fetch(request('/me/project-invitations', target.jwt), env);
    expect(await pending.json()).toEqual({ invitations: [] });

    const acceptExpired = await app.fetch(
      request(`/project-invitations/${expired.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptExpired.status).toBe(409);
    expect(await acceptExpired.json()).toEqual({ error: 'project invitation has expired' });
    expect(
      (
        await env.db.select().from(projectInvitations).where(eq(projectInvitations.id, expired.id))
      )[0],
    ).toMatchObject({ status: 'expired' });

    const live = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    expect(live.id).not.toBe(expired.id);
    const declined = await app.fetch(
      request(`/project-invitations/${live.id}/decline`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(declined.status).toBe(204);
    const declinedAgain = await app.fetch(
      request(`/project-invitations/${live.id}/decline`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(declinedAgain.status).toBe(204);
  });

  it('refreshes an expired pending invitation instead of consuming another pending slot', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const expiredPending = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    await env.db
      .update(projectInvitations)
      .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(projectInvitations.id, expiredPending.id));

    const refreshed = await invite(project.id, owner.jwt, 'target@example.com', 'admin');
    expect(refreshed).toMatchObject({ id: expiredPending.id, refreshed: true });
    const [row] = await env.db
      .select()
      .from(projectInvitations)
      .where(eq(projectInvitations.id, expiredPending.id));
    expect(row).toMatchObject({ status: 'pending', role: 'admin' });
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    expect(await env.db.select().from(projectInvitations)).toHaveLength(1);
  });

  it('rejects acceptance when the invited account has become the project owner', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    await env.db.update(projects).set({ user_id: target.id }).where(eq(projects.id, project.id));

    const response = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'the project owner cannot be invited or changed as a member',
    });
    expect(await env.db.select().from(projectMembers)).toEqual([]);
  });
});
