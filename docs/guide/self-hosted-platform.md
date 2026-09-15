---
outline: deep
---

# Self-host a Void platform

A Void platform lets your team deploy apps into a shared Cloudflare account. As an administrator, you install and maintain the platform. Developers connect the Void CLI to its URL, sign in with GitHub, and deploy their apps.

If you're deploying an app for yourself, [deploy directly to Cloudflare](../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account). You don't need to install a platform first.

The CLI stores platform login credentials in your operating system's keychain, separately for each platform URL. For CI, supply `VOID_TOKEN` from a secret manager. Void doesn't create new plaintext token files if the keychain is unavailable.

The core platform supports GitHub login, CLI deploys, D1, KV, R2, Queues, cron jobs, Workers AI, WebSockets, SSE, ISR, routing, logs, and rollback. It uses the same components as Void Cloud.

The user dashboard, GitHub builds and webhooks, build Containers, email, Google login, custom project domains, and sandbox orchestration aren't part of the core installation.

## Prerequisites

You need:

- A Cloudflare account with Workers for Platforms and the products represented in the footprint below.
- Access to create the platform's resources in that account. Void opens your browser to sign in and stores the session in your system keychain. CI uses `CLOUDFLARE_API_TOKEN`.
- A Cloudflare API token for the running platform. This is separate from your administrator login: the platform uses it to manage resources when developers deploy apps. See the permissions below.
- An empty PostgreSQL database reachable through Cloudflare Hyperdrive, dedicated to this installation. Void records the installation in that database and won't let another platform share it. You manage the database itself.
- An application base domain such as `apps.example.com`. Its containing Cloudflare zone may already exist or the installer can create it.
- A GitHub OAuth App for login. The installer prints the exact callback URL before asking for its client credentials.
- An R2 API token with Object Read & Write access. This is separate from the Cloudflare management API token and is used to sign direct asset uploads.

Workers for Platforms is a platform-level Cloudflare product. This requirement does not change native single-app deploys: ordinary `void deploy --platform cloudflare` apps remain Workers Free-compatible unless the app explicitly uses a paid-only product such as Containers.

### Runtime token permissions

The running platform needs these account permissions: Workers Scripts: Edit, Workers Tail: Read, D1: Edit, Workers KV Storage: Edit, Workers R2 Storage: Edit, Queues: Edit, and Account Analytics: Read. It also needs SSL and Certificates: Edit on the application zone.

The installer links to the account-token page and asks for the token in a masked prompt. Keep a copy in your secret manager for recovery.

## Preview the installation

Run the interactive installer with `--plan` first:

```sh
void platform install --plan
```

The plan shows the account, resource names, domains, and changes Void would make. It doesn't change Cloudflare resources. The API and resource proxy use `workers.dev` hostnames by default.

A preview uses an example suffix for resource names. Installation generates a fresh suffix and shows the final names before asking you to proceed.

For a repeatable non-interactive plan:

```sh
void platform install --plan \
  --name company \
  --display-name "Company Void" \
  --account 0123456789abcdef0123456789abcdef \
  --application-domain apps.example.com \
  --zone example.com
```

Commands that change the platform require `--yes` in a non-interactive shell. A preview with `--plan` doesn't need it.

Use `--control-plane-domain platform.example.net` when you want a custom API hostname. The hostname must be in a zone the selected account and token can manage. Omitting it keeps the control plane on `workers.dev` and avoids requiring another domain.

Use `--dedicated-zone` if the entire application zone belongs to Void. This adds catch-all routes for unmatched hostnames. For example, you could use a spare domain such as `example.app` as the whole zone, or `apps.example.com` within an existing company zone without the catch-all.

## Configure GitHub OAuth

Create a GitHub OAuth App using the final API URL the installer prints. A `--plan` preview may use a placeholder resource suffix, so wait for the actual installation URL before saving the callback:

- Homepage URL: the API origin, for example `https://void-company-api.example.workers.dev`
- Authorization callback URL: `<API origin>/auth/callback`

The installer asks for the app's client ID, client secret, and the GitHub username of the first administrator. That GitHub account becomes the first owner. Signup stays restricted until an administrator changes the access settings.

## Install

The interactive command asks for every missing value:

```sh
void platform install
```

For CI or another non-interactive shell, supply the configuration through environment variables. The example below uses placeholders; load the real values from your secret manager.

`CLOUDFLARE_API_TOKEN` authorizes the installation. `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` is the separate token the running platform will use.

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
  --zone example.com \
  --yes
```

The database must be dedicated to this installation. Its ownership claim and platform tables remain after uninstall because external PostgreSQL is never purged automatically. To reuse it for a different installation, explicitly remove the old platform schema and data yourself or provide a fresh database.

Before making changes, Void shows the full plan and asks for confirmation, with No selected by default. It saves progress locally and in Cloudflare so an interrupted install can resume.

Void records which resources belong to the installation. If it cannot prove that a resource is yours to manage, it stops and asks you to resolve the conflict.

If the requested zone does not exist, Void creates it and stops in a `waiting-for-dns` state. Update the domain at its registrar to use the printed Cloudflare nameservers, wait for the zone to become active, then resume:

```sh
void platform install --resume --name <installation-id>
```

For application traffic, Void creates one proxied wildcard DNS record at `*.application-domain` and the matching Worker routes. A compatible existing proxied record is adopted and is never deleted by Void.

## Managing Access

After installation, sign in with the GitHub account you chose as the first administrator:

```sh
void platform auth login
void platform signup allow github teammate
```

Void shows the proposed access change and asks you to confirm it. Once approved, `teammate` can connect to the platform's API URL and sign in with GitHub.

To see who can join, run `void platform signup show`. You can also allow an email address or a domain such as `*@example.com`. `void platform signup open` permits public signup; `void platform signup restrict` requires an allowlist match again.

Your administrator session lasts for one hour. Use it to inspect users, projects, logs, and platform health. The [Platform Administration guide](./platform-administration.md) walks through those workflows, previews, and automation. You can also open `<API origin>/admin/login` to use the browser admin UI.

## Cloudflare footprint

Resources use a `void-<installation-name>-<random-suffix>-*` prefix where Cloudflare allows names. This keeps installations recognizable and avoids predictable Worker names colliding during setup.

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

The API Worker uses four Durable Object classes for usage, cron scheduling, error monitoring, and concurrency. Worker bindings create the request and log datasets in Analytics Engine. The core installation doesn't create Container applications, a GitHub App, a dashboard Worker, or build Workers.

## Connect and deploy an app

The CLI selects your platform after installation. A developer, or an administrator on another workstation, can connect using its API URL:

```sh
void connect https://void-company-api.example.workers.dev
void project link
void deploy --platform void
```

`void connect` validates the platform and signs you in when needed. With no URL, it offers Cloudflare or a Void platform; `void connect --platform void` offers saved platforms and an option to enter another URL. New projects need a platform connection. Connecting elsewhere preserves an existing project link and explains which destination the project still uses.

In CI, use `void connect <url> --no-login` to register the platform, and supply `VOID_TOKEN` and `VOID_API_URL` for deployment. To verify authentication during connection, omit `--no-login` and set both variables to credentials for that same platform. Older project files already linked to Void Cloud continue to work.

Use these commands to inspect connections and installations:

```sh
void platform list
void platform use [id]
void platform status [id]
```

## Resume, repair, recover, and upgrade

You can omit an installation ID when only one is configured. With several installations, choose one interactively or pass its ID in CI.

### Resume an installation

If setup stops or fails, continue from the saved progress:

```sh
void platform install --resume --name <id>
```

You can correct the database URL if the initial connection failed. Once Void has claimed the database or provisioned Hyperdrive, that database is fixed for the installation. A later command with a different URL stops before making changes.

### Repair missing resources

Preview what needs repair, then apply it:

```sh
void platform repair [id] --plan
void platform repair [id]
```

Repair recreates missing resources that the installer owns. If an adopted or external resource is missing, restore it yourself before continuing. A disabled platform stays disabled through repair and upgrade.

### Upgrade the platform

Use the installed CLI's packaged runtime to upgrade:

```sh
void platform upgrade [id] --plan
void platform upgrade [id]
```

An upgrade validates the runtime, applies supported pending migrations, deploys the Workers, and checks their health. Existing Worker secrets are preserved.

Database migrations only move forward. Void checks that the live migration history matches the release's files and order. If migrations are pending, the release must explicitly support running the previous Worker version against the updated schema. Otherwise, upgrade stops and asks you to use an intermediate release.

Pending migrations run in one PostgreSQL transaction. If the Worker rollout fails, Void restores the previous Workers against that compatible schema. A retry recognizes migrations that already succeeded.

### Manage an installation from another machine

Use `discover` to restore the administrator's local installation records:

```sh
void platform discover --account <account-id> --installation <id-or-name>
```

Discovery checks the recorded resources and their ownership before saving local state. For an enabled installation, it also checks the live platform's identity. Interrupted or disabled installations can still be recovered when their endpoints are unavailable.

After discovery, provide `VOID_PLATFORM_DATABASE_URL` for migrations and to coordinate administrator commands. You don't need to re-enter the other secrets for a normal upgrade. If repair must recreate a missing API or proxy Worker, supply its original runtime token, GitHub, R2, JWT, and project-encryption secrets through the `VOID_PLATFORM_*` variables. Cloudflare can't return those values, so keep them in your organization's secret manager.

### Where local state lives

Installation records live in `~/.void/platforms/` and contain no credentials. Recovery secrets are encrypted with AES-256-GCM in `.recovery.enc` files. The encryption key lives in your operating system's keychain; on systems with POSIX permissions, recovery files are readable only by their owner. Older plaintext `.recovery` files are encrypted and removed on first read.

If the keychain isn't available, Void stops before writing secrets. Headless environments can supply `VOID_PLATFORM_RECOVERY_KEY`: a canonical base64-encoded 32-byte key from a secret manager. A temporary CI runner can use a new key for each run if its original credentials remain available in protected CI secrets.

::: details How recovery protects existing resources

Platform commands hold a PostgreSQL advisory lock so two administrators can't change the same installation at once. The database also stores the authoritative installation record; stale local or KV records cannot overwrite newer changes.

Before migrations or uploads, Void checks that Hyperdrive still points at the recorded database, including its scheme, host, port, database name, and user when Cloudflare provides it. The recorded fingerprint excludes the password. A changed origin stops the operation.

New, resumed, and previously disabled installations block user traffic before Worker uploads begin. Only the installer's health probes can pass until the complete runtime is verified. An interrupted or ambiguous upload leaves setup resumable with traffic blocked.

Void preserves manually attached routes and custom domains in both the new configuration and rollback state. R2 recovery checks the bucket's recorded creation identity before completing an interrupted ownership marker write. It won't overwrite a replacement bucket or another installation's marker.

:::

For local API and dashboard development, fork CI, and the source layout, see
[Platform Development](./platform-development.md).

## Continuously deploy a source build

Build `@void/platform` from your checkout and pass its runtime directory to `install`, `upgrade`, `repair`, or `enable` with `--runtime`. Custom runtimes get the same integrity, migration, health, and rollback checks as packaged releases.

Void records the runtime's manifest digest, whether it was packaged or custom, and the source revision when you set `VOID_PLATFORM_SOURCE_REVISION` during the build.

A fresh CI runner can discover the installation each time. Set `CLOUDFLARE_API_TOKEN` and `VOID_PLATFORM_DATABASE_URL` through its protected environment, then:

```sh
export VOID_PLATFORM_SOURCE_REVISION="$GITHUB_SHA"
vp run build

export VOID_PLATFORM_REGISTRY_DIR="$RUNNER_TEMP/void-platform-registry"
export VOID_PLATFORM_RECOVERY_KEY="$(openssl rand -base64 32)"
void platform discover --account "$CLOUDFLARE_ACCOUNT_ID" \
  --installation "$VOID_PLATFORM_INSTALLATION"
void platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --plan
void platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --yes
```

Omit the installation selector only if the account has one discoverable installation. Run one deployment per installation at a time, and let it finish before starting the next. Cancelling during migrations or Worker rollout can leave an installation waiting for recovery.

Keep the management token and database URL in a protected CI environment. Upgrades inherit deployed Worker secrets. Other original secrets are needed when recreating a missing Worker or explicitly rotating credentials.

## Disable and safely uninstall

To pause a platform without removing its data:

```sh
void platform disable [id] --plan
void platform disable [id]
```

Disabled platforms reject requests through a flag in their routing storage. Their domains and routes remain attached. Repair and upgrade preserve the disabled state; restore traffic with:

```sh
void platform enable [id] --plan
void platform enable [id]
```

Add `--yes` to commands that make changes in a non-interactive shell.

While disabled, the platform retries queue batches after five minutes instead of delivering them to apps. Queue retention and retry limits still apply. For a long pause, plan a dead-letter queue or another way to recover messages.

### Uninstall

Preview removal before applying it:

```sh
void platform uninstall [id] --plan
void platform uninstall [id]
```

Uninstall blocks platform traffic, removes transient Queues, and records the resources left for you to review. By default, Workers, KV, R2, Hyperdrive, the dispatch namespace, and AI Gateway remain in your account. Adopted resources, external PostgreSQL, zones, DNS records, routes, and custom domains are always retained.

To also remove eligible data resources owned by the installer:

```sh
void platform uninstall [id] --purge-data
```

Even with `--purge-data`, Void retains Workers, R2, AI Gateway, DNS records, routes, custom domains, adopted resources, external PostgreSQL, and zones. Review those in the Cloudflare dashboard if you want to remove them. The older `--delete-zone` flag is no longer supported.

::: details Why some resources require manual cleanup

Cloudflare can't make deletion of these resources conditional on the exact resource generation Void inspected. A resource could be replaced or repurposed between that inspection and deletion. Void leaves it in place and blocks platform traffic instead.

Before removal, Void verifies remote ownership and compares the installation record with a fresh resource inventory. Changed or missing ownership proof stops the operation. A retry skips work already completed, and the routing namespace is removed last when eligible.

A default uninstall keeps the final `uninstalled` record and disabled flag in the retained routing namespace. PostgreSQL's installation claim and tables also remain; uninstall never deletes the external database.

:::
