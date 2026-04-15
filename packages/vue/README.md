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

### Link

`Link` renders an `<a>` for GET navigation and a `<button>` for mutation methods:

```vue
<Link href="/users" :data="{ page: 2, tag: ['active', 'new'] }">Filtered users</Link>
<Link href="/users" replace>Users</Link>
<Link href="/logout" reload-document>Sign out</Link>
```

GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw.

`prefetch` and `reloadDocument` are GET-only and throw for mutation links. `onNavigate` can cancel client-side navigation by calling `event.preventDefault()`.

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
