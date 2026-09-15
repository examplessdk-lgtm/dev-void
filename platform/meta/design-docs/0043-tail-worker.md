---
title: Tail Worker — User Worker Observability
status: approved
created: 2026-03-01
supersedes: 0040-worker-observability
---

# Tail Worker — User Worker Observability

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Context

Design doc 0040 proposed using the CF Workers Logs (telemetry) API and Tail API for user worker observability. Both are unsupported for Workers for Platforms dispatch namespace workers — the telemetry API returns empty data, and the Tail REST endpoint doesn't exist (502). CF docs confirm:

> Adding a Tail Worker to your dispatch Worker collects logs for both the dispatch Worker and for any user Workers in the dispatch namespace.

This design replaces 0040 with a Tail Worker approach.

## Goal

1. **Historical logs**: Admin dashboard shows recent error/exception logs for any deployment, queryable by worker name and time range.
2. **Live tailing**: Admin dashboard streams logs in real-time via WebSocket for a running deployment.
3. **User-facing (future)**: Architecture supports exposing logs to users in the dashboard later.

## Architecture

```
User Workers (dispatch namespace)
    │ (tail events — automatic via CF)
    ▼
Tail Worker (void-tail) ─── tail() handler
    ├──→ Analytics Engine: "void_logs" dataset (historical storage)
    └──→ LogStream Durable Object (per-worker live broadcast)
               │
               ▼ (WebSocket)
          Dashboard clients

API Worker (void-api)
    ├──→ AE SQL API (historical log queries)
    └──→ Service binding → Tail Worker (proxy WebSocket upgrades for live tail)
```

## Design

### New package: `platform/packages/tail`

A new CF Worker (`void-tail`) with:

- **`tail()` handler** — receives `TraceItem[]` events from all user workers in the dispatch namespace. For each event: writes a data point to Analytics Engine, and forwards to the `LogStream` DO keyed by `scriptName`.
- **`LogStream` Durable Object** — one instance per worker name. Accepts WebSocket connections. Uses WebSocket hibernation (`acceptWebSocket()`) for cost efficiency. Broadcasts incoming log events to all connected clients. Automatically cleans up when no clients are connected.
- **`fetch()` handler** — handles `GET /tail/:scriptName` WebSocket upgrade requests (called via service binding from the API worker).

### Analytics Engine schema (`void_logs` dataset)

| Field   | AE slot      | Content                                           |
| ------- | ------------ | ------------------------------------------------- |
| index1  | `indexes[0]` | `scriptName` (e.g. `user-my-project`)             |
| blob1   | `blobs[0]`   | `outcome` (e.g. `ok`, `exception`, `exceededCpu`) |
| blob2   | `blobs[1]`   | JSON array of `logs[]` (console messages)         |
| blob3   | `blobs[2]`   | JSON array of `exceptions[]`                      |
| blob4   | `blobs[3]`   | Request URL                                       |
| blob5   | `blobs[4]`   | Request method                                    |
| blob6   | `blobs[5]`   | Response status (as string)                       |
| double1 | `doubles[0]` | `eventTimestamp` (ms)                             |
| double2 | `doubles[1]` | Response status (as number, for filtering)        |

AE provides 90-day automatic retention and SQL querying via the REST API. The 16KB blob limit is sufficient for typical log output.

### Dispatch worker changes

Add `tail_consumers` to `platform/packages/dispatch/wrangler.jsonc`:

```jsonc
"tail_consumers": [{ "service": "void-tail" }]
```

This automatically routes tail events from `void-dispatch` and all user workers in the `void-users` namespace to `void-tail`.

### API worker changes

1. **Service binding**: Add `TAIL: Fetcher` binding to `void-tail` in `wrangler.jsonc` and `env.ts`.
2. **Historical logs endpoint**: `GET /admin/deployments/:id/logs?since=1h&level=error` — queries AE SQL API for the worker's `scriptName`, returns JSON log entries.
3. **Live tail proxy**: `GET /admin/deployments/:id/tail` — proxies WebSocket upgrade to the tail worker's `LogStream` DO via service binding.
4. **Admin UI**: Update `deployment-logs.tsx` with historical log table + live tail WebSocket toggle.

### Wrangler configs

**`platform/packages/tail/wrangler.jsonc`:**

- Analytics engine dataset: `void_logs` (staging: `void_logs_staging`)
- Durable object: `LogStream` class
- No routes — accessed only via service binding and `tail_consumers`

**`platform/packages/dispatch/wrangler.jsonc`:**

- Add `tail_consumers: [{ "service": "void-tail" }]`
- Staging: `tail_consumers: [{ "service": "void-tail-staging" }]`

**`platform/packages/api/wrangler.jsonc`:**

- Add `TAIL` service binding to `void-tail`

## Non-goals

- User-facing log dashboard (future scope)
- Log level filtering at the tail worker level (all events are captured; filtering happens at query time)
- Custom retention beyond AE's 90-day default
