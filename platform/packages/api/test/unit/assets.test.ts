import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import {
  applyDeclaredAssetManifest,
  AssetHashMismatchError,
  computeAssetHash,
  createAssetUploadSession,
  deleteUnreferencedAssets,
  deleteWorkerBundle,
  normalizeForCfAssetSession,
  persistWorkerBundle,
  replayWorkerBundle,
  uploadAssetBuckets,
  uploadStaticAssets,
  type AssetEntry,
} from '../../src/assets.ts';

const enc = new TextEncoder();
function entry(content: string | Uint8Array, contentType: string): AssetEntry {
  return {
    bytes: typeof content === 'string' ? enc.encode(content) : content,
    contentType,
  };
}

function createMockKV() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: vi.fn(async (key: string, _opts?: unknown) => store.get(key) ?? null),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    })),
    put: vi.fn(async (key: string, value: ArrayBuffer | string, _opts?: unknown) => {
      store.set(key, typeof value === 'string' ? new TextEncoder().encode(value).buffer : value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
  } as unknown as KVNamespace & { store: Map<string, ArrayBuffer> };
}

function createMockR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    put: vi.fn(async (key: string, value: ArrayBuffer, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (keys: string | Array<string>) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }),
    get: vi.fn(async (key: string) =>
      store.has(key)
        ? {
            body: new ReadableStream(),
            httpMetadata: {},
            size: 0,
            httpEtag: '"test"',
          }
        : null,
    ),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket & { store: Map<string, ArrayBuffer> };
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).buffer;
  }
  throw new Error('unsupported mock storage value');
}

async function readBodyText(body: unknown): Promise<string> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Array<Uint8Array> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
  if (typeof body === 'string') {
    return body;
  }
  throw new Error('unsupported body type');
}

/** Create a JWT with the given expiration time (Unix seconds). */
function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.fake-signature`;
}

const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('applyDeclaredAssetManifest', () => {
  it('prefers the declared entry when both hash and size match the built entry', () => {
    const bytes = enc.encode('hello');
    const hash = computeAssetHash(bytes.buffer, '/index.html');
    const built = { '/index.html': { hash, size: bytes.length } };
    const declared = { '/index.html': { hash, size: bytes.length } };

    const result = applyDeclaredAssetManifest(built, declared);

    expect(result).toEqual(built);
    expect(result['/index.html']).toBe(declared['/index.html']);
  });

  it('keeps the built entry when the declared size does not match', () => {
    const bytes = enc.encode('hello');
    const hash = computeAssetHash(bytes.buffer, '/index.html');
    const built = { '/index.html': { hash, size: bytes.length } };
    const declared = { '/index.html': { hash, size: bytes.length + 1 } };

    const result = applyDeclaredAssetManifest(built, declared);

    expect(result['/index.html']).toBe(built['/index.html']);
  });

  it('throws AssetHashMismatchError when the declared hash does not match the built hash', () => {
    const bytes = enc.encode('hello');
    const hash = computeAssetHash(bytes.buffer, '/index.html');
    const built = { '/index.html': { hash, size: bytes.length } };
    const declared = { '/index.html': { hash: 'a'.repeat(32), size: bytes.length } };

    expect(() => applyDeclaredAssetManifest(built, declared)).toThrow(AssetHashMismatchError);
  });
});

describe('uploadStaticAssets', () => {
  it('uploads small assets to KV and large assets to R2', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const assetsByHash = new Map<string, AssetEntry>([
      ['smallhash0000000000000000000000', entry('small file', 'text/html')],
      ['largehash0000000000000000000000', entry(new Uint8Array(KV_THRESHOLD + 1), 'video/mp4')],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test');

    expect(kv.put).toHaveBeenCalledTimes(1); // small asset
    expect(r2.put).toHaveBeenCalledTimes(1); // large asset
    expect(largeHashes.has('largehash0000000000000000000000')).toBe(true);
    expect(largeHashes.has('smallhash0000000000000000000000')).toBe(false);
  });

  it('overwrites assets that already exist in KV (idempotent puts)', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/existinghash000000000000000000', new ArrayBuffer(1));

    const assetsByHash = new Map<string, AssetEntry>([
      ['existinghash000000000000000000', entry('exists', 'text/html')],
      ['newhash00000000000000000000000', entry('new', 'text/css')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test');

    expect(kv.put).toHaveBeenCalledTimes(2); // both assets, no existence check
  });

  it('retries transient KV upload failures', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    let attempts = 0;
    vi.mocked(kv.put).mockImplementation(async (key, value, _opts) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('temporary KV failure');
      }
      kv.store.set(key, toArrayBuffer(value));
    });

    const assetsByHash = new Map<string, AssetEntry>([
      ['retryhash000000000000000000000', entry('retry', 'text/plain')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test', { retryDelayMs: 0 });

    expect(kv.put).toHaveBeenCalledTimes(2);
    expect(kv.store.has('assets/proj_test/retryhash000000000000000000000')).toBe(true);
  });

  it('overwrites assets that already exist in R2 (idempotent puts)', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    r2.store.set(
      'assets/proj_test/existinglarge00000000000000000',
      new ArrayBuffer(KV_THRESHOLD + 1),
    );

    const assetsByHash = new Map<string, AssetEntry>([
      ['existinglarge00000000000000000', entry(new Uint8Array(KV_THRESHOLD + 1), 'video/mp4')],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test');

    expect(r2.put).toHaveBeenCalledTimes(1); // idempotent put, no existence check
    expect(largeHashes.has('existinglarge00000000000000000')).toBe(true);
  });

  it('retries transient R2 upload failures', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    let attempts = 0;
    vi.mocked(r2.put).mockImplementation(async (key, value, _opts) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('temporary R2 failure');
      }
      r2.store.set(key, toArrayBuffer(value));
      return { key } as R2Object;
    });

    const assetsByHash = new Map<string, AssetEntry>([
      ['retrylarge00000000000000000000', entry(new Uint8Array(KV_THRESHOLD + 1), 'video/mp4')],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test', {
      retryDelayMs: 0,
    });

    expect(r2.put).toHaveBeenCalledTimes(2);
    expect(r2.store.has('assets/proj_test/retrylarge00000000000000000000')).toBe(true);
    expect(largeHashes.has('retrylarge00000000000000000000')).toBe(true);
  });

  it('scopes asset keys by project ID', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const assetsByHash = new Map<string, AssetEntry>([
      ['deadbeef12345678', entry('test', 'text/plain')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_abc123');

    expect(kv.put).toHaveBeenCalledWith(
      'assets/proj_abc123/deadbeef12345678',
      expect.any(Uint8Array),
      expect.anything(),
    );
  });

  it('different projects get different keys for same hash', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const assetsByHash = new Map<string, AssetEntry>([
      ['deadbeef12345678', entry('test', 'text/plain')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_aaa');
    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_bbb');

    expect(kv.put).toHaveBeenCalledWith(
      'assets/proj_aaa/deadbeef12345678',
      expect.any(Uint8Array),
      expect.anything(),
    );
    expect(kv.put).toHaveBeenCalledWith(
      'assets/proj_bbb/deadbeef12345678',
      expect.any(Uint8Array),
      expect.anything(),
    );
  });
});

describe('deleteUnreferencedAssets', () => {
  it('deletes only hashes not referenced by retained deployments', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));
    kv.store.set('assets/proj_test/hash_b', new ArrayBuffer(0));
    r2.store.set('assets/proj_test/hash_c', new ArrayBuffer(0));

    const evictedHashes = ['hash_a', 'hash_b', 'hash_c'];
    const retainedHashes = new Set(['hash_b']);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    expect(kv.store.has('assets/proj_test/hash_b')).toBe(true);
    expect(r2.store.has('assets/proj_test/hash_c')).toBe(false);
  });

  it('does nothing when all evicted hashes are retained', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));

    const evictedHashes = ['hash_a'];
    const retainedHashes = new Set(['hash_a']);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
    expect(kv.store.has('assets/proj_test/hash_a')).toBe(true);
  });

  it('does nothing when evictedHashes is empty', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    await deleteUnreferencedAssets(kv, r2, [], new Set(), 'proj_test');

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('only deletes project-scoped keys, not legacy shared keys', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    // Legacy key exists for the same hash
    kv.store.set('assets/hash_a', new ArrayBuffer(0));
    // Scoped key also exists
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));

    const evictedHashes = ['hash_a'];
    const retainedHashes = new Set<string>();

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    // Scoped key deleted
    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    // Legacy key untouched
    expect(kv.store.has('assets/hash_a')).toBe(true);
  });
});

describe('uploadAssetBuckets', () => {
  const singleAssetMap = new Map<string, AssetEntry>([['hash1', entry('hello', 'text/plain')]]);
  const opts = { retryDelayMs: 0, gatewayDelayMs: 0 };

  it('returns session JWT directly when buckets are empty (all cached)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets('acct', 'session-jwt', [], singleAssetMap, opts);

    expect(completionJwt).toBe('session-jwt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns session JWT directly when buckets contain only empty arrays', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [[]],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('session-jwt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the returned jwt when Cloudflare responds with JSON', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { jwt: 'completion-jwt' } }));
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams base64 multipart asset bodies with correct headers and encoded content', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer session-jwt',
      });
      expect(init?.headers).toMatchObject({
        'Content-Type': expect.stringContaining('multipart/form-data; boundary='),
      });
      const body = await readBodyText(init?.body);
      expect(body).toContain('Content-Disposition: form-data; name="hash1"; filename="hash1"');
      expect(body).toContain('Content-Type: text/plain');
      expect(body).toContain('aGVsbG8=');
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
  });

  it('retries on 5xx errors and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response('Bad Gateway', { status: 502 });
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('accepts missing JWT for non-final buckets', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // First bucket (non-final): 202 with no JWT
      if (calls === 1) {
        return Response.json({ result: {} }, { status: 202 });
      }
      // Second bucket (final): 200 with completion JWT
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1'], ['hash2']],
      new Map<string, AssetEntry>([
        ['hash1', entry('a', 'text/plain')],
        ['hash2', entry('b', 'text/plain')],
      ]),
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses session JWT for auth on all buckets (no chaining)', async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1'], ['hash2']],
      new Map<string, AssetEntry>([
        ['hash1', entry('a', 'text/plain')],
        ['hash2', entry('b', 'text/plain')],
      ]),
      opts,
    );

    // Both calls should use session JWT, not the response JWT from bucket 1
    for (const call of fetchMock.mock.calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (call as any)[1] as { headers: { Authorization: string } };
      expect(options.headers.Authorization).toBe('Bearer session-jwt');
    }
  });

  it('retries malformed 2xx (CF edge bug) and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 1) {
        return new Response('Assets have already been uploaded.');
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when no bucket returns a completion JWT', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: {} }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('no completion JWT received');

    // Valid response — no retries burned, just 1 call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 4xx errors before throwing (matches Wrangler)', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (401)');

    // 4xx errors are retried just like 5xx (matching Wrangler's behavior)
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('524 gateway errors get free retries before counting as attempts', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Return 524 for the first 6 calls, then succeed
      if (calls <= 6) {
        return new Response('A timeout occurred', { status: 524 });
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    // 6 failures + 1 success = 7 calls. The first 4 gateway errors are free
    // (gwErr 1-4, attempts stays 0). The 5th (gwErr=5 >= MAX=5) increments
    // attempts to 1, the 6th increments to 2. Call 7 succeeds.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('throws after exhausting gateway + regular retries', async () => {
    // Always return 524 — eventually should exhaust all retries
    const fetchMock = vi.fn(async () => new Response('A timeout occurred', { status: 524 }));
    vi.stubGlobal('fetch', fetchMock);

    // Rethrows the original AssetUploadError (matching Wrangler's `throw e;`)
    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (524)');

    // 4 free gateway errors (gwErr 1-4, attempts stays 0)
    // + 6 counted (gwErr 5-10, each increments attempts 1→2→3→4→5→check fails)
    // = 10 total calls
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('uploads buckets concurrently', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const fetchMock = vi.fn(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Yield to let other concurrent tasks start
      await new Promise((r) => setTimeout(r, 1));
      currentConcurrent--;
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['h1'], ['h2'], ['h3']],
      new Map<string, AssetEntry>([
        ['h1', entry('a', 'text/plain')],
        ['h2', entry('b', 'text/plain')],
        ['h3', entry('c', 'text/plain')],
      ]),
      opts,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // All 3 should run concurrently since UPLOAD_CONCURRENCY=3
    expect(maxConcurrent).toBe(3);
  });

  it('JWT expiration gives specific error message when retries exhausted', async () => {
    // JWT that expired 1 hour ago
    const expiredJwt = makeJwt(Math.floor(Date.now() / 1000) - 3600);
    const fetchMock = vi.fn(async () => new Response('Server Error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', expiredJwt, [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow(/upload session has expired/);
  });

  it('rethrows original error when retries exhausted and JWT valid', async () => {
    // JWT that expires in 1 hour
    const validJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const fetchMock = vi.fn(async () => new Response('Server Error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    // Original AssetUploadError is rethrown (matching Wrangler's `throw e;`)
    await expect(
      uploadAssetBuckets('acct', validJwt, [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (500)');
  });
});

describe('createAssetUploadSession', () => {
  const manifest = { '/index.html': { hash: 'abc123', size: 100 } };

  it('returns jwt and buckets on success', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ result: { jwt: 'session-jwt', buckets: [['abc123']] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'session-jwt', buckets: [['abc123']] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on plain-text response and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response('Assets have already been uploaded.');
      }
      return Response.json({ result: { jwt: 'retry-jwt', buckets: [] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'retry-jwt', buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on plain-text responses', async () => {
    const fetchMock = vi.fn(async () => new Response('Assets have already been uploaded.'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session returned invalid response');

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry on HTTP error responses', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session failed: Unauthorized');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeForCfAssetSession', () => {
  it('strips v2 manifest extras (blake3, md5) and keeps only {hash, size}', () => {
    const v2Manifest = {
      '/index.html': {
        // v2 wire shape from the framework CLI
        blake3: 'a'.repeat(32),
        md5: 'b'.repeat(32),
        size: 100,
        hash: 'a'.repeat(32),
      } as unknown as { hash: string; size: number },
      '/style.css': {
        blake3: 'c'.repeat(32),
        md5: 'd'.repeat(32),
        size: 50,
        hash: 'c'.repeat(32),
      } as unknown as { hash: string; size: number },
    };

    const out = normalizeForCfAssetSession(v2Manifest);

    expect(Object.keys(out).sort()).toEqual(['/index.html', '/style.css']);
    for (const entry of Object.values(out)) {
      expect(Object.keys(entry).sort()).toEqual(['hash', 'size']);
      expect(entry).not.toHaveProperty('blake3');
      expect(entry).not.toHaveProperty('md5');
    }
    expect(out['/index.html']).toEqual({ hash: 'a'.repeat(32), size: 100 });
    expect(out['/style.css']).toEqual({ hash: 'c'.repeat(32), size: 50 });
  });

  it('returns a fresh object — mutating input does not affect output', () => {
    const input = { '/a.js': { hash: 'h', size: 1 } };
    const out = normalizeForCfAssetSession(input);
    expect(out).not.toBe(input);
    expect(out['/a.js']).not.toBe(input['/a.js']);
    // mutating input post-normalize must not leak through
    (input['/a.js'] as { extra?: string }).extra = 'leaked';
    expect(out['/a.js']).not.toHaveProperty('extra');
  });

  it('passes a manifest that is already {hash, size} through unchanged in shape', () => {
    const input = { '/index.html': { hash: 'aaa', size: 7 } };
    const out = normalizeForCfAssetSession(input);
    expect(out).toEqual(input);
  });

  it('preserves all paths, including empty manifests', () => {
    expect(normalizeForCfAssetSession({})).toEqual({});
  });
});

type BundleR2Entry = {
  bytes: ArrayBuffer;
  contentType: string;
};

function createBundleR2Mock(opts?: { listPageSize?: number }) {
  const store = new Map<string, BundleR2Entry>();
  const listPageSize = opts?.listPageSize ?? 1000;
  return {
    store,
    put: vi.fn(
      async (
        key: string,
        value: ArrayBuffer | ArrayBufferView,
        options?: { httpMetadata?: { contentType?: string } },
      ) => {
        const buf =
          value instanceof ArrayBuffer
            ? value.slice(0)
            : (() => {
                const view = value as ArrayBufferView;
                const copy = new Uint8Array(view.byteLength);
                copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
                return copy.buffer;
              })();
        store.set(key, {
          bytes: buf,
          contentType: options?.httpMetadata?.contentType ?? '',
        });
        return { key } as R2Object;
      },
    ),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      return {
        key,
        httpMetadata: { contentType: entry.contentType },
        arrayBuffer: async () => entry.bytes.slice(0),
      } as unknown as R2ObjectBody;
    }),
    list: vi.fn(async (options?: { prefix?: string; cursor?: string }) => {
      const prefix = options?.prefix ?? '';
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const startIndex = options?.cursor ? Number(options.cursor) : 0;
      const slice = allKeys.slice(startIndex, startIndex + listPageSize);
      const nextIndex = startIndex + slice.length;
      const truncated = nextIndex < allKeys.length;
      const objects = slice.map((k) => ({ key: k })) as Array<R2Object>;
      if (truncated) {
        return {
          objects,
          delimitedPrefixes: [],
          truncated: true as const,
          cursor: String(nextIndex),
        };
      }
      return {
        objects,
        delimitedPrefixes: [],
        truncated: false as const,
      };
    }),
    delete: vi.fn(async (keys: string | Array<string>) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }),
  } as unknown as R2Bucket & { store: Map<string, BundleR2Entry> };
}

describe('persistWorkerBundle', () => {
  it('writes one R2 object per file with correct key and content-type', async () => {
    const r2 = createBundleR2Mock();
    const files = [
      { name: 'index.js', content: new Blob(['main code'], { type: 'application/javascript' }) },
      {
        name: 'chunks/x.js',
        content: new Blob(['chunk code'], { type: 'application/javascript+module' }),
      },
      {
        name: 'data.json',
        content: new Blob(['{"k":1}'], { type: 'application/json' }),
      },
    ];

    await persistWorkerBundle(r2, 'p_1', 'd_2', files);

    expect(r2.put).toHaveBeenCalledTimes(3);
    expect(r2.store.has('worker-bundles/p_1/d_2/index.js')).toBe(true);
    expect(r2.store.has('worker-bundles/p_1/d_2/chunks/x.js')).toBe(true);
    expect(r2.store.has('worker-bundles/p_1/d_2/data.json')).toBe(true);

    const indexEntry = r2.store.get('worker-bundles/p_1/d_2/index.js');
    expect(indexEntry?.contentType).toBe('application/javascript');
    expect(new TextDecoder().decode(indexEntry?.bytes)).toBe('main code');

    const chunkEntry = r2.store.get('worker-bundles/p_1/d_2/chunks/x.js');
    expect(chunkEntry?.contentType).toBe('application/javascript+module');
    expect(new TextDecoder().decode(chunkEntry?.bytes)).toBe('chunk code');
  });

  it('rejects when an R2 put fails', async () => {
    const r2 = createBundleR2Mock();
    vi.mocked(r2.put).mockImplementationOnce(async () => {
      throw new Error('R2 transport down');
    });

    await expect(
      persistWorkerBundle(r2, 'p_1', 'd_2', [
        { name: 'index.js', content: new Blob(['x'], { type: 'application/javascript' }) },
      ]),
    ).rejects.toThrow('R2 transport down');
  });

  it('awaits all in-flight sibling puts before rejecting on first failure', async () => {
    // Reproduces the race that adversarial review flagged: with Promise.all,
    // persistWorkerBundle returned on the first rejection while sibling writes
    // were still landing in R2, leaving partial rollback artifacts under the
    // deployment prefix when the deploy abort cleanup ran.
    const r2 = createBundleR2Mock();
    const settled: Array<string> = [];
    let releaseDelayed: (() => void) | undefined;
    const delayedPut = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });

    const realPut = vi.mocked(r2.put).getMockImplementation()!;
    vi.mocked(r2.put).mockImplementation(async (key, value, options) => {
      if (key.endsWith('/fail.js')) {
        settled.push(key);
        throw new Error('R2 transport down');
      }
      if (key.endsWith('/slow.js')) {
        await delayedPut;
        const result = await realPut(key, value, options);
        settled.push(key);
        return result;
      }
      const result = await realPut(key, value, options);
      settled.push(key);
      return result;
    });

    const files = [
      { name: 'fail.js', content: new Blob(['boom'], { type: 'application/javascript' }) },
      { name: 'slow.js', content: new Blob(['slow'], { type: 'application/javascript' }) },
      { name: 'fast.js', content: new Blob(['fast'], { type: 'application/javascript' }) },
    ];
    const pending = persistWorkerBundle(r2, 'p_1', 'd_2', files);
    // Swallow the eventual rejection so an unhandled rejection doesn't
    // poison the test runner; we still await the original `pending` below
    // for the real assertion.
    pending.catch(() => {});

    // Race the bundle promise against a marker that resolves on a clearly
    // later turn. With the bounded-worker fix, the bundle promise must NOT
    // win the race — slow.js is still parked on `delayedPut`. With the
    // pre-fix Promise.all, the bundle promise rejects as soon as fail.js
    // throws and wins the race.
    const marker = Symbol('marker');
    const winner = await Promise.race([
      pending.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<typeof marker>((r) => setTimeout(() => r(marker), 25)),
    ]);
    expect(winner).toBe(marker);
    expect(settled).toContain('worker-bundles/p_1/d_2/fail.js');
    // slow.js is still parked on the gate.
    expect(settled).not.toContain('worker-bundles/p_1/d_2/slow.js');

    releaseDelayed!();
    await expect(pending).rejects.toThrow('R2 transport down');

    // After rejection, every sibling that was scheduled must have settled.
    expect(settled).toContain('worker-bundles/p_1/d_2/slow.js');
  });
});

describe('replayWorkerBundle', () => {
  it('reads all modules back with bytes and content-type intact', async () => {
    const r2 = createBundleR2Mock();
    const files = [
      { name: 'index.js', content: new Blob(['main()'], { type: 'application/javascript' }) },
      {
        name: 'chunks/a.js',
        content: new Blob(['chunk a'], { type: 'application/javascript+module' }),
      },
      {
        name: 'chunks/b.js',
        content: new Blob([new Uint8Array([0, 1, 2, 3, 255])], {
          type: 'application/octet-stream',
        }),
      },
    ];
    await persistWorkerBundle(r2, 'p_1', 'd_2', files);

    const replayed = await replayWorkerBundle(r2, 'p_1', 'd_2');

    expect(replayed).toHaveLength(3);
    const byName = new Map(replayed.map((f) => [f.name, f.content]));

    expect(byName.get('index.js')?.type).toBe('application/javascript');
    expect(await byName.get('index.js')?.text()).toBe('main()');

    expect(byName.get('chunks/a.js')?.type).toBe('application/javascript+module');
    expect(await byName.get('chunks/a.js')?.text()).toBe('chunk a');

    const binary = byName.get('chunks/b.js');
    expect(binary?.type).toBe('application/octet-stream');
    expect(new Uint8Array(await binary!.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 255]));
  });

  it('paginates through multiple R2 list pages', async () => {
    const r2 = createBundleR2Mock({ listPageSize: 2 });
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `mod${i}.js`,
      content: new Blob([`code${i}`], { type: 'application/javascript' }),
    }));
    await persistWorkerBundle(r2, 'p_1', 'd_2', files);

    const replayed = await replayWorkerBundle(r2, 'p_1', 'd_2');

    expect(replayed).toHaveLength(5);
    expect(vi.mocked(r2.list).mock.calls.length).toBeGreaterThan(1);
    const names = new Set(replayed.map((f) => f.name));
    for (let i = 0; i < 5; i++) {
      expect(names.has(`mod${i}.js`)).toBe(true);
    }
  });

  it('throws a clear error when no bundle objects exist', async () => {
    const r2 = createBundleR2Mock();
    await expect(replayWorkerBundle(r2, 'p_1', 'missing')).rejects.toThrow(
      /no bundle objects found for deploy missing/,
    );
  });

  it('does not pick up bundles for other deploys with shared prefix', async () => {
    const r2 = createBundleR2Mock();
    await persistWorkerBundle(r2, 'p_1', 'd_1', [
      { name: 'index.js', content: new Blob(['a'], { type: 'application/javascript' }) },
    ]);
    await persistWorkerBundle(r2, 'p_1', 'd_2', [
      { name: 'index.js', content: new Blob(['b'], { type: 'application/javascript' }) },
      { name: 'extra.js', content: new Blob(['b2'], { type: 'application/javascript' }) },
    ]);

    const replayed = await replayWorkerBundle(r2, 'p_1', 'd_1');
    expect(replayed).toHaveLength(1);
    expect(await replayed[0].content.text()).toBe('a');
  });
});

describe('deleteWorkerBundle', () => {
  it('deletes all keys under the deploy prefix', async () => {
    const r2 = createBundleR2Mock();
    await persistWorkerBundle(r2, 'p_1', 'd_2', [
      { name: 'index.js', content: new Blob(['x'], { type: 'application/javascript' }) },
      { name: 'chunks/a.js', content: new Blob(['y'], { type: 'application/javascript' }) },
    ]);
    await persistWorkerBundle(r2, 'p_1', 'd_3', [
      { name: 'index.js', content: new Blob(['z'], { type: 'application/javascript' }) },
    ]);
    expect(r2.store.size).toBe(3);

    await deleteWorkerBundle(r2, 'p_1', 'd_2');

    expect(r2.store.has('worker-bundles/p_1/d_2/index.js')).toBe(false);
    expect(r2.store.has('worker-bundles/p_1/d_2/chunks/a.js')).toBe(false);
    expect(r2.store.has('worker-bundles/p_1/d_3/index.js')).toBe(true);
  });

  it('is idempotent when there is nothing to delete', async () => {
    const r2 = createBundleR2Mock();
    await expect(deleteWorkerBundle(r2, 'p_1', 'd_2')).resolves.toBeUndefined();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('paginates through multiple R2 list pages and batch-deletes in chunks of 1000', async () => {
    const r2 = createBundleR2Mock({ listPageSize: 250 });
    const files = Array.from({ length: 1500 }, (_, i) => ({
      name: `mod${i}.js`,
      content: new Blob([`code${i}`], { type: 'application/javascript' }),
    }));
    await persistWorkerBundle(r2, 'p_1', 'd_big', files);
    expect(r2.store.size).toBe(1500);

    await deleteWorkerBundle(r2, 'p_1', 'd_big');

    expect(r2.store.size).toBe(0);
    const deleteCalls = vi.mocked(r2.delete).mock.calls;
    // 1500 keys → at most 1000 + 500 in two batches; never a batch larger than 1000.
    for (const [arg] of deleteCalls) {
      const arr = Array.isArray(arg) ? arg : [arg];
      expect(arr.length).toBeLessThanOrEqual(1000);
    }
    const totalDeleted = deleteCalls.reduce((sum, [arg]) => {
      const arr = Array.isArray(arg) ? arg : [arg];
      return sum + arr.length;
    }, 0);
    expect(totalDeleted).toBe(1500);
  });
});
