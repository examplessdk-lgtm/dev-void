# Remote Bindings for Local Development

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-28
**Status:** Design

---

## Summary

Allow Void users to connect to their real remote D1, KV, and R2 resources during local development, enabling read-write access to production data from `vite dev`. A unified proxy worker (`proxy.platform.example.net`) mediates all remote binding access, authenticated via JWT. The Void plugin injects proxy-backed binding implementations when remote mode is active.

## Motivation

Local development currently uses Miniflare — D1 backed by SQLite, KV and R2 by filesystem. This is fast and offline-capable, but users can't work with real data. Common pain points:

- Debugging issues that only reproduce with production data
- Developing against realistic data shapes and volumes
- Testing migrations against a real D1 instance before deploying
- Iterating on KV/R2-dependent features without manual seeding

## Opt-In

Two mechanisms, checked by the plugin at dev server startup:

1. **`void.json`** — persistent per-project config:

   ```json
   { "remote": true }
   ```

2. **Environment variable** — one-off per session:
   ```
   VOID_REMOTE=1 vite dev
   ```

The env var overrides the config — `VOID_REMOTE=0` disables remote mode even if `void.json` says `true`. When neither is set, local dev uses Miniflare as usual.

**Prerequisites** (checked on startup, clear error if unmet):

- User must be logged in to the selected platform
- Project must be linked (`.void/project.json` exists)
- Project must have been deployed at least once (remote resources must exist)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  User's Machine                      │
│                                                      │
│   vite dev  (remote mode)                            │
│   ┌────────────────────────────────────────────┐    │
│   │ Vite Dev Server                             │    │
│   │  ├── Static assets (Vite)                   │    │
│   │  └── Proxy /api/* → workerd                 │    │
│   │                                             │    │
│   │ workerd (Miniflare)                         │    │
│   │  ├── User code (routes, middleware)          │    │
│   │  ├── env.DB  → ProxyD1Database  ──┐         │    │
│   │  ├── env.KV  → ProxyKVNamespace ──┼── HTTPS │    │
│   │  ├── env.STORAGE → ProxyR2Bucket ─┤         │    │
│   │  └── env.AI  → ProxyAI (existing) ┘         │    │
│   └──────────────────────┼─────────────────────┘    │
│                          │                           │
└──────────────────────────┼───────────────────────────┘
                           │ JWT-authenticated HTTPS
                           ▼
┌──────────────────────────────────────────────────────┐
│                 proxy.platform.example.net                      │
│  (Cloudflare Worker — consolidates ai-proxy)         │
│                                                       │
│  ├── POST /ai/run         → Workers AI (existing)    │
│  ├── POST /d1/query       → CF D1 REST API          │
│  ├── POST /d1/batch       → CF D1 REST API          │
│  ├── POST /kv/get         → CF KV REST API          │
│  ├── POST /kv/put         → CF KV REST API          │
│  ├── POST /kv/delete      → CF KV REST API          │
│  ├── POST /kv/list        → CF KV REST API          │
│  ├── POST /r2/get         → CF R2 REST API          │
│  ├── PUT  /r2/put         → CF R2 REST API          │
│  ├── POST /r2/delete      → CF R2 REST API          │
│  ├── POST /r2/list        → CF R2 REST API          │
│  └── POST /r2/head        → CF R2 REST API          │
│                                                       │
│  Auth: JWT (sub: projectId, login)                   │
│  Resolution: JWT → project → resources table → cf_id │
└──────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Unified proxy** — consolidates `ai-proxy` into a general `proxy` worker at `proxy.platform.example.net`. AI inference, D1, KV, and R2 all share one auth surface.
- **CF REST API backend** — the proxy forwards operations to Cloudflare's REST APIs. This avoids giving users any direct access to Void's CF account.
- **Entry-point wrapping** — proxy-backed bindings are injected by wrapping the worker's fetch handler, not by modifying Miniflare configuration. This ensures both `c.env.DB` and `void/db` hit the proxy.

### Why Not Miniflare Native Remote Bindings?

Cloudflare shipped native remote bindings (GA September 2025) where Miniflare proxies binding calls to real CF resources via an internal protocol. However, this requires authenticating to the CF account that owns the resources. Since deployed application resources live in the platform operator's Cloudflare account, we can't use this mechanism without either:

- Giving application developers API tokens to the operator's account (security risk)
- Reverse-engineering Miniflare's internal proxy protocol (undocumented, uses Cap'n Proto)

The Void proxy approach gives us full control over auth, scoping, and audit while keeping the user experience simple.

## Proxy Worker

### Rename and Consolidation

`packages/ai-proxy` is renamed to `platform/packages/proxy`. All existing AI inference functionality is preserved. New D1/KV/R2 proxy endpoints are added alongside.

```
platform/packages/proxy/
├── src/
│   ├── index.ts             (Hono router, auth middleware)
│   ├── ai.ts                (existing AI inference logic)
│   ├── d1.ts                (D1 proxy endpoints)
│   ├── kv.ts                (KV proxy endpoints)
│   ├── r2.ts                (R2 proxy endpoints)
│   └── resolve.ts           (resource ID resolution from platform DB)
├── wrangler.jsonc
└── package.json
```

### Authentication

Same JWT scheme the AI proxy already uses:

- Bearer token in `Authorization` header
- HS256 JWT with `{ sub: projectId, login, iat, exp }`
- Verified on every request via auth middleware

### Resource Resolution

The proxy maps `(projectId, bindingType, bindingName)` → `cf_id` using the platform DB's `resources` table. For V1, this is a direct D1 query per request. The lookup is a single indexed query:

```sql
SELECT cf_id FROM resources
WHERE project_id = ? AND type = ? AND binding_name = ?
```

Future optimization: KV cache with TTL for resource mappings.

### Endpoint Protocol

**D1:**

```
POST /d1/query
{
  "binding": "DB",
  "sql": "SELECT * FROM users WHERE id = ?",
  "params": [1],
  "method": "all" | "first" | "raw" | "run"
}

POST /d1/batch
{
  "binding": "DB",
  "statements": [
    { "sql": "INSERT INTO ...", "params": [...] },
    { "sql": "UPDATE ...", "params": [...] }
  ]
}
```

**KV:**

```
POST /kv/get     { "binding": "KV", "key": "foo", "type": "text" | "json" | "arrayBuffer" | "stream" }
POST /kv/put     { "binding": "KV", "key": "foo", "value": "bar", "expiration": 3600, "metadata": {} }
POST /kv/delete  { "binding": "KV", "key": "foo" }
POST /kv/list    { "binding": "KV", "prefix": "user:", "limit": 100, "cursor": "..." }
```

**R2:**

```
POST /r2/get     { "binding": "STORAGE", "key": "avatar.png" }
  → response body streamed, metadata in headers

PUT  /r2/put     key + metadata in headers, body streamed
  → streams request body to CF R2 API

POST /r2/delete  { "binding": "STORAGE", "key": "avatar.png" }
  or             { "binding": "STORAGE", "keys": ["a.png", "b.png"] }
POST /r2/list    { "binding": "STORAGE", "prefix": "uploads/", "limit": 100, "cursor": "..." }
POST /r2/head    { "binding": "STORAGE", "key": "avatar.png" }
```

R2 get/put use streaming — the proxy passes through request/response bodies without buffering.

## Local-Side Integration

### Plugin Changes

When remote mode is active, the plugin injects env vars instead of (or in addition to) local binding config:

```ts
// In mergeBindings(), when remote mode is active
vars.__VOID_PROXY_URL = 'https://proxy.platform.example.net';
vars.__VOID_TOKEN = credentials.token;
vars.__VOID_PROJECT_ID = credentials.projectId;
vars.__VOID_REMOTE = 'true';
```

Local Miniflare bindings are still created (workerd needs them to start), but they are overridden at runtime by the proxy-backed implementations.

### Entry-Point Wrapping

The generated worker entry (from the routing plugin's `compile.ts`) detects remote mode and replaces bindings:

```ts
export default {
  async fetch(request, env, ctx) {
    const resolvedEnv = env.__VOID_REMOTE ? createRemoteEnv(env) : env;

    return withRuntimeEnv(resolvedEnv, () => app.fetch(request, resolvedEnv, ctx));
  },
};
```

`createRemoteEnv(env)` returns a shallow copy of `env` where `DB`, `KV`, and `STORAGE` are replaced with `ProxyD1Database`, `ProxyKVNamespace`, and `ProxyR2Bucket` instances.

This covers both access patterns:

| Pattern                        | Resolution path                                                     | Hits proxy? |
| ------------------------------ | ------------------------------------------------------------------- | ----------- |
| `import { db } from "void/db"` | `getRuntimeEnv()` → `envContext.getStore()` → proxy-backed `env.DB` | Yes         |
| `c.env.DB` in defineHandler    | Hono receives `resolvedEnv` → proxy-backed `env.DB`                 | Yes         |

### Proxy-Backed Binding Implementations

Located in `packages/void/src/runtime/remote/`:

```
runtime/remote/
├── index.ts          (createRemoteEnv)
├── d1.ts             (ProxyD1Database, ProxyD1PreparedStatement)
├── kv.ts             (ProxyKVNamespace)
├── r2.ts             (ProxyR2Bucket)
└── client.ts         (shared HTTP client)
```

These classes implement the standard CF binding interfaces (`D1Database`, `KVNamespace`, `R2Bucket`) by translating each method call to an HTTP request to the proxy.

Key implementation detail: `D1PreparedStatement.prepare()` and `.bind()` are synchronous — they accumulate SQL and params locally. The HTTP call only happens when a terminal method (`.all()`, `.first()`, `.run()`, `.raw()`) is called. This matches real D1 behavior.

## UX

### Console Output (Remote Mode Active)

```
  VITE v8.0.0  ready in 312 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.5:5173/

  ⚡ Remote bindings active (my-project.apps.example.com)
     DB      → remote D1
     KV      → remote KV
     STORAGE → remote R2
```

### Error Handling

| Scenario            | Behavior                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Not logged in       | `✗ Remote bindings require authentication. Run void login first.`                                |
| No linked project   | `✗ Remote bindings require a linked project. Run void deploy first.`                             |
| No prior deployment | `✗ Remote bindings require at least one deployment. Run void deploy first.`                      |
| Expired token       | `✗ Remote binding auth expired. Restart dev server to re-authenticate.`                          |
| Proxy unreachable   | Runtime error in route handler: `Remote D1 query failed: proxy.platform.example.net unreachable` |

Proxy errors surface as runtime errors in the user's route handler — same behavior as if a real CF binding failed in production.

## R2 Future Optimizations

V1 routes all R2 operations (including large file uploads/downloads) through the proxy worker. This is sufficient for typical local dev but has known limitations:

- CF Workers have a 128MB memory limit; R2 objects can be up to 5GB
- Upload/download throughput is bottlenecked by the proxy worker's bandwidth
- Every byte passes through two hops (client → proxy → R2 and back)

### Optimization 1: Pre-Signed URLs for Get/Put

The proxy generates short-lived, scoped S3-compatible pre-signed URLs. The local R2 implementation fetches the URL from the proxy, then reads/writes R2 directly:

```
Local:  POST proxy.platform.example.net/r2/presign { key, operation: "get" | "put" }
Proxy:  → { url: "https://{account}.r2.cloudflarestorage.com/{key}?X-Amz-..." }
Local:  GET/PUT {presigned-url}  (direct to R2, no proxy hop)
```

Pre-signed URLs are time-limited (5 minutes) and scoped to a single key + operation. R2 supports S3-compatible pre-signed URLs natively.

### Optimization 2: Conditional Proxying by Size

Small objects (< 1MB) continue through the proxy for simplicity and lower latency (single round-trip). Large objects automatically switch to the pre-signed URL path. The proxy can determine size based on a `HEAD` check, or the client can signal expected size for uploads.

### Optimization 3: Multipart Upload Direct Path

`createMultipartUpload` / `uploadPart` / `completeMultipartUpload` are already multi-step APIs. Each step could use pre-signed URLs, keeping the proxy out of the data path entirely while still controlling auth at the session level.

### When to Implement

When users report slow R2 operations during local dev, or when proxy worker CPU/memory limits are hit. For typical local dev workflows (small assets, avatars, config files), V1's full-proxy approach should be fine.

## Configuration Schema Change

Add `remote` to `void.json`:

```json
{
  "$schema": "./node_modules/void/schema.json",
  "remote": true
}
```

Update `packages/void/schema.json` and `src/config.ts` accordingly. The `remote` field is `boolean`, defaults to `false`.
