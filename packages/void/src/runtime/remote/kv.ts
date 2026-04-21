import type { ProxyClient } from './client';

/**
 * KVNamespace implementation backed by the remote proxy.
 * Used during local development when `remote: true` is set in void.json.
 */
export class ProxyKVNamespace {
  private normalizeGetOptions(
    options?: { type?: string } | string,
  ): string | { type: 'json' | 'text' | 'arrayBuffer' | 'stream' } | undefined {
    if (typeof options === 'string') {
      return options;
    }
    if (
      options?.type === 'json' ||
      options?.type === 'text' ||
      options?.type === 'arrayBuffer' ||
      options?.type === 'stream'
    ) {
      return { type: options.type };
    }
    return undefined;
  }

  constructor(
    private client: ProxyClient,
    private binding: string,
  ) {}

  async get(key: string): Promise<string | null>;
  async get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  async get(key: string, type: 'text'): Promise<string | null>;
  async get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  async get(key: string, type: 'stream'): Promise<ReadableStream | null>;
  async get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  async get(key: string, options: { type: 'text' }): Promise<string | null>;
  async get(key: string, options: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null>;
  async get(key: string, options: { type: 'stream' }): Promise<ReadableStream | null>;
  async get(
    key: string,
    options?: { type?: string } | string,
  ): Promise<string | ArrayBuffer | ReadableStream | unknown | null> {
    const type = typeof options === 'string' ? options : (options?.type ?? 'text');
    const res = await this.client.fetch('/kv/get', {
      binding: this.binding,
      key,
      type,
    });

    // The proxy returns JSON `null` (200, application/json) for missing keys
    // regardless of the requested type. Check for null before type conversion.
    const ct = res.headers.get('content-type') ?? '';
    if (type === 'arrayBuffer' || type === 'stream') {
      // For binary types, the proxy returns application/octet-stream for real values
      // but application/json for null. Check content-type to detect null responses.
      if (ct.includes('application/json')) {
        const data = await res.json();
        if (data === null) {
          return null;
        }
        // Non-null JSON response for binary type — shouldn't happen, but handle gracefully
        const encoded = new TextEncoder().encode(JSON.stringify(data));
        return type === 'arrayBuffer'
          ? encoded.buffer
          : new ReadableStream({
              start(controller) {
                controller.enqueue(encoded);
                controller.close();
              },
            });
      }
      if (type === 'arrayBuffer') {
        return res.arrayBuffer();
      }
      return res.body;
    }

    // text and json are returned as JSON by the proxy
    return res.json();
  }

  async getWithMetadata<T = string, M = unknown>(
    key: string,
    options?: { type?: string } | string,
  ): Promise<{ value: T | null; metadata: M | null; cacheStatus: null }> {
    const normalized = this.normalizeGetOptions(options);
    let value: T | null;
    switch (typeof normalized === 'string' ? normalized : normalized?.type) {
      case 'json':
        value = (await this.get(key, 'json')) as T | null;
        break;
      case 'text':
        value = (await this.get(key, 'text')) as T | null;
        break;
      case 'arrayBuffer':
        value = (await this.get(key, 'arrayBuffer')) as T | null;
        break;
      case 'stream':
        value = (await this.get(key, 'stream')) as T | null;
        break;
      default:
        value = (await this.get(key)) as T | null;
        break;
    }
    // The proxy doesn't support metadata retrieval via REST API in V1
    return { value, metadata: null, cacheStatus: null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void> {
    let serializedValue: unknown;
    let isBase64 = false;
    if (typeof value === 'string') {
      serializedValue = value;
    } else if (value instanceof ArrayBuffer) {
      // Base64-encode binary data for JSON transport
      const bytes = new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      serializedValue = btoa(binary);
      isBase64 = true;
    } else {
      // ReadableStream — read it all and base64-encode
      const reader = (value as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(chunk);
      }
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      let binary = '';
      for (const byte of merged) {
        binary += String.fromCharCode(byte);
      }
      serializedValue = btoa(binary);
      isBase64 = true;
    }

    const body: Record<string, unknown> = {
      binding: this.binding,
      key,
      value: serializedValue,
      ...(isBase64 && { base64: true }),
    };
    if (options?.expiration) {
      body.expiration = options.expiration;
    }
    if (options?.expirationTtl) {
      body.expiration_ttl = options.expirationTtl;
    }
    if (options?.metadata) {
      body.metadata = options.metadata;
    }
    await this.client.fetch('/kv/put', body);
  }

  async delete(key: string): Promise<void> {
    await this.client.fetch('/kv/delete', { binding: this.binding, key });
  }

  async list<M = unknown>(
    options?: KVNamespaceListOptions,
  ): Promise<KVNamespaceListResult<M, string>> {
    const res = await this.client.fetch('/kv/list', {
      binding: this.binding,
      prefix: options?.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
    });
    return (await res.json()) as KVNamespaceListResult<M, string>;
  }
}
