import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import { assetMigrationInventory, migrateOperatorDeploymentAssets } from './asset-migration.ts';
import { buildDetail, buildLogs } from './build-operations.ts';
import { dryRun, OperatorError, pagination, preview, readBody, stringField } from './common.ts';
import {
  deploymentDetail,
  deploymentLogs,
  listOperatorDeployments,
  requestDeploymentCancellation,
} from './deployment-operations.ts';
import { drainManagedSandboxes } from './sandbox-operations.ts';
import {
  backfillPlatformQueueTokens,
  cliVersionStats,
  systemHealth,
  systemOverview,
} from './system-operations.ts';
import {
  executeWorkerRollbacks,
  prepareAllWorkerRollbacks,
  prepareWorkerRollback,
  workerBatch,
  workerDetail,
  workerEnvironment,
  workerEvents,
  workerList,
} from './worker-operations.ts';

export const operationsRoutes = new Hono<ApiEnv>();

operationsRoutes.get('/deployments', async (context) =>
  context.json(
    await listOperatorDeployments(context.get('db'), {
      ...pagination(context),
      search: context.req.query('search'),
      project: context.req.query('project'),
      status: context.req.query('status'),
    }),
  ),
);
operationsRoutes.get('/deployments/:id', async (context) =>
  context.json(await deploymentDetail(context.get('db'), context.req.param('id'))),
);
operationsRoutes.post('/deployments/:id/migrate-assets', async (context) => {
  const body = await readBody(context);
  if (body.cursor !== undefined && typeof body.cursor !== 'string') {
    throw new OperatorError(400, 'cursor must be a string.', 'invalid_argument');
  }
  return context.json(
    await migrateOperatorDeploymentAssets(
      context,
      context.req.param('id'),
      dryRun(body),
      body.cursor,
      body.expected,
    ),
  );
});
operationsRoutes.post('/deployments/:id/cancel', async (context) => {
  const body = await readBody(context);
  const deployment = await requestDeploymentCancellation(
    context.get('db'),
    context.req.param('id'),
    dryRun(body),
  );
  return context.json(
    dryRun(body) ? preview('deployment.cancel', deployment.id, { deployment }) : { deployment },
  );
});
operationsRoutes.get('/deployments/:id/logs', async (context) =>
  context.json(
    await deploymentLogs(context.get('db'), context.env, context.req.param('id'), {
      since: context.req.query('since'),
      limit: Number(context.req.query('limit') ?? 100),
      cursor: context.req.query('cursor'),
      after: context.req.query('after'),
    }),
  ),
);
operationsRoutes.get('/builds/:id', async (context) =>
  context.json(await buildDetail(context.get('db'), context.req.param('id'))),
);
operationsRoutes.get('/builds/:id/logs', async (context) =>
  context.json(
    await buildLogs(
      context.get('db'),
      context.env,
      context.req.param('id'),
      Number(context.req.query('since') ?? 0),
      Number(context.req.query('limit') ?? 500),
    ),
  ),
);
operationsRoutes.get('/system/overview', async (context) =>
  context.json(await systemOverview(context.get('db'), context.env)),
);
operationsRoutes.get('/system/asset-migrations', async (context) =>
  context.json(await assetMigrationInventory(context, pagination(context))),
);
operationsRoutes.get('/system/health', async (context) =>
  context.json(await systemHealth(context.get('db'), context.env, context.req.url)),
);
operationsRoutes.get('/system/cli-versions', async (context) =>
  context.json(await cliVersionStats(context.get('db'))),
);
operationsRoutes.post('/system/backfill-queue-tokens', async (context) => {
  const body = await readBody(context);
  const result = await backfillPlatformQueueTokens(context.env, dryRun(body));
  return context.json(
    dryRun(body)
      ? preview('system.backfill-queue-tokens', 'queue:*', { ...result })
      : { ...result, ok: result.errored === 0, partial: result.errored > 0 && result.updated > 0 },
    result.errored > 0 && !dryRun(body) ? 207 : 200,
  );
});
operationsRoutes.post('/system/sandbox-drain', async (context) => {
  const body = await readBody(context);
  const preview = dryRun(body);
  const cursor = body.cursor;
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw new OperatorError(400, 'cursor must be a string.', 'invalid_argument');
  }
  const result = await drainManagedSandboxes(context.get('db'), context.env, preview, cursor);
  return context.json(result, !preview && !result.complete ? 207 : 200);
});

operationsRoutes.get('/workers', async (context) =>
  context.json(
    await workerList(context.env, workerEnvironment(context.env, context.req.query('environment'))),
  ),
);
operationsRoutes.get('/workers/events', async (context) =>
  context.json(
    await workerEvents(
      context.get('db'),
      context.env,
      workerEnvironment(context.env, context.req.query('environment')),
      pagination(context),
    ),
  ),
);
operationsRoutes.get('/workers/events/:batchId', async (context) =>
  context.json(
    await workerBatch(
      context.get('db'),
      context.env,
      context.req.param('batchId'),
      context.req.query('environment') === undefined
        ? undefined
        : workerEnvironment(context.env, context.req.query('environment')),
    ),
  ),
);
operationsRoutes.post('/workers/rollback-all', async (context) => {
  const body = await readBody(context);
  const environment = workerEnvironment(context.env, body.environment);
  if (!dryRun(body) && body.versions === undefined) {
    throw new OperatorError(400, 'Submit the exact versions from a rollback preview.');
  }
  const targets = await prepareAllWorkerRollbacks(context.env, environment, body.versions);
  if (dryRun(body)) {
    return context.json(
      preview('worker.rollback-all', environment, {
        environment,
        workers: targets,
        versions: Object.fromEntries(
          targets.map((target) => [target.worker.name, target.versionId]),
        ),
      }),
    );
  }
  const result = await executeWorkerRollbacks(
    context.get('db'),
    context.env,
    context.get('user'),
    environment,
    targets,
    true,
  );
  return context.json(result, result.ok ? 200 : 207);
});
operationsRoutes.get('/workers/:name', async (context) =>
  context.json(
    await workerDetail(
      context.env,
      workerEnvironment(context.env, context.req.query('environment')),
      context.req.param('name'),
    ),
  ),
);
operationsRoutes.post('/workers/:name/rollback', async (context) => {
  const body = await readBody(context);
  const environment = workerEnvironment(context.env, body.environment);
  const target = await prepareWorkerRollback(
    context.env,
    environment,
    context.req.param('name'),
    stringField(body, 'versionId', { maxLength: 128 }),
  );
  if (dryRun(body)) {
    return context.json(preview('worker.rollback', target.scriptName, { ...target, environment }));
  }
  const result = await executeWorkerRollbacks(
    context.get('db'),
    context.env,
    context.get('user'),
    environment,
    [target],
  );
  return context.json(result, result.ok ? 200 : 207);
});
