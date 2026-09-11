# @voidcloud/proxy

Shared proxy worker for platform-owned capabilities: AI metering, ISR revalidation, and remote D1/KV/R2 access.

## Architecture

- **AI traffic** goes through AI Gateway so usage cannot bypass platform metering.
- **ISR revalidation** forwards to the API worker over a service binding.
- **Remote bindings** try the deployed user worker first via `DISPATCH` and its `/__void/*` endpoints, then fall back to Cloudflare REST APIs for older deployments.
- **Resource resolution** happens through internal API endpoints, not direct DB reads inside the proxy.

```text
Deployed user worker            Proxy                       Downstream
┌────────────────────┐         ┌────────────────────┐      ┌────────────────────┐
│ ai.run()           │────────▶│ /ai/*              │─────▶│ AI Gateway / AI    │
│ revalidate()       │────────▶│ /revalidate        │─────▶│ void-api           │
│ remote D1/KV/R2    │────────▶│ /d1/* /kv/* /r2/*  │─────▶│ user worker / CF   │
└────────────────────┘         └────────────────────┘      └────────────────────┘
```

## Authentication

Two auth paths are supported:

| Path            | When               | Auth                                      |
| --------------- | ------------------ | ----------------------------------------- |
| Service binding | Deployed Void apps | HMAC-signed `projectId` token (`aiToken`) |
| HTTPS           | Local development  | `Authorization: Bearer <jwt>`             |

All routes require `projectId` in the JSON body.

## Endpoints

### AI

| Endpoint              | Body                                                                             | Notes                           |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| `POST /ai/run`        | `{ model, inputs?, options?, projectId, aiToken? }`                              | Cloudflare AI binding inference |
| `POST /ai/provider`   | `{ provider, path, method?, headers?, body?, providerKey, projectId, aiToken? }` | Provider-native AI Gateway call |
| `POST /ai/models`     | `{ inputs?, projectId, aiToken? }`                                               | List models                     |
| `POST /ai/toMarkdown` | `{ inputs, options?, projectId, aiToken? }`                                      | `AI.toMarkdown()` passthrough   |

`/ai/*` also checks `ROUTING` for `ai-block:{projectId}` before forwarding.

`/ai/provider` forwards to `AI.gateway("void").getUrl(provider)` plus the relative `path`. JSON, text, binary, and multipart bodies are serialized by the SDK and reconstructed before forwarding. OpenAI-style providers default to `Authorization: Bearer <providerKey>`; Google AI Studio uses `x-goog-api-key`. Non-JSON responses are returned without JSON coercion so provider-native binary and streaming responses can pass through.

### Remote bindings

| Endpoint                                            | Purpose             |
| --------------------------------------------------- | ------------------- |
| `POST /d1/query`                                    | Query a D1 binding  |
| `POST /d1/batch`                                    | Batch D1 statements |
| `POST /kv/get` / `put` / `delete` / `list`          | KV access           |
| `POST /r2/get` / `put` / `delete` / `list` / `head` | R2 access           |

The remote-binding path is:

1. resolve the active worker or resource via internal API
2. try the deployed worker's native binding handler through `DISPATCH`
3. fall back to the Cloudflare REST API if the worker does not support `/__void/*`

### ISR revalidation

| Endpoint           | Body                                                      |
| ------------------ | --------------------------------------------------------- |
| `POST /revalidate` | `{ paths?: string[], all?: boolean, projectId, aiToken }` |

The proxy forwards the request to `API.fetch("https://api/internal/revalidate/:projectId")` with `x-void-internal`.

### Health

`GET /health` returns binding presence for `ai`, `kv`, `jwt`, and `api`.

## Source Layout

```text
src/
  index.ts        # Hono app, CORS, auth middleware, route mounting
  ai.ts           # Workers AI + AI Gateway endpoints
  revalidate.ts   # ISR revalidation forwarding to API
  dispatch.ts     # Dispatch-to-user-worker fast path for remote bindings
  resolve.ts      # Internal API resource resolution + in-memory cache
  d1.ts           # D1 remote access
  kv.ts           # KV remote access
  r2.ts           # R2 remote access
  types.ts        # Env and JWT types
test/unit/
  proxy.test.ts
  dispatch.test.ts
  resolve.test.ts
  d1.test.ts
  kv.test.ts
  r2.test.ts
```

## Bindings

| Binding         | Type               | Purpose                                                |
| --------------- | ------------------ | ------------------------------------------------------ |
| `AI`            | Workers AI         | Real inference binding                                 |
| `API`           | Service binding    | Internal API calls (`revalidate`, resource resolution) |
| `DISPATCH`      | Dispatch namespace | Fast path to deployed user workers                     |
| `ROUTING`       | KV                 | AI limit flags                                         |
| `JWT_SECRET`    | Secret             | HMAC/JWT verification                                  |
| `CF_ACCOUNT_ID` | Secret             | Cloudflare account ID                                  |
| `CF_API_TOKEN`  | Secret             | Fallback REST API access                               |

## Deploy

```bash
vp run --filter @voidcloud/proxy deploy --env production
vp run --filter @voidcloud/proxy deploy --env staging
```

Deployed as part of the root `vp run deploy` and `vp run deploy:staging` scripts.

## Tests

- `test/unit/proxy.test.ts` — auth, CORS, AI routes, revalidation
- `test/unit/dispatch.test.ts` — dispatch fast path and fallback behavior
- `test/unit/resolve.test.ts` — internal resource resolution cache
- `test/unit/d1.test.ts` — D1 query and batch behavior
- `test/unit/kv.test.ts` — KV operations
- `test/unit/r2.test.ts` — R2 operations
