import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { createBindingHandler } from '../../../src/runtime/remote/binding-handler.ts';
import { ProxyClient } from '../../../src/runtime/remote/client.ts';
import { ProxyR2Bucket } from '../../../src/runtime/remote/r2.ts';

function createClient() {
  return new ProxyClient('https://proxy.void.cloud', 'jwt-token', 'proj_1');
}

function mockFetch(response: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { 'content-type': contentType },
      }),
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('ProxyR2Bucket', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('head()', () => {
    it('returns R2Object with metadata', async () => {
      mockFetch({
        key: 'file.txt',
        size: 1024,
        etag: 'abc123',
        lastModified: '2024-01-01T00:00:00Z',
        contentType: 'text/plain',
      });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.head('file.txt');

      expect(obj).not.toBeNull();
      expect(obj!.key).toBe('file.txt');
      expect(obj!.size).toBe(1024);
      expect(obj!.etag).toBe('abc123');
    });

    it('returns null for missing key', async () => {
      mockFetch(null);

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.head('missing.txt');

      expect(obj).toBeNull();
    });
  });

  describe('get()', () => {
    it('returns R2ObjectBody with stream for existing object', async () => {
      const body = 'file contents here';
      const fetchMock = vi.fn(
        async () =>
          new Response(body, {
            headers: {
              'content-type': 'text/plain',
              'content-length': String(body.length),
              etag: 'abc123',
            },
          }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.get('file.txt');

      expect(obj).not.toBeNull();
      expect(obj!.key).toBe('file.txt');
      expect(obj!.size).toBe(body.length);
      const text = await obj!.text();
      expect(text).toBe('file contents here');
    });

    it('returns null for missing key', async () => {
      mockFetch(null);

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.get('missing.txt');

      expect(obj).toBeNull();
    });
  });

  describe('put()', () => {
    it('rejects malformed conditions before calling R2', async () => {
      const put = vi.fn();
      const handler = createBindingHandler({ __VOID_PROXY_TOKEN: 'internal', STORAGE: { put } });
      const response = await handler.request('/r2/put-conditional', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': 'internal' },
        body: JSON.stringify({
          binding: 'STORAGE',
          key: 'key',
          value: 'new',
          onlyIf: { uploadedAfter: 'invalid' },
        }),
      });
      expect(response.status).toBe(400);
      expect(put).not.toHaveBeenCalled();
    });

    it.each(['object', 'headers'] as const)(
      'preserves %s conditions and a rejected write through the binding handler',
      async (kind) => {
        const put = vi.fn(async () => null);
        const handler = createBindingHandler({ __VOID_PROXY_TOKEN: 'internal', STORAGE: { put } });
        const requests: Array<string> = [];
        globalThis.fetch = vi.fn(async (input, init) => {
          const path = new URL(String(input)).pathname;
          requests.push(path);
          return handler.request(path, {
            ...init,
            headers: { 'content-type': 'application/json', 'x-void-internal': 'internal' },
          });
        }) as typeof fetch;
        const before = new Date('2026-01-01T00:00:00Z');
        const onlyIf =
          kind === 'headers'
            ? new Headers({ 'if-match': 'old' })
            : { etagMatches: 'old', uploadedBefore: before, secondsGranularity: true };
        const result = await new ProxyR2Bucket(createClient(), 'STORAGE').put('key', 'new', {
          onlyIf,
        });
        expect(requests).toEqual(['/r2/put-conditional']);
        expect(result).toBeNull();
        const options = (put.mock.calls[0] as unknown as [string, unknown, R2PutOptions])[2];
        if (kind === 'headers') {
          expect((options.onlyIf as Headers).get('if-match')).toBe('old');
        } else {
          expect(options.onlyIf).toEqual(onlyIf);
          expect((options.onlyIf as R2Conditional).uploadedBefore).toBeInstanceOf(Date);
        }
      },
    );

    it('returns actual metadata from a successful conditional put', async () => {
      mockFetch({
        key: 'file.txt',
        size: 5,
        etag: 'new-etag',
        version: 'v1',
        lastModified: '2026-01-01T00:00:00Z',
        contentType: 'text/plain',
        customMetadata: { owner: 'me' },
      });
      const result = await new ProxyR2Bucket(createClient(), 'STORAGE').put('file.txt', 'hello', {
        onlyIf: { etagDoesNotMatch: '*' },
      });
      expect(result).toMatchObject({
        size: 5,
        etag: 'new-etag',
        version: 'v1',
        customMetadata: { owner: 'me' },
      });
    });

    it.each([
      ['typed array slice', () => new Uint8Array([9, 1, 2, 8]).subarray(1, 3), [1, 2]],
      ['DataView', () => new DataView(new Uint8Array([9, 1, 2, 8]).buffer, 1, 2), [1, 2]],
      ['pooled Buffer', () => Buffer.from([9, 1, 2, 8]).subarray(1, 3), [1, 2]],
      ['empty view', () => new Uint8Array([9, 8]).subarray(1, 1), []],
    ] as const)('uploads only the bytes in a %s', async (_name, makeValue, expected) => {
      mockFetch({ success: true });
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('binary.bin', makeValue());

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(typeof body.base64).toBe('string');
      expect(Array.from(Buffer.from(body.base64, 'base64'))).toEqual(expected);
    });

    it('sends string value as text', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.put('file.txt', 'hello world');

      expect(result).not.toBeNull();
      expect(result!.key).toBe('file.txt');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.key).toBe('file.txt');
      expect(body.value).toBe('hello world');
      expect(body.binding).toBe('STORAGE');
    });

    it('sends ArrayBuffer value as base64', async () => {
      mockFetch({ success: true });

      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('binary.bin', data.buffer as ArrayBuffer);

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.base64).toBe(btoa('Hello'));
    });

    it('sends httpMetadata.contentType', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('file.json', '{"a":1}', {
        httpMetadata: { contentType: 'application/json' },
      });

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.contentType).toBe('application/json');
    });
  });

  describe('delete()', () => {
    it('deletes single key', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.delete('file.txt');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.key).toBe('file.txt');
    });

    it('deletes multiple keys', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.delete(['a.txt', 'b.txt']);

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.keys).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('list()', () => {
    it('returns objects and pagination info', async () => {
      mockFetch({
        objects: [
          { key: 'file1.txt', size: 100, lastModified: '2024-01-01T00:00:00Z' },
          { key: 'file2.txt', size: 200, lastModified: '2024-01-02T00:00:00Z' },
        ],
        truncated: false,
        cursor: null,
      });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.list({ prefix: 'files/' });

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].key).toBe('file1.txt');
      expect(result.objects[1].key).toBe('file2.txt');
      expect(result.truncated).toBe(false);
    });

    it('returns cursor when truncated', async () => {
      mockFetch({
        objects: [{ key: 'file1.txt', size: 100, lastModified: '' }],
        truncated: true,
        cursor: 'next-page',
      });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.list({ limit: 1 });

      expect(result.truncated).toBe(true);
      expect((result as typeof result & { cursor: string | null }).cursor).toBe('next-page');
    });
  });

  describe('unsupported methods', () => {
    it('createMultipartUpload throws', () => {
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      expect(() =>
        (
          r2 as ProxyR2Bucket & { createMultipartUpload(key: string): unknown }
        ).createMultipartUpload('key'),
      ).toThrow('not supported with remote bindings');
    });

    it('resumeMultipartUpload throws', () => {
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      expect(() =>
        (
          r2 as ProxyR2Bucket & {
            resumeMultipartUpload(key: string, uploadId: string): unknown;
          }
        ).resumeMultipartUpload('key', 'id'),
      ).toThrow('not supported with remote bindings');
    });
  });
});
