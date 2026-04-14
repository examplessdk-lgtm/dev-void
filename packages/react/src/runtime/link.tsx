import { useContext, useRef, useEffect, type JSX } from 'react';
import type { MouseEvent, AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
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
};

export type LinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps>;

export function Link({
  href,
  method = 'GET',
  data,
  preserveScroll = false,
  viewTransition,
  prefetch: prefetchProp = false,
  cacheFor,
  children,
  ...rest
}: LinkProps): JSX.Element {
  const router = useContext(RouterContext);
  const elRef = useRef<HTMLElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function getStrategies(): PrefetchStrategy[] {
    if (prefetchProp === false) {
      return [];
    }
    if (prefetchProp === true) {
      return ['hover'];
    }
    if (typeof prefetchProp === 'string') {
      return [prefetchProp];
    }
    return prefetchProp;
  }

  function doPrefetch() {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (href === current) {
      return;
    }
    const options: any = {};
    if (cacheFor !== undefined) {
      options.cacheFor = cacheFor;
    }
    if (method) {
      options.method = method;
    }
    router.prefetch(href, options);
  }

  function onClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
      return;
    }

    e.preventDefault();
    router.visit(href, {
      method,
      data,
      preserveScroll,
      viewTransition,
    });
  }

  const strategies = getStrategies();

  function onMouseEnter() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function onMouseDown() {
    doPrefetch();
  }

  useEffect(() => {
    const strategies =
      prefetchProp === false
        ? []
        : prefetchProp === true
          ? ['hover']
          : typeof prefetchProp === 'string'
            ? [prefetchProp]
            : prefetchProp;
    if (strategies.length === 0) {
      return;
    }

    const prefetch = () => {
      if (!router?.prefetch) {
        return;
      }
      const current = window.location.pathname + window.location.search;
      if (href === current) {
        return;
      }
      const options: any = {};
      if (cacheFor !== undefined) {
        options.cacheFor = cacheFor;
      }
      if (method) {
        options.method = method;
      }
      router.prefetch(href, options);
    };

    if (strategies.includes('mount')) {
      prefetch();
    }

    let observer: IntersectionObserver | null = null;
    if (strategies.includes('visible') && elRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            prefetch();
            observer?.disconnect();
            observer = null;
          }
        },
        { rootMargin: '0px' },
      );
      observer.observe(elRef.current);
    }

    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (observer) {
        observer.disconnect();
      }
    };
  }, [cacheFor, href, method, prefetchProp, router]);
  const isGet = method.toUpperCase() === 'GET';

  const eventHandlers: Record<string, any> = { onClick };

  if (strategies.includes('hover')) {
    eventHandlers.onMouseEnter = onMouseEnter;
    eventHandlers.onMouseLeave = onMouseLeave;
    eventHandlers.onFocus = doPrefetch;
  }

  if (strategies.includes('click')) {
    eventHandlers.onMouseDown = onMouseDown;
  }

  if (isGet) {
    return (
      <a ref={elRef as any} href={href} {...eventHandlers} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <button
      ref={elRef as any}
      type="button"
      {...eventHandlers}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  );
}
