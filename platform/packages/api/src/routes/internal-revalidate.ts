import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { runRevalidate } from '../revalidate-core.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal revalidation endpoint — called by the proxy via service binding.
 * Authenticated via HMAC token in X-Void-Internal header (no JWT/userId).
 */
app.post('/:id', async (context) => {
  const projectId = context.req.param('id');

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

  const body = await context.req.json<{ paths?: ReadonlyArray<string>; all?: boolean }>();
  return runRevalidate(context, projectId, project, body);
});

export default app;
