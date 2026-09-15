import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  PROVIDER_KEY_MAP,
  type AiProvider,
  type AiProviderFetchInit,
  type AiProviderOptions,
} from './ai-types.ts';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw.ts';

const PROXY_URL = 'https://proxy.void.cloud/ai';
const STAGING_PROXY_URL = 'https://proxy.staging.void.cloud/ai';
const VOID_FILE_MARKER = '__voidFile';

// Per-provider auth header/prefix for the self-host direct gateway path. The
// gateway passes provider auth through unchanged, so each entry mirrors the
// provider's documented native auth convention. Providers NOT listed here fall
// back to `Authorization: Bearer <key>` (correct for openai, groq, mistral,
// grok, deepseek, openrouter, perplexity, cohere, cerebras, huggingface,
// replicate). A caller's `apiKeyHeader`/`apiKeyPrefix` override still wins.
const PROVIDER_AUTH_DEFAULTS: Record<string, { header: string; prefix: string }> = {
  'google-ai-studio': { header: 'x-goog-api-key', prefix: '' },
  anthropic: { header: 'x-api-key', prefix: '' },
  elevenlabs: { header: 'xi-api-key', prefix: '' },
  deepgram: { header: 'authorization', prefix: 'Token ' },
  fal: { header: 'authorization', prefix: 'Key ' },
  cartesia: { header: 'x-api-key', prefix: '' },
  baseten: { header: 'authorization', prefix: 'Api-Key ' },
  ideogram: { header: 'Api-Key', prefix: '' },
  parallel: { header: 'x-api-key', prefix: '' },
};

type SerializedFileInput = {
  [VOID_FILE_MARKER]: true;
  data: string;
  name?: string;
  type?: string;
};

type SerializedProviderBody =
  | { type: 'none' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; data: string; contentType?: string }
  | { type: 'base64'; data: string; contentType?: string }
  | { type: 'form'; entries: Array<{ name: string; value: string | SerializedFileInput }> };

type AiBackend = {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
  image(model: string, inputs: unknown, options?: unknown): Promise<Response>;
  providerFetch(
    provider: string,
    path: string,
    init: AiProviderFetchInit | undefined,
    options: AiProviderOptions | undefined,
  ): Promise<Response>;
  models(params?: unknown): Promise<unknown>;
  toMarkdown(items: unknown, options?: unknown): Promise<unknown>;
};

function hasStreamFlag(value: unknown): value is { stream?: boolean } {
  return typeof value === 'object' && value !== null && 'stream' in value;
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

function formFileName(value: File | Blob, fallback: string): string {
  const name = fileNameFromBlob(value);
  return name ?? fallback;
}

async function serializeFormData(form: FormData): Promise<SerializedProviderBody> {
  const entries: Array<{ name: string; value: string | SerializedFileInput }> = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ name, value });
      continue;
    }
    entries.push({
      name,
      value: {
        [VOID_FILE_MARKER]: true,
        data: arrayBufferToBase64(await value.arrayBuffer()),
        name: formFileName(value, name),
        type: value.type || undefined,
      },
    });
  }
  return { type: 'form', entries };
}

async function serializeProviderBody(body: unknown): Promise<SerializedProviderBody> {
  if (body === undefined || body === null) {
    return { type: 'none' };
  }

  if (typeof body === 'string') {
    return { type: 'text', data: body };
  }

  if (body instanceof URLSearchParams) {
    return {
      type: 'text',
      data: body.toString(),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }

  if (body instanceof FormData) {
    return serializeFormData(body);
  }

  if (body instanceof Blob) {
    return {
      type: 'base64',
      data: arrayBufferToBase64(await body.arrayBuffer()),
      contentType: body.type || undefined,
    };
  }

  if (body instanceof ArrayBuffer) {
    return { type: 'base64', data: arrayBufferToBase64(body) };
  }

  if (isBinaryView(body)) {
    return { type: 'base64', data: arrayBufferToBase64(copyBinaryView(body)) };
  }

  return { type: 'json', value: await serializeProxyValue(body) };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const result: Record<string, string> = {};
  const normalized = new Headers(headers);
  for (const [key, value] of normalized.entries()) {
    result[key] = value;
  }
  return result;
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

function resolveProviderKey(
  provider: string,
  runtimeEnv: RuntimeEnv,
  options?: AiProviderOptions,
): string {
  const envVar = options?.apiKeyEnv ?? PROVIDER_KEY_MAP[provider];
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

function providerAuthDefaults(provider: string): { header: string; prefix: string } {
  return PROVIDER_AUTH_DEFAULTS[provider] ?? { header: 'authorization', prefix: 'Bearer ' };
}

function gatewayEndpointUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${normalizedBase}/${normalizedEndpoint}`;
}

function isUnsafeProviderPath(path: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(path) || path.includes('\\')) {
    return true;
  }

  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  for (const segment of pathname.split('/')) {
    try {
      if (decodeURIComponent(segment) === '..') {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

/**
 * Build a real outgoing HTTP body for the user's own AI Gateway (P3 self-host).
 *
 * Unlike `serializeProviderBody`/`providerRequestBody` (which build the proxy
 * envelope decoded on the proxy side), this emits an actual `BodyInit` +
 * content-type for a direct `fetch` to the gateway.
 */
function toDirectBody(body: unknown): { body: BodyInit | undefined; contentType?: string } {
  if (body === undefined || body === null) {
    return { body: undefined };
  }
  if (typeof body === 'string') {
    return { body };
  }
  if (
    body instanceof ReadableStream ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    isBinaryView(body)
  ) {
    return { body: body as BodyInit };
  }
  return { body: JSON.stringify(body), contentType: 'application/json' };
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
    return makeDirectBackend(
      directAi,
      runtimeEnv,
      runtimeEnv.__VOID_AI_GATEWAY as string | undefined,
    );
  }

  throw new Error(
    'ai: Not available. Run `void auth login` and `void project link` first, or bind Workers AI (env.AI) for self-hosted deploys.',
  );
}

function unsupported(method: string): () => never {
  return () => {
    throw new Error(`ai: ai.${method}() is not supported in this environment.`);
  };
}

async function providerRequestBody(
  provider: string,
  path: string,
  init: AiProviderFetchInit | undefined,
  options: AiProviderOptions | undefined,
  runtimeEnv: RuntimeEnv,
): Promise<Record<string, unknown>> {
  return {
    provider,
    path,
    method: init?.method,
    headers: headersToRecord(init?.headers),
    body: await serializeProviderBody(init?.body),
    providerKey: resolveProviderKey(provider, runtimeEnv, options),
    apiKeyHeader: options?.apiKeyHeader,
    apiKeyPrefix: options?.apiKeyPrefix,
  };
}

function makeServiceBindingBackend(proxy: Fetcher, runtimeEnv: RuntimeEnv): AiBackend {
  async function proxyFetch(
    action: string,
    body: Record<string, unknown>,
    options: { throwOnError?: boolean } = {},
  ): Promise<Response> {
    const res = await proxy.fetch(`https://ai-proxy/ai/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    if (options.throwOnError !== false && !res.ok) {
      const text = await res.text();
      throw new Error(`ai: Proxy request failed with ${res.status}: '${text}'.`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;

      const res = await proxyFetch('run', { model, inputs, options, projectId, aiToken });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return readProxyResult(res);
    },
    async image(model, inputs, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;
      const { runOptions } = splitImageOptions(options);

      return proxyFetch('run', { model, inputs, options: runOptions, projectId, aiToken });
    },
    async providerFetch(provider, path, init, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;
      return proxyFetch(
        'provider',
        {
          ...(await providerRequestBody(provider, path, init, options, runtimeEnv)),
          projectId,
          aiToken,
        },
        { throwOnError: false },
      );
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
    ...cfAccessHeaders(runtimeEnv, base),
  };

  async function proxyFetch(
    action: string,
    body: Record<string, unknown>,
    options: { throwOnError?: boolean } = {},
  ): Promise<Response> {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...body, projectId }),
    });
    if (options.throwOnError !== false && !res.ok) {
      const text = await res.text();
      throw new Error(`ai: Proxy request failed with ${res.status}: '${text}'.`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      const res = await proxyFetch('run', { model, inputs, options });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return readProxyResult(res);
    },
    async image(model, inputs, options) {
      const { runOptions } = splitImageOptions(options);

      return proxyFetch('run', { model, inputs, options: runOptions });
    },
    async providerFetch(provider, path, init, options) {
      return proxyFetch(
        'provider',
        await providerRequestBody(provider, path, init, options, runtimeEnv),
        { throwOnError: false },
      );
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

function makeDirectBackend(
  directAi: Ai,
  runtimeEnv: RuntimeEnv,
  gatewayId: string | undefined,
): AiBackend {
  return {
    run: directAi.run.bind(directAi),
    async image(model, inputs, options) {
      const { runOptions } = splitImageOptions(options);
      return responseFromResult(
        await directAi.run(model as keyof AiModels, inputs as never, runOptions as AiOptions),
      );
    },
    async providerFetch(provider, path, init, options) {
      if (!gatewayId) {
        return Response.json(
          {
            error:
              'ai: ai.provider().fetch() needs an AI Gateway when self-hosting. Set "ai": { "gateway": "<id>" } in void.json.',
          },
          { status: 501 },
        );
      }
      if (isUnsafeProviderPath(path)) {
        return Response.json(
          { error: `ai: provider path '${path}' must be relative.` },
          { status: 400 },
        );
      }
      let providerKey: string;
      try {
        providerKey = resolveProviderKey(provider, runtimeEnv, options);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
      let baseUrl: string;
      try {
        baseUrl = await directAi.gateway(gatewayId).getUrl(provider);
      } catch (e) {
        return Response.json(
          { error: `ai: gateway '${gatewayId}': ${(e as Error).message}` },
          { status: 502 },
        );
      }
      const { body, contentType } = toDirectBody(init?.body);
      const headers = new Headers(init?.headers);
      const defaults = providerAuthDefaults(provider);
      headers.set(
        options?.apiKeyHeader ?? defaults.header,
        `${options?.apiKeyPrefix ?? defaults.prefix}${providerKey}`,
      );
      if (contentType && !headers.has('content-type')) {
        headers.set('content-type', contentType);
      }
      return fetch(gatewayEndpointUrl(baseUrl, path), {
        method: init?.method ?? 'POST',
        headers,
        body,
      });
    },
    models: directAi.models.bind(directAi),
    toMarkdown: directAi.toMarkdown?.bind(directAi) ?? unsupported('toMarkdown'),
  };
}

// Lazy-init backend on first access
let _backend: AiBackend | undefined;
function backend(): AiBackend {
  return (_backend ??= resolveBackend());
}

/**
 * Extended AI type with a convenience `stream()` method.
 *
 * `stream()` calls `ai.run()` with `stream: true` and wraps the result
 * in a `Response` with SSE headers — ready to return from a route handler.
 */
export type VoidAi = Omit<Ai, 'run'> & {
  /** Workers AI inference (existing) */
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: AiModels[Name]['inputs'],
    options?: AiOptions,
  ): Promise<AiModels[Name]['postProcessedOutputs']>;

  /** Cloudflare AI Gateway model inference. Accepts Cloudflare model IDs unchanged. */
  run(model: string, inputs: unknown, options?: AiOptions): Promise<unknown>;

  /** Image generation. Returns the proxy response so callers can return or parse it. */
  image<Name extends keyof AiModels>(
    model: Name,
    inputs: AiModels[Name]['inputs'],
    options?: AiOptions,
  ): Promise<Response>;

  /** Cloudflare AI Gateway model inference returned as a Response. */
  image(model: string, inputs: unknown, options?: AiOptions): Promise<Response>;

  /** Provider-native AI Gateway requests using a project secret for the provider API key. */
  provider(
    provider: AiProvider,
    options?: AiProviderOptions,
  ): {
    fetch(path: string, init?: AiProviderFetchInit): Promise<Response>;
  };

  /** Stream Workers AI response as SSE */
  stream<Name extends keyof AiModels>(
    model: Name,
    inputs: Omit<AiModels[Name]['inputs'], 'stream'>,
    options?: AiOptions,
  ): Promise<Response>;

  /** Stream any Cloudflare AI Gateway model response as SSE */
  stream(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<Response>;
};

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
    if (prop === 'provider') {
      return (provider: string, options?: AiProviderOptions) => ({
        fetch: (path: string, init?: AiProviderFetchInit) =>
          backend().providerFetch(provider, path, init, options),
      });
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
  AiProvider,
  AiProviderFetchInit,
  AiProviderName,
  AiProviderOptions,
  ImageFileInput,
} from './ai-types.ts';
