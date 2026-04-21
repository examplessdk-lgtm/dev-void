import { createMemo, onCleanup, onMount, splitProps, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { RouterContext } from './context';

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type NavigateEvent = { preventDefault(): void };
type PrefetchOptions = { cacheFor?: LinkProps['cacheFor']; method?: LinkMethod };

type CommonProps = {
  href: string;
  method?: LinkMethod | Lowercase<LinkMethod>;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  reloadDocument?: boolean;
  viewTransition?: boolean;
  prefetch?: boolean | PrefetchStrategy | PrefetchStrategy[];
  cacheFor?: number | string | [string, string];
  onNavigate?: (event: NavigateEvent) => void;
  children?: JSX.Element;
};

export type LinkProps = CommonProps &
  Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> &
  Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps>;

function appendQueryValue(params: URLSearchParams, key: string, value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (value instanceof Date) {
    params.append(key, value.toISOString());
    return true;
  }
  if (Array.isArray(value)) {
    let appended = false;
    for (const item of value) {
      appended = appendQueryValue(params, key, item) || appended;
    }
    return appended;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    params.append(key, String(value));
    return true;
  }
  throw new Error(
    `Void Link GET data only supports primitive values and arrays. Received nested data for "${key}".`,
  );
}

function mergeDataIntoHref(href: string, data?: Record<string, unknown>): string {
  if (!data) {
    return href;
  }

  const hashIndex = href.indexOf('#');
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  const searchIndex = beforeHash.indexOf('?');
  const path = searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex);
  const search = searchIndex === -1 ? '' : beforeHash.slice(searchIndex + 1);
  const params = new URLSearchParams(search);
  let appended = false;

  for (const [key, value] of Object.entries(data)) {
    appended = appendQueryValue(params, key, value) || appended;
  }

  if (!appended) {
    return href;
  }

  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

function hasPrefetch(prefetch: LinkProps['prefetch']): boolean {
  return prefetch !== false && prefetch !== undefined;
}

function isModifiedEvent(e: MouseEvent): boolean {
  const target = (e.currentTarget as HTMLElement).getAttribute('target');
  return (
    (target !== null && target !== '_self') ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey ||
    e.altKey ||
    e.button !== 0
  );
}

function mergeStyle(style: JSX.CSSProperties | string | undefined): JSX.CSSProperties | string {
  if (typeof style === 'string') {
    return `touch-action: manipulation; ${style}`;
  }
  return {
    touchAction: 'manipulation',
    ...style,
  } as JSX.CSSProperties;
}

function callHandler(handler: unknown, event: Event): void {
  if (Array.isArray(handler)) {
    const [fn, data] = handler;
    if (typeof fn === 'function') {
      fn(data, event);
    }
  } else if (typeof handler === 'function') {
    handler(event);
  }
}

export function Link(props: LinkProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'href',
    'method',
    'data',
    'preserveScroll',
    'preserveState',
    'replace',
    'reloadDocument',
    'viewTransition',
    'prefetch',
    'cacheFor',
    'onNavigate',
    'children',
    'style',
    'onClick',
    'onMouseEnter',
    'onMouseLeave',
    'onFocus',
    'onMouseDown',
    'onTouchStart',
  ]);
  const router = useContext(RouterContext);

  const linkState = createMemo(() => {
    const method = (local.method || 'GET').toUpperCase() as LinkMethod;
    const isGet = method === 'GET';

    if (hasPrefetch(local.prefetch) && !isGet) {
      throw new Error(
        'Void Link prefetch only supports GET links. Remove `prefetch` or use method="GET".',
      );
    }
    if (local.reloadDocument && !isGet) {
      throw new Error('Void Link reloadDocument only supports GET links.');
    }

    return {
      href: isGet ? mergeDataIntoHref(local.href, local.data) : local.href,
      isGet,
      method,
    };
  });
  const normalizedMethod = () => linkState().method;
  const isGet = () => linkState().isGet;
  const hrefWithData = () => linkState().href;
  const strategies = createMemo<PrefetchStrategy[]>(() => {
    if (local.prefetch === false || local.prefetch === undefined || local.reloadDocument) {
      return [];
    }
    if (local.prefetch === true) {
      return ['hover'];
    }
    if (typeof local.prefetch === 'string') {
      return [local.prefetch];
    }
    return local.prefetch;
  });
  const resolvedStyle = createMemo(() => mergeStyle(local.style));

  function doPrefetch() {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (hrefWithData() === current) {
      return;
    }
    const options: PrefetchOptions = {};
    if (local.cacheFor !== undefined) {
      options.cacheFor = local.cacheFor;
    }
    if (normalizedMethod()) {
      options.method = normalizedMethod();
    }
    router.prefetch(hrefWithData(), options);
  }

  function shouldHandleClick(event: MouseEvent): boolean {
    if (local.reloadDocument || !router || event.defaultPrevented || isModifiedEvent(event)) {
      return false;
    }
    if ((event.currentTarget as HTMLElement).hasAttribute('download')) {
      return false;
    }

    const url = new URL(hrefWithData(), window.location.origin);
    if (url.origin !== window.location.origin) {
      return false;
    }

    return true;
  }

  function onClick(event: MouseEvent) {
    callHandler(local.onClick, event);
    if (!shouldHandleClick(event)) {
      return;
    }

    let navigatePrevented = false;
    local.onNavigate?.({
      preventDefault() {
        navigatePrevented = true;
      },
    });
    if (navigatePrevented) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    router?.visit(hrefWithData(), {
      method: normalizedMethod(),
      data: isGet() ? undefined : local.data,
      preserveScroll: local.preserveScroll,
      preserveState: local.preserveState,
      replace: local.replace,
      viewTransition: local.viewTransition,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: IntersectionObserver | null = null;
  let el: HTMLElement | undefined;

  function onMouseEnter(event: MouseEvent) {
    callHandler(local.onMouseEnter, event);
    if (event.defaultPrevented) {
      return;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave(event: MouseEvent) {
    callHandler(local.onMouseLeave, event);
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onFocus(event: FocusEvent) {
    callHandler(local.onFocus, event);
    if (!event.defaultPrevented) {
      doPrefetch();
    }
  }

  function onMouseDown(event: MouseEvent) {
    callHandler(local.onMouseDown, event);
    if (!event.defaultPrevented) {
      doPrefetch();
    }
  }

  function onTouchStart(event: TouchEvent) {
    callHandler(local.onTouchStart, event);
    if (!event.defaultPrevented) {
      doPrefetch();
    }
  }

  onMount(() => {
    if (strategies().includes('mount')) {
      doPrefetch();
    }
    if (strategies().includes('visible') && el) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            doPrefetch();
            observer?.disconnect();
            observer = null;
          }
        },
        { rootMargin: '0px' },
      );
      observer.observe(el);
    }
  });

  onCleanup(() => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  });

  const eventHandlers = createMemo(() => {
    const handlers: Record<string, unknown> = {
      onClick,
      onFocus: local.onFocus,
      onMouseDown: local.onMouseDown,
      onMouseEnter: local.onMouseEnter,
      onMouseLeave: local.onMouseLeave,
      onTouchStart: local.onTouchStart,
    };

    if (strategies().includes('hover')) {
      handlers.onMouseEnter = onMouseEnter;
      handlers.onMouseLeave = onMouseLeave;
      handlers.onFocus = onFocus;
      handlers.onTouchStart = onTouchStart;
    }

    if (strategies().includes('click')) {
      handlers.onMouseDown = onMouseDown;
      handlers.onTouchStart = onTouchStart;
    }

    return handlers;
  });

  return (
    <>
      {isGet() ? (
        <a
          ref={(r) => {
            el = r;
          }}
          href={hrefWithData()}
          {...rest}
          style={resolvedStyle()}
          {...eventHandlers()}
        >
          {local.children}
        </a>
      ) : (
        <button
          ref={(r) => {
            el = r;
          }}
          type="button"
          {...(rest as JSX.ButtonHTMLAttributes<HTMLButtonElement>)}
          style={resolvedStyle()}
          {...eventHandlers()}
        >
          {local.children}
        </button>
      )}
    </>
  );
}
