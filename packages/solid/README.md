# @void/solid

Solid adapter for Void Pages mode.

## Setup

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidSolid } from '@void/solid/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

## Plugin

`voidSolid(options?)` returns:

- `vite-plugin-solid`
- the Solid pages plugin
- the Solid islands plugin

Options:

- `solid?` — forwarded to `vite-plugin-solid`
- `viewTransitions?` — enable View Transitions for SPA navigation
- `prefetch?` — link prefetch behavior

## Runtime

Main runtime APIs live at `@void/solid`:

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

```tsx
<Link href="/users" data={{ page: 2, tag: ['active', 'new'] }}>Filtered users</Link>
<Link href="/users" replace>Users</Link>
<Link href="/logout" reloadDocument>Sign out</Link>
```

GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw.

`prefetch` and `reloadDocument` are GET-only and throw for mutation links. `onNavigate` can cancel client-side navigation by calling `event.preventDefault()`.

### Forms

`useForm()` tracks form state for Pages actions. Use `pending` for in-flight
state, `errors` for field validation, and `error` for non-validation call-site
failures. The submit helpers return promises so boundary-class failures can
propagate through Solid async error handling or explicit `catch` handlers.

```tsx
import { useForm } from '@void/solid';

export default function CreateUser() {
  const form = useForm('/users', { name: '', email: '' });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        return form.post();
      }}
    >
      <input
        name="name"
        value={form.data.name}
        onInput={(event) => form.setData('name', event.currentTarget.value)}
      />
      {form.errors.name && <p>{form.errors.name}</p>}
      {form.error && <p>{form.error.message}</p>}
      <button disabled={form.pending}>Save</button>
    </form>
  );
}
```

Use `action()` for the awaitable imperative escape hatch. It returns
`{ ok: true, pageData }` or `{ ok: false, error }` for call-site action errors,
while boundary-class failures are thrown. `action()` uses `POST` by default and
accepts `{ method: "PUT" | "PATCH" | "DELETE" }`.

## Pages

Pages are `.tsx` files in `pages/` with companion `.server.ts` files:

```tsx
export default function Home(props: { title: string }) {
  return <h1>{props.title}</h1>;
}
```

```ts
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({ title: 'Home' }));
```

Export `ssr = false` from a page's `.server.ts` file to skip server-rendered
component HTML for that route while still running its loader on the first
request.

## Tests

- `test/integration/solid-pages-playground.test.ts`

The Solid integration test covers both SSR output and browser-side navigation/forms.

The [shared client](../../test/pages-client-contract.ts) and [island](../../test/pages-island-contract.ts) contracts run against this adapter in both dev and preview. Shared form equality is tested directly in [Void](../void/test/unit/form-value-equality.test.ts); tests do not copy the hook implementation.
