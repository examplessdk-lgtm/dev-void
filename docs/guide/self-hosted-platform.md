---
outline: deep
---

# Self-host a Void platform

A self-hosted Void platform gives a company one shared control plane in its own Cloudflare account. Developers connect the normal `void` CLI to it, log in with GitHub, create projects, and run `void deploy --platform void`. This is different from `void deploy --platform cloudflare`, which deploys one app directly and does not install a control plane.

Developer and administrator platform sessions created by `void auth login` are stored in the operating-system keychain, scoped to the platform origin. Void refuses to create a new plaintext token file when the keychain is unavailable; headless environments provide `VOID_TOKEN` from a secret manager.

The core installation intentionally excludes the user dashboard, Deploy on GitHub, GitHub App webhooks, build Containers, email, Google OAuth, custom project domains, and sandbox orchestration. Those are optional platform modules, not prerequisites for deploying an app. GitHub OAuth login, CLI deploys, D1, KV, R2, Queues, cron jobs, Workers AI, WebSockets, SSE, ISR, routing, logs, and rollback use the same platform components as Void Cloud.

## Prerequisites

You need:

- A Cloudflare account with Workers for Platforms and the products represented in the footprint below.
- A Cloudflare user who can create the resources represented in the footprint below. Interactive lifecycle commands open Cloudflare browser OAuth and store the session in the operating-system keychain. CI uses `CLOUDFLARE_API_TOKEN` instead.
- A separate, scoped Cloudflare runtime API token for the installed control plane. It manages application Workers, D1, KV, R2, Queues, Analytics, and certificates after installation; it is never used as the human operator credential. Give it account-level Workers Scripts: Edit, Workers Tail: Read, D1: Edit, Workers KV Storage: Edit, Workers R2 Storage: Edit, Queues: Edit, and Account Analytics: Read, plus zone-level SSL and Certificates: Edit on the application zone. The installer prints a direct account-token dashboard link and accepts the value through a masked prompt.
- A dedicated, empty external PostgreSQL database reachable through Cloudflare Hyperdrive. Void never creates or deletes this database. The installer transactionally claims it for one platform installation and refuses to share it with another installation.
- An application base domain such as `apps.example.com`. Its containing Cloudflare zone may already exist or the installer can create it.
- A GitHub OAuth App for login. The installer prints the exact callback URL before asking for its client credentials.
- An R2 API token with Object Read & Write access. This is separate from the Cloudflare management API token and is used to sign direct asset uploads.

Workers for Platforms is a platform-level Cloudflare product. This requirement does not change native single-app deploys: ordinary `void deploy --platform cloudflare` apps remain Workers Free-compatible unless the app explicitly uses a paid-only product such as Containers.

## Preview the installation

Run the interactive installer with `--plan` first:

```sh
void platform install --plan
```

The plan performs reads only. It selects an account, normalizes the installation name, shows every resource it would create, reuse, update, or adopt, and prints the future API and resource-proxy URLs. By default both use their respective Workers' `workers.dev` hostnames.

For a repeatable non-interactive plan:

```sh
void platform install --plan \
  --name company \
  --display-name "Company Void" \
  --account 0123456789abcdef0123456789abcdef \
  --application-domain apps.example.com \
  --zone example.com \
  --yes
```

`--yes` is required for every mutating lifecycle command in CI or another non-interactive shell. Interactive commands still ask before install or uninstall unless `--yes` is provided; `--plan` is always read-only.

Use `--control-plane-domain platform.example.net` when you want a custom API hostname. The hostname must be in a zone the selected account and token can manage. Omitting it keeps the control plane on `workers.dev` and avoids requiring another domain.

Use `--dedicated-zone` only when the application domain is the entire zone and every unmatched hostname in that zone belongs to Void. Without it, Void installs only the explicit `*.application-domain` routes. It never assumes a domain is shaped like `apps.company.com`.

## Configure GitHub OAuth

Create a GitHub OAuth App using the API URL from the plan:

- Homepage URL: the API origin, for example `https://void-company-api.example.workers.dev`
- Authorization callback URL: `<API origin>/auth/callback`

Keep its client ID and client secret for the installer. The installer also asks for the GitHub username of the initial administrator. Only that account can bootstrap the installation, and signup remains restricted after the first login until an administrator explicitly changes the signup controls. First-owner creation is serialized in PostgreSQL so concurrent logins cannot create multiple owners.

## Install

The interactive command asks for every missing value:

```sh
void platform install
```

For non-interactive installation, provide the plan flags above and these environment variables. `CLOUDFLARE_API_TOKEN` is the CI/operator credential; `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` is the distinct token installed into the platform Workers:

```sh
export CLOUDFLARE_API_TOKEN=your-scoped-management-token
export VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN=your-scoped-runtime-token
export VOID_PLATFORM_DATABASE_URL='postgresql://user:password@host/database?sslmode=require'
export VOID_PLATFORM_GITHUB_CLIENT_ID=your-github-oauth-client-id
export VOID_PLATFORM_GITHUB_CLIENT_SECRET=your-github-oauth-client-secret
export VOID_PLATFORM_ADMIN_GITHUB_LOGIN=your-github-username
export VOID_PLATFORM_R2_ACCESS_KEY_ID=your-r2-access-key-id
export VOID_PLATFORM_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key

void platform install \
  --name company \
  --display-name "Company Void" \
  --account 0123456789abcdef0123456789abcdef \
  --application-domain apps.example.com \
  --zone example.com
```

The database must be dedicated to this installation. Its ownership claim and platform tables remain after uninstall because external PostgreSQL is never purged automatically. To reuse it for a different installation, explicitly remove the old platform schema and data yourself or provide a fresh database.

Before changing Cloudflare, the installer shows the complete plan and defaults the confirmation to No. A read-only `--plan` shows the exact footprint with a representative stable suffix; the mutating install allocates a fresh cryptographically random suffix and shows those final names before confirmation. Every create operation is preceded by a durable local intent checkpoint, and ownership is continuously mirrored into the installer-owned routing namespace. The installer also stamps installation-specific ownership markers into every platform Worker and the assets R2 bucket. A local intent alone is never accepted as remote ownership proof, so a concurrent or ambiguous same-name installation fails closed instead of claiming resources it might later delete.

If the requested zone does not exist, Void creates it and stops in a `waiting-for-dns` state. Update the domain at its registrar to use the printed Cloudflare nameservers, wait for the zone to become active, then resume:

```sh
void platform install --resume --name <installation-id>
```

After installation, sign in through `void auth login`. The initial administrator can also open `<API origin>/admin/login` and use the same GitHub account to manage signup access and inspect the platform.

For application traffic, Void creates one proxied wildcard DNS record at `*.application-domain` and the matching Worker routes. A compatible existing proxied record is adopted and is never deleted by Void.

## Cloudflare footprint

Every resource uses a recognizable `void-<installation-name>-<random-suffix>-*` prefix where Cloudflare permits names. The per-installation suffix prevents a concurrent process from predicting and claiming a Worker name before its first upload.

| Resource                                  |  Count | Purpose                                                            |
| ----------------------------------------- | -----: | ------------------------------------------------------------------ |
| Workers                                   |      4 | API/control plane, proxy, tail ingestion, and application dispatch |
| KV namespaces                             |      3 | Routing, ISR cache, and legacy/static asset compatibility          |
| R2 buckets                                |      1 | Static and deployment assets                                       |
| Queues                                    |      2 | Usage events and cron firing                                       |
| Workers for Platforms dispatch namespaces |      1 | User application Workers                                           |
| Hyperdrive configurations                 |      1 | External platform PostgreSQL                                       |
| AI Gateways                               |      1 | Installation-isolated AI routing and metering                      |
| Proxied wildcard DNS records              |      1 | Application hostname resolution                                    |
| Zones                                     | 0 or 1 | Created only when the requested application zone is absent         |

The API Worker declares four Durable Object classes for usage, cron scheduling, error monitoring, and concurrency coordination. Analytics Engine datasets for request and log telemetry are established by Worker bindings rather than separate installer API calls. Core installation creates no Container application, GitHub App, dashboard Worker, or build Worker.

## Connect and deploy an app

A successful installation is selected automatically. On another workstation, connect by API URL; its public discovery document pins both the API and resource-proxy origins so project credentials never cross platform boundaries:

```sh
void platform connect https://void-company-api.example.workers.dev
void auth login
void project link
void deploy --platform void
```

There is no implicit public Void platform for new projects. One configured platform is selected automatically; multiple platforms produce an interactive picker. Non-interactive use with multiple platforms must select one first with `void platform use <id-or-url>`. Existing project files created before platform URLs were recorded continue to resolve to Void Cloud for compatibility.

Use these commands to inspect connections and installations:

```sh
void platform list
void platform use [id]
void platform status [id]
```

## Resume, repair, recover, and upgrade

Local state lives under `~/.void/platforms/`. Manifests contain no credentials. Recovery material is encrypted with AES-256-GCM in owner-only `.recovery.enc` files; the randomly generated encryption key lives in the operating-system keychain. Existing plaintext `.recovery` files are encrypted and deleted on first read. A lifecycle operation refuses to write secrets when the keychain is unavailable instead of falling back to plaintext.

Headless environments may set `VOID_PLATFORM_RECOVERY_KEY` to a canonical base64-encoded 32-byte key supplied by their secret manager. Ephemeral CI jobs may generate a new key for each run because their original platform secrets remain in protected CI secrets and deployed Worker secrets are preserved during upgrades.

- Resume an interrupted install with `void platform install --resume --name <id>`.
- Before the initial PostgreSQL claim succeeds, an explicit database URL may correct a mistyped or unreachable URL. After the claim succeeds—or Hyperdrive has been provisioned—the recorded URL is pinned; resume refuses a different `DATABASE_URL` instead of splitting lifecycle state from the database used by deployed Workers.
- Inspect drift without changes with `void platform repair [id] --plan`.
- Recreate only missing installer-owned resources with `void platform repair [id]`. Missing adopted or external resources fail closed.
- Deploy the packaged current platform runtime and pending database migrations with `void platform upgrade [id]`. Upgrade and repair preserve whether traffic is currently enabled or disabled.
- To test or operate a source build, run `vp run --filter @void/platform build`, then pass `--runtime packages/platform/dist/runtime` to install, upgrade, repair, or enable. Custom runtimes use the same integrity verification, migration safety, staged cutover, health checks, and rollback path as packaged releases. The successful installation checkpoint records the runtime manifest digest, whether it was custom or packaged, and `VOID_PLATFORM_SOURCE_REVISION` when that value was present during the runtime build.
- Platform database upgrades are forward-only and fail closed. The published runtime manifest hashes the migration journal and every SQL file; the installer requires PostgreSQL's Drizzle history to be an exact ordered prefix before it changes the database. Edited, forked, out-of-order, or package-newer histories are rejected.
- When existing platform Workers need pending migrations, the target release must explicitly attest that its final schema remains compatible with the exact old Worker version and current schema digest. If that edge is absent, upgrade stops before the database or Workers change and asks you to use a supported intermediate release. Maintainers must ship expand-compatible schema changes during this rollback-capable transition; destructive contract changes belong in a later release after old Workers can no longer be restored.
- All pending platform migrations run in one PostgreSQL transaction under the lifecycle lock. Worker deployment starts only after the target schema digest is verified and checkpointed. The installation keeps reporting the old platform version until every Worker is deployed and target-version health succeeds. If cutover fails, Void restores the old Workers against the explicitly compatible expanded schema; retry recognizes the completed schema and does not rerun migrations.
- Fresh, resumed, and previously disabled installations write the routing safety gate before the first Worker upload. Bounded API, discovery, proxy, and dispatch health probes can run through that gate, but normal user traffic remains blocked until the complete target runtime passes verification. An ambiguous upload response or interrupted process therefore leaves the incomplete installation closed and safely resumable.
- R2 creation checkpoints the bucket's Cloudflare creation fingerprint before writing its ownership marker. If that marker write fails, resume repairs only the still-missing marker on the exact checkpointed bucket generation; a replacement bucket or foreign marker is never overwritten.
- Upgrade, repair, enable, and interrupted-cutover recovery inventory every existing platform Worker before publishing triggers. Routes and custom domains outside the installation manifest are carried into both the new version and its rollback snapshot, so lifecycle operations do not erase manually attached traffic.
- The manifest fingerprints the Hyperdrive PostgreSQL origin without storing its password. Before migrations or Worker upload, Void fetches the exact Hyperdrive configuration and requires its scheme, host, port, database, and (when Cloudflare returns it) user to match the pinned recovery database. If an administrator retargeted Hyperdrive, the command stops before mutation.
- Recover a lost local manifest from the installation marker in Cloudflare with `void platform discover [--account <id>]`. In an account containing several platforms, add `--installation <id-or-name>` to recover and verify only the intended installation.
- On a newly discovered workstation, provide `VOID_PLATFORM_DATABASE_URL` for database locking and migrations. Normal upgrades preserve the existing encrypted Worker secrets, so GitHub, R2, JWT, project-encryption, and runtime-token values do not need to be re-entered. If repair must recreate a missing API or proxy Worker, restore the original values through the documented `VOID_PLATFORM_*` variables; Void fails before creating an unusable Worker when they are absent. Install, repair, upgrade, enable, disable, and uninstall hold a PostgreSQL session advisory lock so two hosts cannot mutate one installation concurrently. The claimed database row also stores the secret-free authoritative lifecycle manifest, which prevents a host with stale local or Workers KV state from undoing a newer operation.

Discovery verifies the account, every recorded Cloudflare resource, and the routing namespace ownership marker before writing local state. It also verifies the live endpoint identity for a completed enabled installation; interrupted and disabled installations remain recoverable when no endpoint is available. Cloudflare does not expose secret values. Keep the database URL and original runtime secrets in an organizational secret manager for disaster recovery; routine source and package upgrades preserve those deployed secrets without downloading them.

## Continuously deploy a source build

A CI runner does not need a persisted `~/.void/platforms` directory. It can rebuild local state from the installer-owned Cloudflare checkpoint, supply the original secrets from its protected environment, preview the change, and upgrade from a workspace runtime:

```sh
export VOID_PLATFORM_SOURCE_REVISION="$GITHUB_SHA"
vp run build

export VOID_PLATFORM_REGISTRY_DIR="$RUNNER_TEMP/void-platform-registry"
export VOID_PLATFORM_RECOVERY_KEY="$(openssl rand -base64 32)"
void platform discover --account "$CLOUDFLARE_ACCOUNT_ID"
void platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --plan
void platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --yes
```

The installation selector may be omitted when the account contains only one discoverable installation. Serialize deployments for one installation: database migrations and Worker cutover must never be cancelled midway by a newer CI run. Keep the CI management token and database URL in a protected environment. Existing Worker secrets are inherited by new versions; provide the other original secrets only when a repair must recreate a missing Worker or when performing an explicit credential rotation.

## Disable and safely uninstall

New installs observe published routes and custom domains and record them as retained attachments. Cloudflare does not expose a generation precondition for deleting either kind of attachment, so disable, rollback, and uninstall leave them in place for explicit dashboard cleanup. The installation-owned routing flag still blocks platform requests.

Gate platform traffic through an installation-owned routing flag without deleting resources or data. Repair and upgrade keep the installation private until traffic is restored explicitly:

```sh
void platform disable [id] --plan
void platform disable [id]
void platform enable [id] --plan
void platform enable [id]
```

Add `--yes` to a mutating lifecycle command when running it non-interactively.

Disable also blocks queue batches from reaching application Workers. Dispatch retries those batches after five minutes, but delivery remains subject to each Queue consumer's configured retry count and Cloudflare's retention and dead-letter policy. Plan a dead-letter queue or another recovery path when an installation may stay disabled long enough to exhaust those limits.

Preview uninstall first:

```sh
void platform uninstall [id] --plan
```

The default uninstall policy is ownership-aware:

- Adopted or external resources are never deleted.
- Transient Queues are removed. DNS records, routes, and custom domains are retained for explicit dashboard cleanup because Cloudflare cannot condition deletion on the exact configuration the installer verified.
- Installer-owned Workers, KV, R2, Hyperdrive, dispatch, and AI Gateway resources are retained and recorded in the final manifest by default.
- External PostgreSQL is never deleted.
- Zones are always retained. A zone can contain unrelated DNS, settings, and Cloudflare products that the installer cannot exhaustively prove ownership of, so inspect and delete an installer-created zone manually after uninstall if appropriate. The legacy `--delete-zone` flag fails before mutation with this guidance.

To delete installer-owned data:

```sh
void platform uninstall [id] --purge-data
```

`--purge-data` is destructive, but still never deletes external PostgreSQL, Workers, R2, the AI Gateway, Worker routes, Worker custom domains, adopted resources, or a zone. Those Cloudflare APIs expose no server-enforced generation condition, so a replacement could race a client-side ownership check. Void therefore blocks platform traffic through routing storage and leaves those resources to an operator who can inspect the account immediately before cleanup. Before any Cloudflare mutation, Void compares the remote installation checkpoint with fresh resource inventory and verifies the ownership markers on every Worker. A missing or changed ownership proof stops the operation before it can affect a replacement resource. The routing namespace is deleted last, so rerunning after a failure skips completed work. A default data-retaining uninstall keeps a final `uninstalled` audit checkpoint and disabled flag in the retained routing namespace.
