import { Hono } from 'hono';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { runRevalidate } from '../revalidate-core.ts';

const app = new Hono<ApiEnv>();

app.post('/:id/revalidate', async (context) => {
  const projectId = context.req.param('id');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== context.get('user').id) {
    return context.json({ error: 'forbidden' }, 403);
  }

  const body = await context.req.json<{ paths?: ReadonlyArray<string>; all?: boolean }>();
  return runRevalidate(context, projectId, project, body);
});

export default app;
