# Builds — CI/Build Service

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-19
**Updated:** 2026-07-02
**Status:** Implemented (backend + admin build UI; user-facing dashboard views deferred)

> **Implementation note (2026-06):** The backend shipped, but the build
> mechanism diverged from this design in several material ways. The sections
> below describe the _original_ design; read
> [Implementation divergences (2026-06)](#implementation-divergences-2026-06)
> at the end before treating anything here as current. The diagrams, the
> `POST /builds/:id/artifacts` endpoint, the FormData artifact flow, and the
> single-executor container model are all stale.

---

## Summary

Move the build step from the user's machine to Void's infrastructure. A `git push` queues a build that runs in a Cloudflare Container, orchestrated by Durable Objects. The user views build logs in real-time via the dashboard.

Two deploy paths:

- **`void deploy`** — build locally, upload artifacts (existing, unchanged)
- **GitHub push** — build remotely on Void infra, deploy automatically

**Goal:** `git push` → build → deploy, with no local toolchain required.

---

## Architecture Overview

```
GitHub push webhook
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  API Worker (void-api)                                        │
│                                                               │
│  POST /webhooks/github       → verify, lookup project, queue  │
│  GET  /projects/:id/builds   → list builds from PostgreSQL   │
│  GET  /builds/:id            → build status from PostgreSQL  │
│  WS   /builds/:id/logs       → proxy WebSocket to DO         │
│  POST /builds/:id/cancel     → RPC to BuildManager DO        │
│  POST /builds/:id/artifacts  → (internal) run deploy pipeline │
└──────────────────────┬───────────────────────────────────────┘
                       │
          BuildScheduler DO (alarm every 2s)
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  BuildManager DO + Container  (one per build)                 │
│                                                               │
│  DO side:                          Container side:            │
│  ┌─────────────────────┐          ┌────────────────────────┐  │
│  │ State machine        │          │ build-agent            │  │
│  │ SQLite: logs, state  │◄── HTTP ─┤                        │  │
│  │ WebSocket: log stream│          │ 1. Download tarball    │  │
│  │ Alarm: build timeout │          │ 2. Detect pkg manager  │  │
│  │                      │          │ 3. Install deps        │  │
│  │ onStop(): update DB, │          │ 4. vite build          │  │
│  │   notify scheduler   │          │ 5. Package artifacts   │  │
│  └─────────────────────┘          │ 6. POST to platform    │  │
│                                    └────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Note: The BuildManager DO's own state (logs, build config) lives in its SQLite storage. The platform's shared database (builds table, project/user lookups) is PostgreSQL via Hyperdrive.

---

## Components

### 1. BuildScheduler DO

A single global instance (addressed as `"global-scheduler"`). Runs a polling loop via Durable Object alarms.

**Responsibilities:**

- Poll PostgreSQL every 2s for builds with `status = 'queued'`
- Enforce per-user concurrency limits based on plan tier
- Start builds by calling `env.BUILD_MANAGER.get(buildId).startBuild(config)`
- Reschedule its own alarm after each tick

**Concurrency limits by tier:**

| Tier | Concurrent Builds | Build Timeout | Container Instance                        |
| ---- | ----------------- | ------------- | ----------------------------------------- |
| Free | 1                 | 10 min        | `standard-1` (0.5 vCPU, 4 GiB, 8 GB disk) |
| Pro  | 3                 | 15 min        | `standard-2` (1 vCPU, 6 GiB, 12 GB disk)  |
| Team | 6                 | 20 min        | `standard-3` (2 vCPU, 8 GiB, 16 GB disk)  |

**Scheduling algorithm (Phase 1):**

```
alarm():
  builds = db.select().from(builds).where(eq(builds.status, 'queued')).orderBy(asc(builds.created_at))
  for each build:
    user = getUser(db, build.userId)
    activeCount = countUserActiveBuilds(db, build.userId)
    limit = getPlanLimits(user.plan).concurrentBuilds
    if activeCount < limit:
      updateBuildStatus(db, build.id, 'starting')
      env.BUILD_MANAGER.get(build.id).startBuild(config)
  if queue not empty: setAlarm(now + 2000)
```

**Why a scheduler instead of starting builds immediately:**

- Fairness: prevents one user from consuming all capacity
- Tier enforcement: checked centrally, not race-prone
- System-level limits: can cap total concurrent builds across all users
- Queue ordering: FIFO by default, priority by tier later

### 2. BuildManager DO (extends Container)

One instance per build. The `Container` class from `@cloudflare/containers` extends `DurableObject`, so the DO and container are a single unit.

**State machine:**

```
             ┌─ cancel ─→ cancelled
             │
queued ──→ starting ──→ building ──→ deploying ──→ complete
             │             │            │
             └─────────────┴────────────┴──→ failed (+ error, exit code)
```

**DO responsibilities:**

- Start the container with build config as env vars
- Set a timeout alarm (10/15/20 min based on tier)
- Accept WebSocket connections for real-time log streaming
- Receive log lines from the container via HTTP POST (batched every 500ms)
- Store logs in DO SQLite for historical retrieval
- Broadcast log lines to all connected WebSocket clients
- On container stop: update PostgreSQL build status via Hyperdrive, clean up

**Container communication:**

- Container → DO: `POST /logs` (batched log lines), `POST /status` (state transitions)
- DO → Container: `POST /cancel` (graceful shutdown signal)

**Lifecycle hooks:**

```typescript
export class BuildManager extends Container {
  defaultPort = 4000;
  enableInternet = true; // npm install needs outbound

  override onStart() {
    // Container is up, health check passed
    this.transition('building');
  }

  override onStop({ exitCode, reason }) {
    if (this.state === 'deploying' && exitCode === 0) {
      this.transition('complete');
    } else if (exitCode !== 0) {
      this.transition('failed', `Exit code ${exitCode}: ${reason}`);
    }
  }

  override onError(error: string) {
    this.transition('failed', error);
  }
}
```

### 3. Build Container

A minimal Docker image that runs the build-agent script.

**Dockerfile:**

```dockerfile
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY build-agent.mjs /build-agent.mjs
EXPOSE 4000
CMD ["node", "/build-agent.mjs"]
```

**build-agent responsibilities:**

1. Start HTTP server on port 4000 (health check for DO, receives cancel signal)
2. Download source tarball from GitHub (URL + token passed as env vars)
3. Extract into working directory
4. Detect package manager from lockfile
5. Install dependencies (`pnpm install`, `npm install`, or `bun install`)
6. Run `npx vite build`
7. Package build output into the same FormData format as `void deploy`
8. POST artifacts to `POST /builds/:id/artifacts` on the platform
9. Stream stdout/stderr to the DO via periodic `POST /logs` (every 500ms)
10. Exit 0 on success, non-zero on failure

**Environment variables passed to container:**

```
BUILD_ID          - unique build identifier
PROJECT_ID        - vite cloud project id
SOURCE_URL        - GitHub tarball URL (with auth token embedded or separate)
SOURCE_TOKEN      - GitHub installation access token (1hr TTL)
BUILD_TOKEN       - short-lived token for POST /builds/:id/artifacts
PLATFORM_URL      - e.g. https://api.platform.example.net
DO_URL            - BuildManager DO URL for log streaming
```

---

## Source Code Delivery

**Phase 1: GitHub tarball API** (simplest, fastest)

|                           | Git Clone (--depth 1) | GitHub Tarball         |
| ------------------------- | --------------------- | ---------------------- |
| Download size (50MB repo) | ~15-20MB              | ~5-10MB                |
| Time                      | 2-3s                  | <1s                    |
| Image bloat               | +50MB (git)           | +0 (curl/tar built-in) |
| Submodules                | Yes                   | No                     |
| Git history               | Yes                   | No                     |

Flow:

1. Platform has GitHub App installation token (from webhook or stored)
2. Generates tarball URL: `https://api.github.com/repos/{owner}/{repo}/tarball/{sha}`
3. Passes URL + token to container as env vars
4. Container: `curl -sL -H "Authorization: token $TOKEN" "$URL" | tar xz --strip-components=1`

Git clone can be added as an option later for repos needing submodules or git history.

---

## Artifact Flow

The container produces the **exact same FormData** that `void deploy` produces today:

| FormData key       | Content                                                       |
| ------------------ | ------------------------------------------------------------- |
| `manifest`         | JSON: bindings, migrations, schedules, SSR, assetHashes, etc. |
| `worker:<path>`    | Worker JS module blobs                                        |
| `asset:<path>`     | Static asset blobs (after delta check)                        |
| `migration:<name>` | SQL migration files                                           |
| `source`           | `"github"`                                                    |

The container POSTs this to `POST /builds/:id/artifacts`, a new internal endpoint authenticated with the build token. This endpoint runs the **existing deploy pipeline** (provision bindings → migrations → asset upload → WfP upload → KV routing → prerendering → cron sync).

This means:

- Zero changes to the deploy logic
- CLI deploys (`void deploy`) continue working unchanged
- The build service is purely additive

---

## Log Streaming

```
Container ──POST /logs (batch)──→ BuildManager DO ──WebSocket──→ Dashboard
                                       │
                                  DO SQLite storage
                                  (historical retrieval)
```

**Container → DO:** Every 500ms, the build-agent collects buffered stdout/stderr lines and POSTs them to the DO's HTTP endpoint. Each batch is an array of `{ line, timestamp }` objects.

**DO → Clients:** The DO broadcasts each batch to all connected WebSocket clients immediately on receipt. Lines are also appended to DO SQLite for clients that connect mid-build or after completion.

**Client reconnection:** On WebSocket connect, the DO sends all stored log lines (from SQLite) followed by a `{ type: "caught_up" }` marker, then live-streams new lines.

---

## Platform API Endpoints

### `POST /webhooks/github`

Receives GitHub push webhooks. Verifies HMAC-SHA256 signature, looks up project by `installation_id` + `repo_full_name`, checks branch filter, inserts build row into PostgreSQL, and pokes the BuildScheduler DO alarm.

### `GET /projects/:id/builds`

List recent builds for a project. Paginated.

### `GET /builds/:id`

Get build status, duration, error message.

### `GET /builds/:id/logs` (WebSocket upgrade)

Stream build logs in real-time. Proxied to the BuildManager DO.

### `POST /builds/:id/cancel`

Cancel a queued or in-progress build. If queued, marks as cancelled in PostgreSQL. If in-progress, sends cancel signal to the BuildManager DO, which sends SIGTERM to the container.

### `POST /builds/:id/artifacts` (internal)

Receives the build FormData from the container. Authenticated with the build-specific token. Runs the deploy pipeline.

---

## Database Schema

The platform uses PostgreSQL (PlanetScale) via Cloudflare Hyperdrive, with Drizzle ORM for type-safe queries. Schema is defined in `platform/packages/api/src/schema.ts`. Types are inferred via `InferSelectModel`, not hand-maintained.

**New tables to add to `platform/packages/api/src/schema.ts`:**

```typescript
// ---------------------------------------------------------------------------
// builds
// ---------------------------------------------------------------------------
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<
        'queued' | 'starting' | 'building' | 'deploying' | 'complete' | 'failed' | 'cancelled'
      >(),
    commit_sha: text('commit_sha').notNull(),
    branch: text('branch').notNull(),
    deployment_id: text('deployment_id').references(() => deployments.id),
    error: text('error'),
    exit_code: text('exit_code'),
    instance_type: text('instance_type'),
    started_at: timestamp('started_at', { mode: 'string' }),
    completed_at: timestamp('completed_at', { mode: 'string' }),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_builds_project').on(t.project_id, t.created_at),
    index('idx_builds_status').on(t.status),
    index('idx_builds_user_status').on(t.user_id, t.status),
  ],
);

// ---------------------------------------------------------------------------
// github_connections
// ---------------------------------------------------------------------------
export const githubConnections = pgTable(
  'github_connections',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .unique()
      .references(() => projects.id),
    installation_id: text('installation_id').notNull(),
    repo_full_name: text('repo_full_name').notNull(),
    branch: text('branch').notNull().default('main'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('idx_github_repo').on(t.installation_id, t.repo_full_name)],
);
```

**Types (in `platform/packages/api/src/types.ts`):**

```typescript
import type { builds, githubConnections } from './schema';
export type Build = InferSelectModel<typeof builds>;
export type GitHubConnection = InferSelectModel<typeof githubConnections>;
```

**Migrations:** Run `pnpm db:generate` after adding to schema. Drizzle generates the migration SQL automatically. Apply with `drizzle-kit migrate`. This is a safe migration (new tables only — no breaking changes to existing schema). The `schema-compat` CI job will validate this.

---

## GitHub App Integration

Builds are triggered exclusively by GitHub pushes. The GitHub repo is the source of truth for remote builds. Local builds remain available via `void deploy`.

### Setup Flow

1. User installs the Void GitHub App on their repo (via dashboard or `void init --github`)
2. Platform stores the installation ID and repo mapping in PostgreSQL
3. User configures which branch triggers deploys (default: `main`)

### Webhook Flow

```
GitHub push event
  │
  ▼
API Worker: POST /webhooks/github
  │
  ├─ Verify webhook signature (HMAC-SHA256)
  ├─ Look up project by repo (installation_id + repo full_name)
  ├─ Check branch filter (only build configured branches)
  ├─ Generate installation access token (GitHub App API, 1hr TTL)
  ├─ Insert build row into PostgreSQL (status: queued)
  └─ Poke BuildScheduler DO alarm
```

---

## Dashboard Integration

### User-Facing Dashboard (`platform/packages/dashboard`)

The user dashboard is a Vue Pages mode app (`platform/packages/dashboard`) with direct Hyperdrive reads. Build-related pages:

- **Build list** — read-only loader queries `builds` table via Hyperdrive
- **Build detail** — status, logs (WebSocket to API), commit info
- **GitHub connection management** — connect/disconnect repo (mutations go through API HTTP)
- **Real-time log viewer** — WebSocket to `GET /builds/:id/logs` on the API

### Admin Dashboard (`platform/packages/api/src/admin/`)

The admin dashboard (Hono JSX, server-rendered) gets a builds section for operational visibility:

- Paginated builds list with status badges, project links, commit SHAs
- Build detail with error cards and log display
- Build count in system stats dashboard

---

## Future Phases

These can be cleanly added without modifying the Phase 1 architecture:

### Build Caching (R2)

- Container saves/restores dependency and build caches to `{projectId}/build-cache/` in R2
- Auto-detect: `node_modules/.cache`, `.vite`, `pnpm-store`
- LRU eviction, 7-day TTL on last read
- Pure container-side change (add cache restore/save steps to build-agent)

### Preview Deploys

- Builds triggered by pull requests deploy to `pr-{n}--{slug}.apps.example.com`
- Requires dispatch worker changes for PR URL routing
- Comment on PR with preview URL

### Git Clone Fallback

- Add `git` to container image, configurable per project
- For repos needing submodules or git history

### Monorepo Support

- Detect changed packages from commit diff
- Only build affected projects

### Custom Build Commands

- Override default `vite build` with user-specified command in project settings
- For non-Vite projects or custom build pipelines

---

## Implementation divergences (2026-06)

The "Deploy on GitHub" feature shipped its backend in June 2026. Several parts
of the original design above were written against assumptions that became stale
during implementation. This section is authoritative where it conflicts with
the design above.

### 1. Build mechanism: run the real `void deploy` CLI, no artifacts endpoint

The container does **not** re-implement packaging and POST FormData artifacts.
Instead, the build agent runs the **real `void deploy` CLI** inside the
container with a short-lived, project-scoped token:

```
npx void deploy --project $slug   # with VOID_TOKEN + VOID_API_URL in env
```

Consequences:

- There is **no** `POST /builds/:id/artifacts` endpoint. (Design "Artifact Flow"
  and the corresponding row in "Platform API Endpoints" are dropped.)
- There is **no** deploy-pipeline extraction. `platform/packages/api/src/routes/deploy.ts`
  is **unchanged**; the deploy endpoint stays JSON-manifest-only with
  direct-to-R2 asset upload.
- The container reuses the exact same deploy path as a local `void deploy`, so
  there is zero divergence between local and remote deploys.

The original premise (container POSTs FormData to a new internal endpoint that
re-runs the pipeline) was stale: the deploy endpoint had already moved to a
JSON-manifest / direct-to-R2 model, so re-implementing packaging in the
container was both unnecessary and wrong.

**Scoped deploy token (replaces the HMAC build-token):**

- `signDeployToken()` (`platform/packages/api/src/auth/deploy-token.ts`) mints a 15-min
  `aud: 'deploy'`, project-scoped JWT. (15 min is the default; the container
  build path sizes the TTL to the owner plan's `buildTimeoutMinutes`, hard-capped
  at 60 min + a 300s margin via `deployTokenTtlSecondsForBuildMinutes`. The token
  also carries an optional `build` claim and is revoked the moment that build row
  leaves `ACTIVE_BUILD_STATUSES`.)
- `signJwt()` gained an optional `{ ttlSeconds }`.
- `middleware/auth.ts` accepts `aud` of `'api'` **or** `'deploy'` (sets a
  `deployScope` on the context); `routes/deploy.ts` has a one-line project-scope
  guard. The pipeline is otherwise untouched.

### 2. Two build executors (container is default; GitHub Actions via OIDC added)

The design was container-only. The shipped feature has **two** executors,
selected by `github_connections.build_executor` (`'container' | 'github_actions'`,
default `'container'`):

- **CF Container** (default) — `BuildScheduler` + `BuildManager` DOs as designed.
- **GitHub Actions via OIDC** — `void init --github` scaffolds
  `.github/workflows/void-deploy.yml`. The workflow runs `void deploy` on GitHub's
  runners and authenticates with **no stored secret**: it presents a GitHub
  Actions OIDC token to `POST /auth/github-oidc`, which verifies it against
  GitHub's JWKS and mints a scoped `VOID_TOKEN`. `workflow_run` webhooks complete
  the Actions-side build row.

### 3. Admin build UI shipped; user-facing dashboard deferred

The admin Hono-JSX build views shipped: a per-project Builds section on
`/admin/projects/:id` (`admin/routes/projects.tsx` + `admin/views/build-table.tsx`)
and a build detail page `GET /admin/builds/:id` (`admin/routes/builds.tsx`) with a
client-side polling live-log panel (`admin/views/build-logs.tsx`, `setInterval` ->
`/admin/builds/:id/logs?since=N`) — NOT the DO WebSocket. The user-facing Vue
dashboard build views remain deferred.

### 4. Durable Objects: flat files, migration tags v5 + v6

- DO classes live **flat** in `platform/packages/api/src/` (`build-scheduler.ts`,
  `build-manager.ts`), not in a `durable-objects/` directory.
- The wrangler DO migration tag is **v5** (`new_sqlite_classes`:
  `[BuildScheduler, BuildManager]`), applied to top-level + `env.production` +
  `env.staging`.
- `BuildManager` extends `Container` from `@cloudflare/containers@0.3.3`; the
  `containers` block binds it to `./container/Dockerfile` in all three scopes.
- A later migration tag v6 (`new_sqlite_classes: [BuildManagerLarge]`) added a
  second container DO class `export class BuildManagerLarge extends BuildManager {}`,
  bound as `BUILD_MANAGER_LARGE`. It exists solely to bind a larger static
  `instance_type` (`@cloudflare/containers@0.3.x` has no per-start sizing). Free
  builds use `BuildManager` (standard-3); paid builds use `BuildManagerLarge`
  (standard-4), selected per-build by `buildManagerNamespace(instance_type)`.

### 5. Extra schema beyond the original two tables

In addition to `builds` and `github_connections`:

- `github_connections` gained a `build_executor` column
  (`'container' | 'github_actions'`, default `'container'`).
- A new `github_installations` table maps GitHub installation IDs to users and
  tracks accessible repos. The OAuth callback backfills installation → user.
- Migrations: `platform/packages/api/drizzle/0027_github_deploy.sql` (creates `builds`,
  `github_connections`, `github_installations`; idempotent `IF NOT EXISTS`) and
  `0028_check_runs.sql` (`ALTER TABLE builds ADD COLUMN check_run_id`).
  Re-stamped past 0026 during the #179 routing split.

### New / changed surfaces (not in the original design)

- `platform/packages/api/src/github/`: `app-jwt.ts` (RS256 App JWT), `installation-token.ts`
  (cached 1h installation token + tarball URL), `webhook-verify.ts`
  (HMAC-SHA256), `oidc-verify.ts` (GitHub Actions JWKS verify). Dependency: `jose`.
- Routes mounted in `index.ts`: `routes/github.ts` (install-url, installations,
  callback, per-project connect/get/patch/delete), `routes/webhooks.ts`
  (`push` → queue container build + poke scheduler; `installation` /
  `installation_repositories`; `workflow_run`), `routes/auth-oidc.ts`
  (`POST /auth/github-oidc`).
- Container: `platform/packages/api/container/` — `Dockerfile` (node:24-slim + corepack +
  bun) and `build-agent.mjs`.
- Tiers: `PlanLimits.concurrentBuilds` + `.buildTimeoutMinutes` (0 = unlimited);
  `getBuildInstanceType(plan)` -> two sizes only: free -> standard-3
  (`BUILD_INSTANCE_FREE`), and solo|pro|sponsored|custom -> standard-4
  (`BUILD_INSTANCE_LARGE`). Concurrency/timeout per plan: free 1/10, solo 2/15,
  pro 3/15, sponsored 6/20, custom 0/0.

### New secrets

`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM), `GITHUB_WEBHOOK_SECRET`,
`GITHUB_APP_SLUG` — per-env, declared **optional** in `env.ts` (webhook + OIDC
endpoints return 503 when unset). Distinct from the existing
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (user sign-in OAuth app). Staging
Cloudflare Access must add `/webhooks/github` and `/auth/github-oidc` to the
bypass list (GitHub cannot present Access creds).

### Known follow-ups (not done this round)

- **Container → DO live-log transport — DONE.** Wired via a DO pull-loop:
  `pollLogs()` (`build-manager.ts`) PULLS the agent's `GET /logs?since=N`
  (~1s cadence, self-terminating on terminal status) into the SQLite `logs`
  table + WS fan-out, and is the single producer. It uses a non-starting
  `getTcpPort(defaultPort).fetch()` — NOT `containerFetch` — to avoid
  resurrecting an exited container. The `ContainerProxy`/`outboundByHost`
  alternative was not used.
- User-facing dashboard build views (admin build views shipped — see #3).
- **Preview deployments per PR.**

---

## Configurable Deploy-Workflow Path (2026-07-02)

This follow-up extends the OIDC executor described in
[§2](#2-two-build-executors-container-is-default-github-actions-via-oidc-added)
with a configurable `void-deploy.yml` path.

### Motivation

The OIDC exchange (`platform/packages/api/src/routes/auth-oidc.ts`) hardcodes the
authorized workflow as `SCAFFOLD_WORKFLOW_PATH = '.github/workflows/void-deploy.yml'`
(`:26`, enforced `:131`). Baking a filename into the backend is inflexible;
owners should own their workflow layout. Make the authorized path a
**per-connection, owner-set** value, **defaulting to the current constant** so
nothing changes for existing users.

### Security invariant (must be preserved)

The pin's value = _only the workflow the project **owner** designated may mint a
deploy token_. Preserve it by keeping the authorized path **server-side on the
`github_connections` row**, set only through owner-authenticated surfaces
(`POST`/`PATCH /projects/:id/github` — both `authMiddleware` + `project.user_id`
403-gated). It is **never** read from the repo and **never** written by the
webhook (`repo` rename → touches only `repo_full_name`) or the OIDC path (never
writes the connection). Those are the only untrusted inputs, so the boundary
holds by construction.

Accepted second-order tradeoff (owner's informed choice): pointing the path at a
fat multi-purpose workflow (`ci.yml`) enlarges the deploy-oracle surface — any
compromised step there with `id-token: write` could mint. The backend cannot
detect this; it sees only the OIDC claim (path/event/ref/sha), never the file's
contents.

### Semantics

**Single path per connection, REPLACE (not a list).** Setting
`workflow_path = .github/workflows/ci.yml` means `void-deploy.yml` is no longer
authorized (→ 401). Default `.github/workflows/void-deploy.yml`.

**A pin change is atomic, like a branch/executor change** (added after the
adversarial review). `workflow_path` is a trust-boundary field, so re-pinning
must not leave the old workflow able to deploy through an already-minted token or
a check→lock race. The `PATCH` therefore terminalizes in-flight `github_actions`
builds when the pin changes (revoking their deploy tokens; container builds don't
use the workflow gate), and `createGithubActionsBuildWithinLimit` re-reads
`workflow_path` under the same `FOR UPDATE` connection lock it already uses for
`branch`, rejecting with a `workflow-mismatch` (409) when the token's workflow no
longer matches the current pin. This mirrors the existing branch/executor
handling exactly. The CLI also fails closed if a `--workflow` request is not
echoed back by the server (an older API that silently drops the field).

### Design summary

- **Data.** `githubConnections` (`schema.ts:390`) gains
  `workflow_path: text('workflow_path').notNull().default('.github/workflows/void-deploy.yml')`
  after `build_executor`. `GitHubConnection` is inferred (`types.ts:34`) → picks
  it up. The OIDC read `getGitHubActionsConnectionsByRepo` (`db.ts`) spreads
  `getTableColumns(githubConnections)` → column auto-selected, **no query edit**.
- **Enforcement.** Move the path gate from **before** the connection lookup
  (`auth-oidc.ts:131`, global const) to **after** connection selection (beside
  the existing post-lookup `build_executor` check, `auth-oidc.ts:~169`);
  compare `workflowPathForRepo(workflowRef, claims.repository)` against
  `connection.workflow_path`. Keep `workflowPathForRepo` and its `null`
  anti-spoof behavior verbatim. `SCAFFOLD_WORKFLOW_PATH` survives as the shared
  default constant.
- **Setter.** `POST /projects/:id/github` (create, `routes/github.ts:~633`) and
  `PATCH` (update, `:~747`) accept optional `workflow_path`; `db.ts` helpers
  `createGitHubConnection` / `updateGitHubConnection` persist it.
- **Validation** (API, authoritative, 400 on fail): non-empty; `startsWith`
  `.github/workflows/`; ends `.yml`|`.yaml`; no `..`; no leading `/`. (GitHub
  only runs workflows under `.github/workflows/`, so anything else can never
  match a real `workflow_ref` — fail loudly now, not silently-never-authorized
  later.)
- **CLI** (framework, `packages/void`): `void github connect --workflow <path>`
  and `void github update --workflow <path>` → `client.ts` connect/update send
  `workflow_path`; `github-cmd.ts` parses the flag.

### Out of scope

Scaffolder path-awareness (`init.ts` keeps writing `void-deploy.yml`; advanced
users hand-manage a custom file); dashboard UI (marketing site only); multiple
/ glob paths.

### Tasks

**Task 1 — Schema + migration (platform, `platform/packages/api`).**
Add the `workflow_path` column to `githubConnections` in `schema.ts`. Generate
`drizzle/0029_github_workflow_path.sql` via `pnpm -C platform/packages/api db:generate`
(emits `.sql` + `_journal.json` + `0029_snapshot.json` together — do not
hand-edit meta). SQL is
`ALTER TABLE "github_connections" ADD COLUMN "workflow_path" text DEFAULT '.github/workflows/void-deploy.yml' NOT NULL;`.
_Verify:_ `vp run check` clean; `0029_*` present, journal `idx: 29`;
`GitHubConnection` includes `workflow_path`. _Depends:_ none.

**Task 2 — db.ts helpers persist the column (platform).**
`createGitHubConnection` inserts `workflow_path` (default constant when
omitted); `updateGitHubConnection` updates it when provided. _Verify:_
typecheck; signatures. _Depends:_ Task 1.

**Task 3 — API setter + validation (platform, `routes/github.ts`).**
POST + PATCH read optional `workflow_path`, run a `validateWorkflowPath()` util
(rules above), 400 on invalid, pass to the Task-2 helpers. _Verify:_ typecheck.
_Depends:_ Task 2.

**Task 4 — OIDC enforcement per-connection (platform, `routes/auth-oidc.ts`).**
Remove the global gate at `:131`; re-add after connection selection, comparing
`workflowPathForRepo(...)` to `connection.workflow_path`. Keep
`SCAFFOLD_WORKFLOW_PATH` as the default constant. _Verify:_ control-flow reasoning;
covered by Task 5. _Depends:_ Task 1.

**Task 5 — Tests (platform, `platform/packages/api/test/integration`).**
`api-oidc.test.ts`: (a) default back-compat — existing scaffolded / `other.yml`
/ spoofed-prefix cases still pass; (b) `workflow_path='.github/workflows/ci.yml'`
→ `ci.yml` mints 200, `void-deploy.yml` → 401; (c) two projects, same repo,
different paths → each mints only its own, cross → 401. Connection-CRUD test:
POST/PATCH invalid path → 400, `.yaml` ok, value persisted + read back.
_Verify:_ `vp test run` on these files green. _Depends:_ Tasks 2–4.

**Task 6 — CLI flags (`packages/void`).** `client.ts` connect + update helpers add optional `workflowPath` →
body `workflow_path`; `github-cmd.ts` connect + update parse `--workflow <path>`
(client-side validate for a friendly error; API stays authoritative). Contract:
body field is `workflow_path` (fixed by Task 3). _Verify:_ framework typecheck +
`github-cmd` tests. _Depends:_ Task 3 (field-name contract) — buildable in
parallel once fixed.

### Schema compatibility

The added column is backward-compatible with the previous API. Apply the
migration before deploying the API that reads it. Framework and platform changes
now share the same workspace and contract tests.
