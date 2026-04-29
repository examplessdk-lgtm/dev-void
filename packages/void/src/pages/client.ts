/// <reference lib="dom" />

import { VoidActionError, isCallSiteActionError, type ActionResult } from './action-result.ts';
import {
  createPageNavigationEngine as createNavigationEngine,
  type PageComponentModule,
  type PageData,
} from './navigation-engine.ts';
import type { CacheForResult, CacheForInput } from './prefetch.ts';

export {
  VoidActionError,
  categorizeActionError,
  isAbortError,
  isCallSiteActionError,
} from './action-result.ts';
export type { ActionErrorHandlingScope, ActionResult } from './action-result.ts';
export { isEqualFormValue } from './form-value-equality.ts';
export { createPageNavigationEngine } from './navigation-engine.ts';
export type {
  PageNavigationEngine,
  PageNavigationResource,
  PageNavigationResult,
} from './navigation-engine.ts';

// --- Types ---

export interface VisitOptions {
  method?: string;
  data?: unknown;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  viewTransition?: boolean;
  /** @internal Used by React Actions to avoid waiting for a commit blocked by the action itself. */
  _resolveOnShell?: boolean;
  /** @internal Used by popstate handler to pass saved scroll position */
  _scrollPosition?: { x: number; y: number } | null;
  /** @internal Used by popstate handler to avoid writing history while traversing */
  _popstate?: boolean;
}

export interface PrefetchOptions {
  method?: string;
  cacheFor?: CacheForInput;
}

export type NavigationStateType = 'idle' | 'loading' | 'submitting';
export type NavigationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface NavigationState {
  state: NavigationStateType;
  location: URL | null;
  method: NavigationMethod | null;
}

export interface VoidRouter {
  _hoverDelay: number;
  readonly url: URL;
  readonly path: string;
  readonly query: URLSearchParams;
  visit(url: string | URL, options?: VisitOptions): Promise<unknown>;
  refresh(options?: VisitOptions): Promise<unknown>;
  prefetch(url: string | URL, options?: PrefetchOptions): Promise<unknown>;
  flush(url: string | URL, method?: string): void;
  flushAll(): void;
}

export interface PageRouterAdapter {
  createDeferred(): unknown;
  resolveDeferred(ref: unknown, value: unknown): unknown;
  rejectDeferred(ref: unknown, error: string): unknown;
  isLoading(ref: unknown): boolean;
  applyUpdate(
    pageData: PageData,
    component: unknown,
    layouts: Array<unknown>,
  ): void | Promise<void>;
  onDeferredUpdate?(props: Record<string, unknown>): void;
}

export interface PageRouterConfig {
  adapter: PageRouterAdapter;
  components: Record<string, () => Promise<PageComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  routeMeta: Record<string, { island?: boolean }>;
  matchRoute(url: string): string | null;
  staticPageData?: boolean;
  staticPageDataFastPath?: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
  onRouteChange?(url: string): void;
  onNavigationChange?(navigation: NavigationState): void;
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function getUrlOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}

function toUrl(value: string | URL): URL {
  return value instanceof URL ? new URL(value.href) : new URL(value || '/', getUrlOrigin());
}

function normalizeUrl(value: string | URL): string {
  if (typeof value === 'string' && value.startsWith('#')) {
    return value;
  }
  const url = toUrl(value);
  return url.origin === getUrlOrigin() ? url.pathname + url.search + url.hash : url.href;
}

function navigationMethod(method: string): NavigationMethod {
  const normalized = method.toUpperCase();
  if (
    normalized === 'POST' ||
    normalized === 'PUT' ||
    normalized === 'PATCH' ||
    normalized === 'DELETE'
  ) {
    return normalized;
  }
  return 'GET';
}

function navigationStateFor(url: string, method: string): NavigationState {
  const normalized = navigationMethod(method);
  return {
    state: normalized === 'GET' ? 'loading' : 'submitting',
    location: toUrl(url),
    method: normalized,
  };
}

export function idleNavigationState(): NavigationState {
  return {
    state: 'idle',
    location: null,
    method: null,
  };
}

export function createRouterFacade(router: VoidRouter, getCurrentUrl: () => string): VoidRouter {
  return {
    get _hoverDelay() {
      return router._hoverDelay;
    },

    get url() {
      return toUrl(getCurrentUrl());
    },

    get path() {
      return this.url.pathname;
    },

    get query() {
      return this.url.searchParams;
    },

    visit(url, options = {}) {
      return router.visit(url, options);
    },

    refresh(options = {}) {
      return router.refresh(options);
    },

    prefetch(url, options = {}) {
      return router.prefetch(url, options);
    },

    flush(url, method = 'GET') {
      router.flush(url, method);
    },

    flushAll() {
      router.flushAll();
    },
  };
}

export function createSsrRouter(url = '/'): VoidRouter {
  const router = {
    _hoverDelay: 75,
    get url() {
      return toUrl(url);
    },
    get path() {
      return this.url.pathname;
    },
    get query() {
      return this.url.searchParams;
    },
    visit() {
      throw new Error('pages: router.visit() is not available during SSR.');
    },
    refresh() {
      throw new Error('pages: router.refresh() is not available during SSR.');
    },
    prefetch() {
      throw new Error('pages: router.prefetch() is not available during SSR.');
    },
    flush() {
      throw new Error('pages: router.flush() is not available during SSR.');
    },
    flushAll() {
      throw new Error('pages: router.flushAll() is not available during SSR.');
    },
  };

  return router as VoidRouter;
}

// --- Form utilities ---

export function isFile(value: unknown): boolean {
  return (
    (typeof File !== 'undefined' && value instanceof File) ||
    value instanceof Blob ||
    (typeof FileList !== 'undefined' && value instanceof FileList && value.length > 0)
  );
}

export function hasFiles(data: unknown): boolean {
  return (
    isFile(data) ||
    (typeof data === 'object' && data !== null && Object.values(data).some(hasFiles))
  );
}

export function objectToFormData(
  source: Record<string, unknown>,
  form?: FormData,
  parentKey?: string,
): FormData {
  form = form || new FormData();
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const composed = parentKey ? parentKey + '[' + key + ']' : key;
    const value = source[key];
    if (value instanceof File) {
      form.append(composed, value, value.name);
    } else if (value instanceof Blob) {
      form.append(composed, value);
    } else if (typeof FileList !== 'undefined' && value instanceof FileList) {
      for (let i = 0; i < value.length; i++) {
        form.append(composed + '[]', value[i], value[i].name);
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        objectToFormData({ [i]: value[i] }, form, composed);
      }
    } else if (value instanceof Date) {
      form.append(composed, value.toISOString());
    } else if (typeof value === 'boolean') {
      form.append(composed, value ? '1' : '0');
    } else if (typeof value === 'string') {
      form.append(composed, value);
    } else if (typeof value === 'number') {
      form.append(composed, String(value));
    } else if (value === null || value === undefined) {
      form.append(composed, '');
    } else {
      objectToFormData(value as Record<string, unknown>, form, composed);
    }
  }
  return form;
}

// --- SSR proxy ---

export const ssrProxy: VoidRouter = createSsrRouter();

export async function submitAction(
  router: VoidRouter,
  url: string,
  options: VisitOptions,
): Promise<ActionResult> {
  try {
    const pageData = await router.visit(url, options);
    if (
      typeof pageData === 'object' &&
      pageData !== null &&
      'errors' in pageData &&
      pageData.errors
    ) {
      return {
        ok: false,
        error: new VoidActionError({
          body: { errors: pageData.errors as Record<string, string> },
          status: 422,
          statusText: 'Unprocessable Content',
          url,
        }),
      };
    }
    return { ok: true, pageData: pageData as PageData };
  } catch (error) {
    if (isCallSiteActionError(error)) {
      return { ok: false, error };
    }
    throw error;
  }
}

// --- createPageRouter factory ---

export async function createPageRouter(config: PageRouterConfig): Promise<{
  router: VoidRouter;
  initialPageData: PageData;
  initialComponent: unknown;
  initialLayouts: Array<unknown>;
  start(): void;
}> {
  {
    const engine = await createNavigationEngine(config);
    let routeUrl = currentUrl();
    let activeNavigationId: number | null = null;
    const setRouteUrl = (url: string) => {
      routeUrl = url;
      config.onRouteChange?.(url);
    };
    const setNavigation = (navigation: NavigationState) => {
      config.onNavigationChange?.(navigation);
    };

    async function applyNavigationResource(resource: ReturnType<typeof engine.prepareVisit>) {
      activeNavigationId = resource.id;
      setNavigation(navigationStateFor(resource.fetchUrl + resource.hash, resource.method));
      try {
        const result = await resource.shell;
        if (!result) {
          return undefined;
        }

        const applyUpdate = () =>
          config.adapter.applyUpdate(result.pageData, result.component, result.layouts);

        const useTransition = resource.options.viewTransition ?? config.viewTransitions;
        if (useTransition && document.startViewTransition) {
          const transition = document.startViewTransition(() => applyUpdate());
          await transition.updateCallbackDone;
        } else {
          await applyUpdate();
        }

        await resource.commit();
        if (activeNavigationId === resource.id) {
          setRouteUrl(currentUrl());
        }
        return result.pageData;
      } finally {
        if (activeNavigationId === resource.id) {
          activeNavigationId = null;
          setRouteUrl(currentUrl());
          setNavigation(idleNavigationState());
        }
      }
    }

    const rawRouter: VoidRouter = {
      _hoverDelay: engine._hoverDelay,

      get url() {
        return toUrl(routeUrl);
      },

      get path() {
        return this.url.pathname;
      },

      get query() {
        return this.url.searchParams;
      },

      visit(url, options = {}) {
        const resource = engine.prepareVisit(normalizeUrl(url), options);
        return applyNavigationResource(resource);
      },

      refresh(options = {}) {
        return rawRouter.visit(window.location.pathname + window.location.search, {
          preserveState: true,
          preserveScroll: true,
          ...options,
        });
      },

      prefetch(url, options = {}) {
        return engine.prefetch(normalizeUrl(url), options);
      },

      flush(url, method = 'GET') {
        engine.flush(normalizeUrl(url), method);
      },

      flushAll() {
        engine.flushAll();
      },
    };
    const router = createRouterFacade(rawRouter, () => routeUrl);

    engine.setPopStateHandler((url, options) => {
      router.visit(url, options);
    });

    return {
      router,
      initialPageData: engine.initialPageData,
      initialComponent: engine.initialComponent,
      initialLayouts: engine.initialLayouts,
      start: engine.start,
    };
  }
}

// --- Island hydration ---

export function scheduleHydration(
  el: Element,
  loader: () => Promise<unknown>,
  props: Record<string, unknown>,
  strategy: string,
  hydrateFn: (el: Element, mod: unknown, props: Record<string, unknown>) => void | Promise<void>,
): void {
  const hydrate = () => loader().then((mod) => hydrateFn(el, mod, props));

  if (strategy === 'load') {
    hydrate();
  } else if (strategy === 'visible') {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        hydrate();
      }
    });
    observer.observe(el);
  } else if (strategy === 'idle') {
    const schedule =
      window.requestIdleCallback?.bind(window) ?? ((cb: () => void) => setTimeout(cb, 1));
    schedule(() => hydrate());
  } else if (strategy.startsWith('media:')) {
    const query = strategy.slice(6);
    const mql = matchMedia(query);
    const check = () => {
      if (mql.matches) {
        mql.removeEventListener('change', check);
        hydrate();
      }
    };
    mql.addEventListener('change', check);
    check();
  }
}

export function initIslands(
  islands: Record<string, () => Promise<unknown>>,
  hydrateFn: (el: Element, mod: unknown, props: Record<string, unknown>) => void | Promise<void>,
): void {
  document.querySelectorAll('[data-island]').forEach((el) => {
    const id = el.getAttribute('data-island')!;
    const props = JSON.parse(el.getAttribute('data-props') || '{}');
    const strategy = el.getAttribute('data-hydrate') || 'load';
    const loader = islands[id];
    if (loader) {
      scheduleHydration(el, loader, props, strategy, hydrateFn);
    }
  });
}
