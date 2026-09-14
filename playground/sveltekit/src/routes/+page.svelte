<script>
  import { onMount } from 'svelte';

  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });
</script>

<h1 data-hydrated={hydrated}>SvelteKit + Void</h1>
<p>This playground demonstrates meta-framework integration.</p>
<a href="/smoke">Smoke Test</a>
