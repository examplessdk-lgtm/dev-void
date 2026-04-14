# @void/vue

Vue adapter for Void Pages mode.

## Setup

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidVue } from '@void/vue/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

## Plugin

`voidVue(options?)` returns:

- `@vitejs/plugin-vue`
- the Vue pages plugin
- the Vue islands plugin

Options:

- `vue?` — forwarded to `@vitejs/plugin-vue`
- `viewTransitions?` — enable View Transitions for SPA navigation

## Runtime

Main runtime APIs live at `@void/vue`:

- `Link`
- `useRouter()`
- `useNavigation()`
- `useShared()`
- `useForm()`
- `useIslandForm()`
- `action()`

Deferred helpers are exported from `@void/vue/deferred`.

## Pages

Pages are `.vue` files in `pages/` with companion `.server.ts` files:

```vue
<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <h1>{{ title }}</h1>
</template>
```

```ts
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({ title: 'Home' }));
```

## Tests

- `test/unit/use-form.test.ts`
- `test/unit/prefetch.test.ts`
- `test/integration/vue-pages-client.test.ts`

Cross-package SSR/protocol coverage for Vue pages mode also lives in `framework/packages/void/test/integration/*`.
