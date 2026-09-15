---
title: Real-Time 5xx Error Alerting
status: implemented
created: 2026-03-17
---

# Real-Time 5xx Error Alerting

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Context

Users have no way to know their project is returning server errors until they check the dashboard. We need an automated alert system that emails the project owner when 5xx errors are detected, with low latency and without creating alert fatigue.

## Solution

A per-project `ErrorAlertMonitor` Durable Object that receives 5xx signals from the existing usage queue, debounces them, and sends email alerts. Piggybacks on the dispatch → queue → API pipeline already in place for usage enforcement (see [0024-event-driven-usage-enforcement](./0024-event-driven-usage-enforcement.md)).

## Architecture

```
                    ┌─────────────┐
   request ───────► │  dispatch   │──► response
                    │             │
                    │ waitUntil:  │
                    │  AE write   │  (existing)
                    │  queue.send │  (existing, now includes status on 5xx)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ USAGE_QUEUE │  (CF Queue, batches up to 100, 5s flush)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  api worker │  (queue consumer)
                    │             │
                    │  Phase A:   │  UsageCounter DO (existing, per-user)
                    │  Phase B:   │  ErrorAlertMonitor DO (new, per-project)
                    │      │      │
                    │  ┌───▼───┐  │
                    │  │  DO   │  │  (one per project)
                    │  │ alert │  │
                    │  │monitor│  │
                    │  └───┬───┘  │
                    │      │      │
                    │  debounce   │
                    │  2min / cap │
                    │      │      │
                    │  ┌───▼───┐  │
                    │  │ email │  │  (via CF SendEmail binding)
                    │  └───────┘  │
                    └─────────────┘
```

## Components

### 1. Extended `UsageEvent`

Add optional `status?: number` to the existing `UsageEvent` interface. Dispatch conditionally includes it:

```ts
...(response.status >= 500 && { status: response.status })
```

Zero overhead on the hot path for non-5xx responses — the field is omitted entirely.

### 2. Queue Consumer — Phase B

After the existing UsageCounter routing (Phase A) succeeds and acks the batch, a second pass filters for 5xx events, groups by `projectId`, and forwards counts to the `ErrorAlertMonitor` DO.

Phase B runs **only on the ack path** — if Phase A fails and triggers `batch.retryAll()`, Phase B is skipped entirely. This prevents double-counting on redelivery.

```
Phase A fails  → batch.retryAll()  [Phase B skipped]
Phase A passes → Phase B runs      → batch.ackAll()
                 (Phase B failures do not trigger retry)
```

### 3. `ErrorAlertMonitor` Durable Object

One instance per project, keyed by `projectId` via `idFromName`.

**State:**

```ts
type ErrorAlertState = {
  count: number; // accumulated 5xx errors in current window
  projectId: string;
  userId: string; // project owner (for email lookup)
  slug: string; // project slug (for email copy)
  lastAlertAt: number | null; // epoch ms of last sent alert
};
```

**Constants:**

| Name          | Value | Purpose                         |
| ------------- | ----- | ------------------------------- |
| `DEBOUNCE_MS` | 2 min | Trailing-edge debounce window   |
| `COUNT_CAP`   | 100   | Skip debounce, fire immediately |
| `COOLDOWN_MS` | 24 h  | Suppress repeat alerts          |

**Endpoints:**

- `POST /record` — increment count, evaluate debounce/cap/cooldown

**Alarm handler:** fires when debounce timer or retry timer expires, calls `fireAlert()`.

### 4. Debounce Strategy

Trailing-edge with count cap:

```
Sparse errors:

  t=0s    1x 5xx arrives  → count=1,   alarm set for t=120s
  t=30s   1x 5xx arrives  → count=2,   alarm reset to t=150s
  t=60s   1x 5xx arrives  → count=3,   alarm reset to t=180s
  ...errors stop...
  t=180s  alarm fires     → fireAlert() → email sent with count=3

Burst (count cap = 100):

  t=0s    batch arrives   → count=40,  alarm set for t=120s
  t=5s    batch arrives   → count=80,  alarm reset to t=125s
  t=10s   batch arrives   → count=120, cap hit → fireAlert() immediately

During 24h cooldown:

  t=0h    alert sent, cooldown starts
  t=1h    5xx arrives     → count=1, in cooldown → save, no alarm
  ...
  t=24h   cooldown expires
  t=24.5h 5xx arrives     → count=N, alarm set for t=24.5h+2min

Transient email failure:

  t=0s    5xx arrives     → count=5, alarm set for t=120s
  t=120s  alarm fires     → fireAlert() → email throws
          count=5 preserved, retry alarm set for t=240s
  t=240s  alarm fires     → fireAlert() → email succeeds
          count=0, cooldown active
```

No minimum threshold — even a single 5xx that survives the 2-minute debounce triggers an email.

### 5. `fireAlert()` Outcomes

| Condition               | Action                                             | Retry?                               |
| ----------------------- | -------------------------------------------------- | ------------------------------------ |
| No `EMAIL` binding      | Reset count, return                                | No (permanent config)                |
| User has no email       | Reset count, delete alarm, return                  | No (not transient)                   |
| Email sent successfully | Set cooldown, reset count, delete alarm            | N/A                                  |
| DB or email throws      | Log error, preserve count, schedule alarm at +2min | Yes (indefinitely at 2min intervals) |

Worst-case load during persistent outage: one Postgres query + one email attempt every 2 minutes per affected project.

### 6. Email

Sent via Cloudflare `SendEmail` binding (`noreply@platform.example.net`).

- **Subject:** `5xx errors detected: {slug}`
- **Body:** "Your project **{slug}** has returned **{count}** server error responses recently."
- **Footer:** "You will not receive another alert for this project for 24 hours."
- **CTA:** "View Project" button → dashboard project page

### 7. Wrangler Config

```jsonc
// New DO binding (both production and staging)
"durable_objects": {
  "bindings": [
    { "name": "ERROR_ALERT_MONITOR", "class_name": "ErrorAlertMonitor" }
  ]
},
"migrations": [
  { "tag": "v3", "new_classes": ["ErrorAlertMonitor"] }
]
```

## Backfill: Legacy Routing Entries

Dispatch only emits usage events when `routing.userId` exists. Old routing entries from before the `userId` field was introduced are missing it. The hourly cron's `processUserRollover()` backfills these:

1. **Slug entries (all plans):** reads `ROUTING[project.slug]`, patches any entry missing `userId`. Runs before the unlimited-plan early return so sponsored/custom projects are covered.

2. **Domain entries:** for projects that needed slug backfill, batch-queries active domains via `getDomainsByProjectIds()`, then patches any `ROUTING["domain:{hostname}"]` entries missing `userId`.

Once every project has redeployed at least once (deploys always write `userId` via `buildRoutingJson`/`buildStaticRoutingJson`), the backfill becomes a no-op.

## Deploy Order

API first (registers the DO class and migration), then dispatch (starts emitting `status`). If dispatch deploys first, the `status` field is simply ignored by the old API — no breakage.

## Key Design Decisions

1. **Per-project DO, not per-user** — 5xx alerts are project-scoped (a user may have one healthy project and one broken one). Unlike usage enforcement which aggregates per-user, error alerting needs per-project debounce and cooldown.

2. **Piggyback on existing queue, not a new one** — the usage queue already carries per-request events from dispatch to the API worker. Adding an optional `status` field is cheaper than a second queue (no new binding, no new consumer, no new wrangler config).

3. **Ack-path only for Phase B** — if the queue consumer retries (Phase A failure), the same messages are redelivered. Running Phase B before the retry decision would double-count 5xx events and trigger false alerts.

4. **Preserve count on transient failure** — resetting count on failure and not scheduling a retry would permanently drop a burst's alert if no new 5xx events arrive. Preserving count and scheduling a retry alarm ensures eventual delivery.

5. **No minimum threshold** — even a single 5xx is operationally significant. The 2-minute debounce filters out isolated retries that self-resolve, and the 24-hour cooldown prevents fatigue.

6. **Always fire at count cap** — the cap (100) exists to bypass the debounce during error storms. Attempting `fireAlert()` at the cap even when a debounce alarm is pending ensures immediate response. On transient failure, the retry alarm handles follow-up.

## Future Extensions

- Per-plan alert configuration (custom thresholds, cooldown duration)
- Webhook/Slack notifications in addition to email
- User-facing dashboard alert history
- Aggregate error rate trends (not just counts)
