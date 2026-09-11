# Node.js Deploy Target

**Date:** 2026-02-28
**Status:** Design

---

## Summary

Add a `target` config option to `void.json` that enables deploying Void apps to Node.js (and Bun/Deno) instead of Cloudflare Workers. In this mode, all CF-specific `void/*` imports are disallowed, there is no binding inference, and no wrangler. The output is a plain Hono app that runs in any Node.js-compatible runtime. Users still get file-based routing (`routes/`), pages mode (`pages/`), middleware, typed fetch client (`void/client`), and SSR — just without CF platform features.

## Motivation

Void's file-based routing, pages mode, and meta-framework DX are valuable independent of Cloudflare. A Node.js target makes Void apps:

- Deployable to any Node.js platform (Railway, Fly, VPS, Docker, etc.)
- Runnable with Bun or Deno natively
- Accessible to developers who don't use Cloudflare
- Useful as a lightweight Hono meta-framework without cloud lock-in

## Configuration

Add `target` to `void.json`:

```json
{
  "target": "node"
}
```

Valid values: `"cloudflare"` (default), `"node"`, `"bun"`, `"deno"`.

When `target` is non-cloudflare:

- CF-only config fields (`bindings`, `auth`, `wrangler`) are ignored with a prominent warning
- `appType`, `output`, `head`, `headers`, `redirects`, `scanDirs` still work
- `void/client` is still available (runtime-agnostic typed fetch)
- `void/db`, `void/kv`, `void/auth`, `void/bindings` produce compile-time errors

## Architecture: Target-Aware Plugin Composition

The `voidPlugin()` reads `target` from config and swaps the plugin tail. The entire routing/pages/codegen layer is shared — only the "last mile" changes.

### Current (CF target):

```
voidPlugin() returns:
  restartPlugin()
  bindingWatchPlugin          ← CF-specific (binding inference)
  envPlugin
  routingPlugin               ← SHARED (route scanning + codegen)
  dbTypesPlugin               ← CF-specific (D1 types)
  migrationPlugin             ← CF-specific (D1 migrations)
  prerenderPlugin             ← SHARED
  ...cloudflare({ ... })      ← CF-specific (Miniflare/wrangler)
```

### New (non-CF target):

```
voidPlugin() returns:
  restartPlugin()
  envPlugin
  routingPlugin               ← SHARED (identical)
  prerenderPlugin             ← SHARED (identical)
  nodeTargetPlugin(target)    ← NEW (replaces everything CF)
```

## `nodeTargetPlugin` — The Core New Plugin

Single new Vite plugin with three responsibilities:

### 1. Binding Guard (`resolveId` hook)

Intercepts imports of `void/db`, `void/kv`, `void/auth`, `void/bindings` and throws a compile-time error:

```
✖ 'void/db' is not available with target: "node".
  CF bindings require target: "cloudflare".
```

`void/client` and `void/handler` are allowed — they are runtime-agnostic.

### 2. Dev Server

Uses `@hono/vite-dev-server` to run the Hono app in Node.js during `vite dev`:

- Loads `virtual:void-routes` as the Hono app entry
- Serves client assets via Vite's built-in dev middleware
- Gets HMR for pages (client environment)
- Gets module invalidation + auto-reload for route changes (same as today)
- No wrangler, no workerd, no Miniflare

### 3. Build Entry Generation

Generates a target-specific entry file with the appropriate `serve()` call:

```js
// target: "node"
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import app from 'virtual:void-routes';
app.use('/assets/*', serveStatic({ root: './client' }));
serve({ fetch: app.fetch, port: process.env.PORT || 3000 });

// target: "bun"
import { serveStatic } from 'hono/bun';
import app from 'virtual:void-routes';
app.use('/assets/*', serveStatic({ root: './client' }));
Bun.serve({ fetch: app.fetch, port: process.env.PORT || 3000 });

// target: "deno"
import { serveStatic } from 'hono/deno';
import app from 'virtual:void-routes';
app.use('/assets/*', serveStatic({ root: './client' }));
Deno.serve({ port: Number(Deno.env.get('PORT') || 3000) }, app.fetch);
```

Adds `compileNodeEntry(target)` as a sibling to the existing `compileWorkerEntry()`.

## What Stays the Same

These components are already runtime-agnostic and require **zero changes**:

| Component             | Why it works as-is                                      |
| --------------------- | ------------------------------------------------------- |
| `routingPlugin`       | Generates `virtual:void-routes` as a pure Hono app      |
| `compileRouteTable()` | Hono routing is runtime-agnostic                        |
| Pages mode (SSR)      | `renderToString()` is just Vue/React — no CF dependency |
| Pages mode (client)   | Runs in the browser — no runtime dependency             |
| `void/client`         | Just ofetch — runtime-agnostic                          |
| File-based routing    | Scanning + codegen is pure Node.js at build time        |
| Middleware            | Standard Hono middleware                                |
| `virtual:void-routes` | The core virtual module — completely target-agnostic    |

## What Gets Skipped/Warned

For non-CF targets, these features are unavailable:

| Feature               | Behavior           |
| --------------------- | ------------------ |
| `void/db` (D1)        | Compile-time error |
| `void/kv` (KV)        | Compile-time error |
| `void/auth` (AUTH_KV) | Compile-time error |
| `void/bindings`       | Compile-time error |
| `bindings` config     | Warning, ignored   |
| `auth` config         | Warning, ignored   |
| `wrangler` config     | Warning, ignored   |
| Cron jobs (`crons/`)  | Warning, ignored   |
| Queues (`queues/`)    | Warning, ignored   |
| Binding inference     | Skipped entirely   |

## Build Output

```
dist/
  index.js            # Server entry (target-specific serve() call)
  app.js              # Hono app (route table + handlers)
  client/             # Static assets (pages mode)
    assets/
      index-abc.js
      index-xyz.css
  .vite/
    manifest.json     # Asset manifest
```

Run with: `node dist/index.js` (or `bun dist/index.js`, `deno run dist/index.js`).

## Changes Summary

| Area                    | Change                                                  | Scope         |
| ----------------------- | ------------------------------------------------------- | ------------- |
| `config.ts`             | Add `target` field, warn on CF-only fields              | Small         |
| `schema.json`           | Add `target` enum                                       | Trivial       |
| `index.ts` (voidPlugin) | Conditional plugin tail based on target                 | Medium        |
| `plugin-node-target.ts` | **New file** — binding guard + dev server + build entry | Core new work |
| `router/compile.ts`     | Add `compileNodeEntry(target)`                          | Small         |
| `package.json`          | Add `@hono/vite-dev-server` as optional peer dep        | Trivial       |
