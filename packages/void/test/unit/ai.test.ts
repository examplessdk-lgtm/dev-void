import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Build a fake Workers AI binding (`env.AI`) for the P3 self-host backend.
 *
 * `gateway(id)` returns an object whose `getUrl(provider)` mock resolves to a
 * realistic AI Gateway URL derived from BOTH the gateway id and provider, so
 * the appended provider path can be asserted end-to-end.
 */
function makeDirectAi(
  opts: { getUrl?: (id: string, provider: string) => Promise<string>; run?: () => unknown } = {},
) {
  const getUrlImpl =
    opts.getUrl ??
    (async (id: string, provider: string) =>
      `https://gateway.ai.cloudflare.com/v1/acct123/${id}/${provider}`);
  const run = vi.fn(async (..._args: Array<unknown>) => (opts.run ? opts.run() : { ok: true }));
  const models = vi.fn(async () => ['@cf/meta/llama']);
  const toMarkdown = vi.fn(async () => []);
  const gateway = vi.fn((id: string) => ({
    getUrl: vi.fn((provider: string) => getUrlImpl(id, provider)),
  }));
  return { AI: { run, gateway, models, toMarkdown }, run, gateway };
}

describe('runtime ai', () => {
  it.each([undefined, '1'])(
    'rejects missing proxy metadata without sending credentials (legacy staging=%s)',
    async (staging) => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');
      const request = vi.fn();
      vi.stubGlobal('fetch', request);
      await envContext.run(
        { __VOID_TOKEN: 'token', __VOID_PROJECT_ID: 'project', __VOID_STAGING: staging },
        async () => {
          await expect(ai.run('@cf/meta/llama', {})).rejects.toThrow('No connected platform proxy');
        },
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('explains missing bindings without suggesting Void login for a direct Cloudflare project', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');
    await envContext.run({}, async () => {
      await expect(ai.run('@cf/meta/llama', {})).rejects.toThrow(
        'Configure a Workers AI binding (env.AI) for direct Cloudflare development',
      );
    });
  });

  it('routes Cloudflare provider models through the run endpoint unchanged', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
      },
      async () => {
        const result = await ai.run('google/gemini-2.5-flash', {
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        });

        expect(result).toEqual({ choices: [{ message: { content: 'Hi' } }] });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/run');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'run',
      model: 'google/gemini-2.5-flash',
      inputs: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
      projectId: 'proj_1',
    });
  });

  it('routes provider-native JSON requests through the provider endpoint', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'chatcmpl_1' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          headers: { 'openai-beta': 'assistants=v2' },
          body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
          },
        });

        expect(await response.json()).toEqual({ id: 'chatcmpl_1' });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/provider');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'provider',
      provider: 'openai',
      path: '/chat/completions',
      headers: { 'openai-beta': 'assistants=v2' },
      body: {
        type: 'json',
        value: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('returns non-2xx provider responses for HTTP proxy requests', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { message: 'Invalid API key' } });
      },
    );
  });

  it('returns non-2xx provider responses for service-binding proxy requests', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const proxyFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await envContext.run(
      {
        __VOID_PROXY: { fetch: proxyFetch },
        __PROJECT_ID: 'proj_1',
        __VOID_PROXY_TOKEN: 'proxy-token',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { message: 'Invalid API key' } });
      },
    );

    expect(proxyFetch).toHaveBeenCalledOnce();
    const init = proxyFetch.mock.calls[0][1]!;
    expect(proxyFetch.mock.calls[0][0]).toBe('https://ai-proxy/ai/provider');
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: 'provider',
      provider: 'openai',
      path: '/chat/completions',
      providerKey: 'sk-test',
      projectId: 'proj_1',
      aiToken: 'proxy-token',
    });
  });

  it('supports provider API-key env and header overrides', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        CUSTOM_AI_KEY: 'custom-key',
      },
      async () => {
        await ai
          .provider('custom-provider', {
            apiKeyEnv: 'CUSTOM_AI_KEY',
            apiKeyHeader: 'x-api-key',
            apiKeyPrefix: '',
          })
          .fetch('/v1/respond', { body: 'hello' });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'provider',
      provider: 'custom-provider',
      path: '/v1/respond',
      body: { type: 'text', data: 'hello' },
      providerKey: 'custom-key',
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: '',
      projectId: 'proj_1',
    });
  });

  it('serializes provider-native multipart bodies', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const form = new FormData();
        form.set('model', 'gpt-image-1.5');
        form.set('prompt', 'change the background');
        form.set('image', new Blob(['png-bytes'], { type: 'image/png' }), 'source.png');

        await ai.provider('openai').fetch('/images/edits', { body: form });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      action: 'provider',
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
              data: 'cG5nLWJ5dGVz',
              name: 'source.png',
              type: 'image/png',
            },
          },
        ],
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('returns blobs for non-JSON run responses', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('png-bytes', {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
      },
      async () => {
        const result = await ai.run(
          '@cf/black-forest-labs/flux-1-schnell' as keyof AiModels,
          {
            prompt: 'a small robot',
          } as never,
        );

        expect(result).toBeInstanceOf(Blob);
        expect((result as Blob).type).toBe('image/png');
        expect(await (result as Blob).text()).toBe('png-bytes');
      },
    );
  });

  // P3 self-host backend: only `env.AI` is bound (no Void proxy/token). Inference
  // runs directly against the user's Workers AI binding, and `ai.provider().fetch`
  // routes through the user's OWN AI Gateway using a project provider secret.
  describe('direct AI backend (self-host, env.AI only)', () => {
    it('selects the direct backend when only env.AI is present (ai.run → directAi.run)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      // Any accidental fall-through to the Void proxy would hit fetch — assert it doesn't.
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response('proxy-should-not-be-used', { status: 500 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run({ AI: direct.AI }, async () => {
        const result = await ai.run('@cf/meta/llama', { prompt: 'Hi' });
        expect(result).toEqual({ ok: true });
      });

      expect(direct.run).toHaveBeenCalledWith(
        '@cf/meta/llama',
        { prompt: 'Hi' },
        { returnRawResponse: true },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('selects a custom binding named by the generated runtime variable', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');
      const direct = makeDirectAi();

      await envContext.run({ MY_AI: direct.AI, __VOID_AI_BINDING: 'MY_AI' }, async () => {
        expect(await ai.run('@cf/meta/llama', { prompt: 'Hi' })).toEqual({ ok: true });
      });

      expect(direct.run).toHaveBeenCalledWith(
        '@cf/meta/llama',
        { prompt: 'Hi' },
        { returnRawResponse: true },
      );
    });

    it('provider().fetch hits the user gateway with provider auth and no metering header', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 'chatcmpl_direct' }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const response = await ai.provider('openai').fetch('/chat/completions', {
            body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
          });
          // Gateway response passes through untouched.
          expect(await response.json()).toEqual({ id: 'chatcmpl_direct' });
        },
      );

      // Resolved the URL from the user's OWN gateway (awaited getUrl), not the Void proxy.
      expect(direct.gateway).toHaveBeenCalledWith('my-gw');
      expect(direct.gateway.mock.results[0].value.getUrl).toHaveBeenCalledWith('openai');

      expect(fetchMock).toHaveBeenCalledOnce();
      const url = fetchMock.mock.calls[0][0];
      const init = fetchMock.mock.calls[0][1]!;
      expect(String(url).endsWith('/my-gw/openai/chat/completions')).toBe(true);
      expect(init.method).toBe('POST');

      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-test');
      expect(headers.get('content-type')).toBe('application/json');
      // Self-host path must NOT attach managed metering / projectId headers.
      expect(headers.get('cf-aig-metadata-projectId')).toBeNull();
      expect(headers.get('cf-aig-metadata')).toBeNull();

      // Real provider payload — NOT the proxy envelope ({ action, provider, providerKey, ... }).
      const sent = JSON.parse(init.body as string);
      expect(sent).toEqual({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] });
      expect(sent).not.toHaveProperty('action');
      expect(sent).not.toHaveProperty('provider');
      expect(sent).not.toHaveProperty('providerKey');
    });

    it('sends the provider-native auth header for a non-Bearer provider (anthropic → x-api-key, no Bearer)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 'msg_direct' }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', ANTHROPIC_API_KEY: 'sk-ant-test' },
        async () => {
          await ai.provider('anthropic').fetch('/v1/messages', {
            body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'Hi' }] },
          });
        },
      );

      expect(direct.gateway.mock.results[0].value.getUrl).toHaveBeenCalledWith('anthropic');
      const init = fetchMock.mock.calls[0][1]!;
      const headers = new Headers(init.headers);
      // Anthropic authenticates with `x-api-key` and NO prefix — sending
      // `Authorization: Bearer <key>` 401s at the gateway pass-through.
      expect(headers.get('x-api-key')).toBe('sk-ant-test');
      expect(headers.get('authorization')).toBeNull();
    });

    it('sends the provider-native auth header for parallel (x-api-key, no Bearer)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 'task_run_direct' }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', PARALLEL_API_KEY: 'pk-test' },
        async () => {
          await ai.provider('parallel').fetch('/v1/tasks/runs', {
            body: { input: 'What is the capital of France?' },
          });
        },
      );

      expect(direct.gateway.mock.results[0].value.getUrl).toHaveBeenCalledWith('parallel');
      const init = fetchMock.mock.calls[0][1]!;
      const headers = new Headers(init.headers);
      // Parallel's AI Gateway authenticates with `x-api-key` and NO prefix —
      // sending `Authorization: Bearer <key>` 401s at the gateway pass-through.
      expect(headers.get('x-api-key')).toBe('pk-test');
      expect(headers.get('authorization')).toBeNull();
    });

    it('sends a prefixed non-Bearer auth header (deepgram → Authorization: Token)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', DEEPGRAM_API_KEY: 'dg-test' },
        async () => {
          await ai
            .provider('deepgram')
            .fetch('/v1/listen', { body: { url: 'https://example.com/a.wav' } });
        },
      );

      const init = fetchMock.mock.calls[0][1]!;
      const headers = new Headers(init.headers);
      // Deepgram uses the `Token ` scheme, not `Bearer `.
      expect(headers.get('authorization')).toBe('Token dg-test');
    });

    it('resolves to 501 when no AI gateway is configured', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run({ AI: direct.AI, OPENAI_API_KEY: 'sk-test' }, async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o' },
        });
        expect(response.status).toBe(501);
        const body = (await response.json()) as { error: string };
        expect(body.error).toMatch(/gateway/i);
        expect(body.error).toContain('void.json');
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(direct.gateway).not.toHaveBeenCalled();
    });

    it('resolves to 400 naming the missing provider secret', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      // Gateway present + safe path, but OPENAI_API_KEY is absent.
      await envContext.run({ AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw' }, async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o' },
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain('OPENAI_API_KEY');
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // Key check happens before the gateway lookup.
      expect(direct.gateway).not.toHaveBeenCalled();
    });

    it('resolves to 502 when the gateway getUrl lookup rejects', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi({
        getUrl: async () => {
          throw new Error('gateway 404 not found');
        },
      });

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const response = await ai.provider('openai').fetch('/chat/completions', {
            body: { model: 'gpt-4o' },
          });
          expect(response.status).toBe(502);
          const body = (await response.json()) as { error: string };
          expect(body.error).toContain('my-gw');
        },
      );

      expect(direct.gateway).toHaveBeenCalledWith('my-gw');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves to 400 for an unsafe absolute provider path', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const response = await ai
            .provider('openai')
            .fetch('https://evil.example.com/v1/chat', { body: { model: 'gpt-4o' } });
          expect(response.status).toBe(400);
          const body = (await response.json()) as { error: string };
          expect(body.error).toMatch(/must be relative/);
        },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      // Path is rejected before any gateway lookup or network call.
      expect(direct.gateway).not.toHaveBeenCalled();
    });

    it('serializes a direct JSON body as real application/json (not the proxy envelope)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          await ai.provider('openai').fetch('/chat/completions', {
            body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
          });
        },
      );

      const init = fetchMock.mock.calls[0][1]!;
      expect(typeof init.body).toBe('string');
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('forwards a direct multipart/form-data body untouched (fetch sets the boundary)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const form = new FormData();
          form.set('model', 'gpt-image-1.5');
          form.set('prompt', 'change the background');
          form.set('image', new Blob(['png-bytes'], { type: 'image/png' }), 'source.png');

          await ai.provider('openai').fetch('/images/edits', { body: form });
        },
      );

      const init = fetchMock.mock.calls[0][1]!;
      // The self-host path passes FormData straight through — fetch itself sets
      // the multipart content-type + boundary, so we must NOT force content-type
      // and must NOT base64-envelope the parts like the managed proxy does.
      expect(init.body).toBeInstanceOf(FormData);
      expect(new Headers(init.headers).get('content-type')).toBeNull();
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');

      const sentForm = init.body as FormData;
      expect(sentForm.get('model')).toBe('gpt-image-1.5');
      expect(sentForm.get('prompt')).toBe('change the background');
      const image = sentForm.get('image');
      expect(image).toBeInstanceOf(Blob);
      expect(await (image as Blob).text()).toBe('png-bytes');
    });
  });
});

describe('AI usage-limit rejections', () => {
  it('supports Promise.all and repeated awaits without repeating inference', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');
    const direct = makeDirectAi();
    await envContext.run({ AI: direct.AI }, async () => {
      const first = ai.run('model', {});
      const second = ai.run('model', {});
      expect(first).toBeInstanceOf(Promise);
      expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
      expect(await first).toEqual({ ok: true });
      expect(direct.run).toHaveBeenCalledTimes(2);
    });
  });

  it('preserves ordinary inference failures', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');
    const error = new Error('network failed');
    const direct = makeDirectAi({
      run: () => {
        throw error;
      },
    });
    await envContext.run({ AI: direct.AI }, async () => {
      await expect(ai.run('model', {})).rejects.toBe(error);
    });
  });

  it.each(['run', 'stream'] as const)(
    'returns an unhandled %s limit as HTTP 429',
    async (method) => {
      vi.resetModules();
      const { Hono } = await import('hono');
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');
      const { createHttpRouteHandler } = await import('../../src/runtime/routing.ts');
      const { createErrorRenderer } = await import('../../src/runtime/routing-errors.ts');
      const direct = makeDirectAi({
        run: () => Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }),
      });
      const app = new Hono();
      app.onError(createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError);
      app.post(
        '/ai',
        createHttpRouteHandler(async () => ({ POST: () => ai[method]('model', {}) }), 'POST'),
      );
      await envContext.run({ AI: direct.AI }, async () => {
        const response = await app.request('/ai', { method: 'POST' });
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBeTruthy();
        expect(await response.json()).toMatchObject({
          code: 'usage_limit',
          resource: 'ai',
          reason: 'rate_limit',
        });
      });
    },
  );

  it.each(['run', 'stream', 'image', 'models', 'toMarkdown', 'provider'] as const)(
    'rejects %s quota failures with UsageLimit',
    async (method) => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env-raw.ts');
      const { ai } = await import('../../src/runtime/ai.ts');
      const { UsageLimit } = await import('../../src/runtime/limits.ts');
      const fetch = vi.fn(async () =>
        Response.json(
          {
            code: 'usage_limit',
            resource: 'ai',
            reason: 'monthly_quota',
            message: 'AI allowance exhausted',
          },
          { status: 429 },
        ),
      );
      await envContext.run(
        {
          __VOID_PROXY: { fetch },
          __PROJECT_ID: 'p',
          __VOID_PROXY_TOKEN: 't',
          OPENAI_API_KEY: 'test',
        },
        async () => {
          const op =
            method === 'provider'
              ? ai.provider('openai').fetch('/chat/completions')
              : method === 'models'
                ? ai.models()
                : method === 'toMarkdown'
                  ? ai.toMarkdown({ name: 'test.txt', blob: new Blob(['text']) })
                  : ai[method]('model', {});
          expect(op).toBeInstanceOf(Promise);
          await expect(op).rejects.toBeInstanceOf(UsageLimit);
          await expect(op).rejects.toMatchObject({
            resource: 'ai',
            reason: 'monthly_quota',
            message: 'AI allowance exhausted',
          });
          expect(fetch).toHaveBeenCalledOnce();
        },
      );
    },
  );
});

it('preserves a quota interruption after streaming has started in a terminal event', async () => {
  vi.resetModules();
  const { envContext } = await import('../../src/runtime/env-raw.ts');
  const { ai } = await import('../../src/runtime/ai.ts');
  const { UsageLimit } = await import('../../src/runtime/limits.ts');
  const limit = new UsageLimit({ resource: 'ai', reason: 'rate_limit', message: 'Provider limit' });
  const body = new ReadableStream({
    pull(controller) {
      controller.error(limit);
    },
  });
  await envContext.run({ AI: makeDirectAi({ run: () => body }).AI }, async () => {
    const response = await ai.stream('model', {});
    const text = await response.text();
    expect(text).toContain('event: void:limit');
    expect(text).toContain('Provider limit');
    expect(text).toContain('"reason":"rate_limit"');
  });
});

it.each(['run', 'stream', 'image'] as const)(
  'handles native %s quotas before the binding discards the HTTP status',
  async (method) => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');
    const direct = makeDirectAi({
      run: () =>
        Response.json(
          { errors: [{ code: 3036, message: 'Account limited' }] },
          { status: 429, headers: { 'Retry-After': '60' } },
        ),
    });
    await envContext.run({ AI: direct.AI }, async () => {
      const { UsageLimit } = await import('../../src/runtime/limits.ts');
      const result = ai[method]('model', {});
      await expect(result).rejects.toBeInstanceOf(UsageLimit);
      await expect(result).rejects.toMatchObject({
        resource: 'ai',
        reason: 'rate_limit',
        retryAt: expect.any(String),
      });
    });
  },
);

it('decodes native JSON responses and preserves explicitly requested raw responses', async () => {
  vi.resetModules();
  const { envContext } = await import('../../src/runtime/env-raw.ts');
  const { ai } = await import('../../src/runtime/ai.ts');
  const direct = makeDirectAi({ run: () => Response.json({ response: 'hello' }) });
  await envContext.run({ AI: direct.AI }, async () => {
    expect(await ai.run('model', {})).toEqual({ response: 'hello' });
    expect(await ai.run('model', {}, { returnRawResponse: true })).toBeInstanceOf(Response);
  });
});
