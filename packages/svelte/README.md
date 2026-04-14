# @void/svelte

Svelte 5 adapter for Void Pages mode.

## Setup

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidSvelte } from '@void/svelte/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

## Plugin

`voidSvelte(options?)` returns:

- `@sveltejs/vite-plugin-svelte`
- the Svelte pages plugin
- the Svelte islands plugin

Options:

- `svelte?` — forwarded to the Svelte Vite plugin
- `viewTransitions?` — enable View Transitions for SPA navigation
- `prefetch?` — link prefetch behavior

## Runtime

Main runtime APIs live at `@void/svelte`:

- `Link`
- `useRouter()`
- `useNavigation()`
- `useShared()`
- `useForm()`
- `useIslandForm()`
- `action()`

## Pages

Pages are `.svelte` files in `pages/` with companion `.server.ts` files:

```svelte
<script>
  let { title } = $props();
</script>

<h1>{title}</h1>
```

```ts
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({ title: 'Home' }));
```

## Tests

- `test/unit/use-form.test.ts`
- `test/integration/svelte-pages-client.test.ts`

Cross-package SSR/protocol coverage for Svelte pages mode also lives in `framework/packages/void/test/integration/*`.
