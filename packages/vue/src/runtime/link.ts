import {
  computed,
  defineComponent,
  h,
  inject,
  onMounted,
  onUnmounted,
  ref,
  type Component,
  type PropType,
} from 'vue';

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type NavigateEvent = { preventDefault(): void };

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

function hasPrefetch(prefetch: boolean | PrefetchStrategy | PrefetchStrategy[]): boolean {
  return prefetch !== false;
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

function callHandler(handler: unknown, event: Event): void {
  if (Array.isArray(handler)) {
    for (const fn of handler) {
      if (typeof fn === 'function') {
        fn(event);
      }
    }
  } else if (typeof handler === 'function') {
    handler(event);
  }
}

export const Link: Component = defineComponent({
  name: 'Link',
  props: {
    href: { type: String, required: true },
    method: { type: String, default: 'GET' },
    data: { type: Object, default: undefined },
    preserveScroll: { type: Boolean, default: false },
    preserveState: { type: Boolean, default: false },
    replace: { type: Boolean, default: false },
    reloadDocument: { type: Boolean, default: false },
    viewTransition: { type: Boolean, default: undefined },
    onNavigate: { type: Function as PropType<(event: NavigateEvent) => void>, default: undefined },
    prefetch: {
      type: [Boolean, String, Array] as PropType<boolean | PrefetchStrategy | PrefetchStrategy[]>,
      default: false,
    },
    cacheFor: {
      type: [Number, String, Array] as PropType<number | string | [string, string]>,
      default: undefined,
    },
  },
  setup(props, { slots, attrs }) {
    const router = inject<any>('__void_router', null);
    const elRef = ref<HTMLElement | null>(null);
    const normalizedMethod = computed(() => props.method.toUpperCase() as LinkMethod);
    const isGet = computed(() => normalizedMethod.value === 'GET');
    const hrefWithData = computed(() =>
      isGet.value ? mergeDataIntoHref(props.href, props.data) : props.href,
    );
    const strategies = computed<PrefetchStrategy[]>(() => {
      if (props.prefetch === false || props.reloadDocument) {
        return [];
      }
      if (props.prefetch === true) {
        return ['hover'];
      }
      if (typeof props.prefetch === 'string') {
        return [props.prefetch];
      }
      return props.prefetch;
    });

    function doPrefetch() {
      if (!router?.prefetch) {
        return;
      }
      const current = window.location.pathname + window.location.search;
      if (hrefWithData.value === current) {
        return;
      }
      const options: any = {};
      if (props.cacheFor !== undefined) {
        options.cacheFor = props.cacheFor;
      }
      if (normalizedMethod.value) {
        options.method = normalizedMethod.value;
      }
      router.prefetch(hrefWithData.value, options);
    }

    function onClick(e: MouseEvent) {
      callHandler(attrs.onClick, e);
      if (props.reloadDocument || !router || e.defaultPrevented || isModifiedEvent(e)) {
        return;
      }
      if ((e.currentTarget as HTMLElement).hasAttribute('download')) {
        return;
      }
      const url = new URL(hrefWithData.value, window.location.origin);
      if (url.origin !== window.location.origin) {
        return;
      }

      let navigatePrevented = false;
      props.onNavigate?.({
        preventDefault() {
          navigatePrevented = true;
        },
      });
      if (navigatePrevented) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      router.visit(hrefWithData.value, {
        method: normalizedMethod.value,
        data: isGet.value ? undefined : props.data,
        preserveScroll: props.preserveScroll,
        preserveState: props.preserveState,
        replace: props.replace,
        viewTransition: props.viewTransition,
      });
    }

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: IntersectionObserver | null = null;

    function onMouseEnter(e: MouseEvent) {
      callHandler(attrs.onMouseenter ?? attrs.onMouseEnter, e);
      if (e.defaultPrevented) {
        return;
      }
      hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
    }

    function onMouseLeave(e: MouseEvent) {
      callHandler(attrs.onMouseleave ?? attrs.onMouseLeave, e);
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }

    function onFocus(e: FocusEvent) {
      callHandler(attrs.onFocus, e);
      if (!e.defaultPrevented) {
        doPrefetch();
      }
    }

    function onMouseDown(e: MouseEvent) {
      callHandler(attrs.onMousedown ?? attrs.onMouseDown, e);
      if (!e.defaultPrevented) {
        doPrefetch();
      }
    }

    function onTouchStart(e: TouchEvent) {
      callHandler(attrs.onTouchstart ?? attrs.onTouchStart, e);
      if (!e.defaultPrevented) {
        doPrefetch();
      }
    }

    onMounted(() => {
      if (strategies.value.includes('mount')) {
        doPrefetch();
      }
      if (strategies.value.includes('visible') && elRef.value) {
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
        observer.observe(elRef.value);
      }
    });

    onUnmounted(() => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    });

    return () => {
      if (hasPrefetch(props.prefetch) && !isGet.value) {
        throw new Error(
          'Void Link prefetch only supports GET links. Remove `prefetch` or use method="GET".',
        );
      }
      if (props.reloadDocument && !isGet.value) {
        throw new Error('Void Link reloadDocument only supports GET links.');
      }

      const tag = isGet.value ? 'a' : 'button';

      const eventHandlers: Record<string, any> = { onClick };

      if (strategies.value.includes('hover')) {
        eventHandlers.onMouseenter = onMouseEnter;
        eventHandlers.onMouseleave = onMouseLeave;
        eventHandlers.onFocus = onFocus;
        eventHandlers.onTouchstart = onTouchStart;
      }

      if (strategies.value.includes('click')) {
        eventHandlers.onMousedown = onMouseDown;
        eventHandlers.onTouchstart = onTouchStart;
      }

      return h(
        tag,
        {
          ...attrs,
          ref: elRef,
          ...(isGet.value ? { href: hrefWithData.value } : { type: 'button' }),
          style: [{ touchAction: 'manipulation' }, (attrs as any).style],
          ...eventHandlers,
        },
        slots.default?.(),
      );
    };
  },
});
