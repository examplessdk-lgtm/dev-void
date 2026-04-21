---
outline: deep
---

# Rewrites

Define URL rewrites in [`void.json`](../../reference/config) using the `routing.rewrites` field. Keys are source URL patterns, values are destination paths. A rewrite serves content from the destination path **without changing the URL in the browser** — the user sees the original URL, but the server resolves content from the destination.

```json
{
  "routing": {
    "rewrites": {
      "/": "/en",
      "/docs": "/en/docs",
      "/docs/*": "/en/docs/:splat"
    }
  }
}
```

## When to use rewrites

Use rewrites instead of [redirects](./redirects) when you want to decouple the **public URL** from the **internal route** without the user seeing a URL change. Common scenarios:

- **i18n routing** — serve the default locale at unprefixed paths (`/docs` serves `/en/docs`)
- **URL restructuring** — reorganize internal route files without changing public URLs or SEO
- **Vanity URLs** — map `/pricing` to `/marketing/pricing-page` without exposing the internal structure
- **API versioning** — route `/api/users` to `/api/v3/users` internally so consumers use clean, unversioned endpoints
- **Incremental migration** — old URL structure continues working at the edge while route handlers move to new paths
- **Multi-app composition** — serve different internal apps under a unified URL namespace (e.g., `/docs/*` rewrites to a docs app, `/app/*` to the main app)

If you **do** want the user to see the new URL (e.g., for SEO canonical signals or moving a page permanently), use a [redirect](./redirects) instead.

## Rules

- **Source patterns** start with `/`. `*` matches any characters including `/`.
- **Destinations** are strings starting with `/` (only internal paths are supported).
- `:splat` in the destination is replaced with the portion of the path matched by `*` in the source pattern.
- When multiple rules match, the **last match wins**.
- Rewrites are evaluated at the edge **before** the request reaches the worker. The rewritten path is then used for static asset serving, ISR, and SSR.
- Unlike redirects, rewrites do **not** change the URL in the browser or send a `Location` header.

## Example: i18n routing

Define route files only under `[locale]/` and rewrite the default locale to unprefixed paths:

```json
{
  "routing": {
    "rewrites": {
      "/": "/en",
      "/docs": "/en/docs",
      "/docs/*": "/en/docs/:splat"
    }
  }
}
```

A request to `/docs/getting-started` serves the content from `/en/docs/getting-started`, but the browser URL stays at `/docs/getting-started`. Non-default locales like `/zh-CN/docs/getting-started` work as-is because they match the `[locale]/` route directly.

## Example: vanity URLs

Map short marketing URLs to internal route paths:

```json
{
  "routing": {
    "rewrites": {
      "/pricing": "/marketing/pricing-page",
      "/start": "/onboarding/get-started",
      "/jobs": "/company/careers"
    }
  }
}
```

## Example: API versioning

Route unversioned API paths to the current version internally:

```json
{
  "routing": {
    "rewrites": {
      "/api/users": "/api/v3/users",
      "/api/users/*": "/api/v3/users/:splat"
    }
  }
}
```

When v4 ships, update the rewrite — no client-side changes needed.

## Example: path restructuring

After reorganizing from `/blog/:slug` to `/posts/:slug`, keep the old URLs working:

```json
{
  "routing": {
    "rewrites": {
      "/blog/*": "/posts/:splat"
    }
  }
}
```

Unlike a redirect, users on `/blog/hello-world` won't see the URL change — they'll just see the content from `/posts/hello-world`.

## Programmatic rewrites in middleware

::: warning Cloudflare target only
`c.rewrite()`, `c.originalUrl()`, `c.isRewritten()`, and `routing.fallbacks` only work on the default Cloudflare target. `routing.rewrites` and `routing.redirects` work on every target (`node`, `bun`, `deno`, Cloudflare) via the router.
:::

For dynamic rewrite logic — like i18n locale negotiation based on cookies or headers — use `c.rewrite()` in middleware:

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  const locale = detectLocale(c.req);
  if (!c.req.path.match(/^\/(en|zh-CN)\//)) {
    return c.rewrite(`/${locale}${c.req.path}`);
  }
  return next();
});
```

`c.rewrite(path)` re-dispatches the request through the router with the new pathname. You must `return` the result — same shape as `c.redirect()`.

### Runtime caveat: unmanaged Hono contexts

`c.rewrite`, `c.originalUrl`, and `c.isRewritten` are only installed on Contexts created by Void's generated router — i.e. the Context that reaches a `defineHandler` or `defineMiddleware` export. TypeScript catches most misuse here: outside a Context whose `Env` extends `CloudEnv`, the helpers resolve to `never` and the call won't compile. If you manage to call them anyway — typically from inside a vanilla `new Hono()` sub-app whose env has been widened by third-party middleware — you'll get `TypeError: c.rewrite is not a function` at runtime, because the dispatcher that attaches the helpers never ran for that Context. Keep rewrite logic in top-level `defineMiddleware` handlers rather than inside mounted vanilla Hono apps.

### Runtime rewrites cannot reach static assets

`c.rewrite()` can only re-dispatch to paths the worker itself handles — routes, SSR entries, API handlers. It **cannot** re-dispatch into the static asset handler, because on Cloudflare assets are served by the platform before the worker runs. A call like `c.rewrite('/hero.png')` re-enters the worker's route table, doesn't match anything, and 404s.

Static rewrites are different: `_redirects` `200!` entries and `routing.rewrites` run at the platform layer **before** the asset handler, so they _can_ rewrite into assets. If you need "rewrite into an asset" behavior dynamically, model it as a static rule (possibly with a broader source pattern) rather than doing it from middleware.

**Loop prevention:** Single-hop rewrite loops are prevented automatically. When `c.rewrite('/foo')` re-dispatches the request, the runtime tracks that request object in an internal `WeakSet` so static routing rules are skipped on the second pass — even if `/foo` would itself match a rewrite rule, it won't rewrite again. The guard is identity-based on the in-memory `Request` object, so client-supplied headers cannot spoof or bypass it. The pre-rewrite URL is exposed to re-dispatched handlers via `X-Void-Original-URL` (see [Original URL access](#original-url-access)).

What the guard **doesn't** catch are multi-hop user-written loops across separate middleware: middleware A rewrites `/a → /b`, middleware B rewrites `/b → /c`, middleware C rewrites `/c → /a`. Each hop constructs a fresh `Request`, so the per-request guard can't see the cycle. If you chain rewrites across middleware, write each hop so it only rewrites paths that aren't already in its target shape.

Also avoid deep rewrite chains for performance: every hop re-runs all middleware from the top, so `/a → /b → /c → /d` costs four router passes.

### Side effects in re-dispatched middleware

Because every hop replays the full middleware stack, any side-effectful middleware fires twice (or N times for deep chains): DB lookups, session/auth checks, rate-limiter increments, and request loggers all double-count. For example, an auth middleware that logs every request will log twice for every rewritten request.

To skip idempotent-unsafe work on the second pass, use `c.isRewritten()`:

```ts
if (c.isRewritten()) return next();
```

`c.isRewritten()` returns `true` when the request was re-dispatched by a rewrite (whether from a static rule at the edge or `c.rewrite()` in middleware). It checks for the presence of the `X-Void-Original-URL` header that the runtime attaches on every rewrite hop; reach for the raw header only if you need to inspect it from outside a Void-managed context.

::: tip
This is the recommended approach for i18n libraries. The library can export a middleware factory that handles locale detection and rewriting, and users just drop it into their `middleware/` directory.
:::

## Original URL access

When a request has been rewritten — either by a static rule at the edge or by `c.rewrite()` in middleware — `c.originalUrl()` returns the URL the user originally requested. This is useful for canonical links, locale detection, and building correct hrefs:

```ts
export default defineHandler((c) => {
  const original = c.originalUrl();
  // original is the full URL the user requested before the rewrite,
  // or null if the request was not rewritten.
});
```

Internally this reads the `X-Void-Original-URL` header that Void sets on every rewrite hop. Use the helper in handler code; reach for the raw header only when you need to inspect it from outside a Void-managed context.

## Fallbacks

`routing.fallbacks` shares the same shape as `rewrites` but runs **only when no static asset or route matched** — i.e. the request would otherwise return a 404. This lets you add catch-all rewrites without preempting real routes.

```json
{
  "routing": {
    "fallbacks": {
      "/*": "/index.html"
    }
  }
}
```

Common uses:

- **SPA shell** — serve `/index.html` for any unmatched path so client-side routing can take over (for app types that don't already do this automatically).
- **Default-locale catch-all** — send unmatched paths to `/en/:splat` without stealing requests that already resolve to an existing page under `/zh-CN/…`, `/ja/…`, etc.

Ordering:

- `rewrites` are evaluated **before** the static asset lookup; a matching rule always wins.
- `fallbacks` are evaluated **after** the static asset lookup, only when it would 404.

Use `rewrites` when you want to force a path mapping regardless of what exists; use `fallbacks` when the rule should only kick in as a safety net.

### SPA app type + `routing.fallbacks`

For the `spa` app type, the platform already serves `/index.html` for any asset miss by default (`not_found_handling: 'single-page-application'`). Adding `routing.fallbacks` to a SPA app is **additive, not an override**:

1. Your `routing.fallbacks` rules are checked first, in the order they appear (last match wins among user rules).
2. If none of them match, the implicit `/* → /index.html` SPA fallback still fires.

So a SPA app can carve out specific paths without losing the SPA shell behavior for everything else:

```json
{
  "routing": {
    "fallbacks": {
      "/docs/*": "/docs.html"
    }
  }
}
```

With this config, an asset miss under `/docs/getting-started` resolves to `/docs.html`, while an asset miss under `/app/settings` still resolves to `/index.html` (the SPA default).

You don't need to write `"/*": "/index.html"` yourself — the CLI appends it automatically when packaging a SPA deploy that has user fallbacks. If you do write it, the CLI emits a warning on `void deploy` noting that the rule duplicates the default and can be omitted.

## `_redirects` file

Rewrites can also be defined in a `_redirects` file. Void mirrors Netlify / Cloudflare Pages semantics for the `200` status code:

```text
# plain 200 = fallback (asset-miss only, equivalent to routing.fallbacks)
/*         /index.html    200

# 200! with force suffix = always rewrite (equivalent to routing.rewrites)
/docs/*    /en/docs/:splat 200!
```

| File-based form | `void.json` equivalent | Behavior                                                                 |
| --------------- | ---------------------- | ------------------------------------------------------------------------ |
| `... 200`       | `routing.fallbacks`    | Fires only when no static asset and no route matched (would have 404'd). |
| `... 200!`      | `routing.rewrites`     | Always fires, overriding any static asset that would have served.        |

- File-based rules are applied **before** `void.json` rules. Since the last match wins, `routing.rewrites` / `routing.fallbacks` in `void.json` take precedence.
- The `_redirects` file can mix 3xx redirects, `200` fallbacks, and `200!` force rewrites. Ordering is preserved within each bucket.
- The `!` force suffix is only valid on `200`. Entries like `301!` are rejected with a warning — 3xx redirects always "force" by their nature (they change the URL), so the suffix is meaningless.

## Precedence: `_redirects` vs `void.json`

When the same source pattern appears in both a `_redirects` file and `void.json` (`routing.redirects` / `routing.rewrites` / `routing.fallbacks`), the rules don't replace each other — they **merge into a single ordered list per phase**, and the last match wins.

Rules are bucketed by phase before merging:

- **Pre-asset phase** (always fires, runs before static asset lookup): `_redirects` 3xx entries + `_redirects` `200!` entries + `routing.redirects` + `routing.rewrites`.
- **Post-asset phase** (only fires on an asset miss): `_redirects` plain `200` entries + `routing.fallbacks`. For SPA app types, the synthetic `/* → /index.html` rule is **prepended first** in this phase, so user fallbacks evaluated later override it under last-match-wins.

Within each phase, the order is always: **`_redirects` file rules first, then `void.json` rules**. Because evaluation is last-match-wins, **`void.json` rules override `_redirects` rules for the same source**. This holds even though `_redirects` is "closer to the build output" — intuitions like "file wins" or "whichever I wrote last in the file wins" are both wrong.

### Concrete example

```text
# _redirects
/docs/*    /en/docs/:splat    200!
```

```json
// void.json
{
  "routing": {
    "rewrites": {
      "/docs/*": "/handbook/:splat"
    }
  }
}
```

A request to `/docs/intro` matches both rules. Merged order is `[_redirects: /docs/* → /en/docs/:splat, void.json: /docs/* → /handbook/:splat]`, so `void.json` wins and the request resolves to `/handbook/intro`.

To confirm precedence in practice, check the [`X-Void-Routing` dev header](#debugging-with-x-void-routing) on any response during `vite dev` — it names the winning rule and its origin (`_redirects:<line>` vs `void.json#routing.rewrites`).

## How rewrites work

**Static rewrites** (`void.json` and `_redirects` file):

1. `void deploy` reads rewrite rules from the `_redirects` file (status `200` entries) and `routing.rewrites` in `void.json`, then includes them in the deploy manifest alongside redirect rules.
2. The platform stores the rules in the KV routing entry for your project.
3. The dispatch worker evaluates all routing rules (redirects and rewrites) before any worker invocation. If a rewrite matches, the request pathname is updated internally and the request continues through the normal pipeline (static assets, ISR, worker). The original URL is passed as `X-Void-Original-URL`.

**Middleware rewrites** (`c.rewrite()`):

1. The request reaches the worker with its original (or edge-rewritten) pathname.
2. Your middleware calls `c.rewrite(newPath)`, which constructs a new request with the rewritten pathname and re-dispatches it through the Hono router.
3. The re-dispatched request runs through all middleware and route handlers as if it were a fresh request to the new path.

Static rewrites are evaluated at the edge (zero-cost). Middleware rewrites run inside the worker (adds a re-dispatch but enables dynamic logic).

## Caveat: client navigation skips rewrites

Rewrites run on the server. A full HTTP request to `/docs` resolves through `routing.rewrites` and serves `/en/docs` content. But a client-side `<Link to="/docs">` navigation in Pages mode fetches loader data directly for `/docs` — the client router doesn't know about the server's rewrite table, so there's no lookup against `/en/docs` on that path.

In practice this only matters when the source and destination have **different loader behavior**. If `/docs` has no route handler but `/en/docs` does, clicking a `<Link to="/docs">` will fail where a fresh page load would succeed. The first render (server) and a subsequent client nav (CSR) to the same URL can diverge.

Two mitigations:

- Use a plain `<a href="/docs">` when you need the navigation to round-trip through the server (and therefore through rewrites).
- If the URL change is meant to be authoritative, use a [redirect](./redirects) instead — the client router follows redirects via HTTP, so behavior is consistent.

## Caveat: ISR cache keys use the rewritten URL

If you use [`routing.revalidate`](./revalidation) on a rewritten path, the cache key is the **rewritten** pathname, not the original. So a request to `/docs/foo` that rewrites to `/en/docs/foo` is cached under `/en/docs/foo`. Direct requests to `/docs/foo` aren't cached (they re-render every time), and `revalidate({ paths: ['/docs/foo'] })` invalidates nothing — you need to pass the rewritten path (`/en/docs/foo`).

This is a known limitation and will likely change in a future release. For now, if you rely on ISR for rewritten routes, invalidate against the destination path.

## Debugging with `X-Void-Routing`

During `vite dev`, every response carries an `X-Void-Routing` header that traces how the request was resolved. Open the Network tab in devtools and inspect the response headers:

```
X-Void-Routing: redirect[/old] → /new 301 (_redirects:12)
X-Void-Routing: rewrite[/api/*] → /backend/:splat (void.json#routing.rewrites)
X-Void-Routing: fallback[/docs/*] → /docs.html (void.json#routing.fallbacks)
X-Void-Routing: c.rewrite → /new-path (middleware)
X-Void-Routing: pass-through
```

Phases are separated by `→`. The parenthesised source hint points at the exact declaration — a line number for `_redirects`, a config path for `void.json`, or `spa-default` for the synthetic SPA catch-all. The header is **only emitted in dev** — production builds strip both the trace code and the per-rule `origin` metadata from the bundle and manifest.
