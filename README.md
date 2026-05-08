# Void

Fullstack SDK for Cloudflare Workers, powered by [Vite](https://vite.dev).

Add a single plugin to your `vite.config.ts` and get file-based API routing, server-rendered pages, URL rewrites and redirects, D1 database, KV storage, R2 object storage, AI inference, and one-command deploys — all auto-provisioned from your imports.

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

When you run `void init` in a scaffoldable empty directory, it scaffolds the starter and adds the matching framework adapter plus Vite dependencies for you. In an existing app, `void init` configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`.

Then run:

```sh
pnpm void init
pnpm dev             # local dev with workerd runtime
pnpm void deploy     # deploy to void.app
```

## Adding Void to an Existing Project

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

4. Deploy to void.app:

```sh
pnpm void deploy
```

## Features

- **Zero config** — no `wrangler.json`, no dashboard clicks
- **Automatic provisioning** — import `db`, `kv`, `storage`, or `ai` from `void` and resources are created on deploy
- **File-based routing** — drop a file in `routes/`, get an endpoint with method exports, dynamic params, middleware, and [Standard Schema](https://standardschema.dev/) validation
- **Full-stack pages** — `pages/` directory for server-rendered UI with co-located data loading, SPA navigation, and typed forms (React, Vue, Svelte, Solid)
- **End-to-end type safety** — SQL migrations generate DB types, route handlers infer return types, typed fetch client checks everything at the call site
- **Local dev parity** — `vite dev` runs handlers in the real `workerd` runtime with local D1, KV, and R2

## Documentation

Full docs at [void.cloud](https://void.cloud). Run `vp run dev:docs` in this repo to view the documentation locally.

## Contributing

### Setup

```sh
git clone https://github.com/nicepkg/void.git
cd void
vp install
vp run build:all
```

### Development

```sh
vp test run            # run tests
vp lint                # oxlint via Vite+
vp fmt                 # oxfmt via Vite+
vp run check           # typecheck all packages
vp run dev:docs        # local docs dev server
```

### Project Structure

| Package           | Purpose                         |
| ----------------- | ------------------------------- |
| `packages/void`   | Core Vite plugin + CLI          |
| `packages/react`  | React framework adapter         |
| `packages/vue`    | Vue framework adapter           |
| `packages/svelte` | Svelte 5 framework adapter      |
| `packages/solid`  | SolidJS framework adapter       |
| `docs`            | Documentation (VitePress)       |
| `playground/*`    | Test apps for local development |

## GitHub Environments & Secrets

Deploy and publish workflows require three GitHub environments:

| Environment | Trigger | Secret       | Purpose                                               |
| ----------- | ------- | ------------ | ----------------------------------------------------- |
| `Prod`      | `prod`  | `VOID_TOKEN` | Auth token for `void deploy` (production docs)        |
| `Staging`   | `main`  | `VOID_TOKEN` | Auth token for `void deploy` (staging docs)           |
| `Release`   | `v*`    | `NPM_TOKEN`  | npm publish token via `.github/workflows/publish.yml` |

Note both prod and staging docs are self-hosted on the **production** environment of the platform, so `VOID_TOKEN` for both Prod and Staging envs should be issued from the production API.

CI (`ci.yml`) runs on PRs to `main` and requires no secrets.

## License

MIT
