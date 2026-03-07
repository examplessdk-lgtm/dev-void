---
outline: deep
---

# Type Safety

Void provides end-to-end type safety across your entire stack — from database queries, through route handlers, to frontend fetch calls. Types are derived from your source code and Drizzle schema. Nothing is manually written or duplicated.

## The Type Pipeline

```
Drizzle schema → DB types → Route handlers → Route types → Typed fetch client
```

Each layer feeds into the next:

1. **Database types** come from your [Drizzle schema](./database.md#schema-definition) in `db/schema.ts`. The schema is TypeScript — column types are already known at compile time.
2. **Route handler types** are extracted from your `routes/` files using `typeof import(...)`. Return types, validator schemas, and parameter patterns all become part of the generated `RouteMap`.
3. **The fetch client** consumes the `RouteMap` to type-check paths, methods, request bodies, and response types at the call site.

All generated types live in `.void/` and update automatically when you change source files or schema.

## Database → Handler

Types from `void/db` are inferred from your [Drizzle schema](./database.md#schema-definition). When a handler queries the database, the return type flows through naturally:

```ts
// routes/api/users.ts
import { defineHandler } from "void";
import { db } from "void/db";
import { users } from "@schema";

export const GET = defineHandler(async (c) => {
  return db.select({ name: users.name, email: users.email }).from(users).all();
  // Return type: { name: string; email: string }[]
});
```

TypeScript knows the shape of the result because it's inferred from the Drizzle schema columns. The handler's return type is then captured by the route type generator.

## Handler → Client

The typed fetch client infers its types from your handler's return type and validator schemas:

```ts
// src/App.tsx
import { fetch } from "void/client";

const users = await fetch("/api/users");
// users: { name: string; email: string }[]

users[0].name; // ✓ string
users[0].missing; // ✗ TypeScript error
```

No type annotation on `users` — it's inferred from the GET handler's return type, after JSON serialization.

## Validators Close the Loop

When you [derive validators from your Drizzle schema](./database.md#schema-derived-validators), types flow from the database all the way to the frontend fetch client — the schema is the single source of truth:

```ts
// routes/api/users.ts
import { defineHandler } from "void";
import { db } from "void/db";
import { users, insertUserSchema } from "@schema";

export const POST = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  const [created] = await db.insert(users).values(body).returning();
  return created;
});
```

```ts
// src/App.tsx
import { fetch } from "void/client";

// ✓ body shape matches the schema-derived validator
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice", email: "alice@example.com" },
});

// ✗ TypeScript error — missing 'email'
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice" },
});
```

The Drizzle schema defines database columns, runtime validation, handler input types, and client-side type checking all at once. For endpoints that don't map to a table, you can also write [manual validators](./server-routing.md#manual-validators) with any Standard Schema library.

## Loader → Page Component

In [pages mode](./pages-routing/overview), a `loader` in a `.server.ts` file returns data that becomes the page component's props. The return type flows through automatically via `InferProps`:

```ts
// pages/users/index.server.ts
import { defineHandler, type InferProps } from "void";
import { db } from "void/db";
import { users } from "@schema";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  return { users: await db.select().from(users).all() };
});
```

The page component imports the `Props` type — everything is inferred from the loader's return type:

```vue
<!-- pages/users/index.vue -->
<script setup lang="ts">
import type { Props } from "./index.server";
defineProps<Props>();
</script>

<template>
  <ul>
    <li v-for="u in users" :key="u.id">{{ u.name }}</li>
  </ul>
</template>
```

No manual interface needed — `InferProps` extracts the return type from `defineHandler`, so the props stay in sync with whatever the loader returns.

## Action → useForm

The same pipeline extends to [pages mode](./pages-routing/overview). When a page action uses `withValidator()` in a `.server.ts` file, the body schema flows through to `useForm` — typed `data`, typed `errors` keys, and URL autocomplete:

```ts
// pages/users/create.server.ts
import { defineHandler } from "void";
import { db } from "void/db";
import { users, insertUserSchema } from "@schema";

export const action = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  await db.insert(users).values(body);
});
```

```ts
import { useForm } from "void/vue"; // or "void/react" or "void/svelte"

const form = useForm("/users/create", { name: "", email: "" });
//                    ^ autocompletes     ^ must match body schema

form.errors.email; // string | undefined ✓
form.errors.foo; // ✗ TypeScript error
form.reset("name"); // field names autocomplete
```

For dynamic routes, `params` is required:

```ts
const form = useForm("/users/:id", { name: "" }, { params: { id: "42" } });
form.put(); // submits to /users/42
```

Actions without validators still get URL autocomplete — the body falls back to `Record<string, unknown>`. See [Pages Routing — Forms](./pages-routing/forms) for the full API.

## What Gets Checked

| Layer        | What's type-checked                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Database     | Table columns, value types, insert/update shapes — all inferred from Drizzle schema              |
| Handlers     | `c.env` bindings, validator input, return type                                                   |
| Fetch client | Route paths, HTTP methods, `body`/`query`/`params`, response type                                |
| `useForm`    | Page action URLs, `data` fields, `errors` keys, `reset()`/`clearErrors()` args, dynamic `params` |

## Serialization

The type system models JSON serialization. A `Serialize<T>` transform is applied to handler return types so the client sees what actually arrives over the wire:

| Source type                       | Serialized type                                           |
| --------------------------------- | --------------------------------------------------------- |
| `string`, `number`, `boolean`     | unchanged                                                 |
| `Date`                            | `string`                                                  |
| `Response`                        | excluded (passed through at runtime, not in typed output) |
| `bigint`, `Function`, `undefined` | excluded                                                  |
| `Array<T>`                        | `Array<Serialize<T>>`                                     |
| `{ key: T }`                      | `{ key: Serialize<T> }` (function-valued keys stripped)   |

## Context Variables

Route handlers and middleware share data through Hono's context variables (`c.set()` / `c.get()`). Void's `CloudContextVariables` interface defines the variable types, and you can augment it to add your own:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "void";

declare module "void" {
  interface CloudContextVariables {
    requestId: string;
  }
}

export default defineMiddleware(async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
});
```

Now `c.get("requestId")` returns `string` in every handler and middleware — no type assertions needed.

This is standard TypeScript [declaration merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html). Multiple augmentations across different files are merged together, so each middleware can declare what it provides.

## Setup

Extend the generated tsconfig in your project's `tsconfig.json`:

```json
{
  "extends": "./.void/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["void/env"]
  },
  "include": ["src", "routes", "middleware", "crons", "queues"]
}
```

The `"extends"` line is the key part. The generated `.void/tsconfig.json` uses `"files"` to include both `routes.d.ts` and `db.d.ts`, which TypeScript inherits automatically. You do not need to add `.void` to your `include` array.

> The `.void/` files are generated when the dev server starts or when you build. Run `vite dev` or `vite build` at least once to generate them.
