import type { ProxyClient } from './client';

/**
 * R2Bucket implementation backed by the remote proxy.
 * Used during local development when `remote: true` is set in void.json.
 */
export class ProxyR2Bucket {
  constructor(
    private client: ProxyClient,
    private binding: string,
  ) {}

  async head(key: string): Promise<R2Object | null> {
    const res = await this.client.fetch('/r2/head', {
      binding: this.binding,
      key,
    });
    const data = (await res.json()) as {
      key: string;
      size: number;
      etag: string;
      lastModified: string;
      contentType: string;
    } | null;
    if (!data) {
      return null;
    }
    return makeR2Object(data);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const res = await this.client.stream('/r2/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ binding: this.binding, key }),
    });

    // Check if the proxy returned null (JSON response for 404).
    // Clone first so we don't consume the body if the object exists.
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const clone = res.clone();
      const data = await clone.json();
      if (data === null) {
        return null;
      }
    }

    return makeR2ObjectBody(key, res);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    // For V1, send as base64 or text in JSON body
    let base64: string | undefined;
    let textValue: string | undefined;

    if (typeof value === 'string') {
      textValue = value;
    } else if (value === null) {
      textValue = '';
    } else if (value instanceof ArrayBuffer) {
      base64 = arrayBufferToBase64(value);
    } else if (ArrayBuffer.isView(value)) {
      base64 = arrayBufferToBase64(value.buffer as ArrayBuffer);
    } else if (value instanceof Blob) {
      base64 = arrayBufferToBase64(await value.arrayBuffer());
    } else {
      // ReadableStream — read it all
      const reader = value.getReader();
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
      base64 = arrayBufferToBase64(merged.buffer as ArrayBuffer);
    }

    const body: Record<string, unknown> = {
      binding: this.binding,
      key,
    };
    if (base64) {
      body.base64 = base64;
    } else {
      body.value = textValue;
    }
    if (options?.httpMetadata) {
      const meta = options.httpMetadata;
      if (meta instanceof Headers) {
        body.contentType = meta.get('content-type') ?? undefined;
      } else {
        body.contentType = meta.contentType;
      }
    }
    if (options?.customMetadata) {
      body.customMetadata = options.customMetadata;
    }

    await this.client.fetch('/r2/put', body);

    // Return a minimal R2Object
    return makeR2Object({
      key,
      size: 0,
      etag: '',
      lastModified: new Date().toISOString(),
      contentType: 'application/octet-stream',
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    const body: Record<string, unknown> = { binding: this.binding };
    if (Array.isArray(keys)) {
      body.keys = keys;
    } else {
      body.key = keys;
    }
    await this.client.fetch('/r2/delete', body);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const res = await this.client.fetch('/r2/list', {
      binding: this.binding,
      prefix: options?.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
      delimiter: options?.delimiter,
    });
    const data = (await res.json()) as {
      objects: { key: string; size: number; lastModified: string }[];
      truncated: boolean;
      cursor: string | null;
    };

    return {
      objects: data.objects.map((o) =>
        makeR2Object({
          key: o.key,
          size: o.size,
          etag: '',
          lastModified: o.lastModified,
          contentType: 'application/octet-stream',
        }),
      ),
      truncated: data.truncated,
      cursor: data.cursor ?? undefined,
      delimitedPrefixes: [],
    } as R2Objects;
  }

  createMultipartUpload(): never {
    throw new Error('createMultipartUpload() is not supported with remote bindings');
  }

  resumeMultipartUpload(): never {
    throw new Error('resumeMultipartUpload() is not supported with remote bindings');
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function makeR2Object(data: {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
  contentType: string;
}): R2Object {
  return {
    key: data.key,
    version: '',
    size: data.size,
    etag: data.etag,
    httpEtag: data.etag ? `"${data.etag}"` : '',
    checksums: { toJSON: () => ({}) } as R2Checksums,
    uploaded: new Date(data.lastModified || Date.now()),
    httpMetadata: { contentType: data.contentType },
    customMetadata: {},
    storageClass: 'Standard',
    range: undefined,
    writeHttpMetadata(_headers: Headers) {
      // no-op for remote proxy
    },
  } as R2Object;
}

function makeR2ObjectBody(key: string, res: Response): R2ObjectBody {
  const size = parseInt(res.headers.get('content-length') ?? '0');
  const etag = res.headers.get('etag') ?? '';
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const lastModified = res.headers.get('last-modified') ?? new Date().toISOString();

  const obj = makeR2Object({ key, size, etag, lastModified, contentType });

  return {
    ...obj,
    body: res.body!,
    get bodyUsed() {
      return res.bodyUsed;
    },
    arrayBuffer: () => res.arrayBuffer(),
    bytes: async () => new Uint8Array(await res.arrayBuffer()),
    text: () => res.text(),
    json: <T>() => res.json() as Promise<T>,
    blob: () => res.blob(),
  } as R2ObjectBody;
}
