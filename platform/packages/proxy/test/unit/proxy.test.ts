import { describe, it, expect, vi, beforeAll, afterEach } from 'vite-plus/test';
import worker from '../../src/index.ts';

const JWT_SECRET = 'test-secret-key';

// --- JWT helper (mirrors the worker's HMAC-SHA256 signing) ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(
  payload: {
    sub: string;
    login: string;
    aud?: string;
    exp?: number;
    project?: string;
    build?: string;
  },
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64urlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        ...payload,
        aud: payload.aud ?? 'api',
        iat: Math.floor(Date.now() / 1000),
        exp: payload.exp ?? Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`)),
  );
  return `${header}.${body}.${base64urlEncode(sig)}`;
}

// --- HMAC helper (mirrors the worker's project token signing) ---

async function signAiToken(projectId: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(projectId)));
  return base64urlEncode(sig);
}

// --- Mock env factory ---

type MockAi = {
  run: ReturnType<typeof vi.fn>;
  models: ReturnType<typeof vi.fn>;
  toMarkdown: ReturnType<typeof vi.fn>;
  gateway: ReturnType<typeof vi.fn>;
};

function createMockKv(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

/**
 * User-to-project ownership map used by the mock API for verify-owner checks.
 * Default: user_1 owns proj_1, proj_42, proj_99, and p.
 */
const DEFAULT_OWNERSHIP: Record<string, Array<string>> = {
  user_1: ['proj_1', 'proj_42', 'proj_99', 'p'],
};

type ApiFetchHandler = (input: string | Request, init?: RequestInit) => Promise<Response>;

function createMockApi(
  handler?: ApiFetchHandler,
  ownership: Record<string, Array<string>> = DEFAULT_OWNERSHIP,
) {
  // Fetcher.fetch() is called as (url: string, init: RequestInit), not (Request).
  const defaultHandler = async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);

    // Handle verify-owner requests
    if (url.includes('/internal/verify-owner/')) {
      const projectId = url.split('/').pop()!;
      const parsed = typeof body === 'string' ? JSON.parse(body) : {};
      const userProjects = ownership[parsed.userId] ?? [];
      if (userProjects.includes(projectId)) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Default: generic success response
    return new Response(JSON.stringify({ purged: 1 }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch: handler ?? defaultHandler };
}

function createEnv(
  aiOverrides?: Partial<MockAi>,
  kvData?: Record<string, string>,
  apiOverride?: { fetch: ReturnType<typeof vi.fn> | ((req: Request) => Promise<Response>) },
) {
  return {
    AI: {
      run: vi.fn(async () => ({ response: 'hello' })),
      models: vi.fn(async () => [{ name: 'model-a' }]),
      toMarkdown: vi.fn(async () => ({ markdown: '# Hi' })),
      gateway: vi.fn(() => ({ run: vi.fn(async () => new Response('{}')) })),
      ...aiOverrides,
    },
    JWT_SECRET,
    ROUTING: createMockKv(kvData),
    CF_ACCOUNT_ID: 'test-account-id',
    CF_API_TOKEN: 'test-api-token',
    API: apiOverride ?? createMockApi(),
    DISPATCH: {
      get: vi.fn(() => {
        throw new Error('worker not found');
      }),
    },
  };
}

function post(path: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(`https://proxy.void.cloud${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

describe('proxy worker', () => {
  let validToken: string;
  const aiTokens: Record<string, string> = {};

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    validToken = await signJwt({ sub: 'user_1', login: 'testuser' }, JWT_SECRET);
    for (const pid of ['proj_1', 'proj_42', 'proj_99', 'p']) {
      aiTokens[pid] = await signAiToken(pid, JWT_SECRET);
    }
  });

  describe('CORS', () => {
    it('returns 204 with CORS headers on OPTIONS', async () => {
      const req = new Request('https://proxy.void.cloud/ai/run', { method: 'OPTIONS' });
      const res = await worker.fetch(req, createEnv());

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    });
  });

  describe('method validation', () => {
    it('rejects non-POST requests with 405', async () => {
      const req = new Request('https://proxy.void.cloud/ai/run', { method: 'GET' });
      const res = await worker.fetch(req, createEnv());

      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: 'method not allowed' });
    });
  });

  describe('JWT authentication (HTTPS path)', () => {
    it('accepts valid JWT', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it('rejects expired JWT with 401', async () => {
      const expiredToken = await signJwt(
        { sub: 'user_1', login: 'testuser', exp: Math.floor(Date.now() / 1000) - 60 },
        JWT_SECRET,
      );

      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'p' },
          { authorization: `Bearer ${expiredToken}` },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid or expired token' });
    });

    it('rejects JWT signed with wrong secret', async () => {
      const badToken = await signJwt({ sub: 'user_1', login: 'testuser' }, 'wrong-secret');

      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'p' },
          { authorization: `Bearer ${badToken}` },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
    });

    it('rejects malformed JWT with 401', async () => {
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'p' },
          { authorization: 'Bearer not.a.valid.jwt.at.all' },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
    });

    it('requires projectId with JWT auth', async () => {
      const res = await worker.fetch(
        post('/ai/run', { model: 'm', inputs: {} }, { authorization: `Bearer ${validToken}` }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId required' });
    });
  });

  describe('JWT project ownership verification', () => {
    it('allows access when user owns the project', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it('accepts a prerender token only for its scoped project', async () => {
      const token = await signJwt(
        { sub: 'user_1', login: 'testuser', aud: 'prerender', project: 'proj_1' },
        JWT_SECRET,
      );
      const api = createMockApi();
      const apiFetch = vi.spyOn(api, 'fetch');
      const env = createEnv(undefined, undefined, api);

      const allowed = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${token}` },
        ),
        env,
      );
      expect(allowed.status).toBe(200);
      expect(apiFetch).not.toHaveBeenCalled();

      const denied = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_42' },
          { authorization: `Bearer ${token}` },
        ),
        env,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'forbidden' });
    });

    it('revokes an already-minted build-bound prerender token when its build terminates', async () => {
      const token = await signJwt(
        {
          sub: 'user_1',
          login: 'testuser',
          aud: 'prerender',
          project: 'proj_1',
          build: 'bld_1',
        },
        JWT_SECRET,
      );
      let active = true;
      const api = createMockApi(async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        expect(url).toContain('/internal/verify-prerender-build/proj_1');
        return active
          ? Response.json({ ok: true })
          : Response.json({ error: 'build is no longer active' }, { status: 403 });
      });
      const env = createEnv(undefined, undefined, api);
      const request = () =>
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${token}` },
        );

      expect((await worker.fetch(request(), env)).status).toBe(200);
      active = false;
      const revoked = await worker.fetch(request(), env);
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toEqual({
        error: 'prerender token build is no longer active',
      });
    });

    it('rejects deploy tokens at the binding proxy', async () => {
      const token = await signJwt(
        { sub: 'user_1', login: 'testuser', aud: 'deploy', project: 'proj_1' },
        JWT_SECRET,
      );
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${token}` },
        ),
        createEnv(),
      );
      expect(res.status).toBe(401);
    });

    it('rejects access when user does not own the project', async () => {
      // user_1 does not own "proj_other"
      const env = createEnv();
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_other' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    });

    it("rejects cross-tenant access to another user's project", async () => {
      // user_2 owns proj_cross but user_1 (validToken) does not
      const ownership = { user_2: ['proj_cross'] };
      const env = createEnv(undefined, undefined, createMockApi(undefined, ownership));
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_cross' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    });

    it('returns 403 when verify-owner API call fails', async () => {
      // API returns 500 for all requests
      const failingApi = createMockApi(async () => new Response('error', { status: 500 }));
      const env = createEnv(undefined, undefined, failingApi);
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    });

    it('HMAC path bypasses ownership check (service binding is trusted)', async () => {
      // Even for a project not in user_1's ownership, HMAC path should work
      const env = createEnv(undefined, undefined, createMockApi(undefined, {}));
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });
  });

  describe('service binding path (no auth header)', () => {
    it('accepts requests with valid aiToken', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it('requires projectId and aiToken', async () => {
      const res = await worker.fetch(post('/ai/run', { model: 'm', inputs: {} }), createEnv());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId and aiToken required' });
    });

    it('rejects request with missing aiToken', async () => {
      const res = await worker.fetch(
        post('/ai/run', { model: 'm', inputs: {}, projectId: 'proj_1' }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId and aiToken required' });
    });

    it('rejects request with wrong aiToken', async () => {
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_1',
          aiToken: 'invalid-token',
        }),
        createEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
    });

    it('rejects request with aiToken for different projectId', async () => {
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_1',
          aiToken: aiTokens['proj_42'],
        }),
        createEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
    });
  });

  describe('AI usage limit (KV block)', () => {
    it('returns 429 when ai-block key exists (service binding path)', async () => {
      const env = createEnv({}, { 'ai-block:proj_1': '1' });
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'AI usage limit exceeded' });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('returns 429 when ai-block key exists (JWT path)', async () => {
      const env = createEnv({}, { 'ai-block:proj_1': '1' });
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'proj_1' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'AI usage limit exceeded' });
    });

    it('allows request when ai-block key does not exist', async () => {
      const env = createEnv({}, {});
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
    });
  });

  describe('AI: /ai/run', () => {
    it('calls AI.run with model, inputs, and gateway metadata', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post('/ai/run', {
          model: '@cf/meta/llama-3-8b-instruct',
          inputs: { prompt: 'hi' },
          options: { max_tokens: 100 },
          projectId: 'proj_42',
          aiToken: aiTokens['proj_42'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalledWith(
        '@cf/meta/llama-3-8b-instruct',
        { prompt: 'hi' },
        {
          max_tokens: 100,
          gateway: { id: 'void', metadata: { projectId: 'proj_42' } },
        },
      );
    });

    it('preserves user gateway options while forcing Void gateway id and project metadata', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: { prompt: 'hi' },
          options: {
            gateway: {
              id: 'custom',
              skipCache: true,
              cacheTtl: 60,
              metadata: { user: 'alice', projectId: 'wrong' },
            },
          },
          projectId: 'proj_42',
          aiToken: aiTokens['proj_42'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        { prompt: 'hi' },
        {
          gateway: {
            id: 'void',
            skipCache: true,
            cacheTtl: 60,
            metadata: { user: 'alice', projectId: 'proj_42' },
          },
        },
      );
    });

    it('returns 400 when model is missing', async () => {
      const res = await worker.fetch(
        post('/ai/run', { inputs: {}, projectId: 'p', aiToken: aiTokens['p'] }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'model required' });
    });

    it('returns streaming response when inputs.stream is true', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"response":"hi"}\n\n'));
          controller.close();
        },
      });
      const env = createEnv({ run: vi.fn(async () => stream) });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: { prompt: 'hi', stream: true },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');

      const text = await res.text();
      expect(text).toContain('{"response":"hi"}');
    });

    it('returns JSON response for non-streaming calls', async () => {
      const env = createEnv({ run: vi.fn(async () => ({ response: 'world' })) });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: { prompt: 'hi' },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ response: 'world' });
    });

    it('returns binary responses without forcing JSON', async () => {
      const env = createEnv({
        run: vi.fn(async () => new Blob(['png-bytes'], { type: 'image/png' })),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: '@cf/black-forest-labs/flux-1-schnell',
          inputs: { prompt: 'a red cube' },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(await res.text()).toBe('png-bytes');
    });

    it('uses response() from Workers AI result objects', async () => {
      const env = createEnv({
        run: vi.fn(async () => ({
          response: () => new Response('jpeg-bytes', { headers: { 'content-type': 'image/jpeg' } }),
        })),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: '@cf/image-model',
          inputs: { prompt: 'a blue cube' },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(await res.text()).toBe('jpeg-bytes');
    });

    it('injects gateway metadata even without user options', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_99',
          aiToken: aiTokens['proj_99'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        {},
        {
          gateway: { id: 'void', metadata: { projectId: 'proj_99' } },
        },
      );
    });
  });

  describe('AI: /ai/models', () => {
    it('calls AI.models and returns result', async () => {
      const models = [{ name: 'model-a' }, { name: 'model-b' }];
      const env = createEnv({ models: vi.fn(async () => models) });

      const res = await worker.fetch(
        post('/ai/models', {
          inputs: { search: 'llama' },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(models);
      expect(env.AI.models).toHaveBeenCalledWith({ search: 'llama' });
    });
  });

  describe('AI: /ai/toMarkdown', () => {
    it('calls AI.toMarkdown and returns result', async () => {
      const result = { markdown: '# Hello' };
      const env = createEnv({ toMarkdown: vi.fn(async () => result) });

      const res = await worker.fetch(
        post('/ai/toMarkdown', {
          inputs: { content: 'hello' },
          options: { format: 'md' },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
      expect(env.AI.toMarkdown).toHaveBeenCalledWith({ content: 'hello' }, { format: 'md' });
    });
  });

  describe('AI: /ai/provider', () => {
    function mockProviderFetch(response: BodyInit, init?: ResponseInit) {
      const fetchMock = vi.fn(async () => new Response(response, init));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    function mockProviderGateway(provider = 'openai') {
      const getUrlMock = vi.fn(
        async (requestedProvider?: string) =>
          `https://gateway.test/v1/account/void/${requestedProvider ?? provider}/`,
      );
      const runMock = vi.fn();
      const gateway = vi.fn(() => ({ getUrl: getUrlMock, run: runMock }));
      return { gateway, getUrlMock, runMock };
    }

    it('forwards OpenAI provider-native JSON requests', async () => {
      const fetchMock = mockProviderFetch(JSON.stringify({ id: 'resp_1' }), {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway, getUrlMock, runMock } = mockProviderGateway();

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          method: 'POST',
          headers: { 'openai-beta': 'assistants=v2' },
          body: {
            type: 'json',
            value: {
              model: 'gpt-4o',
              messages: [{ role: 'user', content: 'Hello' }],
            },
          },
          providerKey: 'sk-test-key',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'resp_1' });
      expect(gateway).toHaveBeenCalledWith('void');
      expect(getUrlMock).toHaveBeenCalledWith('openai');
      expect(runMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gateway.test/v1/account/void/openai/chat/completions',
      );

      const init = fetchMock.mock.calls[0][1]!;
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-test-key');
      expect(headers.get('cf-aig-metadata-projectId')).toBe('proj_1');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('openai-beta')).toBe('assistants=v2');
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('uses Google AI Studio API-key header for provider-native requests', async () => {
      const fetchMock = mockProviderFetch(JSON.stringify({ candidates: [] }), {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway, getUrlMock } = mockProviderGateway('google-ai-studio');

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'google-ai-studio',
          path: '/v1/models/gemini-2.5-flash:generateContent',
          body: {
            type: 'json',
            value: { contents: [{ parts: [{ text: 'Hello' }] }] },
          },
          providerKey: 'google-key',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(getUrlMock).toHaveBeenCalledWith('google-ai-studio');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gateway.test/v1/account/void/google-ai-studio/v1/models/gemini-2.5-flash:generateContent',
      );
      const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
      expect(headers.get('x-goog-api-key')).toBe('google-key');
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cf-aig-metadata-projectId')).toBe('proj_1');
    });

    it('reconstructs multipart form data bodies', async () => {
      const fetchMock = mockProviderFetch(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway } = mockProviderGateway();

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/images/edits',
          body: {
            type: 'form',
            entries: [
              { name: 'model', value: 'gpt-image-1.5' },
              { name: 'prompt', value: 'change the background' },
              {
                name: 'image',
                value: {
                  __voidFile: true,
                  data: btoa('png-bytes'),
                  name: 'source.png',
                  type: 'image/png',
                },
              },
            ],
          },
          providerKey: 'sk-test',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      const init = fetchMock.mock.calls[0][1]!;
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBeNull();

      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('model')).toBe('gpt-image-1.5');
      expect(form.get('prompt')).toBe('change the background');
      const image = form.get('image') as Blob;
      expect(image).toBeInstanceOf(Blob);
      expect(image.type).toBe('image/png');
      expect(await image.text()).toBe('png-bytes');
    });

    it('preserves non-JSON provider responses', async () => {
      const fetchMock = mockProviderFetch('image-bytes', {
        headers: { 'content-type': 'image/png' },
      });
      const { gateway } = mockProviderGateway('fal');

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'fal',
          path: '/v1/images',
          body: { type: 'json', value: { prompt: 'a small robot' } },
          providerKey: 'fal-key',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(await res.text()).toBe('image-bytes');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('requires provider, path, and providerKey', async () => {
      const env = createEnv();

      const noProvider = await worker.fetch(
        post('/ai/provider', {
          path: '/chat/completions',
          providerKey: 'sk-test',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );
      expect(noProvider.status).toBe(400);
      expect(await noProvider.json()).toEqual({ error: 'provider required' });

      const noPath = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          providerKey: 'sk-test',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );
      expect(noPath.status).toBe(400);
      expect(await noPath.json()).toEqual({ error: 'path required' });

      const noKey = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );
      expect(noKey.status).toBe(400);
      expect(await noKey.json()).toEqual({ error: 'providerKey required' });
    });

    it('rejects unsafe provider paths', async () => {
      const env = createEnv();
      for (const path of [
        'https://api.openai.com/v1/chat/completions',
        '//api.openai.com/v1/chat/completions',
        '/../chat/completions',
        '/%2e%2e/chat/completions',
        '/v1\\chat\\completions',
        '/%E0%A4%A',
      ]) {
        const res = await worker.fetch(
          post('/ai/provider', {
            provider: 'openai',
            path,
            providerKey: 'sk-test',
            projectId: 'proj_1',
            aiToken: aiTokens['proj_1'],
          }),
          env,
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'path must be relative' });
      }
    });

    it('forwards provider error status and message', async () => {
      mockProviderFetch(
        JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
      const { gateway } = mockProviderGateway();

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          body: { type: 'json', value: { model: 'gpt-4o' } },
          providerKey: 'sk-bad-key',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Invalid API key');
    });

    it('respects usage limits for provider-native requests', async () => {
      const env = createEnv({}, { 'ai-block:proj_1': '1' });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          providerKey: 'sk-test',
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'AI usage limit exceeded' });
    });
  });

  describe('revalidate: /revalidate', () => {
    it('forwards revalidation to API via service binding', async () => {
      const apiFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 2 }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const env = createEnv({}, {}, { fetch: apiFetch });

      const res = await worker.fetch(
        post('/revalidate', {
          paths: ['/', '/blog'],
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 2 });

      expect(apiFetch).toHaveBeenCalledOnce();
      // Fetcher.fetch() receives (url: string, init: RequestInit)
      const [url, init] = apiFetch.mock.calls[0];
      expect(url).toBe('https://api/internal/revalidate/proj_1');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('x-void-internal')).toBe(aiTokens['proj_1']);
      expect(JSON.parse(init.body)).toEqual({ paths: ['/', '/blog'] });
    });

    it('forwards all:true revalidation', async () => {
      const apiFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 10 }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const env = createEnv({}, {}, { fetch: apiFetch });

      const res = await worker.fetch(
        post('/revalidate', {
          all: true,
          projectId: 'proj_1',
          aiToken: aiTokens['proj_1'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 10 });

      const [, init] = apiFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ all: true });
    });

    it('rejects unauthenticated revalidation requests', async () => {
      const res = await worker.fetch(post('/revalidate', { paths: ['/'] }), createEnv());

      expect(res.status).toBe(400);
    });
  });

  describe('error handling', () => {
    it('returns the AI binding error message when the binding throws', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw new Error('inference failed');
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'inference failed' });
    });

    it('returns 502 with stringified error when non-Error is thrown', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw 'string error';
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'string error' });
    });

    it('forwards response-shaped AI binding errors', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw {
            response: new Response(
              JSON.stringify({ errors: [{ message: 'Unified Billing off' }] }),
              {
                status: 402,
                headers: { 'content-type': 'application/json' },
              },
            ),
          };
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'google/gemini-2.5-flash',
          inputs: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(402);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toEqual({ errors: [{ message: 'Unified Billing off' }] });
    });

    it('uses status from AI binding errors when available', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          const error = new Error('Invalid model input') as Error & { status: number };
          error.status = 400;
          throw error;
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'google/gemini-2.5-flash',
          inputs: { messages: [{ role: 'user', content: 'Hello' }] },
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid model input' });
    });

    it('includes CORS headers on error responses', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw new Error('fail');
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'p',
          aiToken: aiTokens['p'],
        }),
        env,
      );

      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });
});
