import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { ACTIVE_BUILD_STATUSES, getBuild } from '../db.ts';
import type { ApiEnv } from '../env.ts';

const app = new Hono<ApiEnv>();

/**
 * Revocation check for build-bound prerender credentials. The binding proxy
 * calls this over its service binding for every request so a superseded,
 * cancelled, failed, or completed build loses remote project-data access even
 * when its short-lived JWT has not expired yet.
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

  const { buildId } = await context.req.json<{ buildId?: string }>();
  if (!buildId) {
    return context.json({ error: 'buildId required' }, 400);
  }
  const build = await getBuild(context.get('db'), buildId);
  if (!build || build.project_id !== projectId || !ACTIVE_BUILD_STATUSES.includes(build.status)) {
    return context.json({ error: 'build is no longer active' }, 403);
  }

  return context.json({ ok: true });
});

export default app;
