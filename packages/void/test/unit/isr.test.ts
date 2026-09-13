import { hostRegistryKey, htmlEdgeKey, isrKey, isrPrefix, jsonEdgeKey } from '@void/isr/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { envContext } from '../../src/runtime/env-raw.ts';
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
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('ok', { status: 200 }),
    );
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
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('ok', { status: 200 }),
    );
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

  it('{ paths } (request host) deletes EXACTLY the requested (host, path) entries from KV and both edge variants — no over-purge', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/blog/x'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/keepme'), new ArrayBuffer(4));
    // Target edge variants (both should be purged).
    edge.store.set(htmlEdgeKey(HOST, '/', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/', DPL), new Response('x'));
    edge.store.set(htmlEdgeKey(HOST, '/blog/x', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/blog/x', DPL), new Response('x'));
    // UNRELATED edge variants for a path NOT being revalidated — an over-purging
    // implementation (e.g. deleting sibling variants, or purging by prefix) would
    // wrongly remove these. They MUST survive.
    edge.store.set(htmlEdgeKey(HOST, '/keepme', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/keepme', DPL), new Response('x'));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => {
        await revalidate({ paths: ['/', '/blog/x'] });
      },
    );

    // Exactly the requested (host, path) KV keys are gone; the untouched one survives.
    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(false);
    expect(store.has(isrKey(DPL, HOST, '/blog/x'))).toBe(false);
    expect(store.has(isrKey(DPL, HOST, '/keepme'))).toBe(true);

    // Both edge variants purged for each requested path; unrelated ones survive.
    expect(edge.store.has(htmlEdgeKey(HOST, '/', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/x', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/x', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/keepme', DPL))).toBe(true);
    expect(edge.store.has(jsonEdgeKey(HOST, '/keepme', DPL))).toBe(true);

    // EXACT KV delete calls: precisely the two requested (host, path) keys, no
    // extras. An over-purge (e.g. also deleting `/keepme`) would fail here.
    expect(kvDelete).toHaveBeenCalledTimes(2);
    expect(kvDelete.mock.calls.map((c) => c[0])).toEqual([
      isrKey(DPL, HOST, '/'),
      isrKey(DPL, HOST, '/blog/x'),
    ]);

    // EXACT edge delete calls: html + json for each requested path (correct
    // host/id), in purge order, with no unrelated deletes.
    expect(edge.delete).toHaveBeenCalledTimes(4);
    expect(edge.delete.mock.calls.map((c) => c[0])).toEqual([
      htmlEdgeKey(HOST, '/', DPL),
      jsonEdgeKey(HOST, '/', DPL),
      htmlEdgeKey(HOST, '/blog/x', DPL),
      jsonEdgeKey(HOST, '/blog/x', DPL),
    ]);
  });

  it('{ paths } deletes every allowlisted query variant from KV and edge cache', async () => {
    const { store, kv } = createKvMock();
    const variantA = `https://${HOST}/search?q=a`;
    const variantB = `https://${HOST}/search?q=b`;
    store.set(isrKey(DPL, HOST, '/search', variantA), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/search', variantB), new ArrayBuffer(4));
    edge.store.set(htmlEdgeKey(HOST, '/search', DPL, variantA), new Response('a'));
    edge.store.set(jsonEdgeKey(HOST, '/search', DPL, variantA), new Response('a'));
    edge.store.set(htmlEdgeKey(HOST, '/search', DPL, variantB), new Response('b'));
    edge.store.set(jsonEdgeKey(HOST, '/search', DPL, variantB), new Response('b'));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => revalidate({ paths: ['/search'] }),
    );

    expect(store.has(isrKey(DPL, HOST, '/search', variantA))).toBe(false);
    expect(store.has(isrKey(DPL, HOST, '/search', variantB))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/search', DPL, variantA))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/search', DPL, variantA))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/search', DPL, variantB))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/search', DPL, variantB))).toBe(false);
  });

  // Cron/queue handlers stamp the deployment id WITHOUT a request host (the F1
  // fix), so a host-less `revalidate({ paths })` must enumerate EVERY registered
  // host from the registry and purge each host's (host, path) entry.
  it('{ paths } with NO request host purges every REGISTERED host (cron/queue purge via registry)', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    const HOST_A = 'a.example';
    const HOST_B = 'b.example';
    // Two hosts have cached the same path; both are registered.
    store.set(isrKey(DPL, HOST_A, '/p'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST_B, '/p'), new ArrayBuffer(4));
    store.set(hostRegistryKey(DPL, HOST_A), new ArrayBuffer(0));
    store.set(hostRegistryKey(DPL, HOST_B), new ArrayBuffer(0));
    edge.store.set(htmlEdgeKey(HOST_A, '/p', DPL), new Response('x'));
    edge.store.set(htmlEdgeKey(HOST_B, '/p', DPL), new Response('x'));

    // NO __VOID_ISR_HOST — the cron/queue path relies entirely on the registry.
    await envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
      await revalidate({ paths: ['/p'] });
    });

    // Both registered hosts' KV + edge entries purged.
    expect(store.has(isrKey(DPL, HOST_A, '/p'))).toBe(false);
    expect(store.has(isrKey(DPL, HOST_B, '/p'))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST_A, '/p', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST_B, '/p', DPL))).toBe(false);
    // One KV delete per registered host (order-independent).
    expect(kvDelete.mock.calls.map((c) => c[0]).sort()).toEqual(
      [isrKey(DPL, HOST_A, '/p'), isrKey(DPL, HOST_B, '/p')].sort(),
    );
  });

  it('{ paths } with no request host and an EMPTY registry is a silent no-op (nothing purged)', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));

    await envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
      await revalidate({ paths: ['/'] });
    });

    // No registered host and no request host → no host to purge → key survives.
    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
    expect(edge.delete).not.toHaveBeenCalled();
  });

  // The authoritative KV purge must never depend on the Cache API: the edge purge
  // is guarded, so a degraded `caches.default` (scheduled/queue handlers, or no
  // Cache API) fails open without blocking the KV delete.
  it('purges KV via the registry even when the Cache API is degraded (edge fails open, KV still purged)', async () => {
    // Degraded Cache API: reading `caches.default` throws.
    vi.stubGlobal('caches', {
      get default(): Cache {
        throw new Error('Cache API unavailable');
      },
    });

    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    store.set(hostRegistryKey(DPL, HOST), new ArrayBuffer(0));

    // No __VOID_ISR_HOST → host comes from the registry; the degraded edge must
    // not throw and must not block the KV purge.
    await expect(
      envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
        await revalidate({ paths: ['/'] });
      }),
    ).resolves.toBeUndefined();

    // KV delete completed despite the swallowed edge throw.
    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(false);
    expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, HOST, '/'));
  });

  it('{ all: true } lists the shared deployment prefix, splits each host, and purges every entry across pages', async () => {
    // pageSize 2 forces the cursor loop to iterate across multiple pages.
    const { store, kv, list } = createKvMock(2);
    const HOST2 = 'other.example';
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/a'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/b/c'), new ArrayBuffer(4));
    // A SECOND host under the same deployment — its key must be purged too, and
    // its host must be split back out of the scanned key correctly.
    store.set(isrKey(DPL, HOST2, '/d'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/e'), new ArrayBuffer(4));
    // A different deployment's entry must never be touched.
    store.set(isrKey('other_dpl', HOST, '/x'), new ArrayBuffer(4));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => {
        await revalidate({ all: true });
      },
    );

    // Every (host, path) under THIS deployment is gone; the other deployment survives.
    for (const [h, p] of [
      [HOST, '/'],
      [HOST, '/a'],
      [HOST, '/b/c'],
      [HOST2, '/d'],
      [HOST, '/e'],
    ] as const) {
      expect(store.has(isrKey(DPL, h, p))).toBe(false);
    }
    expect(store.has(isrKey('other_dpl', HOST, '/x'))).toBe(true);
    // Cursor loop ran more than once (5 keys / pageSize 2 → 3 list calls).
    expect(list.mock.calls.length).toBeGreaterThan(1);
    // EVERY list call is scoped to THIS deployment's prefix. An unscoped
    // `kv.list()` (or a wrong/missing prefix) would enumerate — and therefore
    // purge — other deployments' keys; assert the prefix on every page.
    const listPrefix = isrPrefix(DPL);
    for (const [opts] of list.mock.calls) {
      expect((opts as { prefix?: string }).prefix).toBe(listPrefix);
    }
    // The first page starts with no cursor.
    expect((list.mock.calls[0][0] as { cursor?: string }).cursor).toBeUndefined();
    // Edge purge issued with the host SPLIT from the scanned key (path round-tripped
    // through denormalizeIsrPath), including the second host.
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/', DPL));
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/b/c', DPL));
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST2, '/d', DPL));
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
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    await envContext.run({ ISR_CACHE: kv }, async () => {
      await revalidate({ paths: ['/'] });
    });
    // Early return before any delete — the key survives.
    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
  });
});
