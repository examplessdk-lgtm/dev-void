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

- `31536000` (1 year): effectively cached until the next deploy, since deploys clear the ISR cache
- `0`: never cached and always rendered by the worker, which is equivalent to plain SSR for that path

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

## Caveat: cache keys follow rewrites

If a request is rewritten (via `routing.rewrites`, `routing.fallbacks`, `_redirects` 200/200!, or `c.rewrite()`), the ISR cache key is the **rewritten** pathname — not the URL the user requested. So `/docs/foo` rewritten to `/en/docs/foo` caches under `/en/docs/foo`, and `revalidate({ paths: ['/docs/foo'] })` won't invalidate it. Pass the destination path instead.

This is a known limitation. See the [rewrites caveat](./rewrites#caveat-isr-cache-keys-use-the-rewritten-url) for details.

**Migration note:** if you introduce a new rewrite on an existing project that was already serving ISR traffic, expect a one-time cache-miss wave on the first deploy. Cache entries written under the original pathname become unreachable — the cache key now follows the rewritten path — so early requests re-render until the new key warms up. The miss window is proportional to your traffic and TTL; no manual purge is required.

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
