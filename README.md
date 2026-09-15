# Void

Fullstack SDK for Cloudflare Workers, powered by [Vite](https://vite.dev).

Add the Vite plugin to build APIs and server-rendered pages with typed access to databases, storage, and AI. Void detects the resources your code uses and provisions them when you deploy.

If you run a team platform, `void platform` also lets you give people access,
manage their projects, and investigate deployments from the terminal. Start with
[Platform Administration](./docs/guide/platform-administration.md).

The platform implementation is included in this repository. To change it or
deploy a runtime from your own fork, follow
[Platform Development](./docs/guide/platform-development.md).

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
});
```

## Starting a New Project

1. Install the Void CLI:

```sh
mkdir your-project
cd your-project
pnpm add -D void
```

In an empty project, `void init` asks which framework and starter you want, then installs the dependencies. It uses Vite+ by default. In an existing app, it adds missing scripts and configures the Vite plugin.

Then run:

```sh
pnpm void init
pnpm dev             # local dev with workerd runtime
pnpm void deploy     # deploy to the saved Cloudflare or Void target
```

## Adding Void to an Existing Project

Already deploy the same Void app directly to Cloudflare? Run `void deploy`. If your project has a `wrangler.jsonc` or `wrangler.json` and no deployment destination, Void offers to link and deploy using the existing Worker and resources. Accept once, then use `void deploy` for future deployments. See [Deploy an existing Worker](./docs/integrations/cloudflare.md#deploy-an-existing-worker).

1. Install Void:

```sh
pnpm add -D void
```

2. Enable the plugin in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
});
```

3. Run the setup flow:

```sh
pnpm void init
```

4. Deploy to the target selected during setup:

```sh
pnpm void deploy
```

## Features

- **One CLI** — deploy and manage your app on your Cloudflare account or your team's Void platform
- **Team platforms** — install a shared deployment service in your company's Cloudflare account and connect developers through the same CLI
- **Automatic provisioning** — use `void/db`, `void/kv`, `void/storage`, or `void/ai`, and Void provisions the resources your app needs
- **Typed secrets** — mark env schema keys with `.secret()`; direct Cloudflare deploys upload them as encrypted Worker secrets instead of plaintext vars
- **File-based routing** — drop a file in `routes/`, get an endpoint with method exports, dynamic params, middleware, and [Standard Schema](https://standardschema.dev/) validation
- **Full-stack pages** — `pages/` directory for server-rendered UI with co-located data loading, SPA navigation, and typed forms (React, Vue, Svelte, Solid)
- **End-to-end type safety** — SQL migrations generate DB types, route handlers infer return types, typed fetch client checks everything at the call site
- **Typed durable state** — modules in `durable-objects/` get inferred SQLite-backed bindings and typed RPC methods
- **Local dev parity** — `vite dev` runs handlers in the real `workerd` runtime with local D1, KV, and R2

## Documentation

Full docs at [void.cloud](https://void.cloud). Run `vp run dev:docs` in this repo to view the documentation locally.

Run `void connect` to choose a deployment destination and sign in, `void connect --platform cloudflare` for your own account, or `void connect <url>` for your team's platform. See the [connection reference](./docs/reference/cli.md#connect).

To install a shared company platform, start with `void platform install --plan`. It packages the core API, routing, proxy, and telemetry Workers without requiring the dashboard, GitHub App, or build Containers. See [Self-host a Void platform](./docs/guide/self-hosted-platform.md).

Platform upgrades verify migrations and check the new Workers before completing the rollout. If a rollout fails, Void can restore the previous Workers against the compatible database schema. See the platform guide for recovery and upgrade details.

## Contributing

### Setup

```sh
git clone https://github.com/voidzero-dev/void.git
cd void
vp install
vp run build:all
```

### Development

```sh
vp test run            # run tests
vpr test:all           # format, lint, build, typecheck, and run every SDK/platform test
vp lint                # oxlint via Vite+
vp fmt                 # oxfmt via Vite+
vp run check           # typecheck all packages
vp run dev:docs        # local docs dev server
```

See [TESTING.md](./TESTING.md) for targeted verification and the account-neutral, non-destructive
native Cloudflare live E2E procedure.

### Project Structure

| Path                         | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `packages/void`              | Core Vite plugin + CLI                                            |
| `packages/deploy-core`       | Shared deploy contracts, artifacts, planning, and target boundary |
| `packages/deploy-cloudflare` | Public direct-Cloudflare deployment primitives                    |
| `packages/platform`          | Platform deployment manifests, naming, and lifecycle contracts    |
| `packages/edge`              | Shared edge routing and static asset runtime                      |
| `packages/isr`               | Shared ISR protocol, core, and direct runtime                     |
| `packages/react`             | React framework adapter                                           |
| `packages/vue`               | Vue framework adapter                                             |
| `packages/svelte`            | Svelte 5 framework adapter                                        |
| `packages/solid`             | SolidJS framework adapter                                         |
| `platform/packages`          | Hosted Void control plane, routing, proxy, logging, and dashboard |
| `docs`                       | Documentation (VitePress)                                         |
| `playground/*`               | Test apps for local development                                   |

Public SDK packages must not import from `platform/`. Hosted platform packages may depend on public or shared workspace packages.

## GitHub Deployment

The documentation site deploys from `main` through the Void GitHub App using the
`container` executor. The root [`void.json`](./void.json) configures the monorepo
as a static project that builds `docs` and publishes `docs/.vitepress/dist`.
There is no documentation deploy workflow or `VOID_TOKEN` repository secret.

Connect the repository once with:

```sh
void github connect void-docs \
  --repo voidzero-dev/void \
  --branch main \
  --executor container
```

Release publishing still uses the `Release` GitHub environment with an
`NPM_TOKEN` secret via `.github/workflows/publish.yml`.

CI (`ci.yml`) runs on PRs to `main` and requires no secrets.

## License

MIT
