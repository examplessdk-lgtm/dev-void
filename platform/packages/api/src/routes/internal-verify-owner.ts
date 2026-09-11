import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal ownership verification — called by the proxy via service binding.
 * Used on the JWT auth path to confirm the authenticated user owns the project.
 * Authenticated via HMAC token in X-Void-Internal header.
 *
 * POST /internal/verify-owner/:projectId
 * Body: { "userId": "..." }
 * Returns: 200 { ok: true } or 403 { error: "forbidden" }
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

  const { userId } = await context.req.json<{ userId: string }>();
  if (!userId) {
    return context.json({ error: 'userId required' }, 400);
  }

  const project = await getProject(context.get('db'), projectId);
  if (!project || project.user_id !== userId) {
    return context.json({ error: 'forbidden' }, 403);
  }

  return context.json({ ok: true });
});

export default app;
