<script lang="ts">
  import { getContext, onDestroy, onMount, type Snippet } from "svelte";
  import type { VoidRouter } from "void/pages-client";

  type PrefetchStrategy = "hover" | "click" | "mount" | "visible";
  type LinkMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  type NavigateEvent = { preventDefault(): void };
  type EventHandler<T extends Event> = (event: T) => void;
  type PrefetchOptions = {
    cacheFor?: number | string | [string, string];
    method?: LinkMethod;
  };

  let {
    href,
    method = "GET",
    data = undefined,
    preserveScroll = false,
    preserveState = false,
    replace = false,
    reloadDocument = false,
    viewTransition = undefined,
    prefetch: prefetchProp = false,
    cacheFor = undefined,
    onNavigate = undefined,
    children,
    onclick: onclickProp = undefined,
    onmouseenter: onMouseEnterProp = undefined,
    onmouseleave: onMouseLeaveProp = undefined,
    onfocus: onFocusProp = undefined,
    onmousedown: onMouseDownProp = undefined,
    ontouchstart: onTouchStartProp = undefined,
    style = undefined,
    ...rest
  }: {
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
    children?: Snippet;
    onclick?: EventHandler<MouseEvent>;
    onmouseenter?: EventHandler<MouseEvent>;
    onmouseleave?: EventHandler<MouseEvent>;
    onfocus?: EventHandler<FocusEvent>;
    onmousedown?: EventHandler<MouseEvent>;
    ontouchstart?: EventHandler<TouchEvent>;
    style?: string;
    [key: string]: unknown;
  } = $props();

  const router = getContext<VoidRouter>("__void_router");

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
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params.append(key, String(value));
      return true;
    }
    throw new Error(
      `Void Link GET data only supports primitive values and arrays. Received nested data for "${key}".`,
    );
  }

  function mergeDataIntoHref(hrefValue: string, dataValue?: Record<string, unknown>): string {
    if (!dataValue) {
      return hrefValue;
    }

    const hashIndex = hrefValue.indexOf("#");
    const beforeHash = hashIndex === -1 ? hrefValue : hrefValue.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : hrefValue.slice(hashIndex);
    const searchIndex = beforeHash.indexOf("?");
    const path = searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex);
    const search = searchIndex === -1 ? "" : beforeHash.slice(searchIndex + 1);
    const params = new URLSearchParams(search);
    let appended = false;

    for (const [key, value] of Object.entries(dataValue)) {
      appended = appendQueryValue(params, key, value) || appended;
    }

    if (!appended) {
      return hrefValue;
    }

    const query = params.toString();
    return `${path}${query ? `?${query}` : ""}${hash}`;
  }

  function hasPrefetch(prefetch: boolean | PrefetchStrategy | PrefetchStrategy[]): boolean {
    return prefetch !== false;
  }

  function isModifiedEvent(e: MouseEvent): boolean {
    const target = (e.currentTarget as HTMLElement).getAttribute("target");
    return (
      (target !== null && target !== "_self") ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.altKey ||
      e.button !== 0
    );
  }

  function getStrategies(): PrefetchStrategy[] {
    if (hasPrefetch(prefetchProp) && !isGet) {
      throw new Error(
        'Void Link prefetch only supports GET links. Remove `prefetch` or use method="GET".',
      );
    }
    if (reloadDocument && !isGet) {
      throw new Error("Void Link reloadDocument only supports GET links.");
    }
    if (prefetchProp === false || reloadDocument) {
      return [];
    }
    if (prefetchProp === true) {
      return ["hover"];
    }
    if (typeof prefetchProp === "string") {
      return [prefetchProp];
    }
    return prefetchProp;
  }

  function doPrefetch() {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (hrefWithData === current) {
      return;
    }
    const options: PrefetchOptions = {};
    if (cacheFor !== undefined) {
      options.cacheFor = cacheFor;
    }
    if (normalizedMethod) {
      options.method = normalizedMethod;
    }
    router.prefetch(hrefWithData, options);
  }

  function onClick(e: MouseEvent) {
    onclickProp?.(e);
    if (reloadDocument || !router || e.defaultPrevented || isModifiedEvent(e)) {
      return;
    }
    if ((e.currentTarget as HTMLElement).hasAttribute("download")) {
      return;
    }
    const url = new URL(hrefWithData, window.location.origin);
    if (url.origin !== window.location.origin) {
      return;
    }

    let navigatePrevented = false;
    onNavigate?.({
      preventDefault() {
        navigatePrevented = true;
      },
    });
    if (navigatePrevented) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    router.visit(hrefWithData, {
      method: normalizedMethod,
      data: isGet ? undefined : data,
      preserveScroll,
      preserveState,
      replace,
      viewTransition,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: IntersectionObserver | null = null;
  let el = $state<HTMLElement | null>(null);

  function onMouseEnter(e: MouseEvent) {
    onMouseEnterProp?.(e);
    if (e.defaultPrevented) {
      return;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave(e: MouseEvent) {
    onMouseLeaveProp?.(e);
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onFocus(e: FocusEvent) {
    onFocusProp?.(e);
    if (!e.defaultPrevented) {
      doPrefetch();
    }
  }

  function onMouseDown(e: MouseEvent) {
    onMouseDownProp?.(e);
    if (!e.defaultPrevented) {
      doPrefetch();
    }
  }

  function onTouchStart(e: TouchEvent) {
    onTouchStartProp?.(e);
    if (!e.defaultPrevented) {
      doPrefetch();
    }
  }

  onMount(() => {
    if (strategies.includes("mount")) {
      doPrefetch();
    }
    if (strategies.includes("visible") && el) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            doPrefetch();
            observer?.disconnect();
            observer = null;
          }
        },
        { rootMargin: "0px" },
      );
      observer.observe(el);
    }
  });

  onDestroy(() => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  });

  const normalizedMethod = $derived(method.toUpperCase() as LinkMethod);
  const isGet = $derived(normalizedMethod === "GET");
  const hrefWithData = $derived(isGet ? mergeDataIntoHref(href, data) : href);
  const strategies = $derived(getStrategies());
  const resolvedStyle = $derived(
    style ? `touch-action: manipulation; ${style}` : "touch-action: manipulation",
  );
</script>

{#if isGet}
  <a
    bind:this={el}
    href={hrefWithData}
    {...rest}
    style={resolvedStyle}
    onclick={onClick}
    onmouseenter={strategies.includes("hover") ? onMouseEnter : onMouseEnterProp}
    onmouseleave={strategies.includes("hover") ? onMouseLeave : onMouseLeaveProp}
    onfocus={strategies.includes("hover") ? onFocus : onFocusProp}
    onmousedown={strategies.includes("click") ? onMouseDown : onMouseDownProp}
    ontouchstart={strategies.includes("hover") || strategies.includes("click")
      ? onTouchStart
      : onTouchStartProp}
  >
    {@render children()}
  </a>
{:else}
  <button
    bind:this={el}
    type="button"
    {...rest}
    style={resolvedStyle}
    onclick={onClick}
    onmouseenter={strategies.includes("hover") ? onMouseEnter : onMouseEnterProp}
    onmouseleave={strategies.includes("hover") ? onMouseLeave : onMouseLeaveProp}
    onfocus={strategies.includes("hover") ? onFocus : onFocusProp}
    onmousedown={strategies.includes("click") ? onMouseDown : onMouseDownProp}
    ontouchstart={strategies.includes("hover") || strategies.includes("click")
      ? onTouchStart
      : onTouchStartProp}
  >
    {@render children()}
  </button>
{/if}
