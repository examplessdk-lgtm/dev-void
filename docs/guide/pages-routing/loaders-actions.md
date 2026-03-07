---
outline: deep
---

# Loaders & Actions

Every page can have a companion `.server.ts` file that exports a `loader` and/or `action`. Server handlers use the exact same `defineHandler` API as [server routes](../server-routing.md) — you get the same typed `c.env` bindings, `withValidator()` support, and Hono context methods.

## Loaders

`loader` runs on GET requests and returns an object that becomes the page's props:

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

## Actions

`action` runs on mutations (POST, PUT, PATCH, DELETE). Use `withValidator()` with a [schema-derived validator](../database.md#schema-derived-validators) to validate the request body:

```ts
// pages/users/index.server.ts
import { defineHandler } from "void";
import { db } from "void/db";
import { users, insertUserSchema } from "@schema";

export const action = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  await db.insert(users).values(body);
  // No return → re-runs loader, page re-renders with fresh data
});
```

| Action returns        | Behavior                                              |
| --------------------- | ----------------------------------------------------- |
| Nothing (void)        | Re-runs the loader, page re-renders with fresh props. |
| `c.redirect('/path')` | Navigates to another page.                            |

Both use the same `defineHandler` API from [server routing](../server-routing.md), including `withValidator()` for input validation.

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
