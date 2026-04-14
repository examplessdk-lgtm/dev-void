# void

Vite plugin and CLI for building and deploying apps on Void.

## What It Covers

- file-based API routes from `routes/`
- Pages mode from `pages/`
- typed Drizzle access via `void/db`
- `crons/` and `queues/`
- binding inference for D1, KV, R2, AI, auth, and queues
- remote bindings for local development
- deploy packaging for Void-hosted apps, static sites, and supported meta-frameworks

## Quick Start

Void is currently in private preview. To install it for the first time, keep importing `void` and `@void/*` in source code, but install the preview artifacts with npm aliases.

1. Create a project `.npmrc` with the scope mapping:

```ini
@void-sdk:registry=https://npm.pkg.github.com
```

2. Create a GitHub classic PAT with `read:packages`:

- Token creation: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic
- Packages permissions: https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages

3. Put the token in your user `~/.npmrc` instead of the project:

```ini
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

4. Install the preview CLI using a package alias:

```bash
npm install -D void@npm:@void-sdk/void
```

If you run `void init` in an empty directory, the scaffold flow adds the matching Pages adapter and Vite dependencies for you. Use the same alias pattern for the other adapters and `@void/md` when you add them manually later.

Then run `npx void init`. The full interactive flow can scaffold a starter, configure local project files, log you in, and link or create your Void project so the next step is just `npx void deploy`.

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
- `void auth login` — platform auth
- `void deploy` — build and deploy
- `void db *` — local DB and migration commands
- `void project *` — link, status, logs, rollback, delete

Runtime helpers include:

- `defineHandler`
- `defineMiddleware`
- `defineScheduled`
- `defineQueue`
- `void/db`
- `void/kv`
- `void/storage`
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
- framework apps can opt into PostgreSQL mode
- route types, DB types, and queue types are generated into `.void/*.d.ts`

## Documentation

Full docs live at [void.cloud/docs](https://void.cloud/docs).

## License

MIT
