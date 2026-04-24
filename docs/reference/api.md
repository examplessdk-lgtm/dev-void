---
outline: deep
---

# API Reference

This page is the source of truth for public `void` exports. Use it when you already know what feature you want and need the exact import, signature, or return type.

## Plugin

### `voidPlugin(options?)`

Named export from `"void"`. Returns an array of Vite plugins that set up file-based routing, migration support, and the Cloudflare Workers runtime. Application-level configuration is read from [`void.json`](./config.md); the optional `options` object controls Vite/Cloudflare plugin behavior.

```ts
import { voidPlugin } from 'void';

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
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return { message: 'hello' };
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
import { defineHandler } from 'void';
import * as v from 'valibot';

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
import { defineMiddleware } from 'void';

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
import { defineScheduled } from 'void';

export default defineScheduled(async (controller, env, ctx) => {
  const { results } = await env.DB.prepare('SELECT * FROM stale').all();
  // ...
});
```

**Signature:**

```ts
function defineScheduled(
  handler: (
    controller: ScheduledController,
    env: CloudEnv['Bindings'],
    ctx: ExecutionContext,
  ) => unknown | Promise<unknown>,
): ScheduledFn;
```

### `defineQueue<T>(handler)`

Wraps a [queue](../guide/queues.md) consumer handler with typed message bodies. The generic `<T>` defines the message body type, which flows through to the typed `queues` proxy for `send()` calls.

```ts
import { defineQueue } from 'void';

export default defineQueue<{ to: string; subject: string }>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

**Signature:**

```ts
function defineQueue<T>(
  handler: (batch: QueueBatch<T>, env: CloudEnv['Bindings']) => void | Promise<void>,
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
import { defineHandler, defineHead } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  return { post };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.post.title,
    meta: [
      { name: 'description', content: props.post.excerpt },
      { property: 'og:title', content: props.post.title },
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

## Rewrites

URL rewrites re-dispatch a request at a different internal path without changing the browser's URL. `c.rewrite()`, `c.originalUrl()`, and `c.isRewritten()` are available on every Hono `Context` the Void runtime hands you. See the [Rewrites guide](../guide/edge/rewrites.md) for the full overview, including static `routing.rewrites` / `routing.fallbacks` in [`void.json`](./config.md#routing).

### `c.rewrite(destination)`

Re-dispatches the current request at `destination` and returns the resulting `Response`. The browser URL does not change — this is a server-side hop. Query strings from the original request are preserved automatically, so `destination` must not contain a `?`. `destination` must start with `/` and is type-checked against the generated route tree via [`RewriteDestination`](#rewritedestination).

`c.redirect()` follows the same query-merge rule: query params from the request URL are preserved on the `Location`, and any query params included in the redirect destination are merged over them on collision (destination wins, last-write-wins, silent). This is parallel to `c.rewrite()`'s handling — write the destination with the exact params you want to override.

```ts
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  const locale = c.req.header('accept-language')?.startsWith('de') ? 'de' : 'en';
  return c.rewrite(`/${locale}${new URL(c.req.url).pathname}`);
});
```

**Signature:**

```ts
interface CloudContext {
  rewrite(destination: RewriteDestination): Promise<Response>;
}
```

**Caveats:**

- `destination` must start with a single `/` and point at an internal path. External URLs, protocol-relative destinations (`//host/...`), and anything non-path-absolute throw immediately — use `fetch()` for cross-origin calls.
- Destinations whose final path segment ends in a known static-asset extension (e.g. `/hero.png`, `/app.css`, `/data.json`) throw `VoidAssetRewriteError` (exported from `"void"`) before the re-dispatch. Runtime rewrites cannot reach assets — use a static `routing.rewrites` rule or a `_redirects` `200!` entry. `.html` is deliberately excluded from this guard because `.html` paths may be legitimate route handlers. See the [guide](../guide/edge/rewrites.md#runtime-rewrites-cannot-reach-static-assets) for the full extension list and rationale.
- Middleware re-runs on every rewrite hop. Guard side-effects with [`c.isRewritten()`](#c-originalurl-c-isrewritten).
- Client-side SPA navigation via `Link` does not trigger server rewrites; only full HTTP requests do.
- [ISR](../guide/edge/revalidation.md) cache keys follow the rewritten path, not the original URL.

### `c.originalUrl()` / `c.isRewritten()`

Context methods for inspecting rewrite state. `c.originalUrl()` returns the pre-rewrite URL as a `URL` object, or `null` on the first, non-rewritten hop. `c.isRewritten()` returns `true` on any re-dispatched context and `false` on the original. Both helpers read from an in-worker `WeakMap<Request, URL>` keyed on `c.req.raw`; the `X-Void-Original-URL` header is only how edge dispatch forwards the pre-rewrite URL to the worker, and entry middleware migrates it into the map once per request.

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (!c.isRewritten()) {
    // Only log the user-visible request, not internal rewrite hops.
    console.log(`${c.req.method} ${c.req.path}`);
  }
  await next();
});
```

**Signature:**

```ts
interface CloudContext {
  originalUrl(): URL | null;
  isRewritten(): boolean;
}
```

### `RewriteDestination`

```ts
import type { RewriteDestination } from 'void/routes';
```

Union of the exact route patterns from your generated `RouteMap` plus a `string` fallback (`RouteName | (string & {})`). Known route patterns (e.g. `/posts/[id]`) are offered as autocomplete entries in your editor, while the `string` branch keeps the type assignable from concrete runtime paths like `` `/posts/${id}` `` — there is no `:id` template-literal resolution at the type level. Used as:

- The parameter type of [`c.rewrite()`](#c-rewrite-destination).
- The type of `destination` entries in `routing.rewrites` and `routing.fallbacks` in [`void.json`](./config.md#routing).

Like [`RouteMap`](#routemap), `RewriteDestination` lives in the virtual `void/routes` module and is refreshed whenever routes change.

## Auth

Imported from `"void"` or `"void/auth"`. Client-side helpers imported from `"void/client"`.

### `defineAuth(config)`

Advanced escape hatch for customizing Void's Better Auth config.

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ['https://example.com'],
}));
```

**Signature:**

```ts
function defineAuth(config: VoidAuthConfig): VoidAuthConfig;
```

### `getUser()`

Returns the current authenticated user from AsyncLocalStorage, or `null` when no user is present.

```ts
import { getUser } from 'void/auth';

const user = getUser();
```

**Signature:**

```ts
function getUser(): AuthUser | null;
```

### `getSession()`

Returns the current Better Auth request state, or `null`.

```ts
import { getSession } from 'void/auth';

const state = getSession();
```

**Signature:**

```ts
function getSession(): AuthState | null;
```

### `requireAuth(c)`

Extracts the authenticated user from the request context. Throws a 401 `HTTPException` if no session is present.

```ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

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
import { auth } from 'void/client';

await auth.signIn.email({ email, password });
await auth.signOut();
```

The exact client methods come from Better Auth. In pages apps, Void automatically chooses the framework-specific Better Auth client package when available.

### `createAuthClient`

Imported from `"void/client"`. Re-export of Better Auth's `createAuthClient` for advanced usage.

```ts
import { createAuthClient } from 'void/client';

const auth = createAuthClient({ basePath: '/api/auth' });
```

## Fetch Client

Imported from `"void/client"`.

### `fetch(path, options?)`

Type-safe fetch client for calling your API routes from client code, built on top of [ofetch](https://github.com/unjs/ofetch). Route paths and return types are inferred from the generated `RouteMap`.

```ts
import { fetch } from 'void/client';

// Types are fully inferred from your route handlers
const users = await fetch('/api/users');
const user = await fetch('/api/users/:id', {
  params: { id: '1' },
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
import { fetch, FetchError } from 'void/client';

try {
  await fetch('/api/users/:id', { params: { id: '999' } });
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

| Behavior               | Native `fetch`                                       | `void/client` `fetch`                                                                                                  |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Return type**        | `Promise<Response>`, so you call `.json()` yourself  | `Promise<T>`, which auto-parses JSON and returns the typed result directly (`undefined` for `204`)                     |
| **Error handling**     | Resolves on any HTTP status; you check `response.ok` | Throws `FetchError` on non-2xx responses                                                                               |
| **URL construction**   | Raw URL string                                       | Route path with `:param` interpolation from `options.params` + query string from `options.query`                       |
| **Body serialization** | Manual `JSON.stringify()` + `Content-Type` header    | Auto-serializes `options.body` as JSON and sets `Content-Type: application/json`                                       |
| **Type safety**        | Accepts any URL or method                            | Constrains paths to `RouteMap` keys and methods to those defined per route. Invalid combinations fail at compile time. |
| **Retry**              | None                                                 | Auto-retries on 408, 429, and 5xx (configurable via `retry` option)                                                    |
| **Timeout**            | None                                                 | Configurable via `timeout` option                                                                                      |

`headers` and `signal` are passed through to the underlying fetch unchanged.

## Database

Imported from `"void/db"`. The `db` export is a [Drizzle ORM](https://orm.drizzle.team) instance for [Cloudflare D1](https://developers.cloudflare.com/d1/). See the [Database guide](../guide/database.md) for usage and the [Drizzle docs](https://orm.drizzle.team/docs/select) for the full query API.

### `db`

Default Drizzle D1 instance, pre-wired with the `env.DB` binding and your schema from `db/schema.ts`.

```ts
import { db } from 'void/db';
import { users } from '@schema';

const allUsers = await db.select().from(users).all();
```

When the Void plugin is active, `void/db` is served as a virtual module that auto-wires the D1 binding with your schema. The published npm fallback uses a lazy proxy that resolves the `DB` binding at first access.

### `createDb(database)`

Creates a Drizzle D1 instance from a specific D1 binding. Use this when you have multiple D1 databases or need a non-default binding.

```ts
import { createDb } from 'void/db';
import { env } from 'cloudflare:workers';

const db = createDb(env.MY_OTHER_DB);
```

**Signature:**

```ts
function createDb(d1: D1Database): DrizzleD1Database;
```

### Query Operators

`void/db` re-exports commonly used [Drizzle operators](https://orm.drizzle.team/docs/operators) so you never need to depend on `drizzle-orm` directly:

```ts
import { db, eq, and, or, desc, like, inArray, sql } from 'void/db';
```

**Full list:** `sql`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `desc`, `asc`, `like`, `ilike`, `notLike`, `inArray`, `notInArray`, `isNull`, `isNotNull`, `between`, `notBetween`, `exists`, `notExists`, `count`, `sum`, `avg`, `min`, `max`.

## Seeding

Imported from `"void/seed"`.

### `defineSeed(fn)`

Identity helper for programmatic seed modules used by `void db seed`.

```ts
import { defineSeed } from 'void/seed';

export default defineSeed<typeof import('./schema')>(async ({ db, schema }) => {
  await db.insert(schema.users).values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ]);
});
```

The callback receives:

- `dialect`: `"sqlite"` or `"postgresql"`
- `db`: a local Drizzle instance for the active dialect
- `schema`: the exports from `db/schema.ts` or `db/schema/`

Seed modules can export either `default` or a named `seed` function.

## Types

### `CloudContext`

Hono `Context` pre-typed with [`CloudEnv`](#cloudenv). This is the type of the `c` parameter in all route handlers and middleware.

```ts
import type { CloudContext } from 'void';
```

### `CloudEnv`

Hono environment type for Void workers. Extends Hono's `Env` with Cloudflare bindings and context variables.

```ts
interface CloudEnv extends Env {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AI: Ai;
    SANDBOX: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
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
declare module 'void' {
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

Empty stub interface augmented at build time by the generated `.void/routes.d.ts`. It contains the full type information for routes, methods, inputs, and outputs, and the typed `fetch` client reads from it.

```ts
import type { RouteMap } from 'void/routes';
```

## Environment Types

Importing `"void/env"` provides global Cloudflare environment types:

```ts
/// <reference types="void/env" />
```

Declares the `Cloudflare.Env` namespace with `DB`, `KV`, `STORAGE`, `AI`, and `SANDBOX` binding types.

For handler context variables such as `c.set()` and `c.get()`, augment [`CloudContextVariables`](#cloudcontextvariables). This is separate from `Cloudflare.Env`, which types worker bindings. Framework adapters such as `@void/vue`, `@void/react`, and `@void/svelte` also augment `CloudContextVariables` to add the `shared` key used by `useShared()`.

## Framework Adaptors

Framework adaptors for [Pages Routing](../guide/pages-routing/overview). Each adaptor provides a Vite plugin and client-side runtime.

### `@void/vue`

#### `voidVue(options?)`

Imported from `"@void/vue/plugin"`. Returns an array of Vite plugins that handle Vue SFC compilation and SSR or hydration entry generation. It already includes `@vitejs/plugin-vue`, so you do not need to install or configure that separately.

```ts
import { voidVue } from '@void/vue/plugin';

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

Imported from `"@void/vue"`.

| Export                             | Description                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Vue component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `useRouter()`                      | Returns the Pages router with current route state (`url`, `path`, `query`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`.                                                                                 |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                             |
| `useForm(url, defaults, options?)` | Typed reactive form helper bound to a page action URL. Returns `{ data, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                       |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                          |

Vue `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

### `@void/react`

#### `voidReact(options?)`

Imported from `"@void/react/plugin"`. Returns an array of Vite plugins that handle SSR and hydration entry generation. It already includes `@vitejs/plugin-react`, so you do not need to install or configure that separately.

```ts
import { voidReact } from '@void/react/plugin';

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
  viewTransitions?: boolean; // enable View Transitions API for navigations
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

#### React Runtime

Imported from `"@void/react"`.

| Export                             | Description                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | React component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `useRouter()`                      | Returns the Pages router with current route state (`url`, `path`, `query`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`. React navigations are scheduled as transitions.                                   |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                               |
| `useForm(url, defaults, options?)` | Form helper hook. Returns `{ data, setData, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                                                     |
| `action(url, options?)`            | Awaitable one-shot page action helper. Uses `POST` by default and accepts `{ data, method, params }`, where `method` can be `"PUT"`, `"PATCH"`, or `"DELETE"`. Returns an `ActionResult`.                                                           |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                            |
| `Deferred<T>`                      | React-only prop type for `defer()` results. It is `Promise<T>` and is consumed with React `use()`.                                                                                                                                                  |

React `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

React deferred props returned from `defer()` are Suspense resources. Read them
with React's `use()` inside a `<Suspense>` boundary. React Pages requires React
19 and uses streaming SSR for the initial deferred shell. Rejections throw from
`use()`, so use a normal React error boundary for custom deferred error UI. Vue,
Svelte, and Solid keep the `{ loading, value, error }` deferred state object.
When explicitly annotating props, import `Deferred` from the framework adapter
package (`@void/react`, `@void/vue`, `@void/svelte`, or `@void/solid`) so the
type matches that adapter's client runtime shape.

### `@void/svelte`

#### `voidSvelte(options?)`

Imported from `"@void/svelte/plugin"`. Returns an array of Vite plugins that handle SSR and hydration entry generation for Svelte 5. It already includes `@sveltejs/vite-plugin-svelte`, so you do not need to install or configure that separately.

```ts
import { voidSvelte } from '@void/svelte/plugin';

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

Imported from `"@void/svelte"`.

| Export                             | Description                                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Svelte component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `useForm(url, defaults, options?)` | Form helper using Svelte 5 runes. Returns `{ data, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                                               |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                             |
| `useRouter()`                      | Returns the Pages router with current route state (`url`, `path`, `query`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`.                                                                                    |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                                |

Svelte `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

### `@void/solid`

#### `voidSolid(options?)`

Imported from `"@void/solid/plugin"`. Returns an array of Vite plugins that handle SSR and hydration entry generation for Solid. It already includes `vite-plugin-solid`, so you do not need to install or configure that separately.

```ts
import { voidSolid } from '@void/solid/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

**Signature:**

```ts
function voidSolid(options?: VoidSolidOptions): Plugin[];
```

**Options:**

```ts
interface VoidSolidOptions {
  solid?: SolidPluginOptions; // passed through to vite-plugin-solid
  viewTransitions?: boolean; // enable View Transitions API
}
```

#### Solid Runtime

Imported from `"@void/solid"`.

| Export                             | Description                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Solid component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `useForm(url, defaults, options?)` | Form helper using Solid stores. Returns `{ data, setData, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                                       |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                            |
| `useRouter()`                      | Returns the Pages router with current route state (`url`, `path`, `query`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`.                                                                                   |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                               |

Solid `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

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
| `void/drizzle-zod`     | Re-exports [`drizzle-zod`](https://orm.drizzle.team/docs/zod) for schema-derived Zod validators for Drizzle tables                                               |
| `void/drizzle-valibot` | Re-exports [`drizzle-valibot`](https://orm.drizzle.team/docs/typebox) for schema-derived Valibot validators for Drizzle tables                                   |
| `void/drizzle-arktype` | Re-exports [`drizzle-arktype`](https://orm.drizzle.team/docs/arktype) for schema-derived ArkType validators for Drizzle tables                                   |
| `void/schema-d1`       | Re-exports [`drizzle-orm/sqlite-core`](https://orm.drizzle.team/docs/column-types/sqlite) for D1 table and column builders                                       |
| `void/schema-pg`       | Re-exports [`drizzle-orm/pg-core`](https://orm.drizzle.team/docs/column-types/pg) for PostgreSQL table and column builders                                       |
| `void/db`              | `db` ([Drizzle D1](https://orm.drizzle.team/docs/get-started/d1-new) instance), `createDb`, query operators (`eq`, `and`, `or`, `desc`, `like`, `inArray`, etc.) |
| `void/seed`            | `defineSeed`, `SeedContext`, `SeedFn` for programmatic `void db seed` modules                                                                                    |
| `void/routes`          | `RouteMap` and `WebSocketRouteMap` stubs (types only)                                                                                                            |
| `void/queues`          | `queues` proxy for sending messages to typed queues                                                                                                              |
| `void/sandbox`         | `getSandbox`, `sandbox`, `Sandbox`, and sandbox option types from the Cloudflare Sandbox SDK                                                                     |
| `void/env`             | Global Cloudflare env types (types only)                                                                                                                         |
