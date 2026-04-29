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

## Authentication

Void is currently in private preview. You need to set up a GitHub Personal Access Token (PAT) for the GitHub Packages registry.

1. Add the GitHub Packages registry mapping to your project's `.npmrc`:

```sh
echo "@void-sdk:registry=https://npm.pkg.github.com" >> .npmrc
```

2. Create a GitHub classic PAT with `read:packages` to install private packages:

- Visit https://github.com/settings/tokens/new
- Enable `read:packages`
- Click "Generate Token"

See also [token creation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic) and [packages permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages) for details.

3. Add the token to your user `~/.npmrc` so you do not commit credentials into the project:

```sh
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT" >> ~/.npmrc
```

4. For CI, configure `NODE_AUTH_TOKEN` with your PAT under GitHub repo settings "Secrets and variables" > "Actions":

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: lts/*
    cache: pnpm
    registry-url: https://npm.pkg.github.com
    scope: '@void-sdk'
- run: pnpm install
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }}
```

## Starting a New Project

1. Install the preview CLI using a package alias:

```sh
mkdir your-project
cd your-project
pnpm add -D void@npm:@void-sdk/void
```

> [!WARNING]
> **Using npm?** npm has a known issue resolving peer dependencies with package aliases. Add the `--legacy-peer-deps` flag.

```sh
npm install -D void@npm:@void-sdk/void --legacy-peer-deps
```

For example, the resulting `package.json` entry looks like this:

```json
{
  "devDependencies": {
    "void": "npm:@void-sdk/void@VERSION"
  }
}
```

When you run `void init` in a scaffoldable empty directory, it scaffolds the starter and adds the matching framework adapter plus Vite dependencies for you. In an existing app, `void init` configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`. Framework and support packages still follow the same alias pattern when you add them manually later: `@void/react@npm:@void-sdk/react`, `@void/vue@npm:@void-sdk/vue`, `@void/svelte@npm:@void-sdk/svelte`, `@void/solid@npm:@void-sdk/solid`, and `@void/md@npm:@void-sdk/md`.

Then run:

```sh
pnpm void init
pnpm dev             # local dev with workerd runtime
pnpm void deploy     # deploy to void.app
```

## Adding Void to an Existing Project

1. Install the preview package using a package alias:

```sh
pnpm add -D void@npm:@void-sdk/void
```

> [!WARNING]
> **Using npm?** npm has a known issue resolving peer dependencies with package aliases. Add the `--legacy-peer-deps` flag.

```sh
npm install -D void@npm:@void-sdk/void --legacy-peer-deps
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

Full docs at [void.cloud](https://void.cloud). Run `pnpm dev:docs` in this repo to view the documentation locally.

## Contributing

### Setup

```sh
git clone https://github.com/nicepkg/void.git
cd void
pnpm install
pnpm -r build
```

### Development

```sh
pnpm test              # run tests
pnpm lint              # oxlint
pnpm fmt               # oxfmt
pnpm check             # typecheck all packages
pnpm dev:docs          # local docs dev server
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

| Environment | Trigger | Secret              | Purpose                                                                        |
| ----------- | ------- | ------------------- | ------------------------------------------------------------------------------ |
| `Prod`      | `prod`  | `VOID_TOKEN`        | Auth token for `void deploy` (production docs)                                 |
| `Staging`   | `main`  | `VOID_TOKEN`        | Auth token for `void deploy` (staging docs)                                    |
| `Release`   | `v*`    | `GH_PACKAGES_TOKEN` | GitHub Packages private beta publish token via `.github/workflows/publish.yml` |

Note both prod and staging docs are self-hosted on the **production** environment of the platform, so `VOID_TOKEN` for both Prod and Staging envs should be issued from the production API.

CI (`ci.yml`) runs on PRs to `main` and requires no secrets.

## License

MIT
