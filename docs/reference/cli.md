---
outline: deep
---

# CLI

`void` is a local binary from the installed `void` package.

## Cheat Sheet

| Command                           | Purpose                                 |
| --------------------------------- | --------------------------------------- |
| `void deploy`                     | Build and deploy to Void                |
| `void gen model <name> [cols...]` | Scaffold migration + CRUD routes        |
| `void gen route <path>`           | Create an API route                     |
| `void db status`                  | Show local/remote migration status      |
| `void db reset`                   | Drop and re-apply all migrations        |
| `void db seed`                    | Reset + seed local database             |
| `void db studio`                  | Open Drizzle Studio for local database  |
| `void secret put <name=value>`    | Set a production secret                 |
| `void secret sync .env.local`     | Bulk upload secrets from dotenv file    |
| `void auth login`                 | Authenticate with Void                  |
| `void project link`               | Link directory to a project             |
| `void project logs`               | Show runtime logs from deployed project |
| `void project rollback`           | Roll back to a previous deployment      |
| `void init`                       | Setup wizard (tsconfig, agents, CI)     |

## Binary Invocation

Outside of npm scripts, you need to invoke `void` with `npx`, `pnpm`, `yarn`, or `bunx`. For brevity, docs show unprefixed `void` usage — just remember it needs a binary runner.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `void` directly when you are in the root directory of your app.

:::warning ⚠️ Prefer local install
We do not recommend installing `void` globally, because the CLI needs to be in sync with same version of the runtime framework. Always install `void` locally as a dev dependency of your project.
:::

## Setup

### `void init`

```
void init [--tsconfig] [--github] [--agents]
```

Setup wizard for void projects (new or existing). If run in an empty directory, it scaffolds a starter app first. Then it walks through:

1. **TypeScript** — creates or updates `tsconfig.json` (adds `extends .void/tsconfig.json` and `void/env` types)
2. **Agent instructions** — detects agents once and injects instructions into `CLAUDE.md` or `AGENTS.md`
3. **Skills** — links void skills using the same detected/selected agent context
4. **MCP config** — writes MCP server config using the same detected/selected agent context
5. **Demo code** — optionally scaffolds a migration, API route, and typed fetch example
6. **GitHub Actions** — optionally creates `.github/workflows/deploy.yml` with the correct package manager commands

If no agent is detected, `void init` asks you to choose one from a short list (Claude, Cursor, Codex, Gemini CLI, Generic). That single choice is reused across all agent steps.

Use flags to run individual steps without prompts:

| Flag         | Purpose                                           |
| ------------ | ------------------------------------------------- |
| `--tsconfig` | Only update `tsconfig.json`                       |
| `--agents`   | Set up agent instructions, skills, and MCP config |
| `--github`   | Only create GitHub Actions workflow               |

Flags can be combined. When any flag is provided, only the specified steps run and interactive prompts are skipped.

## Auth

### `void auth login`

OAuth login (GitHub or Google — you choose at the prompt). Saves token to `~/.void/config.json`.

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
void project logs [--filter <text>] [--range <duration>] [--deployment <id>]
```

Show runtime logs from the deployed project. Uses the linked project from `.void/project.json`.

| Flag                 | Purpose                                                                                                         | Default |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------- |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                                                 | `1h`    |
| `--filter <text>`    | Case-insensitive text match against log/exception messages. Shows full request entry when any log line matches. | —       |
| `--deployment <id>`  | Filter logs to a specific deployment ID.                                                                        | —       |

Output shows one line per request (`HH:MM:SS METHOD URL STATUS`) with indented console log and exception lines beneath. Errors and exceptions are colored red, warnings yellow.

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

## Deploy

### `void deploy`

```
void deploy [--project <name>] [--dir <path>] [--spa] [--skip-build]
```

Auto-detects your project type and chooses the right pipeline. See [Supported App Types](../guide/app-types.md) and [Deployment](../guide/deployment.md) for details.

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

If no project is linked and no override is provided, CLI prompts to link or create one.

## Database

### `void db status`

Show migration status. Displays which migrations are applied or pending locally. When logged in and linked to a project, also shows remote status.

### `void db reset`

Drop the local D1 database and re-apply all migrations. Does not affect the remote database.

### `void db seed`

```
void db seed [--file <path>]
```

Reset the local database, re-apply all migrations, then execute a seed file. Defaults to `migrations/seed.sql`. The seed file is excluded from migration collection — it's never deployed or applied as a migration.

### `void db execute`

```
void db execute <sql>
void db execute --file <path>
```

Run ad-hoc SQL against the local D1 database. Provide SQL inline or from a file. SELECT queries display results as a formatted table; other statements execute silently.

### `void db migrate`

```
void db migrate
```

Apply pending migrations to the local database without resetting. Unlike `void db reset`, this preserves existing data and only runs migrations that haven't been applied yet.

### `void db studio`

Open [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio) for the local D1 database. Launches a web-based GUI for browsing and editing your data.

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

- `migrations/NNN_create_posts.sql` — CREATE TABLE with `id` (autoincrement), your columns, and `created_at`
- `routes/api/posts/index.ts` — GET (list all) + POST (insert with validation)
- `routes/api/posts/[id].ts` — GET by id with 404 handling
- Regenerated `.void/db.d.ts`

The generated routes automatically detect your validation library from `package.json` (valibot, zod, or arktype). If none is found, you'll be prompted to choose one or skip validation. See [Database — Scaffolding](../guide/database.md#scaffolding) for the full type mapping.

Column format: `name:type` or `name:type?` (nullable). Types: `string`, `text`, `datetime`, `integer`, `boolean`, `real`, `blob`.

Model names must be lowercase alphanumeric with underscores (e.g. `posts`, `user_roles`). Existing files are never overwritten.

### `void gen migration`

```
void gen migration <name>
```

Create an empty migration file with auto-numbered prefix. The number is one greater than the highest existing migration.

```sh
void gen migration add_avatar_to_users
# → migrations/002_add_avatar_to_users.sql
```

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

- `src/main.ssr.{tsx,ts}` — server entry with `defineRender`
- `src/main.client.{tsx,ts}` — client entry with hydration
- `src/App.{tsx,vue,svelte}` — minimal interactive component

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

1. **Instructions** — detects agents once and injects Void framework instructions with versioned markers
2. **Skills** — links skills for that same detected/selected agent context
3. **MCP config** — writes MCP server config for that same detected/selected agent context (or prints generic MCP JSON for Generic mode)

If no agent is detected, `void init --agents` asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

## Environment variables

| Variable       | Purpose                                                | Default |
| -------------- | ------------------------------------------------------ | ------- |
| `VOID_TOKEN`   | Auth token override (instead of saved config)          | —       |
| `VOID_PROJECT` | Default project slug for deploy/secret/delete commands | —       |
