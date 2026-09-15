---
title: Platform Cron Scheduler
status: approved
created: 2026-03-02
---

# Platform Cron Scheduler

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Context

Cloudflare's Workers for Platforms (dispatch namespace) does not support cron triggers on user workers. The CF API for dispatch namespace scripts has no `schedules` endpoint, and the `triggers` field in upload metadata is silently ignored. User-defined cron jobs (e.g. `crons/heartbeat.ts` with `export const cron = "* * * * *"`) never fire when deployed.

## Solution

A `CronScheduler` Durable Object on the API worker, one instance per project. Each DO independently manages its own alarm cycle — no central coordinator, no fan-out bottleneck, no subrequest limits.

User workers receive cron invocations via HTTP (`/__scheduled` route), following the same relay pattern queues already use with `/__queue`.

## Architecture

```
Deploy                            Runtime
──────                            ───────
CLI builds manifest               CronScheduler DO alarm fires
  → API /deploy route               → evaluates which crons are due
    → uploads worker to dispatch     → DISPATCH.get(workerName).fetch("/__scheduled")
    → syncs schedules to DO          → user worker handleScheduled()
    → DO computes + sets alarm       → DO computes + sets next alarm
```

## Components

### 1. `CronScheduler` Durable Object (API worker)

New DO class on the API worker, keyed by project ID (`env.CRON_SCHEDULER.idFromName(projectId)`).

**Storage:**

```typescript
type CronSchedulerState = {
  workerName: string; // e.g. "user-kitchen-sink"
  schedules: ScheduleMeta[]; // [{ name: "heartbeat", cron: "* * * * *" }]
};
```

**Endpoints (via internal fetch):**

- `POST /sync` — receives updated schedules from deploy, persists to DO storage, computes next alarm
- `POST /clear` — cancels alarm, deletes storage (when crons are removed on redeploy)
- `GET /status` — returns current state and next alarm time (for admin visibility)

**Alarm handler:**

1. Read schedules from storage
2. For each cron expression, check if it matches the current minute
3. For each match, `env.DISPATCH.get(workerName).fetch("https://internal/__scheduled", { method: "POST", body: JSON.stringify({ cron, scheduledTime }) })`
4. Compute next fire time across all crons (using `cron-parser` npm package)
5. Set alarm for that time

**Edge cases:**

- If multiple crons fire at the same minute, all are invoked in parallel
- If the DO alarm is late (CF jitter), evaluate against the alarm's scheduled time, not wall clock
- If a user worker invocation fails, log and continue — cron jobs are fire-and-forget (matches CF native cron behavior)

### 2. Deploy Flow Changes (`platform/packages/api/src/routes/deploy.ts`)

After worker upload:

- If `manifest.schedules` has entries: POST to `CronScheduler` DO with `{ workerName, schedules }`
- If manifest has no schedules: POST to DO `/clear` to cancel alarm and clean up
- Remove the `triggers` field from upload metadata (it does nothing)

No new database table — the manifest (including schedules) is already stored in the `deployments` table. The DO storage is the runtime source of truth for alarm scheduling.

### 3. Framework `/__scheduled` Route (user workers)

Added to the compiled worker entry alongside the existing `/__queue` route.

- Accepts `POST /__scheduled` with JSON body: `{ cron: string, scheduledTime: number }`
- Constructs a controller object: `{ cron, scheduledTime, noRetry() {} }`
- Calls `handleScheduled(controller, env, ctx)` (the existing generated dispatcher)
- Returns 200 on success, 500 on error

This goes in `packages/void/src/router/compile.ts` (where `/__queue` is generated) and in the wrapper entry (`packages/void/src/cli/wrapper.ts`).

### 4. Cron Expression Evaluation

Use `cron-parser` (v5.5.0) in the DO to:

- Check if a cron expression matches a given minute: parse → get prev → compare
- Compute next fire time: parse → call `next()` → get timestamp

### 5. Wrangler Config Changes (`platform/packages/api/wrangler.jsonc`)

```jsonc
// New DO binding (both production and staging)
"durable_objects": {
  "bindings": [
    { "name": "USAGE_COUNTER", "class_name": "UsageCounter" },
    { "name": "CRON_SCHEDULER", "class_name": "CronScheduler" }
  ]
},
"migrations": [
  { "tag": "v1", "new_classes": ["UsageCounter"] },
  { "tag": "v2", "new_classes": ["CronScheduler"] }
]
```

Staging environment inherits the DO binding (same class, isolated storage).

## Cleanup Lifecycle

| Deploy state                | Action                                               |
| --------------------------- | ---------------------------------------------------- |
| First deploy with crons     | Create DO, sync schedules, set alarm                 |
| Redeploy with updated crons | Sync new schedules to DO, recompute alarm            |
| Redeploy with no crons      | POST `/clear` to DO — cancels alarm, deletes storage |
| Project deleted             | POST `/clear` to DO                                  |

## Cost

DO alarms are billed as DO requests ($0.15/M, first 1M free). Cost scales linearly with (projects × cron frequency). At 1,000 projects with minutely crons: ~$6/month in DO requests.
