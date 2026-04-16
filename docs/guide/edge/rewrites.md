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

For dynamic rewrite logic — like i18n locale negotiation based on cookies or headers — use the `rewrite()` utility in middleware:

```ts
import { defineMiddleware, rewrite } from 'void';

export default defineMiddleware(async (c, next) => {
  const locale = detectLocale(c.req);
  if (!c.req.path.match(/^\/(en|zh-CN)\//)) {
    return rewrite(c, `/${locale}${c.req.path}`);
  }
  return next();
});
```

`rewrite(c, path)` re-dispatches the request through the router with the new pathname. You must `return` the result (same pattern as `c.redirect()`).

**Loop prevention:** The re-dispatched request is tracked internally so that static routing rules do not re-evaluate on it. The request also carries an `X-Void-Rewritten` header for observability, but the loop guard does not rely on it (client-supplied headers cannot bypass routing rules). Your middleware is responsible for its own loop prevention — typically by checking whether the path already has the expected prefix before rewriting.

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

## `_redirects` file

Rewrites can also be defined in a `_redirects` file using status `200`:

```text
/ /en 200
/docs/* /en/docs/:splat 200
```

- File-based rules are applied **before** `void.json` rules. Since the last match wins, `routing.rewrites` in `void.json` takes precedence.
- The `_redirects` file can contain both redirects (3xx) and rewrites (200). Ordering is preserved.

## How rewrites work

**Static rewrites** (`void.json` and `_redirects` file):

1. `void deploy` reads rewrite rules from the `_redirects` file (status `200` entries) and `routing.rewrites` in `void.json`, then includes them in the deploy manifest alongside redirect rules.
2. The platform stores the rules in the KV routing entry for your project.
3. The dispatch worker evaluates all routing rules (redirects and rewrites) before any worker invocation. If a rewrite matches, the request pathname is updated internally and the request continues through the normal pipeline (static assets, ISR, worker). The original URL is passed as `X-Void-Original-URL`.

**Middleware rewrites** (`rewrite()` function):

1. The request reaches the worker with its original (or edge-rewritten) pathname.
2. Your middleware calls `rewrite(c, newPath)`, which constructs a new request with the rewritten pathname and re-dispatches it through the Hono router.
3. The re-dispatched request runs through all middleware and route handlers as if it were a fresh request to the new path.

Static rewrites are evaluated at the edge (zero-cost). Middleware rewrites run inside the worker (adds a re-dispatch but enables dynamic logic).
