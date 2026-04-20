import React, {
  Suspense,
  use,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useTransition,
  type ComponentType,
} from 'react';
import { hydrateRoot } from 'react-dom/client';
import {
  createRouterFacade,
  createPageNavigationEngine,
  idleNavigationState,
  type PageNavigationResource,
  type PageNavigationResult,
  type NavigationState,
  type VisitOptions,
  type VoidRouter,
} from 'void/pages-client';
import type { CacheForResult } from 'void/pages-prefetch';
import { setActionRouter } from './action';
import { ErrorsContext, NavigationContext, RouterContext, SharedContext } from './context';

type ComponentModule = { default: ComponentType<any> };

export interface ReactPagesConfig {
  components: Record<string, () => Promise<ComponentModule>>;
  layoutTree: Record<string, string[]>;
  routeMeta: Record<string, { island?: boolean }>;
  matchRoute(url: string): string | null;
  staticPageData: boolean;
  staticPageDataFastPath: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
}

export interface ReactPagesClient {
  router: VoidRouter;
}

type DeferredResource = Promise<unknown>;

type DeferredResourceState =
  | {
      status: 'pending';
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }
  | { status: 'resolved' | 'rejected' };

type ReactPageResource = PageNavigationResource & {
  shell: Promise<PageNavigationResult | undefined>;
};

type VisitSettler = {
  resolve(pageData: Record<string, unknown> | undefined): void;
  reject(error: unknown): void;
};

interface AppState {
  resource: ReactPageResource;
  navigation: NavigationState;
  routeUrl: string;
  pendingId: number | null;
}

type AppAction =
  | {
      type: 'begin';
      resource: ReactPageResource;
      navigation: NavigationState;
    }
  | { type: 'reveal'; resource: ReactPageResource }
  | { type: 'finish'; resource: ReactPageResource; location: string }
  | { type: 'fail'; resource: ReactPageResource; location: string };

const deferredState = new WeakMap<DeferredResource, DeferredResourceState>();
const viewTransitionWaiters = new Map<number, () => void>();
const pendingVisitSettlers = new Map<number, VisitSettler>();
const committedResources = new Set<number>();

let activePendingNavigationId: number | null = null;
let scheduleVisit:
  | ((url: string, options?: VisitOptions) => Promise<Record<string, unknown> | undefined>)
  | null = null;

function createDeferredResource(): DeferredResource {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  deferredState.set(promise, { status: 'pending', resolve, reject });
  return promise;
}

function resolveDeferredResource(ref: unknown, value: unknown): unknown {
  const state = deferredState.get(ref as DeferredResource);
  if (state?.status === 'pending') {
    state.resolve(value);
    deferredState.set(ref as DeferredResource, { status: 'resolved' });
  }
  return ref;
}

function rejectDeferredResource(ref: unknown, error: string): unknown {
  const state = deferredState.get(ref as DeferredResource);
  if (state?.status === 'pending') {
    state.reject(new Error(error));
    deferredState.set(ref as DeferredResource, { status: 'rejected' });
  }
  return ref;
}

function isDeferredResourceLoading(ref: unknown): boolean {
  return deferredState.get(ref as DeferredResource)?.status === 'pending';
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function normalizeUrl(value: string | URL): string {
  if (typeof value === 'string' && value.startsWith('#')) {
    return value;
  }
  const url = value instanceof URL ? value : new URL(value, window.location.origin);
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : url.href;
}

function navigationForResource(resource: PageNavigationResource): NavigationState {
  const method = resource.method.toUpperCase();
  const isSubmitting = method !== 'GET';
  return {
    state: isSubmitting ? 'submitting' : 'loading',
    location: new URL(resource.fetchUrl + resource.hash, window.location.origin),
    method:
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? method
        : 'GET',
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'begin':
      return {
        resource: state.resource,
        pendingId: action.resource.id,
        routeUrl: state.routeUrl,
        navigation: action.navigation,
      };
    case 'reveal':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        resource: action.resource,
      };
    case 'finish':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        resource: action.resource.immediate ? state.resource : action.resource,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
    case 'fail':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
  }
}

function createRouter(engine: Awaited<ReturnType<typeof createPageNavigationEngine>>): VoidRouter {
  const router: VoidRouter = {
    _hoverDelay: engine._hoverDelay,
    get url() {
      return new URL(currentUrl(), window.location.origin);
    },
    get path() {
      return this.url.pathname;
    },
    get query() {
      return this.url.searchParams;
    },
    visit(url, options = {}) {
      if (!scheduleVisit) {
        return Promise.reject(new Error('router.visit() called before router initialized'));
      }
      return scheduleVisit(normalizeUrl(url), options);
    },
    refresh(options = {}) {
      return router.visit(window.location.pathname + window.location.search, {
        preserveState: true,
        preserveScroll: true,
        ...options,
      });
    },
    prefetch(url, options = {}) {
      engine.prefetch(normalizeUrl(url), options);
    },
    flush(url, method = 'GET') {
      engine.flush(normalizeUrl(url), method);
    },
    flushAll() {
      engine.flushAll();
    },
  };
  return router;
}

function RouteResource({
  resource,
  onCommit,
}: {
  resource: ReactPageResource;
  onCommit(resource: ReactPageResource, result: PageNavigationResult): void;
}): React.ReactNode {
  const result = use(resource.shell);
  useLayoutEffect(() => {
    if (result) {
      onCommit(resource, result);
    }
  }, [onCommit, resource, result]);

  if (!result) {
    return null;
  }

  let element = React.createElement(result.component, result.pageData.props);
  for (let i = result.layouts.length - 1; i >= 0; i--) {
    element = React.createElement(result.layouts[i], null, element);
  }

  return React.createElement(
    SharedContext.Provider,
    { value: result.pageData.shared || {} },
    React.createElement(ErrorsContext.Provider, { value: result.pageData.errors || {} }, element),
  );
}

function startViewTransition(
  resource: ReactPageResource,
  reveal: () => void,
  enabled: boolean,
): void {
  if (!enabled || typeof document.startViewTransition !== 'function') {
    reveal();
    return;
  }

  let resolveViewTransition!: () => void;
  const readyForCapture = new Promise<void>((resolve) => {
    resolveViewTransition = resolve;
  });
  viewTransitionWaiters.set(resource.id, resolveViewTransition);
  document.startViewTransition(() => {
    reveal();
    return readyForCapture;
  });
}

function App({
  engine,
  router,
  viewTransitions,
}: {
  engine: Awaited<ReturnType<typeof createPageNavigationEngine>>;
  router: VoidRouter;
  viewTransitions: boolean;
}): React.ReactNode {
  const sharedStateRef = useRef<Record<string, unknown>>(engine.initialPageData.shared || {});
  const initialResource = useMemo<ReactPageResource>(
    () => ({
      id: 0,
      url: engine.initialPageData.url || currentUrl(),
      fetchUrl: engine.initialPageData.url || currentUrl(),
      hash: window.location.hash,
      method: 'GET',
      options: {},
      immediate: false,
      shell: Promise.resolve({
        pageData: { ...engine.initialPageData, shared: engine.initialPageData.shared || {} },
        component: engine.initialComponent,
        layouts: engine.initialLayouts,
      }),
      abort() {},
      async commit() {},
      dispose() {},
    }),
    [engine],
  );
  const [state, dispatch] = useReducer(appReducer, {
    resource: initialResource,
    pendingId: null,
    routeUrl: currentUrl(),
    navigation: idleNavigationState(),
  });
  const [isTransitionPending, startTransition] = useTransition();

  const mergeShared = useCallback(
    (result: PageNavigationResult | undefined): PageNavigationResult | undefined => {
      if (!result) {
        return result;
      }
      sharedStateRef.current = {
        ...sharedStateRef.current,
        ...(result.pageData.shared || {}),
      };
      const shared = sharedStateRef.current;
      result.pageData = { ...result.pageData, shared };
      return result;
    },
    [],
  );

  const finishNavigation = useCallback(
    (resource: ReactPageResource, result: PageNavigationResult) => {
      if (committedResources.has(resource.id)) {
        return;
      }
      committedResources.add(resource.id);
      resource
        .commit()
        .then(() => {
          const resolveViewTransition = viewTransitionWaiters.get(resource.id);
          if (resolveViewTransition) {
            viewTransitionWaiters.delete(resource.id);
            resolveViewTransition();
          }
          const visitSettler = pendingVisitSettlers.get(resource.id);
          if (visitSettler) {
            pendingVisitSettlers.delete(resource.id);
            visitSettler.resolve(result.pageData);
          }
          if (activePendingNavigationId === resource.id) {
            activePendingNavigationId = null;
          }
          dispatch({ type: 'finish', resource, location: currentUrl() });
        })
        .catch((error) => {
          const visitSettler = pendingVisitSettlers.get(resource.id);
          if (visitSettler) {
            pendingVisitSettlers.delete(resource.id);
            visitSettler.reject(error);
          }
        });
    },
    [],
  );

  const schedule = useCallback(
    (url: string, options: VisitOptions = {}) => {
      const prepared = engine.prepareVisit(url, options) as ReactPageResource;
      if (prepared.immediate) {
        const navigation = navigationForResource(prepared);

        activePendingNavigationId = prepared.id;
        dispatch({ type: 'begin', resource: prepared, navigation });

        return prepared.shell.then(
          (result) => {
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
            }
            dispatch({ type: 'finish', resource: prepared, location: currentUrl() });
            return result?.pageData;
          },
          (error) => {
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
            }
            dispatch({ type: 'fail', resource: prepared, location: currentUrl() });
            throw error;
          },
        );
      }

      let resolveVisit!: (pageData: Record<string, unknown> | undefined) => void;
      let rejectVisit!: (error: unknown) => void;
      const pagePromise = new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        resolveVisit = resolve;
        rejectVisit = reject;
      });

      const next: ReactPageResource = {
        ...prepared,
        shell: prepared.shell.then(mergeShared).then(
          (result) => {
            if (!result) {
              const resolveViewTransition = viewTransitionWaiters.get(prepared.id);
              if (resolveViewTransition) {
                viewTransitionWaiters.delete(prepared.id);
                resolveViewTransition();
              }
              pendingVisitSettlers.delete(prepared.id);
              if (activePendingNavigationId === prepared.id) {
                activePendingNavigationId = null;
              }
              dispatch({ type: 'finish', resource: prepared, location: currentUrl() });
              resolveVisit(undefined);
            }
            return result;
          },
          (error) => {
            const resolveViewTransition = viewTransitionWaiters.get(prepared.id);
            if (resolveViewTransition) {
              viewTransitionWaiters.delete(prepared.id);
              resolveViewTransition();
            }
            pendingVisitSettlers.delete(prepared.id);
            rejectVisit(error);
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
            }
            dispatch({ type: 'fail', resource: prepared, location: currentUrl() });
            throw error;
          },
        ),
      };
      const navigation = navigationForResource(next);

      pendingVisitSettlers.set(next.id, { resolve: resolveVisit, reject: rejectVisit });
      activePendingNavigationId = next.id;
      dispatch({ type: 'begin', resource: next, navigation });

      const reveal = () => {
        startTransition(() => {
          dispatch({ type: 'reveal', resource: next });
        });
      };

      startViewTransition(next, reveal, options.viewTransition ?? viewTransitions);
      return pagePromise;
    },
    [engine, mergeShared, startTransition, viewTransitions],
  );

  useInsertionEffect(() => {
    scheduleVisit = schedule;
    return () => {
      if (scheduleVisit === schedule) {
        scheduleVisit = null;
      }
    };
  }, [schedule]);

  useEffect(() => {
    engine.setPopStateHandler((url, options) => {
      router.visit(url, options);
    });
  }, [engine, router]);

  const navigationValue = useMemo<NavigationState>(() => {
    if (state.navigation.state !== 'idle' || !isTransitionPending) {
      return state.navigation;
    }
    return {
      state: 'loading',
      location: null,
      method: 'GET',
    };
  }, [isTransitionPending, state.navigation]);

  const routerValue = useMemo(
    () => createRouterFacade(router, () => state.routeUrl),
    [router, state.routeUrl],
  );

  return React.createElement(
    RouterContext.Provider,
    { value: routerValue },
    React.createElement(
      NavigationContext.Provider,
      { value: navigationValue },
      React.createElement(
        Suspense,
        { fallback: null },
        React.createElement(RouteResource, {
          resource: state.resource,
          onCommit: finishNavigation,
        }),
      ),
    ),
  );
}

export async function startReactPages(config: ReactPagesConfig): Promise<ReactPagesClient> {
  viewTransitionWaiters.clear();
  pendingVisitSettlers.clear();
  committedResources.clear();
  committedResources.add(0);
  activePendingNavigationId = null;

  const engine = await createPageNavigationEngine({
    adapter: {
      createDeferred: createDeferredResource,
      resolveDeferred: resolveDeferredResource,
      rejectDeferred: rejectDeferredResource,
      isLoading: isDeferredResourceLoading,
    },
    components: config.components,
    layoutTree: config.layoutTree,
    routeMeta: config.routeMeta,
    matchRoute: config.matchRoute,
    staticPageData: config.staticPageData,
    staticPageDataFastPath: config.staticPageDataFastPath,
    viewTransitions: config.viewTransitions,
    prefetchHoverDelay: config.prefetchHoverDelay,
    prefetchDefaultCacheFor: config.prefetchDefaultCacheFor,
  });
  const router = createRouter(engine);
  setActionRouter(router);

  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('Missing #app element for Void React pages hydration');
  }

  hydrateRoot(
    appEl,
    React.createElement(App, { engine, router, viewTransitions: config.viewTransitions }),
  );
  appEl.setAttribute('data-hydrated', 'true');
  engine.start();

  return { router };
}
