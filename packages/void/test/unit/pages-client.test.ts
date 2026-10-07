import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createVoidRouter, ssrProxy } from '../../src/pages/client.ts';
import { createPageNavigationEngine } from '../../src/pages/navigation-engine.ts';
import { parseCacheFor } from '../../src/pages/prefetch.ts';

type DeferredTestWindow = Window & {
  __resolveDeferred(group: string, data: unknown): void;
};

function stubClientGlobals() {
  const documentStub = {
    createElement: vi.fn(() => ({})),
    getElementById: vi.fn((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            props: {},
          }),
        };
      }
      if (id === 'app') {
        return {
          getAttribute: vi.fn((): string | null => null),
        };
      }
      return null;
    }),
    head: {
      appendChild: vi.fn(),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
    querySelector: vi.fn(() => null),
  };

  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    location: {
      origin: 'http://localhost',
      pathname: '/',
      search: '',
      hash: '',
    },
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(),
  });
  vi.stubGlobal('history', {
    pushState: vi.fn(),
    replaceState: vi.fn(),
    scrollRestoration: 'auto',
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });

  return documentStub;
}

describe('createVoidRouter prefetch', () => {
  it('requires the page-data script even when a legacy data-page attribute is present', async () => {
    const documentStub = stubClientGlobals();
    documentStub.getElementById.mockImplementation((id: string) =>
      id === 'app'
        ? { getAttribute: vi.fn(() => JSON.stringify({ component: 'home', props: {} })) }
        : null,
    );
    await expect(
      createVoidRouter({
        adapter: {
          applyUpdate: vi.fn(),
          createDeferred: () => ({}),
          isLoading: () => false,
          resolveDeferred: (_ref, value) => value,
          rejectDeferred: (_ref, error) => error,
        },
        components: { home: async () => ({ default: {} }) },
        layoutTree: {},
        routeMeta: {},
        matchRoute: () => 'home',
        viewTransitions: false,
        prefetchHoverDelay: 75,
        prefetchDefaultCacheFor: parseCacheFor('30s'),
      }),
    ).rejects.toThrow('pages: Missing initial page payload.');
  });

  it.each([
    [{}, false],
    [{ method: 'POST' }, true],
    [{ preserveState: true }, true],
    [{ method: 'POST', preserveState: false }, false],
  ] as const)('passes page preservation to the adapter for %j', async (options, preserveState) => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    const applyUpdate = vi.fn();
    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: () => ({}),
        isLoading: () => false,
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: (_ref, error) => error,
      },
      components: { home: async () => ({ default: {} }) },
      layoutTree: {},
      routeMeta: {},
      matchRoute: () => 'home',
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
    });
    await router.visit('/next', options);
    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns stable route values from the SSR proxy', () => {
    expect(ssrProxy.path).toBe('/');
    expect(ssrProxy.url.pathname).toBe('/');
    expect(ssrProxy.query.toString()).toBe('');
    expect(() => ssrProxy.visit('/users')).toThrow(
      'Void Router: visit() is not available during SSR.',
    );
  });

  it('rejects non-GET methods before route side effects', async () => {
    const documentStub = stubClientGlobals();
    const homeLoader = vi.fn(async () => ({ default: {} }));
    const usersLoader = vi.fn(async () => ({ default: {} }));
    const layoutLoader = vi.fn(async () => ({ default: {} }));
    const matchRoute = vi.fn(() => 'users');

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: homeLoader,
        layout: layoutLoader,
        users: usersLoader,
      },
      layoutTree: {
        users: ['layout'],
      },
      matchRoute,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {
        users: {},
      },
      viewTransitions: false,
    });

    expect(() => router.prefetch('/users', { method: 'POST' })).toThrow(
      'Void Router: prefetch() only supports GET requests.',
    );
    expect(matchRoute).not.toHaveBeenCalled();
    expect(usersLoader).not.toHaveBeenCalled();
    expect(layoutLoader).not.toHaveBeenCalled();
    expect(documentStub.createElement).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();
  });

  it('returns a promise that resolves when page data is prefetched', async () => {
    stubClientGlobals();
    const pageData = {
      component: 'users',
      props: { users: [] },
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json(pageData, { headers: { 'X-VoidPages': 'true' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
        users: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/users' ? 'users' : 'home')),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {
        users: {},
      },
      viewTransitions: false,
    });

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['replace', 'mutate'])(
    'keeps prefetched deferred data intact with %s adapters',
    async (mode) => {
      stubClientGlobals();
      const pageData = {
        component: 'users',
        props: { stats: { count: 42 } },
        deferredKeys: { stats: 'stats' },
      };
      const fetchMock = vi.fn(async () =>
        Response.json(pageData, { headers: { 'X-VoidPages': 'true' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const applyUpdate = vi.fn();
      const { router } = await createVoidRouter({
        adapter: {
          applyUpdate,
          createDeferred: () => ({ loading: true, value: null, error: null }),
          isLoading: (ref) => (ref as { loading: boolean }).loading,
          resolveDeferred: (ref, value) =>
            mode === 'mutate'
              ? Object.assign(ref as object, { loading: false, value })
              : { loading: false, value, error: null },
          rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        },
        components: { home: async () => ({ default: {} }), users: async () => ({ default: {} }) },
        layoutTree: {},
        routeMeta: {},
        matchRoute: () => 'users',
        viewTransitions: false,
        prefetchHoverDelay: 75,
        prefetchDefaultCacheFor: parseCacheFor('30s'),
      });
      try {
        await router.prefetch('/users');
        for (let visit = 0; visit < 3; visit++) {
          await router.visit('/users');
          const rendered = applyUpdate.mock.calls.at(-1)![0];
          expect(rendered.props.stats).toEqual({
            loading: false,
            value: { count: 42 },
            error: null,
          });
          // Component mutations must not become part of the next cached visit either.
          rendered.props.stats.value.count = 100;
          expect(await router.prefetch('/users')).toEqual(pageData);
        }
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        router.flushAll();
      }
    },
  );

  it('serves revalidated data after a stale-while-revalidate refresh', async () => {
    stubClientGlobals();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        n += 1;
        return Promise.resolve(
          Response.json(
            { component: 'users', props: { v: n } },
            { headers: { 'X-VoidPages': 'true' } },
          ),
        );
      }),
    );

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
        users: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/users' ? 'users' : 'home')),
      prefetchDefaultCacheFor: parseCacheFor(['5ms', '10s']),
      prefetchHoverDelay: 75,
      routeMeta: { users: {} },
      viewTransitions: false,
    });

    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { v: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Visit while stale: serves v:1 and fires the background revalidate to v:2.
    await router.visit('/users');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The next read must return the revalidated v:2, not the discarded-refresh stale v:1.
    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { v: 2 } });
  });

  it('reuses visited GET page shells while their refresh is pending when opted in', async () => {
    stubClientGlobals();
    let requests = 0;
    let finishRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => {
      requests += 1;
      if (requests === 3) {
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      }
      return Promise.resolve(
        Response.json(
          { component: requests === 2 ? 'other' : 'users', props: { version: requests } },
          { headers: { 'X-VoidPages': 'true' } },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: () => ({}),
        isLoading: () => false,
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: (_ref, error) => error,
      },
      components: {
        home: async () => ({ default: {} }),
        users: async () => ({ default: {} }),
        other: async () => ({ default: {} }),
      },
      layoutTree: {},
      routeMeta: {},
      matchRoute: (url) => (url === '/users' ? 'users' : 'other'),
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
      cacheVisitedPageData: true,
    });

    await router.visit('/users');
    await router.visit('/other');
    const revisit = await router.visit('/users');
    expect(revisit).toMatchObject({ props: { version: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(applyUpdate.mock.lastCall?.[0]).toMatchObject({ props: { version: 1 } });

    expect(finishRefresh).toBeTypeOf('function');
    finishRefresh!(
      Response.json(
        { component: 'users', props: { version: 3 } },
        { headers: { 'X-VoidPages': 'true' } },
      ),
    );
    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { version: 3 } });
  });

  it('reuses the server-rendered initial page on a return visit', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/dashboard';
    vi.mocked(documentStub.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'dashboard',
            props: { version: 1 },
            params: {},
            shared: {},
            url: '/dashboard',
            errors: null,
          }),
        };
      }
      return id === 'app' ? { getAttribute: () => null } : null;
    });
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          {
            component: url === '/users' ? 'users' : 'dashboard',
            props: { version: url === '/users' ? 2 : 3 },
          },
          { headers: { 'X-VoidPages': 'true' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: () => ({}),
        isLoading: () => false,
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: (_ref, error) => error,
      },
      components: {
        dashboard: async () => ({ default: {} }),
        users: async () => ({ default: {} }),
      },
      layoutTree: {},
      routeMeta: {},
      matchRoute: (url) => (url === '/dashboard' ? 'dashboard' : 'users'),
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
      cacheVisitedPageData: true,
    });

    await router.visit('/users');
    await expect(router.visit('/dashboard')).resolves.toMatchObject({ props: { version: 1 } });
    await expect(router.prefetch('/dashboard')).resolves.toMatchObject({ props: { version: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not resolve disposed initial deferred props into a later page', async () => {
    stubClientGlobals();
    const initialPayload = {
      component: 'home',
      deferredKeys: { stats: 'stats' },
      props: { stats: { loading: true, value: null, error: null } },
    };
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return { textContent: JSON.stringify(initialPayload) } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const rejectDeferred = vi.fn((_ref, error) => ({
      loading: false,
      value: null,
      error: new Error(error),
    }));
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              component: 'next',
              props: { title: 'Next' },
            },
            { headers: { 'X-VoidPages': 'true' } },
          ),
        ),
      ),
    );

    const { router, start } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
        next: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn(() => 'next'),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    start();
    await router.visit('/next');

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'next' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
    expect(rejectDeferred).toHaveBeenCalledTimes(1);

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).not.toHaveBeenCalled();
  });

  it('runs navigation listeners for same-page hash visits', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    const matchRoute = vi.fn(() => 'home');
    vi.stubGlobal('fetch', vi.fn());

    const events: Array<string> = [];
    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
      onNavigationChange(navigation) {
        events.push(navigation.state);
      },
    });

    await router.visit('#section');

    expect(events).toEqual(['loading', 'idle']);
    expect(history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/docs?tab=api#section',
    );
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(matchRoute).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();
  });

  it('keeps pending navigation state when an older visit aborts', async () => {
    stubClientGlobals();
    let resolveFast!: (response: Response) => void;
    const events: Array<string> = [];
    const applyUpdate = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        if (url === '/fast') {
          return new Promise<Response>((resolve) => {
            resolveFast = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        fast: vi.fn(async () => ({ default: {} })),
        home: vi.fn(async () => ({ default: {} })),
        slow: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => {
        if (url === '/slow') {
          return 'slow';
        }
        if (url === '/fast') {
          return 'fast';
        }
        return 'home';
      }),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
      onNavigationChange(navigation) {
        events.push(navigation.state);
      },
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fastVisit = router.visit('/fast');
    await slowVisit;

    expect(events).toEqual(['loading', 'loading']);

    resolveFast(
      Response.json(
        {
          component: 'fast',
          props: { title: 'Fast' },
        },
        { headers: { 'X-VoidPages': 'true' } },
      ),
    );
    await fastVisit;

    expect(events).toEqual(['loading', 'loading', 'idle']);
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'fast' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
  });

  it('resolves abandoned GET visits without surfacing abort errors to fire-and-forget callers', async () => {
    stubClientGlobals();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        if (url === '/fast') {
          return Promise.resolve(
            Response.json(
              {
                component: 'fast',
                props: { title: 'Fast' },
              },
              { headers: { 'X-VoidPages': 'true' } },
            ),
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        fast: vi.fn(async () => ({ default: {} })),
        home: vi.fn(async () => ({ default: {} })),
        slow: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => {
        if (url === '/slow') {
          return 'slow';
        }
        if (url === '/fast') {
          return 'fast';
        }
        return 'home';
      }),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    const slowVisit = router.visit('/slow');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.visit('/fast');

    await expect(slowVisit).resolves.toBeUndefined();
  });

  it('does not fetch or write history for same-page hash popstate visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn());

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn(() => 'home'),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    await router.visit('/docs?tab=api#section', {
      preserveState: true,
      _popstate: true,
      _scrollPosition: { x: 0, y: 42 },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 42);
  });

  it('does not fetch or write history for same-page hash removal popstate visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    const matchRoute = vi.fn(() => 'home');
    vi.stubGlobal('fetch', vi.fn());

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    await router.visit('/docs?tab=api', {
      preserveState: true,
      _popstate: true,
      _scrollPosition: { x: 0, y: 42 },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(matchRoute).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 42);
  });

  it('does not write history for same-page hash visits when state is preserved', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn());

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn(() => 'home'),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    await router.visit('#section', { preserveState: true });

    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('uses the browser URL for non-popstate hash visits after preserved navigation', async () => {
    stubClientGlobals();
    window.location.pathname = '/';
    const applyUpdate = vi.fn();
    const fetchMock = vi.fn((url: string) => {
      if (url !== '/next') {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Promise.resolve(
        Response.json(
          {
            component: 'next',
            props: { title: 'Next' },
          },
          { headers: { 'X-VoidPages': 'true' } },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
        next: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/next' ? 'next' : 'home')),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    await router.visit('/next', { preserveState: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/next',
      expect.objectContaining({ headers: { 'X-VoidPages': 'true', Accept: 'application/json' } }),
    );
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'next' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );

    fetchMock.mockClear();
    applyUpdate.mockClear();
    vi.mocked(history.pushState).mockClear();
    vi.mocked(history.replaceState).mockClear();
    vi.mocked(window.scrollTo).mockClear();

    await router.visit('#section');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/#section',
    );
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('aborts pending navigations before same-page hash popstate visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    const applyUpdate = vi.fn();
    let aborted = false;
    let resolveSlow!: (response: Response) => void;
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url !== '/slow') {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<Response>((resolve) => {
        resolveSlow = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
        slow: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/slow' ? 'slow' : 'home')),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await router.visit('/docs#section', {
      preserveState: true,
      _popstate: true,
      _scrollPosition: { x: 0, y: 42 },
    });

    expect(aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 42);

    resolveSlow(
      Response.json(
        {
          component: 'slow',
          props: { title: 'Slow' },
        },
        { headers: { 'X-VoidPages': 'true' } },
      ),
    );
    await slowVisit;

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('fetches when a popstate hash visit targets a different committed page', async () => {
    stubClientGlobals();
    window.location.pathname = '/users';
    const applyUpdate = vi.fn();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json(
          {
            component: 'docs',
            props: { title: 'Docs' },
          },
          { headers: { 'X-VoidPages': 'true' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        docs: vi.fn(async () => ({ default: {} })),
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn(() => 'docs'),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    window.location.pathname = '/docs';
    await router.visit('/docs#section', {
      preserveState: true,
      _popstate: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/docs',
      expect.objectContaining({ headers: { 'X-VoidPages': 'true', Accept: 'application/json' } }),
    );
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'docs' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
  });

  it('keeps preserved initial deferred props alive after a mutation commits', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { stats: 'stats' },
            props: { stats: { loading: true, value: null, error: null } },
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const initialRef = { loading: true, value: null, error: null };
    const resolveDeferred = vi.fn((ref, value) => {
      ref.loading = false;
      ref.value = value;
      return ref;
    });
    const rejectDeferred = vi.fn((ref, error) => {
      ref.loading = false;
      ref.error = new Error(error);
      return ref;
    });
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              component: 'home',
              props: { stats: null, title: 'Updated' },
            },
            { headers: { 'X-VoidPages': 'true' } },
          ),
        ),
      ),
    );

    const { router, start } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => initialRef),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn(() => 'home'),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    start();
    await router.visit('/', { method: 'POST', data: { ok: true } });

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ stats: initialRef, title: 'Updated' }),
      }),
      expect.anything(),
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
    expect(rejectDeferred).not.toHaveBeenCalled();

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).toHaveBeenCalledWith(initialRef, { count: 42 });
    expect(initialRef).toMatchObject({
      loading: false,
      value: { count: 42 },
      error: null,
    });
  });

  it('keeps the committed page deferred registry alive while a new navigation is pending', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { stats: 'stats' },
            props: { stats: { loading: true, value: null, error: null } },
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const rejectDeferred = vi.fn((_ref, error) => ({
      loading: false,
      value: null,
      error: new Error(error),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        return Promise.resolve(
          Response.json(
            {
              component: 'fast',
              props: { title: 'Fast' },
            },
            { headers: { 'X-VoidPages': 'true' } },
          ),
        );
      }),
    );

    const { router, start } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: {
        fast: vi.fn(async () => ({ default: {} })),
        home: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/slow' ? 'slow' : 'fast')),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    start();
    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });
    expect(resolveDeferred).toHaveBeenCalledWith(expect.anything(), { count: 42 });

    await router.visit('/fast');
    await slowVisit;
    expect(rejectDeferred).not.toHaveBeenCalled();
  });

  it('ignores deferred chunks from an aborted pending navigation', async () => {
    stubClientGlobals();

    let slowStreamController!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const slowComponent = new Promise<{ default: unknown }>(() => {});

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/slow') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              slowStreamController = controller;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    component: 'slow',
                    deferredKeys: { stats: 'stats' },
                    props: { title: 'Slow', stats: { loading: true, value: null, error: null } },
                  }) + '\n',
                ),
              );
            },
          });
          return Promise.resolve(
            new Response(stream, {
              headers: {
                'content-type': 'application/x-ndjson',
                'X-VoidPages': 'true',
              },
            }),
          );
        }
        return Promise.resolve(
          Response.json(
            {
              component: 'fast',
              props: { title: 'Fast' },
            },
            { headers: { 'X-VoidPages': 'true' } },
          ),
        );
      }),
    );

    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred: vi.fn((_ref, error) => ({
          loading: false,
          value: null,
          error: new Error(error),
        })),
        resolveDeferred,
      },
      components: {
        fast: vi.fn(async () => ({ default: {} })),
        home: vi.fn(async () => ({ default: {} })),
        slow: vi.fn(() => slowComponent),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/slow' ? 'slow' : 'fast')),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.visit('/fast');

    slowStreamController.enqueue(
      encoder.encode(JSON.stringify({ __deferred: 'stats', data: { count: 1 } }) + '\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await slowVisit;

    expect(resolveDeferred).not.toHaveBeenCalled();
  });
});

describe('createVoidRouter other-origin visits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createRouter() {
    stubClientGlobals();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { component: 'users', props: { users: [] } },
        { headers: { 'X-VoidPages': 'true' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createVoidRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: vi.fn(async () => ({ default: {} })),
        users: vi.fn(async () => ({ default: {} })),
      },
      layoutTree: {},
      matchRoute: vi.fn((url) => (url === '/users' ? 'users' : 'home')),
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {},
      viewTransitions: false,
    });
    return { router, fetchMock, applyUpdate };
  }

  it.each(['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x'])(
    'rejects %j without fetching or assigning location',
    async (url) => {
      const { router, fetchMock, applyUpdate } = await createRouter();

      await expect(router.visit(url)).rejects.toThrow(/refusing to navigate/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(applyUpdate).not.toHaveBeenCalled();
      expect(window.location.href).toBeUndefined();
    },
  );

  it('rejects a same-origin blob URL passed straight to the navigation engine', async () => {
    stubClientGlobals();
    const fetchMock = vi.fn(
      async () => new Response('<script></script>', { headers: { 'Content-Type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const engine = await createPageNavigationEngine({
      adapter: {
        createDeferred: () => ({}),
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: (_ref, error) => error,
        isLoading: () => false,
      },
      components: { home: async () => ({ default: {} }) },
      layoutTree: {},
      routeMeta: {},
      matchRoute: () => 'home',
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
    });

    const resource = engine.prepareVisit(
      'blob:http://localhost/0b5e4c1a-7f0d-4f9e-9b52-1c3d2e4f5a6b',
    );

    await expect(resource.shell).rejects.toThrow('refusing to navigate to a blob: URL');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it('sends other-origin http(s) GET visits to a full page load without fetching', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();

    await expect(router.visit('https://other.example/x?y=1#z')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(window.location.href).toBe('https://other.example/x?y=1#z');
  });

  it('rejects non-GET visits to another origin without sending them', async () => {
    const { router, fetchMock } = await createRouter();

    await expect(
      router.visit('https://other.example/x', { method: 'POST', data: { a: 1 } }),
    ).rejects.toThrow('Void Router: non-GET visits must target the current origin.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it('still loads absolute same-origin URLs in place', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();

    await router.visit('http://localhost/users');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/users',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-VoidPages': 'true' }),
      }),
    );
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(applyUpdate.mock.calls[0][0]).toMatchObject({ component: 'users' });
    expect(window.location.href).toBeUndefined();
  });
});
