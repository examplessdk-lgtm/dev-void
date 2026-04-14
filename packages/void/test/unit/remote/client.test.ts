import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProxyClient } from '../../../src/runtime/remote/client';

const PROXY_URL = 'https://proxy.void.cloud';
const TOKEN = 'test-jwt-token';
const PROJECT_ID = 'proj_1';

describe('ProxyClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('fetch()', () => {
    it('sends correct headers and injects projectId into body', async () => {
      globalThis.fetch = vi.fn(async () => Response.json({ results: [] })) as any;

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
      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.projectId).toBe(PROJECT_ID);
      expect(body.binding).toBe('DB');
      expect(body.sql).toBe('SELECT 1');
    });

    it('throws on non-OK responses with error message from body', async () => {
      globalThis.fetch = vi.fn(
        async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
      ) as any;

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await expect(client.fetch('/d1/query', { binding: 'MISSING' })).rejects.toThrow(
        /Remote proxy error \(404\)/,
      );
    });

    it('returns response for successful requests', async () => {
      globalThis.fetch = vi.fn(async () =>
        Response.json({ results: [{ id: 1 }], success: true }),
      ) as any;

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
      globalThis.fetch = vi.fn(
        async () =>
          new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }),
      ) as any;

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
      globalThis.fetch = vi.fn(async () => Response.json({ ok: true })) as any;

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await client.stream('/r2/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ binding: 'STORAGE', key: 'file.txt' }),
      });

      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
      // Verify projectId was injected into body
      const body = JSON.parse(call[1].body);
      expect(body.projectId).toBe(PROJECT_ID);
    });

    it('throws on non-OK responses', async () => {
      globalThis.fetch = vi.fn(async () => new Response('server error', { status: 502 })) as any;

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
