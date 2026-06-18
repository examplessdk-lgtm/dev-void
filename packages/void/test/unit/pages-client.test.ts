import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createVoidRouter, ssrProxy } from '../../src/pages/client.ts';
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
          getAttribute: vi.fn(() => null),
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
    expect(history.pushState).toHaveBeenCalledWith({}, '', '/docs?tab=api#section');
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
    );

    fetchMock.mockClear();
    applyUpdate.mockClear();
    vi.mocked(history.pushState).mockClear();
    vi.mocked(history.replaceState).mockClear();
    vi.mocked(window.scrollTo).mockClear();

    await router.visit('#section');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).toHaveBeenCalledWith({}, '', '/#section');
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
