import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { compileWorkerClient } from '../../src/router/compile';

describe('compileWorkerClient', () => {
  it('generates module with fetch function and FetchError class', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('import app, { requestContext } from "virtual:void-routes"');
    expect(code).toContain('import { env } from "cloudflare:workers"');
    expect(code).toContain('export class FetchError');
    expect(code).toContain('export async function fetch');
  });

  it('re-exports auth helpers from resolved path', () => {
    const code = compileWorkerClient('/my/path/auth-client.mjs');
    expect(code).toContain('export { auth, createAuthClient } from "/my/path/auth-client.mjs"');
  });

  it('includes param interpolation logic', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('encodeURIComponent');
    expect(code).toContain('url.replace(":" + key');
  });

  it('includes query string building', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('URLSearchParams');
  });

  it('includes cookie and authorization forwarding from ALS', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('requestContext.getStore()');
    expect(code).toContain('"cookie"');
    expect(code).toContain('"authorization"');
  });

  it('includes executionCtx passthrough with no-op fallback', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('store?.executionCtx');
    expect(code).toContain('waitUntil()');
    expect(code).toContain('passThroughOnException()');
  });

  it('handles 204 No Content', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('response.status === 204');
    expect(code).toContain('return undefined');
  });
});

/**
 * Runtime behavior tests — exercise the worker fetch logic directly.
 * We create standalone functions that replicate the generated module's behavior,
 * avoiding the need to eval() generated code with virtual module imports.
 */
describe('worker fetch runtime behavior', () => {
  // Replicate the generated FetchError class
  class FetchError extends Error {
    status: number;
    statusText: string;
    data: unknown;
    constructor(status: number, statusText: string, data: unknown) {
      super(`Request failed with status ${status}`);
      this.name = 'FetchError';
      this.status = status;
      this.statusText = statusText;
      this.data = data;
    }
  }

  const requestContext = new AsyncLocalStorage<{
    request: Request;
    executionCtx: { waitUntil: (...args: unknown[]) => void; passThroughOnException: () => void };
  }>();

  // Mock app.fetch — records calls and returns configurable responses
  let mockAppFetch: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>;
  let mockEnv: Record<string, unknown>;

  // Replicate the generated fetch function
  async function workerFetch(path: string, options?: Record<string, unknown>): Promise<unknown> {
    let url = path;
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params as Record<string, string>)) {
        url = url.replace(':' + key, encodeURIComponent(value));
      }
    }

    if (options?.query) {
      const qs = new URLSearchParams(options.query as Record<string, string>).toString();
      if (qs) {
        url += '?' + qs;
      }
    }

    const method = (options?.method as string) ?? 'GET';
    const headers = new Headers(options?.headers as HeadersInit | undefined);

    const store = requestContext.getStore();
    if (store?.request) {
      const outerReq = store.request;
      if (!headers.has('cookie')) {
        const cookie = outerReq.headers.get('cookie');
        if (cookie) {
          headers.set('cookie', cookie);
        }
      }
      if (!headers.has('authorization')) {
        const auth = outerReq.headers.get('authorization');
        if (auth) {
          headers.set('authorization', auth);
        }
      }
    }

    if (options?.body != null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const request = new Request('http://worker.local' + url, {
      method,
      headers,
      body: options?.body != null ? JSON.stringify(options.body) : undefined,
    });

    const executionCtx = store?.executionCtx ?? {
      waitUntil() {},
      passThroughOnException() {},
    };
    const response = (await mockAppFetch(request, mockEnv, executionCtx)) as Response;

    if (response.status === 204) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new FetchError(response.status, response.statusText, data);
    }

    return data;
  }

  beforeEach(() => {
    mockAppFetch = vi.fn();
    mockEnv = { DB: {} };
  });

  it('makes a GET request by default', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await workerFetch('/api/hello');

    expect(result).toEqual({ ok: true });
    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe('GET');
    expect(new URL(req.url).pathname).toBe('/api/hello');
  });

  it('interpolates path params', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: '42' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/users/:id', { params: { id: '42' } });

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(new URL(req.url).pathname).toBe('/api/users/42');
  });

  it('encodes path params', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({}), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/files/:name', { params: { name: 'hello world.txt' } });

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(new URL(req.url).pathname).toBe('/api/files/hello%20world.txt');
  });

  it('builds query string', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/users', { query: { page: '1', limit: '10' } });

    const req = mockAppFetch.mock.calls[0][0] as Request;
    const url = new URL(req.url);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('serializes body as JSON', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ created: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/users', { method: 'POST', body: { name: 'Alice' } });

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toBe('application/json');
    expect(await req.json()).toEqual({ name: 'Alice' });
  });

  it('throws FetchError on non-OK response', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const err = await workerFetch('/api/hello').catch((e: Error) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(404);
    expect((err as FetchError).statusText).toBe('Not Found');
    expect((err as FetchError).data).toEqual({ error: 'not found' });
  });

  it('returns undefined for 204 No Content', async () => {
    mockAppFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await workerFetch('/api/items/:id', { method: 'DELETE', params: { id: '1' } });
    expect(result).toBeUndefined();
  });

  it('returns text for non-JSON responses', async () => {
    mockAppFetch.mockResolvedValue(
      new Response('Hello World', {
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await workerFetch('/api/hello');
    expect(result).toBe('Hello World');
  });

  it('forwards cookie from outer request via ALS', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outerRequest = new Request('http://example.com', {
      headers: { cookie: 'session=abc123' },
    });

    await requestContext.run(
      {
        request: outerRequest,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
      () => workerFetch('/api/hello'),
    );

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('cookie')).toBe('session=abc123');
  });

  it('forwards authorization from outer request via ALS', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outerRequest = new Request('http://example.com', {
      headers: { authorization: 'Bearer token123' },
    });

    await requestContext.run(
      {
        request: outerRequest,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
      () => workerFetch('/api/hello'),
    );

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer token123');
  });

  it('user headers override forwarded headers', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outerRequest = new Request('http://example.com', {
      headers: { cookie: 'outer=old', authorization: 'Bearer outer' },
    });

    await requestContext.run(
      {
        request: outerRequest,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
      () =>
        workerFetch('/api/hello', {
          headers: { cookie: 'custom=value', authorization: 'Bearer custom' },
        }),
    );

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('cookie')).toBe('custom=value');
    expect(req.headers.get('authorization')).toBe('Bearer custom');
  });

  it('passes real executionCtx from ALS', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const waitUntilFn = vi.fn();
    const ctx = { waitUntil: waitUntilFn, passThroughOnException() {} };
    const outerRequest = new Request('http://example.com');

    await requestContext.run({ request: outerRequest, executionCtx: ctx }, () =>
      workerFetch('/api/hello'),
    );

    const passedCtx = mockAppFetch.mock.calls[0][2];
    expect(passedCtx).toBe(ctx);
  });

  it('uses no-op executionCtx when ALS has no context', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/hello');

    const passedCtx = mockAppFetch.mock.calls[0][2] as {
      waitUntil: () => void;
      passThroughOnException: () => void;
    };
    expect(passedCtx.waitUntil).toBeTypeOf('function');
    expect(passedCtx.passThroughOnException).toBeTypeOf('function');
    // Should not throw
    passedCtx.waitUntil();
    passedCtx.passThroughOnException();
  });

  it('passes env from worker bindings', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/hello');

    const passedEnv = mockAppFetch.mock.calls[0][1];
    expect(passedEnv).toBe(mockEnv);
  });
});
