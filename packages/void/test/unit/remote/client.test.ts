import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProxyClient } from '../../../src/runtime/remote/client';

const PROXY_URL = 'https://proxy.void.cloud';
const TOKEN = 'test-jwt-token';
const PROJECT_ID = 'proj_1';

function setFetchMock(factory: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(factory);
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('ProxyClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('fetch()', () => {
    it('sends correct headers and injects projectId into body', async () => {
      const fetchMock = setFetchMock(async () => Response.json({ results: [] }));

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await client.fetch('/d1/query', { binding: 'DB', sql: 'SELECT 1' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${PROXY_URL}/d1/query`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          }),
        }),
      );

      // Verify projectId was injected into body
      const call = fetchMock.mock.calls[0];
      expect(call).toBeDefined();
      if (!call) {
        throw new Error('Expected fetch to be called');
      }
      const [, init] = call as unknown as [RequestInfo | URL, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.projectId).toBe(PROJECT_ID);
      expect(body.binding).toBe('DB');
      expect(body.sql).toBe('SELECT 1');
    });

    it('throws on non-OK responses with error message from body', async () => {
      setFetchMock(
        async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
      );

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await expect(client.fetch('/d1/query', { binding: 'MISSING' })).rejects.toThrow(
        /Remote proxy error \(404\)/,
      );
    });

    it('returns response for successful requests', async () => {
      setFetchMock(async () =>
        Response.json({ results: [{ id: 1 }], success: true }),
      );

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      const res = await client.fetch('/d1/query', { binding: 'DB', sql: 'SELECT 1' });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as { results: unknown[] };
      expect(data.results).toEqual([{ id: 1 }]);
    });
  });

  describe('stream()', () => {
    it('returns raw Response for streaming', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'));
          controller.close();
        },
      });
      setFetchMock(
        async () =>
          new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }),
      );

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      const res = await client.stream('/r2/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ binding: 'STORAGE', key: 'file.txt' }),
      });

      expect(res.ok).toBe(true);
      const text = await res.text();
      expect(text).toBe('chunk1');
    });

    it('injects Authorization header and projectId into body', async () => {
      const fetchMock = setFetchMock(async () => Response.json({ ok: true }));

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await client.stream('/r2/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ binding: 'STORAGE', key: 'file.txt' }),
      });

      const call = fetchMock.mock.calls[0];
      expect(call).toBeDefined();
      if (!call) {
        throw new Error('Expected fetch to be called');
      }
      const [, init] = call as unknown as [RequestInfo | URL, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      // Verify projectId was injected into body
      const body = JSON.parse(String(init.body));
      expect(body.projectId).toBe(PROJECT_ID);
    });

    it('throws on non-OK responses', async () => {
      setFetchMock(async () => new Response('server error', { status: 502 }));

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await expect(
        client.stream('/r2/get', {
          method: 'POST',
          body: JSON.stringify({ binding: 'STORAGE', key: 'file.txt' }),
        }),
      ).rejects.toThrow(/Remote proxy error \(502\)/);
    });
  });
});
