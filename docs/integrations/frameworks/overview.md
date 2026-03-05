---
outline: deep
---

# Meta-Frameworks

Void supports deploying meta-framework apps to the Void platform via `void deploy`. Add `voidPlugin()` to your framework's Vite config to get binding inference, typed DB generation, migration management, auth, cron jobs, queues, and caching.

Some frameworks (TanStack Start, React Router) compose directly with `@cloudflare/vite-plugin`, which Void already depends on and covers. Others (SvelteKit, Nuxt, Astro) have their own Cloudflare integrations, which Void respects. In both cases, the framework owns routing and rendering — Void serves as the platform SDK that enhances backend DX.

![void relationships with meta frameworks and deployment targets](./void-relationships.svg)

## Supported Frameworks

| Framework                                           | Package                 | Integration                                                                  |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| [TanStack Start](https://tanstack.com/start/latest) | `@tanstack/react-start` | Vite plugin composition — `voidPlugin()` runs alongside the framework plugin |
| [React Router v7](https://reactrouter.com/)         | `@react-router/dev`     | Vite plugin composition — same as TanStack Start                             |
| [SvelteKit](https://svelte.dev/docs/kit)            | `@sveltejs/kit`         | Vite-based, uses its own Cloudflare adapter                                  |
| [Nuxt](https://nuxt.com/)                           | `nuxt`                  | Own CLI and build toolchain                                                  |
| [Astro **v6+**](https://astro.build/)               | `astro`                 | Own CLI and Cloudflare adapter (v6 required)                                 |

Detection is automatic — the CLI reads your `package.json` dependencies.

See the individual framework guides for setup instructions:

- [TanStack Start](./tanstack-start.md)
- [React Router](./react-router.md)
- [SvelteKit](./sveltekit.md)
- [Nuxt](./nuxt.md)
- [Astro](./astro.md)

## Feature Support

With `voidPlugin()` added to the framework's Vite config, all frameworks get the same features as [Void apps](../../guide/app-types.md#void-apps):

- **Binding inference** — D1, KV, R2, AI, queues, and auth detected from source code
- **Typed database** — query helpers generated from `migrations/*.sql`
- **Migrations** — applied to local D1 on dev startup, validated and deployed with `void deploy`
- **Runtime helpers** — `void/db`, `void/kv`, `void/storage`, `void/ai` for typed access to Cloudflare bindings in dev and production
- **Auth** — built-in [authentication](../../guide/auth.md) with `getUser()`, auto-detected from `void/auth` imports
- **Cron jobs** — scheduled handlers via `crons/` directory
- **Queue consumers** — typed producers and consumers via `queues/` directory
- **Revalidation & prerendering** — configured via [`routing.revalidate`](../../guide/edge/revalidation.md) and [`routing.prerender`](../../guide/edge/prerendering.md) in `void.json` (Void apps can also configure these per-page in component files)

Frameworks can also access bindings directly via the framework's own mechanisms (e.g. `platform.env` in SvelteKit, `event.context.cloudflare.env` in Nuxt, `Astro.locals.runtime.env` in Astro).

## Configuration

### `void.json`

Most configuration is inferred automatically. Use `void.json` to override defaults or fine-tune behavior:

```json
{
  "$schema": "https://unpkg.com/void/schema.json",
  "inference": {
    "build": "nuxt build",
    "scanDirs": ["src", "server", "lib"],
    "bindings": { "db": "MY_DB" }
  },
  "routing": {
    "prerender": ["/", "/about", "/pricing"],
    "revalidate": 60
  }
}
```

| Field                | Purpose                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inference.build`    | Override the default build command                                                                                                                   |
| `inference.scanDirs` | Directories to scan for binding inference (defaults vary by framework)                                                                               |
| `routing.prerender`  | Paths to prerender as static HTML at deploy time                                                                                                     |
| `routing.revalidate` | Default revalidation TTL in seconds for cached responses                                                                                             |
| `inference.bindings` | Override inferred bindings — only needed if auto-detection isn't working as intended. Accepts `true` or a custom binding name (e.g. `"db": "MY_DB"`) |

See [Configuration](../../reference/config.md) for the full reference.

### `wrangler.jsonc`

Frameworks that use Cloudflare's dev runtime for local dev (SvelteKit, Nuxt with `nitro-cloudflare-dev`, Astro) need a `wrangler.jsonc` for binding configuration. `voidPlugin()` auto-syncs inferred bindings into this file on dev startup:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
  // Bindings below are auto-managed by voidPlugin()
}
```

Existing bindings are preserved — only missing ones are added with local placeholder IDs.

For `void deploy`, compatibility settings are read from `wrangler.jsonc` automatically (no need to duplicate them in `void.json`).

## Deploy Pipeline

SvelteKit, Nuxt, and Astro apps follow this pipeline:

```
void deploy
  │
  ├─ 1. Detect framework
  │    Reads package.json → determines framework + output conventions
  │
  ├─ 2. Build
  │    Runs framework's build command (or void.json `build` override)
  │    SvelteKit: vite build → .svelte-kit/cloudflare/
  │    Nuxt:      nuxt build → .output/
  │    Astro:     astro build → dist/
  │
  ├─ 3. Analyze
  │    ├─ Locate worker entry + static assets from known output paths
  │    ├─ Infer bindings from source or read from void.json
  │    ├─ Collect migrations from migrations/*.sql
  │    ├─ Detect auth, cron, and queue handlers
  │    └─ Read wrangler.jsonc compat settings
  │
  ├─ 4. Wrap (if needed)
  │    If auth, crons, or queues are configured:
  │    ├─ Generate wrapper entry module
  │    ├─ Bundle with Vite (wraps framework's worker)
  │    └─ Wrapper adds auth middleware, scheduled/queue handlers
  │
  ├─ 5. Package + upload
  │    Same as full-stack: hash-based asset diffing,
  │    multipart upload, platform provisioning
  │
  └─ 6. Live
       https://my-app.void.app
```
