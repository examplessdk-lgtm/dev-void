import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  cloneWithoutVoidPages,
  deleteIsrCache,
  denormalizeIsrPath,
  handleIsr,
  hostRegistryKey,
  htmlEdgeKey,
  isrCacheResponse,
  isrKey,
  isStale,
  jsonEdgeKey,
  listIsrHosts,
  matchLiteralPattern,
  normalizeIsrPath,
  packIsrValue,
  readIsrCache,
  resolvePathTtl,
  resolveRevalidateTtl,
  unpackIsrValue,
  writeIsrCache,
  type IsrCacheEntry,
  type IsrCacheEnv,
  type IsrCacheMetadata,
  type RenderFn,
} from '../../src/runtime/isr-cache.ts';

// Collapsed self-host deployment id (baked as a compile-time literal on the real
// worker). Every key in this suite is scoped by it — `void-isr/<id>/...`.
const DPL = '11111111-1111-4111-8111-111111111111';
const HOST = 'app.void.app';
// A fixed, realistic epoch so `Date.now()` (faked) is deterministic.
const BASE = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// In-memory KV mock (getWithMetadata/put/delete/list with cursor pagination).
// Real behavior: `store` is the authoritative backing map, so assertions read
// actual cache contents rather than merely "the mock was called".
// ---------------------------------------------------------------------------

type KvRecord = { value: ArrayBuffer; metadata: IsrCacheMetadata | null };

function createKvMock(opts: { throwOnGet?: boolean } = {}) {
  const store = new Map<string, KvRecord>();
  const getWithMetadata = vi.fn(async (key: string, _type: 'arrayBuffer') => {
    if (opts.throwOnGet) {
      throw new Error('KV unavailable');
    }
    const rec = store.get(key);
    return rec ? { value: rec.value, metadata: rec.metadata } : { value: null, metadata: null };
  });
  const put = vi.fn(
    async (key: string, value: ArrayBuffer, options?: { metadata?: IsrCacheMetadata }) => {
      store.set(key, { value, metadata: options?.metadata ?? null });
    },
  );
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const list = vi.fn(async (o: { prefix?: string; cursor?: string; limit?: number } = {}) => {
    const prefix = o.prefix ?? '';
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const limit = o.limit ?? 1000;
    const start = o.cursor ? Number.parseInt(o.cursor, 10) : 0;
    const slice = all.slice(start, start + limit);
    const complete = start + limit >= all.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? '' : String(start + limit),
    };
  });
  const kv = { getWithMetadata, put, delete: del, list } as unknown as KVNamespace;
  return { store, kv, getWithMetadata, put, delete: del, list };
}

function makeEnv(kv: KVNamespace): IsrCacheEnv {
  return { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL };
}

function packEntry(headers: Record<string, string>, body: string): ArrayBuffer {
  return packIsrValue(headers, new TextEncoder().encode(body).buffer as ArrayBuffer);
}

function seedEntry(
  store: Map<string, KvRecord>,
  path: string,
  {
    headers = { 'content-type': 'text/html' },
    body = '<html>cached</html>',
    status = 200,
    createdAt,
    ttl = 60,
    value,
  }: {
    headers?: Record<string, string>;
    body?: string;
    status?: number;
    createdAt: number;
    ttl?: number;
    value?: ArrayBuffer;
  },
): void {
  store.set(isrKey(DPL, HOST, path), {
    value: value ?? packEntry(headers, body),
    metadata: { s: status, c: createdAt, t: ttl },
  });
}

// ---------------------------------------------------------------------------
// Fake per-colo edge cache (caches.default): match/put/delete over string keys.
// ---------------------------------------------------------------------------

function createEdgeMock() {
  const store = new Map<string, Response>();
  const match = vi.fn(async (key: string | Request) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    const res = store.get(k);
    // Real Cache.match hands back a fresh Response each call.
    return res ? res.clone() : undefined;
  });
  const put = vi.fn(async (key: string | Request, response: Response) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    store.set(k, response);
  });
  const del = vi.fn(async (key: string | Request) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    return store.delete(k);
  });
  const cache = { match, put, delete: del } as unknown as Cache;
  return { store, cache, match, put, delete: del };
}

function createCtx() {
  const tasks: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    tasks,
    flush: async () => {
      await Promise.all(tasks);
    },
  };
}

function createRender(makeResponse: (req: Request) => Response) {
  const requests: Array<Request> = [];
  const spy = vi.fn(async (req: Request) => {
    requests.push(req);
    return makeResponse(req);
  });
  return { render: spy as unknown as RenderFn, spy, requests };
}

// ---------------------------------------------------------------------------
// Corrupt-KV fail-open table (critical). A KV entry whose metadata/headers make
// a Response un-constructible must be rejected at the `readIsrCache` choke point
// so `isrCacheResponse` can never throw. Shared by two suites: the low-level
// `readIsrCache` fail-open tests AND the end-to-end `handleIsr` live-render
// path (every corrupt shape must degrade to a live render, never a 500).
// ---------------------------------------------------------------------------
const corruptCases: Array<{ name: string; seed: () => KvRecord }> = [
  {
    name: 'status out of range (s: 999)',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 999, c: BASE, t: 60 } }),
  },
  {
    name: 'status out of range (s: 0)',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 0, c: BASE, t: 60 } }),
  },
  {
    name: 'invalid header name',
    seed: () => ({
      value: packEntry({ 'Invalid Header Name': 'x' }, 'x'),
      metadata: { s: 200, c: BASE, t: 60 },
    }),
  },
  {
    name: 'createdAt NaN',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 200, c: NaN, t: 60 } }),
  },
  {
    name: 'createdAt Infinity',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 200, c: Infinity, t: 60 } }),
  },
  {
    name: 'createdAt negative',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 200, c: -1, t: 60 } }),
  },
  {
    name: 'ttl NaN',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 200, c: BASE, t: NaN } }),
  },
  {
    name: 'ttl zero',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 200, c: BASE, t: 0 } }),
  },
  {
    name: 'ttl negative',
    seed: () => ({ value: packEntry({}, 'x'), metadata: { s: 200, c: BASE, t: -5 } }),
  },
  {
    name: 'malformed packed value',
    seed: () => ({ value: new ArrayBuffer(2), metadata: { s: 200, c: BASE, t: 60 } }),
  },
];

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('normalizeIsrPath / denormalizeIsrPath', () => {
  it('maps root to __index__ and back', () => {
    expect(normalizeIsrPath('/')).toBe('__index__');
    expect(denormalizeIsrPath('__index__')).toBe('/');
  });

  it('strips leading and trailing slashes', () => {
    expect(normalizeIsrPath('/about')).toBe('about');
    expect(normalizeIsrPath('/about/')).toBe('about');
    expect(normalizeIsrPath('/blog/hello-world')).toBe('blog/hello-world');
  });

  it('round-trips non-root paths', () => {
    for (const p of ['/', '/about', '/blog/hello']) {
      expect(denormalizeIsrPath(normalizeIsrPath(p))).toBe(p);
    }
  });
});

describe('collapsed self-host cache keys', () => {
  it('scopes the KV key by deployment id AND host (void-isr/<id>/<host>/...), no projectId/isr-v2', () => {
    expect(isrKey(DPL, HOST, '/')).toBe(`void-isr/${DPL}/${HOST}/__index__`);
    expect(isrKey(DPL, HOST, '/blog/x')).toBe(`void-isr/${DPL}/${HOST}/blog/x`);
    expect(isrKey(DPL, HOST, '/about/')).toBe(`void-isr/${DPL}/${HOST}/about`);
  });

  it('host-scopes the KV key: different hosts never share a cache key', () => {
    expect(isrKey(DPL, 'foo.example', '/x')).not.toBe(isrKey(DPL, 'bar.example', '/x'));
    expect(isrKey(DPL, 'foo.example', '/x')).toBe(`void-isr/${DPL}/foo.example/x`);
  });

  it('builds the host-registry key (void-isr-hosts/<id>/<host>), distinct from the cache prefix', () => {
    expect(hostRegistryKey(DPL, HOST)).toBe(`void-isr-hosts/${DPL}/${HOST}`);
    // The registry prefix must NOT collide with the cache prefix, or an `{ all }`
    // list (prefix `void-isr/<id>/`) would enumerate registry keys as cache keys.
    expect(hostRegistryKey(DPL, HOST).startsWith(`void-isr/${DPL}/`)).toBe(false);
  });

  it('builds HTML edge keys with the deployment id and a canonical pathname', () => {
    expect(htmlEdgeKey(HOST, '/about', DPL)).toBe(`https://${HOST}/about?__void_isr=${DPL}`);
    // Trailing slash canonicalized (matches normalizeIsrPath).
    expect(htmlEdgeKey(HOST, '/about/', DPL)).toBe(`https://${HOST}/about?__void_isr=${DPL}`);
    // Root keeps its slash.
    expect(htmlEdgeKey(HOST, '/', DPL)).toBe(`https://${HOST}/?__void_isr=${DPL}`);
  });

  it('builds JSON edge keys as the HTML key plus the &__void=json marker', () => {
    expect(jsonEdgeKey(HOST, '/about', DPL)).toBe(
      `https://${HOST}/about?__void_isr=${DPL}&__void=json`,
    );
  });
});

describe('isStale', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const entry = (createdAt: number, ttl = 60): IsrCacheEntry => ({
    body: new ReadableStream(),
    status: 200,
    headers: {},
    createdAt,
    ttl,
  });

  it('is fresh before the TTL elapses', () => {
    vi.setSystemTime(BASE);
    expect(isStale(entry(BASE))).toBe(false);
  });

  it('is stale past the TTL', () => {
    vi.setSystemTime(BASE + 61 * 1000);
    expect(isStale(entry(BASE))).toBe(true);
  });

  it('is fresh at the exact TTL boundary', () => {
    vi.setSystemTime(BASE + 60 * 1000);
    expect(isStale(entry(BASE))).toBe(false);
  });
});

describe('resolveRevalidateTtl', () => {
  it('returns the default when no header is present', () => {
    expect(resolveRevalidateTtl(new Response('ok'), 60)).toBe(60);
  });

  it('returns the header value when present', () => {
    expect(
      resolveRevalidateTtl(new Response('ok', { headers: { 'x-revalidate': '120' } }), 60),
    ).toBe(120);
  });

  it('returns 0 for the opt-out header (x-revalidate: 0 → do not cache)', () => {
    expect(resolveRevalidateTtl(new Response('ok', { headers: { 'x-revalidate': '0' } }), 60)).toBe(
      0,
    );
  });

  it('falls back to the default for invalid or negative header values', () => {
    expect(
      resolveRevalidateTtl(new Response('ok', { headers: { 'x-revalidate': 'abc' } }), 60),
    ).toBe(60);
    expect(
      resolveRevalidateTtl(new Response('ok', { headers: { 'x-revalidate': '-5' } }), 60),
    ).toBe(60);
  });
});

describe('isrCacheResponse', () => {
  it('serves HIT with an edge-cacheable s-maxage for a fresh entry', () => {
    const res = isrCacheResponse(
      {
        body: new ReadableStream(),
        status: 200,
        headers: { 'content-type': 'text/html' },
        createdAt: Date.now(),
        ttl: 60,
      },
      false,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-isr-cache')).toBe('HIT');
    expect(res.headers.get('content-type')).toBe('text/html');
    const cc = res.headers.get('Cache-Control')!;
    expect(cc).toContain('public');
    expect(cc).toContain('s-maxage=');
    expect(cc).toContain('must-revalidate');
  });

  it('serves STALE with s-maxage=min(10, ttl)', () => {
    const res = isrCacheResponse(
      {
        body: new ReadableStream(),
        status: 200,
        headers: {},
        createdAt: Date.now() - 120000,
        ttl: 60,
      },
      true,
    );
    expect(res.headers.get('x-isr-cache')).toBe('STALE');
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=10, max-age=0, must-revalidate',
    );
  });

  it('caps the STALE s-maxage at ttl for short ISR windows', () => {
    const res = isrCacheResponse(
      {
        body: new ReadableStream(),
        status: 200,
        headers: {},
        createdAt: Date.now() - 10000,
        ttl: 5,
      },
      true,
    );
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=5, max-age=0, must-revalidate');
  });
});

describe('packIsrValue / unpackIsrValue', () => {
  it('round-trips headers and body', () => {
    const headers = { 'content-type': 'text/html', etag: '"abc"' };
    const packed = packIsrValue(
      headers,
      new TextEncoder().encode('<html>hi</html>').buffer as ArrayBuffer,
    );
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(new TextDecoder().decode(result!.body)).toBe('<html>hi</html>');
  });

  it('handles empty body and empty headers', () => {
    const emptyBody = unpackIsrValue(
      packIsrValue({ 'content-type': 'text/html' }, new ArrayBuffer(0)),
    );
    expect(emptyBody!.body.byteLength).toBe(0);
    const emptyHeaders = unpackIsrValue(
      packIsrValue({}, new TextEncoder().encode('x').buffer as ArrayBuffer),
    );
    expect(emptyHeaders!.headers).toEqual({});
  });

  it('returns null for a buffer too small or a truncated header', () => {
    expect(unpackIsrValue(new ArrayBuffer(2))).toBeNull();
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 999, true); // claims 999 header bytes it does not have
    expect(unpackIsrValue(buf)).toBeNull();
  });
});

// ===========================================================================
// KV cache: write / read round-trip, delete, and corrupt-entry fail-open
// ===========================================================================

describe('writeIsrCache / readIsrCache / deleteIsrCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a packed entry to KV and reads it back with status/headers/ttl/body', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    await writeIsrCache(
      env,
      HOST,
      '/blog/post',
      new Response('<html>fresh</html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': 'sid=secret', 'cache-control': 'no' },
      }),
      60,
    );

    // Real KV contents: exactly one entry under the collapsed key.
    expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(true);
    const meta = store.get(isrKey(DPL, HOST, '/blog/post'))!.metadata!;
    expect(meta).toEqual({ s: 200, c: BASE, t: 60 });

    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe(200);
    expect(entry!.ttl).toBe(60);
    expect(entry!.createdAt).toBe(BASE);
    expect(entry!.headers['content-type']).toBe('text/html');
    // serializeHeaders strips cache-control/set-cookie before persisting.
    expect(entry!.headers['set-cookie']).toBeUndefined();
    expect(entry!.headers['cache-control']).toBeUndefined();
    expect(await new Response(entry!.body).text()).toBe('<html>fresh</html>');
  });

  it('returns null on a cache miss', async () => {
    const { kv } = createKvMock();
    expect(await readIsrCache(makeEnv(kv), HOST, '/nope')).toBeNull();
  });

  it('deleteIsrCache removes the entry', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/gone', { createdAt: BASE });
    expect(store.has(isrKey(DPL, HOST, '/gone'))).toBe(true);
    await deleteIsrCache(env, HOST, '/gone');
    expect(store.has(isrKey(DPL, HOST, '/gone'))).toBe(false);
  });

  it('fails open to null when getWithMetadata throws (never surfaces the error)', async () => {
    const { kv } = createKvMock({ throwOnGet: true });
    await expect(readIsrCache(makeEnv(kv), HOST, '/x')).resolves.toBeNull();
  });

  // Corrupt-KV fail-open: the `corruptCases` table is module-scoped (shared with
  // the `handleIsr` live-render suite). readIsrCache must reject every shape.
  for (const c of corruptCases) {
    it(`readIsrCache returns null for a corrupt entry: ${c.name}`, async () => {
      const { store, kv } = createKvMock();
      store.set(isrKey(DPL, HOST, '/p'), c.seed());
      await expect(readIsrCache(makeEnv(kv), HOST, '/p')).resolves.toBeNull();
    });
  }
});

// ===========================================================================
// cloneWithoutVoidPages — the background-render request stripper
// ===========================================================================
// A request that carries `X-VoidPages` takes the JSON branch in `handleIsr` and
// returns before ever reaching the HTML stale path where the stripper runs, so
// the public API cannot deliver an X-VoidPages request to it. Test it directly
// so the mandated stripping is actually exercised (the stale-path test can only
// ever hand it a request that already lacks the header — a tautology otherwise).

describe('cloneWithoutVoidPages', () => {
  it('removes X-VoidPages while preserving method, url, and every other header', () => {
    const original = new Request(`https://${HOST}/blog/post`, {
      method: 'GET',
      headers: {
        'X-VoidPages': '1',
        'X-Test-Marker': 'keep',
        Accept: 'text/html',
      },
    });
    // Precondition: the input genuinely carries the header we expect stripped.
    expect(original.headers.has('X-VoidPages')).toBe(true);

    const cleaned = cloneWithoutVoidPages(original);

    // Only X-VoidPages is dropped; everything else is preserved verbatim. This
    // fails if `cloneWithoutVoidPages` stops deleting the header (regression).
    expect(cleaned.headers.has('X-VoidPages')).toBe(false);
    expect(cleaned.headers.get('X-Test-Marker')).toBe('keep');
    expect(cleaned.headers.get('Accept')).toBe('text/html');
    expect(cleaned.method).toBe('GET');
    expect(cleaned.url).toBe(`https://${HOST}/blog/post`);
  });

  it('is a no-op on the header set when X-VoidPages is absent', () => {
    const original = new Request(`https://${HOST}/blog/post`, {
      method: 'GET',
      headers: { 'X-Test-Marker': 'keep' },
    });
    const cleaned = cloneWithoutVoidPages(original);
    expect(cleaned.headers.has('X-VoidPages')).toBe(false);
    expect(cleaned.headers.get('X-Test-Marker')).toBe('keep');
    expect(cleaned.url).toBe(`https://${HOST}/blog/post`);
  });
});

// ===========================================================================
// handleIsr — the cache ladder end to end
// ===========================================================================

describe('handleIsr', () => {
  let edge: ReturnType<typeof createEdgeMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    edge = createEdgeMock();
    vi.stubGlobal('caches', { default: edge.cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const OPTS = { revalidate: 60, deploymentId: DPL };

  function htmlRequest(path = '/blog/post', headers: Record<string, string> = {}) {
    return new Request(`https://${HOST}${path}`, { method: 'GET', headers });
  }

  it('MISS → renders live, returns MISS, and writes KV + HTML edge in the background', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy } = createRender(
      () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await res!.text()).toBe('<html>live</html>');
    expect(spy).toHaveBeenCalledTimes(1);

    await flush();
    // Real KV contents: the live render was persisted under the collapsed key.
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).not.toBeNull();
    expect(await new Response(entry!.body).text()).toBe('<html>live</html>');
    // HTML edge variant warmed; plain HTML (no page data) never warms the JSON variant.
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(true);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    // Exactly one PAGE-cache entry persisted (`void-isr/…`); the host-registry
    // bookkeeping key (`void-isr-hosts/…`) is separate and excluded here.
    expect([...store.keys()].filter((k) => k.startsWith('void-isr/')).length).toBe(1);
  });

  it('KV HIT (fresh) → serves HIT from KV without a live render and warms the edge', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { body: '<html>kv</html>', createdAt: BASE, ttl: 60 });
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('HIT');
    // Client response revalidates on every hit.
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await res!.text()).toBe('<html>kv</html>');
    expect(spy).not.toHaveBeenCalled();

    await flush();
    // Edge warmed from KV with the fresh (HIT) response — s-maxage tracks remaining freshness.
    const warmed = edge.store.get(htmlEdgeKey(HOST, '/blog/post', DPL));
    expect(warmed).toBeDefined();
    expect(warmed!.headers.get('x-isr-cache')).toBe('HIT');
    expect(warmed!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, max-age=0, must-revalidate',
    );
  });

  it('KV HIT (stale) → serves STALE BEFORE revalidation runs, queues it via ctx.waitUntil (background, not inline), then re-puts KV', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    // Seed a stale entry: created at BASE, now BASE+200s (> ttl 60s).
    seedEntry(store, '/blog/post', { body: '<html>stale</html>', createdAt: BASE, ttl: 60 });
    vi.setSystemTime(BASE + 200_000);

    // A DEFERRED render we control: the background revalidation cannot produce a
    // response until we call `release()`. This is the crux of proving background
    // vs. inline — if `handleIsr` awaited the revalidation INLINE (instead of
    // `ctx.waitUntil`), the `await handleIsr(...)` below would deadlock on this
    // gate and the test would time out. It resolves only because the stale
    // response is served WITHOUT waiting on the re-render.
    const requests: Array<Request> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.fn(async (req: Request) => {
      requests.push(req);
      await gate; // block until the test explicitly releases the render
      return new Response('<html>revalidated</html>', {
        headers: { 'content-type': 'text/html' },
      });
    });
    const render = spy as unknown as RenderFn;
    const { ctx, tasks, flush } = createCtx();

    // Original request carries a marker header (and NO X-VoidPages — an
    // X-VoidPages request would take the JSON branch and never reach here).
    const res = await handleIsr(
      htmlRequest('/blog/post', { 'X-Test-Marker': 'keep' }),
      env,
      ctx,
      OPTS,
      render,
    );

    // (a) Resolves to the STALE response BEFORE the deferred render resolves —
    // the gate is still closed, yet the client already has its answer.
    expect(res!.headers.get('x-isr-cache')).toBe('STALE');
    expect(await res!.text()).toBe('<html>stale</html>');
    // (b) BOTH background tasks are registered via ctx.waitUntil on the stale
    // path: the revalidation AND the edge-cache warm. Asserting the EXACT count
    // (2), not >= 1, is what protects the registration: a regression that fired
    // `revalidateInBackground` as an untracked floating promise would leave only
    // the edge-warm tracked, dropping this to 1 and failing here. That matters
    // because production Workers terminate untracked background work after the
    // response, so the revalidation MUST go through waitUntil to survive.
    expect(tasks.length).toBe(2);
    // The revalidation was KICKED OFF (render invoked) but NOT awaited inline:
    // KV still holds the ORIGINAL stale entry because the gate hasn't opened.
    expect(spy).toHaveBeenCalledTimes(1);
    const midEntry = await readIsrCache(env, HOST, '/blog/post');
    expect(midEntry!.createdAt).toBe(BASE);
    expect(isStale(midEntry!)).toBe(true);
    expect(await new Response(midEntry!.body).text()).toBe('<html>stale</html>');

    // Now release the deferred render and drain the queued background task.
    release();
    await flush();

    // Background re-render ran exactly once (queued via ctx.waitUntil).
    expect(spy).toHaveBeenCalledTimes(1);
    const rerender = requests[0]!;
    // The re-render request is derived from the original (marker preserved, GET,
    // same URL). X-VoidPages stripping itself is proven directly by the
    // `cloneWithoutVoidPages` suite above (an X-VoidPages request cannot reach
    // this HTML stale path through the public `handleIsr` API).
    // NOTE: cloneWithoutVoidPages uses `new Request(request, { headers })`, which
    // preserves `request.cf` on real workerd (verified empirically). These unit
    // tests run on Node's default vitest pool where `request.cf` does not exist,
    // so cf preservation is not representable here and is intentionally not asserted.
    expect(rerender.headers.has('X-VoidPages')).toBe(false);
    expect(rerender.headers.get('X-Test-Marker')).toBe('keep');
    expect(rerender.method).toBe('GET');
    expect(rerender.url).toBe(`https://${HOST}/blog/post`);

    // KV re-put with the fresh render (KV is only written by the background task,
    // so this is race-free) — createdAt advanced, entry is fresh again.
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry!.createdAt).toBe(BASE + 200_000);
    expect(isStale(entry!)).toBe(false);
    expect(await new Response(entry!.body).text()).toBe('<html>revalidated</html>');
  });

  it('HTML edge HIT → serves the edge variant without touching KV or rendering', async () => {
    const { kv, store, getWithMetadata } = createKvMock();
    const env = makeEnv(kv);
    edge.store.set(
      htmlEdgeKey(HOST, '/blog/post', DPL),
      new Response('<html>edge</html>', { headers: { 'x-isr-cache': 'HIT' } }),
    );
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(await res!.text()).toBe('<html>edge</html>');
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(spy).not.toHaveBeenCalled();
    expect(getWithMetadata).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('JSON (X-VoidPages) MISS → renders live JSON and never writes the edge or KV', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy, requests } = createRender(
      () =>
        new Response('{"component":"Blog"}', { headers: { 'content-type': 'application/json' } }),
    );
    const { ctx, tasks } = createCtx();

    const res = await handleIsr(
      htmlRequest('/blog/post', { 'X-VoidPages': '1' }),
      env,
      ctx,
      OPTS,
      render,
    );

    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('{"component":"Blog"}');
    // JSON path renders with the ORIGINAL request (X-VoidPages preserved).
    expect(requests[0]!.headers.has('X-VoidPages')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // No writes on the JSON path — the JSON variant is warmed only by the HTML render path.
    expect(tasks).toHaveLength(0);
    expect(edge.store.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it('JSON (X-VoidPages) edge HIT → serves the cached JSON variant, no render', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    edge.store.set(jsonEdgeKey(HOST, '/blog/post', DPL), new Response('{"cached":true}'));
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx } = createCtx();

    const res = await handleIsr(
      htmlRequest('/blog/post', { 'X-VoidPages': '1' }),
      env,
      ctx,
      OPTS,
      render,
    );
    expect(await res!.text()).toBe('{"cached":true}');
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(spy).not.toHaveBeenCalled();
  });

  // Regression: when an HTML render warms the JSON edge variant, the STORED JSON
  // response must mirror the live responder `pageJsonResponse` (pages/protocol.ts)
  // by carrying `X-VoidPages: true` + `Vary: X-VoidPages`. The Pages client gates
  // JSON parsing on `X-VoidPages` (navigation-engine.ts) — a cached JSON variant
  // served on a later navigation WITHOUT it is treated as non-JSON and triggers a
  // full-page hard reload. Prove the served header end to end (warm → HIT serve).
  it('cached JSON variant (warmed by an HTML render) carries X-VoidPages + Vary on a later navigation HIT', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    // HTML MISS render exposes embedded page data via the x-void-page-data header,
    // which `populateJsonEdgeCache` stores as the JSON edge variant.
    const { render } = createRender(
      () =>
        new Response('<html>live</html>', {
          headers: {
            'content-type': 'text/html',
            'x-void-page-data': '{"component":"Blog","props":{}}',
          },
        }),
    );
    const { ctx, flush } = createCtx();

    // 1) HTML navigation MISS → warms the JSON edge variant in the background.
    await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    await flush();
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(true);

    // 2) A subsequent Pages (X-VoidPages) navigation hits the warmed JSON variant.
    const { render: render2, spy: spy2 } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx: ctx2 } = createCtx();
    const res = await handleIsr(
      htmlRequest('/blog/post', { 'X-VoidPages': '1' }),
      env,
      ctx2,
      OPTS,
      render2,
    );

    // Served from the cached JSON variant (no live render).
    expect(spy2).not.toHaveBeenCalled();
    // The header the client gates on — missing it means a hard reload.
    expect(res!.headers.get('X-VoidPages')).toBe('true');
    expect(res!.headers.get('Vary')).toBe('X-VoidPages');
    expect(res!.headers.get('content-type')).toBe('application/json');
    expect(await res!.text()).toBe('{"component":"Blog","props":{}}');
  });

  it('fails open to a LIVE render (not a 500) when getWithMetadata throws', async () => {
    const { kv } = createKvMock({ throwOnGet: true });
    const env = makeEnv(kv);
    const { render, spy } = createRender(
      () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { ctx } = createCtx();

    // readIsrCache degrades to null on the throw...
    await expect(readIsrCache(env, HOST, '/blog/post')).resolves.toBeNull();
    // ...and handleIsr degrades to the live render rather than throwing.
    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await res!.text()).toBe('<html>live</html>');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // A corrupt KV entry on the hit path must degrade to a live render, never 500
  // and never throw — proven through the PUBLIC `handleIsr` API for EVERY corrupt
  // shape (the full module-scoped `corruptCases` table, including createdAt
  // NaN/Infinity/negative and ttl zero/negative), not just a hand-picked subset.
  for (const c of corruptCases) {
    it(`degrades to a live render on a corrupt KV hit (never 500): ${c.name}`, async () => {
      const { store, kv } = createKvMock();
      const env = makeEnv(kv);
      store.set(isrKey(DPL, HOST, '/blog/post'), c.seed());

      // Choke point: the corrupt entry is rejected at `readIsrCache` (→ null),
      // so `isrCacheResponse` never sees an un-constructible entry.
      await expect(readIsrCache(env, HOST, '/blog/post')).resolves.toBeNull();

      const { render, spy } = createRender(
        () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
      );
      const { ctx, flush } = createCtx();

      // handleIsr returns the LIVE render (MISS), never a 500 and never a throw.
      const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
      expect(res!.status).toBe(200);
      expect(res!.headers.get('x-isr-cache')).toBe('MISS');
      expect(await res!.text()).toBe('<html>live</html>');
      expect(spy).toHaveBeenCalledTimes(1);

      await flush();
      // The MISS path overwrote the corrupt entry with a valid, readable one.
      const entry = await readIsrCache(env, HOST, '/blog/post');
      expect(entry).not.toBeNull();
      expect(await new Response(entry!.body).text()).toBe('<html>live</html>');
    });
  }

  it('background revalidation with x-revalidate: 0 purges the KV entry and both edge variants', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { createdAt: BASE, ttl: 60 });
    vi.setSystemTime(BASE + 200_000); // stale

    // Pre-warm the JSON edge variant so we can watch it get purged. The HTML
    // edge key is left empty on purpose — pre-warming it would hit L1 and
    // short-circuit before the KV stale path (which triggers the purge) runs.
    edge.store.set(jsonEdgeKey(HOST, '/blog/post', DPL), new Response('{"edge":true}'));

    const { render } = createRender(
      () =>
        new Response('<html>opt-out</html>', {
          headers: { 'content-type': 'text/html', 'x-revalidate': '0' },
        }),
    );
    const { ctx, flush } = createCtx();

    await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    await flush();

    // KV entry is only ever deleted here (never re-put) — deterministic real removal.
    expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(false);
    expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, HOST, '/blog/post'));
    // JSON edge variant is only touched by the purge → deterministically removed.
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    expect(edge.delete).toHaveBeenCalledWith(jsonEdgeKey(HOST, '/blog/post', DPL));
    // HTML edge purge is issued; its final state races the concurrent stale-warm
    // put, so assert the delete call rather than the (racey) final map state.
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/blog/post', DPL));
  });

  it('returns null (caller renders live) for non-GET, credentialed, and non-ISR paths', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    const { render } = createRender(() => new Response('x'));
    const { ctx } = createCtx();

    // Non-GET.
    expect(
      await handleIsr(
        new Request(`https://${HOST}/blog/post`, { method: 'POST' }),
        env,
        ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
    // Credentialed (Cookie) requests bypass ISR.
    expect(
      await handleIsr(htmlRequest('/blog/post', { Cookie: 'sid=1' }), env, ctx, OPTS, render),
    ).toBeNull();
    // Path with no configured TTL.
    expect(
      await handleIsr(
        htmlRequest('/blog/post'),
        env,
        ctx,
        { revalidate: { '/other': 60 }, deploymentId: DPL },
        render,
      ),
    ).toBeNull();
  });

  // FIX A: the Cache API can be absent/degraded — `edgeCache()` must swallow the
  // `caches.default` deref (returning undefined) so `handleIsr` never rejects
  // before its fail-open guards run. A degraded cache renders live, never 500.
  it('fails open (never throws) when the Cache API is absent — a MISS renders live', async () => {
    // Degrade the Cache API entirely: reading `caches.default` throws.
    vi.stubGlobal('caches', undefined);

    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy } = createRender(
      () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { ctx, flush } = createCtx();

    // L1 edge is unreachable → treated as a miss → L2 KV miss → live MISS render.
    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await res!.text()).toBe('<html>live</html>');
    expect(spy).toHaveBeenCalledTimes(1);

    // Background writes (guarded on an undefined edge cache) drain without throwing;
    // the KV write still lands.
    await expect(flush()).resolves.toBeUndefined();
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).not.toBeNull();
    expect(await new Response(entry!.body).text()).toBe('<html>live</html>');
    // Exactly one PAGE-cache entry (`void-isr/…`); the registry key is separate.
    expect([...store.keys()].filter((k) => k.startsWith('void-isr/')).length).toBe(1);
  });

  it('serves the L2 KV HIT with no per-colo edge cache (KV ladder independent of caches.default)', async () => {
    // `caches.default` throws on access — the KV ladder must still serve.
    vi.stubGlobal('caches', {
      get default(): Cache {
        throw new Error('Cache API degraded');
      },
    });

    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { body: '<html>kv</html>', createdAt: BASE, ttl: 60 });
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.headers.get('x-isr-cache')).toBe('HIT');
    expect(await res!.text()).toBe('<html>kv</html>');
    // Served from KV without a live render, despite no reachable edge cache.
    expect(spy).not.toHaveBeenCalled();
    // The edge-warm background task (guarded on undefined cache) drains cleanly.
    await expect(flush()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// matchLiteralPattern — segment-anchored matching (FIX 3)
// ===========================================================================

describe('matchLiteralPattern — segment-anchored matching', () => {
  it('anchors a WHOLE-segment `:name` to exactly ONE path segment', () => {
    expect(matchLiteralPattern('/blog/:slug', '/blog/hello')).toBe(true);
    // Deeper path — `:slug` must NOT cross a `/`.
    expect(matchLiteralPattern('/blog/:slug', '/blog/a/b')).toBe(false);
    // Empty segment — `[^/]+` requires at least one char.
    expect(matchLiteralPattern('/blog/:slug', '/blog/')).toBe(false);
    expect(matchLiteralPattern('/blog/:slug', '/blog')).toBe(false);
  });

  it('lets `*` cross `/` (catch-all splat)', () => {
    expect(matchLiteralPattern('/blog/*', '/blog/a/b')).toBe(true);
    expect(matchLiteralPattern('/blog/*', '/blog/hello')).toBe(true);
  });

  it('matches a root catch-all `/*` against any path (including root)', () => {
    expect(matchLiteralPattern('/*', '/')).toBe(true);
    expect(matchLiteralPattern('/*', '/x/y')).toBe(true);
  });

  it('anchors EACH param in a multi-segment `:cat/:id` pattern to one segment', () => {
    expect(matchLiteralPattern('/shop/:cat/:id', '/shop/shoes/42')).toBe(true);
    expect(matchLiteralPattern('/shop/:cat/:id', '/shop/shoes')).toBe(false);
    expect(matchLiteralPattern('/shop/:cat/:id', '/shop/shoes/42/extra')).toBe(false);
  });

  it('preserves a MID-segment literal `:` — only whole-segment `:name` is a wildcard', () => {
    // A user literal key `/api/v1:health` must match ONLY itself: the `:health`
    // is mid-segment (preceded by `1`, not `/`), so it stays a literal.
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:other')).toBe(false);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1/health')).toBe(false);
  });

  it('is a strict SUPERSET of the old matcher — old `*`-only manifests match identically', () => {
    // The OLD emitter produced `/blog/*` for `[slug]`; that manifest must keep
    // matching the same paths under the new matcher (rollout safety).
    expect(matchLiteralPattern('/blog/*', '/blog/hello')).toBe(true);
    expect(matchLiteralPattern('/blog/*', '/blog/a/b')).toBe(true);
  });
});

describe('resolvePathTtl — single-segment anchoring', () => {
  it('resolves the single-segment TTL for a one-segment path but NOT a deeper one', () => {
    // The FIX-3 emitter keeps `/blog/:slug` as-is; the matcher anchors it to one
    // segment, so `/blog/hello` gets the TTL while `/blog/a/b` does not.
    const revalidate = { '/blog/:slug': 120 };
    expect(resolvePathTtl(revalidate, '/blog/hello')).toBe(120);
    expect(resolvePathTtl(revalidate, '/blog/a/b')).toBe(0);
  });
});

// ===========================================================================
// Host-scoped KV cache + host registry (FIX 4)
// ===========================================================================

describe('host-scoped KV cache + host registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not bleed across hosts: write under one host, read under another → null', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    await writeIsrCache(
      env,
      'foo.example',
      '/x',
      new Response('<html>foo</html>', { headers: { 'content-type': 'text/html' } }),
      60,
    );
    // Same path, different host → miss (keys are host-scoped).
    expect(await readIsrCache(env, 'bar.example', '/x')).toBeNull();
    // Same host → hit.
    expect(await readIsrCache(env, 'foo.example', '/x')).not.toBeNull();
  });

  it('registers the host in the registry on write (void-isr-hosts/<id>/<host>)', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    // Unique host so the module-level in-isolate registration guard (shared across
    // this file's tests) does not skip the registry write here.
    const host = 'registry-write.example';
    await writeIsrCache(
      env,
      host,
      '/p',
      new Response('<html>x</html>', { headers: { 'content-type': 'text/html' } }),
      60,
    );
    expect(store.has(hostRegistryKey(DPL, host))).toBe(true);
  });

  it('listIsrHosts returns the registered hosts for a deployment, scoped by id', async () => {
    const { store, kv } = createKvMock();
    store.set(hostRegistryKey(DPL, 'a.example'), { value: new ArrayBuffer(0), metadata: null });
    store.set(hostRegistryKey(DPL, 'b.example'), { value: new ArrayBuffer(0), metadata: null });
    // A different deployment's registration must NOT leak into this list.
    store.set(hostRegistryKey('other_dpl', 'c.example'), {
      value: new ArrayBuffer(0),
      metadata: null,
    });
    const hosts = await listIsrHosts(kv, DPL);
    expect([...hosts].sort()).toEqual(['a.example', 'b.example']);
  });

  it('listIsrHosts fails open to [] on a broken registry (never throws)', async () => {
    const brokenKv = {
      list: vi.fn(async () => {
        throw new Error('KV unavailable');
      }),
    } as unknown as KVNamespace;
    await expect(listIsrHosts(brokenKv, DPL)).resolves.toEqual([]);
  });
});
