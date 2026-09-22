import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
} from '../project-access.ts';
import { ProjectOperationInProgressError, teardownProject } from '../provisioning/cleanup.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const app = new Hono<ApiEnv>();

app.delete('/:id', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'delete');
  if (access instanceof Response) {
    return access;
  }
  const project = access.project;

  // `teardownProject` handles the FOR UPDATE lock, status='deleting' flip,
  // bulk deployment cancellation, critical CF cleanup (container apps from
  // `resources` rows + per-deploy container orphan recovery by deterministic
  // name — fatal on failure), best-effort CF cleanup (D1, KV, R2, queues,
  // hyperdrive, custom hostnames, routing entries — warnings), and the DB
  // cascade. Critical-cleanup failure throws and surfaces as a 5xx.
  let warnings: ReadonlyArray<string>;
  try {
    ({ warnings } = await teardownProject(context, projectId, project, {
      actorUserId: context.get('user').id,
    }));
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return context.json(projectAccessErrorBody(error), error.status);
    }
    if (error instanceof ProjectOperationInProgressError) {
      return context.json({ error: error.message }, 409);
    }
    throw error;
  }

  return context.json({
    ok: true,
    id: projectId,
    slug: project.slug,
    ...(warnings.length > 0 && { warnings }),
  });
});

export default app;
