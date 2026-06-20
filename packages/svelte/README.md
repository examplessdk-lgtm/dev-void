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
- `useParams()`
- `useNavigation()`
- `useShared()`
- `useForm()`
- `useIslandForm()`
- `action()`

### Link

`Link` renders an `<a>` for GET navigation and a `<button>` for mutation methods:

```svelte
<Link href="/users" data={{ page: 2, tag: ["active", "new"] }}>Filtered users</Link>
<Link href="/users" replace>Users</Link>
<Link href="/logout" reloadDocument>Sign out</Link>
```

GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw.

`prefetch` and `reloadDocument` are GET-only and throw for mutation links. `onNavigate` can cancel client-side navigation by calling `event.preventDefault()`.

### Forms

`useForm()` tracks form state for Pages actions. Use `pending` for in-flight
state, `errors` for field validation, and `error` for non-validation call-site
failures. The submit helpers return promises so boundary-class failures can
propagate through Svelte async error handling or explicit `catch` handlers.

```svelte
<script lang="ts">
  import { useForm } from '@void/svelte';

  const form = useForm('/users', { name: '', email: '' });
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    return form.post();
  }}
>
  <input bind:value={form.data.name} name="name" />
  {#if form.errors.name}<p>{form.errors.name}</p>{/if}
  {#if form.error}<p>{form.error.message}</p>{/if}
  <button disabled={form.pending}>Save</button>
</form>
```

Use `action()` for the awaitable imperative escape hatch. It returns
`{ ok: true, pageData }` or `{ ok: false, error }` for call-site action errors,
while boundary-class failures are thrown. `action()` uses `POST` by default and
accepts `{ method: "PUT" | "PATCH" | "DELETE" }`.

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

Export `ssr = false` from a page's `.server.ts` file to skip server-rendered
component HTML for that route while still running its loader on the first
request.

## Tests

- `test/unit/use-form.test.ts`
- `test/integration/svelte-pages-client.test.ts`

Cross-package SSR/protocol coverage for Svelte pages mode also lives in `framework/packages/void/test/integration/*`.
