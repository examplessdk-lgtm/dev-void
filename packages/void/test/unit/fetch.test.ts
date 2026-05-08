import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import { fetch as typedFetch, FetchError } from '../../src/runtime/fetch.ts';

declare module 'void/routes' {
  interface RouteMap {
    '/api/hello': {
      GET: { input: {}; output: { ok: boolean } };
    };
    '/api/users': {
      GET: { input: {}; output: Array<{ id: string; name: string }> };
      POST: { input: { body: { name: string } }; output: { created: boolean } };
    };
    '/api/users/:id': {
      GET: { input: { params: { id: string } }; output: { id: string; name: string } };
    };
    '/api/files/:name': {
      GET: { input: { params: { name: string } }; output: Record<string, never> };
    };
    '/api/items/:id': {
      GET: { input: {}; output: { id: string } };
      DELETE: { input: {}; output: undefined };
    };
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

describe('typed fetch client', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('makes a GET request by default', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));

    const result = await typedFetch('/api/hello');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/hello',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('interpolates path params', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ id: '42', name: 'Alice' }));

    await typedFetch('/api/users/:id', { params: { id: '42' } });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/42'),
      expect.anything(),
    );
  });

  it('encodes path params', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}));

    await typedFetch('/api/files/:name', { params: { name: 'hello world.txt' } });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/files/hello%20world.txt'),
      expect.anything(),
    );
  });

  it('builds query string', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse([]));

    await typedFetch('/api/users', { query: { page: '1', limit: '10' } });

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('page=1');
    expect(url).toContain('limit=10');
  });

  it('serializes body as JSON', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ created: true }, 201));

    await typedFetch('/api/users', { method: 'POST', body: { name: 'Alice' } });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Alice' }));
    expect(new Headers(init.headers!).get('Content-Type')).toBe('application/json');
  });

  it('throws FetchError on non-OK response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    const err = await typedFetch('/api/hello', { retry: 0 }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(404);
  });

  it('returns undefined for 204 No Content', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const result = await typedFetch('/api/items/:id', { method: 'DELETE', params: { id: '1' } });
    expect(result).toBeUndefined();
  });

  it('type: output is correctly narrowed per route', () => {
    const _check = async () => {
      const hello = await typedFetch('/api/hello');
      // @ts-expect-error - 'missing' does not exist on { ok: boolean }
      void hello.missing;
      // @ts-expect-error - ok is boolean, toUpperCase exists only on string
      void hello.ok.toUpperCase();

      const users = await typedFetch('/api/users');
      // array methods are available
      void users.map;
      // @ts-expect-error - toFixed does not exist on array
      void users.toFixed();

      const user = await typedFetch('/api/users/:id', { params: { id: '1' } });
      // @ts-expect-error - 'email' does not exist on { id: string; name: string }
      void user.email;
    };
    void _check;
    expect(true).toBe(true); // compile-time type test
  });

  it('type: rejects invalid paths and methods', () => {
    // @ts-expect-error - "/api/nonexistent" is not in RouteMap
    void typedFetch('/api/nonexistent').catch(() => {});

    // @ts-expect-error - DELETE is not a valid method for /api/hello (only GET)
    void typedFetch('/api/hello', { method: 'DELETE' }).catch(() => {});

    // @ts-expect-error - PATCH is not a valid method for /api/users (only GET, POST)
    void typedFetch('/api/users', { method: 'PATCH' }).catch(() => {});

    expect(true).toBe(true); // compile-time type test
  });

  it('type: enforces input types for body and params', () => {
    const _check = async () => {
      // POST with correct body — compiles
      await typedFetch('/api/users', { method: 'POST', body: { name: 'Alice' } });

      // GET with correct params — compiles
      await typedFetch('/api/users/:id', { params: { id: '42' } });

      // DELETE with no required input — compiles
      await typedFetch('/api/items/:id', { method: 'DELETE' });

      // Extra options alongside typed input — compiles
      await typedFetch('/api/users', {
        method: 'POST',
        body: { name: 'Bob' },
        headers: { 'X-Test': '1' },
      });

      // @ts-expect-error - wrong body type (name should be string)
      await typedFetch('/api/users', { method: 'POST', body: { name: 123 } });

      // @ts-expect-error - missing body entirely on POST
      await typedFetch('/api/users', { method: 'POST' });

      // @ts-expect-error - missing required params (options required)
      await typedFetch('/api/users/:id');

      // @ts-expect-error - wrong params type (id should be string)
      await typedFetch('/api/users/:id', { params: { id: 123 } });
    };
    void _check;
    expect(true).toBe(true); // compile-time type test
  });
});
