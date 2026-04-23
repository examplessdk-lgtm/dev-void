import { cfAccessHeaders } from '../shared/cf-access';
import {
  PROVIDER_KEY_MAP,
  type ThirdPartyModel,
  type ChatCompletionInputs,
  type ChatCompletionResponse,
} from './ai-types';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw';

const PROXY_URL = 'https://proxy.void.cloud/ai';
const STAGING_PROXY_URL = 'https://proxy.staging.void.cloud/ai';

interface AiBackend {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
  models(params?: unknown): Promise<unknown>;
  toMarkdown(items: unknown, options?: unknown): Promise<unknown>;
}

function hasStreamFlag(value: unknown): value is { stream?: boolean } {
  return typeof value === 'object' && value !== null && 'stream' in value;
}

function isThirdPartyModel(model: string): boolean {
  const provider = model.split('/')[0];
  return provider in PROVIDER_KEY_MAP;
}

function resolveProviderKey(model: string, runtimeEnv: RuntimeEnv): string {
  const provider = model.split('/')[0];
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) {
    throw new Error(
      `Unknown AI provider: "${provider}". Supported: ${Object.keys(PROVIDER_KEY_MAP).join(', ')}`,
    );
  }
  const key = runtimeEnv[envVar];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `Missing ${envVar} secret. Add it as a project secret for provider "${provider}".`,
    );
  }
  return key;
}

function getProxyUrl(runtimeEnv: RuntimeEnv): string {
  const custom = runtimeEnv.__VOID_PROXY_URL;
  if (typeof custom === 'string' && custom.length > 0) {
    return custom + '/ai';
  }
  return runtimeEnv.__VOID_STAGING ? STAGING_PROXY_URL : PROXY_URL;
}

function resolveBackend(): AiBackend {
  const runtimeEnv = getRawRuntimeEnv();

  // Priority 1: Service binding (production via Void)
  const proxy = runtimeEnv.__VOID_PROXY as Fetcher | undefined;
  if (proxy) {
    return makeServiceBindingBackend(proxy, runtimeEnv);
  }

  // Priority 2: HTTPS to our proxy (local dev with Void auth)
  const token = runtimeEnv.__VOID_TOKEN;
  const projectId = runtimeEnv.__VOID_PROJECT_ID;
  if (typeof token === 'string' && typeof projectId === 'string') {
    return makeHttpBackend(token, projectId, runtimeEnv);
  }

  // Priority 3: Direct AI binding (user's own CF account)
  const directAi = runtimeEnv.AI as Ai | undefined;
  if (directAi) {
    return {
      run: directAi.run.bind(directAi),
      models: directAi.models.bind(directAi),
      toMarkdown: directAi.toMarkdown?.bind(directAi) ?? unsupported('toMarkdown'),
    };
  }

  throw new Error(
    'AI not available. Run `void auth login` and `void project link` to get started.',
  );
}

function unsupported(method: string): () => never {
  return () => {
    throw new Error(`ai.${method}() is not supported in this environment`);
  };
}

function makeServiceBindingBackend(proxy: Fetcher, runtimeEnv: RuntimeEnv): AiBackend {
  async function proxyFetch(action: string, body: Record<string, unknown>): Promise<Response> {
    const res = await proxy.fetch(`https://ai-proxy/ai/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI proxy error: ${res.status} ${text}`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;

      if (isThirdPartyModel(model as string)) {
        const providerKey = resolveProviderKey(model as string, runtimeEnv);
        const res = await proxyFetch('gateway', { model, inputs, providerKey, projectId, aiToken });
        if (hasStreamFlag(inputs) && inputs.stream) {
          return res.body;
        }
        return res.json();
      }

      const res = await proxyFetch('run', { model, inputs, options, projectId, aiToken });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return res.json();
    },
    async models(params) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;
      const res = await proxyFetch('models', { inputs: params, projectId, aiToken });
      return res.json();
    },
    async toMarkdown(items, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;
      const res = await proxyFetch('toMarkdown', { inputs: items, options, projectId, aiToken });
      return res.json();
    },
  };
}

function makeHttpBackend(token: string, projectId: string, runtimeEnv: RuntimeEnv): AiBackend {
  const base = getProxyUrl(runtimeEnv);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...cfAccessHeaders(runtimeEnv.CF_ACCESS_CLIENT_ID, runtimeEnv.CF_ACCESS_CLIENT_SECRET),
  };

  async function proxyFetch(action: string, body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...body, projectId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI proxy error: ${res.status} ${text}`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      if (isThirdPartyModel(model as string)) {
        const providerKey = resolveProviderKey(model as string, runtimeEnv);
        const res = await proxyFetch('gateway', { model, inputs, providerKey });
        if (hasStreamFlag(inputs) && inputs.stream) {
          return res.body;
        }
        return res.json();
      }

      const res = await proxyFetch('run', { model, inputs, options });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return res.json();
    },
    async models(params) {
      const res = await proxyFetch('models', { inputs: params });
      return res.json();
    },
    async toMarkdown(items, options) {
      const res = await proxyFetch('toMarkdown', { inputs: items, options });
      return res.json();
    },
  };
}

// Lazy-init backend on first access
let _backend: AiBackend | undefined;
function backend(): AiBackend {
  return (_backend ??= resolveBackend());
}

/**
 * Extended AI interface with a convenience `stream()` method.
 *
 * `stream()` calls `ai.run()` with `stream: true` and wraps the result
 * in a `Response` with SSE headers — ready to return from a route handler.
 */
export interface VoidAi extends Omit<Ai, 'run'> {
  /** Workers AI inference (existing) */
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: AiModels[Name]['inputs'],
    options?: AiOptions,
  ): Promise<AiModels[Name]['postProcessedOutputs']>;

  /** Third-party chat completions (OpenAI, Anthropic, etc.) */
  run(
    model: ThirdPartyModel,
    inputs: ChatCompletionInputs,
    options?: AiOptions,
  ): Promise<ChatCompletionResponse>;

  /** Stream Workers AI response as SSE */
  stream<Name extends keyof AiModels>(
    model: Name,
    inputs: Omit<AiModels[Name]['inputs'], 'stream'>,
    options?: AiOptions,
  ): Promise<Response>;

  /** Stream third-party chat completions as SSE */
  stream(
    model: ThirdPartyModel,
    inputs: Omit<ChatCompletionInputs, 'stream'>,
    options?: AiOptions,
  ): Promise<Response>;
}

export const ai: VoidAi = new Proxy({} as VoidAi, {
  get(_, prop) {
    if (prop === 'stream') {
      return async (model: string, inputs: Record<string, unknown>, options?: unknown) => {
        const body = await backend().run(model, { ...inputs, stream: true }, options);
        return new Response(body as ReadableStream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      };
    }
    if (prop === 'run') {
      return backend().run;
    }
    if (prop === 'models') {
      return backend().models;
    }
    if (prop === 'toMarkdown') {
      return backend().toMarkdown;
    }
    return undefined;
  },
});

export type {
  ThirdPartyModel,
  ThirdPartyProvider,
  ChatCompletionInputs,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionUsage,
  ChatCompletionChunk,
  ChatMessage,
} from './ai-types';
