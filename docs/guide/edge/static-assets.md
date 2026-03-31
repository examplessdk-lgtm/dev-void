---
outline: deep
---

# Static Assets Caching

Void serves static assets through Cloudflare's global edge network with sensible cache defaults. This page covers how static assets are cached at the edge.

## Hashed assets

Files in Vite's `build.assetsDir` (default `assets/`) are produced with content hashes in the filename, such as `assets/app-Ab3xK9.js`. These files are immutable because the filename changes whenever the content changes, so they get aggressive caching:

```
Cache-Control: public, max-age=31536000, immutable
```

Cached at the edge for up to one year. Browsers cache them indefinitely. Because the cache key is unversioned, hashed assets survive across deploys without re-fetching.

If your Vite config customizes `build.assetsDir`, Void automatically detects this and applies the immutable optimization to the configured directory:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    assetsDir: "static", // hashed assets go to dist/client/static/
  },
});
```

If `build.assetsDir` is set to `""`, meaning hashed files live at the root, the optimization is skipped because there is no directory-based way to distinguish hashed from non-hashed files.

Void also includes presets for where supported meta frameworks (Astro, Nuxt, SvelteKit, etc.) place their hashed assets, so framework-generated assets enjoy optimal caching out of the box.

## Non-hashed assets

Everything else such as `index.html`, `favicon.ico`, and `/about` is edge-cached using deploy-versioned cache keys. On each deploy, the version changes and previous cache entries are invalidated automatically, so there is nothing to purge.

```
Cache-Control: public, s-maxage=31536000, max-age=0, must-revalidate
```

Cached at the edge until the next deploy. Browsers always revalidate on the next request.

**What gets cached:**

- All `GET` requests for non-SSR projects such as SPAs and static sites
- GET requests with file extensions (`.ico`, `.png`, `.css`, etc.) in SSR projects

**What does NOT get cached:**

- `/api/*` routes, which always hit the worker
- SSR-rendered pages (paths without file extensions in SSR projects)
- Non-GET requests
- Non-2xx responses

### Opting out

If your worker serves dynamic content at a URL that looks static (e.g., a dynamically generated image at `/avatar.jpg`), you can prevent caching by setting `Cache-Control: private` or `Cache-Control: no-store` in your response headers. Any response with `Cache-Control` containing `private`, `no-store`, or `no-cache` will bypass the edge cache.

## ETags and 304 Not Modified

All static asset responses include an `ETag` header derived from the file's content hash in R2. When a browser revalidates a cached resource, it sends `If-None-Match` with the previous ETag. If the file has not changed, the edge returns **304 Not Modified** with no body. That saves bandwidth and speeds up page loads.

This happens automatically for all static assets. No configuration is needed.

## Custom headers

You can override caching headers or add your own for any static asset path using [Custom Headers](./headers).

## API routes and SSR pages

API responses (`/api/*`) and SSR-rendered pages without file extensions always hit the worker. They are **not** edge-cached by the dispatch layer.
