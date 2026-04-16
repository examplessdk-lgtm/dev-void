/// <reference lib="dom" />

import { initClientHead, applyClientHead } from './head-client';
import { createPageNavigationEngine as createNavigationEngine } from './navigation-engine';
import { PrefetchCache, parseCacheFor } from './prefetch';
import type { CacheForResult, CacheForInput } from './prefetch';

export { createPageNavigationEngine } from './navigation-engine';
export type {
  PageNavigationEngine,
  PageNavigationResource,
  PageNavigationResult,
} from './navigation-engine';

// --- Types ---

export interface VisitOptions {
  method?: string;
  data?: unknown;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  viewTransition?: boolean;
  /** @internal Used by popstate handler to pass saved scroll position */
  _scrollPosition?: { x: number; y: number } | null;
  /** @internal Used by popstate handler to avoid writing history while traversing */
  _popstate?: boolean;
}

export interface PrefetchOptions {
  method?: string;
  cacheFor?: CacheForInput;
}

export interface VoidRouter {
  _hoverDelay: number;
  readonly isPending?: boolean;
  readonly location?: string;
  readonly pendingLocation?: string | null;
  readonly type?: string | null;
  onNavigation(onStart?: () => void, onEnd?: () => void): () => void;
  visit(url: string, options?: VisitOptions): Promise<any>;
  prefetch(url: string, options?: PrefetchOptions): void;
  flush(url: string, method?: string): void;
  flushAll(): void;
  reload(): Promise<any>;
  refresh(): Promise<any>;
  setParams(key: string, value: string): Promise<any>;
  setParams(params: Record<string, string | null | undefined>): Promise<any>;
  post(url: string, data?: unknown, options?: VisitOptions): Promise<any>;
  put(url: string, data?: unknown, options?: VisitOptions): Promise<any>;
  patch(url: string, data?: unknown, options?: VisitOptions): Promise<any>;
  delete(url: string, options?: VisitOptions): Promise<any>;
}

export interface PageRouterAdapter {
  createDeferred(): unknown;
  resolveDeferred(ref: unknown, value: unknown): unknown;
  rejectDeferred(ref: unknown, error: string): unknown;
  isLoading(ref: unknown): boolean;
  applyUpdate(pageData: any, component: any, layouts: any[]): void | Promise<void>;
  onDeferredUpdate?(props: Record<string, unknown>): void;
}

export interface PageRouterConfig {
  adapter: PageRouterAdapter;
  components: Record<string, () => Promise<{ default: any }>>;
  layoutTree: Record<string, string[]>;
  routeMeta: Record<string, { island?: boolean }>;
  matchRoute(url: string): string | null;
  staticPageData?: boolean;
  staticPageDataFastPath?: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
}

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';
const STATIC_PAGE_DATA_PREFIX = '/_void/pages';

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
    const value = source[key] as any;
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
      objectToFormData(value, form, composed);
    }
  }
  return form;
}

// --- SSR proxy ---

export const ssrProxy: VoidRouter = new Proxy({} as VoidRouter, {
  get(_target, prop) {
    if (typeof prop === 'symbol') {
      return undefined;
    }
    if (prop === 'isPending') {
      return false;
    }
    if (prop === 'location') {
      return '';
    }
    if (prop === 'pendingLocation' || prop === 'type') {
      return null;
    }
    return () => {
      throw new Error(`router.${prop}() is not available during SSR`);
    };
  },
});

// --- createPageRouter factory ---

export async function createPageRouter(config: PageRouterConfig): Promise<{
  router: VoidRouter;
  initialPageData: any;
  initialComponent: any;
  initialLayouts: any[];
  start(): void;
}> {
  {
    const engine = await createNavigationEngine(config);
    const _navListeners = new Set<{ onStart?: () => void; onEnd?: () => void }>();

    async function applyNavigationResource(resource: ReturnType<typeof engine.prepareVisit>) {
      for (const listener of _navListeners) {
        listener.onStart?.();
      }
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
        return result.pageData;
      } finally {
        for (const listener of _navListeners) {
          listener.onEnd?.();
        }
      }
    }

    const router: VoidRouter = {
      _hoverDelay: engine._hoverDelay,

      onNavigation(onStart, onEnd) {
        const entry = { onStart, onEnd };
        _navListeners.add(entry);
        return () => {
          _navListeners.delete(entry);
        };
      },

      visit(url, options = {}) {
        const resource = engine.prepareVisit(url, options);
        return applyNavigationResource(resource);
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
    const schedule = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1));
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
