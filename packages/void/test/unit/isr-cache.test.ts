import {
  cloneWithoutVoidPages,
  deleteIsrCache,
  denormalizeIsrPath,
  handleFrameworkIsr,
  handleIsr,
  hostRegistryKey,
  htmlEdgeKey,
  isrKey,
  isrPrefix,
  isStale,
  jsonEdgeKey,
  listIsrHosts,
  markSharedCachePolicy,
  normalizeIsrPath,
  packIsrValue,
  readIsrCache,
  SHARED_CACHE_POLICY_VERSION,
  writeIsrCache,
  type IsrCacheEnv,
  type IsrCacheMetadata,
  type RenderFn,
} from '@void/isr/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Collapsed self-host deployment id (baked as a compile-time literal on the real
// worker). Every key in this suite is scoped by the shared v3 protocol.
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
    metadata: { s: status, c: createdAt, t: ttl, p: SHARED_CACHE_POLICY_VERSION },
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

function currentSharedCacheResponse(response: Response): Response {
  markSharedCachePolicy(response.headers);
  return response;
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
    name: 'entry admitted before Vary was checked',
    seed: () => ({
      value: packEntry({ vary: 'Accept-Language' }, 'English'),
      metadata: { s: 200, c: BASE, t: 60, p: 2 } as unknown as IsrCacheMetadata,
    }),
  },
  {
    name: 'legacy entry missing shared-cache policy version',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: 60 } as unknown as IsrCacheMetadata,
    }),
  },
  {
    name: 'status out of range (s: 999)',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 999, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'status out of range (s: 0)',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 0, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'invalid header name',
    seed: () => ({
      value: packEntry({ 'Invalid Header Name': 'x' }, 'x'),
      metadata: { s: 200, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'createdAt NaN',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: NaN, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'createdAt Infinity',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: Infinity, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'createdAt negative',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: -1, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'ttl NaN',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: NaN, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'ttl zero',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: 0, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'ttl negative',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: -5, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'malformed packed value',
    seed: () => ({
      value: new ArrayBuffer(2),
      metadata: { s: 200, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
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
  it('uses the shared v3 protocol scoped by deployment id and host', () => {
    expect(isrKey(DPL, HOST, '/')).toBe(`${isrPrefix(DPL)}${HOST}/__index__`);
    expect(isrKey(DPL, HOST, '/blog/x')).toBe(`${isrPrefix(DPL)}${HOST}/blog/x`);
    expect(isrKey(DPL, HOST, '/about/')).toBe(`${isrPrefix(DPL)}${HOST}/about`);
  });

  it('host-scopes the KV key: different hosts never share a cache key', () => {
    expect(isrKey(DPL, 'foo.example', '/x')).not.toBe(isrKey(DPL, 'bar.example', '/x'));
    expect(isrKey(DPL, 'foo.example', '/x')).toBe(`${isrPrefix(DPL)}foo.example/x`);
  });

  it('builds the host-registry key (void-isr-hosts/<id>/<host>), distinct from the cache prefix', () => {
    expect(hostRegistryKey(DPL, HOST)).toBe(`void-isr-hosts/${DPL}/${HOST}`);
    // The registry prefix must NOT collide with the cache prefix, or an `{ all }`
    // list (the shared v3 deployment prefix) would enumerate registry keys as cache keys.
    expect(hostRegistryKey(DPL, HOST).startsWith(isrPrefix(DPL))).toBe(false);
  });

  it('builds HTML edge keys with the deployment id and a canonical pathname', () => {
    expect(htmlEdgeKey(HOST, '/about', DPL)).toBe(`https://${HOST}/about?__void_isr=${DPL}`);
    // Trailing slash canonicalized (matches normalizeIsrPath).
    expect(htmlEdgeKey(HOST, '/about/', DPL)).toBe(`https://${HOST}/about?__void_isr=${DPL}`);
    // Root keeps its slash.
    expect(htmlEdgeKey(HOST, '/', DPL)).toBe(`https://${HOST}/?__void_isr=${DPL}`);
  });

  it('builds JSON edge keys with the shared variant ordering', () => {
    expect(jsonEdgeKey(HOST, '/about', DPL)).toBe(
      `https://${HOST}/about?__void=json&__void_isr=${DPL}`,
    );
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
    expect(meta).toEqual({ s: 200, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION });

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
// cloneWithoutVoidPages
// ===========================================================================

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

  it('caches framework documents but never serves their HTML to data requests', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(
      async () => new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const document = htmlRequest('/news', { Accept: 'text/html' });
    const first = createCtx();
    expect(
      (await handleFrameworkIsr(document, env, first.ctx, OPTS, render))?.headers.get(
        'x-isr-cache',
      ),
    ).toBe('MISS');
    await first.flush();
    expect(store.has(isrKey(DPL, HOST, '/news'))).toBe(true);
    expect(await readIsrCache(env, HOST, '/news')).not.toBeNull();
    expect(edge.store.has(htmlEdgeKey(HOST, '/news', DPL))).toBe(true);

    const second = createCtx();
    expect(
      (await handleFrameworkIsr(document, env, second.ctx, OPTS, render))?.headers.get(
        'x-isr-cache',
      ),
    ).toBe('HIT');
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      await handleFrameworkIsr(
        htmlRequest('/news', { Accept: 'application/json' }),
        env,
        second.ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
    expect(
      await handleFrameworkIsr(
        htmlRequest('/news', { Accept: 'text/html', 'Sec-Fetch-Dest': 'empty' }),
        env,
        second.ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
  });

  it('does not cache framework JSON returned from a document path', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(async () => Response.json({ data: 'private' }));
    const ctx = createCtx();
    const response = await handleFrameworkIsr(
      htmlRequest('/news', { Accept: 'text/html' }),
      env,
      ctx.ctx,
      OPTS,
      render,
    );
    await ctx.flush();
    expect(response?.headers.get('x-isr-cache')).toBeNull();
    expect(store.has(isrKey(DPL, HOST, '/news'))).toBe(false);
  });

  it('evicts stale framework HTML when the fresh render is no longer HTML', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/news', { createdAt: BASE - 120_000 });
    const render = vi.fn(async () => Response.json({ data: true }));
    const ctx = createCtx();
    const stale = await handleFrameworkIsr(
      htmlRequest('/news', { Accept: 'text/html' }),
      env,
      ctx.ctx,
      OPTS,
      render,
    );
    expect(stale?.headers.get('x-isr-cache')).toBe('STALE');
    await ctx.flush();
    expect(store.has(isrKey(DPL, HOST, '/news'))).toBe(false);
  });

  it('leaves an explicitly opted-out page to the live renderer despite a conflicting flat TTL', async () => {
    const { kv } = createKvMock();
    const render = vi.fn(async () => new Response('<html>private</html>'));

    const response = await handleIsr(
      htmlRequest('/private'),
      makeEnv(kv),
      createCtx().ctx,
      {
        revalidate: { '/private': 60 },
        pages: [{ pattern: '/private', revalidate: 0 }],
        pathRevalidate: { '/private': 60 },
        deploymentId: DPL,
      },
      render,
    );

    expect(response).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it('isolates only allowlisted query variants and ignores unrelated parameters', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(async (request: Request) => {
      const q = new URL(request.url).searchParams.get('q');
      return new Response(`<html>${q}</html>`, { headers: { 'content-type': 'text/html' } });
    });
    const options = {
      ...OPTS,
      revalidate: { '/search': 60 },
      queryAllowlist: { '/search': ['q'] },
    };

    const first = createCtx();
    await handleIsr(htmlRequest('/search?q=one'), env, first.ctx, options, render);
    await first.flush();
    const second = createCtx();
    const same = await handleIsr(
      htmlRequest('/search?utm=b&q=one'),
      env,
      second.ctx,
      options,
      render,
    );
    await second.flush();
    const third = createCtx();
    await handleIsr(htmlRequest('/search?q=two'), env, third.ctx, options, render);
    await third.flush();

    expect(same!.headers.get('x-isr-cache')).toBe('HIT');
    expect(await same!.text()).toBe('<html>one</html>');
    expect(render).toHaveBeenCalledTimes(2);
    expect(store.has(isrKey(DPL, HOST, '/search', `https://${HOST}/search?q=one`))).toBe(true);
    expect(store.has(isrKey(DPL, HOST, '/search', `https://${HOST}/search?q=two`))).toBe(true);
    expect(store.has(isrKey(DPL, HOST, '/search'))).toBe(false);
  });

  it('leaves a cold key empty when the request carries a query param outside the allowlist', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(async (request: Request) => {
      const msg = new URL(request.url).searchParams.get('msg') ?? 'clean';
      return new Response(`<html>${msg}</html>`, { headers: { 'content-type': 'text/html' } });
    });

    const poisoned = createCtx();
    const response = await handleIsr(
      htmlRequest('/blog/post?msg=evil'),
      env,
      poisoned.ctx,
      OPTS,
      render,
    );
    await poisoned.flush();
    // The caller renders this request live; nothing reaches a shared cache.
    expect(response).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL)))).toEqual([]);
    expect(edge.store.size).toBe(0);

    const clean = createCtx();
    const fresh = await handleIsr(htmlRequest('/blog/post'), env, clean.ctx, OPTS, render);
    await clean.flush();
    expect(fresh!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await fresh!.text()).toBe('<html>clean</html>');
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(await new Response(entry!.body).text()).toBe('<html>clean</html>');
    expect(
      await edge.store
        .get(htmlEdgeKey(HOST, '/blog/post', DPL))!
        .clone()
        .text(),
    ).toBe('<html>clean</html>');
  });

  it('refreshes a stale entry from the cache key URL when the trigger carries an unlisted param', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { body: '<html>stale</html>', createdAt: BASE, ttl: 60 });
    vi.setSystemTime(BASE + 200_000);
    const { render, requests } = createRender((request) => {
      const msg = new URL(request.url).searchParams.get('msg') ?? 'clean';
      return new Response(`<html>${msg}</html>`, { headers: { 'content-type': 'text/html' } });
    });
    const { ctx, flush } = createCtx();

    const res = await handleIsr(
      htmlRequest('/blog/post?msg=evil', { 'X-Test-Marker': 'keep' }),
      env,
      ctx,
      OPTS,
      render,
    );
    expect(res!.headers.get('x-isr-cache')).toBe('STALE');
    expect(await res!.text()).toBe('<html>stale</html>');
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://${HOST}/blog/post`);
    expect(requests[0]!.headers.get('X-Test-Marker')).toBe('keep');
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(isStale(entry!)).toBe(false);
    expect(await new Response(entry!.body).text()).toBe('<html>clean</html>');
  });

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
    // Exactly one page-cache entry persisted; the host-registry
    // bookkeeping key (`void-isr-hosts/…`) is separate and excluded here.
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(1);
  });

  it.each(['Accept-Language', 'Origin', '*', 'X-VoidPages, ACCEPT-language'])(
    'renders each request live when Vary is unsupported: %s',
    async (vary) => {
      const { store, kv } = createKvMock();
      const env = makeEnv(kv);
      const { render, spy } = createRender(
        (request) =>
          new Response(request.headers.get('Accept-Language'), {
            headers: {
              'Content-Type': 'text/html',
              Vary: vary,
              'x-void-page-data': '{"component":"Home","props":{}}',
            },
          }),
      );
      for (const language of ['en', 'ja']) {
        const { ctx, flush } = createCtx();
        const response = await handleIsr(
          htmlRequest('/blog/post', { 'Accept-Language': language }),
          env,
          ctx,
          OPTS,
          render,
        );
        expect(await response!.text()).toBe(language);
        await flush();
        expect(store.size).toBe(0);
        expect(edge.store.size).toBe(0);
      }
      expect(spy).toHaveBeenCalledTimes(2);
    },
  );

  it('does not share a MISS whose render sets Set-Cookie', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    // The live render emits TWO DISTINCT Set-Cookie headers (session + CSRF).
    // A `Headers` folds duplicates, so an array init is the only way to seed both.
    const { render, spy } = createRender(
      () =>
        new Response('<html>live</html>', {
          headers: [
            ['content-type', 'text/html'],
            ['set-cookie', 'sid=secret; Path=/; HttpOnly'],
            ['set-cookie', 'csrf=tok; Path=/'],
          ],
        }),
    );
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.headers.get('x-isr-cache')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    // The client receives the authoritative response and every cookie.
    expect(res!.headers.getSetCookie()).toEqual([
      'sid=secret; Path=/; HttpOnly',
      'csrf=tok; Path=/',
    ]);

    await flush();
    // A Set-Cookie response is private to this render, so neither HTML nor its
    // embedded Pages JSON may enter a shared cache.
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).toBeNull();
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL)))).toEqual([]);
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
  });

  it.each(['private', 'no-store', 'no-cache'])(
    'does not share a MISS with Cache-Control: %s through HTML or Pages JSON',
    async (cacheControl) => {
      const { store, kv } = createKvMock();
      const env = makeEnv(kv);
      const { render } = createRender(
        () =>
          new Response('<html>private</html>', {
            headers: {
              'Cache-Control': cacheControl,
              'content-type': 'text/html',
              'x-void-page-data': '{"component":"Private","props":{"user":"alice"}}',
            },
          }),
      );
      const { ctx, flush } = createCtx();

      const response = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
      expect(await response!.text()).toBe('<html>private</html>');
      expect(response!.headers.get('Cache-Control')).toBe(cacheControl);
      expect(response!.headers.get('x-isr-cache')).toBeNull();

      await flush();
      expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(false);
      expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
      expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    },
  );

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
    // The revalidation is the one tracked background task. A stale edge warm
    // here would race a private/no-store revalidation that evicts the old page.
    expect(tasks.length).toBe(1);
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
    // The re-render uses the original request (marker preserved, GET, same URL).
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
      currentSharedCacheResponse(
        new Response('<html>edge</html>', { headers: { 'x-isr-cache': 'HIT' } }),
      ),
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

  it('cold-misses an edge entry written before the current privacy policy', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    const key = htmlEdgeKey(HOST, '/blog/post', DPL);
    edge.store.set(key, new Response('<html>legacy-private-body</html>'));
    const { render, spy } = createRender(
      () => new Response('<html>current-public-body</html>', { status: 200 }),
    );
    const { ctx, flush } = createCtx();

    const response = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(await response!.text()).toBe('<html>current-public-body</html>');
    expect(response!.headers.get('x-isr-cache')).toBe('MISS');
    expect(spy).toHaveBeenCalledOnce();
    await flush();

    expect(await edge.store.get(key)!.text()).toBe('<html>current-public-body</html>');
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
    edge.store.set(
      jsonEdgeKey(HOST, '/blog/post', DPL),
      currentSharedCacheResponse(new Response('{"cached":true}')),
    );
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
    expect(res!.headers.get('x-isr-cache')).toBe('HIT');
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
    // No stale edge warm races the purge, so the HTML variant stays absent.
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/blog/post', DPL));
  });

  describe.each([handleIsr, handleFrameworkIsr])('%s removal convergence', (handle) => {
    describe.each(['text/plain', 'text/event-stream'])('with %s', (contentType) => {
      it.each([
        [404, 60, 30 * 86_400, true],
        [410, 60, 30 * 86_400, true],
        [404, 60, 120, false],
        [410, 60, 86_460, false],
        [404, 25 * 3600, 25 * 3600 + 60, false],
        [503, 60, 30 * 86_400, false],
        [429, 60, 30 * 86_400, false],
      ])('handles status %i with TTL %i and age %i', async (status, ttl, age, evicted) => {
        const { store, kv } = createKvMock();
        const env = makeEnv(kv);
        seedEntry(store, '/blog/post', { createdAt: BASE, ttl });
        vi.setSystemTime(BASE + age * 1000);
        const jsonKey = jsonEdgeKey(HOST, '/blog/post', DPL);
        edge.store.set(jsonKey, new Response('{"cached":true}'));
        const render: RenderFn = async () =>
          new Response('removed or unavailable', {
            status,
            headers: {
              'content-type': contentType,
              ...(status >= 429 ? { 'cache-control': 'no-store', 'x-revalidate': '0' } : {}),
            },
          });
        const first = createCtx();
        const request = htmlRequest('/blog/post', { Accept: 'text/html' });
        const stale = await handle(request, env, first.ctx, OPTS, render);
        expect(stale!.headers.get('x-isr-cache')).toBe('STALE');
        await first.flush();
        expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(!evicted);
        expect(edge.store.has(jsonKey)).toBe(!evicted);
        if (evicted) {
          expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/blog/post', DPL));
          const second = createCtx();
          expect((await handle(request, env, second.ctx, OPTS, render))!.status).toBe(status);
          await second.flush();
        }
      });
    });
  });

  it.each([
    ['private', { 'Cache-Control': 'private' }],
    ['no-store', { 'Cache-Control': 'no-store' }],
    ['no-cache', { 'Cache-Control': 'no-cache' }],
    ['Set-Cookie', { 'Set-Cookie': 'sid=private; Path=/; HttpOnly' }],
    ['Vary', { Vary: 'Accept-Language' }],
  ])(
    'authoritative %s background response evicts previously public HTML, JSON, and KV',
    async (_policy, headers) => {
      const { store, kv, delete: kvDelete } = createKvMock();
      const env = makeEnv(kv);
      seedEntry(store, '/blog/post', {
        body: '<html>public</html>',
        createdAt: BASE,
        ttl: 60,
      });
      vi.setSystemTime(BASE + 200_000);
      edge.store.set(jsonEdgeKey(HOST, '/blog/post', DPL), new Response('{"user":null}'));

      const { render, spy } = createRender(
        () =>
          new Response('<html>private</html>', {
            headers: {
              ...headers,
              'content-type': 'text/html',
              'x-void-page-data': '{"component":"Private","props":{"user":"alice"}}',
            },
          }),
      );
      const first = createCtx();

      const stale = await handleIsr(htmlRequest(), env, first.ctx, OPTS, render);
      expect(stale!.headers.get('x-isr-cache')).toBe('STALE');
      expect(await stale!.text()).toBe('<html>public</html>');
      await first.flush();

      expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(false);
      expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, HOST, '/blog/post'));
      expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
      expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);

      // With all old variants gone, the next request renders the authoritative
      // private response and still does not repopulate shared storage.
      const second = createCtx();
      const live = await handleIsr(htmlRequest(), env, second.ctx, OPTS, render);
      expect(await live!.text()).toBe('<html>private</html>');
      expect(live!.headers.get('x-isr-cache')).toBeNull();
      await second.flush();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(false);
      expect(edge.store.size).toBe(0);
    },
  );

  it('bypasses a signed-preview API under a global TTL, so no-store data cannot reach an unauthorized request', async () => {
    const { store, kv, getWithMetadata } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy } = createRender((request) => {
      const signed = request.headers.get('X-Preview-Signature') === 'valid';
      return signed
        ? new Response('{"draft":"secret"}', {
            headers: { 'Cache-Control': 'no-store', 'content-type': 'application/json' },
          })
        : new Response('{"error":"unauthorized"}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
    });
    const serve = async (request: Request): Promise<Response> => {
      const requestCtx = createCtx();
      const cached = await handleIsr(request, env, requestCtx.ctx, OPTS, render);
      const response = cached ?? (await render(request));
      await requestCtx.flush();
      return response;
    };

    const signed = await serve(
      htmlRequest('/api/signed-preview', { 'X-Preview-Signature': 'valid' }),
    );
    expect(await signed.text()).toBe('{"draft":"secret"}');
    expect(signed.headers.get('Cache-Control')).toBe('no-store');

    const unauthorized = await serve(htmlRequest('/api/signed-preview'));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe('{"error":"unauthorized"}');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(getWithMetadata).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(edge.store.size).toBe(0);
  });

  it('bypasses all shared ISR work for an assertion-only Access request', async () => {
    const { kv, getWithMetadata, put } = createKvMock();
    const { render, spy } = createRender(() => new Response('private profile'));
    const { ctx, tasks } = createCtx();

    expect(
      await handleIsr(
        htmlRequest('/blog/post', { 'Cf-Access-Jwt-Assertion': 'signed-access-assertion' }),
        makeEnv(kv),
        ctx,
        OPTS,
        render,
      ),
    ).toBeNull();

    expect(edge.match).not.toHaveBeenCalled();
    expect(getWithMetadata).not.toHaveBeenCalled();
    expect(edge.put).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
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
    // Credentialed requests bypass ISR.
    expect(
      await handleIsr(htmlRequest('/blog/post', { Cookie: 'sid=1' }), env, ctx, OPTS, render),
    ).toBeNull();
    expect(
      await handleIsr(
        htmlRequest('/blog/post', { Authorization: 'Bearer private' }),
        env,
        ctx,
        OPTS,
        render,
      ),
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
    // Exactly one page-cache entry; the registry key is separate.
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(1);
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

  // =========================================================================
  // Range bypass + full-200-only cache gate
  // A Range GET on an ISR path (e.g. a byte-range media route under a global
  // `revalidate: "*"`) must render LIVE so the origin emits a correct `206
  // Partial Content`. It must never read the shared (host,path) entry (a full
  // body for a partial request) nor write it (a truncated 206 that a later full
  // request would then be served). Defense-in-depth: the write gate is tightened
  // from `response.ok` (200–299, INCLUDING 206) to `status === 200`, so even a
  // non-range render that returns 206/204/etc. never lands in the shared cache.
  // =========================================================================
  describe('Range bypass + full-200-only cache gate', () => {
    it('bypasses ISR for a Range request → null before any cache read, render, or write', async () => {
      const { store, kv, getWithMetadata, put } = createKvMock();
      const env = makeEnv(kv);
      const { render, spy } = createRender(
        () => new Response('SHOULD-NOT-RENDER', { status: 206 }),
      );
      const { ctx, tasks } = createCtx();

      const res = await handleIsr(
        htmlRequest('/blog/post', { Range: 'bytes=0-1023' }),
        env,
        ctx,
        OPTS,
        render,
      );

      // Range requests render live (the caller handles them) — handleIsr bails.
      expect(res).toBeNull();
      // No cache READ: neither the L1 edge nor the L2 KV was consulted.
      expect(edge.match).not.toHaveBeenCalled();
      expect(getWithMetadata).not.toHaveBeenCalled();
      // No render kicked off inside handleIsr, and no cache WRITE scheduled.
      expect(spy).not.toHaveBeenCalled();
      expect(edge.put).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
      expect(store.size).toBe(0);
      expect(edge.store.size).toBe(0);
    });

    it('does NOT cache a forced 206 render (non-range) — only full 200 responses are written', async () => {
      const { store, kv, put } = createKvMock();
      const env = makeEnv(kv);
      // No Range header on the request, yet the render returns 206 — the tightened
      // write gate (status === 200, not response.ok) must still refuse to persist it.
      const { render, spy } = createRender(
        () =>
          new Response('<html>partial</html>', {
            status: 206,
            headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-9/100' },
          }),
      );
      const { ctx, tasks, flush } = createCtx();

      const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);

      // The live 206 is returned to the client verbatim (never rewritten to 200).
      expect(res).not.toBeNull();
      expect(res!.status).toBe(206);
      expect(await res!.text()).toBe('<html>partial</html>');
      expect(spy).toHaveBeenCalledTimes(1);

      await flush();
      // Nothing persisted: a 206 partial body must never enter a shared full-
      // response cache (KV or edge), and no write was even scheduled.
      expect(tasks).toHaveLength(0);
      expect(put).not.toHaveBeenCalled();
      expect(edge.put).not.toHaveBeenCalled();
      expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(0);
      expect(edge.store.size).toBe(0);
      expect(await readIsrCache(env, HOST, '/blog/post')).toBeNull();
    });

    it('still writes + serves a full 200 render (the tightened gate does not block 200)', async () => {
      const { store, kv, put } = createKvMock();
      const env = makeEnv(kv);
      const { render, spy } = createRender(
        () =>
          new Response('<html>ok-200</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      );
      const { ctx, flush } = createCtx();

      const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
      expect(res!.status).toBe(200);
      expect(res!.headers.get('x-isr-cache')).toBe('MISS');
      expect(await res!.text()).toBe('<html>ok-200</html>');
      expect(spy).toHaveBeenCalledTimes(1);

      await flush();
      // The 200 render lands in KV + the HTML edge variant, exactly as before.
      expect(put).toHaveBeenCalled();
      const entry = await readIsrCache(env, HOST, '/blog/post');
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe(200);
      expect(await new Response(entry!.body).text()).toBe('<html>ok-200</html>');
      expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(true);
      expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(1);
    });
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

  it('retries host registration on a later write after a transient registry-put failure', async () => {
    // Unique host so the module-level in-isolate registration guard does not pre-skip it.
    const host = 'registry-retry.example';
    const store = new Map<string, KvRecord>();
    let registryPuts = 0;
    const put = vi.fn(
      async (key: string, value: ArrayBuffer, options?: { metadata?: IsrCacheMetadata }) => {
        if (key.startsWith('void-isr-hosts/')) {
          registryPuts++;
          if (registryPuts === 1) {
            throw new Error('transient registry failure');
          }
        }
        store.set(key, { value, metadata: options?.metadata ?? null });
      },
    );
    const list = vi.fn(async (o: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(o.prefix ?? ''))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    }));
    const kv = { put, list, getWithMetadata: vi.fn(), delete: vi.fn() } as unknown as KVNamespace;
    const env = makeEnv(kv);
    const res = () => new Response('<html>x</html>', { headers: { 'content-type': 'text/html' } });

    // First write: content put succeeds, registry put throws → guard cleared, host unregistered.
    await writeIsrCache(env, host, '/p', res(), 60);
    expect(store.has(hostRegistryKey(DPL, host))).toBe(false);

    // Second write: the guard was cleared, so the registry put is retried and succeeds.
    await writeIsrCache(env, host, '/p', res(), 60);
    expect(registryPuts).toBe(2);
    expect(store.has(hostRegistryKey(DPL, host))).toBe(true);
    expect(await listIsrHosts(kv, DPL)).toContain(host);
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
