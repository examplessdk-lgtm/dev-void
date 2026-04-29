---
outline: deep
---

# Revalidation (ISR)

For SSR and [Pages mode](../pages-routing/overview) projects, Void supports stale-while-revalidate caching for dynamically rendered pages. Cached pages are served instantly from the edge while the worker re-renders in the background when the cache is stale. This is the equivalent of [Incremental Static Regeneration (ISR)](https://vercel.com/docs/incremental-static-regeneration) in other frameworks.

This requires [SSR](../ssr.md) or [Pages mode](../pages-routing/overview) to be configured.

## Enabling revalidation

Add a `routing.revalidate` field to `void.json` with a TTL in seconds:

```json
{
  "routing": {
    "revalidate": 60
  }
}
```

Setting `revalidate` to `0` disables revalidation (equivalent to plain SSR).

## Per-path revalidation

You can set different TTLs for different URL patterns using an object:

```json
{
  "routing": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "/user/*": 0,
      "*": 30
    }
  }
}
```

Rules are matched in order, and the first match wins. The `*` glob matches any characters including `/`.

Special values:

- `"deploy"` in structured rules: cached until the next deploy
- `0`: never cached and always rendered by the worker, which is equivalent to plain SSR for that path

## Query-aware and API revalidation

Use structured rules when a response varies by query string or when you want to cache an API/JSON endpoint:

```json
{
  "routing": {
    "revalidate": [
      { "pattern": "/products/*", "ttl": 300, "query": { "allow": ["color", "size"] } },
      { "pattern": "/api/badges/*", "ttl": 3600, "kind": "api", "query": true }
    ]
  }
}
```

`query: false` ignores query strings, `query: true` includes the full normalized query string, and `{ "allow": [...] }` includes only those parameters. API ISR only caches credential-free `GET` responses with safe public headers and JSON/text/XML/SVG content types.

## Per-page revalidation (Pages mode)

In [Pages mode](../pages-routing/overview), you can export a `revalidate` value from a `.server.ts` file to override the global config for that page:

```ts
// pages/products/index.server.ts
export const revalidate = 120; // cache for 2 minutes

export const loader = defineHandler(async (c) => {
  // ...
});
```

Per-page values take precedence over `void.json` patterns.

## Precedence

When multiple sources set a revalidate TTL, the most specific wins:

1. `x-revalidate` response header (per-response)
2. `.server.ts` export (per-page, Pages mode only)
3. `void.json` `routing.revalidate` path pattern match
4. `void.json` `routing.revalidate` global number or `"*"` fallback

## How revalidation works

1. **First request:** there is no cache entry yet. The worker renders the page, returns the response, and writes the result to KV in the background.

2. **Subsequent requests (fresh):** the cached response is served from the edge cache or KV. No worker call is needed.

3. **Subsequent requests (stale):** the stale cached response is served immediately, and the worker re-renders in the background. The next request gets the fresh version.

This means users never wait for a stale page to re-render. They always get an immediate response.

## Per-response TTL override

Route handlers can set the `x-revalidate` response header to override the TTL for a specific response:

```ts
export const GET = defineHandler(async (c) => {
  // Don't cache this particular response
  c.header('x-revalidate', '0');

  return c.html('...');
});
```

- `x-revalidate: 0`: skip caching for this response
- `x-revalidate: 300`: cache for 5 minutes instead of the default

Only successful responses (2xx) are cached.

## Cache bypass

Requests with `Cookie` or `Authorization` headers bypass the ISR cache entirely and always dispatch to the worker. This ensures personalized or authenticated pages are never served from a shared cache.

## On-demand revalidation

You can purge ISR cache entries programmatically from a route handler:

```ts
import { revalidate } from 'void/isr';

export const POST = defineHandler(async (c) => {
  // ... update content in database ...

  // Purge specific pages
  await revalidate({ paths: ['/', '/blog/hello-world'] });

  // Or purge all cached pages
  await revalidate({ all: true });

  return c.json({ ok: true });
});
```
