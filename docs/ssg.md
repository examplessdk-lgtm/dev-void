---
outline: deep
---

# Static Site Generation (SSG)

Set `output: "static"` in `void.json` to prerender all pages at build time:

```json
{
  "output": "static"
}
```

When `output` is `"static"`:

- All pages default to `prerender = true` — they are rendered during `vite build` and written as HTML files to `dist/client/`.
- Use `export const prerender = false` in a page's `.server.ts` to opt out — that page will be server-rendered on request.
- Dynamic pages without `getPrerenderPaths()` are implicitly not prerendered (the paths aren't known at build time).
- The build output is self-contained and works for `wrangler deploy`, self-hosting, or `void deploy`.

## How it works

During `vite build`, after both the worker and client bundles are written to disk, Void spins up Miniflare with the built worker and fetches each page. The HTML responses are written to `dist/client/` as static files (e.g. `/about` becomes `dist/client/about.html`).

::: important
Running `vite build` locally does **not** generate HTML files — the build only produces the worker and client asset bundles. Prerendered HTML files are generated remotely when the app is deployed.
:::

## Per-page overrides

Individual pages can opt out of prerendering:

```ts
// pages/dashboard.server.ts
export const prerender = false;
```

Dynamic pages with `getPrerenderPaths()` are prerendered for the returned param combinations:

```ts
// pages/blog/[slug].server.ts
export async function getPrerenderPaths() {
  return [{ slug: "hello-world" }, { slug: "getting-started" }];
}
```

Dynamic pages **without** `getPrerenderPaths()` are not prerendered — the paths aren't known at build time. These pages are served dynamically by the worker at runtime.

## Comparison with edge prerendering

| `output` value       | Default prerender | Per-page override                | Prerender timing           |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR) |
| `"static"`           | `true`            | `export const prerender = false` | Build-time (`vite build`)  |

When `output` is omitted or `"server"`, behavior is unchanged — `export const prerender = true` opts individual pages into deploy-time [edge prerendering](./cache/prerendering.md).

## Relationship to `appType: "prebuilt"`

The `appType` field describes app type (SPA, prebuilt, fullstack), while `output` controls rendering strategy:

|              | `appType: "prebuilt"`                           | `output: "static"`                   |
| ------------ | ----------------------------------------------- | ------------------------------------ |
| **What**     | Deploy a pre-built static site (no Void plugin) | Prerender a Void app at build time   |
| **Worker**   | None (static assets only)                       | Yes (for non-prerendered routes)     |
| **Use case** | VitePress, plain HTML, external SSG tools       | Void apps with mostly static content |
