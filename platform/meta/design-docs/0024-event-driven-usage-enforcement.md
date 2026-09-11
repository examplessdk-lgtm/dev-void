# Event-Driven Usage Enforcement

**Date:** 2026-02-24
**Status:** Draft

---

## Summary

Replace the current `scheduled` handler (which fans out `O(users x projects)` Analytics Engine queries every 5 minutes) with event-driven per-user Durable Object counters fed by a Cloudflare Queue. This eliminates the scaling bottleneck while preserving the existing KV-based enforcement mechanism. Also fixes AI neuron enforcement to cover all plans (currently free-only).

## Problem

The `scheduled` handler in `packages/api/src/index.ts` runs every 5 minutes and:

1. Pages through **all** users in batches of 50
2. For each user's projects, fires one Analytics Engine HTTP call per project (up to 10 concurrent)
3. For free-plan users, fires another HTTP call per project for AI neuron usage (GraphQL)
4. Sequentially reads/writes KV routing entries to suspend/unsuspend

At scale this is `O(users x projects x external_calls)`. With 1M users averaging 2 projects each, that's ~2M+ HTTP calls every 5 minutes. The Worker will hit wall-clock limits long before completing, causing overlapping runs with stale/conflicting enforcement decisions.

Additionally, AI neuron enforcement only runs for `user.plan === "free"` despite solo (300K) and pro (500K) having defined limits.

## Design

### Architecture

```
                    ┌─────────────┐
   request ───────► │  dispatch   │──► response
                    │             │
                    │ waitUntil:  │
                    │  AE write   │  (existing — powers dashboard charts)
                    │  queue.send │  (NEW — powers enforcement)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ USAGE_QUEUE │  (CF Queue)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  api worker │  (queue consumer)
                    │             │
                    │  group by   │
                    │  userId     │
                    │      │      │
                    │  ┌───▼───┐  │
                    │  │  DO   │  │  (one per user)
                    │  │counter│  │
                    │  └───┬───┘  │
                    │      │      │
                    │  if exceeded:│
                    │  → KV write │  (suspend routing)
                    │  → D1 write │  (audit trail)
                    └─────────────┘

   hourly cron ───► billing period rollovers + backfill + AI reconciliation
```

### Key Design Decisions

1. **Per-user DO, not per-project** — limits are per-user (aggregate across all projects). One DO per user naturally aggregates. A user with 10 projects has one DO, not 10.

2. **Queue, not direct DO call from dispatch** — decouples dispatch from the api worker. Queue provides backpressure, retry, and batching. Dispatch hot path gains only a `waitUntil` queue send (non-blocking, fire-and-forget).

3. **KV enforcement preserved** — dispatch still checks `routing.suspended` in KV on every request (unchanged). The DO writes KV when limits are breached — same mechanism the current cron uses, just triggered by real-time events instead of periodic polling.

4. **Analytics Engine write preserved** — AE powers dashboard usage charts (time-series breakdowns by day/type/status). The scaling problem was never the AE _write_ (fire-and-forget `writeDataPoint`), it was the cron _querying_ AE millions of times. AE is no longer queried for enforcement.

5. **Request counters event-driven, AI counters alarm-driven** — request volume is the scaling bottleneck (millions/sec). AI calls are orders of magnitude lower. AI neuron usage is checked via per-user DO alarms (every 15 min) querying AI Gateway GraphQL — distributed across users, not a single global cron sweep.

6. **DOs are source of truth for enforcement** — no reconciliation against AE needed. CF Queues guarantee at-least-once delivery, so DO counters are accurate. The hourly cron only handles billing period rollovers and edge cases.

### New Components

#### CF Queue: `void-usage-events`

Producer: dispatch worker (new `USAGE_QUEUE` binding).
Consumer: api worker (new queue handler).

```ts
type UsageEvent = {
  projectId: string;
  userId: string;
  requests: number; // always 1
  responseBytes: number;
};
```

#### Durable Object: `UsageCounter` (in api worker)

One instance per user, keyed by `userId`.

Persistent state (DO storage):

```ts
type CounterState = {
  totalRequests: number;
  totalNeurons: number;
  billingPeriodStart: string; // ISO date
  requestsSuspended: boolean; // tracking suspension state
  aiSuspended: boolean;
  projectSlugs: Record<string, string>; // projectId → slug (for KV writes)
};
```

HTTP API (called by queue consumer and cron):

- `POST /record` — increment request counters from batched events, evaluate limits
- `POST /check-ai` — query AI Gateway for this user's neuron usage, evaluate limits
- `POST /rollover` — reset counters for new billing period
- `GET /state` — return current counter state (debugging/admin)

The DO sets an alarm for AI checks (every 15 min if user has projects, otherwise no alarm).

#### Updated RoutingEntry

```ts
type RoutingEntry = {
  // ... existing fields
  userId: string; // NEW — set at deploy time
};
```

Dispatch needs `userId` to include in queue events. This is immutable per project and set when the deploy endpoint writes the KV routing entry.

### Data Flow

#### Request Path (dispatch)

```
1. Request hits dispatch
2. Dispatch serves response (unchanged hot path)
3. ctx.waitUntil:
   a. recordRequest() → Analytics Engine        (existing, unchanged)
   b. USAGE_QUEUE.send({ projectId, userId,     (NEW, fire-and-forget)
        requests: 1, responseBytes: N })
```

Zero change to the synchronous request path. Queue send is non-blocking in `waitUntil`.

#### Queue Consumer (api worker)

```
1. Receive batch of UsageEvents from queue
2. Group events by userId
3. For each userId:
   a. Get DO stub: env.USAGE_COUNTER.idFromName(userId)
   b. POST /record with batched events
4. Batch acked on success, retried on failure
```

#### DO Limit Evaluation (on /record)

```
1. Increment totalRequests by sum of batch
2. Update projectSlugs mapping if new projects seen
3. Look up plan limits (from stored plan or passed in)
4. If totalRequests crosses requestsPerMonth limit:
   a. For each project slug: KV.put(slug, {...routing, suspended: "requests_exceeded"})
   b. D1: UPDATE users SET suspended_reason = 'requests_exceeded'
   c. Set requestsSuspended = true
5. (Unsuspension only happens during rollover or manual admin action)
```

#### AI Enforcement (DO alarm, every 15 min)

```
1. DO alarm fires
2. Query AI Gateway GraphQL for this user's projects' neuron usage
3. Aggregate neuron cost across projects
4. If aiNeuronsPerMonth exceeded (checked for ALL plans, not just free):
   a. KV.put("ai-block:{projectId}", "1") for each project
   b. Set aiSuspended = true
5. If below limit and currently aiSuspended:
   a. KV.delete("ai-block:{projectId}") for each project
   b. Set aiSuspended = false
6. Re-set alarm for next check
```

#### Hourly Cron (simplified)

```
1. Page through users in batches
2. For each user:
   a. Check if billing period has rolled over → POST /rollover to DO
   b. Ensure DO exists for users with no events yet (new signups)
   c. Backfill userId in old RoutingEntry KV records missing it
3. No Analytics Engine queries. No per-project fan-out.
```

### What Changes in Each Worker

| Worker        | Changes                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **dispatch**  | Add `USAGE_QUEUE` binding. Add `userId` to RoutingEntry type. Add `queue.send()` in `waitUntil`.                                                                                                                                                   |
| **api**       | Add `UsageCounter` DO class + binding. Add queue consumer handler. Update deploy endpoint to write `userId` into KV routing. Rework `scheduled` to hourly cron (rollovers + backfill only). Remove `user.plan === "free"` guard on AI enforcement. |
| **ai-proxy**  | No changes.                                                                                                                                                                                                                                        |
| **dashboard** | No changes.                                                                                                                                                                                                                                        |

### Migration Strategy

**Phase 1: Add `userId` to RoutingEntry.** Update the deploy endpoint to include `userId` in KV routing writes. New deploys get it; old entries are backfilled by the cron.

**Phase 2: Deploy DO + queue infrastructure.** Add DO class, queue bindings, consumer handler. DOs start empty and accumulate from first event.

**Phase 3: Run both paths in parallel.** Keep the 5-min cron running alongside the new event-driven path for 1-2 weeks. Both write the same suspension flags (they converge). Monitor for divergence.

**Phase 4: Cut over.** Demote cron to hourly. Remove per-user AE queries from the cron. Event-driven path is now primary.

### Testing Strategy

- Existing `scheduled.test.ts` tests are adapted to the new hourly reconciliation behavior
- New unit tests for DO: counter increment, limit evaluation, suspend/unsuspend, billing period rollover, AI alarm
- New integration tests for queue consumer: event batching, grouping by userId, DO dispatch
- Dispatch tests: assert `queue.send` is called in `waitUntil` with correct shape
- Migration tests: verify old RoutingEntry records (without userId) are handled gracefully

### Scaling Properties

| Dimension                    | Before                            | After                                    |
| ---------------------------- | --------------------------------- | ---------------------------------------- |
| External API calls per cron  | `O(users x projects)` every 5 min | Zero (cron does no API calls)            |
| Enforcement latency          | Up to 5 min (cron interval)       | Seconds (queue → DO)                     |
| AI enforcement               | Free plan only                    | All plans                                |
| Concurrent cron overlap risk | High at scale                     | None (DO is per-user, queue is ordered)  |
| Dispatch hot path impact     | None                              | +1 `waitUntil` queue send (non-blocking) |
