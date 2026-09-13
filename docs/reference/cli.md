---
outline: deep
---

# CLI

`void` is a local binary from the installed `void` package.

Use this page as a command reference. If you are setting up a project for the first time, start with [Quickstart](../guide/quickstart.md) and come back here when you need exact command behavior or flags.

## Cheat Sheet

| Command                           | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `void deploy`                     | Build and deploy to the configured platform                                   |
| `void prepare`                    | Generate `.void` artifacts without starting Vite                              |
| `void gen model <name> [cols...]` | Scaffold migration + CRUD routes                                              |
| `void gen route <path>`           | Create an API route                                                           |
| `void db push`                    | Apply schema directly without migration files                                 |
| `void db generate`                | Generate SQL migrations from schema changes                                   |
| `void db status`                  | Show local/remote migration status                                            |
| `void db reset`                   | Drop and re-apply all migrations                                              |
| `void db seed`                    | Reset + seed local database                                                   |
| `void db execute <sql>`           | Run SQL against the database (--remote for deployed)                          |
| `void db studio`                  | Open Drizzle Studio (--remote for a deployed external database)               |
| `void secret put <name=value>`    | Set a production secret                                                       |
| `void secret list`                | List production secrets                                                       |
| `void secret sync .env.local`     | Bulk upload secrets from dotenv file                                          |
| `void env check [--remote]`       | Validate env.ts schema                                                        |
| `void env types`                  | Regenerate .void/env.d.ts from env.ts                                         |
| `void env example`                | Refresh the void-managed block in .env.example                                |
| `void auth login`                 | Authenticate with Void                                                        |
| `void project link`               | Link directory to a project                                                   |
| `void project logs`               | Show runtime logs from deployed project                                       |
| `void project requests`           | Show request-level traffic (status, method, timing)                           |
| `void project rollback`           | Roll back to a previous deployment                                            |
| `void project cancel`             | Cancel an active deployment                                                   |
| `void project purge-cache`        | Purge all cached pages                                                        |
| `void build logs`                 | Stream, tail, or download build logs                                          |
| `void email status`               | Show email readiness on your own Cloudflare account (`--platform cloudflare`) |
| `void email setup`                | Set email up on your own Cloudflare account, without deploying                |
| `void email usage`                | Show monthly email send/receive counts and quota                              |
| `void email logs`                 | Show recent email delivery activity                                           |
| `void email destinations`         | List verified recipient addresses                                             |
| `void email allow <address>`      | Add a recipient and send a verification email                                 |
| `void email disallow <address>`   | Remove a recipient from the allowlist                                         |
| `void mcp`                        | Start the Void MCP server                                                     |
| `void init`                       | Setup wizard for new or existing projects                                     |

## Binary Invocation

Outside npm scripts, invoke `void` with `npx`, `pnpm`, `yarn`, or `bunx`. For readability, the docs show unprefixed `void` commands. In practice, you still need a binary runner unless the executable is already on your `PATH`.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `void` directly when you are in the root directory of your app.

:::warning ⚠️ Prefer local install
We do not recommend installing `void` globally, because the CLI needs to be in sync with same version of the runtime framework. Always install `void` locally as a dev dependency of your project.
:::

## Help

```
void --help
void help
void help <command>
void help <group> <command>
void <command> --help
void <group> <command> --help
void <group> help <command>
```

Use `void --help` or `void help` for the top-level command list. Every command and grouped subcommand has a focused help page, so `void deploy --help`, `void help db execute`, and `void db help execute` all print command-specific usage before any command validation or network/auth work runs.

## Setup

### `void init`

```
void init [--tsconfig] [--github] [--agents]
```

Setup wizard for Void projects (new or existing).

If run in a scaffoldable empty directory, `void init` scaffolds a Pages starter. It asks which scaffold toolchain to use, with Vite+ as the default top option and plain Vite as the alternative. If a single Pages adapter is already installed, it reuses that framework; otherwise it asks which framework to scaffold (React, Vue, Svelte, or Solid). It then asks which starter you want: D1, PostgreSQL, MySQL, or Static Pages. The database-backed starters write a framework-specific `vite.config.ts`, a `pages/` home page plus `.server.ts` loader, `db/schema.ts`, `db/seed.ts`, a generated initial migration under `db/migrations/`, and `routes/api/hello.ts`. The Static Pages starter writes just the framework-specific `vite.config.ts` and a `pages/` home page so you can add server features later. Vite+ starters add `vite-plus` and use `vp dev`, `vp build`, and `vp preview` scripts.

If run in a non-empty folder that does not look like an app yet, such as a parent `Projects/` folder with subdirectories but no `package.json`, `void init` asks whether to create a new subfolder or continue in the current folder. Creating a subfolder is the default selection.

If run in an existing project, `void init` configures the project in place: it ensures `void` and `vite` are declared, adds missing `dev` (`vite`) and `build` (`vite build`) scripts without overwriting existing scripts, and creates or patches `vite.config.*` with `voidPlugin()` when the config shape is safe to edit. If the Vite config is too dynamic to patch confidently, it prints the manual snippet instead of rewriting it.

After that, the full interactive flow walks through:

1. **TypeScript:** creates or updates `tsconfig.json`, including `extends .void/tsconfig.json`, `void/env` types, and root-level `files` / `compilerOptions.paths` merges when an existing config would otherwise replace Void's generated entries.
2. **Database:** asks whether you want D1, PostgreSQL, MySQL, or no database yet. PostgreSQL writes `"database": "pg"`; MySQL writes `"database": "mysql"`; D1 stays implicit.
3. **Agent instructions:** detects agents once and injects instructions into `CLAUDE.md` or `AGENTS.md`.
4. **Skills:** links Void skills using the same detected or selected agent context.
5. **Demo code:** for existing non-Pages projects, optionally scaffolds a `db/migrations/` directory plus an API route and typed fetch example.
6. **Deployment platform:** asks where `void deploy` should send the app: Cloudflare (the default), Void, or Skip deployment setup. The choice is stored as `platform` in `.void/project.json`. Choosing Cloudflare creates or augments `wrangler.jsonc`, checks `wrangler whoami`, offers to run `wrangler login` when needed, and writes the selected account as `account_id` (automatically when Wrangler returns only one account).
7. **GitHub Actions:** optionally creates `.github/workflows/void-deploy.yml` for the selected target. Cloudflare workflows run `void deploy --platform cloudflare` with `CLOUDFLARE_API_TOKEN` and pass the optional `DATABASE_URL` secret needed by PostgreSQL/MySQL apps; Void workflows run `void deploy --platform void` through GitHub OIDC.
8. **`env.ts` scaffold:** if the project has no `env.ts` but has `.env` / `.env.example` / `.env.local` / `.env.development*` files on disk, generates an `env.ts` pre-populated with their keys. Values get conservative type inference (`boolean`/`url`/`number`/`string`) — the file carries a banner nudging you to tighten anything the heuristic got wrong.
9. **Void project setup:** when Void is selected, optionally logs you in, lets you select or create a project, and adds the link to `.void/project.json` so your first deploy can just be `void deploy`.

If Cloudflare login is declined or does not complete, initialization still finishes with the Wrangler config in place. Run `wrangler login` and then rerun `void init` to select and save the account.

If no agent is detected, `void init` asks you to choose one from a short list (Claude, Cursor, Codex, Gemini CLI, Generic). That single choice is reused across all agent steps.

Use flags to run individual steps without prompts:

| Flag         | Purpose                                        |
| ------------ | ---------------------------------------------- |
| `--tsconfig` | Only update `tsconfig.json`                    |
| `--agents`   | Set up agent instructions and skills           |
| `--github`   | Only create the GitHub Actions deploy workflow |

Flags can be combined. When any flag is provided, only the specified steps run and interactive prompts are skipped.

For a saved Cloudflare target, the `--github` workflow requires a `CLOUDFLARE_API_TOKEN` repository secret scoped to the pinned account and the Worker/resource permissions the app needs. PostgreSQL/MySQL apps must also configure `DATABASE_URL` as a repository secret; SQLite and database-free apps may leave it unset. For a saved Void target, the workflow uses GitHub OIDC: connect the repository once with `void github connect <project> --repo <owner/repo> --executor github_actions` (see the GitHub section below), and pushes to `main` deploy automatically. There is no `VOID_TOKEN` secret to create or rotate. To target Void staging, set a `VOID_API_URL` repository variable to `https://api.staging.void.cloud`.

For projects that already have `"extends"`, `void init --tsconfig` preserves the existing config and adds `./.void/tsconfig.json`. If the existing config defines `files` or `compilerOptions.paths`, Void also merges its generated declaration files and aliases into the root config because TypeScript replaces those fields across `extends` instead of deeply merging them.

### `void prepare`

```
void prepare
```

Generates the project-local `.void/` artifacts used by TypeScript and runtime codegen without starting `vite dev` or running a full `vite build`.

This is the intended command for CI, fresh clones, editor bootstrap, and any workflow that needs `routes.d.ts`, `db.d.ts`, `queues.d.ts`, `env.d.ts`, and `.void/tsconfig.json` in place before typechecking.

## Auth

### `void auth login`

OAuth login. You choose GitHub or Google at the prompt, and the token is saved to `~/.void/config.json`.

This is optional if you already completed auth during the interactive `void init` flow.

### `void auth logout`

Removes saved credentials.

### `void auth whoami`

Prints your current login.

### `void auth token`

Copies your auth token to the system clipboard. Useful for setting up CI secrets.

## Project commands

### `void project status [name]`

Show deployments for the configured target.

- Void targets show recent hosted deployments; `[name]` looks up a project by slug and otherwise the linked project is used.
- Cloudflare targets list Worker Versions, identify the active version, and show the recorded migration count. A project name is not accepted because the Worker name comes from root `wrangler.jsonc`.

### `void project link [name]`

Link current directory to an existing hosted Void project by slug, or select interactively if omitted. State is stored in `.void/project.json`. Direct Cloudflare apps use the root Wrangler worker name and do not need linking.

### `void project list`

List all hosted projects (slug, mode, URL). For a saved Cloudflare target, this displays the current Worker's versions instead because there is no Void project registry.

### `void project logs`

```
void project logs [--level <level>] [--filter <text>] [--range <duration>] [--deployment <id>]
```

Show runtime logs from the deployed target. Hosted Void targets query retained log history. Cloudflare targets open a live Wrangler tail for the Worker named in root `wrangler.jsonc`; they do not provide historical log storage.

| Flag                 | Purpose                                                                                                                                                                                                         | Default |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                                                                                                                                                 | `1h`    |
| `--level <level>`    | Filter by log level. One of `error`, `warn`, `info`, `log`, `debug`, `all`. `error` also includes uncaught exceptions, non-`ok` outcomes, and any 5xx response — even when the worker neither threw nor logged. | `all`   |
| `--filter <text>`    | Case-insensitive **substring** match against log message text and exception name/message — not a level filter. Shows the full request entry on any hit.                                                         | none    |
| `--deployment <id>`  | Filter logs to a specific deployment ID.                                                                                                                                                                        | none    |

Output shows one line per request (`HH:MM:SS METHOD URL STATUS`) with indented console log and exception lines beneath. Errors and exceptions are colored red, warnings yellow.

Examples:

```
void project logs --level error --range 12h
void project logs --level error --filter websocket
```

Tip: `void project logs` only sees what Cloudflare Tail captures — top-level `console.*` calls and uncaught throws. Application errors caught and persisted to your own DB are invisible to tail. Surface them via `console.error(...)` or `void/log`'s `logger.error(...)` so they show up under `--level error`. For 5xx that never reach your worker at all (edge-router errors, static/SPA projects), use `void project requests --status 5xx`.

On a direct Cloudflare target, `--filter` becomes Wrangler's live search, `--deployment` selects a Worker Version, and `--level error` selects error invocations. Other individual console levels cannot be filtered, and `--range` does not select history. `void project requests` is hosted-only.

### `void project requests`

```
void project requests [--status <filter>] [--range <duration>]
```

Show request-level traffic recorded at the edge for the linked project: one line per request with time, method, HTTP status, request type, and server timing. Unlike `void project logs` (which only has rows for invoked user workers), this reads the edge request-metering data, so it also surfaces:

- **5xx the edge router generated itself** — missing deployment manifest, static-asset read timeouts, SSR dispatch timeouts — which never invoke your worker and so never appear in logs.
- **Requests to static/SPA projects**, which are served directly from storage and never run a worker.

| Flag                 | Purpose                                                                                       | Default |
| -------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `--status <filter>`  | Filter by status: a class (`2xx`, `3xx`, `4xx`, `5xx`) or an exact 3-digit code (e.g. `500`). | none    |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                               | `1h`    |

Output shows one line per request (`HH:MM:SS METHOD STATUS TYPE DURATION`). 5xx are colored red, 4xx yellow. Note: request paths are not recorded, so this view shows status and type rather than URLs — use `void project logs` for per-URL, per-log detail on requests that do reach your worker.

Examples:

```
void project requests --status 5xx
void project requests --range 24h
```

### `void project rollback [deployId]`

```
void project rollback [deployId]
```

Roll back to a previous deployment or Worker Version.

- If `[deployId]` is omitted, shows an interactive select menu of retained deployments
- If the target deployment has fewer applied migrations than the current one, a warning is shown listing the migration diff before confirmation

On the hosted platform, only **retained** deployments can be selected. On Cloudflare, the argument is a complete or unambiguous prefix of a Worker Version id. Void activates that immutable version at 100% and restores the schedules, queue consumers, workflows, routes, and custom domains captured in its trigger snapshot. Versions created before trigger snapshots are rejected because Cloudflare stores those triggers outside the immutable Worker Version and Void cannot reconstruct them safely. Database migrations remain forward-only: when the target version recorded fewer migrations, or either version lacks Void migration metadata, the CLI warns and asks for confirmation because the older code will run against the current schema.

### `void project cancel [deployId]`

```
void project cancel [deployId]
```

Cancel an active deployment.

- If `[deployId]` is omitted, shows an interactive select menu of active deployments for the linked project
- If `[deployId]` is provided, cancels that deployment directly

This command is hosted-only. Direct Cloudflare deploys are local operations and do not expose a remote build to cancel.

### `void project delete [name]`

Permanently delete a hosted Void project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

For direct Cloudflare targets this command refuses to run. Inferred resources can be shared, so Void never performs automatic teardown; verify ownership and remove resources explicitly with Cloudflare tooling.

### `void project purge-cache`

```
void project purge-cache [--project <name>]
```

Purge all cached pages for the linked project. The edge cache will clear within seconds.

If `--project` is provided, purges that project's cache instead of the linked project.

This command is currently hosted-only. Direct Cloudflare cache purge fails closed with guidance.

## Deploy

### `void deploy`

```
void deploy [--project <name>] [--dir <path>] [--spa] [--skip-build] [--debug]
void deploy [--platform <cloudflare|void>] [--require-email]
```

Auto-detects your project type and chooses the right pipeline. See [Supported App Types](../guide/app-types.md) and [Deployment](../guide/deployment.md) for details.

For Drizzle projects, deploy performs a read-only schema drift check. If a new migration would be generated, deploy stops and tells you to run `void db generate`, review the migration, commit it yourself, and rerun `void deploy`.

| Flag                            | Purpose                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--platform <cloudflare\|void>` | Override the platform stored in `.void/project.json`                                               |
| `--project <name>`              | Target a specific Void project by slug; not supported with `--platform cloudflare`                 |
| `--dir <path>`                  | Deploy a pre-built static directory (skips build)                                                  |
| `--spa`                         | Use SPA mode instead of SSG for static deploys                                                     |
| `--skip-build`                  | Skip the build step; on Cloudflare this is supported for static/SPA/SSG deploys only               |
| `--require-email`               | Fail when email cannot be set up instead of deploying without it; requires `--platform cloudflare` |
| `--debug`                       | Mirror the structured deploy log to stderr (also written to `~/.void/logs/`)                       |

The older `--backend cloudflare` spelling remains available as a compatibility alias for `--platform cloudflare`.

Every deploy writes a structured JSONL trace to `~/.void/logs/deploy-<timestamp>.jsonl` regardless of `--debug`. On failure the path is printed at the end of the error message so you can attach it when reporting platform issues. `VOID_DEPLOY_DEBUG=1` is accepted as an alternate trigger for stderr mirroring.

When a deploy fails after it starts, the CLI also prints a summary of that trace under the error, so the cause is visible where the file is not — a CI runner, for example, is discarded with the job. The summary has two blocks: every `error` record with its flattened cause chain, then the last 20 records as a timeline.

Pre-flight failures print no summary. A missing project, a rejected flag combination, or an unsupported `--platform cloudflare` feature stops before any trace exists, and each of those prints its own message explaining what to change. A build failure prints no summary either — the build streams its own output straight to the terminal.

Void masks the credentials it emits itself: signed query parameters, bearer tokens, and any field whose key names a credential.

Masking your own values is left to your CI platform, which holds the secrets and masks them before the log is written. GitHub Actions does this for everything under `secrets.*`. Void does not guess at credential-shaped variable names, and it does not parse credentials out of values you supplied — a password inside a `DATABASE_URL` in your build command prints as written. Register such values as CI secrets, or keep them out of the build command.

```
■  deploy: Deploy failed: deploy in progress
│  Deployment: dpl_7zgitxdrxxz9
│  Detailed log: ~/.void/logs/deploy-2026-08-21T03-24-19-764Z.jsonl
│
│  Errors
│     9.0s  deploy_server_error
│           deploymentId=dpl_7zgitxdrxxz9
│           message=deploy in progress
│
│  Last 20 of 26 entries
│     8.4s  info   finalize_start        assets=98 workers=0
│     8.6s  info   stream_deployment_id  deploymentId=dpl_7zgitxdrxxz9
│     9.0s  error  deploy_server_error   message=deploy in progress
```

Platform resolution precedence:

1. `--platform <cloudflare|void>` (or the legacy `--backend cloudflare` alias)
2. `platform` in `.void/project.json`
3. Void for projects initialized by an older SDK without a saved platform

Selecting Skip deployment setup stores `"platform": "none"`; a later `void deploy` stops with guidance until a platform override is provided.

For the Void platform, project resolution precedence is:

1. `--project <name>`
2. `VOID_PROJECT`
3. linked project in `.void/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one. In CI (non-TTY), `void deploy` errors out instead — set `VOID_PROJECT` or pass `--project <slug>`.

That fallback is mainly for projects that skipped Void project setup during `void init`.

### `void deploy --platform cloudflare`

Deploy the built worker straight to **your own** Cloudflare account instead of the Void platform. This path uses your local `wrangler` auth and your root `wrangler.jsonc` — no Void login or linked project is involved.

```
void deploy --platform cloudflare                   # provision what is missing, then deploy
void deploy --platform cloudflare --require-email   # fail instead of deploying without email
```

Prerequisites:

- A Cloudflare account must be **pinned**: set `account_id` in your root `wrangler.jsonc`, or export `CLOUDFLARE_ACCOUNT_ID`. A multi-account token otherwise makes wrangler prompt (or error in CI), which Void cannot intercept.
- Authenticate wrangler (`wrangler login`, or set `CLOUDFLARE_API_TOKEN`). Deploy needs `Workers Scripts:Edit` plus read on the resources you bind, and per-product `*:Edit` whenever it must create a missing D1 database, KV namespace, R2 bucket, Queue, or Hyperdrive config. Email setup needs a `wrangler login` session from wrangler 4.81 or newer (it carries the Email Routing and Email Sending scopes), or a `CLOUDFLARE_API_TOKEN` that also has Email Routing Edit and Email Sending Edit (a Global API Key pair is refused).
- If Cloudflare Access protects the Worker's `workers.dev` hostname, export a complete `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` service-token pair admitted by that Access policy. For an interactive local deploy, `CF_ACCESS_TOKEN="$(cloudflared access token --app=https://<worker>.<account>.workers.dev)"` also accepts the current user's short-lived Access session. Void uses these credentials only for a matching HTTPS readiness probe, does not expose them to project build code or Wrangler, and does not store them.
- In a fresh CI checkout, set `CLOUDFLARE_WORKERS_SUBDOMAIN` to the account subdomain (for example `my-team`) when the Worker has no version preview URL, as with Durable Objects. Local deploys learn and cache it in ignored `.void/cloudflare.json` from Wrangler's first reported workers.dev URL.
- `CLOUDFLARE_API_TOKEN` is **required** to provision a Hyperdrive config for the first time — `wrangler login` covers every other resource, but wrangler exposes no machine-readable Hyperdrive list, so Void checks for an existing config over the Cloudflare REST API, which OAuth cannot authenticate. Without a token, automatic provisioning stops before touching your account. Alternatively create the Hyperdrive config yourself and put its id in `wrangler.jsonc` — deploying an already-provisioned Hyperdrive app needs no token.
- `--skip-build` is supported for static, SPA, and SSG deployment when the output directory already exists. It is **not supported for worker-bearing apps**, because that path validates the artifact the build emits (worker `vars` in `dist/ssr/wrangler.json` and the generated auth schema).
- `--project` is **not supported** with `--platform cloudflare`, because no Void project is resolved. `--dir` and `--spa` are supported and deploy through a thin Worker in front of Cloudflare Workers Assets.
- Apps that use the sandbox require local Docker and [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans). Before provisioning or building, deploy verifies Containers access with `wrangler containers list`; an API token must include Account / Containers: Edit and Account / Cloudchamber: Edit. Apps without sandbox usage do not run this check.

For static, SPA, and SSG apps, Void builds when needed, merges `_headers`, `_redirects`, and `void.json` routing rules, writes a deterministic thin edge Worker, and deploys the asset directory with Workers Assets. A fully prerenderable `output: "static"` Pages app uses this path; a hybrid app with a dynamic page or another runtime feature keeps its generated application Worker. TanStack Start, React Router, vinext App Router and Pages Router, SvelteKit, Nuxt, Analog, and Astro Cloudflare outputs are supported, including their SSR Workers.

For worker-bearing apps, it settles the app class, pins the account and checks auth, runs the email step when the app uses email (below), automatically provisions missing resources, **builds**, validates the emitted artifact and migrations, preserves or creates the auth secret, applies remote D1 migrations or checked-in PostgreSQL/MySQL migrations through the production `DATABASE_URL`, and promotes explicit env schema `.secret()` values to encrypted Cloudflare Worker secrets. It then uploads an immutable Worker Version, records the exact migration filenames in its annotation, probes that version directly, activates it at 100%, and synchronizes routes, custom domains, cron triggers, queue consumers, and Email Routing rules (from `addresses`). Versions without preview URLs are staged at 0% and probed through the production workers.dev URL with a version override. The same zero-percent path is used when an account-wide Access default-deny policy blocks the generated preview alias but admits the stable Worker hostname, so failed readiness never sends the new version traffic. A failed trigger sync restores the previous version. PostgreSQL migrations are transactional; MySQL DDL is not. External database URLs are never written to the Worker config.

The initial deployment of a brand-new Worker has three Cloudflare exceptions: the Versions API cannot create the Worker, rejects initial Durable Object migration history with error `10211`, and some accounts do not enable preview URLs until an ordinary deployment. Only after proving that the Worker did not exist before first-deploy secret provisioning, Void handles these cases with one ordinary deploy and probes the active Worker for readiness. This remains safe when Wrangler creates a placeholder version while attaching the first secret; Void never takes the fallback for a previously deployed application. Later deployments use preview URLs when available and the 0%-traffic version-override flow otherwise.

The build deliberately comes **before** the secret, auth-schema, and migration gates, because those gates inspect the real emitted worker rather than a prediction of it. A missing secret or a bad migration surfaces after the build has run — relevant when a build is expensive or has side effects. Remote D1 migrations run only once every gate has passed, so a failed gate mutates nothing remote.

Every deploy automatically ensures that the D1 database, KV namespaces, R2 bucket, Queues, Hyperdrive config, and ISR cache namespace inferred from your source exist, then lets wrangler write the real ids into your root `wrangler.jsonc`. Provisioning is **idempotent** — re-running creates nothing that already exists (it reads existing ids first). The former `--provision` flag is still accepted for backwards compatibility but is no longer needed. Notes:

- **Avoid concurrent first deploys from different machines or CI runners.** The provisioning lock is per local config path and does not coordinate across hosts. Resource adoption makes later deploys idempotent, but two first deploys racing the same account could create duplicate resources whose names are not account-unique. Commit the updated `wrangler.jsonc` when practical so CI starts with the resolved ids.
- **Your `wrangler.jsonc` is rewritten.** When wrangler writes the new ids, it preserves your comments but normalizes the whole file's indentation — expect that in the diff.
- **Explicit schema secrets are encrypted automatically.** `.secret()` values may come from `.env`, `.env.production`, `.env.production.local`, or the deploy process environment. Void removes them from generated `vars`, uploads them over stdin, and inherits them through `secrets.required`. Remote-only marked secrets are preserved; absent optional values are skipped; nothing is pruned. Unmarked portable env values remain plaintext, while unmarked local and shell values are excluded.
- **First deploy of a not-yet-deployed worker:** Void can bootstrap schema-marked values on the draft Worker and automatically manages `BETTER_AUTH_SECRET` for auth-enabled apps.
- **Custom D1 migration layouts are verified:** configured `migrations_dir`, `migrations_table`, and `migrations_pattern` are supported only when Wrangler's exact file set, bytes, and numeric order match the migration set Void validated.
- **Top-level config only:** direct deploy and operational commands reject named Wrangler environments and alternate config-path overrides. Keep the intended account and Worker name pinned in the root config.

**Email.** When the app uses email (`sendEmail()` or `email/` handlers) and `void.json` has `email.from`, the deploy reads the state of that address's zone before the build — session scopes, zone, MX records, Email Routing, subaddressing, routing rules, Email Sending, and what `wrangler.jsonc` holds — prints a checklist of what it would change in your account, and asks once (default Yes). On Yes it enables what is missing, writes `send_email: [{ "name": "SEND_EMAIL" }]`, the `__VOID_EMAIL_FROM` var and the `addresses` array into `wrangler.jsonc`, and lets wrangler create the routing rules when the activated version's triggers are synchronized; the deploy ends with the address map. A deploy with nothing left to set up asks nothing. Without `email.from` the deploy prints `add "email": { "from": "you@mail.acme.com" } to void.json` and continues without email. Non-interactive runs (CI, or stdin/stdout not a terminal) never prompt: they print the checklist plus `Run void email setup --platform cloudflare once locally, commit wrangler.jsonc, then redeploy` and deploy without email (or with the setup `wrangler.jsonc` already carries, when the binding is committed; a committed `addresses` array whose routing is off is removed first, since wrangler's plan on it would fail after the upload) — unless `--require-email` is passed, which fails instead. A deploy whose account rows all read ready reconciles the two config rows — `addresses` against the current derivation and `vars.__VOID_EMAIL_FROM` against `email.from` — with a plain file write and no prompt. See [Your own Cloudflare account](../guide/email.md#your-own-cloudflare-account) for the whole flow, including the subdomain-vs-apex rule and what stays manual.

See the [Cloudflare integration guide](../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account) for the full walk-through.

## Database

### `void db push`

Apply your Drizzle schema directly to the development database without creating migration files. D1 updates the local database; PostgreSQL and MySQL use `DATABASE_URL` from `.env.local`.

Use this for quick schema iteration while prototyping. Before deploying, generate and review migration files with `void db generate`.

### `void db generate`

Generate SQL migration files from schema changes.

The command compares your current `db/schema.ts` or `db/schema/` modules against the last generated Drizzle snapshot and writes new migration artifacts under `db/migrations/`. When Void-managed auth is enabled, it also resolves the Better Auth schema in production mode and includes those tables automatically, including configured renames and plugin tables. This works for auth-only apps without an application schema. Review and commit the generated files before deploying.

### `void db status`

Show migration status. Displays which migrations are applied or pending locally, then uses the saved deployment target for remote status: the hosted API for Void projects, the pinned D1 database and its configured migration table for direct Cloudflare SQLite projects, or the shell `DATABASE_URL` for direct Cloudflare PostgreSQL/MySQL projects. If the remote credential or service is unavailable, local status is still shown.

### `void db reset`

Drop the local D1 database and re-apply all migrations. Does not affect the remote database.

### `void db seed`

```
void db seed [--file <path>]
```

Reset the local database, re-apply all migrations, then execute a seed file.

If `--file` is omitted, Void looks for default seed files in this order: `db/seed.ts`, `db/seed.mts`, `db/seed.js`, `db/seed.mjs`, `db/seed.sql`.

If more than one default seed file exists, the CLI stops and asks you to pass `--file <path>`.

Programmatic seed modules must export either a default function or a named `seed` function.

### `void db execute`

```
void db execute <sql>
void db execute --file <path>
void db execute --remote <sql>
```

Run ad-hoc SQL against the database. Provide SQL inline or from a file. SELECT queries display results as a formatted table; other statements execute silently.

By default, targets the local database. Pass `--remote` to run against the deployed database selected in `.void/project.json`:

- **Hosted D1 projects**: routes the query through the Void proxy (`proxy.void.cloud/d1/query`) using your auth token.
- **Direct Cloudflare D1 projects**: invokes Wrangler against the pinned D1 binding from root `wrangler.jsonc`.
- **Hosted PostgreSQL and MySQL projects**: fetches the stored connection string from the platform and connects directly.
- **Direct Cloudflare PostgreSQL and MySQL projects**: uses `DATABASE_URL` from the current shell; Cloudflare cannot return the password from Hyperdrive.

For destructive statements (`DELETE`, `UPDATE`, `DROP`, etc.) when running in a TTY, you will be prompted to confirm before the query is sent to the deployed database. Non-TTY environments (CI) skip the prompt.

### `void db migrate`

```
void db migrate [--remote]
```

Apply pending migrations to the local database without resetting. Unlike `void db reset`, this preserves existing data and only runs migrations that haven't been applied yet.

Pass `--remote` to apply pending migrations to the saved target. Hosted projects require a Void login and link. Direct Cloudflare D1 projects apply with Wrangler using the binding's configured migration directory/table/pattern; direct PostgreSQL and MySQL projects use the shell `DATABASE_URL`.

### `void db studio`

```
void db studio [--remote]
```

Open [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio) for the database. Launches a web-based GUI for browsing and editing your data.

By default, targets the local database. Pass `--remote` to open Studio against the deployed database:

- **PostgreSQL and MySQL projects**: fetch the stored connection string from the platform and open Studio against it. If the URL isn't stored yet, run `void db set-url` first.
- **D1 projects**: remote Studio is not yet supported. Use `void db execute --remote` for ad-hoc queries against your deployed D1 database.

On direct Cloudflare PostgreSQL/MySQL targets, remote Studio uses `DATABASE_URL` from the current shell. Direct D1 Studio remains unsupported; use `void db execute --remote`.

### `void db rename-migrations`

Rename existing migrations from the old numeric prefix format (`0001_name.sql`) to timestamp-based format (`20260410161500_name.sql`). Updates local tracking table and remote records if logged in with a linked project.

### `void db connect`

Connect an existing PostgreSQL/MySQL database or provision one through an adapter:

```sh
void db connect 'postgresql://user:password@host/database'
NEON_API_KEY=... void db connect --provider neon --name my-app
void db connect --provider @acme/void-db-provider --region region-id
```

The command saves `DATABASE_URL` in `.env.local`. When authenticated with a linked Void project, it also updates the encrypted deployment URL; pass `--local-only` to skip that sync. `neon` is built in. Other adapters are project dependencies or local modules exporting a `DatabaseProviderAdapter` from `void/database-provider`.

Provider-created credentials are never printed. For direct Cloudflare deploys, configure the same URL as a protected `DATABASE_URL` in the shell or CI environment that runs deploy.

### `void db set-url`

Update the PostgreSQL or MySQL connection string for deployment. Available for projects with `"database": "pg"` or `"database": "mysql"`.

Prompts for a connection string and sends it to the platform API to create or update the Hyperdrive configuration.

### `void db export`

```
void db export [--output <path>] [--no-data] [--no-schema] [--table <name>]
```

Dump the local database as SQL. Outputs to stdout by default (pipeable), or to a file with `--output`.

| Flag              | Purpose                            |
| ----------------- | ---------------------------------- |
| `--output <path>` | Write to a file instead of stdout  |
| `--no-data`       | Schema only (no INSERT statements) |
| `--no-schema`     | Data only (no CREATE TABLE)        |
| `--table <name>`  | Export a single table              |

## Code Generation

### `void gen model`

```
void gen model <name> [columns...]
```

Scaffold a complete model: migration file, CRUD API routes, and regenerated DB types in one command.

```sh
void gen model posts title:string body:text published:boolean
```

Creates:

- `db/migrations/NNN_create_posts.sql`: `CREATE TABLE` with `id` (autoincrement), your columns, and `created_at`
- `routes/api/posts/index.ts`: `GET` for list and `POST` for insert with validation
- `routes/api/posts/[id].ts`: `GET` by id with `404` handling
- Regenerated `.void/db.d.ts`

The generated routes automatically detect your validation library from `package.json` (`valibot`, `zod`, or `arktype`). If none is found, you will be prompted to choose one or skip validation. See [Database: Scaffolding](../guide/database.md#scaffolding) for the full type mapping.

Column format: `name:type` or `name:type?` (nullable). Types: `string`, `text`, `datetime`, `integer`, `boolean`, `real`, `blob`.

Model names must be lowercase alphanumeric with underscores (e.g. `posts`, `user_roles`). Existing files are never overwritten.

### `void gen migration`

```
void gen migration <name>
```

Create an empty migration file with a timestamp prefix (`YYYYMMDDHHMMSS`).

```sh
void gen migration add_avatar_to_users
# → db/migrations/20260410161500_add_avatar_to_users.sql
```

Existing projects using the old numeric prefix (`0001_`, `0002_`, ...) can rename with `void db rename-migrations`.

### `void gen route`

```
void gen route <path> [--methods get,post,...]
```

Create a route file with `defineHandler` exports. Defaults to GET.

```sh
void gen route api/health
void gen route api/users --methods get,post,delete
```

Creates `routes/<path>.ts` with an exported handler for each method. Supported methods: `get`, `post`, `put`, `patch`, `delete`.

### `void gen middleware`

```
void gen middleware <name>
```

Create a numbered middleware file with `defineMiddleware` default export.

```sh
void gen middleware auth
# → middleware/01.auth.ts (or 02, 03, etc.)
```

The prefix is auto-detected from existing middleware files.

### `void gen ssr`

```
void gen ssr [--react | --vue | --svelte | --solid]
```

Scaffold SSR entry points and a minimal App component for your framework.

Creates three files:

- `src/main.ssr.{tsx,ts}`: server entry with `defineRender`
- `src/main.client.{tsx,ts}`: client entry with hydration
- `src/App.{tsx,vue,svelte}`: minimal interactive component

If no flag is provided, the framework is auto-detected from `package.json` dependencies.

### `void gen cron`

```
void gen cron <name>
```

Create a cron job file in `crons/` with `defineScheduled` and a placeholder cron expression.

```sh
void gen cron hourly-sync
```

### `void gen queue`

```
void gen queue <name>
```

Create a queue consumer file in `queues/` with `defineQueue`, a `Message` interface, and commented-out batch options.

```sh
void gen queue emails
```

## Secrets

### `void secret list`

```
void secret list [--project <name>]
```

List production secret names for the saved target. Secret values are never printed. Direct Cloudflare targets query the Worker named in root `wrangler.jsonc`; `--project` is hosted-only.

### `void secret put`

```
void secret put <name> [--project <name>]
void secret put <name=value> [--project <name>]
```

Value input modes:

- inline: `void secret put API_KEY=abcd`
- prompt (TTY): `void secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | void secret put API_KEY`

On a direct Cloudflare target, the value is sent to Wrangler over stdin and stored as an encrypted Worker secret.

### `void secret sync`

```
void secret sync <file> [--project <name>]
```

Bulk upload secrets from a dotenv file. Each `KEY=value` line in the file is uploaded as a secret.

```sh
void secret sync .env.local       # uploads secrets from .env.local
void secret sync .env.production  # uploads a specific file
```

Direct Cloudflare targets use Wrangler's bulk-secret API. Existing remote secrets absent from the file are not pruned.

### `void secret delete`

```
void secret delete <name> [--project <name>]
```

Secret commands use the platform saved in `.void/project.json`. Hosted project resolution follows the same order as deploy (`--project`, env var, linked project). Direct Cloudflare targets reject `--project` and use the pinned root Wrangler config.

## Env Schema

### `void env check`

```
void env check [--remote]
```

Validate `env.ts` against `.env` + `.env.production` (and, with `--remote`, also against the remote secret list). Exits non-zero if any required key is missing or invalid. Use in CI before deploy.

### `void env types`

```
void env types
```

Regenerate `.void/env.d.ts` from `env.ts`. Normally happens automatically on dev server start and HMR; use this command after a fresh clone or to refresh stale types in non-dev contexts.

### `void env example`

```
void env example [--force]
```

Generate or refresh a marker-delimited "void env" block inside `.env.example` at the project root, sourced from the registered `env.ts` schema. The block is grouped into `required`, `with defaults`, and `optional` sections, with enum members emitted as inline comments. Prefilled values are used for keys with a `.default(...)`.

The command never overwrites the whole file — anything above or below the markers (custom CI tokens, build flags, etc.) is preserved verbatim:

| State of `.env.example`                     | Behavior                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| File doesn't exist                          | Writes a fresh file containing only the marker block.                                                                  |
| Exists, contains both markers               | Replaces only the lines between (and including) the markers; everything else is preserved.                             |
| Exists, no markers                          | Appends the block at the end (one blank line separator) and prints `appended void env block to existing .env.example`. |
| Exists, only one of the two markers present | Hard error — fix the file (restore the missing marker or delete the file) and rerun.                                   |

Pass `--force` to suppress the "appended block" notice for scripted runs.

Example output:

```ini
# >>> void env: managed block — do not edit between markers <<<
# Run `void env example` to refresh.
# required
STRIPE_KEY=
# enum: development | production
NODE_ENV=

# with defaults
PORT=3000
# >>> end void env <<<
```

::: tip Deploy validation
`void deploy` runs the same schema validation automatically (with remote secrets) and refuses to upload if any required key is missing — no need to call `env check` separately when deploying.
:::

See [Environment Variables](../guide/env-vars.md) for the full guide.

## GitHub

Deploy-on-GitHub works from **any** Void login — Google, GitHub, or other SSO. The first time you connect GitHub, Void links your GitHub identity to your current account (a one-time step, independent of how you logged in); it never creates a second account.

### `void github link`

```
void github link
```

Link your current Void account to a GitHub identity. Opens your browser to authorize Void on GitHub (a localhost + PKCE handshake, the same mechanics as `void auth login`), then binds that GitHub identity to the logged-in account. Requires an authenticated CLI (`void auth login` first).

You normally don't need to run this directly — `void github install` runs the link automatically when your account has no GitHub identity yet. Run it on its own to link ahead of time, or to link a GitHub identity without installing the App.

::: warning Existing GitHub sign-in
Void accounts cannot be merged. If the GitHub account you authorize is already linked to a different Void account, including one created through GitHub sign-in, `void github link` is refused with `This GitHub account is already linked to another Void account.` Run `void auth logout` and sign in to that existing account, or authorize a different GitHub account. The command is also refused if your current Void account is already linked to a different GitHub identity. Re-authorizing the GitHub account attached to your current Void account is allowed and reports `GitHub account already linked.`
:::

### `void github install`

```
void github install
```

Open the GitHub App install page in your browser. If your account has no linked GitHub identity yet, `void github install` first runs the GitHub link automatically (browser authorize), then continues. After installing, run `void github connect` to link a repository to your project.

### `void github installations`

```
void github installations
```

List all GitHub App installations linked to your account. Each entry includes the `[id: <installation_id>]` needed for `--installation` in non-interactive use.

### `void github join`

```
void github join
```

Join the GitHub App installations your organization already has. If a teammate installed the Void GitHub App on a shared GitHub organization, run `void github join` to gain access to those installations without re-installing. Void opens your browser to authorize (a localhost + PKCE handshake, the same mechanics as `void github link`), confirms with GitHub which installations you can manage, and records your membership. Afterwards `void github installations` lists them and `void github connect` can connect your own projects to their repositories.

In an interactive terminal you rarely need to run this yourself — `void github connect` runs the same join automatically when no active installations are linked to your account. Running `void github join` yourself matters mainly for non-interactive use (without a TTY, `void github connect` never opens a browser), or to link installations ahead of time.

Requires an authenticated CLI (`void auth login` first) and organization-installation sharing enabled on your Void instance; when it is not enabled the command fails closed with a clear message. You can only join installations your GitHub authorization actually returns — you cannot name or join one you cannot access on GitHub.

### `void github connect`

```
void github connect [project] [options]
```

Connect a GitHub repository to a Void project for automatic deploys. On every push to the configured branch, Void builds and deploys your project automatically.

Interactively (TTY), if your account has no active installations linked, `void github connect` first runs the same browser authorize as `void github join` automatically — if a teammate already installed the Void GitHub App on your organization, you join it on the spot and the connect continues. Only when no shared installation is found does it ask you to run `void github install`. The same recovery runs when `--installation <id>` names an installation your account is not linked to yet. Without a TTY, connect never opens a browser: it fails closed and tells you to run `void github install`, or `void github join` if your organization already installed the App.

**Options**

| Flag                  | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `--project <name>`    | Project name (alias for the positional argument)                                  |
| `--installation <id>` | GitHub App installation ID (required when you have multiple installations)        |
| `--repo <owner/repo>` | Repository full name — required unless the installation grants exactly one repo   |
| `--branch <name>`     | Branch to deploy from — **required in non-interactive mode**                      |
| `--executor <type>`   | Build executor: `container` (default) or `github_actions`                         |
| `--workflow <path>`   | Authorized deploy workflow file — defaults to `.github/workflows/void-deploy.yml` |

The `--workflow` path is the workflow file the GitHub OIDC exchange authorizes to mint this project's deploy token. It defaults to the scaffolded `.github/workflows/void-deploy.yml`; set it only if your deploy step lives in a different workflow file (it must be under `.github/workflows/` and end in `.yml`/`.yaml`). Because the exchange is secretless, **only this one workflow** can mint a deploy token — any other workflow in the repo (including an unsafe `pull_request_target`) is rejected. Pointing it at a broad, multi-purpose workflow widens that trust, so prefer a dedicated file.

Interactively (TTY), after resolving the repository and branch, `void github connect` prompts for the **build executor** (defaulting to `container`). If you pick `github_actions`, it then prompts for the **deploy workflow file**, defaulting to `.github/workflows/void-deploy.yml` and validated locally before it is sent. Pass `--executor` and/or `--workflow` to skip the respective prompt. The workflow prompt is skipped entirely for the `container` executor, which does not use a workflow file.

**Non-interactive use (CI)**

When stdin is not a TTY, `void github connect` never prompts — it fails closed and names any flag it needs. `--branch` is always required. `--project` must be resolvable (positional / `--project` / `VOID_PROJECT` / linked `.void/project.json`). `--installation` is required only when your account has more than one installation; otherwise the sole installation is used. `--repo` is required when the installation grants access to all repos or to more than one selected repo; when it grants exactly one repo that repo is used automatically. `--repo` is also required when the installation does not expose a repository list to your account (shared org installations hide it). Use `void github installations` to discover the `installation_id`.

```
void github connect my-app \
  --installation 42 \
  --repo owner/my-app \
  --branch main
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

**Connecting as an organization member**

If you are a member of a GitHub organization but not the person who installed the App, `void github connect` first confirms that you personally have access to the specific repository. Interactively (TTY), when it detects this it opens your browser once to authorize access to that repo on GitHub (a localhost + PKCE handshake), then completes the connection automatically — no extra flags. Without a TTY, this per-repo authorization never opens a browser: connect fails closed with an error explaining that the installation requires per-repo authorization, which needs an interactive browser sign-in, and telling you to run `void github connect` locally to authorize, then retry. Interactively, connect joins the shared installation automatically when your account has no active installations linked, so running `void github join` first is optional — useful mainly to see the installation in `void github installations` beforehand. You can only connect repositories you can access on GitHub; one you cannot see is refused with a clear message.

### `void github update`

```
void github update [project] [options]
```

Update an existing connection's deploy **branch**, **build executor**, and/or authorized **workflow file**. Use this to change settings on a project that is already connected — for example, flipping the executor from `container` to `github_actions` for a monorepo whose Void app lives in a subdirectory, moving the deploy branch, or pointing the OIDC trust at a different workflow file. The project must already be connected (run `void github connect` first); the repository and installation are not changed.

**Options**

| Flag                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `--project <name>`  | Project name (alias for the positional argument)                 |
| `--branch <name>`   | New branch to deploy from                                        |
| `--executor <type>` | New build executor: `container` or `github_actions`              |
| `--workflow <path>` | New authorized deploy workflow file (under `.github/workflows/`) |

Interactively (TTY), `void github update` shows the current branch and executor and prompts for new values, defaulting each to the current setting. If the resulting executor is `github_actions`, it then prompts for the **deploy workflow file**, defaulting to the current path and validated locally; pass `--workflow` to skip that prompt. The workflow prompt is skipped when the executor is `container`, which does not use a workflow file. When stdin is not a TTY, it never prompts: pass at least one of `--branch` / `--executor` / `--workflow`, or it fails closed. If nothing actually changes, the command reports "no changes" and does not call the API.

```
void github update my-app --executor github_actions
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

### `void github status`

```
void github status [project]
```

Show a project's current GitHub connection: the connected **repository**, the deploy **branch**, the **build executor** (`container` or `github_actions`), and the authorized **deploy workflow file**. Read-only — it never changes anything. The workflow file is the OIDC pin used only for `github_actions` builds; on a `container` connection it is still shown but marked unused. The project must already be connected (run `void github connect` first, otherwise it reports that and exits).

**Options**

| Flag               | Description                                      |
| ------------------ | ------------------------------------------------ |
| `--project <name>` | Project name (alias for the positional argument) |

```
void github status my-app
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

### `void github disconnect`

```
void github disconnect [project]
```

Disconnect a project from its GitHub repository, stopping automatic deploys. Any in-flight builds for the project are cancelled (their deploy tokens are revoked) before the connection is removed. If the project has no connection, it reports that and exits successfully. To point a project at a different repository, disconnect first, then run `void github connect`.

You are asked to confirm before anything is removed. Pass `--yes` to skip the prompt; `--yes` is **required** in a non-interactive shell (CI), where there is no prompt to answer.

**Options**

| Flag               | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `--project <name>` | Project name (alias for the positional argument)                  |
| `--yes`            | Skip the confirmation prompt (required in non-interactive shells) |

```
void github disconnect my-app --yes
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

## Build

Inspect Deploy-on-GitHub builds.

### `void build logs`

```
void build logs [build] [--follow] [--output <file>] [--project <slug>]
```

Stream, tail, or download the build logs for a **container** build. With no
`[build]` argument, targets the project's most recent build.

| Flag                     | Purpose                                                           | Default |
| ------------------------ | ----------------------------------------------------------------- | ------- |
| `--follow`, `-f`         | Live-tail: poll until the build reaches a terminal status.        | off     |
| `--output <file>`, `-o`  | Write logs to a file instead of stdout (appends while following). | stdout  |
| `--project <slug>`, `-p` | Target project.                                                   | linked  |

**Project resolution** follows the same order as deploy: positional / `--project`,
`VOID_PROJECT`, linked project (`.void/project.json`).

Builds run on **GitHub Actions** keep their logs on GitHub — the command prints
the Actions run URL instead of streaming. Only the last 10,000 log lines of a
container build are retained.

Examples:

```
void build logs                     # print the latest build's logs
void build logs -f                  # follow the latest build until it finishes
void build logs bld_123 -o build.log  # download a specific build's logs
```

## Custom Domains

### `void domain add`

```
void domain add <hostname> [--project <name>]
```

Add a custom domain to the saved target. Hosted Void projects print the DNS records needed for SaaS hostname validation. Direct Cloudflare projects add a Wrangler `custom_domain` route and immediately synchronize only the route configuration, leaving cron, queue, and workflow triggers unchanged; Cloudflare manages the DNS record and TLS certificate in a zone on the pinned account. Convert a legacy singular `route` field to a `routes` array first so adding the domain cannot shadow the existing route.

> Wildcard custom hostnames (`*.example.com`) are not supported — register each subdomain individually.

### `void domain delete`

```
void domain delete <hostname> [--project <name>]
```

Direct Cloudflare projects apply the change immediately. Deleting the final custom domain requires `CLOUDFLARE_API_TOKEN` with Workers Scripts: Edit permission because Wrangler does not reconcile an empty custom-domain set; Void fails before changing local or remote state when that token is unavailable.

Remove a custom domain from the saved target. For Cloudflare, this removes the matching `custom_domain` route and synchronizes triggers. If Cloudflare rejects the update, Void restores the exact previous local config and immediately reapplies it remotely. If that second synchronization also fails, the CLI reports that remote route state may be partial instead of claiming a successful rollback.

### `void domain list`

```
void domain list [--project <name>]
```

List all custom domains. Hosted projects show active/pending state from the platform; direct Cloudflare projects list the custom-domain routes currently configured in root `wrangler.jsonc`.

### `void domain status`

```
void domain status <hostname> [--project <name>] [--verbose]
```

Check verification and SSL status for a specific domain. Prints a rolled-up state (`awaiting_dns`, `verifying_dns`, `issuing_cert`, `deploying_cert`, `awaiting_deployment`, `active`, `error`, or `pending`) with a one-line diagnostic explaining what Cloudflare is doing and any user action required. While the certificate is not yet active, the command also surfaces the records to configure — the traffic **CNAME** and the `_cf-custom-hostname` ownership **TXT** — so you can verify them. Activation is automatic: a background job reconciles pending domains (about every 2 minutes for the first 30 minutes after adding, then hourly), so this command is for instant feedback rather than required polling.

Pass `--verbose` to additionally print the raw multi-line status breakdown (DB status, SSL status, ownership state, verification errors) underneath the rollup.

Project resolution for domain commands follows the same order as deploy (`--project`, `VOID_PROJECT`, linked project).

For direct Cloudflare projects, status reports whether the route is present in the root config. It does not claim to inspect remote certificate issuance; Cloudflare owns that state and exposes it in the dashboard. `--project` is hosted-only.

## Email

Inspect email usage and manage the recipients a project is allowed to send to. See [Email](../guide/email.md) for the runtime API.

Project resolution for email commands follows the same order as deploy (`--project`, `VOID_PROJECT`, linked project). `void email setup` and `void email status --platform cloudflare` are the exception: they act on your own Cloudflare account through your `wrangler login` session and need no Void project.

### `void email usage`

```
void email usage [--project <name>]
```

Show the current month's outbound and inbound counts, the monthly outbound limit, and how much of it is left. A suspended project is flagged in the output.

### `void email logs`

```
void email logs [--limit <n>] [--project <name>]
```

Show recent email activity — timestamp, direction, sender, recipient, status, and subject. `--limit` takes a positive integer. While persistent log storage is still being wired up, the command says so and points you at `wrangler tail` for real-time activity.

### `void email destinations`

```
void email destinations [--project <name>]
```

List the project's recipient addresses and their state (`verified`, `pending`, or `failed`). Outbound mail is only delivered to verified addresses.

### `void email allow`

```
void email allow <address> [--project <name>]
```

Add one recipient to the project's destination list. Cloudflare emails that address a verification link — the recipient clicks it, with no Void or Cloudflare account required — and the project can send to them from then on. Re-run `void email destinations` to check whether they have verified yet. If the link did not arrive or has expired, run `void email allow <address>` again while the address is still pending — the CLI re-sends the link, or tells you how to get a fresh one.

The project owner's email is added automatically when the project is created, so sending to yourself works without this step.

### `void email disallow`

```
void email disallow <address> [--project <name>]
```

Remove one recipient from the project's destination list. Outbound mail to that address is rejected from the next deploy onward.

### `void email status`

```
void email status --platform cloudflare
```

Read-only. Checks the email setup on your own Cloudflare account for the domain of `email.from` in `void.json` — session scopes, zone, MX records, Email Routing (and its subaddressing setting), Email Sending, the routing rule for every `email/` handler, and the `send_email` binding — then prints the status rows and the address map (`inbound <address> → email/<handler>`, `outbound sendEmail() from <email.from>`). Exits 1 when anything is not ready. Takes no `--project`: it reads the local project and your `wrangler login` session, never a Void project.

Without `--platform cloudflare` (or with `--platform void`) the command is not available yet; on the Void platform use `void email usage` and `void email destinations`. The older `--backend cloudflare` spelling remains available as a compatibility alias on `void email status` and `void email setup`, with the same rules as `void deploy`: at most once, and never together with `--platform`.

### `void email setup`

```
void email setup --platform cloudflare
```

The same setup `void deploy --platform cloudflare` offers on its first deploy, on its own — for CI, which cannot press Enter: run it locally once, commit `wrangler.jsonc`, then let CI run `void deploy --platform cloudflare --require-email`. Needs `email.from` in `void.json` and a `wrangler login` session from wrangler 4.81 or newer (older sessions lack the email scopes) or a `CLOUDFLARE_API_TOKEN` with Email Routing Edit + Email Sending Edit — the CI credential. It runs the preflight above, prints the checklist of what will change on your account, asks once, then:

1. enables Email Routing on the domain (`wrangler email routing enable <zone>` on an apex; a subdomain is enabled through your session's bearer, borrowed from `wrangler auth token --json` for that one call and dropped),
2. turns on subaddressing for the zone, so `support+anything@` reaches `support@`,
3. onboards the domain for Email Sending (`wrangler email sending enable <domain>`; a Workers Free account keeps inbound and sends to verified destinations only),
4. writes `send_email: [{ "name": "SEND_EMAIL" }]`, the derived `addresses` array, and `vars.__VOID_EMAIL_FROM` into your root `wrangler.jsonc`, comments preserved.

The routing rules themselves are created by the next `void deploy --platform cloudflare`: wrangler applies its Email Routing plan from `addresses` on deploy. `void email setup` never writes `addresses` unless routing is ready for the domain, prunes an address already routed to another worker or a forward (and says so), and skips the whole step when the existing `addresses` array holds entries it did not derive. A run that finds every row ready asks nothing and changes nothing on your account. Needs an interactive terminal; exits 1 when routing is still not ready afterwards. See [Your own Cloudflare account](../guide/email.md#your-own-cloudflare-account).

## Agent

### `void init --agents`

Runs all agent setup steps:

1. **Instructions:** detects agents once and injects Void framework instructions with versioned markers.
2. **Skills:** links skills for the same detected or selected agent context.

If no agent is detected, `void init --agents` asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

## Environment variables

| Variable       | Purpose                                                                   | Default |
| -------------- | ------------------------------------------------------------------------- | ------- |
| `VOID_TOKEN`   | Auth token override instead of saved config                               | none    |
| `VOID_PROJECT` | Default project slug for deploy, secret, domain, and cache purge commands | none    |
