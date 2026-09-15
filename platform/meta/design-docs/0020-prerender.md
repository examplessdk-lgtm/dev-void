# ISR Prerendering at Deploy Time

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-22
**Status:** Implemented

---

## Summary

SSR pages with long `revalidate` values (e.g. 1 year) are effectively static, but the first visitor after each deploy hits a cold cache — the worker must render the page before the ISR cache is populated. This causes a performance hit for the first user and potential load spikes after redeploying during busy hours.

Since we control the full stack, we can prerender these pages on the platform side: after uploading the worker but before flipping the routing entry live, the platform renders each prerender path and writes the result to R2 as an ISR cache entry. By the time the deploy goes live, the cache is already warm.

This also restructures `void.json` to group caching concerns under a `cache` key (breaking: top-level `revalidate` removed, no backwards compat).

---

## User-Facing API

### Config — `void.json`

```json
{
  "cache": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "*": 30
    }
  }
}
```

`cache.revalidate` replaces the old top-level `revalidate` (breaking change). No `prerender` key in config — prerender paths come exclusively from code exports.

### Pages mode — static pages

```ts
// pages/about.server.ts
export const prerender = true;

export function loader(c) {
  return c.render({ title: 'About Us' });
}
```

Static pages (no route params) with `export const prerender = true` are automatically prerendered at deploy time. The path is inferred from the page file location.

### Pages mode — dynamic pages

```ts
// pages/blog/[slug].server.ts
export const prerender = true;

export async function getPrerenderPaths() {
  const posts = await fetch('https://cms.example.com/posts').then((r) => r.json());
  return posts.map((p) => ({ slug: p.slug }));
}

export function loader({ params }) {
  // ...
}
```

Dynamic pages export `getPrerenderPaths()` which returns an array of param objects. The CLI resolves these to concrete paths at deploy time (e.g. `{ slug: "hello" }` + `/blog/:slug` → `/blog/hello`).

`getPrerenderPaths()` is executed via `vite.ssrLoadModule()` during the deploy pipeline — it has access to the full module resolution environment (aliases, imports, etc.) and can make network requests to external APIs.

### Custom SSR mode

```ts
// src/main.ssr.ts
export const prerender = true;

export async function getPrerenderPaths() {
  const pages = await fetch('https://cms.example.com/pages').then((r) => r.json());
  return ['/', '/about', ...pages.map((p) => `/${p.slug}`)];
}

export default defineRender(async (c, assetTags) => {
  // ...
});
```

Custom SSR entries export `getPrerenderPaths()` returning full path strings (not param objects) since there's no file-based routing.

### Precedence / merging

All prerender path sources are merged and deduped:

1. Per-page `export const prerender = true` (static pages, auto-inferred path)
2. Per-page `getPrerenderPaths()` (dynamic pages, param objects → paths)
3. SSR entry `getPrerenderPaths()` (full paths)

Only paths with a positive revalidate TTL are actually prerendered. Paths that resolve to TTL <= 0 are skipped.

---

## Architecture

### Deploy pipeline

```
Current:  upload worker → clear ISR cache → update KV routing → live
New:      upload worker → clear ISR cache → PRERENDER → update KV routing → live
```

Prerendering happens on the platform side, after the worker is uploaded but before traffic is routed to it.

### CLI-side: path resolution

During `void deploy`, the CLI:

1. Scans pages for `export const prerender = true` and `export function getPrerenderPaths` (regex detection, same as `revalidate`)
2. Checks the SSR entry for the same exports
3. For static pages: adds the page pattern directly
4. For dynamic pages / SSR entry: creates a Vite dev server in middleware mode, uses `ssrLoadModule()` to execute `getPrerenderPaths()`, converts results to paths
5. Passes the resolved `prerender: string[]` array in the deploy manifest

Failures in `getPrerenderPaths()` log a warning and continue — never block the deploy.

### Platform-side: rendering

For each path in `manifest.prerender`:

1. Resolve TTL via path matching against `manifest.revalidate` — skip if TTL <= 0
2. Invoke user worker via dispatch namespace: `env.DISPATCH.get(workerName).fetch(new Request(url))`
3. On 2xx: check `x-revalidate` header for TTL override, write response body + metadata to R2 as ISR cache entry (same format as dispatch's `writeIsrCache`)
4. On failure: log error, continue to next path

Concurrency: 3 concurrent requests via `uploadPool()`.

New deployment status: `"prerendering"` (between `"uploading"` and `"live"`).

### R2 cache entry format

Same as existing ISR entries written by dispatch:

- Key: `{projectId}/isr/{normalizedPath}`
- Body: response body
- Custom metadata: `{ status, createdAt, ttl, headers }`
