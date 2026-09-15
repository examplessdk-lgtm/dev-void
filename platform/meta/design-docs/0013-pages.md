# Pages: Inertia-Inspired Full-Stack DX for Void

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Status:** Implemented, but more adapters needed

## Overview

Pages is a new rendering mode for Void that provides an Inertia.js-inspired developer experience: server-driven routing with SPA-like navigation, automatic prop passing from server handlers to page components, form helpers with built-in validation error handling, and full SSR.

The architecture separates a **framework-agnostic core** (protocol, server handling, page resolution) from **framework-specific adapters** (rendering, hydration, client components). Vue is the first adapter; React, Svelte, and Solid follow the same adapter interface.

## Core Concepts

### The Protocol

Pages mode adds an Inertia-style protocol on top of Void's existing Hono-based server:

| Request type      | How detected                          | Server response                                           |
| ----------------- | ------------------------------------- | --------------------------------------------------------- |
| Initial page load | No `X-VoidPages` header               | Full SSR HTML with embedded page object. Client hydrates. |
| SPA navigation    | `X-VoidPages: true` header            | JSON page object. Client swaps component.                 |
| Form submission   | `X-VoidPages: true` + POST/PUT/DELETE | Re-run loader (fresh props) or redirect.                  |

**Page object shape:**

```json
{
  "component": "users/index",
  "props": { "users": [...] },
  "shared": { "auth": { "user": {...} }, "flash": null },
  "url": "/users",
  "errors": null
}
```

### Directory Structure

Pages mode activates when a `pages/` directory exists. It coexists with the existing `routes/` directory for pure JSON API endpoints.

```
project/
  pages/                  # Pages mode (Inertia-style UI)
    layout.vue            # Root layout
    index.vue             # GET /
    users/
      layout.vue          # Nested layout for /users/*
      index.vue           # GET /users
      [id].vue            # GET /users/:id
      create.vue          # GET /users/create
  routes/                 # Pure JSON API endpoints (unchanged)
    api/
      health.ts           # GET /api/health -> JSON
      webhooks.ts         # POST /api/webhooks -> JSON
  middleware/              # Shared across pages and routes
    01.auth.ts
```

File-based routing rules match the existing `routes/` conventions: `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups.

### No Manual SSR Entry

When pages mode is active, the adapter auto-generates the SSR entry and client hydration entry. No `main.ssr.ts` or `main.client.ts` needed.

## Page Anatomy (Vue Example)

```vue
<!-- pages/users/index.vue -->
<script server lang="ts">
import { defineHandler } from 'void';
import { db } from 'void/db';

// loader provides props for this page
export const loader = defineHandler(async (c) => {
  const users = await db.list('users');
  return { users };
});

// action handles mutations — returns nothing = re-run loader with fresh props
export const action = defineHandler.withValidator({ body: createUserSchema })(async (
  c,
  { body },
) => {
  await db.insert('users', body);
  // implicit: re-runs loader, page re-renders with updated user list
});
</script>

<script setup lang="ts">
import { useForm, useShared, Link } from '@void/vue';

type User = {
  id: number;
  name: string;
  email: string;
};
defineProps<{ users: User[] }>();

const { auth, flash } = useShared();

const form = useForm({ name: '', email: '' });
function submit() {
  form.post('/users');
}
</script>

<template>
  <h1>Users</h1>
  <p v-if="flash?.message">{{ flash.message }}</p>

  <ul>
    <li v-for="u in users" :key="u.id">
      <Link :href="`/users/${u.id}`">{{ u.name }}</Link>
    </li>
  </ul>

  <form @submit.prevent="submit">
    <input v-model="form.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>
    <input v-model="form.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>
    <button :disabled="form.processing">Create</button>
  </form>
</template>
```

### Server Handler Rules

The `<script server lang="ts">` block is extracted by the adapter's Vite plugin before the framework's SFC compiler processes the file. It uses the existing `defineHandler` API with Remix-style named exports: `loader` and `action`.

**`loader`:** Handles GET requests. Returns props for the page. Required for any page that needs server data.

**`action`:** Handles all mutations (POST, PUT, PATCH, DELETE). Two return behaviors:

| Returns               | Behavior                                                              |
| --------------------- | --------------------------------------------------------------------- |
| Nothing (void)        | Re-run the page's loader, re-render with fresh props. One round-trip. |
| `c.redirect('/path')` | Navigate to another page. Two round-trips (POST + redirect GET).      |

**Validation errors:** Thrown via `ValidationError` or automatically by `withValidator`. The framework catches the error, re-runs the loader for the current page, and attaches `errors` to the page object. `useForm().errors` picks them up automatically on the client.

### Type Safety

#### Vue: `<script server>` Props Sharing

In Vue SFCs, `<script server>` and `<script setup>` share module scope in `vue-tsc`. This means a `Props` type exported from `<script server>` is directly available in `<script setup>` — no import needed:

```vue
<script server lang="ts">
export type Props = {
  users: User[];
};
export const loader = defineHandler<Props>(async (c) => {
  return { users: await db.list('users') };
});
</script>

<script setup lang="ts">
const props = defineProps<Props>(); // Props is in scope from <script server>
</script>
```

The `defineHandler<Props>` generic constrains the handler return type, and the same `Props` type flows to `defineProps<Props>()` with zero duplication.

#### Companion `.server.ts` Props Pattern

For companion `.server.ts` files (React, or Vue without `<script server>`), the server file exports a `Props` type that the client component imports:

```ts
// pages/users/index.server.ts
export type Props = {
  users: User[];
};
export const loader = defineHandler<Props>(async (c) => {
  return { users: await db.list('users') };
});
```

```tsx
// pages/users/index.tsx
import type { Props } from "./index.server";
export default function UsersPage({ users }: Props) { ... }
```

This is the minimum viable pattern — one `import type` line. Generating a `PagePropsMap` was considered but rejected as it trades a direct import for string-literal indirection, which is arguably worse.

#### `defineHandler<R>` Accepts Response Returns

Handlers often need to return `Response` as an escape hatch (e.g. `c.notFound()`, `c.redirect(...)`). The `defineHandler<R>` signature accepts `R | Response | Promise<R | Response>`, but `__output` carries `Exclude<Awaited<R>, Response>` — Response is stripped from the phantom type so it doesn't pollute typed props:

```ts
export const loader = defineHandler<Props>((c) => {
  const user = findUser(c.req.param('id'));
  if (!user) return c.notFound(); // Response — allowed, stripped from Props
  return { user }; // Props — this is what __output carries
});
```

#### Inline `<script server>` Type Extraction for `PageActionMap`

TypeScript cannot resolve `typeof import(...)` for virtual modules or inline SFC blocks. To enable typed `useForm()` body inference for inline `<script server>` actions, the codegen extracts the block content to a real `.ts` file under `.void/server/` and generates `typeof import(...)` pointing to it.

Relative imports in the extracted content must be rewritten since the generated file lives in a different directory. For example, `import { USERS } from "./_data"` in `pages/users/index.vue` becomes `import { USERS } from "../../../pages/users/_data"` in `.void/server/users/index.server.ts`. The rewriting uses `path.relative()` to compute the correct path from the generated file's location back through the original `pages/` directory.

The generated server files are not listed in `.void/tsconfig.json` — they are resolved transitively via `typeof import(...)` references in `routes.d.ts`.

## Server Handler Files

### Universal Convention: Companion `.server.ts`

Every framework supports companion `.server.ts` files alongside page components:

```
pages/
  users/
    index.vue             # page component
    index.server.ts       # server handler (optional if using <script server>)
```

```ts
// pages/users/index.server.ts
import { defineHandler } from 'void';
import { db } from 'void/db';

export const loader = defineHandler(async (c) => {
  return { users: await db.list('users') };
});

export const action = defineHandler(async (c) => {
  await db.insert('users', await c.req.json());
});
```

This is the **only** option for React, Svelte, and Solid pages (no SFC custom blocks). For Vue, both `<script server>` and companion `.server.ts` are supported — companion `.server.ts` takes precedence if both exist.

### React Example

```
pages/
  users/
    index.tsx             # page component
    index.server.ts       # server handler
```

```tsx
// pages/users/index.tsx
import { useForm, useShared, Link } from '@void/react';

export default function UsersPage({ users }: { users: User[] }) {
  const { auth } = useShared();
  const form = useForm({ name: '', email: '' });

  return (
    <div>
      <ul>
        {users.map((u) => (
          <li key={u.id}>
            <Link href={`/users/${u.id}`}>{u.name}</Link>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.post('/users');
        }}
      >
        <input value={form.name} onChange={(e) => form.setData('name', e.target.value)} />
        {form.errors.name && <span>{form.errors.name}</span>}
        <button disabled={form.processing}>Create</button>
      </form>
    </div>
  );
}
```

## Layouts

Layout files use the `layout.{vue,tsx,svelte}` naming convention in any `pages/` subdirectory.

```
pages/
  layout.vue              # root layout (nav, footer)
  index.vue
  users/
    layout.vue            # nested layout for /users/*
    index.vue
    [id].vue
  admin/
    layout.vue            # admin layout
    index.vue
```

```vue
<!-- pages/layout.vue -->
<script setup>
import { useShared, Link } from '@void/vue';
const { auth } = useShared();
</script>

<template>
  <nav>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <span v-if="auth.user">{{ auth.user.name }}</span>
  </nav>
  <main>
    <slot />
  </main>
</template>
```

**Rules:**

- Layouts **persist across navigations** within their subtree (component state preserved)
- Nested layouts wrap: root `layout.vue` > `users/layout.vue` > page component
- Layouts render client-side only — they access shared data via `useShared()`, not server handlers
- Layouts do **not** have `<script server>` blocks

## Shared Data

Middleware injects shared data available on every page via `c.set('shared', {...})`:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  const user = await getSessionUser(c);
  c.set('shared', {
    auth: { user },
    flash: getFlash(c),
  });
  await next();
});
```

Client-side access via `useShared()`:

```vue
<script setup>
import { useShared } from '@void/vue';
const { auth, flash } = useShared();
</script>
```

Shared data is merged into every page object response. It is separate from page props — `defineProps` receives page-specific data, `useShared()` receives global data.

## Client-Side API

Each framework adapter exports:

| Export              | Purpose                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Link`              | Component. Renders `<a>`, intercepts clicks for Inertia-style navigation. Props: `href`, `method`, `data`, `preserveScroll`. |
| `useForm(defaults)` | Reactive form helper. Returns `{ data, post, put, patch, delete, processing, errors, isDirty, reset, clearErrors }`.         |
| `useShared()`       | Returns shared data from middleware.                                                                                         |
| `router`            | Programmatic navigation: `router.visit(url)`, `router.post(url, data)`, `router.reload()` (re-fetch current page props).     |

## Server-Side Flow

### Initial Request (GET /users, no X-VoidPages header)

1. Run middleware chain -> `c.set('shared', {...})`
2. Resolve page: URL -> `pages/users/index.vue`
3. Run page's `loader` -> props
4. Resolve layout chain: `layout.vue` > `users/layout.vue`
5. SSR render: layouts wrapping page component with props + shared data
6. Return HTML with `<div id="app" data-page='{ component, props, shared, url }'>`
7. Client hydrates

### Inertia Navigation (GET /users, X-VoidPages: true)

1. Run middleware chain -> shared data
2. Run page's `loader` -> props
3. Return JSON: `{ component: "users/index", props, shared, url }`
4. Client swaps page component, persists layouts if in same subtree

### Form Submission (POST /users, X-VoidPages: true)

1. Run middleware chain
2. Run page's `action`
3. If `ValidationError` thrown -> re-run `loader`, return page object with `errors` attached
4. If action returns nothing -> re-run `loader`, return page object with fresh props
5. If action returns redirect -> return redirect, client follows as Inertia GET

## Architecture: Core vs Adapters

### Core (`void` package)

Framework-agnostic. Handles:

- Page object protocol (format, headers, request detection)
- `pages/` directory scanning and file-based route resolution
- Companion `.server.ts` file loading
- Middleware execution and shared data collection
- Handler execution (props / redirect / re-run loader)
- Validation error catching and attachment
- Layout tree resolution from directory structure
- Page object serialization

### Framework Adapter (separate package, e.g. `@void/vue`)

Each adapter is a Vite plugin + runtime library. The adapter:

- Includes the framework's Vite plugin as a dependency (e.g. `@vitejs/plugin-vue`)
- Provides framework-specific SFC compilation (e.g. `<script server>` extraction for Vue)
- Generates SSR entry and client hydration entry
- Handles SSR rendering (`renderToString`)
- Handles client-side page mounting, swapping, and layout persistence
- Exports `Link`, `useForm`, `useShared`, `router`

### Plugin Ordering

#### Vue: 3 Plugins

The Vue adapter's Vite plugin must extract `<script server>` **before** the framework plugin compiles the SFC:

```ts
// @void/vue/plugin internals
import vue from '@vitejs/plugin-vue';

export function voidVue(options?) {
  return [
    scriptServerPlugin(), // extract <script server> first
    vue(options?.vue), // then compile the remaining SFC
    pagesPlugin(), // generate SSR + hydration entries
  ];
}
```

#### React: 2 Plugins

React has no SFC custom blocks, so no `scriptServerPlugin` is needed. Only companion `.server.ts` files are supported:

```ts
// @void/react/plugin internals
import react from '@vitejs/plugin-react';

export function voidReact(options?) {
  return [
    react(options?.react), // JSX transform
    pagesPlugin(), // generate SSR + hydration entries
  ];
}
```

### User Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidVue } from '@void/vue/plugin';

export default defineConfig({
  plugins: [voidPlugin(), ...voidVue()],
});
```

`voidVue()` returns an array of three plugins (scriptServer, vue, pages) — spread it into the plugins array.

### Adapter Interface (As Implemented)

Each framework adapter provides:

1. **Vite plugins** via a factory function (e.g. `voidVue()`) returning an array of plugins
2. **SSR renderer** via `virtual:void-pages-renderer` — exports `renderPage(pageObj, assetTags)` that SSR-renders the page with layout wrapping and returns full HTML
3. **Client hydration entry** via `virtual:void-pages-client` — hydrates the SSR HTML, sets up the client router, and handles SPA navigation
4. **Runtime exports** via the `/runtime` subpath — `Link`, `useForm`, `useShared` composables/components

The SSR renderer and client entry are generated as virtual modules by the adapter's `pagesPlugin`. They use a component manifest (mapping component IDs to dynamic imports) and a layout tree (mapping component IDs to their ancestor layout IDs) generated from the page scan results.

## Implementation Details

### Route Compilation: `notFound` vs `get("*")`

The page catch-all route uses `app.notFound()` instead of `app.get("*")`. In dev mode, `get("*")` intercepts ALL GET requests including Vite's module pipeline requests (e.g. `/pages/index.vue`, `/@vite/client`), breaking HMR and component loading. `notFound()` only fires when no other handler matches, allowing Vite's middleware to serve source files.

### `run_worker_first` Exclusions for Dev

When pages mode is active, `run_worker_first` must exclude `/pages/*` in addition to the standard `!/@*`, `!/src/*`, `!/node_modules/*`. Without this, module requests for `.vue` files go to the worker first, which returns 404 instead of letting Vite serve them.

### Production Asset Serving

Static assets (`/assets/*`) are excluded from `run_worker_first` so Cloudflare serves them directly from the edge/CDN without invoking the worker. The `notFound` handler also has a fallback to `env.ASSETS.fetch(c.req.raw)` for any other file-extension paths that slip through (e.g. `/favicon.ico`), mirroring the existing SSR codepath's `fetchFromAssets()` pattern.

### Rolldown Hook Filters

All `transform`, `resolveId`, and `load` hooks in adapter plugins use declarative `filter` objects instead of early-return guards. This lets Rolldown evaluate conditions in Rust before crossing the FFI boundary into JavaScript, avoiding unnecessary JS invocations. For example, a `transform` hook can use `filter: { id: { include: /\.vue$/, exclude: /node_modules/ }, code: /<script\s+server\b/ }` — Rolldown skips any module that doesn't match both conditions without ever calling into JS. Dynamic checks (like `id.startsWith(pagesDir)`) that depend on runtime state remain in the handler. All adapter plugins should follow this pattern.

### Source Map Preservation in `<script server>` Stripping

When stripping the `<script server>` block, the adapter plugin replaces the matched text with an equivalent number of newlines (`"\n".repeat(lines - 1)`) rather than an empty string. This preserves line positions for all code after the block, so downstream plugins (SFC compilers, JSX transforms, etc.) see correct line numbers. The transform returns `map: { mappings: "" }` to signal an identity mapping — no position changes relative to the input. Every adapter that extracts `<script server>` blocks must use this technique.

### Client Entry: Virtual Module URL in `<script>` Tags

Browser-facing `<script src>` tags cannot use Vite's `\0`-prefixed virtual module IDs directly. The client entry script tag uses `/@id/__x00__virtual:void-pages-client` — Vite's URL-based virtual module resolution format.

### Client-Side Page Updates Must Be Atomic

The client entry must resolve all async work (component loading, layout resolution) via `Promise.all` before updating any reactive state. Setting reactive state across multiple `await` boundaries allows the framework to flush a render between the awaits, causing the new component to render with stale props. The fix: resolve all async work first, then update props → layouts → component synchronously in a single microtask. Props must be set BEFORE the component ref — if the component changes first, the framework renders the new component with stale props from the previous page.

### No Global Click Interceptor — Use `Link` Component

The client entry does NOT include a global `document.addEventListener("click")` interceptor for `<a>` tags. Instead, SPA navigation is handled exclusively by the `Link` component. A global interceptor conflicts with `Link` — both fire `router.visit()` on the same click event, causing double navigation. The `Link` component already handles modifier keys, external URLs, and non-GET methods correctly.

### SSR Context Must Be Complete

During SSR rendering, the app must provide all context keys that components may read (shared data, errors, router), even if the value is `null`. Runtime composables (`useForm`, `Link`) must accept a missing context gracefully (e.g. default to `null`) to avoid framework warnings during SSR when client-only context like the router is unavailable.

## Pitfalls

### Reactive State Update Atomicity

**Problem:** Multiple `await`s between reactive state assignments in the same function:

```js
// BAD — framework flushes renders between the two awaits
currentComponent.value = await resolveComponent(data.component);
currentLayouts.value = await resolveLayouts(data.component); // render happens here!
currentProps.value = data.props; // Too late — component already rendered with old props
```

**Fix:** Resolve all async work first, then batch-update state:

```js
// GOOD — all state updated synchronously after async work completes
const [comp, layouts] = await Promise.all([
  resolveComponent(data.component),
  resolveLayouts(data.component),
]);
currentProps.value = data.props;
currentLayouts.value = layouts;
currentComponent.value = comp;
```

**Rule:** Set props BEFORE component. If the component ref changes, the framework's next render sees the new component. If props haven't been updated yet, the new component renders with stale props from the previous page. This applies to any reactive framework (Vue refs, React state, Svelte stores, Solid signals).

### `app.get("*")` Blocks Vite Dev Server

**Problem:** Hono's `app.get("*", handler)` matches ALL GET requests, not just user-facing navigation. This intercepts Vite's module requests (`/pages/index.vue`, `/@vite/client`, `/node_modules/.vite/deps/vue.js`), returning HTML or 404 instead of JavaScript modules.

**Fix:** Use `app.notFound(handler)` which only fires when no other Hono route or Vite middleware handles the request.

### Worker Catches Static Asset Requests in Production

**Problem:** With `run_worker_first: ["/**"]` and no exclusions, ALL requests go to the worker, including requests for JS/CSS bundles in `/assets/`. This is both slow (unnecessary worker invocation) and broken if the `notFound` handler returns a plain 404.

**Fix:** Exclude `/assets/*` from `run_worker_first` so Cloudflare serves hashed assets directly from the edge. Additionally, the `notFound` handler calls `env.ASSETS.fetch(c.req.raw)` for any remaining file-extension paths as a fallback.

### No JSX in Virtual Modules

**Problem:** Virtual modules with `\0`-prefixed IDs (e.g. `\0virtual:void-pages-renderer`) are not processed by `@vitejs/plugin-react`. Writing JSX in the generated code produces syntax errors at runtime.

**Fix:** Use `React.createElement()` calls instead of JSX in all generated virtual module code. For example:

```js
// BAD — JSX is not transformed in virtual modules
return (
  <Layout>
    <Page {...props} />
  </Layout>
);

// GOOD — explicit createElement calls
return createElement(Layout, null, createElement(Page, props));
```

This applies to both the SSR renderer and client hydration entry virtual modules.

### React Client State: `useSyncExternalStore`

The React client entry uses a module-level store with `useSyncExternalStore` for page state management (current component, props, layouts, shared, errors). This is cleaner than `useState` for state that lives outside the React tree and integrates properly with React's concurrent features. The pattern:

```js
let state = { component, props, layouts, shared, errors };
const listeners = new Set();
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot() {
  return state;
}
function setState(partial) {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}

// In App component:
const snap = useSyncExternalStore(subscribe, getSnapshot);
```

### React View Transitions Require `flushSync`

**Problem:** `document.startViewTransition(callback)` expects the DOM to update synchronously within the callback. React batches state updates by default, so calling `setState` inside the callback doesn't immediately flush to the DOM.

**Fix:** Wrap state updates in `flushSync` from `react-dom`:

```js
document.startViewTransition(() => {
  flushSync(() => setState({ component, props, layouts, shared, errors }));
});
```

Vue uses `nextTick()` instead — different mechanism, same purpose.

### Bare Module Specifiers in Inline `<script>` Tags

**Problem:** Inline `<script type="module">import "virtual:foo";</script>` in SSR-generated HTML doesn't work — browsers don't resolve bare module specifiers, and Vite's import rewriting only processes files served through its module pipeline.

**Fix:** Either use `<script type="module" src="/@id/__x00__virtual:foo">` (served through Vite) or don't inject inline module scripts in SSR HTML.

### Extracted Server Files Need Import Rewriting

**Problem:** When extracting `<script server>` content to `.void/server/<path>.server.ts`, relative imports like `from "./_data"` resolve incorrectly because the generated file is in a different directory than the original SFC.

**Fix:** Rewrite all relative import specifiers (`./foo`, `../bar`) using `path.relative()` to compute the correct path from the generated file's location (`<outDir>/server/<dir>/`) back to the original source directory (`<pagesDir>/<dir>/`). Non-relative imports (bare specifiers like `"void"`) are left untouched.

### `defineHandler<R>` Must Allow Response Without Polluting Output

**Problem:** Handlers that conditionally return `Response` (via `c.notFound()`, `c.redirect()`) alongside the typed return `R` cause `__output` to include `Response`, making the inferred props type `Props | Response`.

**Fix:** The handler signature is `(c: CloudContext) => R | Response | Promise<R | Response>`, but `__output` is `Exclude<Awaited<R>, Response>`. Response is always allowed as an escape hatch but is stripped from the type-level output that flows to page props and `PageActionMap`.

## Debugging Techniques

### Browser Console Forwarding

For debugging client-side issues during development, [vite-console-forward-plugin](https://github.com/mitsuhiko/vite-console-forward-plugin) forwards browser console output to the terminal. Note: its `transformIndexHtml` hook does NOT fire for SSR-generated HTML — you must manually inject `<script type="module" src="/@id/__x00__virtual:console-forward">` into the SSR head tags. The plugin's endpoint must also use a `/@`-prefixed path (e.g. `/@console-forward`) to bypass `run_worker_first` routing.

### Headless Playwright for Client-Side Bug Reproduction

For systematic client-side debugging (hydration crashes, stale props, navigation bugs), use Playwright in headless mode:

```js
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('console', (msg) => console.log(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => console.log(`[ERROR] ${err.message}`));

await page.goto('http://localhost:5173/');
await page.click('a[href="/users"]');
// Check URL, content, and console for warnings
```

This captures framework warnings, hydration errors, and JavaScript exceptions that only appear in the browser — not in server logs. Run the script from the monorepo root (where `playwright` is installed).

### Isolating Dev vs Production Bugs

If something works in `vite dev` but breaks in `vite preview`:

1. Check `run_worker_first` patterns — dev exclusions like `!/pages/*` are irrelevant in production since those paths don't exist
2. Check the `notFound` handler — it must fall through to `env.ASSETS.fetch()` for static files
3. Check virtual module URLs — dev uses `/@id/__x00__` prefix, production uses hashed filenames from the manifest

If something works in `vite preview` but breaks in `vite dev`:

1. Check that `run_worker_first` excludes source directories (`!/pages/*`, `!/src/*`)
2. Check that Hono routes don't intercept Vite middleware requests (use `notFound` instead of `get("*")`)
3. Check that virtual module script tags use `/@id/__x00__` prefix for browser-facing URLs

## What This Does NOT Include

- **Partial reloads** (Inertia's `only` / `except` for selective prop fetching) — can be added later
- **Link prefetching** (prefetch on hover) — can be added later
- **View transitions API** integration — implemented via `viewTransitions` option in adapter config and `viewTransition` prop on `Link`
- **Asset versioning** (409 + full reload on bundle changes) — can be added later
- **Flash data helpers** — flash messages work via shared data, no special API needed initially
