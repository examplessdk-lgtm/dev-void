---
outline: deep
---

# CLI

`void` is a local binary from the installed `void` package.

Use this page as a command reference. If you are setting up a project for the first time, start with [Quickstart](../guide/quickstart.md) and come back here when you need exact command behavior or flags.

## Cheat Sheet

| Command                           | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `void deploy`                     | Build and deploy to Void                         |
| `void prepare`                    | Generate `.void` artifacts without starting Vite |
| `void gen model <name> [cols...]` | Scaffold migration + CRUD routes                 |
| `void gen route <path>`           | Create an API route                              |
| `void db status`                  | Show local/remote migration status               |
| `void db reset`                   | Drop and re-apply all migrations                 |
| `void db seed`                    | Reset + seed local database                      |
| `void db studio`                  | Open Drizzle Studio for local database           |
| `void secret put <name=value>`    | Set a production secret                          |
| `void secret sync .env.local`     | Bulk upload secrets from dotenv file             |
| `void env check [--remote]`       | Validate env.ts schema                           |
| `void env types`                  | Regenerate .void/env.d.ts from env.ts            |
| `void env example`                | Refresh the void-managed block in .env.example   |
| `void auth login`                 | Authenticate with Void                           |
| `void project link`               | Link directory to a project                      |
| `void project logs`               | Show runtime logs from deployed project          |
| `void project rollback`           | Roll back to a previous deployment               |
| `void project purge-cache`        | Purge all cached pages                           |
| `void init`                       | Setup wizard for new or existing projects        |

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

If run in a scaffoldable empty directory, `void init` scaffolds a Pages starter. If a single Pages adapter is already installed, it reuses that framework; otherwise it asks which framework to scaffold (React, Vue, Svelte, or Solid). It then asks which starter you want: D1, PostgreSQL, or Static Pages. The D1 and PostgreSQL starters write a framework-specific `vite.config.ts`, a `pages/` home page plus `.server.ts` loader, `db/schema.ts`, `db/seed.ts`, a generated initial migration under `db/migrations/`, and `routes/api/hello.ts`. The Static Pages starter writes just the framework-specific `vite.config.ts` and a `pages/` home page so you can add server features later.

If run in an existing project, `void init` configures the project in place: it ensures `void` and `vite` are declared, adds missing `dev` (`vite`) and `build` (`vite build`) scripts without overwriting existing scripts, and creates or patches `vite.config.*` with `voidPlugin()` when the config shape is safe to edit. If the Vite config is too dynamic to patch confidently, it prints the manual snippet instead of rewriting it.

After that, the full interactive flow walks through:

1. **TypeScript:** creates or updates `tsconfig.json`, including `extends .void/tsconfig.json`, `void/env` types, and root-level `files` / `compilerOptions.paths` merges when an existing config would otherwise replace Void's generated entries.
2. **Database:** asks whether you want D1, PostgreSQL, or no database yet. Choosing PostgreSQL writes `"database": "pg"` to `void.json`; D1 stays implicit; choosing no database leaves config unchanged so you can add data features later.
3. **Agent instructions:** detects agents once and injects instructions into `CLAUDE.md` or `AGENTS.md`.
4. **Skills:** links Void skills using the same detected or selected agent context.
5. **MCP config:** writes MCP server config using that same agent context.
6. **Demo code:** for existing non-Pages projects, optionally scaffolds a `db/migrations/` directory plus an API route and typed fetch example.
7. **GitHub Actions:** optionally creates `.github/workflows/deploy.yml` with the right package manager commands.
8. **`env.ts` scaffold:** if the project has no `env.ts` but has `.env` / `.env.example` / `.env.local` / `.env.development*` files on disk, generates an `env.ts` pre-populated with their keys. Values get conservative type inference (`boolean`/`url`/`number`/`string`) — the file carries a banner nudging you to tighten anything the heuristic got wrong.
9. **Project setup:** optionally logs you in, lets you select or create a project, and writes `.void/project.json` so your first deploy can just be `void deploy`.

If no agent is detected, `void init` asks you to choose one from a short list (Claude, Cursor, Codex, Gemini CLI, Generic). That single choice is reused across all agent steps.

Use flags to run individual steps without prompts:

| Flag         | Purpose                                           |
| ------------ | ------------------------------------------------- |
| `--tsconfig` | Only update `tsconfig.json`                       |
| `--agents`   | Set up agent instructions, skills, and MCP config |
| `--github`   | Only create GitHub Actions workflow               |

Flags can be combined. When any flag is provided, only the specified steps run and interactive prompts are skipped.

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

Show the last 5 deployments for a project.

- If `[name]` is provided, looks up the project by slug
- Otherwise uses the linked project from `.void/project.json`

### `void project link [name]`

Link current directory to an existing project by slug, or select interactively if omitted. State is stored in `.void/project.json`.

### `void project list`

List all your projects (slug, mode, URL).

### `void project logs`

```
void project logs [--level <level>] [--filter <text>] [--range <duration>] [--deployment <id>]
```

Show runtime logs from the deployed project. Uses the linked project from `.void/project.json`.

| Flag                 | Purpose                                                                                                                                                 | Default |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                                                                                         | `1h`    |
| `--level <level>`    | Filter by log level. One of `error`, `warn`, `info`, `log`, `debug`, `all`. `error` also includes uncaught exceptions and non-`ok` requests.            | `all`   |
| `--filter <text>`    | Case-insensitive **substring** match against log message text and exception name/message — not a level filter. Shows the full request entry on any hit. | none    |
| `--deployment <id>`  | Filter logs to a specific deployment ID.                                                                                                                | none    |

Output shows one line per request (`HH:MM:SS METHOD URL STATUS`) with indented console log and exception lines beneath. Errors and exceptions are colored red, warnings yellow.

Examples:

```
void project logs --level error --range 12h
void project logs --level error --filter websocket
```

Tip: `void project logs` only sees what Cloudflare Tail captures — top-level `console.*` calls and uncaught throws. Application errors caught and persisted to your own DB are invisible to tail. Surface them via `console.error(...)` or `void/log`'s `logger.error(...)` so they show up under `--level error`.

### `void project rollback [deployId]`

```
void project rollback [deployId]
```

Roll back to a previous deployment. Traffic instantly switches to the target deployment's worker script via KV routing update.

- If `[deployId]` is omitted, shows an interactive select menu of retained deployments
- If the target deployment has fewer applied migrations than the current one, a warning is shown listing the migration diff before confirmation

Only **retained** deployments can be rolled back to. The number of retained deployments depends on your plan (free: 1, solo: 5, pro: 25, unlimited for sponsored/custom).

### `void project delete [name]`

Permanently delete a project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

### `void project purge-cache`

```
void project purge-cache [--project <name>]
```

Purge all cached pages for the linked project. The edge cache will clear within seconds.

If `--project` is provided, purges that project's cache instead of the linked project.

## Deploy

### `void deploy`

```
void deploy [--project <name>] [--dir <path>] [--spa] [--skip-build]
```

Auto-detects your project type and chooses the right pipeline. See [Supported App Types](../guide/app-types.md) and [Deployment](../guide/deployment.md) for details.

For Drizzle projects, deploy performs a read-only schema drift check. If a new migration would be generated, deploy stops and tells you to run `void db generate`, review the migration, commit it yourself, and rerun `void deploy`.

| Flag               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                 |
| `--dir <path>`     | Deploy a pre-built static directory (skips build) |
| `--spa`            | Use SPA mode instead of SSG for static deploys    |
| `--skip-build`     | Skip the build step (use existing build output)   |

Project resolution precedence:

1. `--project <name>`
2. `VOID_PROJECT`
3. linked project in `.void/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one. In CI (non-TTY), `void deploy` errors out instead — set `VOID_PROJECT` or pass `--project <slug>`.

That fallback is mainly for projects that skipped Void project setup during `void init`.

## Database

### `void db status`

Show migration status. Displays which migrations are applied or pending locally. When logged in and linked to a project, also shows remote status.

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
```

Run ad-hoc SQL against the local D1 database. Provide SQL inline or from a file. SELECT queries display results as a formatted table; other statements execute silently.

### `void db migrate`

```
void db migrate [--remote]
```

Apply pending migrations to the local database without resetting. Unlike `void db reset`, this preserves existing data and only runs migrations that haven't been applied yet.

Pass `--remote` to apply pending migrations to the remote database instead. Requires being logged in (`void auth login`) and having a linked project.

### `void db studio`

Open [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio) for the local database. Launches a web-based GUI for browsing and editing your data.

### `void db rename-migrations`

Rename existing migrations from the old numeric prefix format (`0001_name.sql`) to timestamp-based format (`20260410161500_name.sql`). Updates local tracking table and remote records if logged in with a linked project.

### `void db set-url`

Update the PostgreSQL connection string for deployment. Only available for projects with `database.dialect: "postgresql"`.

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

### `void secret put`

```
void secret put <name> [--project <name>]
void secret put <name=value> [--project <name>]
```

Value input modes:

- inline: `void secret put API_KEY=abcd`
- prompt (TTY): `void secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | void secret put API_KEY`

### `void secret sync`

```
void secret sync <file> [--project <name>]
```

Bulk upload secrets from a dotenv file. Each `KEY=value` line in the file is uploaded as a secret.

```sh
void secret sync .env.local       # uploads secrets from .env.local
void secret sync .env.production  # uploads a specific file
```

### `void secret delete`

```
void secret delete <name> [--project <name>]
```

Project resolution for secrets follows the same order as deploy (`--project`, env var, linked project).

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

## Custom Domains

### `void domain add`

```
void domain add <hostname> [--project <name>]
```

Add a custom domain to a project. Prints the CNAME target you need to add in your DNS provider.

### `void domain delete`

```
void domain delete <hostname> [--project <name>]
```

Remove a custom domain from a project.

### `void domain list`

```
void domain list [--project <name>]
```

List all custom domains and their status (active/pending).

### `void domain status`

```
void domain status <hostname> [--project <name>]
```

Check verification and SSL status for a specific domain. Shows hostname, status, SSL status, and any verification errors.

Project resolution for domain commands follows the same order as deploy (`--project`, `VOID_PROJECT`, linked project).

## Agent

### `void init --agents`

Runs all agent setup steps:

1. **Instructions:** detects agents once and injects Void framework instructions with versioned markers.
2. **Skills:** links skills for the same detected or selected agent context.
3. **MCP config:** writes MCP server config for that same context, or prints generic MCP JSON in Generic mode.

If no agent is detected, `void init --agents` asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

## Environment variables

| Variable       | Purpose                                                      | Default |
| -------------- | ------------------------------------------------------------ | ------- |
| `VOID_TOKEN`   | Auth token override instead of saved config                  | none    |
| `VOID_PROJECT` | Default project slug for deploy, secret, and delete commands | none    |
