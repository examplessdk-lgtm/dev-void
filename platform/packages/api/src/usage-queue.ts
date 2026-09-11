import { createDb, getUser } from './db.ts';
import type { ApiEnv } from './env.ts';
import { getPlanLimits } from './tiers.ts';
import type { UsageEvent } from './usage-counter.ts';

const PLATFORM_STATIC_ASSET_FAILURES: ReadonlySet<NonNullable<UsageEvent['failureKind']>> = new Set(
  ['platform-static-asset-timeout', 'platform-static-asset-error', 'platform-static-asset-missing'],
);

export function groupEventsByUser(
  events: ReadonlyArray<UsageEvent>,
): Map<string, ReadonlyArray<UsageEvent>> {
  const grouped = new Map<string, Array<UsageEvent>>();
  for (const event of events) {
    const existing = grouped.get(event.userId);
    if (existing) {
      existing.push(event);
    } else {
      grouped.set(event.userId, [event]);
    }
  }
  return grouped;
}

export async function processUsageEventBatch(
  batch: MessageBatch<unknown>,
  env: ApiEnv['Bindings'],
): Promise<void> {
  // Cloudflare stamps each message with its enqueue time — which is when
  // dispatch metered the response at the edge. Keep it: the 5xx alert window
  // must report when the errors happened, not when this consumer drained the
  // batch (a backlog or a retried batch can put hours between the two).
  // Defensive fallback because this is also the billing path.
  const records = batch.messages.map((message) => ({
    event: message.body as UsageEvent,
    at: message.timestamp instanceof Date ? message.timestamp.getTime() : Date.now(),
  }));
  const events = records.map((record) => record.event);

  const grouped = groupEventsByUser(events);
  const db = createDb(env.HYPERDRIVE.connectionString);

  const results = await Promise.allSettled(
    [...grouped.entries()].map(async ([userId, userEvents]) => {
      // Look up user plan (skip DO call for unlimited plans)
      const user = await getUser(db, userId);
      if (!user) {
        return;
      } // Unknown user, skip
      const plan = user.plan ?? 'free';
      const limits = getPlanLimits(plan);
      if (limits.requestsPerMonth === 0) {
        return;
      } // Unlimited plan, skip DO

      // Forward to DO
      const doId = env.USAGE_COUNTER.idFromName(userId);
      const stub = env.USAGE_COUNTER.get(doId);
      const res = await stub.fetch(
        new Request('https://do/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: userEvents, plan, userId }),
        }),
      );

      if (!res.ok) {
        throw new Error(`DO /record failed for user ${userId}: ${res.status}`);
      }
    }),
  );

  // If any UsageCounter DO calls failed, retry the whole batch
  // Route 5xx events only on the ack path to avoid double-counting on redelivery
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    batch.retryAll();
  } else {
    // Best-effort: route project 5xx events to ErrorAlertMonitor (failures
    // don't block ack). Platform-owned static storage failures remain billed
    // and visible in request analytics, but do not tell users that their
    // application returned an error.
    const errorRecords = records.filter(
      ({ event }) =>
        event.status !== undefined &&
        event.status >= 500 &&
        !(event.failureKind !== undefined && PLATFORM_STATIC_ASSET_FAILURES.has(event.failureKind)),
    );
    if (errorRecords.length > 0) {
      const errorsByProject = new Map<
        string,
        { count: number; userId: string; slug: string; firstAt: number; lastAt: number }
      >();
      for (const { event, at } of errorRecords) {
        const existing = errorsByProject.get(event.projectId);
        if (existing) {
          existing.count++;
          existing.firstAt = Math.min(existing.firstAt, at);
          existing.lastAt = Math.max(existing.lastAt, at);
        } else {
          errorsByProject.set(event.projectId, {
            count: 1,
            userId: event.userId,
            slug: event.slug,
            firstAt: at,
            lastAt: at,
          });
        }
      }

      await Promise.allSettled(
        [...errorsByProject.entries()].map(
          async ([projectId, { count, userId, slug, firstAt, lastAt }]) => {
            const doId = env.ERROR_ALERT_MONITOR.idFromName(projectId);
            const stub = env.ERROR_ALERT_MONITOR.get(doId);
            const res = await stub.fetch(
              new Request('https://do/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId, count, userId, slug, firstAt, lastAt }),
              }),
            );
            if (!res.ok) {
              console.error(
                `[error-alert] DO /record failed for project ${projectId}: ${res.status}`,
              );
            }
          },
        ),
      );
    }

    batch.ackAll();
  }
}
