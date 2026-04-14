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
- `useNavigation()`
- `useShared()`
- `useForm()`
- `useIslandForm()`
- `action()`

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

## Tests

- `test/unit/use-form.test.ts`
- `test/integration/solid-pages-playground.test.ts`

The Solid integration test covers both SSR output and browser-side navigation/forms.
