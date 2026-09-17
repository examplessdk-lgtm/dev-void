import { Hono } from 'hono';
import { getRecentPlatformEvents } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  workerEnvironment,
  workerList,
  workerDetail,
  prepareWorkerRollback,
  prepareAllWorkerRollbacks,
  executeWorkerRollbacks,
  workerBatch,
} from '../../operator/worker-operations.ts';
import type { PlatformEvent } from '../../types.ts';
import { PLATFORM_WORKERS } from '../platform-workers.ts';
import { PlatformRollbackResultPage } from '../views/platform-rollback-result.tsx';
import { PlatformWorkerDetailPage } from '../views/platform-worker-detail.tsx';
import { PlatformPage } from '../views/platform.tsx';

const app = new Hono<ApiEnv>();
// This console intentionally models the hosted production/staging topology and
// its literal script names. Self-hosted installations are upgraded through the
// ownership-aware CLI; letting this route run there could target an unrelated
// `void-*` Worker in the same account.
app.use('*', async (context, next) => {
  if (context.env.PLATFORM_INSTALLATION_ID) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'hosted-platform-operations',
        message: 'Manage this self-hosted Void platform with `void platform upgrade`.',
      },
      501,
    );
  }
  await next();
});

app.onError((error, context) => {
  if (error instanceof OperatorError) {
    return context.text(error.message, error.status);
  }
  console.error(error);
  return context.text('Platform operation failed.', 500);
});
const PAGE_SIZE = 15;
export type ActivityEntry =
  | { kind: 'single'; event: PlatformEvent }
  | { kind: 'batch'; batchId: string; events: ReadonlyArray<PlatformEvent> };

function collapseEvents(events: ReadonlyArray<PlatformEvent>): ReadonlyArray<ActivityEntry> {
  const batchMap = new Map<string, Array<PlatformEvent>>();
  for (const event of events) {
    if (event.batch_id) {
      const list = batchMap.get(event.batch_id);
      if (list) {
        list.push(event);
      } else {
        batchMap.set(event.batch_id, [event]);
      }
    }
  }

  const entries: Array<ActivityEntry> = [];
  const seenBatches = new Set<string>();

  for (const event of events) {
    if (!event.batch_id) {
      entries.push({ kind: 'single', event });
    } else if (!seenBatches.has(event.batch_id)) {
      seenBatches.add(event.batch_id);
      entries.push({
        kind: 'batch',
        batchId: event.batch_id,
        events: batchMap.get(event.batch_id)!,
      });
    }
  }

  return entries;
}

app.get('/', async (context) => {
  const environment = workerEnvironment(context.env);
  const [result, rawEvents] = await Promise.all([
    workerList(context.env, environment),
    getRecentPlatformEvents(context.get('db'), environment, 500),
  ]);
  const allEntries = collapseEvents(rawEvents);
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  return context.html(
    <PlatformPage
      workers={result.workers}
      env={environment}
      username={context.get('user').login}
      tz={context.req.raw.cf?.timezone as string | undefined}
      entries={allEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
      page={page}
      totalPages={Math.max(1, Math.ceil(allEntries.length / PAGE_SIZE))}
    />,
  );
});

app.post('/rollback-all', async (context) => {
  const environment = workerEnvironment(context.env);
  const body = await context.req.parseBody();
  const versions = Object.fromEntries(
    PLATFORM_WORKERS.map((worker) => [worker.name, body[`version_${worker.name}`]]),
  );
  return executeAuditedMutation(
    context,
    operatorAuditIntent('workers/rollback-all', { environment, versions }),
    async () => {
      const targets = await prepareAllWorkerRollbacks(context.env, environment, versions);
      const result = await executeWorkerRollbacks(
        context.get('db'),
        context.env,
        context.get('user'),
        environment,
        targets,
        true,
      );
      return {
        response: await context.html(
          <PlatformRollbackResultPage
            events={result.events}
            batchId={result.batchId!}
            env={environment}
            username={context.get('user').login}
            tz={context.req.raw.cf?.timezone as string | undefined}
          />,
        ),
        // The browser result page intentionally renders at 200 even when the
        // batch failed or partially applied, so classify the operation result.
        succeeded: result.ok,
      };
    },
  );
});

app.get('/events/:batchId', async (context) => {
  const result = await workerBatch(context.get('db'), context.env, context.req.param('batchId'));
  return context.html(
    <PlatformRollbackResultPage
      events={result.events}
      batchId={result.batchId}
      env={result.environment}
      username={context.get('user').login}
      tz={context.req.raw.cf?.timezone as string | undefined}
    />,
  );
});

app.get('/:name', async (context) => {
  const environment = workerEnvironment(context.env);
  const result = await workerDetail(context.env, environment, context.req.param('name'));
  return context.html(
    <PlatformWorkerDetailPage
      {...result}
      env={environment}
      username={context.get('user').login}
      tz={context.req.raw.cf?.timezone as string | undefined}
    />,
  );
});

app.post('/:name/rollback', async (context) => {
  const environment = workerEnvironment(context.env);
  const body = await context.req.parseBody();
  if (typeof body.version_id !== 'string') {
    throw new OperatorError(400, 'Missing version_id.');
  }
  const workerName = context.req.param('name');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`workers/${workerName}/rollback`, {
      environment,
      versionId: body.version_id,
    }),
    async () => {
      const target = await prepareWorkerRollback(
        context.env,
        environment,
        workerName,
        body.version_id as string,
      );
      const result = await executeWorkerRollbacks(
        context.get('db'),
        context.env,
        context.get('user'),
        environment,
        [target],
      );
      if (!result.ok) {
        const detail = await workerDetail(context.env, environment, target.worker.name);
        const outcome = result.events[0];
        return {
          response: await context.html(
            <PlatformWorkerDetailPage
              {...detail}
              env={environment}
              error={`Rollback outcome: ${outcome.status}. ${outcome.error_message ?? outcome.auditError ?? ''}`}
              username={context.get('user').login}
              tz={context.req.raw.cf?.timezone as string | undefined}
            />,
            502,
          ),
          succeeded: false,
        };
      }
      return {
        response: context.redirect(`/admin/platform/${target.worker.name}`),
        succeeded: true,
      };
    },
  );
});

export default app;
