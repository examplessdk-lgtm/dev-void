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
  createPageNavigationEngine,
  type PageNavigationResource,
  type PageNavigationResult,
  type VisitOptions,
  type VoidRouter,
} from 'void/pages-client';
import type { CacheForResult } from 'void/pages-prefetch';
import { setActionRouter } from './action';
import { ErrorsContext, NavigationContext, RouterContext, SharedContext } from './context';
import type { NavigationState } from './use-navigation';

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
  pendingId: number | null;
}

type AppAction =
  | {
      type: 'begin';
      resource: ReactPageResource;
      navigationType: string;
      pendingLocation: string;
    }
  | { type: 'reveal'; resource: ReactPageResource }
  | { type: 'finish'; resource: ReactPageResource; location: string }
  | { type: 'fail'; resource: ReactPageResource; location: string };

const deferredState = new WeakMap<DeferredResource, DeferredResourceState>();
const navigationListeners = new Set<{ onStart?: () => void; onEnd?: () => void }>();
const viewTransitionWaiters = new Map<number, () => void>();
const pendingNavigationEnds = new Map<number, () => void>();
const pendingVisitSettlers = new Map<number, VisitSettler>();
const committedResources = new Set<number>();

let navigationSnapshot: NavigationState = {
  isPending: false,
  location: '',
  pendingLocation: null,
  type: null,
};
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

function transitionTypeFor(resource: PageNavigationResource): string {
  if (resource.options._scrollPosition) {
    return 'traverse';
  }
  if (resource.method !== 'GET') {
    return 'submit';
  }
  if (resource.options.preserveState) {
    return 'refresh';
  }
  if (resource.options.replace) {
    return 'replace';
  }
  return 'push';
}

function notifyNavigationStart(): void {
  for (const listener of navigationListeners) {
    listener.onStart?.();
  }
}

function notifyNavigationEnd(): void {
  for (const listener of navigationListeners) {
    listener.onEnd?.();
  }
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'begin':
      return {
        resource: state.resource,
        pendingId: action.resource.id,
        navigation: {
          isPending: true,
          location: state.navigation.location,
          pendingLocation: action.pendingLocation,
          type: action.navigationType,
        },
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
        navigation: {
          isPending: false,
          location: action.location,
          pendingLocation: null,
          type: null,
        },
      };
    case 'fail':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        pendingId: null,
        navigation: {
          isPending: false,
          location: action.location,
          pendingLocation: null,
          type: null,
        },
      };
  }
}

function createRouter(engine: Awaited<ReturnType<typeof createPageNavigationEngine>>): VoidRouter {
  const router: VoidRouter = {
    _hoverDelay: engine._hoverDelay,
    get isPending() {
      return navigationSnapshot.isPending;
    },
    get location() {
      return navigationSnapshot.location;
    },
    get pendingLocation() {
      return navigationSnapshot.pendingLocation;
    },
    get type() {
      return navigationSnapshot.type;
    },
    onNavigation(onStart, onEnd) {
      const entry = { onStart, onEnd };
      navigationListeners.add(entry);
      return () => {
        navigationListeners.delete(entry);
      };
    },
    visit(url, options = {}) {
      if (!scheduleVisit) {
        return Promise.reject(new Error('router.visit() called before router initialized'));
      }
      return scheduleVisit(url, options);
    },
    prefetch(url, options = {}) {
      engine.prefetch(url, options);
    },
    flush(url, method = 'GET') {
      engine.flush(url, method);
    },
    flushAll() {
      engine.flushAll();
    },
    reload() {
      return router.visit(window.location.pathname + window.location.search, {
        preserveState: true,
        preserveScroll: true,
      });
    },
    refresh() {
      return router.reload();
    },
    setParams(keyOrParams: string | Record<string, string | null | undefined>, value?: string) {
      const params = new URLSearchParams(window.location.search);
      if (typeof keyOrParams === 'string') {
        if (value === null || value === undefined || value === '') {
          params.delete(keyOrParams);
        } else {
          params.set(keyOrParams, value);
        }
      } else {
        for (const [key, nextValue] of Object.entries(keyOrParams)) {
          if (nextValue === null || nextValue === undefined || nextValue === '') {
            params.delete(key);
          } else {
            params.set(key, nextValue);
          }
        }
      }
      const search = params.toString();
      return router.visit(window.location.pathname + (search ? `?${search}` : ''), {
        preserveScroll: true,
      });
    },
    post(url, data, options = {}) {
      return router.visit(url, { ...options, method: 'POST', data });
    },
    put(url, data, options = {}) {
      return router.visit(url, { ...options, method: 'PUT', data });
    },
    patch(url, data, options = {}) {
      return router.visit(url, { ...options, method: 'PATCH', data });
    },
    delete(url, options = {}) {
      return router.visit(url, { ...options, method: 'DELETE' });
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
    navigation: {
      isPending: false,
      location: currentUrl(),
      pendingLocation: null,
      type: null,
    },
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
          const end = pendingNavigationEnds.get(resource.id);
          if (end) {
            pendingNavigationEnds.delete(resource.id);
            end();
          }
          const visitSettler = pendingVisitSettlers.get(resource.id);
          if (visitSettler) {
            pendingVisitSettlers.delete(resource.id);
            visitSettler.resolve(result.pageData);
          }
          if (activePendingNavigationId === resource.id) {
            activePendingNavigationId = null;
            navigationSnapshot = {
              isPending: false,
              location: currentUrl(),
              pendingLocation: null,
              type: null,
            };
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
        const pendingLocation = prepared.fetchUrl + prepared.hash;
        const navigationType = transitionTypeFor(prepared);

        notifyNavigationStart();
        activePendingNavigationId = prepared.id;
        navigationSnapshot = {
          isPending: true,
          location: navigationSnapshot.location,
          pendingLocation,
          type: navigationType,
        };
        dispatch({ type: 'begin', resource: prepared, pendingLocation, navigationType });

        return prepared.shell.then(
          (result) => {
            notifyNavigationEnd();
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
              navigationSnapshot = {
                isPending: false,
                location: currentUrl(),
                pendingLocation: null,
                type: null,
              };
            }
            dispatch({ type: 'finish', resource: prepared, location: currentUrl() });
            return result?.pageData;
          },
          (error) => {
            notifyNavigationEnd();
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
              navigationSnapshot = {
                isPending: false,
                location: currentUrl(),
                pendingLocation: null,
                type: null,
              };
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
              const end = pendingNavigationEnds.get(prepared.id);
              if (end) {
                pendingNavigationEnds.delete(prepared.id);
                end();
              }
              const resolveViewTransition = viewTransitionWaiters.get(prepared.id);
              if (resolveViewTransition) {
                viewTransitionWaiters.delete(prepared.id);
                resolveViewTransition();
              }
              pendingVisitSettlers.delete(prepared.id);
              resolveVisit(undefined);
            }
            return result;
          },
          (error) => {
            const end = pendingNavigationEnds.get(prepared.id);
            if (end) {
              pendingNavigationEnds.delete(prepared.id);
              end();
            }
            const resolveViewTransition = viewTransitionWaiters.get(prepared.id);
            if (resolveViewTransition) {
              viewTransitionWaiters.delete(prepared.id);
              resolveViewTransition();
            }
            pendingVisitSettlers.delete(prepared.id);
            rejectVisit(error);
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
              navigationSnapshot = {
                isPending: false,
                location: currentUrl(),
                pendingLocation: null,
                type: null,
              };
            }
            dispatch({ type: 'fail', resource: prepared, location: currentUrl() });
            throw error;
          },
        ),
      };
      const pendingLocation = next.fetchUrl + next.hash;
      const navigationType = transitionTypeFor(next);

      notifyNavigationStart();
      pendingNavigationEnds.set(next.id, notifyNavigationEnd);
      pendingVisitSettlers.set(next.id, { resolve: resolveVisit, reject: rejectVisit });
      activePendingNavigationId = next.id;
      navigationSnapshot = {
        isPending: true,
        location: navigationSnapshot.location,
        pendingLocation,
        type: navigationType,
      };
      dispatch({ type: 'begin', resource: next, pendingLocation, navigationType });

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

  const navigationValue = useMemo<NavigationState>(
    () => ({
      ...state.navigation,
      isPending: state.navigation.isPending || isTransitionPending,
    }),
    [isTransitionPending, state.navigation],
  );

  useEffect(() => {
    navigationSnapshot = navigationValue;
  }, [navigationValue]);

  return React.createElement(
    RouterContext.Provider,
    { value: router },
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
  navigationSnapshot = {
    isPending: false,
    location: currentUrl(),
    pendingLocation: null,
    type: null,
  };
  pendingNavigationEnds.clear();
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
