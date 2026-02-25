# @void-x/vue

Vue framework adapter for Void Pages mode — Inertia-inspired full-stack DX with SSR.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidVue } from "@void-x/vue";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

## Plugin

`voidVue(options?)` returns `[@vitejs/plugin-vue, pagesPlugin, islandsPlugin]`.

Options:

- `vue?` — options passed to `@vitejs/plugin-vue`
- `viewTransitions?` — enable View Transitions API for SPA navigation

The pages plugin generates two virtual modules:

- `virtual:void-pages-renderer` — SSR entry using `renderToString()` from `vue/server-renderer`
- `virtual:void-pages-client` — client hydration entry using `createSSRApp()` from `vue`

## Runtime

Import from `void/vue`:

- **`Link`** — SPA navigation component. Renders `<a>` for GET, `<button>` otherwise. Intercepts clicks for client-side navigation.
- **`useForm(url, defaults, options?)`** — Form state management using Vue `reactive()` and `ref()`. Supports `v-model` directly on `form.data.name`. Methods: `post`, `put`, `patch`, `delete`, `reset`, `clearErrors`.
- **`useShared()`** — Access shared data from middleware (`c.set("shared", ...)`)
- **`useRouter()`** — Access the router for programmatic navigation

## Pages

Pages are `.vue` files in the `pages/` directory with companion `.server.ts` files:

```vue
<!-- pages/index.vue -->
<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <h1>{{ title }}</h1>
</template>
```

```ts
// pages/index.server.ts
import { defineHandler } from "void";

export const loader = defineHandler(() => {
  return { title: "Home" };
});
```

## Architecture

- **Runtime is pre-built** — compiled with tsdown to ESM + DTS. The plugin entry (`./plugin`) is also pre-built.
- **Vue reactivity for client state** — `reactive()` objects drive page/props/shared/errors updates. In-place mutation via `Object.assign()` preserves reactivity.
- **`provide`/`inject` DI** — string-keyed `provide`/`inject` provides router, shared data, and errors to child components. No `optimizeDeps` exclusion needed since Vue uses key-based lookup, not object identity.

## Tests

- `test/integration/vue-pages-playground.test.ts` — Server-side SSR + Inertia protocol tests
- `test/integration/vue-pages-client.test.ts` — Playwright browser tests (dev + preview) for hydration, SPA navigation, forms
