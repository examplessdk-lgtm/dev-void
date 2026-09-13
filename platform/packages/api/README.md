# @voidcloud/api

Control-plane API and internal admin UI for Void.

It owns platform auth, projects, deployments, domains, secrets, provisioning, rollback, usage/account enforcement, and Deploy-on-GitHub (GitHub App connect, push-triggered builds, GitHub Actions OIDC). The worker uses Hono plus Drizzle over PostgreSQL via Hyperdrive.

## Architecture

- **Platform DB**: PostgreSQL via `HYPERDRIVE.connectionString`
- **Public API**: CLI and dashboard-facing JSON routes
- **Internal API**: resource resolution and revalidation used by other platform workers
- **Admin UI**: server-rendered HTML under `/admin/*`
- **Background work**:
  - `scheduled()` for periodic usage enforcement and rollover checks
  - `queue()` for usage-event ingestion
- **Deploy on GitHub**: GitHub App install/connect, webhook-driven builds, and GitHub Actions OIDC. Builds run in a Cloudflare Container (default; one of two plan-sized DO classes, `BuildManager` or `BuildManagerLarge`) or via GitHub Actions, queued and concurrency-gated by the `BuildScheduler` Durable Object

## Source Layout

```text
src/
  index.ts                    # Hono app, Drizzle setup, scheduled(), queue()
  env.ts                      # Worker env types
  schema.ts                   # Drizzle schema
  db.ts                       # Query layer
  types.ts                    # Shared types including DeployManifest
  assets.ts                   # Static asset upload/session helpers
  routing.ts                  # Routing KV updates
  cf-api.ts                   # Cloudflare API helpers
  cron-scheduler.ts           # Durable Object for project crons
  usage-counter.ts            # Durable Object for per-user usage counters
  usage-queue.ts              # Queue consumer logic
  tiers.ts                    # Plan limits + helpers (incl. concurrentBuilds, buildTimeoutMinutes; getBuildInstanceType selects the build-container size/class by plan)
  build-scheduler.ts          # Durable Object: global build queue + per-tier concurrency
  build-manager.ts            # Durable Objects (extend @cloudflare/containers Container): BuildManager (free standard-3 = 2/8/16) + BuildManagerLarge (paid standard-4)
  build-namespace.ts          # buildManagerNamespace: maps builds.instance_type -> the BuildManager/BuildManagerLarge DO class
  build-types.ts              # BuildConfig, BuildLogLine
  github/                     # GitHub App crypto: app-jwt, installation-token, webhook-verify, oidc-verify
  provisioning/               # Worker/resource provisioning + cleanup
  migrations/                 # Validation + legacy remote D1 runner
  auth/
    deploy-token.ts           # Mint short-lived project-scoped deploy JWT (aud: "deploy")
  routes/
    auth.ts                   # OAuth login/callback (also backfills GitHub installation -> user)
    me.ts                     # Current user
    projects.ts               # Project CRUD, migrations, logs, PG DB ops
    deploy.ts                 # Deploy pipeline (accepts api- or deploy-scoped tokens)
    delete.ts                 # Project deletion
    github.ts                 # GitHub App install/connect + per-project connection routes
    webhooks.ts               # POST /webhooks/github (HMAC-verified push/installation/workflow_run)
    auth-oidc.ts              # POST /auth/github-oidc (verify Actions OIDC, mint scoped token)
    revalidate.ts             # Dashboard/admin ISR revalidation
    internal-revalidate.ts    # Proxy -> API ISR revalidation
    internal-resolve-resource.ts
    internal-resolve-worker.ts
    secrets.ts
    domains.ts
    usage.ts
  admin/
    routes/                   # Admin pages: users/projects/deployments/platform/signup-control, plus builds.tsx (build detail page + /logs poll endpoint) and email.tsx (per-project email control plane)
    views/                    # Hono JSX view layer (incl. build-table.tsx, build-logs.tsx)
    middleware/auth.ts        # Admin cookie auth + same-origin guard on every write
container/
  Dockerfile                  # node:26-slim + pinned corepack + bun build image
  build-agent.mjs             # Downloads source tarball, installs deps, runs `npx void deploy`
drizzle/
  0000_*.sql
  ...
  0027_github_deploy.sql      # builds, github_connections, github_installations tables
  0028_check_runs.sql         # builds.check_run_id
```

## Main Route Groups

### Public API

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `GET /me`
- `/projects/*`
  - CRUD
  - deploys and rollbacks
  - migrations and logs
  - secrets
  - domains
  - usage
  - PostgreSQL and MySQL project database provisioning/update
  - `POST /projects/:id/prerender-token` — mint a five-minute, project-scoped token accepted only by the remote-binding proxy
  - `/projects/:id/github` — connect/inspect/update/disconnect the GitHub repo (POST/GET/PATCH/DELETE; auth + ownership)
  - `/projects/:id/email/*` — monthly usage, and the verified-recipient list the project may send to (`GET|POST|DELETE`). Adding a recipient triggers a verification email; the address only becomes sendable once the recipient consents. See [Email](#email).
- `GET /usage`

### Deploy on GitHub

- `GET /github/install-url` (auth) — start GitHub App installation
- `GET /github/installations` (auth) — installations accessible to the user
- `GET /github/callback` (public, HMAC-signed state) — App install callback
- `POST /webhooks/github` (public, HMAC-verified) — `push` queues a container build and pokes the scheduler; `installation`/`installation_repositories` sync access; `workflow_run` completes GitHub Actions builds
- `POST /auth/github-oidc` (public) — verify a GitHub Actions OIDC token, create the Actions build row, and mint a scoped `VOID_TOKEN` (`{ oidcToken, project }` -> `{ token, projectId, buildId }`)

The webhook and OIDC endpoints return `503` when the GitHub App secrets are unset, so the worker runs without them. On staging, both paths must be on the Cloudflare Access **bypass** list (GitHub cannot present Access credentials).

### Internal API

- `POST /internal/revalidate/:projectId`
- `POST /internal/resolve-resource/:projectId`
- `POST /internal/resolve-worker/:projectId`

### Admin UI

- `/admin/users`
- `/admin/projects`
- `/admin/builds/:id` — build detail page (live log panel for container builds; GitHub link for `github_actions`)
- `/admin/builds/:id/logs?since=N` — build-log poll endpoint backing the live tail; container builds front the `BuildManager`/`BuildManagerLarge` DO's read-only `GET /logs?since=N` (routed by `instance_type` via `buildManagerNamespace`), `github_actions` builds return the external `logs_url`
- `/admin/deployments`
- `/admin/email/:projectId` — per-project email usage, caps, outbound kill switch, and destination list
- `/admin/signup-control`
- `/admin/platform`

## Auth Flow

`GET /auth/login?redirect=...&provider=github|google` starts OAuth. After callback:

1. the API validates the signed state
2. exchanges the code with GitHub or Google
3. looks up an existing OAuth account
4. if needed, links the provider to an existing user with the same email
5. otherwise creates a new user
6. for GitHub logins, optionally grants preview access to a configured GitHub repository
7. signs a JWT and redirects back:
   - dashboard redirects receive a short-lived `?code=...` for `POST /auth/exchange`
   - new CLI redirects with `code_challenge_method=S256` receive a short-lived `?code=...` for `POST /auth/cli/token`
   - legacy localhost CLI redirects still receive `?token=...`

The CLI entrypoint is `void auth login`, not `void login`.

Dashboard auth uses the same JWT model, stored in the `void_token` cookie.

## Deploy Flow

`POST /projects/:id/deploy` handles both worker and static deploys. Before either branch runs, the deploy endpoint validates the manifest wire-shape — including `redirectRules` / `fallbackRules` structure and destination constraints (path-absolute, no embedded query on `status: 200` entries) — so malformed routing rules are rejected before any resources are provisioned. See `packages/api/src/routes/deploy.ts` around lines 468-532.

### Worker deploys

1. validate ownership and deploy limits
2. provision bindings and queues from the manifest
3. upload worker modules and assets to CF via `assets-upload-session`
4. also mirror assets to platform `STATIC_ASSETS`/`STATIC_ASSETS_R2` and write a serving manifest to `ROUTING` (safety net for CF asset dedupe poisoning — see `meta/design-docs/0066`)
5. upload a versioned worker: `user-{slug}-{deploymentId}`
6. call `POST /__void/migrate` on that new worker
7. update routing KV (with `assetManifestId`) and active domains only after migrations succeed
8. mark the deployment live and run retention cleanup (evicts mirrored assets + serving manifests for deployments dropped from the retention window)

### Static/SPA deploys

1. content-address assets by hash
2. issue presigned uploads that store every new asset directly in `STATIC_ASSETS_R2` (`STATIC_ASSETS` KV is retained for carry-forward assets from legacy multipart deploys)
3. write a manifest to `ROUTING`
4. point routing at `staticDeploymentId` instead of a worker

## Deploy on GitHub

Connect a repo through a GitHub App; a `git push` then builds and deploys automatically.

- **Connect**: the user installs the App (`/github/install-url` -> `/github/callback`) and links a repo to a project via `/projects/:id/github`. Installation-to-user mapping lives in `github_installations`; the OAuth callback backfills it on sign-in.
- **Trigger**: `POST /webhooks/github` verifies the HMAC signature, then on `push` writes a `builds` row and pokes the `BuildScheduler`.
- **Executors** (per `github_connections.build_executor`, default `container`):
  - **CF Container** — `BuildScheduler` (global, alarm-driven queue with per-tier concurrency from `tiers.ts`) atomically claims a build and starts a container on one of two classes by the owner's plan: `BuildManager` (free, `standard-3` = 2 vCPU / 8 GiB / 16 GB) or `BuildManagerLarge` (paid, `standard-4` = 4 vCPU / 12 GiB / 20 GB, Cloudflare's max per-container size). The class is routed by the persisted `builds.instance_type` (`standard-3` / `standard-4`, derived from the plan by `getBuildInstanceType`) via `buildManagerNamespace` in `build-namespace.ts`; cancel and reaper paths use the same picker, so they address the same class the build started on. `BuildManagerLarge` extends `BuildManager`, which extends `@cloudflare/containers` `Container`, enforces a timeout alarm, and persists status to Postgres via Hyperdrive.
  - **GitHub Actions** — `void init --github` scaffolds a workflow that calls `POST /auth/github-oidc`; the verified job runs `void deploy` and reports back via the `workflow_run` webhook.
- **Build mechanism**: both executors run the real `void deploy` CLI with a short-lived, project-scoped deploy token (`aud: "deploy"`, minted by `auth/deploy-token.ts`). There is no artifact-upload endpoint; `routes/deploy.ts` is unchanged. The container agent (`container/build-agent.mjs`) downloads the source tarball, installs deps, and runs `npx void deploy --project <slug>` with `VOID_TOKEN` + `VOID_API_URL`.
- **Check Run**: container builds publish a "Void Build" GitHub Check Run (head SHA = the build's `commit_sha`/webhook `after`), created `in_progress` at build start and finalized `success`/`failure`/`cancelled` at every terminal site. Best-effort — a Check Run API error never fails or perturbs a build/deploy. `details_url` is the project's dashboard URL `https://{projectSlug}.void.app` for the in-progress/success/failure states (omitted on cancel). The helper (`github/check-run.ts`) is executor-agnostic; Actions check-runs are deferred (the native workflow check already covers them) and the helper is ready for a future PR. `Checks: Write` is already granted, so no permission change was needed. `builds.check_run_id` has no index (nothing queries by it — deferred).
- **Build logs**: `BuildManager` pulls container stdout/stderr into the DO with a `pollLogs()` loop — a non-starting `getTcpPort().fetch()` against the agent's paged `GET /logs?since=N` (deliberately NOT `containerFetch`, which would auto-resurrect an exited container) on a ~1s cadence, advancing its cursor only after SQLite ingestion and feeding the SQLite `logs` table + WebSocket fan-out. On natural exit, the agent keeps its control server alive with an 8s idle deadline that resets only when the acknowledged cursor advances and a 120s non-resettable absolute cap. After a moving final page, the same pull callback sends one empty follow-up request so `since=<last ingested seq>` acknowledges durable ingestion without waiting another tick. Forced teardown instead single-flights the whole join, fresh bounded pull, liveness recheck, and signal sequence so concurrent callers cannot ingest after the termination marker. The DO also serves a read-only `GET /logs?since=N` -> `{ lines, lastSeq }`. The admin build views (below) consume this; `github_actions` builds have no DO log store and link out to their GitHub Actions run.

## Email

Projects send and receive mail through `void/email`. The API owns consent and quota policy; the proxy worker (`packages/proxy/src/email.ts`) owns the send/receive path and every counter.

### Sender identity is per-environment

The platform mail domain is a configured var, `EMAIL_SENDER_DOMAIN` — never a literal in code. Production and staging run different domains (`mail.void.cloud` / `mail.staging.void.cloud`), and the proxy builds its sender regex from the same var, so a hard-coded domain would make a staging send unroutable.

A project's sender address is `<slug>+noreply@<EMAIL_SENDER_DOMAIN>`. Deployed user workers receive the two halves as plain-text bindings:

- `__VOID_EMAIL_DOMAIN` — the value of `EMAIL_SENDER_DOMAIN`
- `__VOID_PROJECT_SLUG` — the project slug, injected for **every** project (it predates this feature but used to be sandbox-only)

The runtime defaults `from` from those two bindings and refuses to send when either is missing, rather than falling back to a baked-in domain.

### Who a project may send to

`email_destinations` in Postgres is the source of truth: one row per (project, recipient), `pending` until the recipient consents. `email-allowlist:<projectId>` in `ROUTING` KV is a denormalized read-cache of the **verified** rows, which is what the proxy enforces on every send. Every destination mutation re-syncs that key — the owner-facing add/revoke routes, the admin revoke, the project-create auto-add of the owner's own address, and the recipient's click on a platform confirmation link; an empty list deletes it. **Nothing syncs it on deploy.**

Those writes are best-effort, so one swallowed KV failure after Postgres already committed `verified` would otherwise be unrecoverable — the proxy reads a missing key as deny-all, and the owner sees a `verified` destination whose every send is rejected as unverified. `GET /projects/:id/email/destinations` is the repair: it compares the mirror against the verified rows and rewrites it only when they differ (one KV read per listing; never a write on every listing). Same read-compare-write self-heal shape as the hourly `email-slug:` backfill in `index.ts`.

Cloudflare Email Routing destination addresses are account-level, so a row is only deleted upstream when no other project still references the same address.

### Quotas and counters

All of it lives in `ROUTING` KV, written by the proxy and read (and overridden) by the admin page:

| Key                                | Meaning                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `email-sent:<projectId>:<YYYY-MM>` | Outbound count for the UTC month; expires shortly after the month ends  |
| `email-recv:<projectId>:<YYYY-MM>` | Inbound count for the UTC month                                         |
| `email-suspended:<projectId>`      | Presence stops mail both ways: outbound sends fail, inbound is rejected |
| `email-limit:<projectId>`          | Monthly outbound override; absent means the platform default (200)      |
| `email-burst-limit:<projectId>`    | Per-minute override; absent means the platform default (10)             |

The defaults live in the proxy and are mirrored in `admin/routes/email.tsx` so the page can label a cap `default` or `override`. Nothing at build time catches a drift between the two — change them together.

### Operator page

`/admin/email/:projectId` is the whole control plane in one page: this month's outbound/inbound counts against the effective caps, the resolved sender address, the suspend/unsuspend kill switch, monthly and burst overrides (submit a blank value to drop an override back to the default), a counter reset, and the destination list with per-row revoke.

The counter reset is guarded server-side — the operator types the project slug — so it cannot be triggered by a POST that never rendered the page. There is deliberately no operator-side "add destination": consent belongs to the recipient, and the owner-facing `POST /projects/:id/email/destinations` is the only path that asks for it.

Every admin write is additionally same-origin checked in `admin/middleware/auth.ts` before authentication runs; a `POST` whose `Origin` (or, failing that, `Referer`) does not match the request host is rejected with `403`, as is one that carries neither.

## Usage and Plan Enforcement

- **Deploy/day limits** are checked from the platform Postgres database.
- **Request usage** is counted asynchronously through `USAGE_QUEUE` and the `UsageCounter` DO.
- **Scheduled enforcement** runs hourly from the worker cron and reconciles request/AI usage against plan limits.
- **Per-request runtime limits** are carried in routing data and enforced by `dispatch`.

## Admin UI

The admin surface is built into this worker under `/admin/*`.

Notable sections:

- user search, plan changes, suspension controls
- project and deployment inspection
- deployment log viewing
- per-project Builds section (ongoing build highlighted) plus a build detail page with a client-side polling live-log tail for container builds (mirrors the deployment live-tail; not a WebSocket), or a GitHub Actions link for `github_actions` builds. The tail polls `GET /admin/builds/:id/logs?since=N`, which fronts the `BuildManager`/`BuildManagerLarge` DO's read-only `GET /logs?since=N` (DO chosen by `instance_type` via `buildManagerNamespace`).
- per-project email page (linked from the project detail view): usage, caps, outbound kill switch, destinations
- signup allowlist/private-beta controls
- platform worker version history and orchestrated rollback

Admin writes are same-origin guarded: `admin/middleware/auth.ts` rejects any non-`GET` request whose `Origin`/`Referer` host does not match the request host, before the cookie is even read.

## Local Setup and Secrets

Useful scripts:

```bash
pnpm -C packages/api dev
pnpm -C packages/api setup
pnpm -C packages/api db:generate
pnpm -C packages/api migrate
```

`pnpm -C packages/api setup` also ensures `packages/api/.dev.vars` and
`packages/dashboard/.dev.vars` include the local development overrides:
`DEV_AUTH_BYPASS=true`, `PLATFORM_ENV=staging`, `JWT_SECRET=dev`, and the local
Hyperdrive connection string. It also prompts for the local admin email and
upserts the seeded `user_admin` record to match it. For non-interactive use,
pass `pnpm -C packages/api setup -- --admin-email you@example.com`.

To run the API locally, use:

```bash
pnpm -C packages/api exec wrangler dev --local --host localhost --port 8787
```

Secrets used at runtime:

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `CF_ZONE_ID`
- `JWT_SECRET`
- `PROJECT_SECRET_KEYS_JSON`
- `PROJECT_SECRET_ACTIVE_KEY_VERSION`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

`PROJECT_SECRET_KEYS_JSON` is a JSON object mapping key-version strings to base64-encoded 32-byte AES keys. `PROJECT_SECRET_ACTIVE_KEY_VERSION` selects which version is used for new project-secret writes.

`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are the OAuth app used for **user sign-in**. They are distinct from the Deploy-on-GitHub App secrets below.

Optional vars:

- `AUTH_REDIRECT_URI`
- `DASHBOARD_URL`
- `GITHUB_PREVIEW_REPO_PAT`
- `VOID_PROXY_SERVICE`
- `SITE_DOMAIN`
- `EMAIL_SENDER_DOMAIN` — platform mail domain for this environment (`mail.void.cloud` in production). Set on the proxy worker too, and handed to deployed user workers as `__VOID_EMAIL_DOMAIN`. See [Email](#email).
- `GITHUB_APP_ID` — Deploy-on-GitHub App identifier
- `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM (convert GitHub's PKCS#1 with `openssl pkcs8 -topk8 -nocrypt`)
- `GITHUB_APP_SLUG` — App slug, used to build the install URL
- `GITHUB_WEBHOOK_SECRET` — HMAC secret for `POST /webhooks/github`

The four `GITHUB_APP_*` secrets are optional: when unset, `/webhooks/github` and `/auth/github-oidc` return `503` and the rest of the worker runs normally. They are the App for Deploy-on-GitHub, separate from the sign-in OAuth app above.

Set `GITHUB_PREVIEW_REPO_PAT` to automatically invite GitHub-authenticated users to `void-sdk/void` with read-only access. The PAT should be a fine-grained token with `Administration` repository permission `write` for that repository.

## Tests

Unit coverage includes provisioning, JWT/auth helpers, deploy manifest validation, usage counters, cron scheduling, legacy D1 migration helpers, and Deploy-on-GitHub crypto (App JWT, installation token, webhook HMAC verification, OIDC verification) plus the scoped deploy-token minting.

Integration coverage includes:

- auth and `/me`
- project CRUD
- deploy/rollback/revalidation
- custom domains and secrets
- admin dashboard
- scheduled usage enforcement
- GitHub App connect/webhook/OIDC routes and the `BuildScheduler` queue/concurrency behavior
