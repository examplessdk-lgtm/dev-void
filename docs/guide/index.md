---
outline: deep
---

# What is Void?

Void was born out of an experiment: what's the best possible fullstack DX for JavaScript? Our answer: an SDK and deployment platform designed hand-in-hand. Add a single Vite plugin, and your imports become your infrastructure — a database, key-value store, object storage, AI inference, and one-command deploys to a global edge network, all without config files or dashboard clicks.

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

## The idea

With most stacks, your app and its platform don't talk to each other. You write config files to bridge the gap — infrastructure declarations, environment variables, resource provisioning, deployment pipelines. And once deployed, you manage caching rules, scaling policies, and resource limits through yet another layer of configuration.

Void removes the gap. It's a Vite plugin that connects your app directly to the platform. Import `db` from `void/db` and a database exists — locally in development and globally replicated in production. Import `kv` or `storage` and the same happens for key-value and object storage. There's nothing to configure because the SDK already told the platform what you need.

This is what it unlocks:

- **Write code, not config** — no infrastructure files, no dashboard clicks, no resource declarations. Your imports are your infrastructure.
- **Types from database to frontend** — your Drizzle schema defines DB types, route handlers infer return types, the [typed fetch client](./typed-fetch.md) checks everything at the call site. One [Standard Schema](https://standardschema.dev/) validator defines runtime validation and compile-time types across the entire stack.
- **Real runtime in development** — `vite dev` runs your server code in the same runtime used in production, with local database, KV, and storage. What works locally works in production.
- **Deploy understands your code** — `void deploy` doesn't just upload files. It reads your migrations, provisions only the resources you use, and deploys to the edge. One command, no intermediate steps.

## The platform

Void deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/). Your server code runs on the edge — globally, close to your users — and scales automatically from zero to whatever you need.

- [Static assets](./edge/static-assets) are served from the edge with proper cache headers. [Incremental revalidation](./edge/revalidation) (ISR) and [prerendering](./edge/prerendering) let you cache dynamic pages while keeping data fresh.
- Database reads are fast everywhere via D1's read replication.
- Custom domains with automatic TLS.
- Secrets and environment variables managed via CLI or dashboard, scoped per project.
- A dashboard for deployments, usage metrics, and project settings.

You don't need a Cloudflare account or any Cloudflare knowledge to get started. But if you want full control, every build produces a standard Cloudflare Worker — you can always [self-host](../integrations/cloudflare#deploy-to-your-own-cloudflare-account) with your own `wrangler.json`.

## How it works

```
vite.config.ts                →  voidPlugin() — works with any Vite app
import { db }                 →  D1 database (auto-provisioned)
import { kv }                 →  KV namespace (auto-provisioned)
import { storage }            →  R2 bucket (auto-provisioned)
import { ai }                 →  Workers AI inference (metered)
db/schema.ts                  →  Drizzle schema — source of truth for DB types
db/migrations/*.sql           →  Applied to D1 on deploy
void deploy                   →  Live at https://<slug>.void.app
```

The plugin scans your source code at build time, detects which imports you use, and provisions the corresponding Cloudflare bindings on deploy.

Void works with your existing framework — [TanStack Start](/integrations/frameworks/tanstack-start), [React Router](/integrations/frameworks/react-router), [SvelteKit](/integrations/frameworks/sveltekit), [Nuxt](/integrations/frameworks/nuxt), and [Astro](/integrations/frameworks/astro) all deploy with the same `voidPlugin()`.

For full-stack apps that don't use a meta-framework, Void also offers [file-based server routing](./server-routing) with method exports, dynamic params, middleware, and validation, plus [pages routing](./pages-routing/overview) with server-rendered UI and SPA navigation, co-located data loading, and typed forms — works with React, Vue, Svelte, and Solid.

Void auto-detects your [app type](./app-types) and adapts accordingly.

## Next steps

- [Quickstart](./quickstart) — get a running app in minutes
- [Server Routing](./server-routing) — dynamic params, middleware, and validation
- [Pages Routing](./pages-routing/overview) — full-stack pages with server loaders and actions
- [Supported App Types](./app-types) — full-stack, meta-framework, and static site modes
