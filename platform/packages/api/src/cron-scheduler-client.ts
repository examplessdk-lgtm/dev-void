import type { ApiEnv } from './env.ts';

type CronSyncState = Readonly<{
  workerName: string;
  schedules: ReadonlyArray<{ name: string; cron: string }>;
  proxyToken?: string;
}>;

/**
 * Retry an async DO RPC a small number of times before giving up. Same-account
 * DO calls are local in-isolate and almost always succeed, but they can fail
 * during DO eviction, storage hiccups, or worker-process recycling. Without a
 * retry, a single transient failure here would leave the CronScheduler DO out
 * of sync until the next user-triggered deploy — for sync, the DO points at a
 * stale workerName; for clear after a worker-deletion path, the DO keeps
 * firing until the cron-fires queue ack-drops as `Worker not found`. Caller
 * still catches+logs the final failure as a safety net.
 */
async function callWithRetry(
  label: string,
  projectId: string,
  fn: () => Promise<Response>,
): Promise<void> {
  const delaysMs = [0, 100, 400];
  let lastErr: unknown;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(
    `[cron-scheduler-client] ${label} failed for ${projectId} after ${delaysMs.length} attempts:`,
    lastErr instanceof Error ? lastErr.message : lastErr,
  );
}

/**
 * Resync the per-project CronScheduler DO with the current live deployment's
 * cron schedules. Errors are retried then caught and logged — cron sync drift
 * self-heals on the next deploy.
 */
export async function syncCronScheduler(
  env: Pick<ApiEnv['Bindings'], 'CRON_SCHEDULER'>,
  projectId: string,
  state: CronSyncState,
): Promise<void> {
  try {
    await callWithRetry('sync', projectId, () =>
      env.CRON_SCHEDULER.get(env.CRON_SCHEDULER.idFromName(projectId)).fetch(
        new Request('https://do/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        }),
      ),
    );
  } catch (err) {
    // `idFromName` can throw synchronously on a misconfigured binding or
    // malformed projectId. Catch here so callers (e.g. `Promise.all` over a
    // cleanup array) cannot be aborted by a stray sync throw.
    console.error(
      `[cron-scheduler-client] sync threw synchronously for ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Clear the per-project CronScheduler DO. Idempotent (handleClear is
 * deleteAll + deleteAlarm, both no-ops on empty DOs). Used from every code
 * path that deletes a user worker so stale alarms do not churn.
 */
export async function clearCronScheduler(
  env: Pick<ApiEnv['Bindings'], 'CRON_SCHEDULER'>,
  projectId: string,
): Promise<void> {
  try {
    await callWithRetry('clear', projectId, () =>
      env.CRON_SCHEDULER.get(env.CRON_SCHEDULER.idFromName(projectId)).fetch(
        new Request('https://do/clear', { method: 'POST' }),
      ),
    );
  } catch (err) {
    // See note on `syncCronScheduler` above.
    console.error(
      `[cron-scheduler-client] clear threw synchronously for ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
