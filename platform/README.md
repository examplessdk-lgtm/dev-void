# Void Platform

The Void platform runs in your Cloudflare account and lets developers deploy
applications through the Void CLI. This repository contains its control plane,
routing, proxy, log ingestion, and optional dashboard and build services.

The API, dispatch, proxy, tail, and email gateway Workers are packaged into
[`@void/platform`](../packages/platform/README.md). A released or source-built
runtime can be installed and upgraded with `void platform`. The installer tracks
resource ownership, applies compatible migrations, and preserves credentials
across upgrades.

Start with [Self-host a Void Platform](../docs/guide/self-hosted-platform.md) to
install it, [Platform Administration](../docs/guide/platform-administration.md) to
operate it, or [Platform Development](../docs/guide/platform-development.md) to
work on a fork. The dashboard and managed builds are optional source components;
they are not provisioned by the core installer.

Commands below run from the repository root. Package paths in the tables are
relative to `platform/` unless they begin with `../`.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- Read the [architecture](./meta/architecture.md) for the current component map.
- Use the [maintainer documentation index](./meta/README.md) and [design archive](./meta/design-docs/README.md) for implementation context. Archived plans are not a current roadmap.
- Public SDK: repository-level `packages/`. If work involves the SDK, read the root `AGENTS.md` and the affected package instructions first.
- Public-facing docs: repository-level `docs/` (VitePress site).

## Best Practices That Must Be Followed

1. General

- **Always** read `meta/lessons.md` at the start of each session before taking any action.
- **Never** commit without asking for confirmation.
- When writing technical design docs or implementation plans to disk, place them in `meta/design-docs` and follow existing file name and frontmatter conventions. Keep commercial strategy, pricing research, competitor analysis, and private operational inventories out of the repository.
- When adding new dependencies to the project, always run `npm view [package] version` to get the latest version.

2. Subagent Strategy
   - Use subagents liberally to keep the main context window clean.
   - Offload research, exploration, and parallel analysis to subagents.
   - For complex problems, allocate more compute via subagents.
   - Assign one task per subagent to ensure focused execution.

3. Self-Improvement Loop
   - After any correction from the user, update meta/lessons.md with the relevant pattern.
   - Create rules for yourself that prevent repeating the same mistake.
   - Iterate on these lessons rigorously until the mistake rate declines.

4. Principles
   - Simplicity First: Make every change as simple as possible. Minimize code impact.
   - No Laziness: Identify root causes. Avoid temporary fixes. Apply senior developer standards.
   - Minimal Impact: Touch only what is necessary. Avoid introducing new bugs.
   - For non-trivial changes, pause and ask whether there is a more elegant solution.
   - If a fix feels hacky, implement the solution you would choose knowing everything you now know.
   - Do not over-engineer simple or obvious fixes.
   - Critically evaluate your own work before presenting it.

5. Planning
   - Enter plan mode for any non-trivial task (three or more steps, or involving architectural decisions).
   - If something goes wrong, stop and re-plan immediately rather than continuing blindly.
   - Every implementation plan should include the following:
   - During plan generation: ask clarifying questions when necessary, especially around developer-experience defining design decisions.
   - Verification:
     - Run `vp run check` from the repository root for typechecking after completing a batch of tasks.
     - Run `vp test run` on tests relevant to the current feature only during feature development. Only run the full test suite when everything is done for final verification.
     - If there are tests hanging or running particularly slow, investigate right there and attempt to fix. Testing velocity is something that should be maintained or improved at every opportunity.
   - Documentation: after verification, update all docs if relevant and applicable:
     - `README.md` (this file)
     - affected packages's `README.md` or `AGENTS.md`
   - Record implementation progress in the relevant current technical design or issue.

## Quick Reference

| Command                                      | Purpose                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| `vp run build:core`                          | Build shared packages, CLI, and packaged platform runtime |
| `vp run build:platform`                      | Build the platform source apps                            |
| `vp run --filter @voidcloud/platform dev`    | Start the dashboard development server                    |
| `vp run build:all`                           | Build all packages, platform apps, and playgrounds        |
| `vp test run --project 'platform-*'`         | Run platform tests                                        |
| `vp run lint:platform`                       | Run type-aware platform lint                              |
| `vp run check`                               | Typecheck the workspace                                   |
| `vp run test:all`                            | Format check, lint, build, typecheck, and test            |
| `vp run --filter @voidcloud/platform health` | Check the selected platform using operator authentication |

The workspace `dev` and `build` scripts in `platform/package.json` apply to the
dashboard. They do not start the API or install a platform. Deployment scripts
in that file serve the existing Void Cloud deployment; see [operations](#operations).

## Operator CLI

Sign in as an administrator to inspect users, projects, deployments, and platform
health:

```sh
void platform auth login
void platform user list
void platform system health
```

Commands use the selected platform connection. Add `--plan` to preview a change,
`--yes` to apply it in a script, and `--json` to read structured results. The
[Platform Administration guide](../docs/guide/platform-administration.md) covers
the workflows; the [CLI reference](../docs/reference/cli.md#operator-commands)
lists all commands and options.

The CLI and browser admin UI share the same server operations and record their
mutations in `operator_events`. The operator API is served at `/operator/v1`. Apply
`0033_operator_sessions_and_events` before deploying the API; the migration adds
tables and indexes that remain compatible with existing Workers.

Both interfaces prevent deletion or suspension of the last active administrator.
Allowed administrator removals revoke access before resource cleanup and preserve
that revocation if cleanup fails, so concurrent removals cannot lock out the
remaining administrator.

When upgrading an installation that previously enabled managed Sandbox, run
`void platform system sandbox-drain --plan`, then apply it and rerun until it
reports `complete: true`. Preview later bounded pages by passing the returned
`nextCursor` to `--cursor`. The lifecycle installer keeps application traffic
closed while this database-backed drain is required. An active deployment is
first asked to cancel; rerun the drain after 10 minutes if its request was
abandoned. A protected cutover remains fenced for 90 minutes before the drain
can compensate it, while an interrupted rollback is adopted through its
database lease. These retries restore the committed deployment before deleting
the managed Sandbox container.

## Local Development

With a local PostgreSQL server running, build the shared packages and set up the API:

```sh
vp run build:core
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

Open `http://localhost:8787/admin/`. To work on the dashboard, start it separately:

```sh
vp run --filter @voidcloud/dashboard dev
```

The [development guide](../docs/guide/platform-development.md) explains the local
configuration, fork CI, schema changes, and how to deploy a source-built runtime
into your own installation.

## Monorepo structure

Void is one repository with an explicit dependency boundary:

- Repository-level `packages/` — public SDK, CLI, runtime helpers, and framework adapters.
- `../packages/deploy-core` — target-neutral deployment manifests and wire contracts shared by the SDK and platform.
- `../packages/platform` — public deployment/installation manifests plus integrity-checked core Worker artifacts used by the platform installer.
- `platform/packages/` — platform implementation packages for the control plane, routing, proxy, logs, dashboard, and UI.
- Platform packages may depend on public/shared packages. Public SDK packages must not depend on `platform/`.

### Top-Level Map

| Path                                                   | Purpose                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`packages/api`](./packages/api/README.md)             | Control plane API, deploy pipeline, provisioning, administrator UI        |
| [`packages/dashboard`](./packages/dashboard/README.md) | User-facing dashboard app                                                 |
| [`packages/dispatch`](./packages/dispatch/README.md)   | Edge router for installation app domains and custom domains               |
| `packages/email-gateway`                               | Email ingress, bounded tenant delivery, and validated email actions       |
| [`packages/proxy`](./packages/proxy/README.md)         | AI proxy, remote D1/KV/R2 proxy, ISR revalidation bridge                  |
| [`packages/tail`](./packages/tail/README.md)           | Runtime log ingestion into Analytics Engine                               |
| [`../packages/void`](../packages/void/AGENTS.md)       | Main `void` package: Vite plugin, CLI, runtime, codegen, deploy packaging |
| `../packages/{vue,react,svelte,solid}`                 | Pages-mode adapters and runtime helpers                                   |
| `../packages/create-void`                              | Scaffolding package                                                       |
| `../packages/md`                                       | Markdown package                                                          |
| `../docs`                                              | Public-facing SDK docs                                                    |
| `meta/design-docs`                                     | Historical design archive                                                 |
| `meta/operations.md`                                   | Operations/runbook                                                        |

### Where Code for X Lives

| Feature                                                                        | Primary code paths                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite plugin and local runtime                                                  | `../packages/void/src/index.ts`, `plugin-*`, `runtime/*`                                                                                                                                                                                                                                            |
| CLI commands                                                                   | `../packages/void/src/cli/*`                                                                                                                                                                                                                                                                        |
| File-based API routing                                                         | `../packages/void/src/router/*`, `runtime/handler.ts`                                                                                                                                                                                                                                               |
| Pages routing, loaders, actions, named actions, deferred props                 | `../packages/void/src/pages/*`, adapter runtimes in `../packages/{vue,react,svelte,solid}/src/runtime/*`                                                                                                                                                                                            |
| Typed route/page/action codegen                                                | `../packages/void/src/codegen/*`, `routes-stub.ts`                                                                                                                                                                                                                                                  |
| Binding inference                                                              | `../packages/void/src/plugin-inference.ts`, `../packages/void/src/inference/*`                                                                                                                                                                                                                      |
| Drizzle integration and migrations                                             | `../packages/void/src/drizzle/*`, `../packages/void/src/migrations/*`                                                                                                                                                                                                                               |
| Framework detection and deploy presets                                         | `../packages/void/src/plugin-inference.ts`, `../packages/void/src/cli/preset.ts`                                                                                                                                                                                                                    |
| Platform auth and project APIs                                                 | `packages/api/src/routes/*`, `packages/api/src/auth/*`, `packages/api/src/middleware/*`                                                                                                                                                                                                             |
| Administrator UI                                                               | `packages/api/src/admin/*`                                                                                                                                                                                                                                                                          |
| Deploy pipeline                                                                | `../packages/void/src/cli/deploy.ts`, `packages/api/src/routes/deploy.ts`, `packages/api/src/assets.ts`, `packages/api/src/provisioning/*`                                                                                                                                                          |
| Deploy on GitHub (App connect, webhooks, OIDC, build containers)               | `packages/api/src/routes/{github,webhooks,auth-oidc}.ts`, `packages/api/src/github/*`, `packages/api/src/build-scheduler.ts`, `packages/api/src/build-manager.ts`, `packages/api/container/*`, `packages/api/src/auth/deploy-token.ts`                                                              |
| Hostname routing, static serving, ISR, redirects, rewrites, headers, metering  | `packages/dispatch/src/*`                                                                                                                                                                                                                                                                           |
| AI metering, BYOK AI gateway, remote D1/KV/R2 access, revalidation bridge      | `packages/proxy/src/*`                                                                                                                                                                                                                                                                              |
| Email (shared sender, custom domains, recipient policy, admin-managed domains) | `packages/email-gateway/src/*`, `packages/proxy/src/email*.ts`, `packages/api/src/routes/email.ts`, `packages/api/src/email/*`, `packages/api/src/operator/email-routes.ts`, `packages/api/src/admin/routes/email.tsx`, `../packages/void/src/cli/email*.ts`, `../packages/void/src/runtime/email*` |
| Runtime logs and live tailing                                                  | `packages/tail/src/index.ts`, `packages/api/src/admin/routes/deployments.tsx`                                                                                                                                                                                                                       |
| User-facing dashboard                                                          | `packages/dashboard/pages/*`, `packages/dashboard/middleware/01.auth.ts`, `packages/dashboard/lib/api.ts`                                                                                                                                                                                           |
| Dashboard styling                                                              | `packages/dashboard/ui/styles/base.css`, `packages/dashboard/ui/styles/tokens.css`                                                                                                                                                                                                                  |

The dashboard depends on `void` and `@void/react` through normal `workspace:*` dependencies. Those packages export only their `dist/` output, so run `vp run build` before `vp run --filter @voidcloud/platform deploy` on a fresh checkout. The platform workflows do this; the task graph does not.

## SDK guidance

Public SDK architecture and adapter guidance live in the
[root instructions](../AGENTS.md) and
[core package instructions](../packages/void/AGENTS.md).
Use the [framework integration guide](../docs/integrations/frameworks/overview.md)
for the supported framework list.

## Platform Package Overview

### `packages/api`

The control plane.

- Owns users, OAuth accounts, projects, deployments, resources, domains, and platform events.
- Stores platform metadata in PostgreSQL via Hyperdrive.
- Exposes the API used by the CLI and dashboard.
- Runs deploys, rollbacks, provisioning, routing updates, queue setup, and retention cleanup.
- Also contains the administrator UI in `src/admin/`.
- When configured, hosts **Deploy on GitHub**: connect a repo via a GitHub App, and a `git push` triggers an automatic build + deploy. Routes under `/github`, `/webhooks/github`, `/auth/github-oidc`, and `/projects/:id/github` handle App install/connect, webhook verification, and GitHub Actions OIDC. An Access-protected API uses the optional standalone source ingress for GitHub deliveries; the core installer does not deploy it. GitHub's **Re-run** / **Re-run all checks** buttons on the "Void Build" check re-enqueue a container build through the same push pipeline (see the pitfall below — the App must subscribe to `check_run`/`check_suite`). Builds run in one of two executors — a Cloudflare Container (default) or GitHub Actions — coordinated by the `BuildScheduler` and `BuildManager` Durable Objects. The build environment runs the real `void deploy` CLI with a short-lived scoped deploy token, so the deploy pipeline itself is unchanged.

### `packages/dashboard`

The optional authentication frontend, built with Void React Pages. It provides
sign-in, callback, sign-out, and a minimal authenticated page. The administrator
UI and full operator API live in the API Worker.

See the [dashboard README](./packages/dashboard/README.md) for source development.
The core installer does not deploy this app. Void Cloud deploys it after its
other Workers so its API dependency is available.

### `packages/dispatch`

The edge router.

- Reads slug/domain routing from KV.
- Sends worker projects to Workers for Platforms.
- Serves current static/SPA deployments directly from R2, while retaining KV reads for small assets carried forward from legacy deploys.
- Handles ISR, edge caching, redirect/rewrite rules, header rules, and signed request metering.
- Relays Cloudflare Queue batches to user workers.

Request and sandbox usage queue messages are authenticated with a
purpose-separated key held in the platform's private routing KV. The API health
check initializes that key before installation traffic is enabled. Sandbox
elapsed time is measured from API-owned lease transitions; tenant Workers do
not receive the usage queue producer binding. After an upgrade, unsigned frames
from older deployed SDK runtimes are acknowledged and ignored. Redeploy those
apps to remove the dormant legacy binding.

### `packages/proxy`

The shared proxy layer.

- Routes all AI traffic through AI Gateway for metering.
- Supports BYOK provider models in addition to Workers AI.
- Provides authenticated remote D1/KV/R2 access for local development.
- Forwards ISR revalidation requests from user workers to the API.

### `packages/tail`

The runtime log pipeline.

- Receives tail events from dispatch/user workers.
- Writes logs to Analytics Engine.
- The API reads stored events for runtime log inspection; CLI following polls those results.

## Tooling

Use the versions declared in `.node-version`, `pnpm-workspace.yaml`, and package
manifests. Vite+ supplies the build, test, lint, format, and package commands;
platform Workers run through the checked-in development scripts. PostgreSQL is
used for platform metadata and reached through Hyperdrive in deployed Workers.

## Testing

Tests run from root with `vp test run`. See each package README for detailed test listings.

## Operations

For an installed platform, use `void platform` lifecycle and administrator
commands. `vp run --filter @voidcloud/platform health` forwards to
`void platform system health`, using the selected connection and operator login.
Automation supplies `VOID_OPERATOR_TOKEN` and an explicit `VOID_API_URL`.

Void Cloud maintains an existing deployment that predates the installer. Its
`platform/package.json` deployment scripts and `platform/deployments/void-cloud.json`
descriptor belong to that deployment. The [Void Cloud operations note](./meta/operations.md)
explains its environments and credentials without storing account-specific
inventories or personal access assignments in the repository.

The hosted deploy/smoke workflows target the existing Void Cloud deployment.
Forks build their own runtime and use `void platform install` or
`void platform upgrade --runtime`, as shown in the development guide.

## Implementation Notes

- Platform metadata uses PostgreSQL through Hyperdrive. Application databases
  still default to D1 unless an app selects PostgreSQL or MySQL.
- Keep Worker TypeScript libraries explicit. DOM globals can hide the Workers
  types, including `CacheStorage.default`.
- Deploy protocol and database changes must tolerate the previous Worker version
  during rollout. Use additive migrations and verified compatibility edges.
- Static applications are served from platform assets. Worker applications also
  mirror assets in KV/R2 so dispatch can recover from the Cloudflare missing-asset
  response; see the [fallback design](./meta/design-docs/0066-wfp-asset-r2-fallback.md).
- Keep routing changes, cron synchronization, and resource cleanup ordered around
  the successful deployment cutover. A pre-cutover failure must preserve the
  previous application's active configuration.
- Build subprocesses need `CI=true` so terminal prompts and animations do not
  interfere with captured output. Preserve raw logs for terminal consumers and
  sanitize them when rendering HTML or Markdown.
- Only Durable Object storage operations hold its input gate. Network I/O can
  interleave with cancellation and polling; shared log drains and teardown must
  keep their existing single-flight ordering.
- Bound retries and log processing by both time and input size. A timeout on a
  wait does not cancel the underlying database operation, and a row-count limit
  alone does not bound payload bytes or processing work.
- Drain build logs before publishing completion. Cancellation must preserve the
  authoritative final marker even when another handler has already changed the
  build's status. See the build-manager regression tests.
- GitHub build reruns require `check_run` and `check_suite` webhook subscriptions
  in addition to Checks write permission. Reuse the same ownership, branch-head,
  and deduplication checks as push-triggered builds.
- The fallback build-container CLI version is derived from the SDK package
  version. The version equality test enforces this during updates.

The [lessons](./meta/lessons.md) and affected package tests contain more detailed
invariants. The [design archive](./meta/design-docs/README.md) explains historical
tradeoffs without acting as a live deployment runbook.
