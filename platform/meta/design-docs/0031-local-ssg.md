# Local SSG (Static Output Mode)

**Date:** 2026-02-27
**Status:** Draft

---

## Summary

Add an `output` option to `void.json` that controls the default rendering strategy:

- **`"server"`** (default) — all pages are server-rendered on request. `export const prerender = true` opts individual pages into deploy-time ISR prerendering (current behavior).
- **`"static"`** — all pages are prerendered at build time as static HTML. `export const prerender = false` opts individual pages out. The prerendered HTML files are written to `dist/client/` during `vite build` and deployed as static assets.

This aligns with [Astro's output modes](https://docs.astro.build/en/guides/on-demand-rendering/) and enables self-hosting, portable builds, and faster deploys for content-heavy sites.

---

## Motivation

Currently, prerendering only happens at deploy time on the Void platform — the API invokes the uploaded worker and writes results to R2. This has two limitations:

1. **No self-hosting** — the prerender step is platform-specific. Users deploying outside Void (e.g. `wrangler deploy`) don't get prerendered pages.
2. **No local preview** — developers can't see the prerendered output before deploying.

Local SSG solves both: `vite build` produces a self-contained output with prerendered HTML files that work anywhere static assets are served.

---

## User-Facing API

### Config — `void.json`

```json
{
  "output": "static"
}
```

| Value                | Default prerender | Per-page override                | Prerender timing             |
| -------------------- | ----------------- | -------------------------------- | ---------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR)   |
| `"static"`           | `true`            | `export const prerender = false` | Build-time (local Miniflare) |

When omitted, `output` defaults to `"server"` — no behavior change for existing projects.

### Per-page override

The `prerender` export flips the default for that page, regardless of output mode:

```ts
// In output: "static" — opt this page OUT of prerendering
export const prerender = false;
```

```ts
// In output: "server" — opt this page IN to prerendering
export const prerender = true;
```

### Dynamic pages

`getPrerenderPaths()` works the same in both modes. In `output: "static"`, dynamic pages without `getPrerenderPaths()` are implicitly `prerender = false` (can't prerender without knowing the paths).

### Island auto-prerender

In `output: "server"`, the existing auto-prerender logic for island pages (no loader, no params) is unchanged. In `output: "static"`, all pages are prerendered by default, so the auto-prerender logic is subsumed — it only matters for the opt-out case (`export const prerender = false`).

---

## Architecture

### Build-time prerender flow

The prerender step runs in a Vite `writeBundle` hook, after the worker bundle is written to disk:

```
vite build
  │
  ├─ Build worker → dist/<workerDir>/index.js
  ├─ Build client → dist/client/
  │
  └─ writeBundle hook (if output: "static")
       │
       ├─ 1. Collect prerender paths
       │     • Static pages: infer from file pattern
       │     • Dynamic pages: call getPrerenderPaths() via ssrLoadModule
       │     • Custom SSR: call getPrerenderPaths() from entry
       │
       ├─ 2. Create Miniflare with built worker
       │     • Script: dist/<workerDir>/index.js
       │     • Bindings: from wrangler.json
       │     • Persistence: .void/ (same as dev)
       │     • Env vars: from .dev.vars
       │
       ├─ 3. Render each path
       │     • dispatchFetch("http://localhost{path}")
       │     • Write response body to dist/client/{path}.html
       │     • Log failures, continue (non-blocking)
       │
       └─ 4. Dispose Miniflare
```

### Output format

Prerendered pages are written as HTML files in `dist/client/`:

| Route                   | Output file                             |
| ----------------------- | --------------------------------------- |
| `/`                     | `dist/client/index.html`                |
| `/about`                | `dist/client/about.html`                |
| `/blog/hello`           | `dist/client/blog/hello.html`           |
| `/docs/getting-started` | `dist/client/docs/getting-started.html` |

Cloudflare Workers static assets with `html_handling: "auto-trailing-slash"` serves these for clean URLs (e.g. `/about` serves `about.html`).

### Interaction with deploy-time prerender

When `output: "static"`:

- Prerendered pages are already static assets in the build output
- The deploy manifest's `prerender` array is empty (no deploy-time prerender needed)
- The platform serves them as static files, bypassing the worker entirely

When `output: "server"` (default):

- No change — `export const prerender = true` pages are prerendered at deploy time via ISR, same as today

### Interaction with ISR / revalidation

`output: "static"` pages are truly static — no ISR, no revalidation, no TTL. They are regenerated on the next build/deploy. The `revalidate` export is ignored for statically-rendered pages.

Pages that opt out (`export const prerender = false`) in static mode are server-rendered on request and can use `revalidate` for ISR caching as usual.

---

## Implementation

### 1. Config changes (`src/config.ts`)

Add `output?: "server" | "static"` to `VoidConfig`. Default: `"server"`. Add validation.

### 2. Page scanning (`src/pages/scan.ts`)

When `output: "static"`:

- Default `prerender` to `true` for all pages (instead of `false`)
- Pages with `export const prerender = false` are excluded
- Dynamic pages without `getPrerenderPaths()` default to `prerender = false`

### 3. Build-time prerender (`src/prerender.ts` — new file)

Core function:

```ts
async function prerenderPages(options: {
  workerPath: string; // dist/<workerDir>/index.js
  clientDir: string; // dist/client/
  paths: string[]; // ["/", "/about", "/blog/hello", ...]
  persistDir: string; // .void/
  wranglerConfig: object; // parsed wrangler.json bindings
}): Promise<{ rendered: string[]; failed: string[] }>;
```

- Creates a Miniflare instance with the built worker module
- Uses `.void/` persistence for D1, KV, R2 (same local data as dev)
- Loads `.dev.vars` for environment variables
- Requests each path via `dispatchFetch()`
- Writes successful responses as HTML to `clientDir`
- Returns lists of rendered and failed paths for logging

### 4. Vite plugin integration (`src/index.ts`)

Add a `writeBundle` hook to the routing plugin that:

- Checks if `output: "static"` (from resolved config)
- Collects prerender paths (reuse existing path collection logic from deploy.ts)
- Calls `prerenderPages()`
- Logs results

### 5. Deploy manifest adjustment (`src/cli/deploy.ts`)

When `output: "static"`:

- Omit `prerender` from the manifest (pages are already static assets)
- The platform skips the deploy-time prerender step

---

## Miniflare Configuration

The Miniflare instance needs to mirror the dev environment:

```ts
import { Miniflare } from 'miniflare';

const mf = new Miniflare({
  modules: [{ type: 'ESModule', path: workerPath }],
  d1Databases: { DB: { id: databaseId } },
  kvNamespaces: { KV: { id: kvId } },
  r2Buckets: { STORAGE: { id: storageId } },
  d1Persist: '.void',
  kvPersist: '.void',
  r2Persist: '.void',
});
```

Binding names and IDs are read from `wrangler.json` (generated by the Void plugin during build). The persist directory matches what `@cloudflare/vite-plugin` uses in dev, so the local data is the same.

---

## Edge Cases

1. **`index.html` conflict** — Pages/Islands mode apps don't generate a client `index.html` (only SPAs do). SPA apps wouldn't use `output: "static"` since their pages are client-rendered. No conflict expected.

2. **Pages that need production data** — Local SSG uses local D1/KV data. Pages that depend on production data should use `export const prerender = false` and rely on server rendering or ISR.

3. **`getPrerenderPaths()` failures** — Logged as warnings, page is skipped. Non-blocking, same as deploy-time prerender.

4. **AI binding** — Workers AI requires network access. Pages using AI should opt out of prerendering or ensure the AI calls are not in the prerender path.

5. **Existing `mode: "ssg"`** — The existing `mode` field describes app type (SPA vs SSG vs fullstack), not rendering strategy. `mode: "ssg"` is for deploying pre-built static sites (VitePress, etc.) with no worker. The new `output` field is orthogonal — it controls whether a fullstack Void app prerenders at build time.

---

## Relationship to existing `mode: "ssg"`

|              | `mode: "ssg"`                                   | `output: "static"`                   |
| ------------ | ----------------------------------------------- | ------------------------------------ |
| **What**     | Deploy a pre-built static site (no Void plugin) | Prerender a Void app at build time   |
| **Worker**   | None (static assets only)                       | Yes (for non-prerendered routes)     |
| **Use case** | VitePress, plain HTML, external SSG tools       | Void apps with mostly static content |
| **Build**    | External build command                          | `vite build` with Void plugin        |
