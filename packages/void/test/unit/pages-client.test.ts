import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageRouter, ssrProxy } from '../../src/pages/client';
import { parseCacheFor } from '../../src/pages/prefetch';

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

describe('createPageRouter prefetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns stable navigation state values from the SSR proxy', () => {
    expect(ssrProxy.isPending).toBe(false);
    expect(ssrProxy.location).toBe('');
    expect(ssrProxy.pendingLocation).toBeNull();
    expect(ssrProxy.type).toBeNull();
    expect(() => ssrProxy.visit('/users')).toThrow('router.visit() is not available during SSR');
  });

  it('rejects non-GET methods before route side effects', async () => {
    const documentStub = stubClientGlobals();
    const homeLoader = vi.fn(async () => ({ default: {} }));
    const usersLoader = vi.fn(async () => ({ default: {} }));
    const layoutLoader = vi.fn(async () => ({ default: {} }));
    const matchRoute = vi.fn(() => 'users');

    const { router } = await createPageRouter({
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
      'router.prefetch() only supports GET requests.',
    );
    expect(matchRoute).not.toHaveBeenCalled();
    expect(usersLoader).not.toHaveBeenCalled();
    expect(layoutLoader).not.toHaveBeenCalled();
    expect(documentStub.createElement).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();
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

    const { router, start } = await createPageRouter({
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

    (window as any).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).not.toHaveBeenCalled();
  });

  it('runs navigation listeners for same-page hash visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';

    const { router } = await createPageRouter({
      adapter: {
        applyUpdate: vi.fn(),
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
    const events: string[] = [];
    router.onNavigation(
      () => events.push('start'),
      () => events.push('end'),
    );

    await router.visit('#section');

    expect(events).toEqual(['start', 'end']);
    expect(history.pushState).toHaveBeenCalledWith({}, '', '/docs?tab=api#section');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
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

    const { router, start } = await createPageRouter({
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

    (window as any).__resolveDeferred('stats', { count: 42 });

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

    const { router, start } = await createPageRouter({
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

    (window as any).__resolveDeferred('stats', { count: 42 });
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
    const slowComponent = new Promise<{ default: any }>(() => {});

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

    const { router } = await createPageRouter({
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
