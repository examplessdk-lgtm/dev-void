# Dispatch-Level Hashed Asset Caching

**Date:** 2026-03-01
**Status:** Implemented

> **Note (2026-04-23):** This caching layer now also fronts the WfP asset safety-net fallback introduced in [0066-wfp-asset-r2-fallback](./0066-wfp-asset-r2-fallback.md). When dispatch falls back to the platform R2/KV mirror for a poisoned asset, the successful response enters the same `caches.default` layer (versioned by `assetManifestId`) described below.

---

## Summary

Move edge caching of hashed static assets from the user worker (`serveWithAssets`) to the dispatch worker. Dispatch already performs a KV lookup on every request — adding a path prefix check is essentially free. On cache hit, the user worker is never invoked, eliminating WfP invocation cost for the most common static asset requests.

---

## Problem

With `run_worker_first: ["/**"]`, every request — including static assets — invokes the user worker via Workers for Platforms. The `serveWithAssets` helper checks the Cache API inside the user worker, but the worker is still invoked on every request. For hashed assets (JS bundles, CSS, images with content hashes), the content never changes, yet we pay WfP invocation cost every time.

---

## Design

### Scope: hashed assets only

Only assets under the hashed prefix (`/{hashedAssetsPrefix}/`) are cached at dispatch. These have content-hash URLs that change on every build, so immutable caching is safe with no invalidation needed.

Non-hashed assets (`favicon.ico`, `robots.txt`, `public/` files) continue through the user worker. Dispatch can't distinguish these from app routes without an R2 lookup, which would add latency to every request. These are low-volume and not worth optimizing.

### Request flow

```
Request → Dispatch
  → KV lookup (already happens) → get hashedAssetsPrefix
  → GET request + path starts with /{hashedAssetsPrefix}/?
    → YES:
      → Normalize cache key (strip query string)
      → caches.default.match(cacheKey)
      → HIT (with immutable header): return cached response (user worker never invoked)
      → HIT (stale/non-immutable): treat as miss (Workers Assets may have pre-existing entries)
      → MISS: invoke user worker → get response
        → set Cache-Control: public, max-age=31536000, immutable
        → ctx.waitUntil(cache.put(cacheKey, response.clone()))
        → return response
    → NO: normal flow (invoke user worker)
```

### Data flow: `hashedAssetsPrefix` through the pipeline

```
Framework preset / void.json → DeployManifest → API → KV RoutingEntry → Dispatch
```

The hashed assets prefix varies by framework:

| Framework      | `hashedAssetsPrefix`    |
| -------------- | ----------------------- |
| Void (Class A) | `assets` (Vite default) |
| SvelteKit      | `_app/immutable`        |
| Nuxt           | `_nuxt`                 |
| Astro          | `_astro`                |

---

## Changes

### 1. `DeployManifest` (framework)

Add optional field:

```typescript
export type DeployManifest = {
  // ... existing fields ...
  hashedAssetsPrefix?: string;
};
```

### 2. Deploy CLI (framework)

Set `hashedAssetsPrefix` from framework preset (`hashedAssetsPrefix` field) or Vite config (`build.assetsDir`, default `"assets"`).

### 3. API deploy endpoint

Read `hashedAssetsPrefix` from the manifest and include it in the KV routing entry written during deploy.

### 4. `RoutingEntry` (dispatch)

Add optional field:

```typescript
type RoutingEntry = {
  // ... existing fields ...
  hashedAssetsPrefix?: string;
};
```

### 5. Dispatch `fetch()`

Before routing to the user worker, check if the request is a GET for a hashed asset:

```typescript
if (request.method === 'GET' && routing.hashedAssetsPrefix) {
  const prefix = '/' + routing.hashedAssetsPrefix + '/';
  if (pathname.startsWith(prefix)) {
    // Normalize cache key: strip query strings — hashed filenames are content-addressed
    const cacheUrl = new URL(request.url);
    cacheUrl.search = '';
    const cacheKey = new Request(cacheUrl.toString());

    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    // Only serve from cache if it's our entry (has immutable header).
    // Workers Assets may have pre-existing entries with short-lived cache headers.
    if (cached?.headers.get('Cache-Control')?.includes('immutable')) {
      return meter(cached);
    }
    // Cache miss — invoke worker, cache immutable response
    try {
      const worker = getWorker(env, routing);
      const response = await worker.fetch(request);
      if (response.ok) {
        const res = new Response(response.body, response);
        res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return meter(res);
      }
      return meter(response);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Worker exceeded')) {
        return meter(Response.json({ error: 'CPU limit exceeded' }, { status: 429 }));
      }
      throw err;
    }
  }
}
```

### 6. `serveWithAssets` (framework)

Revert to simple version — set `Cache-Control` headers on asset responses (for browser caching) but remove programmatic Cache API usage. The edge caching now happens at dispatch.

```javascript
async function serveWithAssets(request, env, response) {
  if (response.status !== 404 || !env.ASSETS) return response;
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return response;
  const res = new Response(asset.body, asset);
  if (new URL(request.url).pathname.startsWith('/{assetsDir}/')) {
    res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.headers.set('Cache-Control', 'public, s-maxage=60, max-age=0, must-revalidate');
  }
  return res;
}
```

---

## What stays the same

- **ISR** — untouched, separate L1/L2 cache in dispatch
- **Non-hashed assets** — served by user worker via ASSETS binding
- **Metering** — dispatch still records the request before the cache check returns
- **`_headers` files** — parsed at deploy time (not generated), rules sent through manifest → KV → dispatch
- **Cache invalidation** — not needed; hashed URLs change on content change
- **Node/Bun/Deno targets** — don't use `serveWithAssets` or dispatch

---

## Edge cases

- **No `hashedAssetsPrefix` in KV** — old deploys without the field: dispatch skips the optimization, falls through to user worker. Fully backward-compatible.
- **Cache eviction** — CF edge caches evict based on popularity. Low-traffic assets get evicted → cache miss → user worker → re-cache. Fine.
- **HEAD/OPTIONS requests** — only cache GETs. Everything else goes through the user worker.
- **Worker returns non-200** — don't cache error responses. Only cache `response.ok`.
- **Query string fragmentation** — cache keys are normalized to strip query strings. Hashed filenames are content-addressed, so `?v=1` and `?v=2` resolve to the same cache entry.
- **Stale `caches.default` entries** — Workers Assets writes its own entries to the zone CDN cache (same as `caches.default`) with short-lived `Cache-Control` headers. On cache hit, dispatch checks for the `immutable` directive before serving — stale Workers Assets entries are treated as cache misses.
- **Worker CPU limit exceeded** — the worker fetch in the hashed-asset block is wrapped in try/catch. CPU limit errors return a metered 429, consistent with the main dispatch path.
- **Static-only sites** — `packageStaticBuild` sets `hashedAssetsPrefix` on the manifest (defaults to `"assets"`), so purely static deployments (VitePress, SPAs) also benefit from dispatch-level caching.

---

## Deploy path coverage

All three packaging functions set `hashedAssetsPrefix` on the manifest:

| Deploy path                | Packaging function      | Prefix source                                                                  |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Class A (void native)      | `packageBuild`          | Detected from Vite client manifest (`build.assetsDir`), defaults to `"assets"` |
| Class B/C (meta-framework) | `packageFrameworkBuild` | `fwPreset.hashedAssetsPrefix ?? "assets"`                                      |
| Static (SPA/VitePress)     | `packageStaticBuild`    | Passed through `runStaticDeploy`, defaults to `"assets"`                       |

The API writes `hashedAssetsPrefix` to both slug and custom domain KV routing entries. All read-modify-write mutations (suspend, unsuspend, userId backfill, domain activation) preserve the field.
