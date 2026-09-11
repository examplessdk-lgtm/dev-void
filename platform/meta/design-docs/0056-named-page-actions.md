---
title: Named Page Actions
status: draft
created: 2026-03-07
depends: [0016-typed-useform, 0013-pages]
---

# Named Page Actions

**Status:** Draft

## Summary

Allow pages to export multiple named actions via an `actions` object, each with its own validator and body type. This replaces the current `intent` field workaround where multiple mutations on a single page share one payload type and lose per-mutation type safety.

## Problem

A page currently exports a single `action` in its `.server.ts`. When a page needs multiple mutations (create, update, delete), they're differentiated via a manual `intent` field:

```ts
// pages/index.server.ts (current workaround)
export const action = defineHandler(async (c) => {
  const body = await c.req.json<{
    intent: string;
    name?: string;
    email?: string;
    id?: number;
  }>();

  if (body.intent === 'create-user') {
    /* ... */
  } else if (body.intent === 'delete-user') {
    /* ... */
  }
});
```

All intents share the same payload type. No per-intent validation. No typed errors per mutation. The type safety pipeline — which flows from Drizzle schema through validators to `useForm` — breaks at the action boundary.

## Design

### Declaring Named Actions

Pages export an `actions` object (plural) instead of a single `action`:

```ts
// pages/users/edit.server.ts
import { defineHandler } from 'void';
import { db } from 'void/db';
import { users, updateUserSchema } from '@schema';
import { z } from 'zod';

export const actions = {
  update: defineHandler.withValidator({
    body: updateUserSchema,
  })(async (c, { body }) => {
    await db
      .update(users)
      .set(body)
      .where(eq(users.id, c.req.param('id')));
  }),

  delete: defineHandler.withValidator({
    body: z.object({ id: z.string() }),
  })(async (c, { body }) => {
    await db.delete(users).where(eq(users.id, body.id));
  }),
};
```

Single `export const action` continues to work unchanged. Exporting both `action` and `actions` from the same page is a codegen-time error.

### URL Convention

Named actions use a `?name` suffix on the page URL:

```
/users/edit?update
/users/edit?delete
/users/:id?update
```

The `?` separates the page path from the action name. At runtime, the action name is transmitted as a query parameter on the POST request: `POST /users/42?delete`. No `/` separator after `?` (unlike SvelteKit's `?/action` convention) — the type system enforces valid action names, so there's no ambiguity with real query parameters.

### Three Consumption Modes

Named actions (and single actions) are consumed through three primitives, each serving a different use case:

```ts
// 1. useForm — form state, errors, dirty tracking + Inertia page update
import { useForm } from '@void/vue';
const form = useForm('/users/:id?update', { name: '', email: '' }, { params: { id } });
form.errors.email; // typed from updateUserSchema
form.put();

// 2. action() — one-shot programmatic call + Inertia page update
import { action } from '@void/vue';
await action('/users/:id?delete', { id: '42' });

// 3. fetch — raw HTTP, no Inertia, framework-agnostic
import { fetch } from 'void/client';
await fetch('/users/:id?delete', { method: 'POST', body: { id: '42' } });
```

| Primitive  | Inertia page update | Form state                 | Framework-specific |
| ---------- | ------------------- | -------------------------- | ------------------ |
| `useForm`  | Yes                 | Yes (errors, dirty, reset) | Yes                |
| `action()` | Yes                 | No                         | Yes                |
| `fetch()`  | No (raw response)   | No                         | No                 |

`useForm` and `action()` are exported from each adapter (`@void/vue`, `@void/react`, `@void/svelte`, `@void/solid`). `fetch` is from `void/client` and is framework-agnostic.

Both `useForm` and `action()` can target any page's actions, not just the current page's. The Inertia response from the server determines what page the user ends up on (same page with fresh props, or a redirect).

`fetch` can also target page action URLs — they're added to the RouteMap alongside API routes. This means page actions are reusable endpoints callable from anywhere.

### Type Generation

The codegen does **not** parse source files for action keys. It references the `actions` export as a whole and lets TypeScript resolve individual keys.

**Current** (single action):

```ts
// Generated .void/routes.d.ts
interface PageActionMap {
  '/users/:id': {
    body: ExtractInput<
      (typeof import('./pages/users/[id].server'))['action']['__validators']
    > extends { body: infer B }
      ? B
      : Record<string, unknown>;
    params: { id: string };
  };
}
```

**Named actions** — reference the entire `actions` export:

```ts
interface PageActionMap {
  '/users/:id': {
    actions: (typeof import('./pages/users/[id].server'))['actions'];
    params: { id: string };
  };
}
```

Consumer types (`useForm`, `action()`, `fetch`) parse the `?name` suffix via template literal types and resolve the per-action body type:

```ts
type ParseAction<U> = U extends `${infer Base}?${infer Action}`
  ? { base: Base; action: Action }
  : { base: U; action: never };

type FormBody<U> = ParseAction<U>['action'] extends never
  ? PageActionMap[ParseAction<U>['base']]['body'] // single action
  : ExtractInput<
        PageActionMap[ParseAction<U>['base']]['actions'][ParseAction<U>['action']]['__validators']
      > extends { body: infer B }
    ? B
    : Record<string, unknown>; // named action
```

The codegen only needs to detect whether the page exports `action` (singular) vs `actions` (plural) — which is an export name check, same as the existing detection for `loader` vs `action`.

### `action()` Helper

Each adapter exports an `action()` function for one-shot programmatic calls that go through the Inertia router (page updates, redirects) without form state:

```ts
// @void/vue
export async function action<U extends keyof PageActionMap & string>(
  url: U,
  data?: FormBody<U>,
  options?: ActionOptions<U>,
): Promise<void> {
  const resolvedUrl = resolveParams(url, options?.params);
  await router.visit(resolvedUrl, { method: 'POST', data });
}
```

`action()` accesses the router instance at module level (set during app initialization), not via `inject`/`useContext`. This is necessary because `action()` is called from event handlers, not during component setup.

### Runtime Dispatch

The server-side pages handler currently calls the single `action` export. With named actions:

1. Check if the page module exports `actions` (plural)
2. Extract the action name from the request URL's query string
3. Look up `actions[name]` and call it
4. If no action name in the query string, call `actions.default` if it exists
5. Fall back to `action` (singular) export for backward compat
6. 404 if the action name doesn't match any key

### Default Action

If a page needs a default action alongside named ones, use the `"default"` key:

```ts
export const actions = {
  default: defineHandler(...),  // useForm("/users/edit", data) — no ?suffix
  update: defineHandler(...),   // useForm("/users/edit?update", data)
  delete: defineHandler(...),   // useForm("/users/edit?delete", data)
};
```

`useForm("/path", data)` with no `?` suffix maps to `actions.default`.

## Backward Compatibility

| Export                                    | `useForm` URL  | Behavior                                    |
| ----------------------------------------- | -------------- | ------------------------------------------- |
| `export const action`                     | `"/path"`      | Unchanged. Single action, single body type. |
| `export const actions`                    | `"/path?name"` | Per-key dispatch, per-key types.            |
| `export const actions` with `default` key | `"/path"`      | Default action, no suffix needed.           |
| Both `action` and `actions`               | —              | Codegen error with clear message.           |

## Edge Cases

1. **Dynamic params + action name** — `/users/:id?delete` requires parsing both. The `?` split happens first to extract the action name, then param segments are resolved on the base path.

2. **Query parameters vs action name** — Page actions receive data via request body (POST), not query params. The only query param is the action name itself. If `fetch` targets `/users/42?delete`, the `?delete` is unambiguously the action name. No collision with real query parameters.

3. **Cross-page calls** — `fetch("/other-page?action", { method: "POST", body })` works. `action("/other-page?name", data)` also works and triggers Inertia navigation to wherever the action redirects.

4. **File uploads** — Named actions are `defineHandler` instances. File upload detection (auto `multipart/form-data`) works per-action with no changes.

5. **Validation errors** — Each named action has its own validator, so `useForm` errors are scoped to that action's body schema. The existing error bridging mechanism (reading `pageData.errors` from the Inertia response) works unchanged.

6. **Static analysis of `actions` keys** — The codegen does not enumerate keys. TypeScript resolves them from `typeof import(...)["actions"]`. However, the `actions` export must be a static object literal — computed keys or spread patterns would break TypeScript's ability to infer the type. This matches how `export const action` already requires a static `defineHandler` call.

## Prior Art

| Framework              | Approach                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| SvelteKit              | `export const actions = { default, update, delete }` with `?/actionName` URL convention    |
| ASP.NET Razor Pages    | Named handlers (`OnPostDelete`, `OnPostUpdate`) dispatched via `?handler=Name` query param |
| Phoenix LiveView       | Named event handlers (`handle_event("save", params, socket)`)                              |
| Remix / React Router   | Single `action` export, `intent` field workaround (the problem we're solving)              |
| Next.js Server Actions | Standalone `"use server"` functions, referenced by identity                                |
