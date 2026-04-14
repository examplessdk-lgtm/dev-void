<script>
  import { setContext, onMount, untrack } from "svelte";

  let props = $props();

  // Extract initial values without reactive tracking.
  // These are one-time snapshots used to seed $state — on the client,
  // store subscriptions in onMount take over reactivity.
  const init = untrack(() => ({
    page: props.page,
    layouts: props.layouts,
    pageProps: props.pageProps,
    shared: props.shared,
    errors: props.errors,
    router: props.router,
    stores: props.stores,
  }));

  // Local reactive state — initialized from props, updated by stores on client
  let currentPage = $state(init.page);
  let currentLayouts = $state(init.layouts);
  let currentPageProps = $state(init.pageProps);
  let shared = $state(init.shared);
  let errors = $state(init.errors);

  // Capitalized alias for dynamic component rendering
  let Page = $derived(currentPage);

  // Provide context for child components (useShared, useRouter, useForm)
  setContext("__void_shared", {
    get value() { return shared; },
  });
  setContext("__void_errors", {
    get value() { return errors; },
  });
  setContext("__void_router", init.router);

  // Client mode: subscribe to stores for live updates after hydration.
  // onMount only runs on the client, not during SSR.
  onMount(() => {
    if (!init.stores) {return;}
    const unsubs = [
      init.stores.page.subscribe((v) => { currentPage = v; }),
      init.stores.props.subscribe((v) => { currentPageProps = v; }),
      init.stores.layouts.subscribe((v) => { currentLayouts = v; }),
      init.stores.shared.subscribe((v) => { shared = v; }),
      init.stores.errors.subscribe((v) => { errors = v; }),
    ];
    return () => unsubs.forEach((u) => u());
  });
</script>

{#if Page}
  {#if currentLayouts.length > 0}
    {@render layoutChain(currentLayouts, 0)}
  {:else}
    <Page {...currentPageProps} />
  {/if}
{/if}

{#snippet layoutChain(layouts, index)}
  {#if index < layouts.length}
    {@const Layout = layouts[index]}
    <Layout>
      {@render layoutChain(layouts, index + 1)}
    </Layout>
  {:else}
    <Page {...currentPageProps} />
  {/if}
{/snippet}
