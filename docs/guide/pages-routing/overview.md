---
outline: deep
---

# Pages Routing

Pages routing provides the server-rendered, components-as-pages, collocated-data-loading routing system that is seen in many existing JavaScript meta frameworks. However, pages routing in Void is different from most in that it is **rendering framework agnostic.** It is built on patterns inspired by [Inertia.js](https://inertiajs.com/): The server returns the data, and the component receives it as props. The client-side routing logic is minimal, allowing Void to support any rendering framework Vite can support. Today, React, Vue, Svelte, and Solid have first-party adapters.

Pages mode activates when a `pages/` directory exists. It coexists with `routes/` — use `pages/` for UI pages and `routes/` for APIs. Components in `pages/` will be server-rendered, which means **they will run in both Cloudflare Workers and browsers**.

Pages mode is also entirely optional - you can use any client-side router to build a pure client-side SPA that interacts with the backend API via the [typed fetch](../typed-fetch.md) utility.

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

## Directory Structure

Pages can be flat files (`about.vue`) or use directory-based routing (`about/index.vue`) — both map to the same route:

<PagesFileTree />

Each page can have a companion `.server.ts` file that runs exclusively on the server. It can export:

- A [**loader**](./loaders) — runs on GET, returns data that becomes the page component's props
- [**Actions**](./actions-and-forms) — handle mutations (POST, PUT, PATCH, DELETE) from forms and programmatic calls. Export a single `action` or multiple [named actions](./actions-and-forms#named-actions) for pages with several mutations

File-based routing rules are the same as [server routing](../server-routing.md): `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups.

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
