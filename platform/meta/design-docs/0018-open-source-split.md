# Open Source Split

**Date:** 2026-02-22
**Status:** Implemented

---

## Summary

Split the Void monorepo into two repos: an open-source **framework repo** (void plugin, CLI, framework adapters, docs) and a private **platform repo** (control plane, dispatch, proxy, dashboard). The goal is to open-source the entire client-side DX layer while keeping the server infrastructure closed.

## Motivation

- Build community trust and adoption — developers can inspect, fork, and contribute to the tooling they depend on
- Enable third-party contributions to the CLI, plugin, codegen, and framework adapters
- Follow the proven model (Vercel/Next.js, Supabase, PlanetScale): open the client, close the server
- The API client / deploy command being open is a feature, not a risk — the value is in the platform, not the protocol

## What Moves Where

**Framework repo (open source):**

- `packages/void` — core Vite plugin + CLI (routing, inference, migrations, codegen, deploy command, all runtime exports)
- `packages/vue` — Vue framework adapter
- `packages/react` — React framework adapter
- `packages/svelte` — Svelte framework adapter
- `packages/solid` — SolidJS framework adapter
- `docs/` — documentation site (VitePress)
- `playground/*` — all 10 test apps (spa, ssr, vue-pages, react-pages, svelte-pages, solid-pages, queues, auth, ai, tanstack-start)
- `docs` symlink

**Platform repo (private, current repo):**

- `packages/api` — control plane API
- `packages/dispatch` — edge router worker
- `packages/proxy` — AI inference, revalidation, and remote bindings proxy worker
- `packages/dashboard` — user-facing dashboard (Vue Pages app)
- `packages/ui` — shared CSS/design tokens (used by dashboard)
- `meta/` — design docs, operations, progress tracking

## Architecture Validation

The split is architecturally clean — confirmed by code analysis:

- **Platform, dispatch, and proxy have zero imports from `void`**. No `from "void"` or `from "@voidcloud/{vue,react,svelte,solid}"` anywhere in platform/dispatch/proxy source code.
- **The only cross-boundary coupling is the HTTP deploy protocol** — the CLI sends a deploy manifest to the platform API. This is a network boundary, not a code dependency.
- **No shared test utilities** between framework and platform packages.
- **Runtime subpaths are hermetic** — `handler`, `db`, `fetch`, `queues`, `auth` have zero imports from CLI or plugin code.
- **Plugins never import from CLI** — `plugin-routing`, `plugin-inference`, `plugin-migration`, `plugin-db-types` are all clean of CLI imports.
- **One trivial fix needed**: `config.ts` imports `HeaderRule` from `cli/types.ts`. Move the type to `config.ts` or a shared `types.ts`.

### Dashboard Cross-Boundary Dependency

The `dashboard` package is a special case — it lives in the platform repo but depends on framework packages:

- **`void`** (core plugin) — used as the build tool
- **`@void/vue`** (Vue adapter) — SSR, `Link`, `useShared`, `useRouter`
- **`@voidcloud/api/api`** — type-only import for API route types (BFF pattern)

Post-split, the dashboard will consume the framework packages as **published npm dependencies** rather than workspace links. This is clean — the dashboard is a consumer of the framework, not a co-dependent. The `@voidcloud/api/api` type import stays internal to the platform repo.

## Physical Layout

The framework repo lives inside the platform repo directory, gitignored. This enables unified local development (single Claude/editor context for cross-cutting changes) while the framework repo remains independently cloneable.

```
~/VoidZero/void/              # platform repo (private)
├── .gitignore                      # includes framework/
├── pnpm-workspace.yaml             # platform + dispatch + proxy + dashboard + ui
├── packages/api/
├── packages/dispatch/
├── packages/proxy/
├── packages/dashboard/
├── packages/ui/
├── meta/
└── framework/                      # framework repo (open source), gitignored
    ├── .git/                       # independent git history
    ├── pnpm-workspace.yaml         # self-contained workspace
    ├── pnpm-lock.yaml              # own lockfile
    ├── packages/void/
    ├── packages/vue/
    ├── packages/react/
    ├── packages/svelte/
    ├── packages/solid/
    ├── docs/
    └── playground/
```

**External contributors** clone the framework repo standalone. `pnpm install && pnpm test` works without the platform repo.

**Internal development** launches from the parent directory with both repos in context. Cross-cutting changes (e.g., deploy protocol changes) edit files in both repos, tested independently.

## Git History

The framework repo preserves git history via `git filter-repo`, extracting commits that touched the framework packages. The platform repo keeps full history.

## Workspace Independence

Each repo is a fully self-contained pnpm workspace with its own:

- `pnpm-workspace.yaml` + catalog
- `pnpm-lock.yaml`
- `package.json` (scripts, devDependencies)
- `vitest.config.ts`
- `.oxlintrc.json`, `.node-version`, `.gitignore`, `.husky/`
- `.github/workflows/ci.yml`

No `pnpm overrides` or cross-workspace linking — the platform repo never imports from `void` at code level, so there is no need for local linking.

## Deploy Protocol Versioning

The `DeployManifest` type is the only cross-repo coupling — the CLI sends it to the platform API over HTTP. After the split, independent releases could break this contract silently.

**Strategy:**

- Add a `version: number` field to `DeployManifest` in both repos (CLI types and platform types)
- The CLI always sets `manifest.version` to the current protocol version when sending
- The platform deploy endpoint validates the version field:
  - Known version → proceed
  - Missing/unknown version → return a clear error: `"Unsupported deploy manifest version. Please update void."`
- Contract tests in both repos assert the expected shape of `DeployManifest`

**Versioning policy:** The CLI must be backward-compatible with the current and previous manifest version. The platform must accept the current and previous version. Bumping the version is a coordinated change.

## CI Changes

**Framework repo CI** (new):

- lint + typecheck
- Unit tests
- Integration tests (void)
- Integration tests — pages adapters (react + vue + svelte + solid, requires playwright)

**Platform repo CI** (simplified):

- lint + typecheck
- Unit tests (platform + dispatch + proxy)
- Integration tests (platform + dashboard)
- Remove pages adapter suite, remove `--filter '!website'` exclusions
- Playwright may still be needed for dashboard E2E tests

**Platform deploy workflows**: Remove the `pnpm -F vue -F void build && pnpm i` pre-build step and `deploy:docs`/`deploy:staging:docs` steps. Post-split, the dashboard gets `void` and `@void/vue` from npm during `pnpm install --frozen-lockfile`, so the pre-build is no longer needed. Docs deployment moves to the framework repo via a dedicated `deploy-docs.yml` workflow. Dashboard deploy stays in the platform workflow.

**Cross-repo compatibility gate (canary CI):**

A daily canary workflow in the platform repo updates the dashboard's `void` and `@void/vue` dependencies to latest, then runs build + typecheck + tests. If a new framework release breaks the dashboard, it fails here before reaching production. The framework repo also runs a deploy manifest contract test as part of its CI to ensure the CLI still produces a valid manifest.

## Dashboard `workspace:*` → npm Cutover

Post-split, the dashboard's `void` and `@void/vue` dependencies change from `workspace:*` to published npm versions. During the transition (before first npm publish), use `file:` protocol overrides in the root `package.json`:

```json
"pnpm": {
  "overrides": {
    "void": "file:framework/packages/void",
    "@void/vue": "file:framework/packages/vue"
  }
}
```

These are removed once packages are published to npm. The `vite` catalog entry is also removed from the platform catalog (moved to framework only), so the dashboard pins `vite` directly in its `package.json`.

## Open Questions

- **Framework repo GitHub org/name**: e.g. `vitejs/void`, `voidzero/void`, or `void/void`?
- **Docs deployment**: Currently the platform deploy workflow deploys docs via `void deploy`. Post-split, the framework repo needs its own docs deploy workflow (or the platform deploy clones the framework repo).
- **npm publishing**: The framework repo will need its own publish workflow for `void`, `@void/vue`, `@void/react`, `@void/svelte`, `@void/solid`.
- **`@voidcloud/ui` placement**: Stays in the platform repo — only consumed by `dashboard`.
- **Dashboard framework dependency versioning**: Post-split, the dashboard will depend on published `void` and `@void/vue` from npm. Need to decide whether to pin versions or track latest. During active development, tracking latest with a lockfile update CI step is likely sufficient.
