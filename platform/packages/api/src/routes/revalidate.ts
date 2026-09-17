import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import { runRevalidate } from '../revalidate-core.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const app = new Hono<ApiEnv>();

app.post('/:id/revalidate', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }

  const body = await context.req.json<{ paths?: ReadonlyArray<string>; all?: boolean }>();
  return runRevalidate(context, projectId, access.project, body);
});

export default app;
