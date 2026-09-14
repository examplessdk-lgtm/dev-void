import { Hono } from 'hono';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  EmailSendRevocationError,
  ProjectOperationInProgressError,
  teardownProject,
} from '../provisioning/cleanup.ts';

const app = new Hono<ApiEnv>();

app.delete('/:id', async (context) => {
  const projectId = context.req.param('id');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== context.get('user').id) {
    return context.json({ error: 'forbidden' }, 403);
  }

  // `teardownProject` handles the FOR UPDATE lock, status='deleting' flip,
  // bulk deployment cancellation, critical CF cleanup (container apps from
  // `resources` rows + per-deploy container orphan recovery by deterministic
  // name — fatal on failure), best-effort CF cleanup (D1, KV, R2, queues,
  // hyperdrive, custom hostnames, routing entries — warnings), and the DB
  // cascade. Critical-cleanup failure throws and surfaces as a 5xx. So does a
  // failed revocation of the project's email send authorization (its KV
  // mirrors): the row stays, and the 503 asks for the retry that finishes it.
  let warnings: ReadonlyArray<string>;
  try {
    ({ warnings } = await teardownProject(context, projectId, project));
  } catch (error) {
    if (error instanceof ProjectOperationInProgressError) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof EmailSendRevocationError) {
      return context.json({ error: 'failed to revoke email send authorization; try again' }, 503);
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
