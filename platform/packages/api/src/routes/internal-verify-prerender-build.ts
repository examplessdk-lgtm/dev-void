import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { ACTIVE_BUILD_STATUSES, getBuild, getProject, getUser } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projectDeployCredentials } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

const app = new Hono<ApiEnv>();

/**
 * Authoritative check for build- and durable-CI-derived prerender credentials.
 * The binding proxy calls this over its service binding for every request so
 * termination, credential renewal/revocation/expiry, project reassignment, and
 * owner suspension take effect before the derived JWT expires.
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const token = context.req.header('x-void-internal');
  if (!token) {
    return context.json({ error: 'missing internal auth' }, 401);
  }
  if (!(await hmacVerifyState(projectId, token, context.env.JWT_SECRET))) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }

  const { userId, buildId, credentialId } = await context.req.json<{
    userId?: string;
    buildId?: string;
    credentialId?: string;
  }>();
  if (!userId || (!buildId && !credentialId)) {
    return context.json({ error: 'userId and credential provenance required' }, 400);
  }

  const db = context.get('db');
  const [user, project] = await Promise.all([getUser(db, userId), getProject(db, projectId)]);
  if (
    !user ||
    isAdminSuspended(user.suspended_reason) ||
    !project ||
    project.status === 'deleting' ||
    project.user_id !== userId
  ) {
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
      .where(
        and(
          eq(projectDeployCredentials.id, credentialId),
          eq(projectDeployCredentials.project_id, projectId),
          eq(projectDeployCredentials.issued_by, userId),
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
