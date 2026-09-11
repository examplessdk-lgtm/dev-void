---
outline: deep
---

# Deployment

Void apps run on Cloudflare's infrastructure but you don't need to use your own Cloudflare account. Our long term goal is to provide a simpler app-centric deployment experience similar to that of Vercel and Netlify. But right now, Void only supports deploying via the CLI or GitHub actions.

## CLI

### First deploy

```bash
void init   # choose Cloudflare (default), Void, or Skip deployment setup
void deploy # builds and deploys to the saved platform
```

`void init` stores the selection as `platform` in `.void/project.json`. Choosing Cloudflare creates or updates `wrangler.jsonc`, offers Wrangler login if necessary, and saves the selected Cloudflare `account_id`. Choosing Void continues into optional Void login and project linking. Choosing Skip stores `"platform": "none"`, and `void deploy` waits for an explicit `--platform cloudflare` or `--platform void` override.

### Migrations

If your app uses Drizzle, `void deploy` runs migrations as part of the deploy flow:

1. Build the app
2. Read SQL migrations from `db/migrations/`
3. Fail if the schema has drifted ahead of the committed migrations
4. Apply pending migrations to the target database
5. Make the new deploy live

Deploy always uses checked-in migration files. If drift is detected, run `void db generate`, review the generated migration, commit it yourself, then rerun deploy. For the full database workflow and backend-specific details, see the [Database guide](./database.md).

### Flags

```bash
void deploy [--platform <cloudflare|void>] [--project <name>] [--dir <path>] [--spa]
```

| Flag                            | Purpose                                           |
| ------------------------------- | ------------------------------------------------- |
| `--platform <cloudflare\|void>` | Override the saved deployment platform            |
| `--project <name>`              | Target a specific Void project by slug            |
| `--dir <path>`                  | Deploy a pre-built static directory (skips build) |
| `--spa`                         | Use SPA mode instead of SSG for static deploys    |

### Project resolution

After resolving the platform from the CLI override and then `.void/project.json`, the Void platform resolves its project in this order:

1. `--project <name>` flag
2. `VOID_PROJECT` environment variable
3. Linked project in `.void/project.json`

If none match, the CLI prompts interactively.

### CI preparation

If your CI pipeline runs typechecking or other static analysis before deploy, run `void prepare` after install to generate the `.void/` artifacts without booting Vite.

### Environment variables

| Variable       | Purpose                          |
| -------------- | -------------------------------- |
| `VOID_TOKEN`   | Auth token (for CI, skips OAuth) |
| `VOID_PROJECT` | Project slug override            |

## GitHub

You can deploy from a GitHub repo on every push to `main`. Running `void init --github` generates `.github/workflows/void-deploy.yml` in your project.

### Void GitHub App (recommended)

No `.github/workflows/void-deploy.yml` or repository `VOID_TOKEN` is required.

1. Initialize your Void project

```bash
void init
# Or, for existing Void project:
void project link
```

2. Install the Void GitHub app

```bash
void github install
```

You should receive GitHub url asking you to install and authorize `Void Deploy`.

In the browser, select the GitHub account/organization and grant access to the repository.

:::details If someone already installed the App for your organization
Join that installation instead:

```bash
void github join
```

:::

3. Link your repository to your project

```bash
void github connect --executor container
```

4. Verify the connection

```bash
void github status
```

You should receive an output like:

```bash
Repository      <owner/repository>
Branch          main
Build executor  container
Deploy workflow .github/workflows/void-deploy.yml (unused for container builds)

```

5. Push to the configured branch to trigger a new deploy

```bash
git push origin main
```

6. Follow the build

```bash
void build logs --follow
```

### GitHub Actions

The workflow authenticates with [GitHub OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect) — there is **no long-lived `VOID_TOKEN` secret to store or rotate**. `void deploy` detects GitHub Actions and does the exchange itself: it requests a short-lived OIDC token from GitHub (audience `void`), exchanges it at `POST $VOID_API_URL/auth/github-oidc` for a short-lived project-scoped deploy token (about 15 minutes on the free tier; longer on higher plans, capped at ~60 minutes), and deploys — so the workflow is a single `void deploy` step. `permissions: id-token: write` is still required: it is what lets the job (and the CLI) mint the OIDC token.

```yaml
name: Deploy to Void
on:
  push:
    branches: [main]

# Latest push wins: a newer commit cancels an in-flight deploy for the same
# repo + branch, so an older commit can never overtake a newer one.
concurrency:
  group: void-deploy-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  id-token: write
  contents: read

env:
  VOID_API_URL: ${{ vars.VOID_API_URL || 'https://api.void.cloud' }}
  VOID_PROJECT: my-app

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: npm
      - run: npm ci
      - name: Deploy
        run: npx void deploy --platform void --project "$VOID_PROJECT"
```

Connect the repository to your project once with `void github connect <project> --repo <owner/repo> --executor github_actions` to authorize it. This GitHub Actions path requires the `github_actions` build executor — the default `container` executor will not work with this workflow. The exact steps vary by package manager (the scaffold detects pnpm, yarn, bun, or npm). The `VOID_PROJECT` value is baked in from your linked project when known; otherwise the workflow reads a `VOID_PROJECT` repository variable. To target staging, set a `VOID_API_URL` repository variable to `https://api.staging.void.cloud`.

::: info External databases on direct Cloudflare deploys
PostgreSQL and MySQL projects use the shell-provided production `DATABASE_URL` to provision Hyperdrive and apply checked-in migrations before upload. The URL is not written to generated config. PostgreSQL migrations are transactional; MySQL DDL may partially apply on failure.
:::

## Other Targets

To deploy directly to your own Cloudflare account, select Cloudflare during `void init` or run `void deploy --platform cloudflare`. Void automatically creates or adopts the D1/KV/R2/Queues/Hyperdrive resources your app needs, then continues the deploy. Keys explicitly marked `.secret()` in `env.ts` are removed from plaintext Worker vars and uploaded through Cloudflare's encrypted secret mechanism; production values may come from `.env`, `.env.production`, `.env.production.local`, or the deploy process environment. PostgreSQL apps use a production `DATABASE_URL` from the shell to provision Hyperdrive and apply checked-in migrations transactionally before the Worker upload; the URL is never written to the generated config. For auth-enabled apps Void preserves an existing remote `BETTER_AUTH_SECRET`, or creates and stores one once when missing. This uses your local wrangler auth and root `wrangler.jsonc` -- pin an account (`account_id` or `CLOUDFLARE_ACCOUNT_ID`). `wrangler login` is enough to authenticate, with one exception: provisioning a **Hyperdrive** config for the first time needs `CLOUDFLARE_API_TOKEN`, because wrangler exposes no machine-readable Hyperdrive list for Void to check against (an already-provisioned Hyperdrive app deploys fine under `wrangler login`). In v1 it deploys **full Void apps on the Cloudflare Workers target** (D1/KV/R2/Queues/Hyperdrive, typed SQLite-backed Durable State, auth, and ISR); framework SSR (TanStack Start, React Router, vinext, SvelteKit, Nuxt, Analog, Astro), static/SPA/SSG apps (including `output: "static"`), legacy key-value-backed WebSocket routes (`*.ws.ts`), a custom `migrations_pattern`, `--skip-build`, and `node`/`bun`/`deno` targets fail closed with guidance. For auth apps, run `void db generate`; it automatically includes the production Better Auth schema, and deploy validates and applies the checked-in migration. Avoid concurrent first deploys from different machines or CI runners because the provisioning lock is local to one config path. See the [Cloudflare integration guide](../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account) for the full walk-through and scope.

To deploy to Node.js, Bun, or Deno instead of Cloudflare, set [`target`](../reference/config.md) in `void.json`. This builds a standalone server you can run anywhere, including Docker, Railway, and Fly.io. These targets do not have access to Void platform features such as D1, KV, R2, built-in auth, Workers AI, or cron scheduling. See the [Node.js, Bun, and Deno guide](../integrations/nodejs-bun-deno.md).
