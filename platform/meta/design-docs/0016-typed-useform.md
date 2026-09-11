# Typed `useForm()` via Generated Route Types

**Status:** Implemented

## Overview

Make `useForm()` type-safe by generating a `PageActionMap` from page action validators and adding a URL-first overload that provides autocomplete, body validation, and typed errors.

## Design

### Type Generation: `PageActionMap`

Extend `routes.d.ts` generation to include a `PageActionMap` interface alongside the existing `RouteMap`. All pages with actions get entries — not just those with validators.

```typescript
// .void/routes.d.ts (generated)
export {};
declare module 'void/routes' {
  // Existing — API routes
  interface RouteMap {
    '/api/users': { GET: { input: {}; output: User[] } };
  }

  // New — page actions
  interface PageActionMap {
    '/users': {
      body: { name: string; email: string }; // from withValidator({ body: schema })
    };
    '/users/:id': {
      body: { name: string };
      params: { id: string };
    };
    '/settings': {
      body: Record<string, unknown>; // action exists but no validator
    };
  }
}
```

**Rules:**

- All pages with actions get entries (enables URL autocomplete even without validators)
- `body` type extracted from `withValidator({ body: schema })` via existing `__validators` machinery
- Actions without validators get `body: Record<string, unknown>`
- `params` included when route has dynamic segments (`:id`, `:slug`, etc.)
- Only `body` validator is relevant — `query`/`params` validators are ignored for form typing

### `useForm` API: URL-First Overload

Two overloads — typed (URL-first) and untyped (backward compatible):

```typescript
// Typed: bound to a specific page route
function useForm<U extends keyof PageActionMap>(
  url: U,
  defaults: PageActionMap[U]['body'],
  options?: { params: PageActionMap[U] extends { params: infer P } ? P : never },
): TypedForm<PageActionMap[U]>;

// Untyped: backward compatible
function useForm<T extends Record<string, unknown>>(defaults: T): Form<T>;
```

**Usage examples:**

```typescript
// Static route — full typing
const form = useForm('/users', { name: '', email: '' });
form.post(); // posts to "/users"
form.errors.name; // string | undefined
form.errors.foo; // TS error

// Dynamic route — params resolve at runtime
const form = useForm('/users/:id', { name: '' }, { params: { id: String(props.user.id) } });
form.post(); // posts to "/users/123"

// Untyped — backward compatible
const form = useForm({ name: '', email: '' });
form.post('/users'); // explicit URL, no type narrowing
```

### Typed Form Return Type

```typescript
type TypedForm<A extends { body: Record<string, unknown> }> = {
  // Reactive data fields (existing behavior, spread onto form object)
  [K in keyof A["body"]]: A["body"][K];

  // Errors narrowed to body field keys
  errors: Partial<Record<keyof A["body"] & string, string>>;

  // Submit methods — URL already bound, no arg needed
  post(opts?: SubmitOptions): void;
  put(opts?: SubmitOptions): void;
  patch(opts?: SubmitOptions): void;
  delete(opts?: SubmitOptions): void;

  // Existing helpers — field args narrowed
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  reset(...fields: (keyof A["body"] & string)[]): void;
  clearErrors(...fields: (keyof A["body"] & string)[]): void;
};
```

For pages without validators (`body: Record<string, unknown>`), errors falls back to `Partial<Record<string, string>>` — no regression from current behavior.

### Dynamic Route Param Resolution

For routes with dynamic segments, params are passed as a third argument and resolved at runtime by replacing `:segment` placeholders:

```typescript
useForm('/users/:id', defaults, { params: { id: '123' } });
// Runtime: posts to "/users/123"
```

This is consistent with the typed `fetch()` client which uses the same `params` pattern.

The `params` option is required (via conditional types) when the route has dynamic segments, and omitted/forbidden for static routes.

## React Adapter

React's `useForm` follows the same URL-first typed overload pattern, with React-specific idioms:

```tsx
const form = useForm("/users", { name: "", email: "" });

// React: explicit setData (no reactive proxy)
<input value={form.data.name} onChange={(e) => form.setData("name", e.target.value)} />

// Vue: reactive proxy, direct v-model
<input v-model="form.name" />
```

Key differences:

- `form.data.field` for reads + `form.setData("field", value)` for writes (React has no Vue-style reactive proxy)
- `isDirty` computed via `useMemo` comparing current data to defaults
- Submit methods (`post`, `put`, `patch`, `delete`) call `router.visit()` from `RouterContext`
- Same `recentlySuccessful` 2-second timeout pattern as Vue

## Files Changed

| File                                       | Change                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| `packages/void/src/codegen/route-types.ts` | Generate `PageActionMap` entries from page action handlers |
| `packages/void/src/runtime/routes-stub.ts` | Add empty `PageActionMap` interface stub                   |
| `packages/vue/src/runtime/use-form.ts`     | Add URL-first overload, runtime param resolution           |
| `packages/vue/src/index.ts`                | Re-export updated `useForm` types                          |
| `packages/react/src/runtime/use-form.ts`   | React useForm with URL-first overload + setData API        |

## Edge Cases

- **No `pages/` directory**: `PageActionMap` is empty — typed overload has no valid URLs, untyped overload still works
- **Action without validator**: Entry generated with `body: Record<string, unknown>` — URL autocompletes, body/errors unnarrowed
- **Multiple validators** (body + query): Only `body` extracted for `PageActionMap`
- **`defineHandler<R>` with Response returns**: `__output` carries `Exclude<Awaited<R>, Response>` — Response is stripped so it doesn't pollute `PageActionMap` body types

## Pitfalls

### Inline `<script server>` Requires Server File Extraction

**Problem:** `typeof import(...)` in `PageActionMap` entries cannot resolve inline `<script server>` blocks — TypeScript needs a real file on disk to resolve imports.

**Previous behavior:** Inline `<script server>` actions fell back to `body: Record<string, unknown>`, losing all type inference for `useForm()`.

**Fix:** During `generateRouteTypes`, the codegen extracts inline `<script server>` content to real `.ts` files under `.void/server/` (e.g. `.void/server/users/index.server.ts`). The `PageActionMap` entry then uses `typeof import("./server/users/index.server")["action"]` which TypeScript can resolve.

**Relative import rewriting:** The extracted files live in a different directory than the original SFC. Relative imports (e.g. `from "./_data"`) must be rewritten using `path.relative()` to resolve from the generated file's location back through the original `pages/` directory. Non-relative imports (bare specifiers like `"void"`) are left untouched.

**Result:** Both `<script server>` and `.server.ts` now produce fully typed `PageActionMap` entries — the codegen handles both uniformly via `typeof import(...)`.

### Companion `.server.ts` Takes Precedence

If both a companion `.server.ts` file and an inline `<script server>` block exist, the companion file takes precedence (consistent with page scanning behavior). The codegen only extracts inline content when no companion file exists.
