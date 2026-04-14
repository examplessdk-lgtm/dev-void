# Void

Full-stack framework for Cloudflare Workers, powered by Vite.

## Context Overview

- **Important**: The source of truth for agent instructions is `CLAUDE.md` (this file). `AGENTS.md` is a symlink to this file. `README.md` is a separate public-facing file. When asked to update agent instructions, always update `CLAUDE.md`.
- Documentation source lives in `docs/`.
  - Docs is a Vitepress project using our custom theme. When asked to "link the theme", temporarily edit `docs/package.json` so that `@voidzero-dev/vitepress-theme` point to `link:../../../theme`. Rerun `pnpm install` to link it. Revert these when asked to "unlink the theme".
- Private beta packages publish under the temporary `@void-sdk/*` scope for GitHub Packages. Consumer-facing code, docs examples, and playground source should keep using `void` and `@void/*`; use package-manager aliases in consumer `package.json` files to bridge the difference.

## Important Note for Release Workflows

The `void` package on npm has these previous versions: '0.0.1', '0.1.0', '0.1.2', '0.1.3', '0.1.5', '0.1.6', '1.0.0', '1.0.1', '1.0.2', '3.0.0', '3.0.1'. We have unpublished these versions but they cannot be published again. In package release workflows, make sure to avoid / skip these versions for `packages/void`.

## Best Practices That Must Be Followed

- **Never** commit without asking for confirmation.
- When adding new dependencies to the project, always run `npm view [package] version` to get the latest version.
- Every implementation plan should include the following:
  - During plan generation: ask clarifying questions when necessary, especially around developer-experience defining design decisions.
  - Verification:
    - Run `pnpm check` for typechecking after completing a batch of tasks.
    - Run `pnpm test` on tests relevant to the current feature only during feature development. Only run the full test suite when everything is done for final verification.
    - If there are tests hanging or running particularly slow, investigate right there and attempt to fix. Testing velocity is something that should be maintained or improved at every opportunity.
  - Documentation: after verification, update all docs if relevant and applicable:
    - `README.md` (this file)
    - affected packages's `README.md` or `AGENTS.md`
    - relevant docs md files in `docs`
    - `packages/void/skills/void` (if change affects skill/CLI guidance)
    - `packages/void/AGENT_PROMPT.md`
    - `packages/void/getting-started-prompt.txt`
- When adding new CLI commands, always remember to update the following:
  - CLI help message
  - The hint message for command groups in the interactive list when running `void` with no args
  - `docs/reference/cli.md`

## Quick Reference

```
pnpm -r build                       # Build all packages
pnpm -C packages/void build         # Build only the core plugin
pnpm test                           # Run vitest (unit + integration tests)
pnpm test packages/void             # Only test the core plugin
pnpm lint                           # oxlint
pnpm fmt                            # oxfmt --write .
pnpm check                          # Typecheck all packages (tsgo --noEmit)
pnpm -C packages/vue typecheck      # Typecheck a specific package
```

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (`@typescript/native-preview`, tsdown, vite, @cloudflare/workers-types, wrangler). Make sure to run `pnpm install` after making package structure changes.

| Package                                          | npm name       | Purpose                                                        |
| ------------------------------------------------ | -------------- | -------------------------------------------------------------- |
| [`packages/void`](./packages/void/AGENTS.md)     | `void`         | Core Vite plugin — routing, inference, migrations, CLI         |
| [`packages/react`](./packages/react/README.md)   | `@void/react`  | React framework adapter for Pages mode (SSR, Link, useForm)    |
| [`packages/vue`](./packages/vue/README.md)       | `@void/vue`    | Vue framework adapter for Pages mode (SSR, Link, useForm)      |
| [`packages/svelte`](./packages/svelte/README.md) | `@void/svelte` | Svelte 5 framework adapter for Pages mode (SSR, Link, useForm) |
| [`packages/solid`](./packages/solid/README.md)   | `@void/solid`  | SolidJS framework adapter for Pages mode (SSR, Link, useForm)  |
| [`docs`](./docs)                                 | (private)      | Documentation site (VitePress)                                 |
| `playground/*`                                   | (private)      | local apps for testing                                         |

## `void` Overview

The `void` package contains two parts:

**Vite plugin** — `voidPlugin()` returns `[routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]` for the default Cloudflare target, or `[routingPlugin, prerenderPlugin, nodeTargetPlugin()]` for non-CF targets (`node`, `bun`, `deno`). Depends on `@cloudflare/vite-plugin` and transitively on wrangler/miniflare (Cloudflare target only).

- **Routing** — file-based API routing on Hono with named HTTP method exports
- **Validation** — request body/query/params validation via any Standard Schema library
- **Typed fetch client** — fully-inferred client from route definitions
- **Typed DB** — auto-generated types from SQL migrations
- **Auth** — built-in email/password + OAuth, auto-detected from imports and env vars
- **Cron jobs** — scheduled handlers via `defineScheduled`
- **Queues** — typed producers and consumers via `defineQueue`
- **AI** — `import { ai } from "void/ai"` for Workers AI inference, metered via AI Gateway proxy
- **Remote bindings** — `remote: true` in `void.json` to use real D1/KV/R2 during local dev via proxy
- **Binding inference** — auto-detects D1, KV, R2, AI, queues from source code
- **Migration runner** — applies SQL migrations to local D1 on dev startup

**CLI (`void`)** — commands for local development DX and deployment:

- **`deploy`** — builds, validates migrations, packages, and uploads to Void
- **`gen`** — scaffolds models, routes, middleware, SSR entries, cron jobs, and queue consumers
- **`init`** — sets up agent instructions, skills, and reference prompts for coding agents
- **`db`** — manages migrations and inspects the local D1 database
- **`auth`** — login, logout, and token management
- **`projects`** — link, create, and manage Void projects
- **`domains`** — configure custom domains for deployed projects
- **`secrets`** — manage production environment variables

See [`packages/void/AGENTS.md`](./packages/void/AGENTS.md) for architecture, source layout, design decisions, package exports, route parsing rules, code generation, and agent integration.

**Note:** `packages/void/skills/void/docs` is ignored from git and is auto copied during build. Ignore files in this directory.

## `@void/vue` Overview

Vue framework adapter for Pages mode — Inertia-inspired full-stack DX with SSR.

- **Plugin** (`@void/vue/plugin`): `voidVue()` — compiles Vue SFCs, generates SSR + client hydration entries
- **Runtime** (`@void/vue`): `Link`, `useForm`, `useShared` composables
- **Server handlers**: Remix-style `loader` (GET → props) and `action` (mutations) exports in companion `.server.ts` files

See [`packages/vue/README.md`](./packages/vue/README.md) for architecture.

## `@void/svelte` Overview

Svelte 5 framework adapter for Pages mode — same Inertia-inspired DX as Vue/React.

- **Plugin** (`@void/svelte/plugin`): `voidSvelte()` — wraps `@sveltejs/vite-plugin-svelte`, generates SSR + client hydration entries
- **Runtime** (`@void/svelte`): `Link`, `useForm`, `useShared`, `useRouter` — uses Svelte 5 runes (`$state`, `$derived`) and `getContext`
- **Server handlers**: companion `.server.ts` files with `loader` and `action` exports (same as React adapter)

See [`packages/svelte/README.md`](./packages/svelte/README.md) for details.

## `@void/solid` Overview

SolidJS framework adapter for Pages mode — same Inertia-inspired DX as Vue/React/Svelte.

- **Plugin** (`@void/solid/plugin`): `voidSolid()` — wraps `vite-plugin-solid`, generates SSR + client hydration entries
- **Runtime** (`@void/solid`): `Link`, `useForm`, `useShared`, `useRouter` — uses Solid signals (`createSignal`, `createStore`) and `createContext`/`useContext`
- **Server handlers**: companion `.server.ts` files with `loader` and `action` exports (same as React/Svelte adapter)

See [`packages/solid/README.md`](./packages/solid/README.md) for details.

## Tooling

| Tool     | Version       | Purpose                                                                                        |
| -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Node.js  | 24.13.1       | Runtime (TS type stripping enabled natively — no `tsx` or `--experimental-strip-types` needed) |
| pnpm     | 10.x          | Package manager with workspaces + catalog                                                      |
| tsdown   | 0.20.3        | Build (rolldown-based, ESM, DTS)                                                               |
| wrangler | 4.x           | CF Worker dev/deploy                                                                           |
| vitest   | 4.x           | Unit + integration tests                                                                       |
| oxlint   | 1.47.x        | Linting                                                                                        |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)                                                              |
| vite     | 8.0.0-beta.14 | Dev server + build                                                                             |

## Testing

Tests run from root with `pnpm test` (vitest). See each package README for detailed test listings.

## Playground

Local apps for testing features end-to-end. Run scripts with `pnpm -C playground/<app> <script>` (e.g. `pnpm -C playground/spa dev`).

| App                                                       | Description                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`kitchen-sink`](./playground/kitchen-sink)               | Vue Pages mode — DB, KV, R2, AI, Auth, Cron, Queues, Env, ISR (exercises every major feature)         |
| [`spa`](./playground/spa/README.md)                       | React SPA — API routes, valibot validation, typed DB, typed fetch client, middleware, cron jobs       |
| [`ssr`](./playground/ssr/README.md)                       | React SSR — `defineRender()`, client hydration, KV storage, dynamic markdown blog                     |
| [`websockets`](./playground/websockets/README.md)         | React Pages mode — typed chat room and single-socket notification stream via `void/ws`                |
| [`vue-pages`](./playground/vue-pages/README.md)           | Vue Pages mode — companion `.server.ts` files, Inertia protocol, SSR, layouts, `useForm`, `useShared` |
| [`svelte-pages`](./playground/svelte-pages)               | Svelte 5 Pages mode — companion `.server.ts` files, Inertia protocol, SSR, layouts, `useForm`         |
| [`solid-pages`](./playground/solid-pages)                 | SolidJS Pages mode — companion `.server.ts` files, Inertia protocol, SSR, layouts, `useForm`          |
| [`tanstack-start`](./playground/tanstack-start/README.md) | TanStack Start meta-framework — server functions, D1 queries, SSR via TanStack                        |
| [`node-app`](./playground/node-app)                       | Node.js target — Hono API routes without CF bindings, `@hono/node-server` for production              |
| [`pg-test`](./playground/pg-test)                         | React Pages mode — PostgreSQL via Hyperdrive, Drizzle ORM CRUD, `useForm`                             |

`playground-local/` is gitignored and used for ad-hoc local testing apps that are not part of the codebase.

## Pitfalls / Things That Broke

- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.void/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
- **`declare module` augmentation requires `export {}`** at the top of the generated file. Without a top-level export/import, TypeScript treats it as an ambient module declaration (replaces the module entirely) rather than an augmentation (merges with existing exports). This hides runtime exports like `db` and `createDb`. Both `routes.d.ts` and `db.d.ts` use `export {}` to ensure augmentation semantics.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `void`.
- **D1 does not allow `PRAGMA foreign_keys=OFF`** — D1 enforces `foreign_keys=ON` always. Drizzle-generated migrations that do table rebuilds (e.g. adding NOT NULL to an existing column) use `PRAGMA foreign_keys=OFF/ON`, which silently fails on D1. Hand-edit these to `PRAGMA defer_foreign_keys=on/off` instead, which defers FK checks to the end of the current transaction.
- **Vite config plugins option accepts array of plugins by default** - there is no need to spread plugins that export an array of plugins.
- **Solid `createComponent()` evaluates immediately** — unlike React's JSX (which creates lazy descriptors), Solid's `createComponent(Fn, props)` calls `Fn` right away. Context providers must wrap the _evaluation_ of child components, not the evaluated result. Build layout chains inside provider `children` getters, not before wrapping in providers.
