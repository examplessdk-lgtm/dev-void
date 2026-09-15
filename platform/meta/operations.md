# Operations

How we deploy, what we provision, and how the system is configured.

## Access Levels

| System                         | Who                      | What                                                                                                     |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Cloudflare account super admin | Evan (evan@voidzero.dev) | Full account access — Workers, KV, R2, DNS, Analytics Engine, Hyperdrive, **token generation / refresh** |
| PlanetScale                    | Evan (evan@voidzero.dev) | PostgreSQL database — platform DB (branches, connection strings, dashboard)                              |
| 1Password tokens vault         | Evan (evan@voidzero.dev) | API tokens, OAuth secrets, JWT secrets for all environments                                              |
| API admin panel                | Evan (evan@voidzero.dev) | `api.void.cloud/admin` — project management, user management, deploys                                    |

## What We Deploy

Five Cloudflare Workers:

| Worker           | Package              | Purpose                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `void-proxy`     | `packages/proxy`     | Unified proxy — AI inference metering + D1/KV/R2 remote bindings for local dev                                                                                                                                                                                                                                                                    |
| `void-api`       | `packages/api`       | Control Plane API + Admin Dashboard — OAuth, project CRUD, deploy pipeline, usage metering; also hosts the `BuildScheduler` Durable Object and two Deploy-on-GitHub build-container DO classes sized by plan: `BuildManager` (free, `standard-3` = 2 vCPU / 8 GiB / 16 GB) and `BuildManagerLarge` (paid, `standard-4` = 4 vCPU / 12 GiB / 20 GB) |
| `void-dashboard` | `packages/dashboard` | User-facing dashboard — project management, deployments, usage                                                                                                                                                                                                                                                                                    |
| `void-tail`      | `packages/tail`      | Tail worker — captures user worker logs to Analytics Engine + live tailing via Durable Object WebSockets                                                                                                                                                                                                                                          |
| `void-dispatch`  | `packages/dispatch`  | Edge router — routes `*.void.app` + custom domain traffic to user workers (via Workers for Platforms), static assets, and ISR cache                                                                                                                                                                                                               |

## Environments

Two fully isolated environments. Each has its own CF resources (KV, R2, dispatch namespace, analytics engine) and a separate Hyperdrive configuration pointing to its own PlanetScale PostgreSQL database.

| Environment    | API URL                  | Dashboard                 | User Sites           | Trigger                                                                          |
| -------------- | ------------------------ | ------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| **Production** | `api.void.cloud`         | `dash.void.cloud`         | `*.void.app`         | Automatic: "Deploy Platform Production" on push to `prod` (also manual dispatch) |
| **Staging**    | `api.staging.void.cloud` | `dash.staging.void.cloud` | `*.staging.void.app` | Automatic: "Deploy Platform Staging" on push to `main` (also manual dispatch)    |

## Cloudflare Resources

### Production

**API worker** (`void-api`):

| Resource           | Binding         | Name / ID                                                                                                                    |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hyperdrive         | `HYPERDRIVE`    | `7bd6b2a606a347819ad3421867840736` (→ PlanetScale PostgreSQL)                                                                |
| KV Namespace       | `ROUTING`       | `9250c33f3db6494ebe8ad6272812c8c0`                                                                                           |
| KV Namespace       | `ISR_CACHE`     | `7a0284b2390b42218901919579aadf0e`                                                                                           |
| Dispatch Namespace | `DISPATCH`      | `void-users`                                                                                                                 |
| Durable Object     | `USAGE_COUNTER` | `UsageCounter` (per-user usage enforcement)                                                                                  |
| Queue (consumer)   | —               | `void-usage-events` (batch 100, timeout 5s)                                                                                  |
| Cron Trigger       | —               | `0 * * * *` (hourly — full maintenance: reconcile all pending domains → stale-pending cleanup → billing rollover + backfill) |
| Cron Trigger       | —               | `*/2 * * * *` (fast tier — reconcile pending domains created within the last 30 min only; no other maintenance)              |

**Dispatch worker** (`void-dispatch`):

| Resource           | Binding       | Name / ID                                                   |
| ------------------ | ------------- | ----------------------------------------------------------- |
| Dispatch Namespace | `DISPATCH`    | `void-users`                                                |
| KV Namespace       | `ROUTING`     | `9250c33f3db6494ebe8ad6272812c8c0`                          |
| KV Namespace       | `ISR_CACHE`   | `7a0284b2390b42218901919579aadf0e`                          |
| Analytics Engine   | `ANALYTICS`   | `vite_cloud_requests`                                       |
| Queue (producer)   | `USAGE_QUEUE` | `void-usage-events`                                         |
| Routes             | —             | `*.void.app/*`, `*.void.app`, `*/*`, `*` (zone: `void.app`) |

**Tail worker** (`void-tail`):

| Resource         | Binding      | Name / ID                                   |
| ---------------- | ------------ | ------------------------------------------- |
| Analytics Engine | `ANALYTICS`  | `void_logs`                                 |
| Durable Object   | `LOG_STREAM` | `LogStream` (per-worker live log broadcast) |

**Proxy worker** (`void-proxy`):

| Resource        | Binding | Name / ID                                                     |
| --------------- | ------- | ------------------------------------------------------------- |
| Workers AI      | `AI`    | (account-level)                                               |
| AI Gateway      | —       | `void` (shared, account-level)                                |
| Service Binding | `API`   | `void-api` (for internal revalidation)                        |
| Routes          | —       | `proxy.void.cloud/*`, `proxy.void.cloud` (zone: `void.cloud`) |

**Dashboard worker** (`void-dashboard`):

| Resource   | Binding      | Name / ID                                                     |
| ---------- | ------------ | ------------------------------------------------------------- |
| Hyperdrive | `HYPERDRIVE` | `7bd6b2a606a347819ad3421867840736` (→ PlanetScale PostgreSQL) |
| Service    | `API`        | `void-api`                                                    |
| Assets     | —            | `dist/client` (static files)                                  |
| Routes     | —            | `dash.void.cloud`                                             |

The dashboard has a Hyperdrive binding for read-only loaders (direct Drizzle queries) and a service binding to the API worker for mutations.

All workers: `compatibility_date: 2026-02-12`, `compatibility_flags: ["nodejs_compat"]`, `observability: enabled`.

### Staging

Same resource types with `-staging` suffixes:

| Resource    | API                                                           | Dashboard                                                     | Dispatch                                                 | Proxy                                                    |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Hyperdrive  | `7cde35825e6249d0b60b9de69feb29dd` (→ PlanetScale PostgreSQL) | `7cde35825e6249d0b60b9de69feb29dd` (→ PlanetScale PostgreSQL) | —                                                        | —                                                        |
| KV ROUTING  | `60240eecea804f39bf8b7395cd6c6b08`                            | —                                                             | `60240eecea804f39bf8b7395cd6c6b08`                       | —                                                        |
| KV ISR      | `7f13ef3a3745445c883a5bbc72f031b7`                            | —                                                             | `7f13ef3a3745445c883a5bbc72f031b7`                       | —                                                        |
| Dispatch NS | `void-users-staging`                                          | —                                                             | `void-users-staging`                                     | —                                                        |
| Analytics   | —                                                             | —                                                             | `vite_cloud_requests_staging`                            | —                                                        |
| Queue       | `void-usage-events-staging` (consumer)                        | —                                                             | `void-usage-events-staging` (producer)                   | —                                                        |
| DO          | `UsageCounter` (same class, staging-isolated)                 | —                                                             | —                                                        | —                                                        |
| Workers AI  | —                                                             | —                                                             | —                                                        | `AI` (account-level)                                     |
| Service     | —                                                             | `void-api-staging`                                            | —                                                        | `void-api-staging` (API binding)                         |
| Routes      | —                                                             | `dash.staging.void.cloud`                                     | `*.staging.void.app/*`, `*.staging.void.app`, `*/*`, `*` | `proxy.staging.void.cloud/*`, `proxy.staging.void.cloud` |

## Secrets and Environment Variables

All secrets are stored in a dedicated 1Password vault.

### API Worker Secrets

Set via `wrangler secret put <NAME>` (separate values per environment):

| Secret                              | Purpose                                          |
| ----------------------------------- | ------------------------------------------------ |
| `CF_API_TOKEN`                      | Cloudflare API token (see permissions below)     |
| `CF_ACCOUNT_ID`                     | Cloudflare account ID                            |
| `CF_ZONE_ID`                        | DNS zone ID (`void.app` zone)                    |
| `JWT_SECRET`                        | Signs auth JWTs                                  |
| `PROJECT_SECRET_KEYS_JSON`          | JSON keyring for encrypted project secrets       |
| `PROJECT_SECRET_ACTIVE_KEY_VERSION` | Active key version for new project-secret writes |
| `GITHUB_CLIENT_ID`                  | GitHub OAuth app client ID (user sign-in)        |
| `GITHUB_CLIENT_SECRET`              | GitHub OAuth app client secret (user sign-in)    |
| `GOOGLE_CLIENT_ID`                  | Google OAuth app client ID                       |
| `GOOGLE_CLIENT_SECRET`              | Google OAuth app client secret                   |
| `R2_ACCESS_KEY_ID`                  | R2 access key ID for presigning asset PUT URLs   |
| `R2_SECRET_ACCESS_KEY`              | R2 secret access key for presigning asset PUTs   |
| `GITHUB_APP_ID`                     | GitHub App ID (Deploy on GitHub — see below)     |
| `GITHUB_APP_PRIVATE_KEY`            | GitHub App private key, PKCS#8 PEM (see below)   |
| `GITHUB_WEBHOOK_SECRET`             | HMAC secret verifying GitHub App webhooks        |
| `GITHUB_APP_SLUG`                   | GitHub App slug (builds the install URL)         |

The last four (`GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`) belong to the **GitHub
App** used for Deploy on GitHub — distinct from `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`, which are the GitHub **OAuth app** for user sign-in. All
four are optional: when unset, the worker still runs and the `/webhooks/github`
and `/auth/github-oidc` endpoints return `503`. See
[GitHub App (Deploy on GitHub)](#github-app-deploy-on-github).

`GITHUB_APP_PRIVATE_KEY` must be **PKCS#8** PEM. GitHub issues a PKCS#1 key;
convert it before storing:

```bash
openssl pkcs8 -topk8 -nocrypt -in github-app-pkcs1.pem -out github-app-pkcs8.pem
```

R2 presigning also needs the bucket NAME — not just the binding — because the
`STATIC_ASSETS_R2` binding only surfaces the `R2Bucket` object. The name is
plumbed through `R2_STATIC_ASSETS_BUCKET` in `wrangler.jsonc` (`vars` block)
and must match the configured `r2_buckets[].bucket_name`. Production:
`void-static-assets-overflow`. Staging: `void-static-assets-overflow-staging`.
Not a secret — it's a public bucket name and is committed in `wrangler.jsonc`.

`PROJECT_SECRET_KEYS_JSON` should be a JSON object mapping key-version strings to base64-encoded 32-byte AES keys. `PROJECT_SECRET_ACTIVE_KEY_VERSION` must match one of those configured versions.

Example:

```json
{ "1": "<base64-32-byte-key>" }
```

With:

```text
PROJECT_SECRET_ACTIVE_KEY_VERSION=1
```

Generate a new 32-byte key with:

```bash
openssl rand -base64 32
```

**API worker `CF_API_TOKEN` permissions** — this is the broad-scope token used at runtime to provision and manage user resources. Separate from the GitHub Actions deploy token.

Account-level:

| Permission         | Access | Operations                                                            |
| ------------------ | ------ | --------------------------------------------------------------------- |
| Workers Scripts    | Edit   | Upload/delete user workers in dispatch namespace                      |
| Workers Tail       | Read   | Create/delete tail sessions for live log streaming                    |
| D1                 | Edit   | Create/delete user project D1 databases, execute user migrations      |
| Email Routing      | Edit   | Manage account-wide verified destinations and the shared inbound zone |
| Workers KV Storage | Edit   | Create/delete KV namespaces                                           |
| Workers R2 Storage | Edit   | Create/delete R2 buckets                                              |
| Queues             | Edit   | Create/delete queues, manage queue consumers                          |
| Account Analytics  | Read   | Query Analytics Engine SQL API for usage metering                     |

Zone-level (on `void.app`):

| Permission           | Access | Operations                                  |
| -------------------- | ------ | ------------------------------------------- |
| SSL and Certificates | Edit   | Custom hostname DV certificate provisioning |

### Proxy Worker Secrets

Set via `wrangler secret put <NAME>`:

| Secret          | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `JWT_SECRET`    | Verifies auth JWTs from local dev clients (same as API worker) |
| `CF_ACCOUNT_ID` | Cloudflare account ID (for D1/KV/R2 REST API calls)            |
| `CF_API_TOKEN`  | Cloudflare API token (for D1/KV/R2 REST API calls)             |

### Configurable Environment Variables

Set via `vars` in `wrangler.jsonc` (production uses defaults, staging overrides):

| Worker    | Variable             | Default                                | Staging Override                               | Purpose                                           |
| --------- | -------------------- | -------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| api       | `DISPATCH_NAMESPACE` | `void-users`                           | `void-users-staging`                           | CF dispatch namespace name                        |
| api       | `VOID_PROXY_SERVICE` | `void-proxy`                           | `void-proxy-staging`                           | Proxy worker name for service binding injection   |
| api       | `SITE_DOMAIN`        | `void.app`                             | `staging.void.app`                             | Base domain for deploy URL output                 |
| api       | `AUTH_REDIRECT_URI`  | `https://api.void.cloud/auth/callback` | `https://api.staging.void.cloud/auth/callback` | OAuth callback URL                                |
| api       | `DEV_AUTH_BYPASS`    | (unset)                                | —                                              | Skip admin OAuth for local dev (`.dev.vars` only) |
| dashboard | `API_URL`            | (unset, defaults to production)        | `https://api.staging.void.cloud`               | API base URL for BFF server-side loaders          |
| dispatch  | `BASE_HOSTNAME`      | `void.app`                             | `staging.void.app`                             | Base hostname for slug extraction                 |

### GitHub Actions Secrets

Two GitHub environments (`Prod` and `Staging`) share the same repo-level secrets plus environment-specific database URLs:

| Secret                            | Environment | Purpose                                                                             |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `CF_API_TOKEN`                    | Both        | Cloudflare API token (see permissions below)                                        |
| `CF_ACCOUNT_ID`                   | Both        | Cloudflare account ID (passed as `CLOUDFLARE_ACCOUNT_ID`)                           |
| `DATABASE_URL`                    | Prod        | PlanetScale direct connection string for drizzle-kit migrations                     |
| `STAGING_DATABASE_URL`            | Staging     | PlanetScale direct connection string for drizzle-kit migrations                     |
| `CF_ACCESS_CLIENT_ID_STAGING`     | Staging     | CF Access service-token client id for reaching staging (see Staging Access Control) |
| `CF_ACCESS_CLIENT_SECRET_STAGING` | Staging     | CF Access service-token client secret for reaching staging                          |

`platform-deploy.yml` uses the `Prod` environment and runs on every push to `prod` or on manual dispatch; `platform-deploy-staging.yml` uses `Staging` and runs on every push to `main` that matches the `platform-ci.yml` path filter, or on manual dispatch. Both run only when the repository variable `VOID_PLATFORM_DEPLOY_ENABLED` is `true`.

**GitHub Actions `CF_API_TOKEN` permissions** — narrower-scope token used only for wrangler deploys. Separate from the API worker runtime token.

> ⚠️ **Must be a _User_ API Token, not an _Account_ API Token.** The `api` worker
> declares a `BuildManager` **container**, so `wrangler deploy` now builds and
> pushes a container image. Before pushing, wrangler calls
> `GET /accounts/{id}/containers/me`, and Cloudflare's Containers/Cloudchamber
> gateway **rejects account-owned tokens** there with `403 "Authentication error"`
> — even when the token has Containers read/write. Create the token under
> **My Profile → API Tokens** (user-owned), _not_ Account → API Tokens. Verify
> with `wrangler whoami`: it must print "User API Token". (An account-owned token
> deploys everything else fine and only fails once a container is in the config —
> which is why this surfaced the moment Deploy-on-GitHub merged. See
> [diagnosing the 403](#diagnosing-container-deploy-403).)

Account-level:

| Permission         | Access | Operations                                                    |
| ------------------ | ------ | ------------------------------------------------------------- |
| Workers Scripts    | Edit   | Deploy API and dispatch workers                               |
| Containers         | Edit   | Build + push the `BuildManager` container image during deploy |
| Cloudchamber       | Edit   | Container registry / `/containers/me` preflight               |
| D1                 | Edit   | Bind user project D1 databases during deploy                  |
| Workers KV Storage | Edit   | Bind KV namespaces during deploy                              |
| Workers R2 Storage | Edit   | Bind R2 buckets during deploy                                 |

Zone-level (on `void.app`):

| Permission     | Access | Operations                                          |
| -------------- | ------ | --------------------------------------------------- |
| Workers Routes | Edit   | Set dispatch worker route patterns (`*.void.app/*`) |
| DNS            | Read   | Zone lookup for route binding                       |

#### Diagnosing container-deploy 403

If a deploy fails at `vp run deploy[:staging]` with:

```
✘ ApiError: Forbidden
  url: '.../accounts/<id>/containers/me'  status: 403
  body: { error: 'Authentication error' }
👋 You are logged in with an Account API Token ...
```

wrangler's "ensure it has the correct permissions" hint is generic boilerplate
(it keys on the 403 status only and never reads the body) — do not chase token
scopes first. Disambiguate in ~30 seconds:

```bash
# 1. token type — must be User, not Account
CLOUDFLARE_API_TOKEN=<deploy token> npx wrangler whoami      # "User"? or "Account"?

# 2. is the ACCOUNT entitled for Containers at all?
npx wrangler containers list                                 # via your own OAuth login
#   lists containers → account is entitled → cause is the token type (#1 above)
#   403               → account not onboarded → enable Containers / Workers Paid
```

The 2026-06-22 occurrence was an **account-owned** deploy token against an
**entitled** account → fix was recreating the token as user-owned.

### GitHub App (Deploy on GitHub)

A single GitHub App backs the "Deploy on GitHub" feature — connect a repo, and a
git push builds and deploys automatically. This is separate from the GitHub
**OAuth app** used for user sign-in (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`).

**One-time GitHub App creation** (manual, in the `voidzero-dev` org's GitHub App
settings). After creation, set the four `GITHUB_APP_*` / `GITHUB_WEBHOOK_SECRET`
secrets on the API worker (see [API Worker Secrets](#api-worker-secrets)).

Repository permissions:

| Permission    | Access |
| ------------- | ------ |
| Contents      | Read   |
| Metadata      | Read   |
| Pull requests | Read   |
| Checks        | Write  |

No `Contents: Write`, no `Workflows`. The App only reads source and reports
build status via Checks — `Checks: Write` is now exercised by the "Void Build"
Check Run that container builds publish.

Webhook events: `push`, `installation`, `installation_repositories`,
`pull_request`, `workflow_run`, `check_run`, `check_suite`.

`check_run` and `check_suite` back GitHub's **Re-run** and **Re-run all checks**
buttons on the "Void Build" check. Subscribing is a separate switch from the
`Checks: Write` permission above — without the subscription GitHub renders the
button, delivers nothing, and the click is silently a no-op. Enable both events on
the App (prod **Void Deploy**, App ID 3113472, and the staging App) after
deploying the handler. Only the `rerequested` action does anything; `requested`
and `completed` are ignored, because a suite is requested on every push and the
`push` handler already builds it.

Webhook URLs (one App, both environments):

- `https://api.void.cloud/webhooks/github`
- `https://api.staging.void.cloud/webhooks/github`

**Build executors.** A connected repo builds in one of two ways, selected per
connection (`github_connections.build_executor`, default `container`):

| Executor         | How it runs                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `container`      | Cloudflare Container driven by a `BuildManager`/`BuildManagerLarge` Durable Object (size by plan) — runs the real `void deploy` CLI in-cloud |
| `github_actions` | GitHub Actions in the user's repo; the workflow authenticates back via GitHub OIDC at `POST /auth/github-oidc`                               |

Container builds are queued and rate-limited per plan tier by the
`BuildScheduler` Durable Object (see `packages/api/src/tiers.ts` for
`concurrentBuilds` / `buildTimeoutMinutes`). The Actions executor needs no stored
secret — the workflow scaffolded by `void init --github` mints a short-lived
scoped `VOID_TOKEN` from its OIDC identity.

**Build container sizing (`packages/api/wrangler.jsonc` `containers[]`).** Builds
run on one of two container sizes by the project owner's plan. Free plans use the
`BuildManager` class at `instance_type: standard-3` = 2 vCPU / 8 GiB / 16 GB disk
(a big step up from the Wrangler default `lite`, 256 MiB, which OOMs on an
`install` + Vite production build). Paid plans (solo / pro / sponsored / custom) use
the `BuildManagerLarge` class at `instance_type: standard-4` = 4 vCPU / 12 GiB / 20 GB
— Cloudflare's max per-container size, so paid builds cannot go bigger (custom
instance types are bounded by `standard-4`, and also require ≥3 GiB memory per
vCPU, which is why free runs `standard-3` rather than a 4-vCPU / 8 GiB custom box).
`@cloudflare/containers@0.3.3` cannot size a container per-start, so each size is a
distinct container-enabled DO class with a fixed `instance_type`; the routing key is
the persisted `builds.instance_type` (`standard-3` / `standard-4`), derived from the plan by
`tiers.ts:getBuildInstanceType` and mapped to the DO class by
`build-namespace.ts:buildManagerNamespace`. The scheduler, cancel, and reaper
paths all use that picker so they address the same class. GitHub Actions builds
run on GitHub runners (no container) and have no `instance_type`.
`rollout_active_grace_period: 3900` (65 min = the 60-min
`DEPLOY_TOKEN_HARD_MAX_MINUTES` build cap + 5 min margin) keeps an in-flight build
from being SIGTERM'd when an `api`-worker deploy re-rolls the container app (the
`api` worker hosts both build-container classes and is the first step of every
deploy). Tradeoff: a routine `api` rollout can be delayed up to ~65 min **if** a
max-length build is in flight when the container app re-rolls; a shorter grace
would let rollouts finish sooner but risks killing rare long builds. Both knobs
(instance size = billing cost; grace = rollout-delay tradeoff) are cost/product
decisions — revisit if build durations or rollout cadence change.

**Where to see build logs.** The admin panel shows per-project builds at
`/admin/projects/:id` (ongoing build highlighted) and a build detail page at
`/admin/builds/:id`. For `container` builds the detail page tails logs live
(client-side polling of `GET /admin/builds/:id/logs?since=N`, which fronts the
`BuildManager`/`BuildManagerLarge` DO that ran the build). For `github_actions`
builds it links out to the GitHub Actions run instead.

### CLI Staging Mode

Internal-only toggle for pointing the CLI at staging. Not documented in public docs.

- `void staging on` — sets `"staging": true` in `~/.void/config.json`
- Reads/writes `stagingToken` instead of `token`
- Defaults API URL to `https://api.staging.void.cloud`
- Can also be activated via `VOID_API_URL=https://api.staging.void.cloud`. The CLI does **not** read `STAGING=1` (`packages/void/src/cli/project.ts:isVoidInternalStaging` only checks `.void/project.json`), so CI workflows must set `VOID_API_URL` explicitly.

## Staging Access Control

All four public staging hostnames sit behind Cloudflare Access:

- `api.staging.void.cloud`
- `dash.staging.void.cloud`
- `proxy.staging.void.cloud`
- `*.staging.void.app` (wildcard over dispatch)

Production hostnames are **not** gated — this applies to staging only, even though staging and prod share the same CF account.

**Identity policy:** each of the four Access Applications has one `Allow` rule: `GitHub organization = voidzero-dev` via GitHub as the IdP. Log into CF Zero Trust with any GitHub account that is a member of the `voidzero-dev` GitHub organization to pass. Email-based matching is avoided because GitHub does not reliably expose a primary email unless the user has made it public. Members whose org membership is private must click **Grant** on the OAuth consent screen the first time they sign in; if the org ever enforces SAML SSO, each member must also SSO-authorize the CF Access OAuth app via `github.com/orgs/voidzero-dev/sso`.

**Bypass rules** (do not prompt for Access login — paths hit by third-party OAuth redirects or by GitHub itself, which cannot present Access credentials):

- `api.staging.void.cloud/auth/callback`
- `api.staging.void.cloud/admin/callback`
- `dash.staging.void.cloud/auth/callback`
- `api.staging.void.cloud/webhooks/github`
- `api.staging.void.cloud/auth/github-oidc`

Each path is self-validating in application code, so bypassing Access does not weaken auth: the OAuth callbacks use HMAC-signed `state` and nonce cookies, `/webhooks/github` verifies the GitHub HMAC webhook signature, and `/auth/github-oidc` verifies the GitHub Actions OIDC token against GitHub's JWKS. GitHub (delivering webhooks, or an Actions runner calling the OIDC endpoint) cannot present CF Access service-token or JWT credentials, so these paths must bypass.

### Teammate dev setup (browser-based, no shared secret)

The Void CLI auto-authenticates against staging via `cloudflared`. One-time setup per machine:

```
brew install cloudflared
```

That's it. The first time you run any `void` command against staging (`void project status`, `void deploy`, etc.), the CLI shells out to `cloudflared access login` if no cached JWT exists — a browser tab opens, you sign in with GitHub (must be a `voidzero-dev` org member), and a 24-hour JWT lands in the local cloudflared cache. Subsequent runs within 24h are silent.

No env vars, no 1Password dance, no shared secret. The JWT is tied to your GitHub identity — revoked the moment you leave the org.

Manual `cloudflared` commands if you need to force re-auth or inspect the token:

```
cloudflared access login https://api.staging.void.cloud
cloudflared access token -app=https://api.staging.void.cloud   # prints the cached JWT
```

### Service token (CI / non-interactive)

For CI and any non-interactive automation, a shared service token `void-staging-programmatic` (CF Zero Trust → Access → Service Auth) is stored in 1Password under `void / staging / cf-access-service-token` and duplicated into the `Staging` GitHub environment as `CF_ACCESS_CLIENT_ID_STAGING` and `CF_ACCESS_CLIENT_SECRET_STAGING`.

The framework's `cfAccessHeaders` helper resolves credentials in this priority order:

1. **Service token pair** — `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` → sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` (CI path)
2. **User JWT** — `CF_ACCESS_TOKEN` → sends `cf-access-token` (dev path, usually populated by the CLI's `cloudflared` probe)
3. **None** — no headers (prod, or unprotected hostnames)

Callers:

| Caller                                   | How credentials are resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Void CLI (`void deploy`, `void whoami`…) | Eager `cloudflared` probe at client construction → sets `CF_ACCESS_TOKEN`. `CF_ACCESS_CLIENT_ID`/`SECRET` in env override the probe.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Smoke-test CI workflow                   | `.github/workflows/smoke-test.yml` → `$CF_ACCESS_CLIENT_ID_STAGING` / `$CF_ACCESS_CLIENT_SECRET_STAGING` (service token)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Container build executor (staging)       | `BuildManager` forwards the staging API worker's `CF_ACCESS_CLIENT_ID_STAGING` / `CF_ACCESS_CLIENT_SECRET_STAGING` into the build container as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. The build-agent scrubs them from untrusted install children and re-injects them only into the trusted `void deploy` child (mirrors `VOID_TOKEN`). The container can't do the interactive `cloudflared` flow (no TTY/binary). Set both as **staging API worker** secrets (`wrangler secret put … --env staging`); unset on prod (not Access-gated). |
| Remote D1/KV/R2 bindings in local dev    | Whatever env vars the local process inherits; CLI's `CF_ACCESS_TOKEN` is forwarded to miniflare                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deployed staging user workers            | `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` set as worker env bindings (rare — only if the worker calls `proxy.staging.void.cloud` directly via `__VOID_PROXY_URL`)                                                                                                                                                                                                                                                                                                                                                                            |

**Rotating the service token:** rotate in the CF Zero Trust dashboard, update the 1Password entry, both `Staging` GitHub secrets, and the staging API worker's `CF_ACCESS_CLIENT_ID_STAGING` / `CF_ACCESS_CLIENT_SECRET_STAGING` secrets (used by the container build executor), and notify anyone with the creds set in their shell. No code change required. Teammate JWTs (via `cloudflared`) are per-user and unaffected.

**Rollback:** delete the four Access Applications in CF Zero Trust. Code changes are inert when neither credential path is populated, so no code rollback needed.

## Deploy Process

### Deploy Scripts

`platform/package.json` retains the hosted production and manual per-service deployment scripts. Run these from `platform/`, or from the repository root as `vp run --filter @voidcloud/platform <script>`. A fresh checkout needs the SDK build first (`vp run build` from the repository root; from `platform/` that name is the dashboard build) because the dashboard bundles the SDK from `dist/`.

```
vp run deploy           # Production: same with --env production
vp run deploy:staging   # First-party Void Cloud staging path; CI uses this
```

Broken down:

```
deploy
├── deploy:api          → vp run --filter @voidcloud/api migrate         (drizzle-kit migrate — requires DATABASE_URL)
│                       → vp run --filter @voidcloud/api deploy --env production
├── deploy:proxy        → vp run --filter @voidcloud/proxy deploy --env production
├── deploy:tail         → vp run --filter @voidcloud/tail deploy --env production
├── deploy:dispatch     → vp run --filter @voidcloud/dispatch deploy --env production
└── deploy:dashboard    → vp run --filter @voidcloud/dashboard deploy --env production

main staging CI
├── vp run build
├── vp run --filter @voidcloud/platform deploy:staging
└── reusable platform smoke test (deploy and exercise kitchen-sink)
```

Deploy order matters. The first-party production and staging scripts run PostgreSQL migrations before the API Worker, then proxy, tail, dispatch, and dashboard. A newer workflow run never cancels an active deployment.

### API rollout notes for DB-backed project secrets

When rolling out the API version that introduces encrypted DB-backed project secrets:

1. set `PROJECT_SECRET_KEYS_JSON` and `PROJECT_SECRET_ACTIVE_KEY_VERSION` on the API worker before deploy
2. run the normal API migrate-then-deploy flow (`vp run deploy:api` or `vp run deploy:staging:api`)
3. roll out the framework/runtime side after the API is live

The API migration creates the `project_secrets` table. The deploy scripts above already run the migration before `wrangler deploy`.

This is a clean cutover. The API only reads project secrets from `project_secrets`; any older worker-only secrets set directly on Cloudflare workers are ignored after rollout. If there are existing staging/test projects with secrets you still need, re-add them with `void secret put` or `void secret sync` after the API deploy.

### GitHub Actions

Four platform workflows live in the repository-level `.github/workflows/` directory, prefixed `platform-`. Every deploy and smoke-test job is gated on the repository variable `VOID_PLATFORM_DEPLOY_ENABLED == 'true'`.

**`platform-ci.yml`** — runs on PRs to `main` that touch `platform/**`, `packages/**`, or the root manifests, and as a reusable workflow:

1. Set up Vite+ and Node.js (from `.node-version`); `setup-vp` runs `vp install`
2. `vp fmt --check`, `vp lint`
3. `vp run build` (SDK packages), then `vp run --filter './platform/packages/**' build`
4. `vp run lint:platform` (type-aware lint; needs the dashboard build output)
5. `vp run check:platform` and `vp run check:sdk` (typecheck the platform packages and the SDK packages; the playgrounds are typechecked by `ci.yml`)
6. `vp test run --project platform-unit` and `--project platform-api-integration`
7. Builds the API build container image (PRs only)
8. The production schema-compatibility guard (`schema-compat`; PRs and production deploys): migrates a fresh Postgres 18 with the candidate's migrations and runs the `prod` branch's `platform-api-integration` suite on it

**`platform-deploy.yml`** — push to `prod`, or manual dispatch (production, environment: `Prod`):

1. Runs `platform-ci.yml` first
2. `vp run build` (SDK packages the dashboard bundles)
3. `vp run --filter @voidcloud/platform deploy` (api with drizzle-kit migrations, proxy, tail, dispatch, dashboard)

`prod` is the production ref: it points at the commit that is live, so advancing it is the release (`git push origin main:prod` deploys whatever `main` is at). There is no path filter — a push to `prod` is deliberate. The branch carries a `prod` ruleset that blocks deletion and force-pushes and allows updates only from its bypass actors (organization admins, repository admins, and the `Void` team), so a push to `prod` is a maintainer action. A `concurrency` group (`platform-deploy-production`, `cancel-in-progress: false`) keeps one deploy running and at most one pending, so a deploy is never interrupted between the API migration and the workers.

**`platform-deploy-staging.yml`** — push to `main` that matches the `platform-ci.yml` path filter, or manual dispatch (staging, environment: `Staging`):

1. Runs `platform-ci.yml` first
2. Builds the SDK packages consumed by the platform
3. Deploys the established Void Cloud staging resources through `vp run --filter @voidcloud/platform deploy:staging`
4. Calls the reusable kitchen-sink smoke test after deployment succeeds

A `concurrency` group (`platform-deploy-staging`, `cancel-in-progress: false`) keeps one deploy running and at most one pending, so a burst of pushes never interrupts a deploy between the API migration and the workers.

The protected `Staging` environment must supply `CF_API_TOKEN`, `CF_ACCOUNT_ID`, and `STAGING_DATABASE_URL`. Access-gated staging also supplies `CF_ACCESS_CLIENT_ID_STAGING` and `CF_ACCESS_CLIENT_SECRET_STAGING` to its smoke test.

Void Cloud staging predates the public platform installer and deliberately remains a first-party deployment. Its populated database, stable Worker names, domains, and existing resources must not be claimed or recreated by `void platform install`. Self-hosted platforms use the ownership-tracked `void platform install`, `discover`, and `upgrade` lifecycle instead.

**`platform-smoke-test.yml`** — reusable from the staging deploy, manually dispatchable, and scheduled daily (`0 0 * * *`, 8am SGT), environment: `Staging`: builds the SDK, deploys `playground/kitchen-sink` to staging with `void deploy`, resets its state, and runs `platform/scripts/kitchen-sink-smoke-test.ts` against `https://kitchen-sink.staging.void.app`.

### Health Checks

```
pnpm health            # Check production API health
pnpm health:staging    # Check staging API health
```

## DNS Setup

| Record                     | Zone         | Points To                                        |
| -------------------------- | ------------ | ------------------------------------------------ |
| `api.void.cloud`           | `void.cloud` | API worker                                       |
| `dash.void.cloud`          | `void.cloud` | Dashboard worker                                 |
| `*.void.app`               | `void.app`   | Dispatch worker (wildcard route)                 |
| `cname.void.app`           | `void.app`   | CF for SaaS fallback origin (AAAA `100::`)       |
| `proxy.void.cloud`         | `void.cloud` | Proxy worker                                     |
| `api.staging.void.cloud`   | `void.cloud` | Staging API worker                               |
| `dash.staging.void.cloud`  | `void.cloud` | Staging dashboard worker                         |
| `*.staging.void.app`       | `void.app`   | Staging dispatch worker (wildcard route)         |
| `proxy.staging.void.cloud` | `void.cloud` | Staging proxy worker                             |
| `mail.void.cloud`          | `void.cloud` | Email Routing subdomain (catch-all to the proxy) |

## Email

The platform runs one shared mail facility for every project. A project sends
as `<slug>[+tag]@<mail domain>` and receives at `<slug>+anything@<mail domain>`.
No per-project DNS work.

The mail domain is a var, not a constant. The api worker and the proxy worker
each declare `EMAIL_SENDER_DOMAIN`, and deployed user workers receive it as the
`__VOID_EMAIL_DOMAIN` binding. **The two worker values must match.** The proxy
validates every sender against its own copy, so a mismatch makes the api's own
verification mail fail with `INVALID_FROM` from our own proxy. Production is
`mail.void.cloud`; staging is `mail.staging.void.cloud`.

Every reader fails closed when the var is absent. Nothing falls back to a
baked-in domain.

### One-time zone setup, per environment

Do these in order. Step 4 before step 5, or the catch-all points at a worker
with no `email()` export.

The mail domain is a **subdomain of the existing `void.cloud` zone**, not a
zone of its own. `void.cloud` is already on Cloudflare DNS with Email Routing
enabled (MX → `route*.mx.cloudflare.net`, SPF present — checked 2026-09-11).
There is no registration and no nameserver change. As of 2026-09-11 neither
`mail.void.cloud` nor `mail.staging.void.cloud` has any DNS record, so nothing
below has been done yet in either environment.

1. **Extend `CF_API_TOKEN` with `Email Routing: Edit`.** Without it every
   `addDestination` returns 403. That reaches a CLI user as a 502, and the
   auto-add on project create swallows it entirely — the owner never gets a
   verification mail and cannot send to their own address.
2. **Add the subdomain to Email Routing.** Dashboard: Compute → Email
   Service → Email Routing → `void.cloud` → Settings → Subdomains → enter
   `mail.void.cloud` (or `mail.staging.void.cloud`). Cloudflare adds and locks
   the MX, SPF and DKIM records on the subdomain. This step is dashboard-only:
   neither the REST API nor `wrangler email routing enable` documents a
   subdomain form. **Unverified:** the docs show one-label examples only;
   confirm the two-label staging name is accepted before writing it anywhere
   else.
3. **Onboard the same name to Email Sending.** Dashboard: Email Service →
   Email Sending → Onboard Domain, or `wrangler email sending enable
mail.void.cloud`. This adds the `cf-bounce` MX, SPF, DKIM and DMARC
   records. Without it the binding can send **only to verified destination
   addresses, and those are capped at 200 per account, shared across every
   domain and every project** — a platform-wide ceiling. With it the binding
   sends to any recipient; per-project consent stays in our own allowlist.
   Requires the Workers Paid plan.
4. **Deploy the proxy** with `send_email` bound and the `email()` export live.
   Check all three scopes in `platform/packages/proxy/wrangler.jsonc`: the top level,
   `env.production` and `env.staging`. Wrangler does not inherit `send_email`
   into a named env, and `deploy:proxy` runs `--env production`.
5. **Create the catch-all rule** on the subdomain. Action _Send to a Worker_,
   destination `void-proxy` (or `void-proxy-staging`). `PUT
/zones/{zone}/email/routing/rules/catch_all` with
   `{ "type": "worker", "value": ["void-proxy"] }` also works; wrangler has no
   catch-all command, and the `addresses` array wrangler ≥ 4.113 applies on
   `wrangler deploy` cannot write it either — its `*@` catch-all is apex-only,
   and the mail domain is a subdomain. This rule is the real kill switch:
   deleting it stops all inbound immediately.
   Do not touch the zone's **subaddressing** setting (`support_subaddress`,
   `false` on `void.cloud` as of 2026-09-11). The catch-all takes every
   address on the subdomain, so `<slug>+tag@` needs no per-zone setting
   here; the setting matters only for literal rules (own-account deploys).
6. **Slug mirror.** The proxy resolves a sender through
   `email-slug:<projectId>` in `ROUTING` KV. `createProject` writes it, and
   the hourly rollover (`platform/packages/api/src/index.ts`, `processUserRollover`)
   rewrites it for every project, so a project that predates this feature is
   covered within an hour of the api deploy. Until then its sends return a 502
   `project slug unknown`. No manual pass is needed.
7. **Verify.** `wrangler tail void-proxy`, then send to
   `<test-slug>+test@<mail domain>`. Expect an `[email-router]` line and either
   a dispatch or a `setReject` with a readable reason. Note that outbound sent
   through the binding shows as **dropped** in the Email Routing summary even
   when delivered; read Email Sending metrics or the tail instead.

### Deploy order

Deploy the **proxy before the api**. The api's verification mail posts to the
proxy's `/email/internal/send`, so an api-first deploy leaves that mail silently
dark until the proxy catches up. `vp run deploy` runs api first, so run the two
as explicit steps for the release that turns email on.

### Rollback

- Delete the catch-all rule to stop inbound.
- Redeploy the proxy without `send_email` to stop outbound.

### Before you deploy this the first time

Two changes are retroactive and server-side. Check production first.

- `SEND_EMAIL`, `__VOID_EMAIL_DOMAIN` and `__VOID_PROJECT_SLUG` are now
  reserved binding names. A project holding one as a var or a stored secret
  starts failing deploys with `reserved binding names: ...`, and a user cannot
  remove a stored secret from the manifest. Query
  `project_secrets.name IN (...)` before deploying the api.
- `noreply`, `postmaster`, `abuse`, `bounce` and `security` are now reserved
  slugs. That gates creation only, so a project already holding one keeps it —
  and `noreply` is the platform's own verification sender. Check for existing
  holders.

## Fresh Environment Setup

Steps to provision a new environment from scratch (e.g. reproducing staging):

1. **Provision PlanetScale database**:
   - Create a new database (or branch) in PlanetScale
   - Note the direct connection string (for drizzle-kit migrations) and the PgBouncer connection string (for Hyperdrive)
   - Run `DATABASE_URL=<direct-url> drizzle-kit migrate` from `packages/api/` to apply the schema

2. **Create CF resources** (all with environment suffix):
   - Hyperdrive configuration (pointing to the PlanetScale PgBouncer URL)
   - KV namespace for ROUTING
   - KV namespace for ISR_CACHE (`wrangler kv namespace create void-isr-cache-<env>`)
   - Dispatch namespace (Workers for Platforms)
   - Analytics Engine dataset
   - AI Gateway named `void`
   - Queue: `wrangler queues create void-usage-events-<env>` (usage enforcement events)

3. **Update wrangler configs** — add an `env.<name>` section in `packages/api/wrangler.jsonc`, `packages/dashboard/wrangler.jsonc`, `packages/dispatch/wrangler.jsonc`, and `packages/proxy/wrangler.jsonc` with the new resource IDs (including the Hyperdrive configuration ID).

4. **Set worker secrets** — for the API worker:

   ```
   wrangler secret put CF_API_TOKEN --env <name>
   wrangler secret put CF_ACCOUNT_ID --env <name>
   wrangler secret put CF_ZONE_ID --env <name>
   wrangler secret put JWT_SECRET --env <name>
   wrangler secret put PROJECT_SECRET_KEYS_JSON --env <name>
   wrangler secret put PROJECT_SECRET_ACTIVE_KEY_VERSION --env <name>
   wrangler secret put GITHUB_CLIENT_ID --env <name>      # OAuth app (user sign-in)
   wrangler secret put GITHUB_CLIENT_SECRET --env <name>  # OAuth app (user sign-in)
   wrangler secret put GOOGLE_CLIENT_ID --env <name>
   wrangler secret put GOOGLE_CLIENT_SECRET --env <name>
   wrangler secret put R2_ACCESS_KEY_ID --env <name>
   wrangler secret put R2_SECRET_ACCESS_KEY --env <name>

   # GitHub App (Deploy on GitHub) — optional; endpoints 503 until set
   wrangler secret put GITHUB_APP_ID --env <name>
   wrangler secret put GITHUB_APP_PRIVATE_KEY --env <name>  # PKCS#8 PEM (convert with openssl pkcs8 -topk8 -nocrypt)
   wrangler secret put GITHUB_WEBHOOK_SECRET --env <name>
   wrangler secret put GITHUB_APP_SLUG --env <name>

   # Staging ONLY — CF Access service token so container builds can reach the
   # Access-gated staging API (see Staging Access Control). Omit on prod.
   wrangler secret put CF_ACCESS_CLIENT_ID_STAGING --env staging
   wrangler secret put CF_ACCESS_CLIENT_SECRET_STAGING --env staging

   ```

5. **DNS records** — all records must be proxied (orange cloud).

   **`void.app` zone:**

   | Record    | Type  | Content                                    | Purpose                                                       |
   | --------- | ----- | ------------------------------------------ | ------------------------------------------------------------- |
   | `cname`   | AAAA  | `100::`                                    | CF for SaaS fallback origin + CNAME target for custom domains |
   | `*.<env>` | CNAME | `void-dispatch-<env>.voidzer0.workers.dev` | Wildcard for dispatch worker route patterns                   |

   **`void.cloud` zone:**

   | Record        | Type  | Content                                 | Purpose            |
   | ------------- | ----- | --------------------------------------- | ------------------ |
   | `proxy.<env>` | CNAME | `void-proxy-<env>.voidzer0.workers.dev` | Proxy worker route |

   **Advanced Certificate Manager (ACM):** Each environment's wildcard subdomain needs an edge certificate. In the `void.app` zone, go to SSL/TLS > Edge Certificates > Advanced Certificate Manager and create a certificate covering `*.<env>.void.app`. Without this, HTTPS requests to `*.<env>.void.app` will fail even if DNS resolves correctly.

   **CF for SaaS (Custom Hostnames):** Enabled on the `void.app` zone. Fallback origin set to `cname.void.app`. The dispatch worker's `*/*` catch-all route intercepts custom hostname traffic before CF reaches the dummy `100::` origin. Users CNAME their custom domain to `cname.void.app`.

   **`void.cloud` zone** (API and dashboard use Worker Custom Domains — CF creates the DNS records automatically when you add the custom domain to the worker):

   | Record       | Type  | Content           | Purpose          |
   | ------------ | ----- | ----------------- | ---------------- |
   | `api.<env>`  | CNAME | _(managed by CF)_ | API worker       |
   | `dash.<env>` | CNAME | _(managed by CF)_ | Dashboard worker |

6. **OAuth callback URLs** — add the new API URL as an authorized redirect in both the GitHub OAuth App and Google OAuth Client:
   - `https://<api-host>/auth/callback`
   - `https://<api-host>/admin/callback`

7. **GitHub Actions** — if CI/CD should deploy to this environment, add a workflow file and configure GitHub environment secrets (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `DATABASE_URL` or `STAGING_DATABASE_URL` for drizzle-kit migrations).

8. **Deploy** — run `vp run deploy:<name>` or equivalent.

## Signup Allowlist (Private Beta)

Temporary mechanism to restrict signups during private beta. Managed via the admin dashboard at `/admin/signup-control`.

**Storage:** Two keys in the existing `ROUTING` KV namespace (shared by API and dispatch workers):

| Key                | Value                                                        | Default   |
| ------------------ | ------------------------------------------------------------ | --------- |
| `signup:enabled`   | `"true"` or `"false"` — global toggle for signup restriction | `"false"` |
| `signup:allowlist` | JSON array of `{ type, pattern, note? }` entries             | `[]`      |

**Entry types:**

| Type     | Pattern examples    | Matches                                           |
| -------- | ------------------- | ------------------------------------------------- |
| `github` | `octocat`           | GitHub username (case-insensitive)                |
| `email`  | `alice@example.com` | Exact email address (case-insensitive)            |
| `email`  | `*@voidzero.dev`    | All emails at domain (wildcard, case-insensitive) |

**Behavior:** When `signup:enabled` is `"true"`, new user signups are checked against the allowlist. GitHub signups match against `github` entries by username. Google signups match against `email` entries. If no entry matches, the user is redirected to `/signup-restricted` (a static page saying "Sorry, we are still in private beta. Check back later!"). Existing users are never blocked — the check only applies to new account creation.

**Admin UI:** Toggle on/off, add/remove entries at `/admin/signup-control` (requires admin role).

**Cleanup (post-beta):** Delete KV keys `signup:enabled` and `signup:allowlist`, then remove the admin route (`src/admin/routes/signup-control.tsx`), view (`src/admin/views/signup-control.tsx`), matching logic (`src/signup-allowlist.ts`), the auth check in `src/routes/auth.ts`, the `/signup-restricted` route in `src/index.ts`, and the nav link in `src/admin/views/layout.tsx`.

## Migration History

### Platform DB: D1 → PlanetScale PostgreSQL (February 2026)

The platform's own database was migrated from Cloudflare D1 (SQLite) to PlanetScale PostgreSQL accessed via Cloudflare Hyperdrive. See `meta/design-docs/0015-platform-d1-to-planetscale.md` for the full design doc.

**What changed:**

| Component         | Before                                  | After                                                       |
| ----------------- | --------------------------------------- | ----------------------------------------------------------- |
| Database          | Cloudflare D1 (SQLite)                  | PlanetScale PostgreSQL via Hyperdrive                       |
| Driver            | `drizzle-orm/d1`                        | `drizzle-orm/node-postgres` (`pg` package)                  |
| Schema definition | `sqliteTable`                           | `pgTable`                                                   |
| Date columns      | `text` + `sql\`datetime('now')\``       | `timestamp` + `defaultNow()`                                |
| Wrangler binding  | `d1_databases` → `env.DB: D1Database`   | `hyperdrive` → `env.HYPERDRIVE: Hyperdrive`                 |
| Drizzle config    | `dialect: "sqlite"`                     | `dialect: "postgresql"`, `DATABASE_URL` env var             |
| Migrations        | `wrangler d1 migrations apply --remote` | `drizzle-kit migrate` (direct PlanetScale connection)       |
| Tests             | Miniflare D1                            | PGlite (in-process WASM PostgreSQL, `@electric-sql/pglite`) |

**What did NOT change:** User project D1 databases are still provisioned via the CF API — only the platform's own database uses PostgreSQL. The API worker's `CF_API_TOKEN` still needs D1 Edit permission for user project databases.

**Both API and Dashboard workers** share the same Hyperdrive configuration per environment, connecting to the same PlanetScale database. The dashboard uses direct Drizzle queries for read-only loaders; mutations go through the API worker.

### Domain: voidcloud.dev → void.app (February 2026)

The userspace domain was migrated from `voidcloud.dev` to `void.app` in February 2026. All DNS records, CF for SaaS configuration, API token permissions, code references, tests, and documentation have been updated. The `void.app` zone is now the primary zone for user site routing and custom domain CNAME targets (`cname.void.app`).

## Runbooks

### Pre-PR-#0067 sandbox cutover (one-time)

The 4 tenants below have stale CF container apps bound to per-deploy DO namespaces from before the cross-script DO host architecture (PR #131). Their next deploy after #131 ships will fail with:

> container application "proj-<id>-void-sandbox" exists but is bound to namespace ... (expected ...). This is the pre-PR-#0067 stuck-tenant state. Operator action required: ...

**Affected tenants (project IDs):**

- recappi (look up project ID before running)
- dtnyzh0qckg3
- 2ves8mgqb4po
- 60c3lfqptd2i

**Operator steps (run BEFORE the tenant's next deploy):**

1. Notify the tenant 24h in advance — sandbox container state will be lost (filesystem, processes, exposed ports, in-flight WebSockets).
2. Find each project's deterministic container app name: `proj-{projectId}-void-sandbox` (lowercased, underscores → dashes; same as `sandboxContainerApplicationName(projectId, 'void-sandbox')` in code).
3. Delete the stale container app:
   ```
   wrangler containers delete proj-<projectId>-void-sandbox
   ```
4. Tell the tenant they can deploy. Their first post-cutover deploy will:
   - PUT a fresh `do-host-${slug}` script
   - POST a fresh container app on the host's namespace
   - Resolve `getSandbox(id)` to a fresh DO instance (state lost — by design at cutover only)

Subsequent deploys preserve sandbox state per the architecture's normal guarantees.

### Sandbox host script orphaned after partial teardown failure

**Symptom:** A project was deleted but its `do-host-<slug>` script and/or `<projectId>-<containerName>` container application still exist in Cloudflare. This can happen if the platform's `teardownProject` flow crashed between status flip and CF cleanup completion, or after a manual operator intervention.

**Diagnosis:**

1. Confirm the project is fully deleted from PostgreSQL: `SELECT * FROM projects WHERE slug = '<slug>'` returns 0 rows.
2. List the dispatch namespace: `wrangler dispatch-namespace get-script <namespace> do-host-<slug>` — if it returns success, the host is orphaned.
3. List container apps: `wrangler containers list | rg <projectId>` — if any match, they're orphaned.

**Remediation:**

1. DELETE the host script: `curl -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/dispatch/namespaces/$DISPATCH_NAMESPACE/scripts/do-host-<slug>"`
2. DELETE the container app: `curl -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/containers/applications/<containerAppId>"`
3. Re-run platform teardown if the project row still exists in PG (idempotent).

**Why this can happen:** Critical CF DELETE failures (5xx, network) abort `teardownProject` BEFORE the DB cascade runs, so the operator can retry. But if the operator force-cascades the DB or runs an out-of-band delete, the CF state is left behind with no DB pointer.
