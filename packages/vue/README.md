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
- `useParams()`
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

### Forms

`useForm()` tracks form state for Pages actions. Use `pending` for in-flight
state, `errors` for field validation, and `error` for non-validation call-site
failures. The submit helpers return promises so boundary-class failures can
propagate through Vue async error handling or explicit `catch` handlers.

```vue
<script setup lang="ts">
import { useForm } from '@void/vue';

const form = useForm('/users', { name: '', email: '' });
</script>

<template>
  <form @submit.prevent="form.post()">
    <input v-model="form.data.name" name="name" />
    <p v-if="form.errors.name">{{ form.errors.name }}</p>
    <p v-if="form.error">{{ form.error.message }}</p>
    <button :disabled="form.pending">Save</button>
  </form>
</template>
```

Use `action()` for the awaitable imperative escape hatch. It returns
`{ ok: true, pageData }` or `{ ok: false, error }` for call-site action errors,
while boundary-class failures are thrown. `action()` uses `POST` by default and
accepts `{ method: "PUT" | "PATCH" | "DELETE" }`.

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

Export `ssr = false` from a page's `.server.ts` file to skip server-rendered
component HTML for that route while still running its loader on the first
request.

## Tests

- `test/unit/use-form.test.ts`
- `test/unit/prefetch.test.ts`
- `test/integration/vue-pages-client.test.ts`

Cross-package SSR/protocol coverage for Vue pages mode also lives in `packages/void/test/integration/*`.
