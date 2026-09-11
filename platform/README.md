## Repository layout

The hosted Void platform lives in `platform/` inside the main Void monorepo. Public SDK packages live in the repository-level `packages/` directory. Both surfaces share one pnpm workspace, lockfile, Vite+ configuration, and commit history.

Paths in this file are relative to `platform/` unless they begin with `../`. For example, `packages/api` is the hosted control plane and `../packages/void` is the public SDK package.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- Refer to the [Design Doc](./meta/design-docs/0001-design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/progress.md) for tracking progress.
- Public SDK: repository-level `packages/`. If work involves the SDK, read the root `AGENTS.md` and the affected package instructions first.
- Public-facing docs: repository-level `docs/` (VitePress site).

## Best Practices That Must Be Followed

1. General

- **Always** read `meta/lessons.md` at the start of each session before taking any action.
- **Never** commit without asking for confirmation.
- When writing design docs or implementation plans to disk, place them in `meta/design-docs` and follow existing file name and frontmatter conventions.
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
   - Progress tracking: tick off relevant steps in `meta/progress.md` when applicable.

## Quick Reference

| Command                                     | Purpose                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `vp run --filter @voidcloud/platform dev`   | Start the dashboard dev server only                                         |
| `vp run --filter @voidcloud/platform build` | Build the dashboard only                                                    |
| `vp run build:all`                          | Build SDK packages, platform surfaces, and playgrounds                      |
| `vp test run --project 'platform-*'`        | Run platform unit and integration tests                                     |
| `vp run lint:platform`                      | Run the platform's type-aware lint pass                                     |
| `vp run check`                              | Run every workspace package's `typecheck` script                            |
| `vp run test:all`                           | Run formatting, linting, all builds, typechecks, and all SDK/platform tests |
| `vp run deploy`                             | Deploy `api` → `proxy` → `tail` → `dispatch` → `dashboard`                  |
| `vp run deploy:dashboard`                   | Deploy the dashboard only                                                   |
| `vp run deploy:staging`                     | Deploy staging `api` → `proxy` → `tail` → `dispatch` → `dashboard`          |
| `vp run deploy:staging:dashboard`           | Deploy the staging dashboard only                                           |

The `@voidcloud/platform` workspace package retains the dashboard-only `dev` and `build` scripts. Dashboard deploys run after the platform workers in the platform deploy pipeline.

**Manual deploys only. Do not ask to push or deploy.**

## Local Development

For the platform API and internal admin UI, start with:

```bash
pnpm -C platform/packages/api setup
pnpm -C platform/packages/api exec wrangler dev --local --host localhost --port 8787
```

Then open `http://localhost:8787/admin/`.

If you also need the dashboard, run it separately:

```bash
vp run --filter @voidcloud/platform dev
```

The platform workspace's `dev` script starts the dashboard only. It does not start the platform API worker.

## Monorepo structure

Void is one repository with an explicit dependency boundary:

- Repository-level `packages/` — public SDK, CLI, runtime helpers, and framework adapters.
- `platform/packages/` — private hosted control plane, traffic router, proxy services, log pipeline, dashboard, and UI.
- Platform packages may depend on public/shared packages. Public SDK packages must not depend on `platform/`.

### Top-Level Map

| Path                                                   | Purpose                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`packages/api`](./packages/api/README.md)             | Control plane API, deploy pipeline, provisioning, internal admin UI       |
| [`packages/dashboard`](./packages/dashboard/README.md) | User-facing dashboard app                                                 |
| [`packages/dispatch`](./packages/dispatch/README.md)   | Edge router for `*.void.app` and custom domains                           |
| [`packages/proxy`](./packages/proxy/README.md)         | AI proxy, remote D1/KV/R2 proxy, ISR revalidation bridge                  |
| [`packages/tail`](./packages/tail/README.md)           | Runtime log ingestion and live tail streaming                             |
| [`packages/ui`](./packages/ui)                         | Shared internal CSS tokens                                                |
| [`../packages/void`](../packages/void/AGENTS.md)       | Main `void` package: Vite plugin, CLI, runtime, codegen, deploy packaging |
| `../packages/{vue,react,svelte,solid}`                 | Pages-mode adapters and runtime helpers                                   |
| `../packages/create-void`                              | Scaffolding package                                                       |
| `../packages/md`                                       | Markdown package                                                          |
| `../docs`                                              | Public-facing SDK docs                                                    |
| `meta/design-docs`                                     | Internal design history                                                   |
| `meta/progress.md`                                     | Progress tracker                                                          |
| `meta/operations.md`                                   | Operations/runbook                                                        |

### Where Code for X Lives

| Feature                                                                       | Primary code paths                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite plugin and local runtime                                                 | `../packages/void/src/index.ts`, `plugin-*`, `runtime/*`                                                                                                                                                                               |
| CLI commands                                                                  | `../packages/void/src/cli/*`                                                                                                                                                                                                           |
| File-based API routing                                                        | `../packages/void/src/router/*`, `runtime/handler.ts`                                                                                                                                                                                  |
| Pages routing, loaders, actions, named actions, deferred props                | `../packages/void/src/pages/*`, adapter runtimes in `../packages/{vue,react,svelte,solid}/src/runtime/*`                                                                                                                               |
| Typed route/page/action codegen                                               | `../packages/void/src/codegen/*`, `routes-stub.ts`                                                                                                                                                                                     |
| Binding inference                                                             | `../packages/void/src/plugin-inference.ts`, `../packages/void/src/inference/*`                                                                                                                                                         |
| Drizzle integration and migrations                                            | `../packages/void/src/drizzle/*`, `../packages/void/src/migrations/*`                                                                                                                                                                  |
| Framework detection and deploy presets                                        | `../packages/void/src/plugin-inference.ts`, `../packages/void/src/cli/preset.ts`                                                                                                                                                       |
| Platform auth and project APIs                                                | `packages/api/src/routes/*`, `packages/api/src/auth/*`, `packages/api/src/middleware/*`                                                                                                                                                |
| Internal admin UI                                                             | `packages/api/src/admin/*`                                                                                                                                                                                                             |
| Deploy pipeline                                                               | `../packages/void/src/cli/deploy.ts`, `packages/api/src/routes/deploy.ts`, `packages/api/src/assets.ts`, `packages/api/src/provisioning/*`                                                                                             |
| Deploy on GitHub (App connect, webhooks, OIDC, build containers)              | `packages/api/src/routes/{github,webhooks,auth-oidc}.ts`, `packages/api/src/github/*`, `packages/api/src/build-scheduler.ts`, `packages/api/src/build-manager.ts`, `packages/api/container/*`, `packages/api/src/auth/deploy-token.ts` |
| Hostname routing, static serving, ISR, redirects, rewrites, headers, metering | `packages/dispatch/src/*`                                                                                                                                                                                                              |
| AI metering, BYOK AI gateway, remote D1/KV/R2 access, revalidation bridge     | `packages/proxy/src/*`                                                                                                                                                                                                                 |
| Runtime logs and live tailing                                                 | `packages/tail/src/index.ts`, `packages/api/src/admin/routes/deployments.tsx`                                                                                                                                                          |
| User-facing dashboard                                                         | `packages/dashboard/pages/*`, `packages/dashboard/middleware/01.auth.ts`, `packages/dashboard/lib/api.ts`                                                                                                                              |
| Shared internal styling                                                       | `packages/ui/src/base.css`, `packages/ui/src/theme.css`                                                                                                                                                                                |

The dashboard depends on `void` and `@void/react` through normal `workspace:*` dependencies. The monorepo task graph builds those packages before the dashboard when required.

## SDK overview

The repository-level packages and docs are the public product surface.

### `../packages/void`

This is the main `void` package.

- `src/index.ts` wires together routing, pages-mode infrastructure, codegen, migrations, prerendering, Cloudflare integration, and non-CF targets.
- `src/cli/*` contains the CLI.
- `src/router/*` handles `routes/` scanning and route compilation.
- `src/pages/*` handles pages-mode scanning, protocol, head management, defer, and manifest generation.
- `src/runtime/*` contains helpers exposed as `void/db`, `void/kv`, `void/storage`, `void/ai`, `void/isr`, `void/client`, and auth utilities.
- `src/codegen/*` generates `.void/routes.d.ts`, `.void/db.d.ts`, `.void/queues.d.ts`, and tsconfig glue.
- `src/drizzle/*` and `src/migrations/*` handle schema discovery and migration execution.
- `src/plugin-node-target.ts` supports `target: "node" | "bun" | "deno"`.

### Adapter packages

- `../packages/vue`
- `../packages/react`
- `../packages/svelte`
- `../packages/solid`

These packages provide pages-mode adapters, links, forms, router helpers, prefetching, and framework-specific client behavior.

### Framework support

Current public support is:

- TanStack Start
- React Router
- SvelteKit
- Nuxt
- Astro

There is Vinext-specific source in the framework repo, but it is intentionally on hold and not part of the current public support matrix.

## Platform Package Overview

### `packages/api`

The control plane.

- Owns users, OAuth accounts, projects, deployments, resources, domains, and platform events.
- Stores platform metadata in PostgreSQL via Hyperdrive.
- Exposes the API used by the CLI and dashboard.
- Runs deploys, rollbacks, provisioning, routing updates, queue setup, and retention cleanup.
- Also contains the internal admin UI in `src/admin/`.
- Hosts **Deploy on GitHub**: connect a repo via a GitHub App, and a `git push` triggers an automatic build + deploy. Routes under `/github`, `/webhooks/github`, `/auth/github-oidc`, and `/projects/:id/github` handle App install/connect, webhook verification, and GitHub Actions OIDC. GitHub's **Re-run** / **Re-run all checks** buttons on the "Void Build" check re-enqueue a container build through the same push pipeline (see the pitfall below — the App must subscribe to `check_run`/`check_suite`). Builds run in one of two executors — a Cloudflare Container (default) or GitHub Actions — coordinated by the `BuildScheduler` and `BuildManager` Durable Objects. The build environment runs the real `void deploy` CLI with a short-lived scoped deploy token, so the deploy pipeline itself is unchanged.

### `packages/dashboard`

The user-facing dashboard.

- Built as a Void Vue pages app.
- Uses direct Postgres reads through Hyperdrive for read-heavy loaders.
- Uses the API for mutations, usage metrics, secrets, and domain operations.
- Is deployed separately from the main platform pipeline.
- Is currently de-emphasized relative to the rest of the platform work.

### `packages/dispatch`

The edge router.

- Reads slug/domain routing from KV.
- Sends worker projects to Workers for Platforms.
- Serves current static/SPA deployments directly from R2, while retaining KV reads for small assets carried forward from legacy deploys.
- Handles ISR, edge caching, redirect/rewrite rules, header rules, and request metering.
- Relays Cloudflare Queue batches to user workers.

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
- Broadcasts live log events through a Durable Object.

## Tooling

| Tool                   | Version   | Purpose                                                                                        |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| Node.js                | 24.13.1   | Runtime (TS type stripping enabled natively — no `tsx` or `--experimental-strip-types` needed) |
| Vite+                  | 0.2.x     | Unified toolchain (`vp`, Vite, Vitest, Oxlint, Oxfmt)                                          |
| pnpm                   | 11.x      | Package manager with workspaces + catalog                                                      |
| wrangler               | 4.x       | CF Worker dev/deploy (api, dispatch)                                                           |
| drizzle                | 0.45.x    | Type-safe ORM for API PostgreSQL (schema + queries + migrations)                               |
| vitest                 | via Vite+ | Unit + integration tests                                                                       |
| oxlint                 | via Vite+ | Linting                                                                                        |
| oxfmt                  | via Vite+ | Formatting                                                                                     |
| vite                   | via Vite+ | Dev server + build (dashboard)                                                                 |
| jose                   | 6.x       | RS256 GitHub App JWT, scoped deploy tokens, GitHub Actions OIDC verification (`api`)           |
| @cloudflare/containers | 0.3.x     | `BuildManager` container base class for Deploy-on-GitHub builds (`api`)                        |

## Testing

Tests run from root with `vp test run`. See each package README for detailed test listings.

## Operations

There are five deployable platform packages/surfaces:

| Package              | Worker / Surface                                | Role                                           |
| -------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `packages/proxy`     | `proxy.void.cloud` / `proxy.staging.void.cloud` | AI proxy, remote bindings, revalidation bridge |
| `packages/tail`      | internal worker                                 | Worker log ingestion and live tail             |
| `packages/api`       | `api.void.cloud` / `api.staging.void.cloud`     | Control plane API and internal admin UI        |
| `packages/dashboard` | `dash.void.cloud` / `dash.staging.void.cloud`   | User-facing dashboard                          |
| `packages/dispatch`  | `*.void.app` / `*.staging.void.app`             | User traffic router                            |

```
vp run deploy                     # api -> proxy -> tail -> dispatch -> dashboard
vp run deploy:dashboard           # dashboard only
vp run deploy:staging             # staging api -> proxy -> tail -> dispatch -> dashboard
vp run deploy:staging:dashboard   # staging dashboard only
```

See [`meta/operations.md`](./meta/operations.md) for the full operations reference — CF resources, secrets, environment variables, DNS setup, GitHub Actions, and fresh environment provisioning.

Staging hostnames are gated by Cloudflare Access (GitHub organization `voidzero-dev` via GitHub). For local dev, install `cloudflared` (`brew install cloudflared`) — the Void CLI auto-authenticates you via a browser popup on first use and caches a 24h JWT. CI uses the shared `void-staging-programmatic` service token. See [`meta/operations.md`](./meta/operations.md#staging-access-control) for full setup, rotation, and rollback.

## Pitfalls / Things That Broke

- **Platform DB is PostgreSQL; user apps still default to D1** — Platform metadata lives in PostgreSQL via Hyperdrive (`packages/api/src/schema.ts` is the source of truth). User projects still default to D1 unless the app opts into `"database": "pg"` or `"database": "mysql"`.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `dispatch`. Not applied to `api` (its tests use Miniflare/Node which needs DOM-compatible `URL` types).
- **Deploy protocol and schema changes must stay backward compatible** — deploy manifests are versioned, and schema changes must tolerate old code briefly running against the new schema during deploy. Safe: additive changes. Unsafe without a two-phase rollout: renames, drops, and type changes.
- **Project type field is `mode` in DB, `type` everywhere else** — The `projects` table column is `mode` (DB column name), but the Drizzle schema field and all TypeScript code use `type` (`type: text("mode")`). The `DeployManifest` field is `type`, the API function is `updateProjectType`, and all views/templates reference `project.type`. Values: `"void"` (Void apps), `"spa"`, `"static"`, `"framework"` (3rd-party meta-frameworks like Astro/SvelteKit).
- **Static deployments use KV/R2, not WfP** — Projects with type `"static"` or `"spa"` are served directly by dispatch from content-addressed KV/R2 assets. No WfP worker script is created for those deploys.
- **WfP deploys mirror assets to KV/R2 as a safety net** — Projects with type `"void"` or `"framework"` still serve assets via CF's per-worker `ASSETS` binding. Each deploy _also_ mirrors assets to `STATIC_ASSETS`/`STATIC_ASSETS_R2` and writes a serving manifest to `ROUTING` KV. When CF returns the `Assets have not yet been deployed to this script.` stub (see `meta/design-docs/0065`, `meta/design-docs/0066`), dispatch detects it and serves from the mirror. CF remains primary; the mirror is only consulted on stub detection.
- **Deploy-on-GitHub builds run the real `void deploy` CLI** — The build environment (CF Container or GitHub Actions) does not re-implement packaging or POST artifacts to the API. It runs `npx void deploy` with a short-lived, project-scoped deploy token (`aud: "deploy"`, 15-min TTL, minted by `src/auth/deploy-token.ts`). There is **no** `POST /builds/:id/artifacts` endpoint and `routes/deploy.ts` is unchanged. Design docs `0010`/`0011` predate the JSON-manifest, direct-to-R2 deploy endpoint and describe a stale artifact-upload premise — do not follow them verbatim.
- **Container→DO live-log transport (now wired via a DO pull-loop)** — `BuildManager` PULLS build-log lines from the build container's agent: a `pollLogs()` loop uses a non-starting `getTcpPort().fetch()` (deliberately **not** `containerFetch`, which would auto-resurrect an exited container) against the agent's `GET /logs?since=N`, advancing an in-memory cursor (~1s cadence, self-terminating on terminal status) and feeding the existing SQLite `logs` table + WebSocket fan-out. (This replaced the earlier "not yet wired" follow-up; the chosen mechanism is the DO pull-loop, **not** a `ContainerProxy` `outboundByHost` outbound interceptor.) The DO also exposes a read-only `GET /logs?since=N` returning `{ lines, lastSeq }`. The internal admin panel surfaces this: a per-project Builds section on `/admin/projects/:id` (ongoing build highlighted) and a build page `GET /admin/builds/:id` with a client-side polling live-log panel (NOT a WebSocket) for container builds. `github_actions` builds have no DO log store and instead link out to their GitHub Actions run. Users can now also view container build logs for their own projects via the CLI (`void build logs`), which fronts the same DO log store through the owner-guarded projects-router routes `GET /projects/:id/builds` and `GET /projects/:id/builds/:buildId/logs` (`github_actions` builds return their Actions run URL instead). Container-build check runs now also embed the last 100 captured log lines in the check-run `output.text` at completion (all terminal outcomes; `github_actions` checks unchanged — they link to the Actions run).
- **The pull-loop needs both an exit acknowledgement barrier and a teardown drain** — The DO pull-loop is the only path that durably ingests container logs, so the agent keeps its control server alive after the build process exits until the DO has acknowledged every recorded sequence. The wait is progress-aware: an 8s idle deadline resets only when the acknowledged cursor advances, while a 120s absolute cap prevents a peer that supplies endless partial progress from pinning the container; `enforceTimeout` is armed with 125s of post-build grace. Teardown cannot rely on that natural-exit path because SIGTERM ends in `process.exit(1)`, so `forceStopContainer()` owns one whole first-caller-wins single-flight sequence: join any scheduled pull, take one fresh paginated snapshot when the first caller requested a drain, re-read liveness, then attempt stop/destroy. Later teardown callers join that same sequence and cannot start a late pull after signalling or override the first caller's drain policy. A manager termination marker is appended only after at least one control call against a freshly-live container succeeds; a natural exit during the drain emits no false marker. Pull callbacks retain a 4s whole-drain deadline plus per-request timeouts, and paging/ring limits are measured in serialized bytes so an oversized backlog advances rather than livelocking. Keep pulls on `getTcpPort().fetch()` rather than `containerFetch`, which can resurrect an exited container.
- **Build children must be told `CI=true`, and the check-run tail is terminal-rendered** — The container agent hands every build child `CI: 'true'` (`nonInteractiveEnv()` in `container/build-agent.mjs`, merged into both install and `void deploy` spawns). This is load-bearing: the Void CLI's `createSpinner()` takes its plain logging path only when `@clack/prompts` sees that exact value; otherwise spinner frames are emitted as `ESC[1G ESC[J` with no newline and hundreds of erased frames arrive as one captured line. Independently, `formatLogTailMarkdown` renders each line before byte accounting because arbitrary third-party build tools may still emit terminal controls, and a Markdown code fence prints rather than interprets them. Render-time only: the live tail and `void build logs` retain color.
- **Use a maintained terminal emulator for check-run text, with deterministic outer bounds** — `sanitizeLogLineForMarkdown` uses `@xterm/headless`, the same VT engine used as the differential oracle, rather than owning another partial CSI/ESC screen model. Tokenizers such as ANSI strippers are insufficient because correctness depends on state: cursor movement, configured tab stops, protected cells and selective erase, wide glyphs, REP, C0/C1 transitions, string controls, and alternate-buffer/history resets all affect what remains visible. The agent preserves each captured row's exact CR/LF/CRLF/EOF ending internally, and the newest 100-row check-run window is rendered chronologically through one persistent xterm so parser state and terminal modes survive row boundaries; that bounded window is the explicit terminal-state reset boundary. The internal ending field is additive and is not exposed by the public log APIs; existing DO tables are upgraded in place with unknown provenance left nullable, letting the formatter retain legacy CRLF-between-rows behavior without fabricating a delimiter after the final row. Plain rows bypass the emulator. Controlled rows use one fixed 32K-column grid, are preflighted for input size plus work-amplifying commands, and reject insert mode; ordinary SGR and cursor parameters are not treated as parser work. The newest tail rows also share a deterministic input/work budget. If a state-mutating group inside the window must be omitted, the formatter fails closed rather than restarting with invented terminal state. Do not replace these limits with `performance.now()` deadlines: deployed Workers do not advance their clocks during CPU work, and xterm has handlers that loop or allocate directly from `Ps` before a caller can inspect time. Correctness remains pinned by fixed and deterministic-fuzz comparisons in `test/unit/sanitize-log-line-oracle.test.ts`.
- **Drain-barrier timing is progress-aware** — A pull callback may spend `LOG_DRAIN_BUDGET_MS = 4000` draining paginated responses and re-arm one second later, so a deep 16MiB ring can require several productive callbacks. The agent now keeps an 8s idle deadline that resets only when the acknowledged cursor advances, plus a non-resettable 120s absolute cap; a dead DO still releases its container after 8s, while a slow healthy drain can finish the conservative 32-request envelope. The DO grants 125s of post-build grace so it cannot overwrite an already-live deployment while that barrier is active. Tests pin the idle, absolute, grace, and deploy-token relations. `onError` is the one terminalizer that does not force-stop, so it owns its own bounded retry loop (`LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS = 7000`, one `POLL_SECONDS` of margin inside the agent's 8s idle barrier): a transient port failure or a budget-exhausted pull is retried instead of being treated as the final attempt, and a teardown that starts during any of those pulls is joined before the check run is finalized.
- **Log ingestion is bounded by deterministic WORK, not only by a clock** — `LOG_DRAIN_BUDGET_MS` cannot bound a pull callback's CPU: a deployed Worker's clock advances on I/O, not during CPU work, so it measures the agent's response latency and scores every JSON parse, SQLite insert and WebSocket fan-out between the fetches as free. `MAX_LOG_PULL_PAGES` bounds the response SIZE (32 x `MAX_LOG_RESPONSE_BYTES`), and bounding the size of data does not bound the work done on it — 64 MiB of rows is `(1 + subscribers)` copies of itself, all of it in front of the SIGTERM a cancel or timeout depends on. `MAX_LOG_SINK_OPS_PER_DRAIN` (= `MAX_STORED_LOG_LINES`, the DO's retained window — a bigger budget could only buy work the same batch's eviction discards) charges each ingested row `(1 + subscribers) * max(1, ceil(len / LOG_SINK_OP_PAYLOAD_BYTES))` and stops the callback when it is spent. Checked BETWEEN pages only: a page is ingested atomically, so the cursor never advances past rows that did not reach the sink and one maximum page may overshoot. A callback that stops on the budget skips its final acknowledgement request; the next one's `since=<advanced cursor>` is that acknowledgement.
- **Drain authorization and reconciliation follow-up (current rule)** — A DO-local terminal status does not prove the Postgres build row is terminal: one teardown writes local state before awaiting its revocation CAS, so a concurrent `cancelBuild` can observe terminal locally while the deploy token is still authorized. That path must perform a bounded authoritative row read and drain only when the row is terminal or absent; an active, failed, or timed-out read skips straight to the signals. A bounded reconciliation read is also the only row read that path may depend on: pass both its `status` and `check_run_id` into check-run finalization. An explicit null id means the authoritative row had none and suppresses a second, unbounded fallback read while still allowing an in-memory or DO-storage id.
- **`PINNED_VOID_CLI_VERSION` must equal the workspace SDK package** — The build container's fallback CLI version (`build-manager.ts`) applies only to repos with **no local `void` dependency**, so drift is invisible in every normal build; it silently sat at `0.9.1` while the SDK moved to `0.10.x`. `build-manager.test.ts` asserts it against `../packages/void/package.json`. Bump the constant whenever the SDK package version moves.
- **`github_actions` "Void Build" check run is create-at-OIDC / complete-from-webhook** — The Actions executor has no BuildManager DO, so the "Void Build" GitHub Check Run is created (`in_progress`) once at the OIDC exchange (`routes/auth-oidc.ts`) and guarded on `!build.check_run_id` so a repeated exchange that REUSES the in-flight build never POSTs a second run / overwrites the id. It is completed from `workflow_run:completed` (`routes/webhooks.ts`) with a conclusion mapped from GitHub's `workflow_run.conclusion` (success→success, cancelled→cancelled, timed_out→timed_out, else failure), driven INDEPENDENT of our internal build-status CAS — so a build terminalized out-of-band (push-supersede, OIDC latest-wins, disconnect, app/repo removal, teardown, reaper) still gets its check completed. Both calls are best-effort. The OIDC create+persist is awaited SYNCHRONOUSLY (before the deploy token is returned) so `check_run_id` is durable before the deploy runs — this is what makes the `!build.check_run_id` guard race-free for sequential retries and closes the completion-miss window; `setBuildCheckRunId` is CAS `check_run_id IS NULL` (immutable once set). The webhook completion is deferred via `executionCtx.waitUntil` (off the 2xx and off the critical token-revoking DB path; idempotent, and a redelivery re-completes). Residual bounded orphans (check may stay `in_progress`): app/repo/connection removed mid-run (GitHub unreachable for the PATCH), a genuinely missed completion webhook (past the reaper timeout), or a pathological pair of TRULY CONCURRENT OIDC exchanges for the same run+attempt (duplicate check, one orphaned) — all accepted, mirroring the container path's best-effort boundary.
- **The source download is bounded by a STALL guard, not a wall clock** — `downloadSource` in `container/build-agent.mjs` used to `fetch` the tarball with no deadline at all. One build (`bld_33gs31a2x6qj`, voidzero.dev) spent its entire 16m52s there: the stream degraded to short bursts separated by dead minutes, delivered ~4.4 MB of a 20.8 MB archive, and only failed at the end. Cloudflare telemetry made it unambiguous — 2.5s of CPU total, memory flat at the agent's own 145 MB and disk grown 5.4 MB, against 2137 MB / 968 MB for the SAME repo 12h earlier. Node's undici defaults cannot catch this: `bodyTimeout` resets on every chunk, so any trickle defeats it. The guard is `SOURCE_STALL_TIMEOUT_MS` (20s with NO bytes at all), because a healthy download streams continuously (measured 1.5 MB/s) and therefore cannot trip it; an absolute per-attempt cap or a minimum-throughput floor WOULD newly fail a large repo on a slow but honest link, so neither exists. `SOURCE_PHASE_BUDGET_MS` (240s) is the only wall clock and spans ALL attempts together, sized to sit inside the smallest plan budget (free = 10min). 401/404/410 fail on the first attempt, but a 403 is classified from its HEADERS and a bounded prefix of its BODY, not its status: GitHub answers 403 for a permission failure AND for both kinds of rate limit, so `retry-after`, `x-ratelimit-remaining: 0`, or a body naming the secondary limit makes it retryable, and the server's own delay replaces the fixed backoff. Status and headers classify FIRST and only an otherwise-ambiguous 403 has its body read — a 429, or a 403 already carrying `retry-after`/`x-ratelimit-remaining: 0`, is a rate limit on evidence already held, and reading its body could only LOSE that (headers arrive, body stalls, the stall watchdog aborts, and a known `retry-after` becomes a generic error). Any rate-limited response that names no delay waits `SECONDARY_RATE_LIMIT_DELAY_MS`, because coming back in two seconds is what escalates a recoverable limit into a banned integration; a server-NAMED delay is used verbatim. Every non-ok body is cancelled (`discardBody`), because undici holds the socket for one that is neither consumed nor cancelled. The sniff slices each chunk BEFORE decoding: bounding the accumulated string bounds the result, not the work, and one chunk can be the whole body. `x-ratelimit-reset` counts ONLY when `x-ratelimit-remaining` is exactly `0` — it rides along on every response including a plain 500, and an hour-away routine reset would overshoot `SOURCE_PHASE_BUDGET_MS` and turn a retryable 500 fatal. A delay that does not fit the budget ends the download instead of parking the container. Retries (3) restart from an empty tree — `resetWorkDirTree()` rm+mkdir on WORK_DIR, because a stalled attempt leaves a partial archive that the next `tar` would unpack on top of. 408/425/429/5xx and a non-zero `tar` exit retry. `extractTarball` settles ONLY from the child's `close`, never from the pipeline's rejection, so a retry cannot wipe WORK_DIR under a live extraction — and because a real `tar` dies too promptly to prove that, the regression test injects a child that outlives the rejection. The download also logs progress every 15s: before that the agent logged one line before the fetch and the next only after extraction, so a 17-minute stall was indistinguishable from a busy build in both the live tail and the check-run tail.
- **GitHub's "Re-run" button is a webhook, and it needs the event subscription** — `check_run:rerequested` (per-check "Re-run") and `check_suite:rerequested` ("Re-run all checks") are handled in `routes/webhooks.ts` via `rerunBuildForCommit`, which deliberately reuses the PUSH pipeline: same connection resolution, same renamed-repo self-heal, same fail-closed `getBranchHeadComparisonStatus` gate (`identical` only), same `supersedeAndCreateContainerBuild`. A rerun must never be a back door that deploys a commit a push could not, so re-running a check on a superseded commit is an intentional no-op. Dedup falls out of the shared helper: a `failed` build for the commit is never reused (so the failing case always enqueues fresh work), while a commit already `complete` AND live reuses that build and enqueues nothing. `github_actions` connections return an explicit ignore — nothing in the Checks API can start a workflow run. A per-check rerun targets ONE project: `external_id` (the build id `createCheckRun` stamps on every run) resolves the originating build, and candidates narrow to its project. `head_branch` cannot substitute — `project_id` is unique on `github_connections` but repo+branch are not, so several projects can publish their own "Void Build" run on the same commit, and resolving by branch alone would rebuild all of them from one click (or enqueue a container build from a click on another project's `github_actions` check). `head_branch` is NOT a filter: GitHub keeps one suite per app per commit even when that commit heads several branches, so filtering on it would drop the connection of a project tracking the other branch at the same SHA — the per-branch freshness gate decides instead, and it is exact. A per-check rerun that cannot resolve its build FAILS CLOSED — deleting a project cascades its build rows away while GitHub keeps check runs for months, so falling back to the branch set would let an orphaned check rebuild sibling projects owned by other users. `check_suite` keeps the fan-out, which is what "Re-run all checks" means. That fan-out compares one branch head per DISTINCT branch, CONCURRENTLY: awaiting them in series multiplies the one compare the push path affords by the branch count, against the same 10s delivery deadline that silently drops the click. The compares are independent and `getBranchHeadComparisonStatus` resolves rather than throws on every failure path, so `Promise.all` cannot turn one bad branch into a 500. Warm the installation token with one awaited `getInstallationToken` first — it memoizes per installation, so a cold cache would otherwise stampede N mints where the serial loop paid one; that warm-up call ignores its own failure because each compare still mints and retries on its own. Codex asked for the whole rerun to move to durable/background processing instead; that was REFUSED as an architectural change to webhook handling that the push path would have to follow, and the per-branch multiplication is the only part this feature added. Any accepted rerequest that enqueues nothing COMPLETES the re-requested run with a reason, because GitHub flips the suite back to `queued` on the click and silence is what makes the button look broken. A refusal ECHOES the run's existing conclusion (`preservedCheckRunConclusion`, `cancelled` when it had none) and never writes one of its own: GitHub counts `neutral` and `skipped` as PASSING for a required status check, so completing a run we did not run with a passing conclusion would let anyone with rerun rights clear branch protection on a commit that never built. Only an authoritatively `complete` AND live build writes `success` — that reuse branch returns the existing row NON-null, which used to read as an enqueue and poke a scheduler that could not claim it. Everything else the reuse branch returns is real work, including `queued`: test `build.status === 'complete'`, NOT `!ACTIVE_BUILD_STATUSES.includes(...)`, which excludes `queued` by design and would report an unrun build as deployed. A `check_suite` refusal reports NOTHING, deliberately: the Checks API cannot conclude a suite at all and the payload carries no run ids. Deriving them from build rows was tried and REVERTED — rows are NOT authoritative for `github_actions`, whose check is completed straight from `workflow_run.conclusion` independent of the status CAS, so a `cancelled` row can carry a published `success` and rewriting from the row would turn a passing required check into a blocking one. A bounded suite-scoped listing endpoint does exist, so cost is not the objection; the objection is that it is UNVERIFIED that a suite rerequest leaves our runs needing resolution at all. **Open item: confirm against a real "Re-run all checks" on staging before building on it.** Reporting runs on `executionCtx.waitUntil`, not on the response path — GitHub drops a delivery unanswered for 10s and does NOT redeliver failures automatically, and `completeCheckRun` mints a token and retries with no clock of its own. The call still STARTS synchronously, so it cannot be skipped. `preservedCheckRunConclusion` echoes only WRITABLE conclusions — `stale` is observable but rejected on update, so it maps to `cancelled` rather than 422-ing every refusal. Authorization is the same shape as `push` (HMAC + known installation; GitHub only offers the button to users with repo write access) and `sender` is ignored — this is deliberately NOT strictly weaker than push, since branch protection can restrict who pushes `main` while leaving repo write intact. The freshness gate bounds it to redeploying the current head; the one real capability is rolling forward past an active rollback, accepted because a connection carries one Void user and gating on `sender` would need a mapping from GitHub actors to per-project deploy rights that does not exist. **The App must SUBSCRIBE to `check_run` and `check_suite`** — that switch is separate from the `Checks: Write` permission, and without it GitHub renders the button, delivers nothing, and the click is silently a no-op. The check-run name is now the shared `VOID_BUILD_CHECK_RUN_NAME` constant, because GitHub matches a rerun request by name and a rename in one producer only would quietly break the button for that executor.
