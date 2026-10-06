import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { getDeployment, getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { isProjectId } from '../id.ts';
import { getProjectDeploymentWorkerName } from '../naming.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal worker name resolution — called by the proxy via service binding.
 * Returns the active versioned WfP worker name for a given projectId.
 * Authenticated via HMAC token in X-Void-Internal header (same as resolve-resource).
 *
 * POST /internal/resolve-worker/:projectId
 * Returns: { "workerName": "user-<slug>-<deploymentId>", "deploymentId": "..." }
 * or 409 when the active deployment is static-only.
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');

  const token = context.req.header('x-void-internal');
  if (!token) {
    return context.json({ error: 'missing internal auth' }, 401);
  }
  if (
    !isProjectId(projectId) ||
    !(await hmacVerifyState(projectId, token, context.env.JWT_SECRET))
  ) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }

  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.json({ error: 'project not found' }, 404);
  }

  if (!project.active_deployment_id) {
    return context.json({ error: 'project has no active deployment' }, 404);
  }

  const deployment = await getDeployment(context.get('db'), project.active_deployment_id);
  if (!deployment || deployment.project_id !== project.id || deployment.status !== 'live') {
    return context.json({ error: 'active deployment not found' }, 404);
  }

  if (project.type === 'static' || project.type === 'spa') {
    return context.json(
      { error: 'active deployment has no worker', deploymentId: deployment.id },
      409,
    );
  }

  return context.json({
    workerName: getProjectDeploymentWorkerName(project.slug, deployment.id),
    deploymentId: deployment.id,
  });
});

export default app;
