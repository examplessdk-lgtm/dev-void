import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { compileWorkerClient } from '../../src/router/compile.ts';
import { FetchError as RuntimeFetchError } from '../../src/runtime/fetch-error.ts';
import { interpolateRouteParams } from '../../src/runtime/route-url.ts';

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
});

// Evaluate the emitted module with only its import boundary substituted.
describe('worker fetch runtime behavior', () => {
  const requestContext = new AsyncLocalStorage<{
    request: Request;
    executionCtx: {
      waitUntil: (...args: Array<unknown>) => void;
      passThroughOnException: () => void;
    };
  }>();

  // Mock app.fetch — records calls and returns configurable responses
  let mockAppFetch: ReturnType<typeof vi.fn<(...args: Array<unknown>) => Promise<Response>>>;
  let mockEnv: Record<string, unknown>;

  let workerFetch: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  let FetchError: typeof RuntimeFetchError;

  beforeEach(() => {
    mockAppFetch = vi.fn();
    mockEnv = { DB: {} };
    ({ fetch: workerFetch, FetchError } = evaluateClient(
      compileWorkerClient,
      mockAppFetch,
      mockEnv,
      requestContext,
    ));
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
    expect((err as RuntimeFetchError).status).toBe(404);
    expect((err as RuntimeFetchError).statusText).toBe('Not Found');
    expect((err as RuntimeFetchError).data).toEqual({ error: 'not found' });
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

function evaluateClient(
  compile: typeof compileWorkerClient,
  fetch: (...args: Array<unknown>) => Promise<Response>,
  env: Record<string, unknown>,
  requestContext: Pick<AsyncLocalStorage<unknown>, 'getStore'>,
): {
  fetch: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  FetchError: typeof RuntimeFetchError;
} {
  const code = compile('/auth.mjs')
    .replace(/^(import .*|export \{.*)\n/gm, '')
    .replaceAll('export ', '');
  return new Function(
    'app',
    'env',
    'requestContext',
    'interpolateRouteParams',
    code + '\nreturn { fetch, FetchError };',
  )({ fetch }, env, requestContext, interpolateRouteParams);
}

it.each([false, true])(
  'expands catch-all routes in generated clients (nodeTarget: %s)',
  async (nodeTarget) => {
    const fetch = vi.fn<(...args: Array<unknown>) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );
    const compile = (authClientPath: string) => compileWorkerClient(authClientPath, nodeTarget);
    const client = evaluateClient(compile, fetch, {}, new AsyncLocalStorage());
    await client.fetch('/files/:id2/:id/:path{.+}', {
      params: { id: 'one', id2: 'two', path: 'docs/start here' },
    });
    const req = fetch.mock.calls[0]![0] as Request;
    expect(new URL(req.url).pathname).toBe('/files/two/one/docs/start%20here');
  },
);
