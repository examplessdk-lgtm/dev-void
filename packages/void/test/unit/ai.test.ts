import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ai } from '../../src/runtime/ai';

describe('runtime ai', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('routes third-party image generation through the gateway endpoint', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw');
    const { ai } = await import('../../src/runtime/ai');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: 'abc123' }] }), {
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
        const response = await ai.image('openai/gpt-image-1.5', {
          prompt: 'a small robot',
          size: '1024x1024',
        });

        expect(await response.json()).toEqual({ data: [{ b64_json: 'abc123' }] });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/gateway');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'gateway',
      endpoint: 'images/generations',
      model: 'openai/gpt-image-1.5',
      inputs: { prompt: 'a small robot', size: '1024x1024' },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('types image edit calls by endpoint', () => {
    type ImageMethod = typeof ai.image;
    const image = undefined as unknown as ImageMethod;

    const assertTypes = () => {
      image('openai/gpt-image-1.5', { prompt: 'a small robot', size: '1024x1024' });
      image(
        'openai/gpt-image-1.5',
        {
          prompt: 'change the background',
          image: new Blob(['png-bytes'], { type: 'image/png' }),
        },
        { endpoint: 'images/edits' },
      );

      image(
        'openai/gpt-image-1.5',
        { prompt: 'change the background', image: 'not-a-file' },
        {
          // @ts-expect-error - image edits require file-like image inputs.
          endpoint: 'images/edits',
        },
      );
      image(
        'openai/gpt-image-1.5',
        { prompt: 'change the background' },
        {
          // @ts-expect-error - generation inputs cannot use the edit endpoint.
          endpoint: 'images/edits',
        },
      );
    };

    expectTypeOf(assertTypes).toBeFunction();
    expectTypeOf(image).toBeFunction();
  });

  it('serializes third-party image edit files for the gateway endpoint', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw');
    const { ai } = await import('../../src/runtime/ai');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: 'edited' }] }), {
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
        const response = await ai.image(
          'openai/gpt-image-1.5',
          {
            prompt: 'change the background',
            image: [
              new Blob(['png-bytes'], { type: 'image/png' }),
              {
                data: 'c2Vjb25kLXBuZw==',
                name: 'source-2.png',
                type: 'image/png',
              },
            ],
            mask: new Uint8Array([1, 2]),
          },
          { endpoint: 'images/edits' },
        );

        expect(await response.json()).toEqual({ data: [{ b64_json: 'edited' }] });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1]!;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      action: 'gateway',
      endpoint: 'images/edits',
      model: 'openai/gpt-image-1.5',
      inputs: {
        prompt: 'change the background',
        image: [
          {
            __voidFile: true,
            data: 'cG5nLWJ5dGVz',
            type: 'image/png',
          },
          {
            __voidFile: true,
            data: 'c2Vjb25kLXBuZw==',
            name: 'source-2.png',
            type: 'image/png',
          },
        ],
        mask: {
          __voidFile: true,
          data: 'AQI=',
          type: 'application/octet-stream',
        },
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('returns blobs for non-JSON run responses', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw');
    const { ai } = await import('../../src/runtime/ai');

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
});
