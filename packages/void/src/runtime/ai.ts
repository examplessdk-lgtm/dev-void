import { cfAccessHeaders } from '../shared/cf-access';
import {
  PROVIDER_KEY_MAP,
  type ThirdPartyModel,
  type ChatCompletionInputs,
  type ChatCompletionResponse,
  type ImageEditInputs,
  type ImageEditOptions,
  type ImageGenerationInputs,
  type ImageGenerationOptions,
} from './ai-types';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw';

const PROXY_URL = 'https://proxy.void.cloud/ai';
const STAGING_PROXY_URL = 'https://proxy.staging.void.cloud/ai';
const VOID_FILE_MARKER = '__voidFile';

interface SerializedFileInput {
  [VOID_FILE_MARKER]: true;
  data: string;
  name?: string;
  type?: string;
}

interface AiBackend {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
  image(model: string, inputs: unknown, options?: unknown): Promise<Response>;
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

function mediaTypeFromContentType(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }
  const [mediaType] = contentType.split(';', 1);
  const normalized = mediaType?.trim().toLowerCase();
  return normalized || null;
}

function isJsonMediaType(mediaType: string | null): boolean {
  if (mediaType === 'application/json') {
    return true;
  }
  const slash = mediaType?.indexOf('/') ?? -1;
  return Boolean(mediaType && slash >= 0 && mediaType.slice(slash + 1).endsWith('+json'));
}

async function readProxyResult(response: Response): Promise<unknown> {
  if (isJsonMediaType(mediaTypeFromContentType(response.headers.get('content-type')))) {
    return response.json();
  }
  return response.blob();
}

function hasResponseMethod(value: unknown): value is { response(): Response | Promise<Response> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'response' in value &&
    typeof (value as { response?: unknown }).response === 'function'
  );
}

function isBinaryView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function copyBinaryView(value: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function isFileLikeRecord(value: Record<string, unknown>): value is {
  data: string;
  name?: string;
  type?: string;
} {
  return (
    typeof value.data === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.type === undefined || typeof value.type === 'string')
  );
}

function fileNameFromBlob(value: Blob): string | undefined {
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

async function serializeProxyValue(
  value: unknown,
  serializeDataObjectAsFile = false,
): Promise<unknown> {
  if (value instanceof Blob) {
    return {
      [VOID_FILE_MARKER]: true,
      data: arrayBufferToBase64(await value.arrayBuffer()),
      name: fileNameFromBlob(value),
      type: value.type || undefined,
    } satisfies SerializedFileInput;
  }

  if (value instanceof ArrayBuffer) {
    return {
      [VOID_FILE_MARKER]: true,
      data: arrayBufferToBase64(value),
      type: 'application/octet-stream',
    } satisfies SerializedFileInput;
  }

  if (isBinaryView(value)) {
    return {
      [VOID_FILE_MARKER]: true,
      data: arrayBufferToBase64(copyBinaryView(value)),
      type: 'application/octet-stream',
    } satisfies SerializedFileInput;
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => serializeProxyValue(item, serializeDataObjectAsFile)));
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (serializeDataObjectAsFile && isFileLikeRecord(record)) {
      return {
        [VOID_FILE_MARKER]: true,
        data: record.data,
        name: record.name,
        type: record.type,
      } satisfies SerializedFileInput;
    }

    const serialized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(record)) {
      serialized[key] = await serializeProxyValue(nestedValue, key === 'image' || key === 'mask');
    }
    return serialized;
  }

  return value;
}

async function serializeImageInputs(inputs: unknown, endpoint: string): Promise<unknown> {
  return endpoint === 'images/edits' ? serializeProxyValue(inputs) : inputs;
}

async function responseFromResult(result: unknown): Promise<Response> {
  if (result instanceof Response) {
    return result;
  }
  if (hasResponseMethod(result)) {
    return result.response();
  }
  if (result instanceof Blob) {
    return new Response(result, {
      headers: result.type ? { 'content-type': result.type } : undefined,
    });
  }
  if (result instanceof ReadableStream) {
    return new Response(result, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (result instanceof ArrayBuffer) {
    return new Response(result, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (isBinaryView(result)) {
    return new Response(copyBinaryView(result), {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return Response.json(result);
}

function splitImageOptions(options: unknown): {
  endpoint: string;
  runOptions: Record<string, unknown> | undefined;
} {
  if (typeof options !== 'object' || options === null) {
    return { endpoint: 'images/generations', runOptions: undefined };
  }

  const { endpoint, ...runOptions } = options as Record<string, unknown>;
  return {
    endpoint: typeof endpoint === 'string' ? endpoint : 'images/generations',
    runOptions: Object.keys(runOptions).length > 0 ? runOptions : undefined,
  };
}

function resolveProviderKey(model: string, runtimeEnv: RuntimeEnv): string {
  const provider = model.split('/')[0];
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) {
    throw new Error(
      `ai: Unknown provider '${provider}'. Use one of: ${Object.keys(PROVIDER_KEY_MAP).join(', ')}.`,
    );
  }
  const key = runtimeEnv[envVar];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `ai: Missing ${envVar} secret. Add it as a project secret for provider '${provider}'.`,
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
      async image(model, inputs, options) {
        const { runOptions } = splitImageOptions(options);
        return responseFromResult(
          await directAi.run(model as keyof AiModels, inputs as never, runOptions as AiOptions),
        );
      },
      models: directAi.models.bind(directAi),
      toMarkdown: directAi.toMarkdown?.bind(directAi) ?? unsupported('toMarkdown'),
    };
  }

  throw new Error('ai: Not available. Run `void auth login` and `void project link` first.');
}

function unsupported(method: string): () => never {
  return () => {
    throw new Error(`ai: ai.${method}() is not supported in this environment.`);
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
      throw new Error(`ai: Proxy request failed with ${res.status}: '${text}'.`);
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
        return readProxyResult(res);
      }

      const res = await proxyFetch('run', { model, inputs, options, projectId, aiToken });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return readProxyResult(res);
    },
    async image(model, inputs, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;
      const { endpoint, runOptions } = splitImageOptions(options);

      if (isThirdPartyModel(model as string)) {
        const providerKey = resolveProviderKey(model as string, runtimeEnv);
        const proxyInputs = await serializeImageInputs(inputs, endpoint);
        return proxyFetch('gateway', {
          model,
          endpoint,
          inputs: proxyInputs,
          providerKey,
          projectId,
          aiToken,
        });
      }

      return proxyFetch('run', { model, inputs, options: runOptions, projectId, aiToken });
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
    ...cfAccessHeaders(runtimeEnv),
  };

  async function proxyFetch(action: string, body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...body, projectId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ai: Proxy request failed with ${res.status}: '${text}'.`);
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
        return readProxyResult(res);
      }

      const res = await proxyFetch('run', { model, inputs, options });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return readProxyResult(res);
    },
    async image(model, inputs, options) {
      const { endpoint, runOptions } = splitImageOptions(options);

      if (isThirdPartyModel(model as string)) {
        const providerKey = resolveProviderKey(model as string, runtimeEnv);
        const proxyInputs = await serializeImageInputs(inputs, endpoint);
        return proxyFetch('gateway', { model, endpoint, inputs: proxyInputs, providerKey });
      }

      return proxyFetch('run', { model, inputs, options: runOptions });
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

  /** Image generation. Returns the proxy response so callers can return or parse it. */
  image<Name extends keyof AiModels>(
    model: Name,
    inputs: AiModels[Name]['inputs'],
    options?: ImageGenerationOptions,
  ): Promise<Response>;

  /** Third-party image generation or editing through AI Gateway. */
  image(
    model: ThirdPartyModel,
    inputs: ImageEditInputs,
    options: ImageEditOptions,
  ): Promise<Response>;

  /** Third-party image generation through AI Gateway. */
  image(
    model: ThirdPartyModel,
    inputs: ImageGenerationInputs,
    options?: ImageGenerationOptions,
  ): Promise<Response>;

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
    if (prop === 'image') {
      return backend().image;
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
  ChatContent,
  ImageGatewayEndpoint,
  ImageEditInputs,
  ImageEditOptions,
  ImageFileInput,
  ImageGenerationInputs,
  ImageGenerationResponse,
  ImageGenerationData,
  ImageGenerationOptions,
} from './ai-types';
