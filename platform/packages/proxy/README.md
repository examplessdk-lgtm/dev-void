# @voidcloud/proxy

Shared proxy worker for platform-owned capabilities: AI metering, ISR revalidation, remote D1/KV/R2 access, and platform email (outbound sends and the inbound catch-all router).

## Architecture

- **AI traffic** goes through AI Gateway so usage cannot bypass platform metering.
- **ISR revalidation** forwards to the API worker over a service binding.
- **Remote bindings** try the deployed user worker first via `DISPATCH` and its `/__void/*` endpoints, then fall back to Cloudflare REST APIs for older deployments.
- **Resource resolution** happens through internal API endpoints, not direct DB reads inside the proxy.
- **Email** is centralized here: the proxy holds the account-level `send_email` binding and is the catch-all inbound router for the platform mail zone. User workers hold no mail binding, so per-project allowlists and quotas cannot be bypassed.

```text
Deployed user worker            Proxy                       Downstream
┌────────────────────┐         ┌────────────────────┐      ┌────────────────────┐
│ ai.run()           │────────▶│ /ai/*              │─────▶│ AI Gateway / AI    │
│ revalidate()       │────────▶│ /revalidate        │─────▶│ void-api           │
│ remote D1/KV/R2    │────────▶│ /d1/* /kv/* /r2/*  │─────▶│ user worker / CF   │
│ sendEmail()        │────────▶│ /email/send        │─────▶│ SEND_EMAIL (CF)    │
└────────────────────┘         └────────────────────┘      └────────────────────┘
         ▲                              ▲
         │  email(envelope) RPC         │  email() handler
         └──────────────────────────────┴───── CF Email Routing (inbound)
```

## Authentication

Two auth paths are supported:

| Path            | When               | Auth                                      |
| --------------- | ------------------ | ----------------------------------------- |
| Service binding | Deployed Void apps | HMAC-signed `projectId` token (`aiToken`) |
| HTTPS           | Local development  | `Authorization: Bearer <api-jwt>`         |
| HTTPS           | Managed prerender  | Five-minute, project-scoped prerender JWT |

All routes require `projectId` in the JSON body. Prerender JWTs are accepted only
when their signed project claim exactly matches that value; they are not valid
at deployment or project-management APIs.

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

### Email

| Endpoint                    | Body                                                                                    | Notes                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /email/send`          | `{ projectId, aiToken, from, recipients, mimeBase64, byteSize, requestId, fromDomain }` | Outbound send. Gate chain below; calls `SEND_EMAIL` once per allowed recipient and returns `SendEmailResult`-shaped JSON.                      |
| `POST /email/internal/send` | `{ platformToken, platformTimestamp, from, to, mimeBase64 }`                            | Platform-internal verification mail from the api worker. `from` is locked to `noreply@$EMAIL_SENDER_DOMAIN`. Not reachable from a user worker. |

Outbound gate chain, in order — the first failure short-circuits, and nothing before the counters burns quota:

```text
body shape ▸ EMAIL_SENDER_DOMAIN set ▸ SEND_EMAIL bound ▸ recipients ▸ MIME size
  ▸ email-slug:<projectId>        (pins `from` local-part to the project's slug)
  ▸ strict `from` regex           (<slug>[+tag]@$EMAIL_SENDER_DOMAIN, no CR/LF or display names)
  ▸ routing.suspended             (platform-wide; the marker dispatch answers with 429)
  ▸ email-suspended:<projectId>   (email-only kill-switch)
  ▸ email-allowlist:<projectId>   (per-project verified destinations)
  ▸ email-burst:<id>:<minute>     ▸ email-sent:<id>:<month>
  ▸ SEND_EMAIL.send() per recipient
```

`POST /email/internal/send` authenticates with an HMAC of
`<sentinel>.<unixSeconds>.<sha256(from|to|mimeBase64)>` under `JWT_SECRET` (sentinel auth plus
content binding, 5-minute skew window). Only the proxy and api hold `JWT_SECRET`. The reference
signer is `packages/api/src/email/send-verification.ts`; changing the format needs a coordinated
proxy + api deploy.

The worker also exports `email()` as the catch-all CF Email Routing handler for the mail zone
(`packages/proxy/src/email-router.ts`). Inbound parses `<slug>+<tag>` from the recipient, reads the
project's routing blob, and dispatches into the user worker over an `email(envelope)` RPC call —
`ForwardableEmailMessage` is not RPC-serializable, so the router sends an envelope and enacts the
returned `EmailAction[]` on the real message. Inbound honors `routing.suspended` and
`email-suspended:<projectId>` **before** dispatch, and passes the project's `routing.limits` into
`DISPATCH.get` exactly as the HTTP router does. Forward/reply actions returned by a handler run
through the same per-project allowlist and burst/monthly quotas as `/email/send` — CF Email Routing
destinations are account-wide, so per-project gating is the platform's security boundary.

Inbound requests are **not** metered today; only the `email-recv:<id>:<month>` delivery counter is
written.

#### Sender domain

The mail zone is configuration, not a constant: `EMAIL_SENDER_DOMAIN` (`mail.void.cloud` in
production, `mail.staging.void.cloud` in staging) is declared as a `vars` entry in **every**
`wrangler.jsonc` scope, since wrangler does not inherit `vars` — or `send_email` — into a named env
and deploys run `--env production`. Deployed user workers receive the same value as the
`__VOID_EMAIL_DOMAIN` plain-text binding so the framework builds its default `from` against the same
zone. There is no baked-in fallback: if the var is missing, both send endpoints fail closed with a
502 rather than sending on the production zone from a staging worker.

### Health

`GET /health` returns binding presence for `ai`, `kv`, `jwt`, `api`, `sendEmail`, and
`emailDomain`.

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
  email.ts        # Outbound /email/send + platform-internal /email/internal/send
  email-router.ts # Inbound CF Email Routing catch-all -> user worker email() RPC
  types.ts        # Env and JWT types
test/unit/
  proxy.test.ts
  dispatch.test.ts
  resolve.test.ts
  d1.test.ts
  kv.test.ts
  r2.test.ts
  email.test.ts
```

## Bindings

| Binding         | Type               | Purpose                                                |
| --------------- | ------------------ | ------------------------------------------------------ |
| `AI`            | Workers AI         | Real inference binding                                 |
| `API`           | Service binding    | Internal API calls (`revalidate`, resource resolution) |
| `DISPATCH`      | Dispatch namespace | Fast path to deployed user workers                     |
| `ROUTING`       | KV                 | AI limit flags, routing blobs, email allowlists/quotas |
| `SEND_EMAIL`    | send_email         | Account-level outbound mail                            |
| `JWT_SECRET`    | Secret             | HMAC/JWT verification                                  |
| `CF_ACCOUNT_ID` | Secret             | Cloudflare account ID                                  |
| `CF_API_TOKEN`  | Secret             | Fallback REST API access                               |

| Var                   | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `EMAIL_SENDER_DOMAIN` | Platform mail zone for this environment (no code default) |

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
- `test/unit/email.test.ts` — wrangler binding/var coverage per env, sender-domain threading, suspension gates, inbound dispatch limits
