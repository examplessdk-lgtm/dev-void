# Void Cloud Operations

This note describes the maintained Void Cloud deployment. A fork runs its own platform through [Self-host a Void Platform](../../docs/guide/self-hosted-platform.md). Use [Platform Administration](../../docs/guide/platform-administration.md) for access control, users, projects, logs, and health checks.

Void Cloud's existing environments predate the installer. Their resources are managed by the checked-in Wrangler configurations and the workflows below. Do not adopt those resources with `void platform install`; the installer manages resources recorded as belonging to a self-hosted installation.

## Environments

| Environment | API                              | Dashboard                         | App domains          |
| ----------- | -------------------------------- | --------------------------------- | -------------------- |
| Production  | `https://api.void.cloud`         | `https://dash.void.cloud`         | `*.void.app`         |
| Staging     | `https://api.staging.void.cloud` | `https://dash.staging.void.cloud` | `*.staging.void.app` |

Each environment has a separate PostgreSQL database, Hyperdrive configuration, dispatch namespace, KV namespaces, R2 buckets, usage queue, and Analytics Engine datasets. Read the corresponding `env.production` or `env.staging` sections in each package's Wrangler configuration for the current resource bindings. Keep credentials and access assignments in the deployment owner's secret manager and identity provider.

## Deployments

Run the source checks before deployment. From the repository root:

```sh
vp run build
vp run --filter './platform/packages/**' build
vp run check
vp test run
```

Void Cloud deploys the API after PostgreSQL migrations, then the proxy, tail, dispatch, and dashboard Workers. The API hosts the build scheduler and build-container Durable Objects. The optional dashboard uses the API for authentication and is deployed after the API it depends on.

The `deploy` and `deploy:staging` scripts in `platform/package.json` target these existing hosted environments. Forks should use `void platform upgrade --runtime` as described in [source deployment](../../docs/guide/platform-development.md#source-build-ci).

### GitHub Actions

| Workflow                      | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `platform-ci.yml`             | Source validation and database schema compatibility checks   |
| `platform-deploy.yml`         | Production deployment from `prod`                            |
| `platform-deploy-staging.yml` | Staging deployment from `main`                               |
| `platform-smoke-test.yml`     | Deploy and exercise a disposable kitchen-sink app in staging |

These deployment and smoke-test workflows target Void Cloud, from `prod` for production or `main` for staging, with `VOID_PLATFORM_DEPLOY_ENABLED=true`. They use the `Prod` and `Staging` GitHub environments. Restrict those environments to the same refs and appropriate reviewers, and keep deployment credentials in environment secrets. Forks use their own source-runtime release workflow.

Both deploy workflows serialize deployments without cancelling an active rollout. Advancing `prod` requests a production deployment. A failed or interrupted deployment needs inspection before another rollout, particularly when database migrations already ran.

Consult the workflow files for their current inputs. Store credentials in the
selected GitHub environment and the deployment owner's secret manager. Keep
secret-manager locations, account access assignments and credential-issuance
procedures in that owner's private runbook.

## Hosted Worker Maintenance

Void Cloud operators can inspect the platform's five Workers and their versions:

```sh
void platform worker list
void platform worker show <proxy|tail|api|dashboard|dispatch>
void platform worker rollback <name> <version-id>
void platform worker rollback-all
void platform worker events [batch-id]
```

Each command accepts `--environment production|staging`. By default, it uses the platform's environment; `events <batch-id>` uses the batch's environment. Worker event lists accept `--page` and `--limit` when no batch ID is given. `worker list` always returns the fixed Worker inventory.

Choose a version from `worker show` for a single rollback. `rollback-all` selects the previous version of each Worker, shows those versions in its preview, and rolls them back in dependency order. A failure stops the remaining changes and reports which Workers succeeded, failed, or were skipped. Use `worker events <batch-id>` to inspect the result.

These commands are for Void Cloud's Workers. Self-hosted installations use the [platform lifecycle commands](../../docs/guide/self-hosted-platform.md#resume-repair-recover-and-upgrade).

## Secrets

Use separate credentials for CI deployment and platform runtime access. Runtime permissions cover tenant resource provisioning; the deploy credential also needs the permissions required to upload the configured Workers and build-container images.

Keep these values recoverable through the deployment owner's secret manager:

| Configuration                                                                         | Purpose                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`                                         | Runtime Cloudflare account and application-zone access          |
| `JWT_SECRET`                                                                          | API and proxy authentication                                    |
| `PROJECT_SECRET_KEYS_JSON`, `PROJECT_SECRET_ACTIVE_KEY_VERSION`                       | Encryption of project secrets                                   |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                            | GitHub sign-in OAuth application                                |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                            | Google sign-in OAuth client                                     |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                            | Signed asset-upload URLs                                        |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` | GitHub deployment integration                                   |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`                                    | GitHub App user authorization for installation ownership checks |

The project-secret keyring is a JSON object mapping key versions to base64-encoded 32-byte keys. The active version must exist in that object. Preserve older keys while any stored secret still uses them; losing a key makes those secrets unreadable. Database backups alone do not contain the decryption keys.

The API and proxy share their JWT signing configuration. Change it as a coordinated operation because existing sessions and remote-binding clients depend on it. Inspect the Worker bindings and application configuration before rotating any shared credential.

## GitHub Deployment Integration

The GitHub App used to build connected repositories is separate from the OAuth application used for platform sign-in. Its repository permissions are Contents read, Metadata read, Pull requests read, and Checks write.

Subscribe to `push`, `installation`, `installation_repositories`, `pull_request`, `workflow_run`, `check_run`, and `check_suite`. The last two subscriptions deliver requests from GitHub's rerun buttons; granting Checks write alone does not enable those events. Set each App's webhook URL to its environment's `/webhooks/github` endpoint.

GitHub issues a PKCS#1 private key. The API expects PKCS#8:

```sh
openssl pkcs8 -topk8 -nocrypt -in github-app-pkcs1.pem -out github-app-pkcs8.pem
```

Container builds use the configured `BuildManager` or `BuildManagerLarge` class for the project's plan. GitHub Actions builds run in the repository's Actions environment and authenticate through `/auth/github-oidc`. Follow build logs with `void platform build logs <build-id> --follow`.

## Email

Every project sends as `<slug>[+tag]@<mail domain>` and receives at `<slug>+anything@<mail domain>` through one shared mail facility; there is no per-project DNS work. The mail domain is the `EMAIL_SENDER_DOMAIN` var on the API and proxy Workers, handed to deployed user Workers as `__VOID_EMAIL_DOMAIN`. The two Worker values must match: the proxy validates every sender against its own copy, so a mismatch fails the API's own verification mail with `INVALID_FROM`. Every reader fails closed when the var is absent. Void Cloud uses `mail.void.cloud` and `mail.staging.void.cloud`, both subdomains of the `void.cloud` zone.

### One-time zone setup, per environment

Do these in order; step 4 before step 5, or the catch-all points at a Worker with no `email()` export.

1. Extend `CF_API_TOKEN` with Email Routing: Edit. Without it every destination add returns 403, which the CLI reports as a 502 and the owner auto-add on project creation swallows.
2. Add the subdomain to Email Routing (dashboard: Email → Email Routing → the zone → Settings → Subdomains). Cloudflare adds and locks the MX, SPF, and DKIM records. The two-label staging name is unverified against this form.
3. Onboard the same name to Email Sending (dashboard, or `wrangler email sending enable <domain>`). Without it the binding sends only to verified destination addresses, capped at 200 per account across every project. Requires Workers Paid.
4. Deploy the proxy with `send_email` bound and the `email()` export live. Check the top level, `env.production`, and `env.staging` of `platform/packages/proxy/wrangler.jsonc`; Wrangler does not inherit `send_email` into a named env.
5. Create the catch-all rule on the subdomain: action _Send to a Worker_, destination the proxy Worker (`PUT /zones/{zone}/email/routing/rules/catch_all` with `{ "type": "worker", "value": ["void-proxy"] }`). Wrangler has no catch-all command and its `addresses` array cannot write it. This rule is the inbound kill switch. Leave the zone's subaddressing setting alone; the catch-all takes every address on the subdomain.
6. The slug mirror (`email-slug:<projectId>` in `ROUTING` KV) is written on project creation and rewritten hourly by the rollover, so projects that predate the feature are covered within an hour of the API deploy.
7. Verify with the proxy tail and a message to `<test-slug>+test@<mail domain>`. Outbound sent through the binding shows as dropped in the Email Routing summary even when delivered; read Email Sending metrics instead.

### Deploy order and rollback

Deploy the proxy before the API: the API's verification mail posts to the proxy's `/email/internal/send`. `vp run deploy` runs the API first, so run the two as explicit steps for the release that turns email on. To stop inbound, delete the catch-all rule; to stop outbound, redeploy the proxy without `send_email`.

Two server-side changes are retroactive. Before the first API deploy that carries them, query `project_secrets.name IN ('SEND_EMAIL', '__VOID_EMAIL_DOMAIN', '__VOID_PROJECT_SLUG')` — those are now reserved binding names and a project holding one fails deploys — and check for projects already holding the reserved slugs `noreply`, `postmaster`, `abuse`, `bounce`, and `security`.

## Staging Access Control

Void Cloud staging protects the API, dashboard, proxy, and app hostnames with Cloudflare Access. Configure user access in the identity provider and use a service-token pair for automation. Access credentials are separate from a Void user or administrator session.

The following callbacks must be reachable by the sign-in providers and GitHub:

- API `/auth/callback` and `/admin/callback`
- Dashboard `/auth/callback`
- API `/webhooks/github` and `/auth/github-oidc`

Application code validates OAuth state, webhook signatures, and GitHub OIDC tokens on these paths. Check each callback's validation before changing an Access bypass policy.

For interactive staging development, install `cloudflared`. The CLI can open the browser sign-in flow for Void Cloud staging and reuse its cached Access session. To sign in manually:

```sh
cloudflared access login https://api.staging.void.cloud
```

Automation uses `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The staging API receives them as `CF_ACCESS_CLIENT_ID_STAGING` and `CF_ACCESS_CLIENT_SECRET_STAGING` so trusted build deployment steps can reach the staging API. Rotate the Access credential, protected-environment secrets, and API Worker secrets together. Update any other automation using the old pair.

These CLI Access helpers recognize Void Cloud staging hosts. They are not a general Access configuration mechanism for a self-hosted platform. The dashboard's source-development helper supports an explicit API origin; see [Platform Development](../../docs/guide/platform-development.md).

## Health and Smoke Tests

Select the environment explicitly and use an administrator session:

```sh
void platform system health --connection https://api.staging.void.cloud
```

`vp run --filter @voidcloud/platform health` runs the same operator health command against the selected connection. It requires a built SDK and `void platform auth login` or `VOID_OPERATOR_TOKEN`. The `health:staging` shortcut explicitly selects Void Cloud staging.

The [kitchen-sink smoke checklist](../scripts/kitchen-sink-smoke-test.md) works with a disposable deployment on any platform. Its automated script requires `SMOKE_URL` and resets that app's data. The hosted smoke-test workflow provides the staging URL explicitly.
