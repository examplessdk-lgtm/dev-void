---
outline: deep
---

# AI

Void provides a typed AI client powered by Cloudflare's [AI Gateway](https://developers.cloudflare.com/ai-gateway/). It supports both [Workers AI](https://developers.cloudflare.com/workers-ai/) models and third-party providers such as OpenAI, Anthropic, and Google through bring-your-own-key credentials. Import `ai` from `void/ai` and run inference directly from your route handlers. Usage is metered through Void.

```ts
import { ai } from 'void/ai';
```

## Basic Usage

Call `ai.run()` with a model name and inputs. Model names and input types are fully typed from `@cloudflare/workers-types`.

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
  });

  return c.json(result);
});
```

You can use any model available on [Workers AI](https://developers.cloudflare.com/workers-ai/models/), including text generation, image classification, embeddings, translation, and more.

## Streaming

Use `ai.stream()` to get a streaming response with SSE headers that you can return directly from a route handler:

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  return ai.stream('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
  });
});
```

`ai.stream()` calls `ai.run()` with `stream: true` and wraps the result in a `Response` with `content-type: text/event-stream` and `cache-control: no-cache` headers.

## Listing Models

Use `ai.models()` to list available models:

```ts
const models = await ai.models();

// Filter by task
const textModels = await ai.models({ task: 'Text Generation' });
```

## Markdown Conversion

Use `ai.toMarkdown()` to convert documents to markdown:

```ts
const result = await ai.toMarkdown([{ name: 'document.pdf', blob: pdfBytes }]);
```

## Local Development

AI requires Void credentials for local development. Run `void auth login` and `void project link` (or follow the interactive setup during `vite dev`) to connect your project.

Once linked, credentials are injected automatically as worker bindings. You do not need to configure them by hand. All inference traffic goes through the Void AI proxy over HTTPS, so usage is tracked and metered the same way it is in production.

## Usage Limits

Workers AI usage is metered in [**neurons**](https://developers.cloudflare.com/workers-ai/platform/pricing/), which is Cloudflare's unit for inference cost. Usage resets at the start of each billing cycle.

| Plan | Included      | At limit                           |
| ---- | ------------- | ---------------------------------- |
| Free | 100,000/month | Blocked until billing cycle resets |
| Solo | 300,000/month | Overage billed                     |
| Pro  | 500,000/month | Overage billed                     |

On the **free tier**, AI requests return a `429` error once the limit is reached. On **paid tiers**, usage beyond the included allowance is tracked as overage on your monthly bill.

## Third-Party Providers (BYOK)

You can use models from OpenAI, Anthropic, Google, and other providers by passing a `provider/model` identifier. Bring your own API key, add it as a project secret, and Void handles the rest. Third-party inference is billed directly by the provider, and Void does not mark up API calls. Requests still route through AI Gateway so usage shows up on the dashboard.

### Usage

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  const result = await ai.run('openai/gpt-4o', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
  });

  return c.json(result);
});
```

The same `ai.run()` and `ai.stream()` methods work for both Workers AI and third-party models. The framework detects the provider from the model string and routes the request through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) automatically.

The options follow each provider's conventions. All third-party providers use the OpenAI-compatible chat completions format, including `messages`, `max_tokens`, and `temperature`. TypeScript narrows the input and return types based on the model string: Workers AI models get per-model typed inputs from `@cloudflare/workers-types`, while third-party models such as `"provider/model"` get `ChatCompletionInputs` and `ChatCompletionResponse`.

### Provider Key Convention

Each provider requires an API key set as a project secret. The env var name is automatically derived from the provider prefix:

| Provider prefix    | Env var               |
| ------------------ | --------------------- |
| `openai`           | `OPENAI_API_KEY`      |
| `anthropic`        | `ANTHROPIC_API_KEY`   |
| `google-ai-studio` | `GOOGLE_API_KEY`      |
| `deepseek`         | `DEEPSEEK_API_KEY`    |
| `groq`             | `GROQ_API_KEY`        |
| `mistral`          | `MISTRAL_API_KEY`     |
| `grok`             | `GROK_API_KEY`        |
| `openrouter`       | `OPENROUTER_API_KEY`  |
| `perplexity`       | `PERPLEXITY_API_KEY`  |
| `cohere`           | `COHERE_API_KEY`      |
| `cerebras`         | `CEREBRAS_API_KEY`    |
| `huggingface`      | `HUGGINGFACE_API_KEY` |
| `replicate`        | `REPLICATE_API_KEY`   |
| `baseten`          | `BASETEN_API_KEY`     |
| `cartesia`         | `CARTESIA_API_KEY`    |
| `deepgram`         | `DEEPGRAM_API_KEY`    |
| `elevenlabs`       | `ELEVENLABS_API_KEY`  |
| `fal`              | `FAL_API_KEY`         |
| `ideogram`         | `IDEOGRAM_API_KEY`    |
| `parallel`         | `PARALLEL_API_KEY`    |

All [AI Gateway providers](https://developers.cloudflare.com/ai-gateway/usage/providers/) that accept a Bearer API key are supported. Providers with non-standard auth (Amazon Bedrock, Azure OpenAI, Google Vertex) are not yet supported.

For production, add your API key as a project secret:

```bash
void secrets set OPENAI_API_KEY sk-...
```

For local development, add it to `.env.local` in your project root:

```
OPENAI_API_KEY=sk-...
```

If the key is missing at runtime, `ai.run()` throws a descriptive error telling you which env var to set.

### Streaming with Third-Party Models

`ai.stream()` works the same way. The response is always SSE regardless of provider:

```ts
export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  return ai.stream('anthropic/claude-sonnet-4-20250514', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
  });
});
```
