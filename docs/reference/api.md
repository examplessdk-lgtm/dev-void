---
outline: deep
---

# API Reference

All public exports of the `void` package.

## Plugin

### `voidPlugin(options?)`

Named export from `"void"`. Returns an array of Vite plugins that set up file-based routing, migration support, and the Cloudflare Workers runtime. Application-level configuration is read from [`void.json`](./config.md); the optional `options` object controls Vite/Cloudflare plugin behavior.

```ts
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
```

| Option             | Type                      | Description                                                                                                                                                                                                                       |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistTo`        | `string`                  | Directory path for persisting local dev state (D1, KV, R2). Defaults to `.void/` in the project root.                                                                                                                             |
| `auxiliaryWorkers` | `AuxiliaryWorkerConfig[]` | Additional workers to run inside the same Miniflare instance during dev. Passed through to `@cloudflare/vite-plugin`. Useful for running multiple workers that share bindings (e.g. a separate API worker alongside a dashboard). |

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

Wraps a [queue](../guide/queues.md) consumer handler with typed message bodies. The generic `<T>` defines the message body type, which flows through to the typed `queues` proxy for `send()` calls.

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
    <html><head>${assetTags.css}${assetTags.preloads}</head>
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

### `defineHead<P>(handler)`

Type-safe wrapper for the page `head()` export in `.server.ts` files. Provides [`CloudContext`](#cloudcontext) typing for the first argument and generic props typing for the second.

```ts
import { defineHandler, defineHead } from "void";
import type { InferProps } from "void";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const post = await getPost(c.req.param("slug"));
  return { post };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.post.title,
    meta: [
      { name: "description", content: props.post.excerpt },
      { property: "og:title", content: props.post.title },
    ],
  };
});
```

**Signature:**

```ts
function defineHead<P = Record<string, unknown>>(
  handler: (c: CloudContext, props: P) => HeadDescriptor | undefined,
): (c: CloudContext, props: P) => HeadDescriptor | undefined;
```

## Auth

Imported from `"void"` or `"void/auth"`. Client-side helpers imported from `"void/client"`.

### `defineAuth(config)`

Advanced escape hatch for customizing Void's Better Auth config.

```ts
import { defineAuth } from "void/auth";

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ["https://example.com"],
}));
```

**Signature:**

```ts
function defineAuth(config: VoidAuthConfig): VoidAuthConfig;
```

### `getUser()`

Returns the current authenticated user from AsyncLocalStorage, or `null` when no user is present.

```ts
import { getUser } from "void/auth";

const user = getUser();
```

**Signature:**

```ts
function getUser(): AuthUser | null;
```

### `getSession()`

Returns the current Better Auth request state, or `null`.

```ts
import { getSession } from "void/auth";

const state = getSession();
```

**Signature:**

```ts
function getSession(): AuthState | null;
```

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

### `AuthUser`

Better Auth user shape re-exported by Void.

```ts
interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### `AuthSession`

Better Auth session shape re-exported by Void.

```ts
interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}
```

### `AuthState`

Combined authenticated request state:

```ts
interface AuthState {
  user: AuthUser;
  session: AuthSession;
}
```

### `auth`

Imported from `"void/client"`. This is a ready-to-use Better Auth client instance preconfigured with `basePath: "/api/auth"`.

```ts
import { auth } from "void/client";

await auth.signIn.email({ email, password });
await auth.signOut();
```

The exact client methods come from Better Auth. In pages apps, Void automatically chooses the framework-specific Better Auth client package when available.

### `createAuthClient`

Imported from `"void/client"`. Re-export of Better Auth's `createAuthClient` for advanced usage.

```ts
import { createAuthClient } from "void/client";

const auth = createAuthClient({ basePath: "/api/auth" });
```

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

Imported from `"void/db"`. The `db` export is a [Drizzle ORM](https://orm.drizzle.team) instance for [Cloudflare D1](https://developers.cloudflare.com/d1/). See the [Database guide](../guide/database.md) for usage and the [Drizzle docs](https://orm.drizzle.team/docs/select) for the full query API.

### `db`

Default Drizzle D1 instance, pre-wired with the `env.DB` binding and your schema from `db/schema.ts`.

```ts
import { db } from "void/db";
import { users } from "@schema";

const allUsers = await db.select().from(users).all();
```

When the Void plugin is active, `void/db` is served as a virtual module that auto-wires the D1 binding with your schema. The published npm fallback uses a lazy proxy that resolves the `DB` binding at first access.

### `createDb(database)`

Creates a Drizzle D1 instance from a specific D1 binding. Use this when you have multiple D1 databases or need a non-default binding.

```ts
import { createDb } from "void/db";
import { env } from "cloudflare:workers";

const db = createDb(env.MY_OTHER_DB);
```

**Signature:**

```ts
function createDb(d1: D1Database): DrizzleD1Database;
```

### Query Operators

`void/db` re-exports commonly used [Drizzle operators](https://orm.drizzle.team/docs/operators) so you never need to depend on `drizzle-orm` directly:

```ts
import { db, eq, and, or, desc, like, inArray, sql } from "void/db";
```

**Full list:** `sql`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `desc`, `asc`, `like`, `ilike`, `notLike`, `inArray`, `notInArray`, `isNull`, `isNotNull`, `between`, `notBetween`, `exists`, `notExists`, `count`, `sum`, `avg`, `min`, `max`.

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
  session: AuthSession | null;
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

See [Type Safety](../guide/type-safety.md#context-variables) for details.

### `TypedHandler<V, R>`

The return type of `defineHandler`. Carries phantom types for validators (`V`) and return type (`R`) used by the codegen to produce typed routes.

```ts
interface TypedHandler<V extends ValidatorSlots = {}, R = unknown> {
  (c: CloudContext): Promise<Response> | Response | unknown;
  readonly __validators: V; // type-level only
  readonly __output: R; // type-level only
}
```

### `HeadDescriptor`

Shape of page head metadata returned by `defineHead`. All fields are optional.

```ts
interface HeadDescriptor {
  title?: string;
  meta?: Array<{ name?: string; property?: string; content?: string; charset?: string }>;
  link?: Array<{ rel: string; href: string; [key: string]: string | undefined }>;
  script?: Array<{ src?: string; innerHTML?: string; [key: string]: string | undefined }>;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
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

Framework adaptors for [Pages Routing](../guide/pages-routing/overview). Each adaptor provides a Vite plugin and client-side runtime.

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

| Import path            | Contents                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `void`                 | `voidPlugin` named export + all handler/type re-exports                                                                                                          |
| `void/handler`         | `defineHandler`, `defineMiddleware`, `defineScheduled`, `defineQueue`, `defineRender`, `defineHead`, types                                                       |
| `void/auth`            | `defineAuth`, `getUser`, `getSession`, `requireAuth`, `AuthUser`, `AuthSession`, `AuthState`                                                                     |
| `void/client`          | `fetch`, `fetchStream`, `FetchError`, `auth`, `createAuthClient`, `AuthUser`, `AuthSession`, `AuthState`                                                         |
| `void/ws`              | `defineRoom`, `defineWebSocket`, `connect`, WebSocket context and connection types                                                                               |
| `void/response`        | `convertReturnValue`                                                                                                                                             |
| `void/validator`       | `runValidation`, `ValidatorSlots`, `HandlerInput`                                                                                                                |
| `void/drizzle-zod`     | Re-exports [`drizzle-zod`](https://orm.drizzle.team/docs/zod) — schema-derived Zod validators for Drizzle tables                                                 |
| `void/drizzle-valibot` | Re-exports [`drizzle-valibot`](https://orm.drizzle.team/docs/typebox) — schema-derived Valibot validators for Drizzle tables                                     |
| `void/drizzle-arktype` | Re-exports [`drizzle-arktype`](https://orm.drizzle.team/docs/arktype) — schema-derived ArkType validators for Drizzle tables                                     |
| `void/schema-d1`       | Re-exports [`drizzle-orm/sqlite-core`](https://orm.drizzle.team/docs/column-types/sqlite) — D1 table/column builders                                             |
| `void/schema-pg`       | Re-exports [`drizzle-orm/pg-core`](https://orm.drizzle.team/docs/column-types/pg) — PostgreSQL table/column builders                                             |
| `void/db`              | `db` ([Drizzle D1](https://orm.drizzle.team/docs/get-started/d1-new) instance), `createDb`, query operators (`eq`, `and`, `or`, `desc`, `like`, `inArray`, etc.) |
| `void/routes`          | `RouteMap` and `WebSocketRouteMap` stubs (types only)                                                                                                            |
| `void/queues`          | `queues` proxy for sending messages to typed queues                                                                                                              |
| `void/env`             | Global Cloudflare env types (types only)                                                                                                                         |
