---
outline: deep
---

<script setup>
import { onMounted } from 'vue'
onMounted(() => {
  const key = 'vitepress:code-group-tab'
  const saved = localStorage.getItem(key)
  if (saved) syncAll(saved)
  window.addEventListener('click', (e) => {
    const label = e.target.closest?.('.vp-code-group .tabs label')
    if (!label) return
    const title = label.getAttribute('data-title')
    if (title) {
      localStorage.setItem(key, title)
      const rect = label.getBoundingClientRect()
      syncAll(title)
      const shift = label.getBoundingClientRect().top - rect.top
      if (shift) window.scrollBy(0, shift)
    }
  })
  function syncAll(title) {
    document.querySelectorAll('.vp-code-group').forEach((group) => {
      const label = group.querySelector(`.tabs label[data-title="${title}"]`)
      if (!label) return
      const input = group.querySelector(`#${CSS.escape(label.getAttribute('for'))}`)
      if (!input || input.checked) return
      const i = Array.from(group.querySelectorAll('.tabs input')).indexOf(input)
      const blocks = group.querySelector('.blocks')
      if (!blocks || i < 0) return
      input.checked = true
      const current = blocks.querySelector('.active')
      if (current) current.classList.remove('active')
      blocks.children[i]?.classList.add('active')
    })
  }
})
</script>

# Pages Routing

Pages routing provides the server-rendered, components-as-pages, collocated-data-loading routing system that is seen in many existing JavaScript meta frameworks. However, pages routing in Void is different from most in that it is **rendering framework agnostic.** It is built on patterns inspired by [Inertia.js](https://inertiajs.com/): The server returns the data, and the component receives it as props. The client-side routing logic is minimal, allowing Void to support any rendering framework Vite can support. Today, React, Vue, Svelte, and Solid have first-party adapters.

Pages mode activates when a `pages/` directory exists. It coexists with `routes/` — use `pages/` for UI pages and `routes/` for APIs. Components in `pages/` will be server-rendered, which means **they will run in both Cloudflare Workers and browsers**.

Pages mode is also entirely optional - you can use any client-side router to build a pure client-side SPA that interacts with the backend API via the [typed fetch](./typed-fetch.md) utility.

## Setup

Install a framework adapter alongside `void`:

::: code-group

```sh [React]
npm install @void-x/react
```

```sh [Vue]
npm install @void-x/vue
```

```sh [Svelte]
npm install @void-x/svelte
```

```sh [Solid]
npm install @void-x/solid
```

:::

Add both plugins to your Vite config:

::: code-group

```ts [React]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void-x/react";

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

```ts [Vue]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidVue } from "@void-x/vue";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

```ts [Svelte]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSvelte } from "@void-x/svelte";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

```ts [Solid]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSolid } from "@void-x/solid";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

:::

That's it — no SSR entry, no client entry, no hydration boilerplate. The adapter generates everything.

Each adapter plugin includes the framework's Vite plugin (`@vitejs/plugin-react`, `@vitejs/plugin-vue`, `@sveltejs/vite-plugin-svelte`, `vite-plugin-solid`) so you don't need to install or configure it separately. Pass framework plugin options via `voidReact({ react: { ... } })`, `voidVue({ vue: { ... } })`, `voidSvelte({ svelte: { ... } })`, or `voidSolid({ solid: { ... } })` if needed.

## How Navigation Works

Pages uses an Inertia-style protocol under the hood:

| Request               | Response                                                              |
| --------------------- | --------------------------------------------------------------------- |
| Initial page load     | Full SSR HTML. Client hydrates automatically.                         |
| Subsequent navigation | JSON with component name + props. Client component swap or re-render. |
| Form submission       | Runs action, then returns fresh props or a redirect.                  |

This means the first page load is server-rendered for SEO and performance, and all subsequent navigations feel instant — no full page reloads.

Use the `Link` component for SPA navigation between pages. It renders an `<a>` tag that intercepts clicks and navigates without a full page reload:

::: code-group

```tsx [React]
import { Link } from "void/react";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from "void/vue";
</script>

<template>
  <Link href="/users">Users</Link>
  <Link :href="`/users/${id}`">View</Link>
</template>
```

```svelte [Svelte]
<script>
  import { Link } from "void/svelte";
</script>

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```tsx [Solid]
import { Link } from "void/solid";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

:::

For programmatic navigation, use `useRouter()`:

```ts
import { useRouter } from "void/vue"; // or "void/react", "void/svelte", "void/solid"

const router = useRouter();
router.visit("/users");
router.reload(); // re-fetch current page props
router.post("/logout"); // non-GET navigation
```

## Directory Structure

Each page is a component file paired with a `.server.ts` file that provides server-side data loading. Pages can be flat files (`about.vue`) or use directory-based routing (`about/index.vue`) — both map to the same route:

```
project/
  pages/                      # UI pages (SSR + SPA navigation)
    layout.(tsx|vue|svelte)   # Root layout
    index.(tsx|vue|svelte)    # GET /
    index.server.ts           # Server handler for /
    about.(tsx|vue|svelte)    # GET /about (flat file)
    about.server.ts           # Server handler for /about
    users/
      layout.(tsx|vue|svelte) # Nested layout for /users/*
      index.(tsx|vue|svelte)  # GET /users (directory-based)
      index.server.ts         # Server handler for /users
      [id].(tsx|vue|svelte)   # GET /users/:id
      [id].server.ts          # Server handler for /users/:id
  routes/                     # Pure JSON API endpoints
    api/
      health.ts               # GET /api/health -> JSON
  middleware/                 # Shared across pages and routes
    01.auth.ts
```

File-based routing rules are the same as [server routing](./server-routing.md): `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups.

## Server Handlers

Every page can have a companion `.server.ts` file that exports a `loader` and/or `action`. Server handlers use the exact same `defineHandler` API as [server routes](./server-routing.md) — you get the same typed `c.env` bindings, `withValidator()` support, and Hono context methods.

**`loader`** runs on GET requests and returns an object that becomes the page's props:

```ts
// pages/users/index.server.ts
import { defineHandler } from "void";
import type { InferProps } from "void";
import { db } from "void/db";

export type Props = InferProps<typeof loader>; // [!code highlight]

export const loader = defineHandler(async (c) => {
  return { users: await db.list("users") };
});
```

`InferProps` extracts the return type from a `defineHandler` call, so you don't need to maintain a separate interface. You can also write the interface explicitly if you prefer:

```ts
export interface Props {
  users: Array<{ id: number; name: string; email: string }>;
}

export const loader = defineHandler<Props>(async (c) => {
  return { users: await db.list("users") };
});
```

**`action`** runs on mutations (POST, PUT, PATCH, DELETE):

```ts
// pages/users/index.server.ts
export const action = defineHandler.withValidator({
  body: createUserSchema,
})(async (c, { body }) => {
  await db.insert("users", body);
  // No return → re-runs loader, page re-renders with fresh data
});
```

| Action returns        | Behavior                                              |
| --------------------- | ----------------------------------------------------- |
| Nothing (void)        | Re-runs the loader, page re-renders with fresh props. |
| `c.redirect('/path')` | Navigates to another page.                            |

Both use the same `defineHandler` API from [server routing](./server-routing.md), including `withValidator()` for input validation.

## Page Components

The component receives loader data as props. Export the props type from your `.server.ts` file to keep the contract in one place:

::: code-group

```tsx [React]
// pages/users/index.tsx
import type { Props } from "./index.server";

export default function UsersPage({ users }: Props) {
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
```

```vue [Vue]
<!-- pages/users/index.vue -->
<script setup lang="ts">
import type { Props } from "./index.server";
defineProps<Props>();
</script>

<template>
  <h1>Users</h1>
  <ul>
    <li v-for="u in users" :key="u.id">{{ u.name }}</li>
  </ul>
</template>
```

```svelte [Svelte]
<!-- pages/users/index.svelte -->
<script lang="ts">
  import type { Props } from "./index.server";

  let { users }: Props = $props();
</script>

<h1>Users</h1>
<ul>
  {#each users as u (u.id)}
    <li>{u.name}</li>
  {/each}
</ul>
```

```tsx [Solid]
// pages/users/index.tsx
import type { Props } from "./index.server";
import { For } from "solid-js";

export default function UsersPage(props: Props) {
  return (
    <>
      <h1>Users</h1>
      <ul>
        <For each={props.users}>{(u) => <li>{u.name}</li>}</For>
      </ul>
    </>
  );
}
```

Aside from the loader, the component can also use the [typed fetch]()

:::

## Deferred Props

Loaders sometimes need to fetch data that's slow — analytics, external APIs, AI inference. `defer()` lets you return a placeholder immediately so the page renders fast, then streams the real data as it resolves:

```ts
// pages/dashboard.server.ts
import { defineHandler, defer } from "void";
import type { InferProps } from "void";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const projects = await db.list("projects"); // fast — returns immediately
  return {
    projects,
    usage: defer(async () => {
      return await fetchUsageMetrics(); // slow — streams when ready
    }),
  };
});
```

The page renders immediately with `projects` available. The `usage` prop starts in a loading state and resolves once the deferred function completes — no waterfall, no blocking.

### Handling Deferred State

`Deferred<T>` is a [discriminated union](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions) with three states:

```ts
type Deferred<T> =
  | { loading: true; value: null; error: null } // pending
  | { loading: false; value: T; error: null } // resolved
  | { loading: false; value: null; error: Error }; // rejected
```

Check `loading` first, then `error` — TypeScript narrows `value` to `T` in the resolved branch:

::: code-group

```tsx [React]
import type { Props } from "./dashboard.server";

export default function Dashboard({ projects, usage }: Props) {
  return (
    <div>
      <h1>Projects ({projects.length})</h1>
      {usage.loading ? (
        <p>Loading usage...</p>
      ) : usage.error ? (
        <p>Failed: {usage.error.message}</p>
      ) : (
        <p>{usage.value.requests} requests</p>
      )}
    </div>
  );
}
```

```vue [Vue]
<script setup lang="ts">
import type { Props } from "./dashboard.server";
defineProps<Props>();
</script>

<template>
  <div>
    <h1>Projects ({{ projects.length }})</h1>
    <p v-if="usage.loading">Loading usage...</p>
    <p v-else-if="usage.error">Failed: {{ usage.error.message }}</p>
    <p v-else>{{ usage.value.requests }} requests</p>
  </div>
</template>
```

```svelte [Svelte]
<script lang="ts">
  import type { Props } from "./dashboard.server";
  let { projects, usage }: Props = $props();
</script>

<div>
  <h1>Projects ({projects.length})</h1>
  {#if usage.loading}
    <p>Loading usage...</p>
  {:else if usage.error}
    <p>Failed: {usage.error.message}</p>
  {:else}
    <p>{usage.value.requests} requests</p>
  {/if}
</div>
```

```tsx [Solid]
import type { Props } from "./dashboard.server";

export default function Dashboard(props: Props) {
  return (
    <div>
      <h1>Projects ({props.projects.length})</h1>
      {props.usage.loading ? (
        <p>Loading usage...</p>
      ) : props.usage.error ? (
        <p>Failed: {props.usage.error.message}</p>
      ) : (
        <p>{props.usage.value.requests} requests</p>
      )}
    </div>
  );
}
```

:::

### How It Works

On the initial page load (SSR), the page renders with deferred props in their loading state. As each deferred function resolves, the server streams an inline `<script>` tag that delivers the data — no extra HTTP request needed. On SPA navigation, deferred data streams via NDJSON over the same response.

### Grouped Deferred Props

When multiple props depend on the same slow operation, use a named group to resolve them together with a single function call:

```ts
export const loader = defineHandler<Props>(async (c) => {
  const analyticsResolver = async () => {
    const data = await fetchAnalytics(); // one slow call
    return { metrics: data.metrics, chart: data.chart };
  };

  return {
    projects: await db.list("projects"),
    metrics: defer("analytics", analyticsResolver),
    chart: defer("analytics", analyticsResolver),
  };
});
```

Both `metrics` and `chart` resolve from a single invocation of the analytics resolver. The component receives them as separate `Deferred<T>` props.

## Layouts

Place a layout file in any `pages/` directory to wrap all pages in that subtree:

```
pages/
  layout.(tsx|vue|svelte)     # Root layout (nav, footer)
  index.(tsx|vue|svelte)
  users/
    layout.(tsx|vue|svelte)   # Nested layout for /users/*
    index.(tsx|vue|svelte)
    [id].(tsx|vue|svelte)
```

::: code-group

```tsx [React]
// pages/layout.tsx
import { useShared, Link } from "void/react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const { auth } = useShared();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {auth?.user && <span>{auth.user.name}</span>}
      </nav>
      <main>{children}</main>
    </>
  );
}
```

```vue [Vue]
<!-- pages/layout.vue -->
<script setup lang="ts">
import { useShared, Link } from "void/vue";
const { auth } = useShared();
</script>

<template>
  <nav>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <span v-if="auth?.user">{{ auth.user.name }}</span>
  </nav>
  <main>
    <slot />
  </main>
</template>
```

```svelte [Svelte]
<!-- pages/layout.svelte -->
<script>
  import { useShared, Link } from "void/svelte";
  let { children } = $props();
  const { auth } = useShared();
</script>

<nav>
  <Link href="/">Home</Link>
  <Link href="/users">Users</Link>
  {#if auth?.user}<span>{auth.user.name}</span>{/if}
</nav>
<main>
  {@render children()}
</main>
```

```tsx [Solid]
// pages/layout.tsx
import { useShared, Link } from "void/solid";
import type { JSX } from "solid-js";

export default function Layout(props: { children: JSX.Element }) {
  const shared = useShared<{ auth: { user: { name: string } | null } }>();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {shared.auth?.user && <span>{shared.auth.user.name}</span>}
      </nav>
      <main>{props.children}</main>
    </>
  );
}
```

:::

Layouts nest automatically (e.g. root layout wraps `users/layout` wraps page component) and persist across navigations within their subtree — component state is preserved.

## Shared Data

Middleware can inject data available on every page via `c.set("shared", {...})`. Augment `CloudContextVariables` to type the shared data, and `useShared()` will infer the type automatically:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "void";

declare module "void" {
  interface CloudContextVariables {
    shared: { auth: { user: { name: string } | null } };
  }
}

export default defineMiddleware(async (c, next) => {
  const user = await getSessionUser(c);
  c.set("shared", { auth: { user } });
  await next();
});
```

Access it on the client with `useShared()` — the return type is inferred from your augmentation:

::: code-group

```tsx [React]
import { useShared } from "void/react";

export default function Page() {
  const { auth } = useShared(); // { auth: { user: { name: string } | null } }
  return <p>Hello, {auth?.user?.name}</p>;
}
```

```vue [Vue]
<script setup lang="ts">
import { useShared } from "void/vue";
const { auth } = useShared(); // { auth: { user: { name: string } | null } }
</script>
```

```svelte [Svelte]
<script>
  import { useShared } from "void/svelte";
  const { auth } = useShared(); // { auth: { user: { name: string } | null } }
</script>
```

```tsx [Solid]
import { useShared } from "void/solid";

export default function Page() {
  const shared = useShared(); // { auth: { user: { name: string } | null } }
  return <p>Hello, {shared.auth?.user?.name}</p>;
}
```

:::

Shared data is separate from page props — props come from the loader, `useShared()` returns global data from middleware. See [Type Safety](./type-safety.md#context-variables) for more on augmenting `CloudContextVariables`.

## Forms and Actions

`useForm` handles form submissions, loading state, and validation errors. It is **fully typed end-to-end** — the URL autocompletes to pages that have an `action`, `form.data` is typed to match the action's validator schema, and `form.errors` keys are constrained to the body's field names. No manual type annotations needed.

Given an action with a validator:

```ts
// pages/users/create.server.ts
import { defineHandler } from "void";
import * as v from "valibot";

export const action = defineHandler.withValidator({
  body: v.object({
    name: v.string(),
    email: v.pipe(v.string(), v.email()),
  }),
})(async (c, { body }) => {
  await db.insert("users", body);
});
```

`useForm` automatically infers body fields and error keys from the validator — the types flow from server to client with zero duplication:

First, define the action in your server handler:

```ts
// pages/users/create.server.ts
import { defineHandler } from "void";
import { db } from "void/db";
import * as v from "valibot";

const createUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
});

export const action = defineHandler.withValidator({
  body: createUserSchema,
})(async (c, { body }) => {
  await db.insert("users", body);
  return c.redirect("/users");
});
```

Then, use `useForm` in the page component to submit to this action:

::: code-group

```tsx [React]
// pages/users/create.tsx
import { useForm } from "void/react";

export default function CreateUser() {
  // "/users/create" autocompletes; { name, email } is typed from the action's validator
  const form = useForm("/users/create", { name: "", email: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post();
      }}
    >
      <input value={form.data.name} onChange={(e) => form.setData("name", e.target.value)} />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input value={form.data.email} onChange={(e) => form.setData("email", e.target.value)} />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button disabled={form.processing}>Create</button>
    </form>
  );
}
```

```vue [Vue]
<!-- pages/users/create.vue -->
<script setup lang="ts">
import { useForm } from "void/vue";

// "/users/create" autocompletes; { name, email } is typed from the action's validator
const form = useForm("/users/create", { name: "", email: "" });
</script>

<template>
  <form @submit.prevent="form.post()">
    <input v-model="form.data.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>

    <input v-model="form.data.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>

    <button :disabled="form.processing">Create</button>
  </form>
</template>
```

```svelte [Svelte]
<!-- pages/users/create.svelte -->
<script>
  import { useForm } from "void/svelte";

  // "/users/create" autocompletes; { name, email } is typed from the action's validator
  const form = useForm("/users/create", { name: "", email: "" });
</script>

<form onsubmit={(e) => { e.preventDefault(); form.post(); }}>
  <input bind:value={form.data.name} />
  {#if form.errors.name}<span>{form.errors.name}</span>{/if}

  <input bind:value={form.data.email} />
  {#if form.errors.email}<span>{form.errors.email}</span>{/if}

  <button disabled={form.processing}>Create</button>
</form>
```

```tsx [Solid]
// pages/users/create.tsx
import { useForm } from "void/solid";

export default function CreateUser() {
  // "/users/create" autocompletes; { name, email } is typed from the action's validator
  const form = useForm("/users/create", { name: "", email: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post();
      }}
    >
      <input value={form.data.name} onInput={(e) => form.setData("name", e.target.value)} />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input value={form.data.email} onInput={(e) => form.setData("email", e.target.value)} />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button disabled={form.processing}>Create</button>
    </form>
  );
}
```

:::

The types are inferred from your action's `withValidator()` schema in the companion `.server.ts` file. If no validator is defined, the body type falls back to `Record<string, unknown>` — you still get URL autocomplete either way.

`useForm` returns a reactive object with:

| Property / Method                | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `data` / `setData`               | Current form values, typed to match the action's body schema.  |
| `errors`                         | Field-level validation errors, keys typed to body field names. |
| `post`, `put`, `patch`, `delete` | Submit the form (URL is already bound).                        |
| `processing`                     | `true` while the submission is in flight.                      |
| `isDirty`                        | `true` if form data differs from initial values.               |
| `reset(...fields)`               | Reset form data to initial values. Field names autocomplete.   |
| `clearErrors(...fields)`         | Clear validation errors. Field names autocomplete.             |

For dynamic routes, pass `params` in the options:

```ts
// pages/users/[id].server.ts has an action
const form = useForm("/users/:id", { name: "" }, { params: { id: "42" } });
form.put(); // submits to /users/42
```

### Validation Errors

When an action throws a `ValidationError` (or validation fails via `withValidator`), the errors are automatically available on `form.errors` — no manual error handling needed.

Actions can throw `ValidationError` for custom validation logic:

```ts
import { defineHandler, ValidationError } from "void";

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  if (await emailExists(body.email)) {
    throw new ValidationError({ email: "Email already taken" });
  }
  // ...
});
```

Or use `withValidator()` for automatic schema-based validation — errors are returned in the same format.

## View Transitions

Pages mode supports the browser's native [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) for animated page transitions. When enabled, navigations are wrapped in `document.startViewTransition()`, giving you a smooth cross-fade between pages by default — customizable entirely via CSS.

### Enabling View Transitions

Pass `viewTransitions: true` to the adapter plugin:

::: code-group

```ts [React]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidReact({ viewTransitions: true })],
});
```

```ts [Vue]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidVue({ viewTransitions: true })],
});
```

```ts [Svelte]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidSvelte({ viewTransitions: true })],
});
```

```ts [Solid]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidSolid({ viewTransitions: true })],
});
```

:::

This enables view transitions for all navigations — `Link` clicks, programmatic `router.visit()` calls, and browser back/forward.

### Per-Link Override

Override the global setting on individual links:

::: code-group

```tsx [React]
{
  /* Disable transition for this link */
}
<Link href="/settings" viewTransition={false}>
  Settings
</Link>;

{
  /* Enable for just this link (even if globally disabled) */
}
<Link href="/about" viewTransition>
  About
</Link>;
```

```vue [Vue]
<!-- Disable transition for this link -->
<Link href="/settings" :view-transition="false">Settings</Link>

<!-- Enable for just this link (even if globally disabled) -->
<Link href="/about" view-transition>About</Link>
```

```svelte [Svelte]
<!-- Disable transition for this link -->
<Link href="/settings" viewTransition={false}>Settings</Link>

<!-- Enable for just this link (even if globally disabled) -->
<Link href="/about" viewTransition>About</Link>
```

```tsx [Solid]
{
  /* Disable transition for this link */
}
<Link href="/settings" viewTransition={false}>
  Settings
</Link>;

{
  /* Enable for just this link (even if globally disabled) */
}
<Link href="/about" viewTransition>
  About
</Link>;
```

:::

Or programmatically:

```ts
router.visit("/about", { viewTransition: true });
router.visit("/settings", { viewTransition: false });
```

### Customizing with CSS

The default transition is a cross-fade. Customize it using the `::view-transition-old` and `::view-transition-new` pseudo-elements:

```css
/* Faster transition */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 0.2s;
}

/* Slide instead of fade */
::view-transition-old(root) {
  animation: slide-out 0.3s ease-in;
}
::view-transition-new(root) {
  animation: slide-in 0.3s ease-out;
}
```

Assign `view-transition-name` to elements that should animate independently (e.g., a hero image that morphs between pages):

```css
.hero-image {
  view-transition-name: hero;
}
```

::: tip
View transitions are progressive enhancement — browsers that don't support the API fall back to instant navigation with no errors.
:::
