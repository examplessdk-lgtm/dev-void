# void

Vite plugin and CLI for building and deploying apps on Void.

## What It Covers

- file-based API routes from `routes/`
- Pages mode from `pages/`
- typed Drizzle access via `void/db`
- `crons/` and `queues/`
- URL redirects, rewrites, and fallbacks (`void.json` / `public/_redirects`, plus `c.rewrite()` from middleware)
- binding inference for D1, KV, R2, AI, auth, queues, and typed Durable Objects
- remote bindings for local development
- deploy packaging for Void-hosted apps, static sites, and supported meta-frameworks

## Quick Start

Install the Void CLI:

```bash
npm install -D void
```

If you run `void init` in an empty directory, the scaffold flow adds the matching Pages adapter and Vite+ by default.

Then run `npx void init`. In an empty directory, the full interactive flow can scaffold a starter and configure local project files. It then asks where to deploy: Cloudflare (the default) creates or augments `wrangler.jsonc`, offers Wrangler login, and saves the selected account; Void can log you in and link or create a managed project. The next step is just `npx void deploy`. Auth-enabled deploys preserve an existing `BETTER_AUTH_SECRET` or create a persistent encrypted secret when missing on either platform. Direct Cloudflare deploys also promote env schema keys explicitly marked `.secret()` to encrypted Worker secrets, removing them from plaintext vars; values may come from production dotenv files or the deploy process environment. In an existing app, init configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
});
```

## Core Surfaces

- `voidPlugin()` — Vite integration, routing, pages mode, codegen, migrations, packaging
- `void prepare` — generate `.void` artifacts for CI, editors, and fresh clones
- `void auth login` — platform auth
- `void deploy` — build and deploy
- `void db *` — local DB and migration commands
- `void project *` — link, status, logs, requests, rollback, delete

Runtime helpers include:

- `defineHandler`
- `defineMiddleware`
- `basicAuth`
- `defineScheduled`
- `defineQueue`
- `void/db`
- `void/kv`
- `void/storage`
- `void/durable`
- `void/ai`
- `void/isr`
- `void/client`
- `void/auth`

## Supported App Shapes

- native Void apps (`routes/`, `pages/`, `middleware/`, `crons/`, `queues/`)
- supported meta-framework deploy targets:
  - TanStack Start
  - React Router
  - SvelteKit
  - Nuxt
  - Astro
- static and SPA deploys
- non-Cloudflare server targets (`node`, `bun`, `deno`)

There is Vinext-specific source in the repo, but it is intentionally on hold and not part of the current public support matrix.

## Database Model

`void/db` is Drizzle-first.

- D1 is the default managed database target
- apps can opt into PostgreSQL or MySQL mode
- route types, DB types, and queue types are generated into `.void/*.d.ts`

## Documentation

Full docs live at [void.cloud/guide](https://void.cloud/guide).

## License

MIT
