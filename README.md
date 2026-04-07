# Void

Fullstack SDK for Cloudflare Workers, powered by [Vite](https://vite.dev).

Add a single plugin to your `vite.config.ts` and get file-based API routing, server-rendered pages, D1 database, KV storage, R2 object storage, AI inference, and one-command deploys — all auto-provisioned from your imports.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
```

## Quickstart

Void is currently in private preview. To install it for the first time:

1. Create a project `.npmrc` with the GitHub Packages registry mapping:

```ini
@void-sdk:registry=https://npm.pkg.github.com
```

2. Create a GitHub classic PAT with `read:packages` so your machine can install private packages:

- Token creation: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic
- Packages permissions: https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages

3. Add the token to your user `~/.npmrc` so you do not commit credentials into the project:

```ini
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

4. Install the preview CLI using a package alias:

```sh
npm install -D void@npm:@void-sdk/void
```

For example, the resulting `package.json` entry looks like this:

```json
{
  "devDependencies": {
    "void": "npm:@void-sdk/void@VERSION"
  }
}
```

When you run `void init` in an empty directory, it scaffolds the starter and adds the matching framework adapter plus Vite dependencies for you. Framework and support packages still follow the same alias pattern when you add them manually later: `@void/react@npm:@void-sdk/react`, `@void/vue@npm:@void-sdk/vue`, `@void/svelte@npm:@void-sdk/svelte`, `@void/solid@npm:@void-sdk/solid`, and `@void/md@npm:@void-sdk/md`.

Then run:

```sh
npx void init
npm run dev          # local dev with workerd runtime
npx void deploy      # deploy to void.app
```

## Features

- **Zero config** — no `wrangler.json`, no dashboard clicks
- **Automatic provisioning** — import `db`, `kv`, `storage`, or `ai` from `void` and resources are created on deploy
- **File-based routing** — drop a file in `routes/`, get an endpoint with method exports, dynamic params, middleware, and [Standard Schema](https://standardschema.dev/) validation
- **Full-stack pages** — `pages/` directory for server-rendered UI with co-located data loading, SPA navigation, and typed forms (React, Vue, Svelte, Solid)
- **End-to-end type safety** — SQL migrations generate DB types, route handlers infer return types, typed fetch client checks everything at the call site
- **Local dev parity** — `vite dev` runs handlers in the real `workerd` runtime with local D1, KV, and R2

## Documentation

Full docs at [void.cloud](https://void.cloud)

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
pnpm docs              # local docs dev server
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
