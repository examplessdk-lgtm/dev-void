import { useContext, splitProps, createMemo, onMount, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { RouterContext } from './context';

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';

type CommonProps = {
  href: string;
  method?: string;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  viewTransition?: boolean;
  prefetch?: boolean | PrefetchStrategy | PrefetchStrategy[];
  cacheFor?: number | string | [string, string];
  children?: JSX.Element;
};

export type LinkProps = CommonProps &
  Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps>;

export function Link(props: LinkProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'href',
    'method',
    'data',
    'preserveScroll',
    'viewTransition',
    'prefetch',
    'cacheFor',
    'children',
  ]);
  const router = useContext(RouterContext);

  function getStrategies(): PrefetchStrategy[] {
    const p = local.prefetch;
    if (p === false || p === undefined) {
      return [];
    }
    if (p === true) {
      return ['hover'];
    }
    if (typeof p === 'string') {
      return [p];
    }
    return p;
  }

  function doPrefetch() {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (local.href === current) {
      return;
    }
    const options: any = {};
    if (local.cacheFor !== undefined) {
      options.cacheFor = local.cacheFor;
    }
    if (local.method) {
      options.method = local.method;
    }
    router.prefetch(local.href, options);
  }

  function onClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    const url = new URL(local.href, window.location.origin);
    if (url.origin !== window.location.origin) {
      return;
    }

    e.preventDefault();
    router?.visit(local.href, {
      method: local.method,
      data: local.data,
      preserveScroll: local.preserveScroll,
      viewTransition: local.viewTransition,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: IntersectionObserver | null = null;
  let el: HTMLElement | undefined;

  function onMouseEnter() {
    hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onMouseDown() {
    doPrefetch();
  }

  onMount(() => {
    const strategies = getStrategies();
    if (strategies.includes('mount')) {
      doPrefetch();
    }
    if (strategies.includes('visible') && el) {
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

  const isGet = createMemo(() => (local.method || 'GET').toUpperCase() === 'GET');
  const strategies = createMemo(() => getStrategies());

  return (
    <>
      {isGet() ? (
        <a
          ref={(r) => {
            el = r;
          }}
          href={local.href}
          onClick={onClick}
          onMouseEnter={strategies().includes('hover') ? onMouseEnter : undefined}
          onMouseLeave={strategies().includes('hover') ? onMouseLeave : undefined}
          onFocus={strategies().includes('hover') ? doPrefetch : undefined}
          onMouseDown={strategies().includes('click') ? onMouseDown : undefined}
          {...rest}
        >
          {local.children}
        </a>
      ) : (
        <button
          ref={(r) => {
            el = r;
          }}
          type="button"
          onClick={onClick}
          onMouseEnter={strategies().includes('hover') ? onMouseEnter : undefined}
          onMouseLeave={strategies().includes('hover') ? onMouseLeave : undefined}
          onFocus={strategies().includes('hover') ? doPrefetch : undefined}
          onMouseDown={strategies().includes('click') ? onMouseDown : undefined}
          {...(rest as any)}
        >
          {local.children}
        </button>
      )}
    </>
  );
}
