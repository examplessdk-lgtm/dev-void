import {
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

export const Link: Component = defineComponent({
  name: 'Link',
  props: {
    href: { type: String, required: true },
    method: { type: String, default: 'GET' },
    data: { type: Object, default: undefined },
    preserveScroll: { type: Boolean, default: false },
    viewTransition: { type: Boolean, default: undefined },
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

    function doPrefetch() {
      if (!router?.prefetch) {
        return;
      }
      const current = window.location.pathname + window.location.search;
      if (props.href === current) {
        return;
      }
      const options: any = {};
      if (props.cacheFor !== undefined) {
        options.cacheFor = props.cacheFor;
      }
      if (props.method) {
        options.method = props.method;
      }
      router.prefetch(props.href, options);
    }

    function onClick(e: MouseEvent) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {
        return;
      }
      const url = new URL(props.href, window.location.origin);
      if (url.origin !== window.location.origin) {
        return;
      }

      e.preventDefault();
      router.visit(props.href, {
        method: props.method,
        data: props.data,
        preserveScroll: props.preserveScroll,
        viewTransition: props.viewTransition,
      });
    }

    function getStrategies(): PrefetchStrategy[] {
      if (props.prefetch === false) {
        return [];
      }
      if (props.prefetch === true) {
        return ['hover'];
      }
      if (typeof props.prefetch === 'string') {
        return [props.prefetch];
      }
      return props.prefetch;
    }

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: IntersectionObserver | null = null;

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

    onMounted(() => {
      const strategies = getStrategies();
      if (strategies.includes('mount')) {
        doPrefetch();
      }
      if (strategies.includes('visible') && elRef.value) {
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
      const strategies = getStrategies();
      const isGet = props.method.toUpperCase() === 'GET';
      const tag = isGet ? 'a' : 'button';

      const eventHandlers: Record<string, any> = { onClick };

      if (strategies.includes('hover')) {
        eventHandlers.onMouseenter = onMouseEnter;
        eventHandlers.onMouseleave = onMouseLeave;
        eventHandlers.onFocus = doPrefetch;
      }

      if (strategies.includes('click')) {
        eventHandlers.onMousedown = onMouseDown;
      }

      return h(
        tag,
        {
          ref: elRef,
          ...(isGet ? { href: props.href } : { type: 'button' }),
          ...eventHandlers,
          ...attrs,
        },
        slots.default?.(),
      );
    };
  },
});
