import { createDb, getProjectUsageOwnershipSnapshot, getUser } from './db.ts';
import type { ApiEnv } from './env.ts';
import { getCurrentBillingPeriodStart } from './tiers.ts';
import {
  ensureUsageSigningKey,
  SANDBOX_USAGE_RETENTION_MS,
  verifyUsageEnvelope,
} from './usage-auth.ts';
import type { UsageEvent } from './usage-counter.ts';

const PLATFORM_STATIC_ASSET_FAILURES: ReadonlySet<NonNullable<UsageEvent['failureKind']>> = new Set(
  ['platform-static-asset-timeout', 'platform-static-asset-error', 'platform-static-asset-missing'],
);

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validSignedEvent(
  source: 'dispatch' | 'sandbox-counter',
  value: unknown,
): UsageEvent | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    typeof event.projectId !== 'string' ||
    event.projectId.length === 0 ||
    event.projectId.length > 256
  ) {
    return null;
  }
  if (source === 'dispatch') {
    if (event.requests !== 1 || !nonnegativeSafeInteger(event.responseBytes)) {
      return null;
    }
    if (
      (event.status !== undefined && !nonnegativeSafeInteger(event.status)) ||
      (event.failureKind !== undefined &&
        !PLATFORM_STATIC_ASSET_FAILURES.has(
          event.failureKind as NonNullable<UsageEvent['failureKind']>,
        )) ||
      event.sandboxRuntimeSeconds !== undefined ||
      event.sandboxInstanceId !== undefined ||
      event.sandboxMeteredFrom !== undefined ||
      event.sandboxMeteredThrough !== undefined
    ) {
      return null;
    }
  } else if (
    event.requests !== 0 ||
    event.responseBytes !== 0 ||
    typeof event.sandboxInstanceId !== 'string' ||
    event.sandboxInstanceId.length === 0 ||
    event.sandboxInstanceId.length > 1024 ||
    !nonnegativeSafeInteger(event.sandboxMeteredFrom) ||
    !nonnegativeSafeInteger(event.sandboxMeteredThrough) ||
    event.sandboxMeteredThrough < Date.now() - SANDBOX_USAGE_RETENTION_MS ||
    event.sandboxMeteredThrough <= event.sandboxMeteredFrom ||
    (event.sandboxMeteredThrough - event.sandboxMeteredFrom) % 1000 !== 0 ||
    event.sandboxRuntimeSeconds !== undefined
  ) {
    return null;
  }
  return event as UsageEvent;
}

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
  let signingKey: string;
  try {
    signingKey = await ensureUsageSigningKey(env.ROUTING, env.JWT_SECRET);
  } catch (error) {
    console.error('[usage-queue] could not load signing key:', error);
    batch.retryAll();
    return;
  }

  const verified = await Promise.all(
    batch.messages.map(async (message) => {
      const envelope = await verifyUsageEnvelope<UsageEvent>(message.body, signingKey);
      if (!envelope) {
        return null;
      }
      const event = validSignedEvent(envelope.source, envelope.event);
      // Cloudflare stamps each message with its enqueue time — which is when
      // dispatch metered the response at the edge. Keep it: the 5xx alert window
      // must report when the errors happened, not when this consumer drained the
      // batch (a backlog or a retried batch can put hours between the two).
      // Defensive fallback because this is also the billing path.
      return event
        ? {
            event,
            at: message.timestamp instanceof Date ? message.timestamp.getTime() : Date.now(),
          }
        : null;
    }),
  );
  const authenticatedRecords = verified.filter((record) => record !== null);
  if (authenticatedRecords.length === 0) {
    // Legacy tenant producers and malformed/forged envelopes have no
    // authority. Acknowledge them so an old deployment cannot cause an
    // endless retry loop after the consumer upgrade.
    batch.ackAll();
    return;
  }

  const db = createDb(env.HYPERDRIVE.connectionString);
  let ownershipSnapshot: Awaited<ReturnType<typeof getProjectUsageOwnershipSnapshot>>;
  try {
    ownershipSnapshot = await getProjectUsageOwnershipSnapshot(
      db,
      authenticatedRecords.map(({ event }) => event.projectId),
    );
  } catch (error) {
    console.error('[usage-queue] project ownership lookup failed:', error);
    batch.retryAll();
    return;
  }
  const projects = ownershipSnapshot.projects;
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const ownershipPeriodsByProject = new Map<
    string,
    Array<(typeof ownershipSnapshot.ownershipPeriods)[number]>
  >(projects.map((project) => [project.id, []]));
  for (const period of ownershipSnapshot.ownershipPeriods) {
    ownershipPeriodsByProject.get(period.project_id)?.push(period);
  }
  const records = authenticatedRecords.flatMap(({ event, at }) => {
    const project = projectsById.get(event.projectId);
    if (!project) {
      return [];
    }
    // Queue enqueue time is the single attribution timestamp. Managed Sandbox
    // is hard-disabled; split interval attribution is deferred until reintroduction.
    const occurredAt = at;
    const ownershipPeriod = ownershipPeriodsByProject
      .get(event.projectId)
      ?.find(
        (period) =>
          Date.parse(period.starts_at) <= occurredAt &&
          (period.ends_at === null || occurredAt < Date.parse(period.ends_at)),
      );
    const ownerUserId = ownershipPeriod?.owner_user_id ?? project.user_id;
    // PostgreSQL owns account identity and the canonical slug. Producer
    // hints are never forwarded into enforcement or alert routing. Ownership
    // is resolved at the event timestamp so a delayed queue message crossing
    // a transfer remains billed to the correct account.
    return [
      {
        event: {
          ...event,
          userId: ownerUserId,
          slug: project.slug,
          currentOwner:
            project.status !== 'deleting' &&
            (ownershipPeriod ? ownershipPeriod.ends_at === null : true),
          ownershipStartedAt: ownershipPeriod?.starts_at ?? project.created_at,
        },
        at,
      },
    ];
  });
  const events = records.map((record) => record.event);

  const grouped = groupEventsByUser(events);

  const results = await Promise.allSettled(
    [...grouped.entries()].map(async ([userId, userEvents]) => {
      // Resolve every account so request and sandbox accounting share the same ledger.
      const user = await getUser(db, userId);
      if (!user) {
        return;
      } // Unknown user, skip
      const doId = env.USAGE_COUNTER.idFromName(userId);
      const stub = env.USAGE_COUNTER.get(doId);
      const res = await stub.fetch(
        new Request('https://do/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: userEvents,
            plan: user.plan,
            userId,
            billingPeriodStart: getCurrentBillingPeriodStart(
              user.billing_cycle_start ?? user.created_at,
            ).toISOString(),
          }),
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
