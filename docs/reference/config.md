---
outline: deep
---

# Config

## Config File Format

All project-level configuration lives in a `void.json` file at the project root. Every field is optional — missing file means all defaults.

```json
{
  "$schema": "./node_modules/void/schema.json",
  "target": "cloudflare",
  "auth": {
    "providers": ["email", "github", "google"]
  },
  "routing": {
    "revalidate": { "/": 60, "*": 30 },
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
    }
  },
  "inference": {
    "bindings": { "db": true, "kv": false },
    "appType": "spa",
    "outputDir": "dist"
  },
  "worker": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

Add the `$schema` field for autocomplete and validation in your editor.

## Fields

### `auth`

High-level Better Auth configuration.

Use `auth.providers` to select which built-in auth providers Void should enable by default. Include `"email"` for email/password auth. Social providers read credentials from `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`.

```json
{
  "auth": {
    "providers": ["email", "github", "google", "discord"]
  }
}
```

If `auth` is omitted but auth is active via imports, Void enables email/password only. For provider-specific options, scopes, plugins, or custom OAuth flows, use a root `auth.ts` with `defineAuth(...)`.

Supported values for `auth.providers`:

- `email`
- `apple`
- `atlassian`
- `cognito`
- `discord`
- `dropbox`
- `facebook`
- `figma`
- `github`
- `gitlab`
- `google`
- `huggingface`
- `kakao`
- `kick`
- `line`
- `linear`
- `linkedin`
- `microsoft`
- `naver`
- `notion`
- `paybin`
- `paypal`
- `polar`
- `railway`
- `reddit`
- `roblox`
- `salesforce`
- `slack`
- `spotify`
- `tiktok`
- `twitch`
- `twitter`
- `vercel`
- `vk`
- `zoom`

### `database`

Database backend. Omit for D1/SQLite (default). Set to `"pg"` for PostgreSQL via Hyperdrive.

```json
{
  "database": "pg"
}
```

| Value       | Description                                           |
| ----------- | ----------------------------------------------------- |
| _(omitted)_ | D1 (SQLite) — fully managed by Void, no config needed |
| `"pg"`      | PostgreSQL via Hyperdrive — bring your own database   |

When using `"pg"`:

- Add `DATABASE_URL` to `.env.local` for local development
- Import schema helpers from `void/schema-pg` instead of `void/schema-d1`
- `void/db` connects via Hyperdrive in production, direct connection locally
- `void gen model` generates `pgTable` with `serial`, `timestamp`, etc.

### `output`

Output mode. Controls the default rendering strategy for pages.

| Value                | Default prerender | Per-page override                | Prerender timing           |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR) |
| `"static"`           | `true`            | `export const prerender = false` | Build-time (`vite build`)  |

When set to `"static"`, all pages are prerendered at build time as static HTML files written to `dist/client/`. Individual pages can opt out with `export const prerender = false`. Dynamic pages (with route params) without a `getPrerenderPaths()` export are implicitly not prerendered.

When omitted or set to `"server"`, pages are server-rendered on request. Individual pages can opt into deploy-time prerendering with `export const prerender = true`.

```json
{ "output": "static" }
```

### `remote`

Use remote D1/KV/R2 bindings during local development instead of local miniflare. When enabled, the Void plugin replaces local bindings with proxy-backed versions that forward operations to your deployed project's real resources via the Void proxy.

```json
{ "remote": true }
```

**Requirements:**

- Must be logged in (`void auth login`)
- Must have a linked project (`void project link`)
- Only affects D1 (`DB`), KV (`KV`), and R2 (`STORAGE`) bindings

You can also enable remote mode via the `VOID_REMOTE=1` environment variable without modifying `void.json`:

```bash
VOID_REMOTE=1 pnpm dev
```

### `target`

Deploy target runtime. Defaults to `"cloudflare"`.

| Value          | Description                                           |
| -------------- | ----------------------------------------------------- |
| `"cloudflare"` | Cloudflare Workers (default) — full platform features |
| `"node"`       | Node.js — uses `@hono/node-server`                    |
| `"bun"`        | Bun — uses `Bun.serve()`                              |
| `"deno"`       | Deno — uses `Deno.serve()`                            |

Non-CF targets disable CF bindings (`void/db`, `void/kv`, `void/auth`, `void/storage`, `void/ai`, `void/env`, `void/ws`). Importing any of these with a non-CF target produces a compile-time error. File-based routing, middleware, and `void/client` all work normally.

```json
{ "target": "node" }
```

### `worker`

Curated Cloudflare Workers configuration. Binding arrays (`d1_databases`, `kv_namespaces`, `r2_buckets`) are not allowed here — bindings are fully managed by void via inference and the `inference.bindings` field. Users wanting custom bindings should use a `wrangler.json` with real binding IDs and `wrangler deploy`.

| Field                 | Type       | Description                            |
| --------------------- | ---------- | -------------------------------------- |
| `compatibility_date`  | `string`   | Cloudflare Workers compatibility date  |
| `compatibility_flags` | `string[]` | Cloudflare Workers compatibility flags |

```json
{
  "worker": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

### `routing`

Routing and edge configuration — headers, redirects, and caching.

#### `routing.headers`

Custom response headers for static assets. Keys are URL patterns, values are arrays of `"Name: value"` strings. See [Custom Headers](../guide/edge/headers) for details.

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
    }
  }
}
```

#### `routing.redirects`

URL redirects. Keys are source URL patterns, values are destination strings (302 default) or objects with `to` and optional `status`. See [Redirects](../guide/edge/redirects) for details.

```json
{
  "routing": {
    "redirects": {
      "/old": "/new",
      "/blog/*": { "to": "/posts/:splat", "status": 301 }
    }
  }
}
```

#### `routing.revalidate`

ISR revalidation TTL in seconds — global or per-path. See [Revalidation](../guide/edge/revalidation.md) for details.

```json
{
  "routing": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "*": 30
    }
  }
}
```

#### `routing.prerender`

Paths to prerender as static HTML at deploy time. Each path must start with `/`. See [Edge Prerendering](../guide/edge/prerendering.md) for details.

```json
{
  "routing": {
    "prerender": ["/", "/about", "/pricing"]
  }
}
```

### `inference`

Configuration for build-time inference — how Void detects your app type, bindings, and build process.

#### `inference.bindings`

Explicitly control inferred Cloudflare bindings. If omitted, bindings are [automatically inferred](./resource-inference.md) by scanning your source files for binding usage. If provided, explicit values take precedence and inference is skipped entirely.

Each binding accepts `true` (use default name), `false` (disable), or a string (custom binding name):

```json
{ "inference": { "bindings": { "db": true, "kv": false, "storage": "MY_BUCKET" } } }
```

| Key       | Default Binding | Type          | Custom Name              |
| --------- | --------------- | ------------- | ------------------------ |
| `db`      | `DB`            | `D1Database`  | `"db": "MY_DB"`          |
| `kv`      | `KV`            | `KVNamespace` | `"kv": "MY_KV"`          |
| `storage` | `STORAGE`       | `R2Bucket`    | `"storage": "MY_BUCKET"` |
| `ai`      | `AI`            | `Ai`          | Boolean only             |

Custom names are used in the deploy manifest and in wrangler binding sync for local dev.

#### `inference.build`

Override the build command. Useful for frameworks with their own CLIs (Nuxt, Astro) or custom build scripts. If omitted, the CLI uses the framework's default build command.

```json
{ "inference": { "build": "nuxt build --preset cloudflare-module" } }
```

#### `inference.scanDirs`

Override which directories are scanned for [binding inference](./resource-inference.md). Paths are relative to the project root. Replaces the default directories for the current mode.

```json
{ "inference": { "scanDirs": ["src", "lib", "workers"] } }
```

#### `inference.appType`

App type. If omitted, auto-detected on first deploy. See [Supported App Types](../guide/app-types.md).

- `"void"` — worker + assets (API routes, SSR, jobs)
- `"framework"` — meta framework (TanStack Start, React Router, SvelteKit, Nuxt, Astro)
- `"static"` — fully rendered HTML files (VitePress, plain HTML, external tools). Non-matching paths return `404.html` or a 404 response.
- `"spa"` — static with SPA fallback. All non-file paths fall back to `index.html` with a 200 status, so client-side routing works out of the box.

#### `inference.outputDir`

Output directory for static deploys, relative to the project root. Only relevant when `inference.appType` is `"spa"` or `"static"`. Defaults to `"dist"`.
