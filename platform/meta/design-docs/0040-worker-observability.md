---
title: Worker Observability — Error Logs
status: approved
created: 2026-03-01
---

# Worker Observability — Error Logs

## Goal

Enable admin dashboard users to click on a deployment and see runtime error logs from that user worker (from requests, not deployment-time errors).

## Approach

Use Cloudflare's built-in **Workers Logs** (GA April 2025) for historical log storage (7-day retention, queryable via REST API) and the **Tail API** for real-time WebSocket streaming as a fallback/complement.

## Design

### 1. Enable Observability on User Worker Uploads

Add `observability` to the worker metadata when uploading to the dispatch namespace.

**File:** `packages/api/src/routes/deploy.ts`

Both the static-only and full deploy paths gain:

```js
observability: {
  enabled: true,
  head_sampling_rate: 1, // 100% — revisit per plan tier later
}
```

### 2. API Endpoints

#### Historical Logs

`GET /admin/deployments/:id/logs`

Query params:

- `since` — time window: `1h` (default), `6h`, `24h`, `7d`
- `level` — filter: `error`, `warn`, `info`, `log`, `all` (default)
- `outcome` — filter: `ok`, `exception`, `all` (default)
- `limit` — max entries: `100` (default)

Flow: look up deployment → derive `workerName = "user-{slug}"` → call CF Observability API (`POST /accounts/{id}/workers/observability/telemetry/query`) filtered by script name, time range, level → return structured JSON.

Response:

```json
{
  "logs": [
    {
      "timestamp": 1709312585000,
      "level": "error",
      "message": "ReferenceError: x is not defined",
      "outcome": "exception",
      "request": { "url": "/api/foo", "method": "GET" },
      "response": { "status": 500 },
      "exception": { "name": "ReferenceError", "message": "x is not defined" }
    }
  ]
}
```

#### Real-time Tail (Fallback)

`POST /admin/deployments/:id/tail`

Creates a CF Tail session via `POST /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{name}/tails`. Returns a pre-authenticated WebSocket URL that the browser connects to directly.

Response:

```json
{ "url": "wss://tail.cloudflare.com/...", "id": "tail-session-id" }
```

Cleanup: `DELETE /admin/deployments/:id/tail/:tailId`

### 3. Admin Dashboard UI

Add a "Logs" section to the deployment detail page (`/admin/deployments/:id`).

```
┌─────────────────────────────────────────────┐
│ Logs                                        │
│                                             │
│ Time: [1h ▾]  Level: [All ▾]  [Live Tail]  │
│                                             │
│ 14:23:05  ERROR  ReferenceError: x is not   │
│                  defined at handler (index.… │
│ 14:22:58  LOG    request received: /api/foo  │
│ 14:22:50  WARN   deprecated API called       │
│ ...                                          │
│ [Load more]                                  │
└─────────────────────────────────────────────┘
```

- **Filter bar** — dropdowns for time range and level, "Live Tail" button
- **Log table** — timestamp, level (color-coded: red=error, orange=warn, gray=log/info), message
- **Expandable rows** — click to see full exception, request URL/method, response status, CPU/wall time
- **Live Tail** — inline `<script>` connects to CF WebSocket, appends entries in real-time
- **Auto-refresh** — historical mode refreshes every 10 seconds

### 4. New Files

| File                                               | Purpose                                     |
| -------------------------------------------------- | ------------------------------------------- |
| `packages/api/src/admin/views/deployment-logs.tsx` | Logs section JSX component                  |
| `packages/api/src/provisioning/cloudflare-api.ts`  | New CF API helpers for observability + tail |

### 5. Modified Files

| File                                            | Change                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `packages/api/src/routes/deploy.ts`             | Add `observability` to worker upload metadata (both paths) |
| `packages/api/src/admin/routes/deployments.tsx` | New routes for logs + tail endpoints, render logs section  |

## Risks

| Risk                                                                    | Mitigation                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| CF Observability API query format underdocumented                       | Experiment during implementation; Tail API as reliable fallback |
| `observability` metadata may not work via dispatch namespace upload API | Test early; if fails, enable via Tail Worker config             |
| Cost of 100% sampling at scale                                          | Start with 100%, add per-plan sampling rates later              |
| 7-day retention insufficient                                            | Acceptable for MVP; Tail Worker + R2 for longer retention later |

## Future Extensions

- Per-plan sampling rates (free=10%, paid=100%)
- User-facing dashboard logs (not just admin)
- Error alerting (webhook/email on exception spikes)
- Tail Worker + R2 for longer retention
- Aggregated error metrics (error rate, top errors, etc.)
