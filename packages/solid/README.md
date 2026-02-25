# @void-x/solid

SolidJS framework adapter for Void Pages mode — Inertia-inspired full-stack DX with SSR.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSolid } from "@void-x/solid";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

## Plugin

`voidSolid(options?)` returns `[vite-plugin-solid, pagesPlugin]`.

Options:

- `solid?` — options passed to `vite-plugin-solid`
- `viewTransitions?` — enable View Transitions API for SPA navigation

The pages plugin generates two virtual modules:

- `virtual:void-pages-renderer` — SSR entry using `renderToStringAsync()` from `solid-js/web`
- `virtual:void-pages-client` — client hydration entry using `hydrate()` from `solid-js/web`

## Runtime

Import from `void/solid`:

- **`Link`** — SPA navigation component. Renders `<a>` for GET, `<button>` otherwise. Intercepts clicks for client-side navigation.
- **`useForm(url, defaults, options?)`** — Form state management using `createStore` from `solid-js/store` and `createSignal`. Methods: `post`, `put`, `patch`, `delete`, `reset`, `clearErrors`.
- **`useShared()`** — Access shared data from middleware (`c.set("shared", ...)`)
- **`useRouter()`** — Access the router for programmatic navigation

## Pages

Pages are `.tsx` files in the `pages/` directory with companion `.server.ts` files:

```tsx
// pages/index.tsx
export default function Home(props: { title: string }) {
  return <h1>{props.title}</h1>;
}
```

```ts
// pages/index.server.ts
import { defineHandler } from "void";

export const loader = defineHandler(() => {
  return { title: "Home" };
});
```

## Architecture

- **Runtime ships as source** — `.tsx` and `.ts` files are compiled by the consumer's `vite-plugin-solid` at dev/build time. The plugin entry (`./plugin`) is pre-built with tsdown.
- **Signals + Context for client state** — `createSignal` and `createStore` drive page/props/shared/errors updates. `createContext`/`useContext` provides values to child components.
- **Context providers must wrap evaluation** — Solid's `createComponent()` invokes functions immediately (unlike React's lazy JSX descriptors). Layout chains are built inside provider `children` getters so contexts are available when components evaluate.

## Tests

- `test/unit/use-form.test.ts` — 14 tests for form core logic
- `test/integration/solid-pages-playground.test.ts` — Server-side SSR + Inertia protocol tests
