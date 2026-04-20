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

**Loop prevention:** Single-hop rewrite loops are prevented automatically. When `c.rewrite('/foo')` re-dispatches the request, the runtime tracks that request object internally so static routing rules are skipped on the second pass — even if `/foo` would itself match a rewrite rule, it won't rewrite again. The re-dispatched request also carries an `X-Void-Rewritten: 1` header for observability, but the guard does not rely on it (client-supplied headers cannot bypass routing rules).

What the guard **doesn't** catch are multi-hop user-written loops across separate middleware: middleware A rewrites `/a → /b`, middleware B rewrites `/b → /c`, middleware C rewrites `/c → /a`. Each hop constructs a fresh `Request`, so the per-request guard can't see the cycle. If you chain rewrites across middleware, write each hop so it only rewrites paths that aren't already in its target shape.

Also avoid deep rewrite chains for performance: every hop re-runs all middleware from the top, so `/a → /b → /c → /d` costs four router passes.

::: tip
This is the recommended approach for i18n libraries. The library can export a middleware factory that handles locale detection and rewriting, and users just drop it into their `middleware/` directory.
:::

## Original URL access

When a static rewrite rule matches at the edge, the platform sets an `X-Void-Original-URL` header on the request forwarded to the worker. This lets your app access the original URL for canonical links, locale detection, or building correct hrefs:

```ts
export default defineHandler((c) => {
  const originalUrl = c.req.header('X-Void-Original-URL');
  // originalUrl is the full URL the user requested before the rewrite
});
```

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
