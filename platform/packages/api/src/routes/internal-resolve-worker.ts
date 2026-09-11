import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal worker name resolution — called by the proxy via service binding.
 * Returns the WfP worker name (user-<slug>) for a given projectId.
 * Authenticated via HMAC token in X-Void-Internal header (same as resolve-resource).
 *
 * POST /internal/resolve-worker/:projectId
 * Returns: { "workerName": "user-<slug>" } or 404
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

  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.json({ error: 'project not found' }, 404);
  }

  return context.json({ workerName: `user-${project.slug}` });
});

export default app;
