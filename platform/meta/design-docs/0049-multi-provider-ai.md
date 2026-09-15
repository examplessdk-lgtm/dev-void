# Multi-Provider AI (BYOK)

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-03-03
**Status:** Implemented

---

## Summary

Extend the existing `void/ai` module to support third-party AI providers (OpenAI, Anthropic, Google, Groq, etc.) via a **Bring Your Own Key (BYOK)** model. Users store their provider API keys as project secrets and call `ai.run("openai/gpt-4o", { messages: [...] })` — the same `ai.run()` function that already handles Workers AI.

Under the hood, third-party requests route through the **same proxy worker** and **CF AI Gateway** that Workers AI uses today. This gives us metering, cost tracking, and usage limits for free — no new billing infrastructure needed.

## Motivation

Workers AI offers a limited set of open-source models. Users want access to GPT-4o, Claude, Gemini, etc. without leaving the Void DX. Rather than providing API keys or managing billing, Void should let users bring their own provider keys and use them through the same unified `ai.run()` interface.

## Design Principles

1. **Leverage CF AI Gateway** — it already supports multi-provider routing with an OpenAI-compatible `/compat/chat/completions` endpoint, cost tracking, and custom metadata.
2. **BYOK via project secrets** — no new key management infra. Users set `OPENAI_API_KEY` as a secret, framework reads it from env.
3. **Consistent dev/prod path** — both environments route through the proxy for uniform metering and usage limits.
4. **Proper TypeScript inference** — model string prefix drives overload selection, giving users correct input/output types.

## Architecture

### Request Flow

```
User Worker
  │  ai.run("openai/gpt-4o", { messages: [...] })
  │
  ├─ Framework detects "openai/" prefix (not "@cf/")
  ├─ Reads env.OPENAI_API_KEY (convention-based)
  │
  └─ Service binding / HTTPS → Void Proxy
       body: {
         action: "chat",
         model: "openai/gpt-4o",
         inputs: { messages: [...], temperature: 0.7 },
         projectId, aiToken, providerKey
       }
       │
       Proxy Worker
       ├─ Validate auth (HMAC or JWT, existing)
       ├─ Check usage limits (existing KV lookup)
       │
       └─ POST CF AI Gateway /compat/chat/completions
            headers:
              Authorization: Bearer <providerKey>     ← user's key
              cf-aig-authorization: Bearer <CF_TOKEN>  ← gateway auth
            body:
              { model: "openai/gpt-4o", messages: [...], stream: bool }
            gateway metadata: { projectId }            ← for metering
```

### Workers AI Path (Unchanged)

```
ai.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "..." })
  └─ Proxy → env.AI.run() with gateway: { id: "void", metadata: { projectId } }
```

The existing Workers AI path is completely unchanged. The `@cf/` prefix triggers the current behavior.

### Local Dev Path

Same as production but over HTTPS instead of service binding:

```
Local Worker → HTTPS POST proxy.platform.example.net/ai/chat
  headers: { Authorization: "Bearer <JWT>" }
  body: { action: "chat", model, inputs, projectId, providerKey }
```

Consistent metering in dev. Users who want zero-latency direct calls can always use native SDKs as an escape hatch.

## User-Facing API

### Basic Usage

```ts
import { ai } from 'void/ai';

// Workers AI (existing, unchanged)
const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
  prompt: 'Hello',
});

// OpenAI
const result = await ai.run('openai/gpt-4o', {
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0.7,
});

// Anthropic
const result = await ai.run('anthropic/claude-sonnet-4-20250514', {
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 1024,
});

// Streaming
const stream = ai.stream('openai/gpt-4o', {
  messages: [{ role: 'user', content: 'Hello' }],
});
for await (const chunk of stream) {
  console.log(chunk.choices[0].delta.content);
}
```

### API Key Convention

The framework resolves API keys from env vars based on provider prefix:

| Model prefix         | Env var             |
| -------------------- | ------------------- |
| `openai/*`           | `OPENAI_API_KEY`    |
| `anthropic/*`        | `ANTHROPIC_API_KEY` |
| `google-ai-studio/*` | `GOOGLE_API_KEY`    |
| `groq/*`             | `GROQ_API_KEY`      |
| `mistral/*`          | `MISTRAL_API_KEY`   |
| `grok/*`             | `GROK_API_KEY`      |

Users set these as project secrets. They get injected as env bindings at deploy time (existing secrets infra).

## Types

```ts
// Provider detection via template literal types
type WorkersAiModel = `@cf/${string}`;
type ThirdPartyModel =
  | `openai/${string}`
  | `anthropic/${string}`
  | `google-ai-studio/${string}`
  | `groq/${string}`
  | `mistral/${string}`
  | `grok/${string}`;

// Overloaded ai.run()
type VoidAi = {
  // Workers AI — existing CF Workers AI types
  run<M extends WorkersAiModel>(
    model: M,
    inputs: WorkersAiInputs<M>,
    options?: AiRunOptions,
  ): Promise<WorkersAiResponse<M>>;

  // Third-party — OpenAI chat completions format
  run(
    model: ThirdPartyModel,
    inputs: ChatCompletionInputs,
    options?: AiRunOptions,
  ): Promise<ChatCompletionResponse>;

  // Streaming
  stream<M extends WorkersAiModel>(model: M, inputs: WorkersAiInputs<M>): AsyncIterable<string>;
  stream(model: ThirdPartyModel, inputs: ChatCompletionInputs): AsyncIterable<ChatCompletionChunk>;

  // Workers AI only (unchanged)
  models(params?: AiModelsParams): Promise<AiModelsResponse>;
  toMarkdown(items: AiToMarkdownInput[], options?: AiOptions): Promise<string>;
};

// OpenAI-compatible types
type ChatCompletionInputs = {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatCompletionResponse = {
  id: string;
  choices: { index: number; message: ChatMessage; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

type ChatCompletionChunk = {
  choices: {
    index: number;
    delta: { content?: string; role?: string };
    finish_reason: string | null;
  }[];
};
```

## Proxy Changes

### New Endpoint: `/ai/chat`

```ts
// platform/packages/proxy/src/ai.ts

ai.post('/chat', async (c) => {
  const body = c.get('body');
  const projectId = c.get('projectId');

  const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${c.env.CF_ACCOUNT_ID}/void/compat/chat/completions`;

  const payload: Record<string, unknown> = {
    model: body.model,
    messages: body.inputs.messages,
    ...body.inputs, // temperature, max_tokens, etc.
  };
  delete payload.messages; // avoid duplication — spread puts it back
  // Actually, spread inputs which contains messages + other params
  // Just forward inputs as-is since it's already OpenAI-compatible

  const isStream = body.inputs.stream === true;
  if (isStream) payload.stream = true;

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.providerKey}`,
      'cf-aig-authorization': `Bearer ${c.env.CF_AIG_TOKEN}`,
      'cf-aig-metadata-projectId': projectId,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    return c.json({ error: `provider error: ${error}` }, response.status as StatusCode);
  }

  if (isStream && response.body) {
    return new Response(response.body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const result = await response.json();
  return c.json(result);
});
```

### Auth Middleware

No changes needed. The existing middleware already:

1. Parses JSON body
2. Validates HMAC (service binding) or JWT (HTTPS)
3. Sets `projectId` on context
4. Checks `/ai/*` routes against `ai-block:{projectId}` KV key

The new `/ai/chat` route falls under `/ai/*` automatically.

### New Env Binding

The proxy needs a `CF_AIG_TOKEN` secret for authenticating with AI Gateway. This is a Cloudflare API token with AI Gateway permissions — separate from the provider's API key.

## Metering & Billing

**No changes required.** The existing metering system queries AI Gateway's GraphQL API:

```graphql
query {
  viewer {
    accounts(filter: { accountTag: "$ACCOUNT_ID" }) {
      aiGatewayRequests(
        filter: {
          gatewayId: "void"
          metadata_projectId: "$PROJECT_ID"
          datetime_geq: "$BILLING_START"
        }
      ) {
        sum {
          cost
        }
      }
    }
  }
}
```

AI Gateway tracks costs across all providers (Workers AI, OpenAI, Anthropic, etc.), so this query automatically includes third-party AI costs. The neuron conversion (`cost / $0.000011`) continues to work.

## Framework Changes

### `packages/void/src/runtime/ai.ts`

1. **Provider detection**: Parse model string prefix to determine path.
2. **API key resolution**: Read `env.{PROVIDER}_API_KEY` based on prefix mapping.
3. **New `"chat"` action**: Send to proxy with `providerKey` in body.
4. **Response handling**: Parse OpenAI-compatible response for chat action.

### Binding Inference

No changes to binding inference (`walk.ts`). The `ai` import detection already works — the proxy binding is always injected regardless of which providers the user calls.

### Deploy Manifest

No changes. The `manifest.bindings.ai: boolean` flag already triggers proxy binding injection. Third-party provider keys come from secrets (separate system).

## What Changes Where

| Component                                 | Change                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `packages/void/src/runtime/ai.ts`         | Provider detection, API key resolution, `"chat"` action, type overloads |
| `packages/void/src/runtime/ai.ts` (types) | `ChatCompletionInputs`, `ChatCompletionResponse`, `ThirdPartyModel`     |
| `platform/packages/proxy/src/ai.ts`       | New `/ai/chat` endpoint → AI Gateway `/compat`                          |
| `platform/packages/proxy/src/types.ts`    | Add `CF_AIG_TOKEN` to `ProxyEnv`                                        |
| `platform/packages/proxy/wrangler.jsonc`  | Add `CF_AIG_TOKEN` secret                                               |
| `platform/packages/proxy/test/`           | Tests for `/ai/chat` endpoint                                           |
| Docs                                      | Supported providers, API key conventions, examples                      |

## Non-Goals (v1)

- **No dedicated AI keys UI** — use project secrets
- **No Void-hosted API keys** — users bring their own
- **No embeddings endpoint** — AI Gateway's unified API is chat-only (embeddings coming)
- **No fallback/routing between providers** — AI Gateway supports this, defer to v2
- **No response normalization** — pass through AI Gateway's response as-is
- **No provider-specific features** — tool calling, function calling, vision, etc. only if AI Gateway's `/compat` endpoint supports them (it does for most)

## Open Questions

1. **CF_AIG_TOKEN provisioning** — need to create an AI Gateway token with appropriate scopes. Verify this works with the existing `void` gateway.
2. **Streaming format** — AI Gateway's `/compat` endpoint returns standard OpenAI SSE format. Verify it works for all providers (Anthropic has a different native streaming format, but `/compat` normalizes it).
3. **Error messages** — when a provider rejects the API key, the error comes from AI Gateway. Need to surface provider-specific errors cleanly.
4. **Rate limits** — providers have their own rate limits. AI Gateway may return 429 from upstream. Need to distinguish from Void's usage limit 429.
