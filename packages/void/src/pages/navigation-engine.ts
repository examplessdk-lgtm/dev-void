/// <reference lib="dom" />

import { createActionErrorFromResponse } from './action-result.ts';
import { initClientHead, applyClientHead } from './head-client.ts';
import type { HeadDescriptor } from './head.ts';
import { PrefetchCache, parseCacheFor } from './prefetch.ts';
import type { CacheForInput, CacheForResult } from './prefetch.ts';
import type { PageObject } from './protocol.ts';

export interface PageComponentModule {
  default: unknown;
}

export type PageData = PageObject;

interface DeferredWindow extends Window {
  __resolveDeferred?: (group: string, data: unknown) => void;
  __rejectDeferred?: (group: string, error: unknown) => void;
  __deferredQueue?: Array<[string, unknown] | [string, 0, unknown]>;
}

type PageFetchOptions = RequestInit & { headers: Record<string, string> };

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

export interface PageRouterAdapter {
  createDeferred(): unknown;
  resolveDeferred(ref: unknown, value: unknown): unknown;
  rejectDeferred(ref: unknown, error: string): unknown;
  isLoading(ref: unknown): boolean;
  onDeferredUpdate?(props: Record<string, unknown>): void;
}

export interface PageNavigationEngineConfig {
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
}

export interface PageNavigationResult {
  pageData: PageData;
  component: unknown;
  layouts: Array<unknown>;
}

export interface PageNavigationResource {
  id: number;
  url: string;
  fetchUrl: string;
  hash: string;
  method: string;
  options: VisitOptions;
  immediate: boolean;
  shell: Promise<PageNavigationResult | undefined>;
  abort(): void;
  commit(): Promise<void>;
  dispose(): void;
}

export interface PageNavigationEngine {
  _hoverDelay: number;
  initialPageData: PageData;
  initialComponent: unknown;
  initialLayouts: Array<unknown>;
  prepareVisit(url: string, options?: VisitOptions): PageNavigationResource;
  prefetch(url: string, options?: PrefetchOptions): Promise<unknown>;
  flush(url: string, method?: string): void;
  flushAll(): void;
  setPopStateHandler(handler: (url: string, options: VisitOptions) => void): void;
  start(): void;
}

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';
const STATIC_PAGE_DATA_PREFIX = '/_void/pages';

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

function clonePageData(pageData: PageData): PageData {
  return JSON.parse(JSON.stringify(pageData)) as PageData;
}

function readInitialPageData(appEl: HTMLElement): PageData {
  const scriptEl = document.getElementById(PAGE_DATA_SCRIPT_ID);
  if (scriptEl?.textContent) {
    return JSON.parse(scriptEl.textContent) as PageData;
  }

  const legacyData = appEl.getAttribute('data-page');
  if (legacyData) {
    return JSON.parse(legacyData) as PageData;
  }

  throw new Error('pages: Missing initial page payload.');
}

function parsePageDataFromHtml(html: string): PageData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scriptEl = doc.getElementById(PAGE_DATA_SCRIPT_ID);
  if (!scriptEl?.textContent) {
    return null;
  }
  try {
    return JSON.parse(scriptEl.textContent) as PageData;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function abortError(): DOMException {
  return new DOMException('Navigation aborted', 'AbortError');
}

function abortSignalPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

async function fetchPageResponse(fetchUrl: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(fetchUrl, init);
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) {
      throw abortError();
    }
    return null;
  }
}

export async function createPageNavigationEngine(
  config: PageNavigationEngineConfig,
): Promise<PageNavigationEngine> {
  const {
    adapter,
    components,
    layoutTree,
    routeMeta,
    matchRoute,
    staticPageData: STATIC_PAGE_DATA_ENABLED = false,
    staticPageDataFastPath: STATIC_PAGE_DATA_FAST_PATH = STATIC_PAGE_DATA_ENABLED,
    prefetchHoverDelay: PREFETCH_HOVER_DELAY,
    prefetchDefaultCacheFor: PREFETCH_DEFAULT_CACHE_FOR,
  } = config;

  const _prefetchCache = new PrefetchCache();
  const _staticPageDataCacheKeys = new Set<string>();
  let _nextNavigationId = 0;
  let _pendingResource: PageNavigationResource | null = null;
  let _committedResource: PageNavigationResource | null = null;
  let _committedDeferredRegistry: DeferredRegistry | null = null;
  let _htmlDeferredRegistry: DeferredRegistry | null = null;
  let _currentFetchUrl = window.location.pathname + window.location.search;
  let popStateHandler: ((url: string, options: VisitOptions) => void) | null = null;

  function getPageDataCacheKey(url: string, method = 'GET'): string {
    return `${method}:${url}`;
  }

  async function resolveComponent(id: string): Promise<unknown> {
    const loader = components[id];
    if (!loader) {
      throw new Error(`pages: Unknown page component '${id}'.`);
    }
    return (await loader()).default;
  }

  async function resolveLayouts(componentId: string): Promise<Array<unknown>> {
    const ids = layoutTree[componentId] || [];
    return Promise.all(ids.map(async (id: string) => (await components[id]()).default));
  }

  function getStaticPageDataUrl(url: string): string {
    const { pathname } = new URL(url || '/', window.location.origin);
    const filePath = pathname === '/' ? 'index' : pathname.replace(/^\/+/, '');
    return `${STATIC_PAGE_DATA_PREFIX}/${filePath}.json`;
  }

  function isUsablePageData(pageData: unknown, matchedId: string): pageData is PageData {
    return (
      typeof pageData === 'object' &&
      pageData !== null &&
      'component' in pageData &&
      typeof pageData.component === 'string' &&
      'props' in pageData &&
      typeof pageData.props === 'object' &&
      pageData.props !== null &&
      typeof pageData.component === 'string' &&
      pageData.component === matchedId &&
      !routeMeta[pageData.component]?.island &&
      Boolean(components[pageData.component])
    );
  }

  class DeferredRegistry {
    private active = true;
    private keyRefs: Record<string, unknown> = {};
    private props: Record<string, unknown> = {};
    private groups: Record<string, Array<string>> = {};
    private preservedSource: DeferredRegistry | null = null;
    private preservedKeys: Set<string> | null = null;

    setupPending(pageData: PageData): void {
      this.props = pageData.props;
      this.keyRefs = {};
      this.groups = {};

      if (!pageData.deferredKeys) {
        return;
      }

      for (const [key, group] of Object.entries(pageData.deferredKeys) as Array<[string, string]>) {
        const ref = adapter.createDeferred();
        this.keyRefs[key] = ref;
        this.props[key] = ref;
        (this.groups[group] ??= []).push(key);
      }
    }

    setupResolved(pageData: PageData): void {
      this.props = pageData.props;
      this.keyRefs = {};
      this.groups = {};

      if (!pageData.deferredKeys) {
        return;
      }

      for (const [key, group] of Object.entries(pageData.deferredKeys) as Array<[string, string]>) {
        const ref = adapter.createDeferred();
        const updated = adapter.resolveDeferred(ref, pageData.props[key]);
        this.keyRefs[key] = updated;
        this.props[key] = updated;
        (this.groups[group] ??= []).push(key);
      }
    }

    preserveValuesFrom(source: DeferredRegistry | null, pageData: PageData): void {
      if (!source) {
        return;
      }
      const keys = source.applyPreservedValues(pageData);
      if (keys) {
        this.preservedSource = source;
        this.preservedKeys = keys;
      }
    }

    commitPreservedValues(
      source: DeferredRegistry | null,
      pageData: PageData,
    ): DeferredRegistry | null {
      if (!this.preservedSource || this.preservedSource !== source || !this.preservedKeys) {
        return null;
      }
      this.preservedSource.retainOnly(this.preservedKeys, pageData.props);
      return this.preservedSource;
    }

    private applyPreservedValues(pageData: PageData): Set<string> | null {
      let keys: Set<string> | null = null;
      for (const key of Object.keys(this.keyRefs)) {
        if (pageData.props[key] === null && this.props[key] !== undefined) {
          pageData.props[key] = this.props[key];
          (keys ??= new Set()).add(key);
        }
      }
      return keys;
    }

    resolve(group: string, data: unknown, error: unknown): void {
      if (!this.active) {
        return;
      }

      if (data !== undefined) {
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
          let resolvedAny = false;
          for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            if (this.keyRefs[key]) {
              this.resolveKey(key, value);
              resolvedAny = true;
            }
          }
          if (!resolvedAny) {
            this.resolveGroup(group, data);
          }
        } else {
          this.resolveGroup(group, data);
        }
      } else if (error !== undefined) {
        this.rejectGroup(group, typeof error === 'string' ? error : String(error));
      }

      adapter.onDeferredUpdate?.(this.props);
    }

    rejectPending(error: string, notify = true): void {
      if (!this.active) {
        return;
      }

      for (const [key, ref] of Object.entries(this.keyRefs)) {
        if (adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, error);
          this.keyRefs[key] = updated;
          this.props[key] = updated;
        }
      }
      if (notify) {
        adapter.onDeferredUpdate?.(this.props);
      }
    }

    dispose(): void {
      if (!this.active) {
        return;
      }
      this.rejectPending('Navigation disposed before deferred props resolved', false);
      this.active = false;
    }

    private retainOnly(keys: Set<string>, props: Record<string, unknown>): void {
      const keyRefs: Record<string, unknown> = {};
      const groups: Record<string, Array<string>> = {};
      for (const [key, ref] of Object.entries(this.keyRefs)) {
        if (keys.has(key)) {
          keyRefs[key] = ref;
          props[key] = this.props[key];
        } else if (adapter.isLoading(ref)) {
          adapter.rejectDeferred(ref, 'Navigation disposed before deferred props resolved');
        }
      }
      for (const [group, groupKeys] of Object.entries(this.groups)) {
        const preservedGroupKeys = groupKeys.filter((key) => keys.has(key));
        if (preservedGroupKeys.length > 0) {
          groups[group] = preservedGroupKeys;
        }
      }
      this.props = props;
      this.keyRefs = keyRefs;
      this.groups = groups;
      adapter.onDeferredUpdate?.(this.props);
    }

    private resolveGroup(group: string, data: unknown): void {
      const keys = this.groups[group] ?? (this.keyRefs[group] ? [group] : []);
      for (const key of keys) {
        this.resolveKey(key, data);
      }
    }

    private resolveKey(key: string, value: unknown): void {
      const ref = this.keyRefs[key];
      if (!ref || !adapter.isLoading(ref)) {
        return;
      }
      const updated = adapter.resolveDeferred(ref, value);
      this.keyRefs[key] = updated;
      this.props[key] = updated;
    }

    private rejectGroup(group: string, error: string): void {
      const keys = this.groups[group] ?? Object.keys(this.keyRefs);
      for (const key of keys) {
        const ref = this.keyRefs[key];
        if (ref && adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, error);
          this.keyRefs[key] = updated;
          this.props[key] = updated;
        }
      }
    }
  }

  const _resourceDeferredRegistries = new WeakMap<PageNavigationResource, DeferredRegistry>();
  const _preservedDeferredResources = new WeakMap<DeferredRegistry, PageNavigationResource>();

  async function loadStaticPageDataFile(
    fetchUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    pageData: PageData;
    resolvedDeferred: boolean;
  } | null> {
    const matchedId = matchRoute(fetchUrl || window.location.pathname + window.location.search);
    if (!matchedId || routeMeta[matchedId]?.island || !components[matchedId]) {
      return null;
    }

    try {
      const pageDataResponse = await fetch(getStaticPageDataUrl(fetchUrl), {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (pageDataResponse.ok) {
        const pageData = await pageDataResponse.json();
        if (isUsablePageData(pageData, matchedId)) {
          return { pageData, resolvedDeferred: true };
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw abortError();
      }
    }

    return null;
  }

  async function loadStaticPageData(
    fetchUrl: string,
    response: Response,
    signal?: AbortSignal,
    verifyPageResponse = false,
  ): Promise<{
    pageData: PageData;
    resolvedDeferred: boolean;
  } | null> {
    if (!response.ok) {
      return null;
    }

    const matchedId = matchRoute(fetchUrl || window.location.pathname + window.location.search);
    if (!matchedId || routeMeta[matchedId]?.island || !components[matchedId]) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.includes('text/html')) {
      return null;
    }

    if (verifyPageResponse) {
      const pageData = parsePageDataFromHtml(await response.text());
      if (!isUsablePageData(pageData, matchedId)) {
        return null;
      }
      if (!pageData.deferredKeys) {
        return { pageData, resolvedDeferred: false };
      }
      return loadStaticPageDataFile(fetchUrl, signal);
    }

    const filePageData = await loadStaticPageDataFile(fetchUrl, signal);
    if (filePageData) {
      return filePageData;
    }

    const pageData = parsePageDataFromHtml(await response.text());
    if (!isUsablePageData(pageData, matchedId) || pageData.deferredKeys) {
      return null;
    }
    return { pageData, resolvedDeferred: false };
  }

  const deferredWindow = window as DeferredWindow;
  deferredWindow.__resolveDeferred = (group: string, data: unknown) =>
    _htmlDeferredRegistry?.resolve(group, data, undefined);
  deferredWindow.__rejectDeferred = (group: string, error: unknown) =>
    _htmlDeferredRegistry?.resolve(group, undefined, error);

  function commitHashNavigation(
    effectiveFetchUrl: string,
    hash: string,
    options: VisitOptions,
    writeHistory: boolean,
  ): void {
    _currentFetchUrl = effectiveFetchUrl;
    if (writeHistory) {
      if (options.replace) {
        history.replaceState({}, '', effectiveFetchUrl + hash);
      } else {
        history.replaceState({ scrollX: window.scrollX, scrollY: window.scrollY }, '');
        history.pushState({}, '', effectiveFetchUrl + hash);
      }
    }
    if (options._scrollPosition) {
      window.scrollTo(options._scrollPosition.x, options._scrollPosition.y);
      return;
    }
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, 0);
  }

  async function loadNavigationShell(
    id: number,
    url: string,
    fetchUrl: string,
    method: string,
    hash: string,
    options: VisitOptions,
    signal: AbortSignal,
    commitTarget: { fetchUrl: string; hash: string },
    deferredRegistry: DeferredRegistry,
  ): Promise<PageNavigationResult | undefined> {
    if (method !== 'GET') {
      _prefetchCache.flushAll();
      _staticPageDataCacheKeys.clear();
    }

    const headers: Record<string, string> = {
      'X-VoidPages': 'true',
      Accept: 'application/json',
    };
    const fetchOptions: PageFetchOptions = { method, headers, signal };

    if (options.data && method !== 'GET') {
      if (hasFiles(options.data)) {
        fetchOptions.body = objectToFormData(options.data as Record<string, unknown>);
      } else {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.data);
      }
    }

    let pageData: PageData | undefined;
    const cacheEntry = method === 'GET' ? _prefetchCache.get(fetchUrl, method) : null;

    if (cacheEntry) {
      const cachedPageData = await cacheEntry.response;
      _prefetchCache.consume(fetchUrl, method);
      if (cachedPageData === null) {
        window.location.href = url;
        return undefined;
      }
      pageData = _staticPageDataCacheKeys.has(getPageDataCacheKey(fetchUrl, method))
        ? clonePageData(cachedPageData as PageData)
        : (cachedPageData as PageData);
      deferredRegistry.setupResolved(pageData);
      if (!_prefetchCache.isFresh(cacheEntry)) {
        const bgHeaders = {
          'X-VoidPages': 'true',
          Accept: 'application/json',
          Purpose: 'prefetch',
        };
        const bgFetch = (
          STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH && method === 'GET'
            ? loadStaticPageDataFile(fetchUrl).then((result) => result?.pageData)
            : Promise.resolve(undefined)
        ).then((pageData) => {
          if (pageData !== undefined) {
            return pageData;
          }
          return fetchPageResponse(fetchUrl, { method, headers: bgHeaders }).then(async (r) => {
            if (!r || r.redirected) {
              return null;
            }
            if (!r.headers.get('X-VoidPages')) {
              return (
                (await loadStaticPageData(fetchUrl, r, undefined, !STATIC_PAGE_DATA_FAST_PATH))
                  ?.pageData ?? null
              );
            }
            return r.json();
          });
        });
        _prefetchCache.set(fetchUrl, method, bgFetch, PREFETCH_DEFAULT_CACHE_FOR);
      }
    } else {
      if (method === 'GET' && STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH) {
        const staticPageData = await loadStaticPageDataFile(fetchUrl, signal);
        if (staticPageData) {
          pageData = staticPageData.pageData;
          _staticPageDataCacheKeys.add(getPageDataCacheKey(fetchUrl, method));
          _prefetchCache.set(
            fetchUrl,
            method,
            Promise.resolve(clonePageData(pageData)),
            PREFETCH_DEFAULT_CACHE_FOR,
          );
          if (staticPageData.resolvedDeferred) {
            deferredRegistry.setupResolved(pageData);
          } else {
            deferredRegistry.setupPending(pageData);
          }
        }
      }

      const response =
        pageData === undefined
          ? method === 'GET'
            ? await fetchPageResponse(fetchUrl, fetchOptions)
            : await fetch(fetchUrl, fetchOptions)
          : null;

      if (pageData === undefined && !response) {
        window.location.href = url;
        return undefined;
      }

      if (response?.redirected) {
        const redirectUrl = new URL(response.url, window.location.origin);
        if (redirectUrl.origin !== window.location.origin) {
          window.location.href = method === 'GET' ? url : response.url;
          return undefined;
        }
        commitTarget.fetchUrl = redirectUrl.pathname + redirectUrl.search;
        commitTarget.hash = redirectUrl.hash;
        return loadNavigationShell(
          id,
          redirectUrl.pathname + redirectUrl.search + redirectUrl.hash,
          redirectUrl.pathname + redirectUrl.search,
          'GET',
          redirectUrl.hash,
          {
            preserveScroll: options.preserveScroll,
            preserveState: options.preserveState,
            replace: options.replace,
            viewTransition: options.viewTransition,
          },
          signal,
          commitTarget,
          deferredRegistry,
        );
      }

      if (response && method !== 'GET' && !response.ok) {
        throw await createActionErrorFromResponse(response, fetchUrl);
      }

      if (response && !response.headers.get('X-VoidPages')) {
        if (method === 'GET') {
          const staticPageData = await loadStaticPageData(
            fetchUrl,
            response,
            signal,
            !STATIC_PAGE_DATA_FAST_PATH,
          );
          if (staticPageData) {
            pageData = staticPageData.pageData;
            if (staticPageData.resolvedDeferred) {
              deferredRegistry.setupResolved(pageData);
            } else {
              deferredRegistry.setupPending(pageData);
            }
          } else {
            window.location.href = url;
            return undefined;
          }
        } else {
          window.location.href = url;
          return undefined;
        }
      }

      const contentType = response?.headers.get('content-type') || '';

      if (pageData !== undefined) {
        // Static page-data fallback already loaded the page object.
      } else if (contentType.includes('application/x-ndjson')) {
        const reader = response!.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstLine = true;

        const processLines = () => {
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) {
              continue;
            }

            if (firstLine) {
              pageData = JSON.parse(line) as PageData;
              deferredRegistry.setupPending(pageData);
              firstLine = false;
            } else {
              const msg = JSON.parse(line);
              if (msg.__deferred) {
                deferredRegistry.resolve(msg.__deferred, msg.data, msg.error);
              }
            }
          }
        };

        while (firstLine) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          processLines();
        }

        (async () => {
          try {
            while (!signal.aborted) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              processLines();
            }
            if (buffer.trim()) {
              processLines();
            }
          } catch (e: unknown) {
            if (!(e instanceof Error) || e.name !== 'AbortError') {
              deferredRegistry.rejectPending('Stream closed before resolution');
            }
          }
        })();
      } else {
        pageData = (await response!.json()) as PageData;
        deferredRegistry.setupPending(pageData);
      }
    }

    if (!pageData) {
      throw new Error('pages: Missing page payload.');
    }

    if (method !== 'GET') {
      deferredRegistry.preserveValuesFrom(_committedDeferredRegistry, pageData);
    }

    const [component, layouts] = await Promise.race([
      Promise.all([resolveComponent(pageData.component), resolveLayouts(pageData.component)]),
      abortSignalPromise(signal),
    ]);

    if (id !== _nextNavigationId && signal.aborted) {
      throw abortError();
    }

    return { pageData, component, layouts };
  }

  function makeCommit(
    commitTarget: { fetchUrl: string; hash: string },
    options: VisitOptions,
    shell: Promise<PageNavigationResult | undefined>,
    deferredRegistry: DeferredRegistry,
    resourceId: number,
    getResource: () => PageNavigationResource,
  ): () => Promise<void> {
    let committed = false;
    return async () => {
      if (committed) {
        return;
      }
      committed = true;
      const result = await shell;
      if (!result) {
        return;
      }
      if (_pendingResource?.id === resourceId) {
        _pendingResource = null;
      }
      const previousResource = _committedResource;
      const previousDeferredRegistry = _committedDeferredRegistry;
      const preservedDeferredRegistry = deferredRegistry.commitPreservedValues(
        previousDeferredRegistry,
        result.pageData,
      );
      _committedResource = getResource();
      const previousResourceOwnsPreservedRegistry = Boolean(
        previousResource &&
        preservedDeferredRegistry &&
        _resourceDeferredRegistries.get(previousResource) === preservedDeferredRegistry,
      );
      if (
        previousResource &&
        previousResource !== _committedResource &&
        !previousResourceOwnsPreservedRegistry
      ) {
        previousResource.dispose();
      }
      if (previousResource && preservedDeferredRegistry && previousResourceOwnsPreservedRegistry) {
        _preservedDeferredResources.set(preservedDeferredRegistry, previousResource);
      }
      _committedDeferredRegistry = preservedDeferredRegistry ?? deferredRegistry;
      const preservedDeferredResource = previousDeferredRegistry
        ? _preservedDeferredResources.get(previousDeferredRegistry)
        : undefined;
      if (previousDeferredRegistry && previousDeferredRegistry !== _committedDeferredRegistry) {
        previousDeferredRegistry.dispose();
        if (
          preservedDeferredResource &&
          preservedDeferredResource !== previousResource &&
          preservedDeferredResource !== _committedResource
        ) {
          preservedDeferredResource.dispose();
        }
        _preservedDeferredResources.delete(previousDeferredRegistry);
      }
      if (preservedDeferredRegistry && preservedDeferredRegistry !== deferredRegistry) {
        deferredRegistry.dispose();
      }
      applyClientHead(result.pageData.head as HeadDescriptor | undefined);
      _currentFetchUrl = commitTarget.fetchUrl;

      if (!options.preserveState) {
        const historyUrl = commitTarget.fetchUrl + commitTarget.hash;
        if (options.replace) {
          history.replaceState({}, '', historyUrl);
        } else {
          history.replaceState({ scrollX: window.scrollX, scrollY: window.scrollY }, '');
          history.pushState({}, '', historyUrl);
        }
      }

      const doScroll = () => {
        if (options.preserveScroll) {
          return;
        }
        if (options._scrollPosition) {
          window.scrollTo(options._scrollPosition.x, options._scrollPosition.y);
        } else if (commitTarget.hash) {
          const el = document.getElementById(commitTarget.hash.slice(1));
          if (el) {
            el.scrollIntoView();
          } else {
            window.scrollTo(0, 0);
          }
        } else {
          window.scrollTo(0, 0);
        }
      };

      requestAnimationFrame(doScroll);
    };
  }

  const appEl = document.getElementById('app')!;
  const initialPageData = readInitialPageData(appEl);
  const [initialComponent, initialLayouts] = await Promise.all([
    resolveComponent(initialPageData.component),
    resolveLayouts(initialPageData.component),
  ]);

  const initialDeferredRegistry = new DeferredRegistry();
  initialDeferredRegistry.setupPending(initialPageData);
  _committedDeferredRegistry = initialDeferredRegistry;
  _htmlDeferredRegistry = initialDeferredRegistry;

  const engine: PageNavigationEngine = {
    _hoverDelay: PREFETCH_HOVER_DELAY,
    initialPageData,
    initialComponent,
    initialLayouts,

    prepareVisit(url, options = {}) {
      const hashIndex = url.indexOf('#');
      const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
      const fetchUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;
      const currentPath = window.location.pathname + window.location.search;
      const effectiveFetchUrl = fetchUrl || currentPath;
      const method = (options.method || 'GET').toUpperCase();
      const id = ++_nextNavigationId;
      const hashNavigationBaseUrl = options._popstate ? _currentFetchUrl : currentPath;

      _pendingResource?.abort();
      _pendingResource = null;

      const isSamePageHashNavigation =
        effectiveFetchUrl === hashNavigationBaseUrl &&
        method === 'GET' &&
        !options.data &&
        Boolean(hash || options._popstate);

      if (isSamePageHashNavigation) {
        commitHashNavigation(
          effectiveFetchUrl,
          hash,
          options,
          !options._popstate && !options.preserveState,
        );
        return {
          id,
          url,
          fetchUrl: effectiveFetchUrl,
          hash,
          method,
          options,
          immediate: true,
          shell: Promise.resolve(undefined),
          abort() {},
          async commit() {},
          dispose() {},
        };
      }

      const controller = new AbortController();
      const deferredRegistry = new DeferredRegistry();
      const commitTarget = { fetchUrl: effectiveFetchUrl, hash };
      const shell = loadNavigationShell(
        id,
        url,
        effectiveFetchUrl,
        method,
        hash,
        options,
        controller.signal,
        commitTarget,
        deferredRegistry,
      );

      let commitResource: () => Promise<void> = async () => {};
      const resource: PageNavigationResource = {
        id,
        url,
        fetchUrl: effectiveFetchUrl,
        hash,
        method,
        options,
        immediate: false,
        shell,
        abort() {
          controller.abort(abortError());
          deferredRegistry.dispose();
        },
        commit() {
          return commitResource();
        },
        dispose() {
          controller.abort(abortError());
          deferredRegistry.dispose();
        },
      };
      _resourceDeferredRegistries.set(resource, deferredRegistry);
      commitResource = makeCommit(
        commitTarget,
        options,
        shell,
        deferredRegistry,
        id,
        () => resource,
      );
      _pendingResource = resource;
      return resource;
    },

    prefetch(url, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      if (method !== 'GET') {
        throw new Error('pages: router.prefetch() only supports GET requests.');
      }

      const id = matchRoute(url);
      if (!id) {
        return Promise.resolve(undefined);
      }

      if (routeMeta[id]?.island) {
        if (!document.querySelector('link[rel="prefetch"][href="' + url + '"]')) {
          const link = document.createElement('link');
          link.rel = 'prefetch';
          link.href = url;
          link.as = 'document';
          document.head.appendChild(link);
        }
        return Promise.resolve(undefined);
      }

      if (components[id]) {
        components[id]();
      }
      const layoutIds = layoutTree[id] || [];
      for (const lid of layoutIds) {
        if (components[lid]) {
          components[lid]();
        }
      }

      const hashIdx = url.indexOf('#');
      const prefetchUrl = hashIdx !== -1 ? url.slice(0, hashIdx) : url;
      const existing = _prefetchCache.get(prefetchUrl, method);
      if (existing) {
        return existing.response;
      }
      const ttl = options.cacheFor ? parseCacheFor(options.cacheFor) : PREFETCH_DEFAULT_CACHE_FOR;
      const headers = {
        'X-VoidPages': 'true',
        Accept: 'application/json',
        Purpose: 'prefetch',
      };
      const fetchPromise = (
        STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH && method === 'GET'
          ? loadStaticPageDataFile(prefetchUrl).then((result) => result?.pageData)
          : Promise.resolve(undefined)
      ).then((pageData) => {
        if (pageData !== undefined) {
          return pageData;
        }
        return fetchPageResponse(prefetchUrl, { method, headers }).then((r) => {
          if (!r || r.redirected) {
            return null;
          }
          if (!r.headers.get('X-VoidPages')) {
            if (method !== 'GET') {
              return null;
            }
            return loadStaticPageData(prefetchUrl, r, undefined, !STATIC_PAGE_DATA_FAST_PATH).then(
              (result) => result?.pageData ?? null,
            );
          }
          return r.json();
        });
      });
      _prefetchCache.set(prefetchUrl, method, fetchPromise, ttl);
      return fetchPromise;
    },

    flush(url, method = 'GET') {
      _prefetchCache.flush(url, method);
      _staticPageDataCacheKeys.delete(getPageDataCacheKey(url, method));
    },

    flushAll() {
      _prefetchCache.flushAll();
      _staticPageDataCacheKeys.clear();
    },

    setPopStateHandler(handler) {
      popStateHandler = handler;
    },

    start() {
      history.scrollRestoration = 'manual';
      history.replaceState({ scrollX: window.scrollX, scrollY: window.scrollY }, '');

      initClientHead(initialPageData.head as HeadDescriptor | undefined);

      if (deferredWindow.__deferredQueue) {
        for (const entry of deferredWindow.__deferredQueue) {
          if (entry.length === 3) {
            _htmlDeferredRegistry?.resolve(entry[0], undefined, entry[2]);
          } else {
            _htmlDeferredRegistry?.resolve(entry[0], entry[1], undefined);
          }
        }
        delete deferredWindow.__deferredQueue;
      }

      window.addEventListener('popstate', (e) => {
        const saved = e.state;
        const url = window.location.pathname + window.location.search + window.location.hash;
        const options = {
          preserveState: true,
          _scrollPosition: saved ? { x: saved.scrollX ?? 0, y: saved.scrollY ?? 0 } : null,
          _popstate: true,
        };
        if (popStateHandler) {
          popStateHandler(url, options);
        }
      });
    },
  };

  return engine;
}
