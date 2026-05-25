# @void/react

React adapter for Void Pages mode.

## Setup

`@void/react` requires React 19.

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidReact } from '@void/react/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

## Plugin

`voidReact(options?)` returns:

- `@vitejs/plugin-react`
- the React pages plugin
- the React islands plugin

Options:

- `react?` — forwarded to `@vitejs/plugin-react`
- `viewTransitions?` — enable View Transitions for SPA navigation
- `prefetch?` — link prefetch behavior

## Runtime

Main runtime APIs live at `@void/react`:

- `Link`
- `useRouter()`
- `useParams()`
- `useNavigation()`
- `useShared()`
- `useForm()`
- `useIslandForm()`
- `action()`

### Async React Routing

React Pages navigations are scheduled as React transitions. Route data,
component modules, layouts, and deferred props are prepared as resources, then
revealed through Suspense so the current screen can stay visible while the next
page loads.

```tsx
import { Suspense, use } from 'react';
import { useNavigation, useRouter } from '@void/react';
import type { Props } from './dashboard.server';

function Usage({ usage }: Pick<Props, 'usage'>) {
  const resolved = use(usage);
  return <p>{resolved.requests} requests</p>;
}

export default function Dashboard({ usage }: Props) {
  const router = useRouter();
  const navigation = useNavigation();

  return (
    <>
      <button onClick={() => router.refresh()} disabled={navigation.state !== 'idle'}>
        Refresh
      </button>
      <Suspense fallback={<p>Loading usage...</p>}>
        <Usage usage={usage} />
      </Suspense>
    </>
  );
}
```

Breaking change: React deferred props returned from `defer()` are consumed as
promises with `use()` under a Suspense boundary. The old
`prop.loading` / `prop.value` shape remains the runtime shape for the Vue,
Svelte, and Solid adapters.

SSR uses React 19's streaming renderer. Deferred props render the nearest
Suspense fallback in the initial shell, then Void streams the resolved values to
the hydrated client. Put deferred reads behind Suspense, and use a normal React
error boundary around that Suspense boundary when rejected deferred values need a
custom error state.

Export `ssr = false` from a page's `.server.ts` file to skip server-rendered
component HTML for that route. The loader still runs and the browser mounts the
page with the embedded initial props.

For explicit prop annotations in React pages, import `Deferred` from
`@void/react`:

```ts
import type { Deferred } from '@void/react';

export interface Props {
  usage: Deferred<{ requests: number }>;
}
```

### Forms and Actions

`useForm()` is built on React Actions. Prefer native form submission with
`form.post`, `form.put`, `form.patch`, or `form.delete`; use `useFormStatus()`
inside the form for button pending state.

```tsx
import { useForm } from '@void/react';
import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>Save</button>;
}

export default function CreateUser() {
  const form = useForm('/users', { name: '', email: '' });

  return (
    <form action={form.post}>
      <input
        name="name"
        value={form.data.name}
        onChange={(e) => form.setData('name', e.target.value)}
      />
      {form.errors.name && <span>{form.errors.name}</span>}
      {form.error && <p>{form.error.message}</p>}
      <SubmitButton />
    </form>
  );
}
```

`form.post`, `form.put`, `form.patch`, and `form.delete` are native React form
actions. Use `action()` for the awaitable imperative escape hatch; it returns
`{ ok: true, pageData }` or `{ ok: false, error }` for call-site action errors,
while boundary-class failures are thrown. `action()` uses `POST` by default and
accepts `{ data, method, params }`.

### `useRouter`

`useRouter()` returns the Void Router. `visit()`, `refresh()`, and `prefetch()`
are awaitable; `prefetch()` resolves when the page data has been cached.

### `useParams`

`useParams()` returns dynamic route params for the page currently being rendered.
Use it instead of parsing `useRouter().path` in dynamic Pages routes.

### `Link`

`Link` is the React Pages navigation component. GET links render an `<a>` and
client-side navigate when the click is safe to intercept. Mutation links render a
`<button type="button">` and submit through the Void Router.

```tsx
import { Link } from '@void/react';

<Link href="/users">Users</Link>

<Link href="/users" data={{ page: 2, tag: ['active', 'new'] }}>
  Filtered users
</Link>

<Link href="/users" replace>
  Replace history entry
</Link>

<Link href="/logout" reloadDocument>
  Sign out
</Link>

<Link
  href="/settings"
  onNavigate={(event) => {
    if (!confirm('Leave this page?')) {
      event.preventDefault();
    }
  }}
>
  Settings
</Link>
```

Props:

- `href` — target URL.
- `method` — `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`. Defaults to `GET`.
- `data` — for GET links, primitive values are merged into the query string and arrays become repeated keys. `null` and `undefined` are omitted. Nested objects throw. For non-GET links, `data` is sent as the request body.
- `prefetch` — `false`, `true`, `"hover"`, `"click"`, `"mount"`, `"visible"`, or an array of strategies. Prefetch is GET-only and throws for non-GET links.
- `cacheFor` — cache TTL for prefetched page data.
- `preserveScroll` — keep the current scroll position after navigation.
- `preserveState` — apply the page update without writing a new URL or history entry.
- `replace` — replace the current history entry instead of pushing a new one.
- `reloadDocument` — use browser document navigation. GET-only and throws for non-GET links.
- `viewTransition` — override the adapter-level View Transition setting for this navigation.
- `onNavigate` — cancellable callback for client-side navigations. It does not run for external links, downloads, modified clicks, non-`_self` targets, `reloadDocument`, or missing router context.

## Pages

Pages are `.tsx` files in `pages/` with companion `.server.ts` files:

```tsx
export default function Home({ title }: { title: string }) {
  return <h1>{title}</h1>;
}
```

```ts
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({ title: 'Home' }));
```

## Tests

- `test/unit/use-form.test.ts`
- `test/unit/link.test.ts`
- `test/integration/react-pages-client.test.ts`

Cross-package SSR/protocol coverage for React pages mode also lives in `framework/packages/void/test/integration/*`.
