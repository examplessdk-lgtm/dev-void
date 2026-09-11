import {
  projectAccountKey,
  sandboxBlockKey,
  type ProjectAccountEntry,
} from '@voidcloud/api/routing';
import { PLAN_LIMITS, type PlanId } from '@voidcloud/api/tiers';
import { Hono } from 'hono';
import { asString } from './body.ts';
import type { ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

/**
 * Look up the `{userId, plan}` for an HMAC-authenticated `projectId`.
 *
 * The auth middleware in `index.ts` already verified the caller knows the
 * HMAC for `projectId`, so reading the `project:{projectId}` routing entry
 * here is safe — we're translating an authenticated id into the per-account
 * fields the sandbox gate needs (`userId` for `sandbox-block`, `plan` for
 * the concurrency cap).
 *
 * Returns `null` if the entry is missing or malformed (treat as 404 by the
 * caller — the project was deleted out from under a live worker, or the
 * deploy pipeline hasn't backfilled the entry yet).
 */
async function lookupProjectAccount(
  routing: KVNamespace,
  projectId: string,
): Promise<ProjectAccountEntry | null> {
  const raw = await routing.get(projectAccountKey(projectId), { cacheTtl: 60 });
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const userId = asString((parsed as Record<string, unknown>).userId);
  const plan = asString((parsed as Record<string, unknown>).plan);
  if (!userId || !plan) {
    return null;
  }
  return { userId, plan };
}

function planLimit(plan: string): number {
  const limits = PLAN_LIMITS[plan as PlanId];
  // Unknown plan strings fall back to the free tier (matches getPlanLimits
  // in tiers.ts). We import the table directly rather than calling
  // getPlanLimits to keep the bundle minimal.
  return (limits ?? PLAN_LIMITS.free).sandboxMaxConcurrentInstances;
}

/**
 * POST /sandbox/acquire
 *
 * Body: `{ sandboxId: string }` (caller-chosen sandbox instance id).
 *
 * Order of checks is deliberate:
 *   1. validate body
 *   2. resolve projectId -> userId+plan (404 if unknown)
 *   3. KV runtime-budget block (cheap, single KV read)
 *   4. DO concurrency claim (expensive, cross-script DO RPC)
 *
 * Any unhandled error falls through to 500 so the framework's fail-open
 * branch lets the sandbox run rather than blocking on a proxy hiccup.
 */
app.post('/acquire', async (context) => {
  const projectId = context.get('projectId');
  const body = context.get('body');
  const sandboxId = asString(body.sandboxId);
  if (!sandboxId) {
    return context.json({ error: 'sandboxId required' }, 400);
  }

  try {
    const account = await lookupProjectAccount(context.env.ROUTING, projectId);
    if (!account) {
      return context.json({ error: 'project not found' }, 404);
    }

    // KV block check first — short-circuits before the DO RPC when the
    // user has already blown their runtime budget for the period.
    const blocked = await context.env.ROUTING.get(sandboxBlockKey(account.userId), {
      cacheTtl: 60,
    });
    if (blocked) {
      return context.json({ reason: 'runtime_budget' }, 409);
    }

    const limit = planLimit(account.plan);
    const stub = context.env.SANDBOX_CONCURRENCY_COUNTER.get(
      context.env.SANDBOX_CONCURRENCY_COUNTER.idFromName(`account:${account.userId}`),
    );
    const result = await stub.acquire(sandboxId, limit);
    if (result.ok) {
      return context.json({}, 200);
    }
    return context.json({ reason: result.reason }, 409);
  } catch (error) {
    console.error('[proxy/sandbox] acquire failed:', error);
    return context.json({ error: 'sandbox gate internal error' }, 500);
  }
});

/**
 * POST /sandbox/refresh
 *
 * Body: `{ sandboxId: string }`. Heartbeat-driven slot keepalive — the
 * framework's `VoidPlatformSandbox.alarm()` calls this every `HEARTBEAT_MS`
 * via `waitUntil` so the DO's `STALE_MS` (1h) sweep doesn't reap live
 * sessions whose `acquiredAt` ages out between acquire and release.
 *
 * Mirrors `/acquire`'s shape so the shared HMAC auth middleware applies the
 * same `{projectId, aiToken}` verification. Does not consult the
 * `sandbox-block` KV gate — refresh is for a slot we already counted
 * against the plan at acquire time, and in-flight sandboxes are not
 * retroactively suspended when a runtime budget block lands.
 */
app.post('/refresh', async (context) => {
  const projectId = context.get('projectId');
  const body = context.get('body');
  const sandboxId = asString(body.sandboxId);
  if (!sandboxId) {
    return context.json({ error: 'sandboxId required' }, 400);
  }

  try {
    const account = await lookupProjectAccount(context.env.ROUTING, projectId);
    if (!account) {
      // Same propagation-miss path as /release — a missing project entry
      // means there's no slot to refresh, so no-op rather than 404 to
      // match the fire-and-forget caller's expectations.
      return new Response(null, { status: 204 });
    }

    const stub = context.env.SANDBOX_CONCURRENCY_COUNTER.get(
      context.env.SANDBOX_CONCURRENCY_COUNTER.idFromName(`account:${account.userId}`),
    );
    const result = await stub.refresh(sandboxId);
    return context.json(result, 200);
  } catch (error) {
    console.error('[proxy/sandbox] refresh failed:', error);
    return context.json({ error: 'sandbox gate internal error' }, 500);
  }
});

/**
 * POST /sandbox/release
 *
 * Body: `{ sandboxId: string }`. Idempotent — the DO ignores missing ids.
 * Returns 204 on success so the framework's fire-and-forget caller doesn't
 * waste bytes parsing an empty body.
 */
app.post('/release', async (context) => {
  const projectId = context.get('projectId');
  const body = context.get('body');
  const sandboxId = asString(body.sandboxId);
  if (!sandboxId) {
    return context.json({ error: 'sandboxId required' }, 400);
  }

  try {
    const account = await lookupProjectAccount(context.env.ROUTING, projectId);
    if (!account) {
      // `project:{projectId}` is durable in current platform code (see
      // `packages/api/src/provisioning/cleanup.ts`). This branch fires only on
      // KV-propagation misses immediately after the first deploy of a brand-new
      // project — in which case the corresponding `/sandbox/acquire` also missed
      // and fail-opened without counting a slot, so there's nothing to release.
      return new Response(null, { status: 204 });
    }

    const stub = context.env.SANDBOX_CONCURRENCY_COUNTER.get(
      context.env.SANDBOX_CONCURRENCY_COUNTER.idFromName(`account:${account.userId}`),
    );
    await stub.release(sandboxId);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('[proxy/sandbox] release failed:', error);
    return context.json({ error: 'sandbox gate internal error' }, 500);
  }
});

export { app as sandbox };
