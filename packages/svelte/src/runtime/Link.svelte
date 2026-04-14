<script>
  import { getContext, onMount, onDestroy } from "svelte";

  let {
    href,
    method = "GET",
    data = undefined,
    preserveScroll = false,
    viewTransition = undefined,
    prefetch: prefetchProp = false,
    cacheFor = undefined,
    children,
    ...rest
  } = $props();

  const router = getContext("__void_router");

  function getStrategies() {
    if (prefetchProp === false) {return [];}
    if (prefetchProp === true) {return ["hover"];}
    if (typeof prefetchProp === "string") {return [prefetchProp];}
    return prefetchProp;
  }

  function doPrefetch() {
    if (!router?.prefetch) {return;}
    const current = window.location.pathname + window.location.search;
    if (href === current) {return;}
    const options = {};
    if (cacheFor !== undefined) {options.cacheFor = cacheFor;}
    if (method) {options.method = method;}
    router.prefetch(href, options);
  }

  function onClick(e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {return;}
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {return;}

    e.preventDefault();
    router.visit(href, {
      method,
      data,
      preserveScroll,
      viewTransition,
    });
  }

  let hoverTimer = null;
  let observer = null;
  let el = $state(null);

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
    if (hoverTimer) {clearTimeout(hoverTimer);}
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  });

  const isGet = $derived(method.toUpperCase() === "GET");
  const strategies = $derived(getStrategies());
</script>

{#if isGet}
  <a
    bind:this={el}
    {href}
    onclick={onClick}
    onmouseenter={strategies.includes("hover") ? onMouseEnter : undefined}
    onmouseleave={strategies.includes("hover") ? onMouseLeave : undefined}
    onfocus={strategies.includes("hover") ? doPrefetch : undefined}
    onmousedown={strategies.includes("click") ? onMouseDown : undefined}
    {...rest}
  >
    {@render children()}
  </a>
{:else}
  <button
    bind:this={el}
    type="button"
    onclick={onClick}
    onmouseenter={strategies.includes("hover") ? onMouseEnter : undefined}
    onmouseleave={strategies.includes("hover") ? onMouseLeave : undefined}
    onfocus={strategies.includes("hover") ? doPrefetch : undefined}
    onmousedown={strategies.includes("click") ? onMouseDown : undefined}
    {...rest}
  >
    {@render children()}
  </button>
{/if}
