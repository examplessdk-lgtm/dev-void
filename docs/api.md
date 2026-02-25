---
outline: deep
---

# API Reference

All public exports of the `void` package.

## Plugin

### `voidPlugin()`

Named export from `"void"`. Returns an array of Vite plugins that set up file-based routing, migration support, and the Cloudflare Workers runtime. Takes no arguments — all configuration is read from [`void.json`](./config.md).

```ts
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
```

## Handlers

Imported from `"void"` or `"void/handler"`.

### `defineHandler(handler)`

Wraps a route handler function. The handler receives a [`CloudContext`](#cloudcontext) and can return a plain value (auto-converted to a Response) or use the Hono `c.json()` / `c.text()` APIs directly.

```ts
import { defineHandler } from "void";

export const GET = defineHandler((c) => {
  return { message: "hello" };
});
```

**Signature:**

```ts
function defineHandler<R>(handler: (c: CloudContext) => R): TypedHandler<{}, R>;
```

### `defineHandler(middleware..., handler)`

Composes up to 5 per-route middleware with a final handler. Middleware runs in order before the handler.

```ts
export const GET = defineHandler(authMiddleware, rateLimiter, (c) => {
  return { ok: true };
});
```

### `defineHandler.withValidator(validators)`

Creates a handler with input validation using any [Standard Schema](https://github.com/standard-schema/standard-schema) compatible library (zod, valibot, arktype, etc.). Returns a curried function that accepts the handler.

Validated input is passed as the second argument to the handler.

```ts
import { defineHandler } from "void";
import * as v from "valibot";

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})((c, { body }) => {
  return { received: body.name };
});
```

**Signature:**

```ts
function withValidator<V extends ValidatorSlots>(
  validators: V,
): <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R) => TypedHandler<V, R>;
```

**Type: `ValidatorSlots`**

```ts
interface ValidatorSlots {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}
```

**Type: `HandlerInput<V>`**

The inferred output types of each validator slot. For a `ValidatorSlots` with `body` and `query`, the input object has `{ body: ..., query: ... }` with types inferred from the schema output.

### `defineMiddleware(handler)`

Type-safe wrapper for Hono middleware. At runtime, returns the function unchanged.

```ts
import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  console.log(`${c.req.method} ${c.req.path}`);
  await next();
});
```

**Signature:**

```ts
function defineMiddleware(handler: MiddlewareHandler<CloudEnv>): MiddlewareHandler<CloudEnv>;
```

### `defineScheduled(handler)`

Wraps a Cloudflare [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) with type inference.

```ts
import { defineScheduled } from "void";

export default defineScheduled(async (controller, env, ctx) => {
  const { results } = await env.DB.prepare("SELECT * FROM stale").all();
  // ...
});
```

**Signature:**

```ts
function defineScheduled(
  handler: (
    controller: ScheduledController,
    env: CloudEnv["Bindings"],
    ctx: ExecutionContext,
  ) => unknown | Promise<unknown>,
): ScheduledFn;
```

### `defineQueue<T>(handler)`

Wraps a [queue](./queues.md) consumer handler with typed message bodies. The generic `<T>` defines the message body type, which flows through to the typed `queues` proxy for `send()` calls.

```ts
import { defineQueue } from "void";

export default defineQueue<{ to: string; subject: string }>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

**Signature:**

```ts
function defineQueue<T>(
  handler: (batch: QueueBatch<T>, env: CloudEnv["Bindings"]) => void | Promise<void>,
): QueueFn;
```

### `defineRender(handler)`

Wraps an SSR render entry. The second argument provides pre-built `<head>` and `<body>` asset tags for injecting client scripts and styles.

```ts
import { defineRender } from "void";
import { renderToString } from "react-dom/server";

export default defineRender((c, assetTags) => {
  const html = renderToString(<App />);
  return c.html(`<!DOCTYPE html>
    <html><head>${assetTags.head}</head>
    <body><div id="root">${html}</div>${assetTags.body}</body></html>`);
});
```

**Signature:**

```ts
function defineRender(
  handler: (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>,
): RenderFn;
```

**Type: `RenderAssetTags`**

```ts
interface RenderAssetTags {
  head: string; // Script and style tags for <head>
  body: string; // Script tags for before </body>
}
```

## Auth

Imported from `"void"` or `"void/auth"`. Client-side helpers imported from `"void/client"`.

### `requireAuth(c)`

Extracts the authenticated user from the request context. Throws a 401 `HTTPException` if no session is present.

```ts
import { defineHandler } from "void";
import { requireAuth } from "void/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

**Signature:**

```ts
function requireAuth(c: CloudContext): AuthUser;
```

**Type: `AuthUser`**

```ts
interface AuthUser {
  id: string;
  provider: string; // "email", "github", or "google"
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}
```

### `AuthClient`

Client-side helpers for Void's built-in [authentication](./auth.md). Imported from `"void/client"`. Handles JSON serialization and cookie sessions automatically.

```ts
import { auth } from "void/client";
```

#### `auth.register(input)`

Create a new email/password account. Sets the session cookie on success.

```ts
const user = await auth.register({
  email: "alice@example.com",
  password: "s3cret",
  name: "Alice",
});
```

**Signature:**

```ts
register(input: { email: string; password: string; name?: string }): Promise<AuthUser>;
```

#### `auth.login(input)`

Sign in with email and password. Sets the session cookie on success.

```ts
const user = await auth.login({
  email: "alice@example.com",
  password: "s3cret",
});
```

**Signature:**

```ts
login(input: { email: string; password: string }): Promise<AuthUser>;
```

#### `auth.me()`

Return the current user, or `null` if not authenticated.

```ts
const user = await auth.me();
```

**Signature:**

```ts
me(): Promise<AuthUser | null>;
```

#### `auth.logout()`

Sign out and clear the session cookie.

```ts
await auth.logout();
```

**Signature:**

```ts
logout(): Promise<void>;
```

### `AuthError`

Error class thrown by `auth` client helpers on non-2xx responses.

```ts
import { auth, AuthError } from "void/client";

try {
  await auth.login({ email, password });
} catch (e) {
  if (e instanceof AuthError) {
    console.log(e.status); // 401
    console.log(e.message); // "Invalid credentials"
    console.log(e.data); // raw response body
  }
}
```

**Properties:**

| Property  | Type      | Description                                                       |
| --------- | --------- | ----------------------------------------------------------------- |
| `status`  | `number`  | HTTP status code                                                  |
| `message` | `string`  | Extracted from `error` field in response body, or generic message |
| `data`    | `unknown` | Full parsed response body                                         |

## Fetch Client

Imported from `"void/client"`.

### `fetch(path, options?)`

Type-safe fetch client for calling your API routes from client code, built on top of [ofetch](https://github.com/unjs/ofetch). Route paths and return types are inferred from the generated `RouteMap`.

```ts
import { fetch } from "void/client";

// Types are fully inferred from your route handlers
const users = await fetch("/api/users");
const user = await fetch("/api/users/:id", {
  params: { id: "1" },
});
```

**Signature:**

```ts
function fetch<P extends keyof RouteMap, M extends MethodsOf<P>>(
  path: P,
  options?: FetchOptions<P, M>,
): Promise<OutputOf<P, M>>;
```

**Options:**

| Option    | Type                     | Description                                                |
| --------- | ------------------------ | ---------------------------------------------------------- |
| `method`  | `string`                 | HTTP method. Defaults to `"GET"`.                          |
| `body`    | `unknown`                | Request body (auto-serialized as JSON).                    |
| `query`   | `Record<string, string>` | Query string parameters.                                   |
| `params`  | `Record<string, string>` | URL path parameters (`:id` segments).                      |
| `headers` | `HeadersInit`            | Additional request headers.                                |
| `signal`  | `AbortSignal`            | Abort signal.                                              |
| `baseURL` | `string`                 | Base URL prepended to the path. Useful for external calls. |
| `retry`   | `number`                 | Number of retry attempts (ofetch default: 1 for GET).      |
| `timeout` | `number`                 | Request timeout in milliseconds.                           |

Returns the parsed JSON response body, or `undefined` for 204 responses. Throws `FetchError` on non-2xx responses.

### `FetchError`

Error class thrown by `fetch` on non-2xx responses.

```ts
import { fetch, FetchError } from "void/client";

try {
  await fetch("/api/users/:id", { params: { id: "999" } });
} catch (e) {
  if (e instanceof FetchError) {
    console.log(e.status); // 404
    console.log(e.response); // raw Response
  }
}
```

**Properties:**

| Property   | Type       | Description                          |
| ---------- | ---------- | ------------------------------------ |
| `status`   | `number`   | HTTP status code.                    |
| `response` | `Response` | The raw `Response` object.           |
| `data`     | `unknown`  | Parsed response body (if available). |

### Differences from Native `fetch`

The typed client is built on [ofetch](https://github.com/unjs/ofetch) with a typed route layer on top. Key differences from native `fetch`:

| Behavior               | Native `fetch`                                       | `void/client` `fetch`                                                                                                     |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Return type**        | `Promise<Response>` — you call `.json()` yourself    | `Promise<T>` — auto-parses JSON, returns the typed result directly (`undefined` for 204)                                  |
| **Error handling**     | Resolves on any HTTP status; you check `response.ok` | Throws `FetchError` on non-2xx responses                                                                                  |
| **URL construction**   | Raw URL string                                       | Route path with `:param` interpolation from `options.params` + query string from `options.query`                          |
| **Body serialization** | Manual `JSON.stringify()` + `Content-Type` header    | Auto-serializes `options.body` as JSON and sets `Content-Type: application/json`                                          |
| **Type safety**        | Accepts any URL/method                               | Constrains paths to `RouteMap` keys and methods to those defined per route — invalid combinations are compile-time errors |
| **Retry**              | None                                                 | Auto-retries on 408, 429, and 5xx (configurable via `retry` option)                                                       |
| **Timeout**            | None                                                 | Configurable via `timeout` option                                                                                         |

`headers` and `signal` are passed through to the underlying fetch unchanged.

## Database

Imported from `"void/db"`. See [Database](./db.md) for usage guide.

### `db`

Default query client instance. Uses `env.DB` from `cloudflare:workers` automatically.

```ts
import { db } from "void/db";

const users = await db.list("users");
```

### `createDb(database)`

Creates a query client for a specific D1 instance. Use this when you need to pass the binding explicitly (e.g. in framework mode).

```ts
import { createDb } from "void/db";
import { env } from "cloudflare:workers";

const db = createDb(env.DB);
```

**Signature:**

```ts
function createDb(database: D1Database): QueryClient;
```

### `QueryClient`

The query client interface. All table names, column names, and value types are checked at compile time via the generated `DbTables` and `DbInsertTables` interfaces.

#### `db.list(table, options?)`

Fetch multiple rows.

```ts
const users = await db.list("users", {
  select: ["name", "email"],
  where: { role: "admin", id: [1, 2, 3] },
  orderBy: ["name ASC", "created_at DESC"],
  limit: 10,
  offset: 20,
});
```

**Signature:**

```ts
// With select — return type narrowed to selected columns
list<T, K>(table: T, options: ListOptions<T> & { select: K[] }): Promise<Pick<Row<T>, K>[]>;
// Without select — returns full row
list<T>(table: T, options?: ListOptions<T>): Promise<Row<T>[]>;
```

**Options:**

| Option    | Type                               | Description                                          |
| --------- | ---------------------------------- | ---------------------------------------------------- |
| `select`  | `string[]`                         | Columns to return. Omit for all columns (`SELECT *`) |
| `where`   | `Record<string, value \| value[]>` | Filter conditions. Arrays produce `IN (...)` clauses |
| `orderBy` | `string \| string[]`               | Column with optional `ASC`/`DESC` direction          |
| `limit`   | `number`                           | Maximum rows to return                               |
| `offset`  | `number`                           | Number of rows to skip                               |

#### `db.get(table, options?)`

Fetch a single row. Returns `null` if no match.

```ts
const user = await db.get("users", {
  select: ["name"],
  where: { id: 1 },
});
// { name: string } | null
```

**Signature:**

```ts
get<T, K>(table: T, options: GetOptions<T> & { select: K[] }): Promise<Pick<Row<T>, K> | null>;
get<T>(table: T, options?: GetOptions<T>): Promise<Row<T> | null>;
```

**Options:** `select` and `where`, same as `list`.

#### `db.insert(table, data)`

Insert a row. Columns with `DEFAULT` or `PRIMARY KEY AUTOINCREMENT` are optional.

```ts
await db.insert("users", { name: "Alice", email: "alice@example.com" });
```

**Signature:**

```ts
insert<T>(table: T, data: DbInsertTables[T]): Promise<D1Result>;
```

#### `db.update(table, options)`

Update rows. Throws if `set` is empty.

```ts
await db.update("users", {
  set: { role: "admin" },
  where: { id: 1 },
});
```

**Signature:**

```ts
update<T>(table: T, options: { set: Partial<Row<T>>; where?: WhereClause<T> }): Promise<D1Result>;
```

#### `db.delete(table, options?)`

Delete rows. Omitting `where` deletes all rows.

```ts
await db.delete("users", { where: { id: 1 } });
```

**Signature:**

```ts
delete<T>(table: T, options?: { where?: WhereClause<T> }): Promise<D1Result>;
```

#### `db.count(table, options?)`

Count rows matching an optional filter.

```ts
const total = await db.count("users");
const admins = await db.count("users", { where: { role: "admin" } });
```

**Signature:**

```ts
count<T>(table: T, options?: { where?: WhereClause<T> }): Promise<number>;
```

#### `db.raw(sql, bindings?)`

Execute arbitrary SQL. Provide a type parameter for the result shape.

```ts
const results = await db.raw<{ name: string; total: number }>(
  "SELECT name, COUNT(*) as total FROM users GROUP BY name",
);
```

**Signature:**

```ts
raw<R = Record<string, unknown>>(sql: string, bindings?: unknown[]): Promise<R[]>;
```

## Types

### `CloudContext`

Hono `Context` pre-typed with [`CloudEnv`](#cloudenv). This is the type of the `c` parameter in all route handlers and middleware.

```ts
import type { CloudContext } from "void";
```

### `CloudEnv`

Hono environment type for Void workers. Extends Hono's `Env` with Cloudflare bindings and context variables.

```ts
interface CloudEnv extends Env {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AUTH_KV: KVNamespace;
    [key: string]: unknown;
  };
  Variables: CloudContextVariables;
}
```

### `CloudContextVariables`

The context variables type used by `c.set()` / `c.get()`. Augment this interface to add typed variables that flow through all middleware and handlers:

```ts
interface CloudContextVariables {
  user: AuthUser | null;
  [key: string]: unknown;
}
```

**Augmentation example:**

```ts
declare module "void" {
  interface CloudContextVariables {
    requestId: string;
  }
}

// c.get("requestId") → string
```

See [Type Safety](./type-safety.md#context-variables) for details.

### `TypedHandler<V, R>`

The return type of `defineHandler`. Carries phantom types for validators (`V`) and return type (`R`) used by the codegen to produce typed routes.

```ts
interface TypedHandler<V extends ValidatorSlots = {}, R = unknown> {
  (c: CloudContext): Promise<Response> | Response | unknown;
  readonly __validators: V; // type-level only
  readonly __output: R; // type-level only
}
```

### `RouteMap`

Empty stub interface augmented at build time by the generated `.void/routes.d.ts`. Contains the full type information for all routes, methods, inputs, and outputs — used by the typed `fetch` client.

```ts
import type { RouteMap } from "void/routes";
```

## Environment Types

Importing `"void/env"` provides global Cloudflare environment types:

```ts
/// <reference types="void/env" />
```

Declares the `Cloudflare.Env` namespace with `DB: D1Database`, `KV: KVNamespace`, and `STORAGE: R2Bucket`.

For handler context variables (`c.set()` / `c.get()`), augment [`CloudContextVariables`](#cloudcontextvariables) — this is separate from `Cloudflare.Env`, which types the worker bindings. Framework adaptors (`void/vue`, `void/react`, `void/svelte`) also augment `CloudContextVariables` to add the `shared` key used by `useShared()`.

## Framework Adaptors

Framework adaptors for [Pages Routing](./pages-routing.md). Each adaptor provides a Vite plugin and client-side runtime.

### `@void-x/vue`

#### `voidVue(options?)`

Imported from `"@void-x/vue"`. Returns an array of Vite plugins that handle Vue SFC compilation and SSR/hydration entry generation. Includes `@vitejs/plugin-vue` — no need to install or configure it separately.

```ts
import { voidVue } from "@void-x/vue";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

**Signature:**

```ts
function voidVue(options?: VoidVueOptions): Plugin[];
```

**Options:**

```ts
interface VoidVueOptions {
  vue?: VuePluginOptions; // passed through to @vitejs/plugin-vue
}
```

#### Vue Runtime

Imported from `"void/vue"`.

| Export                             | Description                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Vue component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `preserveScroll`.           |
| `useRouter()`                      | Returns the page router for programmatic navigation: `visit`, `reload`, `post`, `put`, `patch`, `delete`.                                             |
| `useForm(url, defaults, options?)` | Typed reactive form helper bound to a page action URL. Returns `{ data, post, put, patch, delete, processing, errors, isDirty, reset, clearErrors }`. |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                              |

### `@void-x/react`

#### `voidReact(options?)`

Imported from `"@void-x/react"`. Returns an array of Vite plugins that handle SSR/hydration entry generation. Includes `@vitejs/plugin-react` — no need to install or configure it separately.

```ts
import { voidReact } from "@void-x/react";

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

**Signature:**

```ts
function voidReact(options?: VoidReactOptions): Plugin[];
```

**Options:**

```ts
interface VoidReactOptions {
  react?: ReactPluginOptions; // passed through to @vitejs/plugin-react
}
```

#### React Runtime

Imported from `"void/react"`.

| Export              | Description                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`              | React component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `preserveScroll`. |
| `useForm(defaults)` | Form helper hook. Returns `{ data, setData, post, put, patch, delete, processing, errors, isDirty, reset, clearErrors }`.                     |
| `useShared()`       | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                      |

### `@void-x/svelte`

#### `voidSvelte(options?)`

Imported from `"@void-x/svelte"`. Returns an array of Vite plugins that handle SSR/hydration entry generation for Svelte 5. Includes `@sveltejs/vite-plugin-svelte` — no need to install or configure it separately.

```ts
import { voidSvelte } from "@void-x/svelte";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

**Signature:**

```ts
function voidSvelte(options?: VoidSvelteOptions): Plugin[];
```

**Options:**

```ts
interface VoidSvelteOptions {
  svelte?: SveltePluginOptions; // passed through to @sveltejs/vite-plugin-svelte
  viewTransitions?: boolean; // enable View Transitions API
}
```

#### Svelte Runtime

Imported from `"void/svelte"`.

| Export              | Description                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`              | Svelte component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `preserveScroll`. |
| `useForm(defaults)` | Form helper using Svelte 5 runes. Returns `{ data, post, put, patch, delete, processing, errors, isDirty, reset, clearErrors }`.               |
| `useShared()`       | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                       |
| `useRouter()`       | Returns the page router for programmatic navigation: `visit`, `reload`, `post`, `put`, `patch`, `delete`.                                      |

## Subpath Exports

| Import path      | Contents                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `void`           | `voidPlugin` named export + all handler/type re-exports                                      |
| `void/handler`   | `defineHandler`, `defineMiddleware`, `defineScheduled`, `defineQueue`, `defineRender`, types |
| `void/auth`      | `requireAuth`, `AuthUser`                                                                    |
| `void/client`    | `fetch`, `FetchError`, `auth`, `AuthError`, `AuthUser`                                       |
| `void/response`  | `convertReturnValue`                                                                         |
| `void/validator` | `runValidation`, `ValidatorSlots`, `HandlerInput`                                            |
| `void/db`        | `db`, `createDb`, `QueryClient`, `DbTables`, `DbInsertTables`                                |
| `void/routes`    | `RouteMap` stub (types only)                                                                 |
| `void/queues`    | `queues` proxy for sending messages to typed queues                                          |
| `void/env`       | Global Cloudflare env types (types only)                                                     |
