# @void/react

React adapter for Void Pages mode.

## Setup

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
- `useNavigation()`
- `useShared()`
- `useForm()`
- `useIslandForm()`
- `action()`

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
- `test/integration/react-pages-client.test.ts`

Cross-package SSR/protocol coverage for React pages mode also lives in `framework/packages/void/test/integration/*`.
