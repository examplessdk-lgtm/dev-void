---
outline: deep
---

# What is Void?

Void is a deployment platform and fullstack Vite plugin that turns any Vite app into a globally distributed, edge-first application on Cloudflare — without requiring a Cloudflare account, config files, or infrastructure knowledge.

Add a single plugin to your `vite.config.ts` and you get file-based API routing, full-stack [pages mode](./pages-routing.md) with server-rendered components, a D1 database, KV storage, R2 object storage, AI inference, and one-command deploys. Just import `db`, `kv`, `storage`, or `ai` from `void` and everything is provisioned automatically based on what your code actually uses.

```sh
npm install -D vite void
```

```ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
```

```sh
void deploy
# app live at <your-subdomain>.void.app!
```

## Why Void?

Cloudflare's primitives are powerful but require significant manual setup: creating `wrangler.json` configs, provisioning D1 databases / KV namespaces / R2 buckets, writing a monolithic `fetch` handler, and managing bindings across environments.

Void makes it dead simple:

- **Zero config** — no `wrangler.json`, no dashboard clicks. Write code, deploy.
- **Automatic provisioning** — import `db` from `void/db` in a handler and a D1 database is created for you. Same for `kv` and `storage`.
- **File-based routing** — drop a file in `routes/`, get an endpoint. Method exports, dynamic params, middleware, catch-alls and [Standard Schema](https://standardschema.dev/) validation built in.
- **Full-stack pages** — add a `pages/` directory for server-rendered UI with co-located data loading, SPA navigation, and typed forms. Works with React, Vue, and more.
- **Local dev parity** — `vite dev` runs your handlers in the real `workerd` runtime with local D1 (SQLite), KV, and R2. What works locally works in production.
- **One-command deploy** — `void deploy` builds, provisions resources, runs migrations, and deploys. No intermediate steps.

### Flexible by design

Void auto-detects your [app type](./app-types.md) and adapts accordingly. Build a full-stack app with API routes and pages, deploy a meta-framework like TanStack Start or React Router, or ship a static SPA or SSG site. Use any UI library that works with Vite. Every build produces a standard Cloudflare Worker, so you can always [self-host](./integrations/cloudflare.md#deploy-to-your-own-cloudflare-account) with your own `wrangler.json`.

### End-to-end type safety

Types flow from your database to your frontend with zero manual annotations. SQL migrations generate DB types, route handlers infer return types, and the [typed fetch client](./type-safety.md) checks paths, methods, request bodies, and responses at the call site. In pages mode, [`useForm`](./type-safety.md#action-useform) infers body fields, error keys, and URL autocomplete from your action's validators. Add a [Standard Schema](https://standardschema.dev/) validator (zod, valibot, arktype) and one schema defines runtime validation and compile-time types across the entire stack.

## How it works

```
vite.config.ts          →  voidPlugin() plugin
routes/api/users.ts     →  API endpoint at /api/users
pages/index.vue         →  Server-rendered page at /
import { db }           →  D1 database (auto-provisioned)
import { kv }           →  KV namespace (auto-provisioned)
import { storage }      →  R2 bucket (auto-provisioned)
import { ai }           →  Workers AI inference (metered)
migrations/*.sql        →  Applied to D1 on dev startup and deploy
void deploy              →  Live at https://<slug>.void.app
```

The plugin scans your source code at build time, detects which imports you use (`void/db`, `void/kv`, `void/storage`, `void/ai`), provisions the corresponding Cloudflare bindings on deploy, and routes requests through a generated [Hono](https://hono.dev) app with lazy-loaded handlers for minimal cold starts.

## Next steps

- [Quickstart](./quickstart.md) — get a running app in minutes
- [Server Routing](./server-routing.md) — dynamic params, middleware, and validation
- [Pages Routing](./pages-routing.md) — full-stack pages with server loaders and actions
- [App Types](./app-types.md) — full-stack, meta-framework, and static site modes
