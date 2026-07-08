import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { envContext } from '../../src/runtime/env-raw.ts';
import { htmlEdgeKey, isrKey, jsonEdgeKey } from '../../src/runtime/isr-cache.ts';
import { revalidate } from '../../src/runtime/isr.ts';

const DPL = 'dpl_1';
const HOST = 'app.example.com';

// In-memory KV mock. `pageSize` forces the mock to paginate so revalidate's
// cursor loop (`{ all: true }`) is genuinely exercised with a small key set.
function createKvMock(pageSize = 1000) {
  const store = new Map<string, ArrayBuffer>();
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  // Real KV list is a point-in-time view: snapshot the key set when a new
  // list chain starts (cursor absent) so deletions mid-pagination — as
  // revalidate({ all: true }) does — don't shift the offset and skip keys.
  let snapshot: Array<string> = [];
  const list = vi.fn(async (o: { prefix?: string; cursor?: string } = {}) => {
    const prefix = o.prefix ?? '';
    if (!o.cursor) {
      snapshot = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    }
    const start = o.cursor ? Number.parseInt(o.cursor, 10) : 0;
    const slice = snapshot.slice(start, start + pageSize);
    const complete = start + pageSize >= snapshot.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? '' : String(start + pageSize),
    };
  });
  const kv = { delete: del, list } as unknown as KVNamespace;
  return { store, kv, delete: del, list };
}

function createEdgeMock() {
  const store = new Map<string, Response>();
  const del = vi.fn(async (key: string | Request) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    return store.delete(k);
  });
  const cache = { delete: del } as unknown as Cache;
  return { store, cache, delete: del };
}

describe('revalidate — managed (platform proxy)', () => {
  it('forwards { paths } to the proxy /revalidate endpoint (no self-host regression)', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    await envContext.run(
      { __VOID_PROXY: { fetch: fetchMock }, __PROJECT_ID: 'proj_1', __VOID_PROXY_TOKEN: 'tok_1' },
      async () => {
        await revalidate({ paths: ['/', '/blog/x'] });
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy/revalidate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'proj_1',
      aiToken: 'tok_1',
      paths: ['/', '/blog/x'],
    });
  });

  it('forwards { all: true } to the proxy', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    await envContext.run(
      { __VOID_PROXY: { fetch: fetchMock }, __PROJECT_ID: 'proj_1', __VOID_PROXY_TOKEN: 'tok_1' },
      async () => {
        await revalidate({ all: true });
      },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'proj_1',
      aiToken: 'tok_1',
      all: true,
    });
  });

  it('throws when the proxy responds non-ok', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      envContext.run(
        { __VOID_PROXY: { fetch: fetchMock }, __PROJECT_ID: 'proj_1', __VOID_PROXY_TOKEN: 'tok_1' },
        async () => {
          await revalidate({ paths: ['/'] });
        },
      ),
    ).rejects.toThrow(/500/);
  });

  it('throws when project id / proxy token bindings are missing', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    await expect(
      envContext.run({ __VOID_PROXY: { fetch: fetchMock } }, async () => {
        await revalidate({ paths: ['/'] });
      }),
    ).rejects.toThrow(/__PROJECT_ID and __VOID_PROXY_TOKEN/);
  });
});

describe('revalidate — self-host (own ISR_CACHE + edge)', () => {
  let edge: ReturnType<typeof createEdgeMock>;

  beforeEach(() => {
    edge = createEdgeMock();
    vi.stubGlobal('caches', { default: edge.cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes exactly the requested paths from KV and both edge variants', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, '/'), new ArrayBuffer(4));
    store.set(isrKey(DPL, '/blog/x'), new ArrayBuffer(4));
    store.set(isrKey(DPL, '/keepme'), new ArrayBuffer(4));
    edge.store.set(htmlEdgeKey(HOST, '/', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/', DPL), new Response('x'));
    edge.store.set(htmlEdgeKey(HOST, '/blog/x', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/blog/x', DPL), new Response('x'));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => {
        await revalidate({ paths: ['/', '/blog/x'] });
      },
    );

    // Exactly the requested KV keys are gone; the untouched one survives.
    expect(store.has(isrKey(DPL, '/'))).toBe(false);
    expect(store.has(isrKey(DPL, '/blog/x'))).toBe(false);
    expect(store.has(isrKey(DPL, '/keepme'))).toBe(true);
    expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, '/'));
    expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, '/blog/x'));

    // Both edge variants purged for each path.
    expect(edge.store.has(htmlEdgeKey(HOST, '/', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/x', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/x', DPL))).toBe(false);
  });

  it('skips edge purges when no host is configured (KV only)', async () => {
    const { store, kv } = createKvMock();
    store.set(isrKey(DPL, '/'), new ArrayBuffer(4));

    await envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
      await revalidate({ paths: ['/'] });
    });

    expect(store.has(isrKey(DPL, '/'))).toBe(false);
    expect(edge.delete).not.toHaveBeenCalled();
  });

  it('{ all: true } lists and deletes the entire void-isr/<id>/ prefix (cursor-paginated)', async () => {
    // pageSize 2 forces the cursor loop to iterate across multiple pages.
    const { store, kv, list } = createKvMock(2);
    store.set(isrKey(DPL, '/'), new ArrayBuffer(4));
    store.set(isrKey(DPL, '/a'), new ArrayBuffer(4));
    store.set(isrKey(DPL, '/b/c'), new ArrayBuffer(4));
    store.set(isrKey(DPL, '/d'), new ArrayBuffer(4));
    store.set(isrKey(DPL, '/e'), new ArrayBuffer(4));
    // A different deployment's entry must never be touched.
    store.set(isrKey('other_dpl', '/x'), new ArrayBuffer(4));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => {
        await revalidate({ all: true });
      },
    );

    // The entire prefix for THIS deployment is gone; the other survives.
    for (const p of ['/', '/a', '/b/c', '/d', '/e']) {
      expect(store.has(isrKey(DPL, p))).toBe(false);
    }
    expect(store.has(isrKey('other_dpl', '/x'))).toBe(true);
    // Cursor loop ran more than once (5 keys / pageSize 2 → 3 list calls).
    expect(list.mock.calls.length).toBeGreaterThan(1);
    // Edge purge issued for a representative path (round-tripped through denormalizeIsrPath).
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/', DPL));
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/b/c', DPL));
  });
});

describe('revalidate — unconfigured (silent no-op)', () => {
  beforeEach(() => {
    // No caches.default stub — an unconfigured worker must not even reach it.
    vi.stubGlobal('caches', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-ops when neither proxy nor ISR_CACHE is bound', async () => {
    await expect(
      envContext.run({}, async () => {
        await revalidate({ paths: ['/'] });
      }),
    ).resolves.toBeUndefined();
  });

  it('no-ops when ISR_CACHE is bound but the deployment id is missing', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, '/'), new ArrayBuffer(4));
    await envContext.run({ ISR_CACHE: kv }, async () => {
      await revalidate({ paths: ['/'] });
    });
    // Early return before any delete — the key survives.
    expect(store.has(isrKey(DPL, '/'))).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
  });
});
