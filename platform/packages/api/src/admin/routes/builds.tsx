import { Hono } from 'hono';
import { isTerminalBuildStatus } from '../../build-status.ts';
import { getBuild } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { buildLogs } from '../../operator/build-operations.ts';
import { OperatorError } from '../../operator/common.ts';
import { renderFateDetailPage } from '../fate/render.ts';

const app = new Hono<ApiEnv>();

// GET /admin/builds/:id/logs?since=N
//
// JSON log page. Container builds read the BuildManager DO that ran the build
// (chosen by `instance_type`); github_actions builds have no DO log store and
// return an empty page plus the external `logs_url`.
app.get('/:id/logs', async (context) => {
  const raw = Number(context.req.query('since'));
  const since = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  try {
    return context.json(
      await buildLogs(context.get('db'), context.env, context.req.param('id'), since),
    );
  } catch (error) {
    if (error instanceof OperatorError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

// GET /admin/builds/:id
//
// Build detail page. `?status=1` instead returns a JSON `{ status, terminal }`
// probe that reads only the build row.
app.get('/:id', async (context) => {
  if (context.req.query('status') === undefined) {
    return renderFateDetailPage(context, 'buildDetail');
  }
  const build = await getBuild(context.get('db'), context.req.param('id'));
  if (!build) {
    return context.json({ error: 'build not found' }, 404);
  }
  return context.json({ status: build.status, terminal: isTerminalBuildStatus(build.status) });
});

export default app;
