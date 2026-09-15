---
name: void
description: Void skill for app development and CLI operations. Use this skill to route user requests to the appropriate bundled Void docs.
---

# Void Skill

This skill is a router. Open the minimum relevant docs files under `docs/` and execute.

Docs in this skill are bundled from `docs/` during `void` package build and live at:

- `skills/void/docs/**/*.md`

## Command Naming

Use Void commands for every user-facing workflow. Never ask the user to install, authenticate, or run Wrangler directly. Say Cloudflare or Void instead, except when naming literal `wrangler.jsonc` / `wrangler.json` files or `WRANGLER_*` environment variables the user must inspect.

Use `void` in examples and commands in this skill. For first-time setup, prefer `void init` followed by `void deploy`; in an empty directory, install `void` first and let `void init` add the matching Pages adapter and starter dependencies with Vite+ as the default scaffold toolchain. In an existing app, `void init` configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`. For Cloudflare deployment, Void uses bundled tooling and secure browser OAuth; init or the first deploy saves the selected `account_id`, and `void cloudflare login|status|logout` manages the session; Void-managed deployment requires an explicitly connected platform. Use `void platform connect <url>` for an existing platform or `void platform install --plan` to preview a company control plane in the user's Cloudflare account. The core self-hosted platform excludes the dashboard, GitHub App, and build Containers; lifecycle commands are resumable and verify remote, Worker, and R2 ownership before mutations. `void platform disable` gates traffic through installation-owned routing storage and remains disabled through repair or upgrade; `void platform enable` explicitly restores traffic. Safe uninstall retains name-addressed Workers, R2, AI Gateway, external PostgreSQL, and zones for explicit manual cleanup. Direct Cloudflare deploys support native Void apps, static/SPA/SSG output, and Cloudflare builds from TanStack Start, React Router, vinext, SvelteKit, Nuxt, Analog, and Astro. They provision inferred resources, validate and apply migrations, promote `.secret()` env keys to encrypted Worker secrets, upload and probe an immutable Worker Version, then activate and synchronize triggers. Native Void features are Workers Free-compatible by default; `void/sandbox` is an explicit exception because it uses Cloudflare Containers and therefore requires Workers Paid. A Sandbox deploy checks Containers access before provisioning/building, while apps without Sandbox perform no entitlement probe. Versions without preview URLs are staged at 0% and probed through workers.dev using a version override; the same safe fallback applies when Access blocks a generated preview alias but admits the stable Worker hostname. Set `CLOUDFLARE_WORKERS_SUBDOMAIN` in a fresh CI checkout, while local deploys cache it automatically. When Cloudflare Access protects `workers.dev`, use an admitted `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` service-token pair for CI, or a short-lived `CF_ACCESS_TOKEN` from `cloudflared` for an interactive local readiness probe. With Cloudflare saved in `.void/project.json`, secret, domain, project status/log/rollback, and remote database commands operate directly on the pinned Worker/account. Logs are a live tail. Rollback restores the selected version's saved schedules, queues, workflows, routes, and domains but never reverses database migrations; legacy versions without trigger snapshots are rejected. On either deployment platform, auth-enabled `void deploy` preserves an existing `BETTER_AUTH_SECRET` or creates a persistent encrypted secret when missing; always use Void's deployment flow so it can manage that secret safely.

Use `void` and `@void/*` in code examples and package manifests.

Non-interactive self-hosted platform install, upgrade, repair, disable, enable, and uninstall commands require `--yes`; `--plan` is read-only and needs no acknowledgement.

Use `--runtime <directory>` on platform install, upgrade, repair, or enable when deploying a locally built `@void/platform` runtime. The directory must contain the generated integrity manifest, Worker artifacts, and migration tree. Build it with `vp run --filter @void/platform build`; set `VOID_PLATFORM_SOURCE_REVISION` during the build when the installation should record a source commit. Do not treat this as a safety bypass: custom and packaged runtimes follow the same verification and rollback path.

For self-hosted platform installation, require a dedicated empty PostgreSQL database. Interactive lifecycle commands use Cloudflare browser OAuth with keyring storage; the installed platform uses a separate `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`. The installer transactionally claims the database for one installation, pins that URL after a successful claim, never removes the claim during uninstall, and uses it for a cross-host lifecycle lock plus a secret-free authoritative lifecycle manifest. Local recovery checkpoints are AES-256-GCM encrypted with an OS-keychain key; never place platform secrets in plaintext files. After discovery on a new machine, provide `VOID_PLATFORM_DATABASE_URL`. Normal upgrades preserve deployed Worker secrets; restoring the original runtime, GitHub, R2, JWT, and project-encryption values is required only when recreating a missing Worker. Lifecycle redeploys preserve unmanaged Worker routes and custom domains in both the new trigger state and rollback snapshot. They stop before migrations or uploads when live Hyperdrive origin metadata differs from the pinned database. Platform upgrade SQL is forward-only: packaged hashes and the live Drizzle prefix must match, pending migrations require an exact source-version/schema rollback edge, and the old version remains authoritative until target health succeeds. Safe uninstall retains Worker routes, custom domains, and R2 for explicit manual cleanup because Cloudflare cannot condition their deletion on an immutable generation.

## No-Args Behavior

Published self-hosted platform routes and custom domains are observed and recorded as retained attachments. Lifecycle commands gate traffic through installation-owned routing storage but never delete those attachments unattended.

If invoked without a concrete task, do a brief app status check and report:

1. App type (`void`, `framework`, `spa`, `static`) using `docs/app-types.md` criteria.
2. Backend feature usage (`routes/`, `pages/`, `middleware/`, `migrations/`, `crons/`, `queues/`, SSR entries).
3. Runtime signals (`void/db`, `void/kv`, `void/storage`, queue usage).
4. Auth signals (`void/auth`, `auth` client imports, OAuth env vars).
5. Deployment platform and optional Void project linkage (`.void/project.json`), plus config readiness (`void.json`, Cloudflare `account_id`, tsconfig extends).
6. Optional health checks (`void auth whoami`, `void db status` when relevant).

Then ask what to do next.

## Task Routing

| User intent                                | Docs file(s)                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| CLI command syntax, flags, env vars        | `docs/reference/cli.md`                                                                   |
| Initial setup, onboarding, first app       | `docs/guide/quickstart.md`, `docs/reference/cli.md`                                       |
| App type detection and mode behavior       | `docs/guide/app-types.md`, `docs/reference/config.md`                                     |
| Server/API routing and middleware          | `docs/guide/server-routing.md`, `docs/integrations/hono.md`                               |
| Pages mode, loader/action, forms, layouts  | `docs/guide/pages-routing/*.md`, `docs/guide/type-safety.md`                              |
| Database and migrations                    | `docs/guide/database.md`, `docs/guide/type-safety.md`                                     |
| Typed fetch and end-to-end typing          | `docs/guide/typed-fetch.md`, `docs/guide/type-safety.md`                                  |
| Authentication                             | `docs/guide/auth.md`, `docs/guide/env-vars.md`                                            |
| Cloudflare runtime bindings and config     | `docs/integrations/cloudflare.md`, `docs/reference/config.md`, `docs/guide/env-vars.md`   |
| AI inference (Workers AI, providers)       | `docs/guide/ai.md`                                                                        |
| KV / storage / queues / cron jobs          | `docs/guide/kv.md`, `docs/guide/storage.md`, `docs/guide/queues.md`, `docs/guide/jobs.md` |
| SSR and caching                            | `docs/guide/ssr.md`, `docs/guide/edge/*.md`                                               |
| Rewrites, redirects, fallbacks             | `docs/guide/edge/rewrites.md`, `docs/guide/edge/redirects.md`, `docs/reference/config.md` |
| Static site generation                     | `docs/guide/ssg.md`                                                                       |
| Deployment and CI                          | `docs/guide/deployment.md`, `docs/reference/cli.md`                                       |
| Install or manage a company Void platform  | `docs/guide/self-hosted-platform.md`, `docs/reference/cli.md`                             |
| Self-host deploy to own Cloudflare account | `docs/integrations/cloudflare.md`, `docs/reference/cli.md`                                |
| Project status, deployment history         | `docs/reference/cli.md`                                                                   |
| Cache purging                              | `docs/reference/cli.md`                                                                   |
| Project logs, runtime errors               | `docs/reference/cli.md`                                                                   |
| Secrets management (put/sync/delete)       | `docs/reference/cli.md`, `docs/guide/env-vars.md`                                         |
| Typed env vars (`defineEnv`, `env.ts`)     | `docs/guide/env-vars.md`                                                                  |
| Custom domain setup                        | `docs/reference/cli.md`                                                                   |
| Database status, reset, seed, export       | `docs/reference/cli.md`, `docs/guide/database.md`                                         |
| Auth login/logout/whoami                   | `docs/reference/cli.md`                                                                   |
| Overview / introduction                    | `docs/guide/index.md`                                                                     |
| API surface details                        | `docs/reference/api.md`                                                                   |
| Meta framework integration                 | `docs/integrations/frameworks/*.md`                                                       |
| Coding agent setup                         | `docs/integrations/agents.md`                                                             |
| Node.js / Bun / Deno targets               | `docs/integrations/nodejs-bun-deno.md`                                                    |
| ORMs and external databases                | `docs/integrations/orms-and-external-dbs.md`                                              |
| Project structure and conventions          | `docs/reference/structure.md`                                                             |
| Resource/binding inference                 | `docs/reference/resource-inference.md`                                                    |

## Working Rules

- For any task involving running `void` commands — including checking status, managing secrets, viewing logs, or deploying — open `docs/reference/cli.md` FIRST. Do not guess command syntax.
- Never guess or infer `void` CLI command names or flags. Always consult `docs/reference/cli.md` for the exact command before running it.
- For multi-topic tasks, combine only the needed doc files.
- If docs and memory differ, follow docs.
- For Void-managed auth, `void db generate` automatically includes the production Better Auth schema in the generated migration, including configured model/field renames and plugin tables. Keep those migrations under `db/migrations/`; do not duplicate generated auth tables in the application Drizzle schema.
- **Env vars:** When the project has `env.ts`, the canonical access pattern is `import { env } from "void/env"`. Declare every env key in `env.ts` via `defineEnv({...})` so values are typed and validated. Do not introduce ad-hoc `process.env.X` or untyped `c.env.X` access in new code — add the key to `env.ts` first.
