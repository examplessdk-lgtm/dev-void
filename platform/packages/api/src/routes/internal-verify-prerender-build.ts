import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { ACTIVE_BUILD_STATUSES, getBuild, getUser } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../project-access.ts';
import { projectDeployCredentials, projects } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

const app = new Hono<ApiEnv>();

/**
 * Authoritative check for prerender credentials. The binding proxy calls this
 * for every request so access changes take effect before the JWT expires.
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const denied = await requireProxyInternalAuth(context, 'verify-prerender-build', projectId);
  if (denied) {
    return denied;
  }

  const { userId, buildId, credentialId } = await context.req.json<{
    userId?: string;
    buildId?: string;
    credentialId?: string;
  }>();
  if (!userId) {
    return context.json({ error: 'userId required' }, 400);
  }

  const db = context.get('db');
  const user = await getUser(db, userId);
  if (!user || isAdminSuspended(user.suspended_reason)) {
    return context.json({ error: 'prerender authority is no longer active' }, 403);
  }
  let access;
  try {
    access = await requireProjectCapability(db, projectId, userId, 'deploy');
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return context.json({ error: 'prerender authority is no longer active' }, 403);
    }
    throw error;
  }
  if (access.project.status === 'deleting') {
    return context.json({ error: 'prerender authority is no longer active' }, 403);
  }

  if (buildId) {
    const build = await getBuild(db, buildId);
    if (
      !build ||
      build.project_id !== projectId ||
      build.user_id !== userId ||
      !ACTIVE_BUILD_STATUSES.includes(build.status)
    ) {
      return context.json({ error: 'build is no longer active' }, 403);
    }
  }

  if (credentialId) {
    const credential = await db
      .select({ id: projectDeployCredentials.id })
      .from(projectDeployCredentials)
      .innerJoin(projects, eq(projects.id, projectDeployCredentials.project_id))
      .where(
        and(
          eq(projectDeployCredentials.id, credentialId),
          eq(projectDeployCredentials.project_id, projectId),
          eq(projectDeployCredentials.issued_by, userId),
          eq(projects.user_id, userId),
          isNull(projectDeployCredentials.revoked_at),
          gt(projectDeployCredentials.expires_at, new Date().toISOString()),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!credential) {
      return context.json({ error: 'credential is no longer active' }, 403);
    }
  }

  return context.json({ ok: true });
});

export default app;
