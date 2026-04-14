import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProxyClient } from '../../../src/runtime/remote/client';
import { ProxyR2Bucket } from '../../../src/runtime/remote/r2';

function createClient() {
  return new ProxyClient('https://proxy.void.cloud', 'jwt-token', 'proj_1');
}

function mockFetch(response: unknown, contentType = 'application/json') {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { 'content-type': contentType },
      }),
  ) as any;
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
      globalThis.fetch = vi.fn(
        async () =>
          new Response(body, {
            headers: {
              'content-type': 'text/plain',
              'content-length': String(body.length),
              etag: 'abc123',
            },
          }),
      ) as any;

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.get('file.txt');

      expect(obj).not.toBeNull();
      expect(obj!.key).toBe('file.txt');
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
    it('sends string value as text', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.put('file.txt', 'hello world');

      expect(result).not.toBeNull();
      expect(result!.key).toBe('file.txt');

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.key).toBe('file.txt');
      expect(body.value).toBe('hello world');
      expect(body.binding).toBe('STORAGE');
    });

    it('sends ArrayBuffer value as base64', async () => {
      mockFetch({ success: true });

      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('binary.bin', data.buffer as ArrayBuffer);

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.base64).toBe(btoa('Hello'));
    });

    it('sends httpMetadata.contentType', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('file.json', '{"a":1}', {
        httpMetadata: { contentType: 'application/json' },
      });

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.contentType).toBe('application/json');
    });
  });

  describe('delete()', () => {
    it('deletes single key', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.delete('file.txt');

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.key).toBe('file.txt');
    });

    it('deletes multiple keys', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.delete(['a.txt', 'b.txt']);

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
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
      expect((result as any).cursor).toBe('next-page');
    });
  });

  describe('unsupported methods', () => {
    it('createMultipartUpload throws', () => {
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      expect(() => (r2 as any).createMultipartUpload('key')).toThrow(
        'not supported with remote bindings',
      );
    });

    it('resumeMultipartUpload throws', () => {
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      expect(() => (r2 as any).resumeMultipartUpload('key', 'id')).toThrow(
        'not supported with remote bindings',
      );
    });
  });
});
