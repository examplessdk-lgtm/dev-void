# Workers AI

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-22
**Status:** Implemented

> **Note:** The standalone `ai-proxy` worker described in this doc has been consolidated into the unified `proxy` worker (`platform/packages/proxy`, deployed at `proxy.platform.example.net`). AI functionality is preserved; the proxy now also handles D1/KV/R2 remote bindings. See [0036-remote-bindings.md](./0036-remote-bindings.md).

---

## Summary

Add Workers AI as an inferred binding with a zero-config DX matching the existing D1/KV/R2 pattern. Users `import { ai } from "void/ai"` and get full type-safe access to Cloudflare's AI inference models — no Cloudflare account required, no wrangler config to write.

The core design challenge is **metering**: Cloudflare charges us (the platform account) for all AI inference across Workers for Platforms. We must track per-project usage for billing and prevent users from bypassing metering by modifying their deployed worker code.

The solution: user workers never receive the `AI` binding directly. All inference is routed through a **proxy worker we control**, which injects **AI Gateway** configuration for tamper-proof logging, token counting, cost tracking, and caching.

## User-Facing API

### Server — `void/ai`

```ts
import { ai } from 'void/ai';

// Text generation
const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
  messages: [{ role: 'user', content: 'Hello' }],
});

// Embeddings
const embeddings = await ai.run('@cf/baai/bge-base-en-v1.5', {
  text: ['search query'],
});

// Document conversion
const md = await ai.toMarkdown({ name: 'doc.pdf', blob });

// List models
const models = await ai.models();
```

Full `Ai` type from `@cloudflare/workers-types` — all model names, inputs, and outputs are type-checked. No custom wrapper types to learn.

### Server — `ai.stream()` convenience

Streaming text to the client over SSE is the most common AI-in-web pattern. Without the helper:

```ts
export const POST = defineHandler(async (c) => {
  const stream = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [...],
    stream: true,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
});
```

With the helper:

```ts
export const POST = defineHandler(async (c) => {
  const { messages } = c.req.valid('json');
  return ai.stream('@cf/meta/llama-3.1-8b-instruct', { messages });
});
```

`ai.stream(model, inputs, options?)` calls `ai.run()` with `stream: true` and wraps the result in a `Response` with SSE headers. Returns `Promise<Response>`, ready to return from a handler.

### Server — Direct `c.env` access

Users can also access the binding through the Hono context:

```ts
export const POST = defineHandler(async (c) => {
  const result = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [...],
  });
  return c.json(result);
});
```

Note: in production, `c.env.AI` is not the raw Cloudflare binding — it's the proxied version. The proxy is transparent; the API surface is identical.

### Client — `fetchStream()`

General-purpose SSE stream consumer for the typed fetch client. Not AI-specific — works with any route that returns SSE.

```ts
import { fetchStream } from 'void/client';

const stream = fetchStream('/api/ai/chat', {
  method: 'POST',
  body: { messages: [{ role: 'user', content: 'Hello' }] },
});

for await (const chunk of stream) {
  output += chunk;
  setOutput(output);
}
```

`fetchStream` returns an `AsyncGenerator<string>` that parses SSE `data:` frames, yields text chunks, and terminates on `[DONE]`.

### Full-stack example

Server route (`routes/ai/chat.ts`):

```ts
import { ai } from 'void/ai';
import { defineHandler } from 'void';
import * as v from 'valibot';

export const POST = defineHandler
  .withValidator({
    body: v.object({
      messages: v.array(
        v.object({
          role: v.picklist(['user', 'assistant', 'system']),
          content: v.string(),
        }),
      ),
    }),
  })
  .handler(async (c) => {
    const { messages } = c.req.valid('json');
    return ai.stream('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages],
    });
  });
```

Client (`src/components/Chat.tsx`):

```tsx
import { fetchStream } from 'void/client';
import { useState } from 'react';

function Chat() {
  const [output, setOutput] = useState('');

  async function send(message: string) {
    setOutput('');
    const stream = fetchStream('/api/ai/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: message }] },
    });
    for await (const chunk of stream) {
      setOutput((prev) => prev + chunk);
    }
  }

  return <div>{output}</div>;
}
```

### What we intentionally don't wrap

- **No `ai.chat()` / `ai.embed()` / `ai.generate()` method aliases.** These are model-category-specific and narrow. `ai.run()` handles all model types with full type inference.
- **No model name aliases.** The `@cf/vendor/model` naming is Cloudflare's convention; users should learn it once.
- **No `createAi()` factory.** Only one AI binding per worker.
- **No AI-specific client hooks.** `fetchStream()` is general-purpose. Framework-specific hooks (React `useStream`, Vue composables) are out of scope for v1.

## Architecture

### The metering problem

Cloudflare charges the operator's platform account for all AI inference across Workers for Platforms. If we put the `AI` binding directly on user workers, a user could modify their deployed bundle to:

- Strip metering code
- Call `env.AI.run()` directly without going through our wrapper
- Use AI without any usage being tracked

We cannot trust any code that runs inside the user worker sandbox.

### Solution: Service binding proxy + AI Gateway

```
User worker                 AI Proxy (our code)          AI Gateway           CF Inference
┌─────────────┐  service  ┌──────────────────┐  gateway ┌────────────┐      ┌───────────┐
│ ai.run()    │──binding─▶│ inject gateway   │────────▶│ log tokens │─────▶│ Workers   │
│             │           │ config + project │         │ track cost │      │ AI        │
│ no AI bind  │           │ metadata         │         │ cache hits │      │           │
└─────────────┘           └──────────────────┘         └────────────┘      └───────────┘
      ▲                          ▲                           │
      │                          │                           ▼
  user code                  our code                   Platform queries
  (untrusted)                (trusted)                  GraphQL for billing
```

**Trust chain:** User worker → service binding (can't redirect) → our proxy (injects gateway config) → AI Gateway (logs everything) → inference. No user-modifiable code is in the metering path.

### AI Gateway benefits

AI Gateway gives us capabilities that would be expensive to build ourselves:

| Capability          | What it does for us                                                       |
| ------------------- | ------------------------------------------------------------------------- |
| **Token counting**  | Automatic per-request prompt/completion token counts                      |
| **Cost tracking**   | Per-request cost calculation based on model pricing                       |
| **Custom metadata** | Tag every request with `projectId` — queryable via GraphQL                |
| **Caching**         | Identical prompts served from cache — directly reduces our inference bill |
| **Rate limiting**   | Built-in per-gateway rate limiting                                        |
| **Logging**         | Full request/response logs with Logpush to external storage               |
| **Analytics**       | Dashboard + GraphQL API for requests, tokens, costs, errors               |

We provision a single AI Gateway (`void`) at the account level. All projects share it. Per-project segmentation is via custom metadata, queryable through the GraphQL analytics API.

### The proxy worker

A standalone Cloudflare Worker deployed and managed by us. Holds the real `AI` binding and the AI Gateway configuration.

```ts
export default {
  async fetch(req: Request, env: { AI: Ai }): Promise<Response> {
    const { projectId, ... } = await authenticate(req, env);
    const { action, model, inputs, options } = await req.json();

    if (action === "run") {
      const result = await env.AI.run(model, inputs, {
        ...options,
        gateway: {
          id: "void",
          metadata: { projectId },
        },
      });

      if (inputs?.stream) {
        return new Response(result as ReadableStream, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(result);
    }

    if (action === "models") {
      return Response.json(await env.AI.models(inputs));
    }

    if (action === "toMarkdown") {
      return Response.json(await env.AI.toMarkdown(inputs, options));
    }

    return new Response("unknown action", { status: 400 });
  },
};
```

The proxy authenticates requests differently based on source:

- **Service binding (production):** Trusted. Project ID comes from `__PROJECT_ID` plain text binding on the user worker, passed in the request body.
- **HTTPS (local dev):** Validates the Void auth token from the `Authorization` header. Resolves project ID from the token's session.

### Local dev flow

The existing inferred bindings (D1, KV, R2) work offline because miniflare emulates them locally. AI has no local emulation — inference requires remote access to Cloudflare's GPU fleet.

Rather than requiring users to have a Cloudflare account and configure `wrangler login`, local dev routes through the same proxy via HTTPS:

```
pnpm dev
  │
  ▼
void plugin detects `import { ai }`
  │
  ▼
Reads credentials from the authenticated Void CLI session
  │
  ▼
Injects __VOID_TOKEN and __VOID_PROJECT_ID as env vars
  │
  ▼
ai.run() → HTTPS POST to ai-proxy.apps.example.com
  │         (with Bearer token auth)
  ▼
Proxy → AI Gateway → CF Inference
```

**No Cloudflare account needed.** The user authenticates with Void (which they already need for deploys). AI usage during dev is billed through Void, same as production.

The HTTPS overhead (vs. service binding) is negligible compared to AI inference latency (100ms–10s).

### Runtime detection order

The `void/ai` runtime module detects the environment and routes accordingly:

```ts
function resolveBackend(): AiBackend {
  const proxy = (env as any).__AI_PROXY;
  if (proxy) return { type: 'service-binding', proxy };

  const directAi = (env as any).AI;
  if (directAi) return { type: 'direct', ai: directAi };

  const token = (env as any).__VOID_TOKEN;
  const projectId = (env as any).__VOID_PROJECT_ID;
  if (token) return { type: 'http', token, projectId };

  throw new Error(
    'AI not available. Run `void auth login` and link a project with `void projects link`.',
  );
}
```

| Priority | Backend         | When                                                     | Transport             |
| -------- | --------------- | -------------------------------------------------------- | --------------------- |
| 1        | Service binding | Production (deployed to Void)                            | Intra-CF, sub-ms      |
| 2        | Direct binding  | User has own CF account + manual `[ai]` in wrangler.json | Direct to CF API      |
| 3        | HTTPS proxy     | Local dev with Void auth                                 | HTTPS to proxy worker |
| 4        | Error           | No auth available                                        | Helpful error message |

Priority 2 is the escape hatch for power users who want to use their own CF account and skip our billing.

## Binding Inference

Follows the existing three-tier detection pattern in `src/inference/walk.ts`.

### Detection signals

**Tier 1 — `es-module-lexer` (fast path):**

| Import source | Flag             |
| ------------- | ---------------- |
| `void/ai`     | `needsAI = true` |

**Tier 2 — Regex gate:**

Extend `ENV_BINDING_RE` to match `env.AI`:

```ts
const ENV_BINDING_RE = /\benv\s*\.\s*(DB|KV|STORAGE|QUEUE_\w+|AI)\b/;
```

**Tier 3 — AST walk:**

Match `(*.env).AI` member expressions in the existing `MemberExpression` visitor.

### `InferredBindings`

```ts
export type InferredBindings = {
  needsD1: boolean;
  needsKV: boolean;
  needsR2: boolean;
  needsAuth: boolean;
  needsQueues: boolean;
  needsAI: boolean; // new
};
```

## Deploy-Time Wiring

### Deploy manifest

Add `ai` flag to the bindings schema:

```ts
type DeployManifest = {
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
    ai?: boolean; // new — boolean, not string[], since there's only one AI binding
  };
  // ...
};
```

### Platform provisioning

When `manifest.bindings.ai` is true, the platform adds two bindings to the user worker (instead of an `ai` binding):

```ts
if (manifest.bindings.ai) {
  workerBindings.push({
    type: 'service',
    name: '__AI_PROXY',
    service: 'void-ai-proxy',
  });
  workerBindings.push({
    type: 'plain_text',
    name: '__PROJECT_ID',
    text: projectId,
  });
}
```

The user worker gets `env.__AI_PROXY` (service binding) and `env.__PROJECT_ID` (string), never `env.AI`.

### Local dev — `mergeBindings()`

In the Vite plugin's `mergeBindings()`, AI is handled differently from other bindings:

```ts
if (needsAI) {
  // Don't add ai: { binding: "AI" } — user may not have CF auth
  // Inject Void credentials for HTTPS proxy path
  const credentials = readVoidCredentials(root);
  if (credentials) {
    resolved.vars = {
      ...resolved.vars,
      __VOID_TOKEN: credentials.token,
      __VOID_PROJECT_ID: credentials.projectId,
    };
  }
}
```

## Types

### `env.d.ts`

```ts
declare namespace Cloudflare {
  type Env = {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AI: Ai; // new
  };
}
```

### `CloudEnv.Bindings` (handler.ts)

Add `AI: Ai` so `c.env.AI` is typed in route handlers.

### No custom type generation

Unlike D1 (which generates `DbTables` from migrations) or queues (which generate `QueueMap` from consumer files), AI needs no custom type generation. The `Ai` type from `@cloudflare/workers-types` already has full model/input/output type maps. No `.void/ai.d.ts` file.

## Package Exports

Add `./ai` to `packages/void/package.json`:

```json
{
  "./ai": {
    "types": "./dist/runtime/ai.d.mts",
    "import": "./dist/runtime/ai.mjs"
  }
}
```

Add `fetchStream` to the existing `./client` export (new named export alongside `fetch`, `auth`).

## Platform Billing

### Querying AI Gateway analytics

The platform queries the AI Gateway GraphQL API for per-project usage, filtered by the `projectId` custom metadata:

```graphql
query {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      aiGatewayRequests(
        filter: {
          gatewayId: "void"
          metadata_projectId: $projectId
          datetime_geq: $periodStart
          datetime_leq: $periodEnd
        }
      ) {
        sum {
          requests
          totalTokens
          promptTokens
          completionTokens
          cost
        }
        dimensions {
          model
        }
      }
    }
  }
}
```

This gives us per-project, per-model breakdowns of requests, tokens, and cost — with zero custom metering infrastructure.

### Usage enforcement

Enforcement happens in the proxy worker — it can check usage against limits before forwarding to `env.AI.run()`. The proxy can cache the current period's usage count (from a KV lookup or an in-memory counter with periodic AE/GraphQL sync) to avoid per-request latency.

## Files to Change

### New files

| File                                        | Purpose                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| `packages/void/src/runtime/ai.ts`           | Runtime module — `ai` proxy, `ai.stream()`, backend detection |
| `packages/void/src/runtime/fetch-stream.ts` | `fetchStream()` SSE consumer for the client                   |
| `packages/ai-proxy/`                        | New package — the AI proxy worker                             |

### Modified files

| File                                                  | Change                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/void/src/inference/walk.ts`                 | Add `needsAI` to `InferredBindings`, detection in all 3 tiers              |
| `packages/void/src/index.ts`                          | Handle `needsAI` in `mergeBindings()` (inject credentials, not AI binding) |
| `packages/void/src/plugin-inference.ts`               | Add `bindings.ai` override support                                         |
| `packages/void/src/runtime/handler.ts`                | Add `AI: Ai` to `CloudEnv.Bindings`                                        |
| `packages/void/src/runtime/client.ts`                 | Re-export `fetchStream`                                                    |
| `packages/void/env.d.ts`                              | Add `AI: Ai` to `Cloudflare.Env`                                           |
| `packages/void/package.json`                          | Add `./ai` export                                                          |
| `packages/void/src/cli/types.ts`                      | Add `ai?: boolean` to `DeployManifest.bindings`                            |
| `packages/void/src/cli/package.ts`                    | Serialize `needsAI` into manifest                                          |
| `platform/packages/api/src/types.ts`                  | Add `ai?: boolean` to `DeployManifest.bindings`                            |
| `platform/packages/api/src/routes/deploy.ts`          | Add service binding + project ID when `ai` is true                         |
| `platform/packages/api/src/provisioning/provision.ts` | Handle `ai` binding type (service binding, not CF resource)                |

## Open Questions

1. **AI Gateway: one shared vs. one per project?** Starting with one shared gateway + metadata filtering is simpler. Per-project gateways would give cache isolation and independent rate limits, but add provisioning complexity. Revisit if shared cache causes issues.

2. **Proxy placement: standalone worker or path in dispatch?** Standalone is cleaner (separation of concerns, independent deploys). But dispatch already handles all user worker traffic and adding an `/ai` route would avoid a new worker to manage. Leaning standalone — AI proxy has different scaling characteristics than HTTP dispatch.

3. **`c.env.AI` in production**: In production, user workers don't have the real `AI` binding — only `__AI_PROXY`. For `c.env.AI` to work in route handlers, the worker entry point would need to synthesize an `AI`-like object on `env` from the proxy. Alternatively, only support the `import { ai }` pattern and document that `c.env.AI` is not available in production. The import pattern is the recommended DX anyway.

4. **Cache control**: AI Gateway caching is on by default. Users can pass `{ skipCache: true }` through `ai.run()` options to bypass it. Should we expose `cacheTtl` as well? Probably yes — pass through any gateway-compatible options.

5. **Error handling in proxy**: If the AI Gateway or inference service returns an error, the proxy should return a structured error response that the runtime can deserialize into a typed error (similar to `FetchError` in the client).
