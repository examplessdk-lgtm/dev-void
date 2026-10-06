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
vp run build:platform
vp run check
vp test run
```

The normal Void Cloud deployment script deploys the proxy first, then applies PostgreSQL migrations and deploys the API, followed by the email gateway, tail, dispatch, and dashboard Workers. The first email rollout uses the separate order in [Configure the shared mail zone](#configure-the-shared-mail-zone). The API hosts the build scheduler and build-container Durable Objects. The optional dashboard uses the API for authentication and is deployed after the API it depends on.

The `deploy` and `deploy:staging` scripts in `platform/package.json` target these existing hosted environments. Forks should use `void platform upgrade --runtime` as described in [source deployment](../../docs/guide/platform/development/runtime.md#deploying-source-builds-from-ci).

### GitHub Actions

| Workflow                      | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `platform-ci.yml`             | Source validation and database schema compatibility checks   |
| `platform-deploy.yml`         | Production deployment from `prod`                            |
| `platform-deploy-staging.yml` | Staging deployment from `main`                               |
| `platform-smoke-test.yml`     | Deploy and exercise a disposable kitchen-sink app in staging |

These deployment and smoke-test workflows target Void Cloud, from `prod` for production or `main` for staging, with `VOID_PLATFORM_DEPLOY_ENABLED=true`. They use the `Prod` and `Staging` GitHub environments. Restrict those environments to the same refs and appropriate reviewers, and keep deployment credentials in environment secrets. Forks use their own source-runtime release workflow.

Both deploy workflows serialize deployments without cancelling an active rollout. Advancing `prod` requests a production deployment. A failed or interrupted deployment needs inspection before another rollout, particularly when database migrations already ran.

Hosted API and email gateway deploys report the release version from `packages/platform/package.json` as `PLATFORM_VERSION`. The `void` CLI refuses platforms older than its minimum platform version, so release in this order: advance `prod` and wait for the production deployment to succeed, then push the release tag that publishes the npm packages.

Consult the workflow files for their current inputs. Store credentials in the
selected GitHub environment and the deployment owner's secret manager. Keep
secret-manager locations, account access assignments and credential-issuance
procedures in that owner's private runbook.

## Hosted Worker Maintenance

Void Cloud operators can inspect the platform's six Workers and their versions:

```sh
void platform worker list
void platform worker show <proxy|email-gateway|tail|api|dashboard|dispatch>
void platform worker rollback <name> <version-id>
void platform worker rollback-all
void platform worker events [batch-id]
```

Each command accepts `--environment production|staging`. By default, it uses the platform's environment; `events <batch-id>` uses the batch's environment. Worker event lists accept `--page` and `--limit` when no batch ID is given. `worker list` always returns the fixed Worker inventory.

Choose a version from `worker show` for a single rollback. `rollback-all` selects the previous version of each Worker, shows those versions in its preview, and rolls them back in dependency order. A failure stops the remaining changes and reports which Workers succeeded, failed, or were skipped. Use `worker events <batch-id>` to inspect the result.

These commands are for Void Cloud's Workers. Self-hosted installations use the [platform lifecycle commands](../../docs/guide/platform/installation/maintenance.md#resume-repair-recover-and-upgrade).

## Secrets

Use separate credentials for CI deployment and platform runtime access. Runtime permissions cover tenant resource provisioning; the deploy credential also needs the permissions required to upload the configured Workers and build-container images.

Keep these values recoverable through the deployment owner's secret manager:

| Configuration                                                                         | Purpose                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`                                         | Runtime Cloudflare account and application-zone access          |
| `JWT_SECRET`                                                                          | API sessions and API/proxy platform authentication              |
| `EMAIL_SIGNING_SECRET`                                                                | Email request proofs, receipts, and confirmation tokens         |
| `PROJECT_SECRET_KEYS_JSON`, `PROJECT_SECRET_ACTIVE_KEY_VERSION`                       | Encryption of project secrets                                   |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                            | GitHub sign-in OAuth application                                |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                            | Google sign-in OAuth client                                     |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                            | Signed asset-upload URLs                                        |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` | GitHub deployment integration                                   |
| `GITHUB_WEBHOOK_INGRESS_SECRET`                                                       | Optional isolated webhook ingress-to-API proof                  |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`                                    | GitHub App user authorization for installation ownership checks |

The project-secret keyring is a JSON object mapping key versions to base64-encoded 32-byte keys. The active version must exist in that object. Preserve older keys while any stored secret still uses them; losing a key makes those secrets unreadable. Database backups alone do not contain the decryption keys.

The API and proxy share their JWT signing configuration. Change it as a coordinated operation because existing sessions and remote-binding clients depend on it. Email uses a separate signing secret shared by the API, proxy, and email gateway. Keep stable, distinct values for production and staging, and rotate each shared credential independently as a coordinated operation. Inspect the Worker bindings and application configuration before rotating either one.

## GitHub Deployment Integration

The GitHub App used to build connected repositories is separate from the OAuth application used for platform sign-in. Its repository permissions are Contents read, Metadata read, Pull requests read, and Checks write.

Subscribe to `push`, `installation`, `installation_repositories`, `pull_request`, `workflow_run`, `check_run`, and `check_suite`. The last two subscriptions deliver requests from GitHub's rerun buttons; granting Checks write alone does not enable those events. An API hostname protected by Access cannot receive these deliveries. Deploy the optional ingress described in [Platform Development](../../docs/guide/platform/development/runtime.md#optional-github-webhook-ingress-for-access-protected-apis) and set the App webhook URL to that environment's isolated `/github` endpoint. Keep `/webhooks/github` only for an API origin that is not Access-protected.

GitHub issues a PKCS#1 private key. The API expects PKCS#8:

```sh
openssl pkcs8 -topk8 -nocrypt -in github-app-pkcs1.pem -out github-app-pkcs8.pem
```

Container builds use the configured `BuildManager` or `BuildManagerLarge` class for the project's plan. GitHub Actions builds run in the repository's Actions environment and authenticate through `/auth/github-oidc`. Follow build logs with `void platform build logs <build-id> --follow`.

## Email

The dedicated email gateway receives inbound mail and dispatches bounded requests to tenant handlers. The proxy handles outbound sends and receipt verification. The API owns zone connections, exact domain assignments, policy, quota reservations, and durable operation and delivery records in PostgreSQL.

### Configure the shared mail zone

For a managed installation, provide `VOID_EMAIL_SENDER_DOMAIN` and `VOID_EMAIL_SHARED_ZONE_ID` during installation or upgrade. These values are recorded in the installation; routine upgrades preserve them. The installer supplies the platform account and gateway identity separately from the application zone.

For repository deployments, add the equivalent values to the selected `env.production.vars` or `env.staging.vars` blocks in the Workers' Wrangler configuration before enabling email. Do not rely on dashboard-only plain-text variables; the checked-in Wrangler files remain the deployment source of truth.

- API, proxy, and email gateway: the same `EMAIL_SENDER_DOMAIN`.
- API and email gateway: `EMAIL_SHARED_ACCOUNT_ID`, `EMAIL_SHARED_ZONE_ID`, and `EMAIL_SHARED_INGRESS_NAME`, identifying the platform account, mail zone, and dedicated gateway Worker.
- API: `EMAIL_GATEWAY_ORIGIN`, the gateway's HTTPS origin reachable from customer ingress Workers.
- API, proxy, and email gateway: the same installation `EMAIL_SIGNING_SECRET`; the API retains its separate `JWT_SECRET`, scoped runtime token, and project-encryption keys.

Store one stable, high-entropy `EMAIL_SIGNING_SECRET` in each deployment owner's secret manager and in the corresponding `Prod` or `Staging` GitHub environment. The hosted deployment preflight rejects a missing, short, or whitespace-padded value before database migrations or Worker changes. API, proxy, and gateway deployments upload the selected environment's value as an encrypted Worker secret, including when the gateway is created for the first time. Do not generate a new value for each deployment or put it in Wrangler `vars`.

For the first email rollout, configure and deploy the proxy and email gateway before adding the API's shared-email values. Verify both Workers, then add the API values and deploy the API so scheduled reconciliation cannot direct inbound mail at an unavailable gateway. From the repository root, the production sequence is:

```sh
vp run --filter @voidcloud/platform deploy:proxy
vp run --filter @voidcloud/platform deploy:email-gateway
vp run --filter @voidcloud/platform deploy:api
```

Use the corresponding `deploy:staging:*` commands for staging. After email is enabled and all three Workers exist, the normal platform deployment command can update them.

A dedicated-key cutover has no compatibility bridge to the previous JWT-backed email protocol. Provision the same environment-specific `EMAIL_SIGNING_SECRET` for all three deployments, keep inbound routing disabled, and complete the gateway, proxy, and API rollout before enabling email traffic. Preserve `JWT_SECRET` on the API and proxy: login sessions and non-email authentication still depend on it. After cutover, remove a previous gateway's `JWT_SECRET` binding because Worker deployments preserve existing secrets. If a rollout stops between Workers, leave routing disabled and resume with the same email signing value.

The API's scheduled reconciliation creates the shared connection and reserved shared-domain route only when the complete identity is configured. Confirm the resulting operation and inbound readiness before directing traffic to the gateway. Provision routing and Sending independently: a provider permission or plan refusal must remain visible in the corresponding readiness state. Sending to arbitrary recipients requires Cloudflare Email Sending onboarding and its supported plan.

Customer connections deploy one ingress Worker in the customer's account and zone. Shared and custom domain assignments can coexist on one zone. Setup proves the deployed ingress secret and the gateway's acceptance before changing the owned catch-all. Inspect foreign rules and preserve them; never repoint a catch-all simply because its Worker name resembles Void's.

### Deployment and recovery

Deploy the outbound proxy, API, and gateway before enabling inbound routing. The gateway must expose the new bounded email protocol, and tenant apps with handlers must be rebuilt and redeployed with its deployment metadata. The proxy no longer accepts inbound `/email/relay` requests or native email events.

Development installations using the previous email implementation need explicit
cleanup before setup: inspect their old relay Workers and credentials, detach
only catch-all rules still targeting those Workers, delete the obsolete Workers,
and revoke unused test grants in Cloudflare. Preserve unrelated rules and MX
records. The new reconciler does not migrate old `email_domains` records.

Inspect all three readiness states and the operation ID with `void email domain status <domain>`. Use `sync` to reconcile recoverable steps and `rotate-secret` for explicit ingress-secret rotation. An uncertain provider write remains blocked until its outcome can be proved; neither a timeout nor a missing cache entry authorizes another write. Never erase the operation to force a retry.

If read-back cannot prove whether a routing, Worker, secret, catch-all, or Sending
mutation applied, confirm that the original execution ended and wait at least 24
hours before using `void platform email operation-resolve`. Its preview identifies
the exact stored mutation. Record `applied` to continue without replaying it, or
`not-applied` to retry only that fenced intent. Keep the same platform version and
preserve staged secret state until the operation completes.

PostgreSQL is authoritative for consent, policy, suspension, and recipient-attempt quotas. Cache publication retries independently. `void email logs` exposes receipt and action metadata: provider acceptance is not proof of delivery, and an unknown result must not be retried with a new idempotency key. Removing one domain or project must preserve sibling routes and unresolved cleanup records.

Before production enablement, complete the [email acceptance checks](./release-acceptance.md#email-acceptance), including live Cloudflare routing, forwarding/reply, scoped-token, rotation, and failure-recovery checks.

## Staging Access Control

Void Cloud staging protects the API, dashboard, proxy, and app hostnames with Cloudflare Access. Configure user access in the identity provider and use a service-token pair for automation. Access credentials are separate from a Void user or administrator session.

The following callbacks must be reachable through their intended browser or machine flow:

- API `/auth/callback` and `/admin/callback`
- Dashboard `/auth/callback`
- API `/auth/github-oidc`
- Isolated GitHub ingress `/github`

Application code validates OAuth state and GitHub OIDC tokens on the API paths. The isolated ingress and API both validate the GitHub webhook signature, and the service-binding hop has its own short-lived proof. Do not add an Everyone or path-bypass policy to the API hostname.

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

## Documentation Site

The documentation site deploys from `main` through the Void GitHub App using the
`container` executor. The root [`void.config.ts`](../../void.config.ts) configures the monorepo
as a static project that builds `docs` and publishes `docs/.vitepress/dist`.
There is no documentation deploy workflow or `VOID_TOKEN` repository secret.

Connect the repository once with:

```sh
void github connect void-docs \
  --repo voidzero-dev/void \
  --branch main \
  --executor container
```

Release publishing still uses the `Release` GitHub environment with an
`NPM_TOKEN` secret via `.github/workflows/publish.yml`.

CI (`ci.yml`) runs on PRs to `main` and requires no secrets.
