# void

Vite plugin and CLI for building and deploying apps on Void.

You can also administer a team platform with the same CLI. Sign in with
`void platform auth login`, then manage users, signup access, projects, and logs.
Commands show a preview before applying changes and support `--json` for scripts.
See [Platform Administration](../../docs/guide/platform-administration.md) for a
walkthrough and the [CLI reference](../../docs/reference/cli.md#operator-commands)
for every command.

Use `void platform config auth` to manage login methods and company signup.
Cloudflare Access protection has separate create/connect controls. Users can
link another enabled login to their account with `void auth link`.

## What It Covers

- file-based API routes from `routes/`
- Pages mode from `pages/`
- typed Drizzle access via `void/db`
- `crons/` and `queues/`
- URL redirects, rewrites, and fallbacks (`void.json` / `public/_redirects`, plus `c.rewrite()` from middleware)
- binding inference for D1, KV, R2, AI, auth, queues, and typed Durable Objects
- remote bindings for local development
- one target-aware deploy path for Void-hosted and direct Cloudflare apps
- automatic Cloudflare provisioning, verified Worker Version activation, and operational commands

## Quick Start

Install the Void CLI:

```bash
npm install -D void
```

If you run `void init` in an empty directory, the scaffold flow adds the matching Pages adapter and Vite+ by default.

Init offers to initialize Git and suggests an optional initial commit command. Use `--git` or `--no-git` to choose without the Git prompt. Existing repositories are preserved; Void does not commit automatically.

To install a team platform, use `void platform install`. A domain is recommended; the visible workers.dev testing option is also available as `--workers-dev`. Add a domain later with `void platform domain set example.com`, preserving projects, deployments, and API connections. See the [platform setup guide](../../docs/guide/self-hosted-platform.md).

Init always writes brief coding-agent instructions to `AGENTS.md`, pointing to `node_modules/void/skills/void/docs/`, and links skills for detected agents. Run `void init --agents` to add or refresh just this setup without choosing an agent.

Then run `npx void init`. In an empty directory, the full interactive flow can scaffold a starter and configure local project files. It then asks where to deploy: Cloudflare (the default) creates or augments `wrangler.jsonc`, handles secure browser sign-in through Void's bundled tooling, and saves the selected account; Void asks for the API URL of an explicitly connected company platform (`void connect <url>` or `void platform install`). Back up `~/.void/platforms/` after installing a company platform because its owner-only recovery material contains runtime keys that Cloudflare cannot return. The next app step is just `npx void deploy`. Auth-enabled deploys preserve an existing `BETTER_AUTH_SECRET` or create a persistent encrypted secret when missing on either platform. Root `.env` is local-only; production server keys declared in `env.ts` use encrypted remote secret storage and are rejected as plaintext Worker vars. In an existing app, init configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`.

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
- `void connect [url]` — choose Cloudflare or a Void platform, sign in, and save the deployment destination
- `void platform *` — list, select, inspect, install, recover, repair, upgrade, disable, and safely uninstall a company platform
- `void deploy` — build and deploy to the saved Cloudflare or Void target
- `void db *` — local DB and migration commands
- `void project *` — target-aware status, logs, rollback, managed-project operations, and scoped CI deploy credentials
- `void secret *` / `void domain *` — target-aware Worker secrets and custom domains

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
  - vinext App Router and Pages Router
  - SvelteKit
  - Nuxt
  - Analog
  - Astro
- static and SPA deploys
- non-Cloudflare server targets (`node`, `bun`, `deno`)

Direct Cloudflare deployments also support D1, KV, R2, Queues, Hyperdrive, auth, cron jobs, AI, ISR, typed SQLite Durable Objects, and WebSocket rooms. They upload an immutable Worker Version, probe it before activation (using a 0%-traffic version override when Durable Objects disable preview URLs), and retain version metadata for migration-aware rollback.

Self-hosted platform upgrades verify every packaged PostgreSQL migration and require the live Drizzle history to be an exact prefix. Pending SQL is allowed only for an explicitly attested old-version/schema compatibility edge, runs in one transaction, and leaves the old Worker version authoritative until the target runtime passes discovery and health checks.

An upgrade that changes the authenticated usage protocol briefly gates application traffic while it verifies the complete Worker set. An interruption leaves the gate closed for the next resumable upgrade instead of enabling an unsigned compatibility path.

## Database Model

`void/db` is Drizzle-first.

- D1 is the default managed database target; development and local database commands share the configured binding ID and persistence directory
- apps can opt into PostgreSQL or MySQL mode
- route types, DB types, and queue types are generated into `.void/*.d.ts`

Node.js, Bun, and Deno Pages builds include production hydration assets. Deploy `dist/ssr` together with `dist/client`; the server loads its manifest and assets relative to the emitted module.

## Documentation

Full docs live at [void.cloud/guide](https://void.cloud/guide).

## License

MIT
