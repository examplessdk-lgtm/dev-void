import { Hono } from 'hono';
import {
  createPlatformEvent,
  updatePlatformEventStatus,
  skipPendingBatchEvents,
  getPlatformEventsByBatchId,
  getRecentPlatformEvents,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { generateId } from '../../id.ts';
import {
  listWorkerVersions,
  listWorkerDeployments,
  createWorkerDeployment,
  type WorkerVersion,
  type WorkerDeployment,
} from '../../provisioning/workers-versions.ts';
import type { PlatformEvent } from '../../types.ts';
import { PLATFORM_WORKERS, getScriptName, getWorkerByName, parseEnv } from '../platform-workers.ts';
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

const PAGE_SIZE = 15;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

async function fetchWorkerDetail(
  accountId: string,
  apiToken: string,
  scriptName: string,
): Promise<{
  versions: ReadonlyArray<WorkerVersion>;
  deployment?: WorkerDeployment;
  error?: string;
}> {
  const [versionsResult, deploymentsResult] = await Promise.allSettled([
    listWorkerVersions(accountId, apiToken, scriptName),
    listWorkerDeployments(accountId, apiToken, scriptName),
  ]);

  const versions = versionsResult.status === 'fulfilled' ? versionsResult.value.items : [];
  const deployment =
    deploymentsResult.status === 'fulfilled' ? deploymentsResult.value.deployments[0] : undefined;

  const errors: Array<string> = [];
  if (versionsResult.status === 'rejected') {
    errors.push(toErrorMessage(versionsResult.reason));
  }
  if (deploymentsResult.status === 'rejected') {
    errors.push(toErrorMessage(deploymentsResult.reason));
  }

  return { versions, deployment, error: errors.length > 0 ? errors.join('; ') : undefined };
}

// GET / — overview of all platform workers
app.get('/', async (context) => {
  const env = parseEnv(context.env.PLATFORM_ENV);
  const accountId = context.env.CF_ACCOUNT_ID;
  const apiToken = context.env.CF_API_TOKEN;
  const db = context.get('db');
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  const page = Math.max(1, parseInt(context.req.query('page') ?? '1') || 1);

  const [cfResults, rawEvents] = await Promise.all([
    Promise.allSettled(
      PLATFORM_WORKERS.map(async (worker) => {
        const scriptName = getScriptName(worker, env);
        const { deployments } = await listWorkerDeployments(accountId, apiToken, scriptName);
        const current = deployments[0];
        const currentVersionId = current?.versions.find((v) => v.percentage === 100)?.version_id;
        // Find the first deployment whose active version differs from current
        // (skips over rollback-induced deployments that point back to the same version)
        const previous = deployments.find((d) => {
          const vid = d.versions.find((v) => v.percentage === 100)?.version_id;
          return vid && vid !== currentVersionId;
        });
        const previousVersionId = previous?.versions.find((v) => v.percentage === 100)?.version_id;
        return { worker, scriptName, deployment: current, previousVersionId };
      }),
    ),
    getRecentPlatformEvents(db, env, 500),
  ]);

  const workers = cfResults.map((r, i) => {
    if (r.status === 'fulfilled') {
      return r.value;
    }
    const worker = PLATFORM_WORKERS[i];
    const errorMsg = toErrorMessage(r.reason);
    console.error(`Failed to fetch deployments for ${getScriptName(worker, env)}: ${errorMsg}`);
    return { worker, scriptName: getScriptName(worker, env), error: errorMsg };
  });

  const allEntries = collapseEvents(rawEvents);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PAGE_SIZE));
  const entries = allEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return context.html(
    <PlatformPage
      workers={workers}
      env={env}
      username={context.get('user').login}
      tz={tz}
      entries={entries}
      page={page}
      totalPages={totalPages}
    />,
  );
});

// POST /rollback-all — orchestrated rollback of all platform workers
app.post('/rollback-all', async (context) => {
  const env = parseEnv(context.env.PLATFORM_ENV);
  const accountId = context.env.CF_ACCOUNT_ID;
  const apiToken = context.env.CF_API_TOKEN;
  const db = context.get('db');
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  const body = await context.req.parseBody();
  const batchId = generateId('batch');

  // Rollback order: reverse deploy order (dispatch → dashboard → api → tail → proxy)
  const rollbackOrder = [...PLATFORM_WORKERS].sort((a, b) => b.deployOrder - a.deployOrder);

  // Validate all version IDs present
  const workerTargets = rollbackOrder.map((worker) => {
    const versionId = body[`version_${worker.name}`] as string | undefined;
    const scriptName = getScriptName(worker, env);
    return { worker, scriptName, versionId };
  });

  const missing = workerTargets.filter((t) => !t.versionId);
  if (missing.length > 0) {
    return context.html(
      `<h1>Missing version IDs for: ${missing.map((m) => m.worker.name).join(', ')}</h1>`,
      400,
    );
  }

  // Insert all events as pending
  const eventRows = await Promise.all(
    workerTargets.map((t) =>
      createPlatformEvent(db, {
        id: generateId('pevt'),
        batch_id: batchId,
        action: 'rollback_all',
        worker_name: t.worker.name,
        environment: env,
        version_id: t.versionId!,
        script_name: t.scriptName,
        status: 'pending',
        error_message: null,
        admin_user_id: context.get('user').id,
        admin_login: context.get('user').login,
      }),
    ),
  );

  // Execute rollbacks sequentially, stop on failure
  for (let i = 0; i < workerTargets.length; i++) {
    const target = workerTargets[i];
    const event = eventRows[i];

    try {
      await createWorkerDeployment(accountId, apiToken, target.scriptName, target.versionId!);
      await updatePlatformEventStatus(db, event.id, 'success');
    } catch (err) {
      const errorMessage = toErrorMessage(err);
      console.error(`Batch rollback failed for ${target.scriptName} to ${target.versionId}:`, err);
      await updatePlatformEventStatus(db, event.id, 'failed', errorMessage);
      // Mark all remaining pending events as skipped in one query
      await skipPendingBatchEvents(db, batchId);
      break;
    }
  }

  const finalEvents = await getPlatformEventsByBatchId(db, batchId);

  return context.html(
    <PlatformRollbackResultPage
      events={finalEvents}
      batchId={batchId}
      env={env}
      username={context.get('user').login}
      tz={tz}
    />,
  );
});

// GET /events/:batchId — view past batch rollback results
app.get('/events/:batchId', async (context) => {
  const batchId = context.req.param('batchId');
  const db = context.get('db');
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  const events = await getPlatformEventsByBatchId(db, batchId);
  if (events.length === 0) {
    return context.html('<h1>Batch not found</h1>', 404);
  }

  const env = events[0].environment;

  return context.html(
    <PlatformRollbackResultPage
      events={events}
      batchId={batchId}
      env={env}
      username={context.get('user').login}
      tz={tz}
    />,
  );
});

// GET /:name — version history for a single worker
app.get('/:name', async (context) => {
  const env = parseEnv(context.env.PLATFORM_ENV);
  const worker = getWorkerByName(context.req.param('name'));
  if (!worker) {
    return context.html('<h1>Worker not found</h1>', 404);
  }

  const scriptName = getScriptName(worker, env);
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  const { versions, deployment, error } = await fetchWorkerDetail(
    context.env.CF_ACCOUNT_ID,
    context.env.CF_API_TOKEN,
    scriptName,
  );

  return context.html(
    <PlatformWorkerDetailPage
      worker={worker}
      env={env}
      scriptName={scriptName}
      versions={versions}
      deployment={deployment}
      error={error}
      username={context.get('user').login}
      tz={tz}
    />,
  );
});

// POST /:name/rollback — deploy a previous version at 100%
app.post('/:name/rollback', async (context) => {
  const env = parseEnv(context.env.PLATFORM_ENV);
  const worker = getWorkerByName(context.req.param('name'));
  if (!worker) {
    return context.html('<h1>Worker not found</h1>', 404);
  }

  const body = await context.req.parseBody();
  const versionId = body.version_id as string;
  if (!versionId) {
    return context.html('<h1>Missing version_id</h1>', 400);
  }

  const accountId = context.env.CF_ACCOUNT_ID;
  const apiToken = context.env.CF_API_TOKEN;
  const scriptName = getScriptName(worker, env);
  const db = context.get('db');

  let status: 'success' | 'failed' = 'success';
  let errorMessage: string | null = null;

  try {
    await createWorkerDeployment(accountId, apiToken, scriptName, versionId);
  } catch (err) {
    status = 'failed';
    errorMessage = toErrorMessage(err);
    console.error(`Rollback failed for ${scriptName} to version ${versionId}:`, err);
  }

  await createPlatformEvent(db, {
    id: generateId('pevt'),
    batch_id: null,
    action: 'rollback',
    worker_name: worker.name,
    environment: env,
    version_id: versionId,
    script_name: scriptName,
    status,
    error_message: errorMessage,
    admin_user_id: context.get('user').id,
    admin_login: context.get('user').login,
  });

  if (status === 'failed') {
    const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
    const { versions, deployment } = await fetchWorkerDetail(accountId, apiToken, scriptName);

    return context.html(
      <PlatformWorkerDetailPage
        worker={worker}
        env={env}
        scriptName={scriptName}
        versions={versions}
        deployment={deployment}
        error={`Rollback failed: ${errorMessage}`}
        username={context.get('user').login}
        tz={tz}
      />,
      500,
    );
  }

  return context.redirect(`/admin/platform/${worker.name}`);
});

export default app;
