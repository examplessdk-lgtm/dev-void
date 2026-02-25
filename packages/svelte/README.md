# @void-x/svelte

Svelte 5 framework adapter for Void Pages mode — Inertia-inspired full-stack DX with SSR.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSvelte } from "@void-x/svelte";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

## Plugin

`voidSvelte(options?)` returns `[@sveltejs/vite-plugin-svelte, pagesPlugin]`.

Options:

- `svelte?` — options passed to `@sveltejs/vite-plugin-svelte`
- `viewTransitions?` — enable View Transitions API for SPA navigation

The pages plugin generates two virtual modules:

- `virtual:void-pages-renderer` — SSR entry using `render()` from `svelte/server`
- `virtual:void-pages-client` — client hydration entry using `hydrate()` from `svelte`

## Runtime

Import from `void/svelte`:

- **`Link`** — SPA navigation component. Renders `<a>` for GET, `<button>` otherwise. Intercepts clicks for client-side navigation.
- **`useForm(url, defaults, options?)`** — Form state management using Svelte 5 runes (`$state`, `$derived`). Supports `bind:value` directly on `form.data.name`. Methods: `post`, `put`, `patch`, `delete`, `reset`, `clearErrors`.
- **`useShared()`** — Access shared data from middleware (`c.set("shared", ...)`)
- **`useRouter()`** — Access the router for programmatic navigation

## Pages

Pages are `.svelte` files in the `pages/` directory with companion `.server.ts` files:

```svelte
<!-- pages/index.svelte -->
<script>
  let { title } = $props();
</script>

<h1>{title}</h1>
```

```ts
// pages/index.server.ts
import { defineHandler } from "void";

export const loader = defineHandler(() => {
  return { title: "Home" };
});
```

## Architecture

- **Runtime ships as source** — `.svelte` and `.svelte.ts` files are compiled by the consumer's Svelte plugin at dev/build time. The plugin entry (`./plugin`) is pre-built with tsdown.
- **Svelte stores for client state** — `writable` stores drive page/props/shared/errors updates. Store subscriptions are set up in `onMount` (client-only).
- **Context-based DI** — `setContext`/`getContext` provides router, shared data, and errors to child components.

## Tests

- `test/unit/use-form.test.ts` — 14 tests for form core logic
- `test/integration/svelte-pages-playground.test.ts` — Server-side SSR + Inertia protocol tests
- `test/integration/svelte-pages-client.test.ts` — Playwright browser tests (dev + preview) for hydration, SPA navigation, forms
