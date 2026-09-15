---
outline: deep
---

# Cloudflare

Void runs on Cloudflare Workers. This page covers how bindings work, how the plugin merges Cloudflare configuration, and how to deploy directly to your own Cloudflare account.

## Bindings

Void automatically infers and provisions Cloudflare bindings (D1, KV, R2, AI, Queues) by scanning your source files. There are two ways to access them at runtime depending on your setup.

### Via Hono context (`c.env`)

In Void's default routing mode, route handlers and middleware receive a Hono `Context` object with bindings on `c.env`:

```ts
// routes/api/users.ts
import { defineHandler } from 'void';

export const GET = defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM users').all();
  return c.json(results);
});
```

```ts
// routes/api/cache.ts
import { defineHandler } from 'void';

export const GET = defineHandler(async (c) => {
  const value = await c.env.KV.get('key');
  return c.json({ value });
});
```

`c.env` is fully typed via `CloudContext` -- no manual type declarations needed.

### Via `cloudflare:workers` import

When using framework mode (TanStack Start or React Router), the framework owns routing and you access bindings through the `cloudflare:workers` module instead:

::: warning ⚠️ Cloudflare env access in meta frameworks
Some frameworks, like Nuxt and SvelteKit, do not run in workerd during dev and therefore do not support directly importing from `cloudflare:workers`.
:::

```ts
import { env } from 'cloudflare:workers';

const result = await env.DB.prepare('SELECT * FROM users').all();
```

This also works in server functions:

```tsx
// src/routes/users.tsx (TanStack Start)
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';

const getUsers = createServerFn().handler(async () => {
  const { results } = await env.DB.prepare('SELECT * FROM users').all();
  return results;
});

export const Route = createFileRoute('/users')({
  loader: () => getUsers(),
  component: UsersPage,
});
```

### TypeScript setup

Add `"void/env"` to your tsconfig `types` to get typed bindings on `env`:

```json
{
  "compilerOptions": {
    "types": ["void/env"]
  }
}
```

This augments the `Cloudflare.Env` interface with `DB`, `KV`, `STORAGE`, `AI`, and `QUEUE_*` and also pulls in `@cloudflare/workers-types`, so you don't need to add that separately.

### Available bindings

| Binding          | Type                     | Trigger                                                         |
| ---------------- | ------------------------ | --------------------------------------------------------------- |
| `DB`             | `D1Database`             | `env.DB` / `c.env.DB` or `import from "void/db"`                |
| `KV`             | `KVNamespace`            | `env.KV` / `c.env.KV` or `import from "void/kv"`                |
| `STORAGE`        | `R2Bucket`               | `env.STORAGE` / `c.env.STORAGE` or `import from "void/storage"` |
| `AI`             | `Ai`                     | `env.AI` / `c.env.AI` or `import from "void/ai"`                |
| `QUEUE_*`        | `Queue<T>`               | `defineQueue()` or `import { queues } from "void/queues"`       |
| filename-derived | `DurableObjectNamespace` | module in `durable-objects/`                                    |

Bindings are [inferred automatically](../reference/resource-inference.md) by scanning your source files for import and access patterns. You can also set them explicitly in `void.json`:

```json
{
  "inference": {
    "bindings": { "db": true, "kv": true, "storage": false, "ai": true }
  }
}
```

`db`, `kv`, and `storage` accept a string to customize the binding name (e.g. `"db": "MY_DB"`). `ai` only accepts a boolean.

See [Configuration](../reference/config.md) for details.

### Cloudflare configuration passthrough

You can set non-binding Cloudflare fields like `compatibility_date` and `compatibility_flags` in `void.json`:

```json
{
  "worker": {
    "compatibility_date": "2026-02-24",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

For environment variables, use `.env` files for local values and secrets. Void automatically loads `.env` files through Vite's `loadEnv` and merges them into the worker's `vars` bindings:

```bash
# .env
API_URL=https://api.example.com
```

Binding arrays such as `d1_databases`, `kv_namespaces`, and `r2_buckets` are not allowed in the `worker` field because Void manages bindings for you. If you need custom bindings with real resource IDs, add a `wrangler.jsonc` to the project root instead. See [Cloudflare config merging](#cloudflare-config-merging) for details.

For non-secret plain-text defaults, you can also set `worker.vars` in `void.json`. Values from `.env` files override `worker.vars`.

## Cloudflare config merging

By default, Void configures the Cloudflare plugin programmatically, so you don't need a `wrangler.jsonc` for bindings. Void pins a Workers compatibility date in `void.json` `worker.compatibility_date`; if no date is already configured in `void.json` or `wrangler.jsonc`/`wrangler.json`, Void writes the latest known-good date to `void.json`. Bindings are inferred from your source code and provisioned with local placeholder IDs for development.

If you add a `wrangler.jsonc` (or `wrangler.json`) to your project root, Void respects it -- but **how** depends on whether Void owns the Cloudflare integration or a meta-framework does.

### Void-only mode and Vite-based frameworks

In Void's default mode and when using frameworks where Void controls the Cloudflare integration (TanStack Start, React Router), Void manages the `@cloudflare/vite-plugin` directly. It passes a `config` callback that merges inferred bindings into whatever the plugin resolves from your `wrangler.jsonc`:

1. The plugin reads your `wrangler.jsonc` and resolves it into a config object with `d1_databases`, `kv_namespaces`, `r2_buckets`, etc.
2. Void checks each inferred binding **by name** (e.g. `"DB"`, `"KV"`, `"STORAGE"`). If a binding with that name already exists in your config, it is left untouched.
3. Only bindings that are **missing** from your config are added with local placeholder IDs (e.g. `database_id: "local"`).
4. The merged config is used for both `vite dev` (Miniflare) and `vite build` (output `wrangler.json` in `dist/`).

All other fields in your `wrangler.jsonc` -- `name`, `routes`, `services`, `vars`, `env`, `compatibility_date`, etc. -- are preserved in the resolved config and flow through to the build output.

Fields that Void always sets (`main`, `triggers`, `assets`) don't need to be in your Cloudflare config -- they're added programmatically based on your project structure.

In this mode, normal inferred bindings are merged purely in memory. Typed state modules in `durable-objects/` are the exception: Void persists their bindings and `new_sqlite_classes` entries to `wrangler.jsonc` because Cloudflare Durable Object migration history must remain append-only across builds. Commit those entries.

### Adapter-based frameworks (SvelteKit, Nuxt, Astro)

When using SvelteKit, Nuxt, or Astro, the framework's own Cloudflare adapter owns the worker build and dev server. Void does **not** provide `@cloudflare/vite-plugin` in that setup. It only contributes DB type codegen, migration management, and binding sync.

Because Void doesn't control the CF plugin in this mode, it can't merge bindings via a config callback. Instead, on dev startup Void syncs inferred bindings directly to your `wrangler.jsonc` file on disk:

- Only adds bindings that are **missing** by name -- existing bindings are never modified or removed.
- If `worker.compatibility_date` is set in `void.json`, syncs that date into the Cloudflare config so the framework adapter reads the same value.
- Also ensures the `nodejs_als` compatibility flag is present.
- The framework adapter then reads this `wrangler.jsonc` normally.

This means your `wrangler.jsonc` is the single source of truth for bindings in this mode. Void keeps it up to date as you add new resource imports to your code, but you're responsible for replacing placeholder IDs with real ones before deploying.

### Merge precedence

| Source                     | Priority             | What it controls                                                    |
| -------------------------- | -------------------- | ------------------------------------------------------------------- |
| Your `wrangler.jsonc`      | Highest for bindings | Real resource IDs, service bindings, routes, vars, environments     |
| `void.json` `worker` field | Highest for compat   | `compatibility_date`, `compatibility_flags`, `vars`                 |
| Void inference             | Fills gaps only      | Adds placeholder bindings for inferred resources not in your config |

If no date is found in `void.json`, the project Cloudflare config, or the supported generated build fallback during deploy, Void pins the latest known-good date to `void.json` and uses it for that run.

### Example

If your code uses `c.env.DB` and `c.env.KV`, and your `wrangler.jsonc` only defines D1:

```jsonc
{
  "name": "my-app",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
  ],
  // Service bindings, routes, etc. are also preserved
  "services": [{ "binding": "API", "service": "my-api-worker" }],
}
```

Void sees that `DB` is already configured and leaves it alone (including your real `database_id`), but adds a local placeholder for `KV` since it's missing. The `services` array passes through unchanged.

This means `pnpm dev` works out of the box (Miniflare creates local instances of all bindings), while `void deploy --platform cloudflare` uses your real D1 database ID and service bindings.

### What ends up in the build output

After `vite build`, the Cloudflare Vite plugin writes a merged `wrangler.json` to the `dist/` directory. This file contains:

- All fields from your `wrangler.jsonc` (bindings with real IDs, routes, services, vars, environments)
- Any inferred bindings Void added (with placeholder IDs -- replace these before deploying)
- Fields set by Void (`main`, `assets`, `triggers`)

When you run `void deploy --platform cloudflare`, Void validates this generated `wrangler.json` and deploys it safely.

::: tip
When deploying to a Void platform, the `wrangler.json` in the build output is **skipped** because the platform manages Worker configuration through its own deploy manifest. The merge behavior described here applies to direct Cloudflare deployment.
:::

## Deploy to your own Cloudflare account

During `void init`, Cloudflare is the default deployment platform. The generated Worker is standard Cloudflare output, and Void deploys it directly to your own account.

When you choose Cloudflare, init creates or augments the root `wrangler.jsonc` with a compatibility date, checks your Cloudflare session through Void's bundled tooling, and opens secure browser sign-in if needed. A single available account is selected automatically; when your login can access multiple accounts, init asks which one to use. The resulting `account_id` is written to the config without removing comments or unrelated fields. If you skip sign-in, rerun `void init` or use `void cloudflare login` later.

[`void deploy --platform cloudflare`](#one-command-void-deploy-platform-cloudflare) provisions bindings, applies remote migrations, checks secrets, builds, then uploads, verifies, and activates a Worker Version for you. `void init` saves this choice so the override is normally unnecessary. The [Local development](#local-development), [AI](#ai-self-host), and [ISR](#isr-self-host) notes below also apply.

### One command: `void deploy --platform cloudflare`

`void deploy --platform cloudflare` deploys the built worker to **your own** Cloudflare account. Void owns the Cloudflare authentication flow and uses your root `wrangler.jsonc`; there is no Void platform login or linked project. When `.void/project.json` already contains `"platform": "cloudflare"`, plain `void deploy` takes the same path.

```bash
# Create or adopt missing resources, then deploy
void deploy --platform cloudflare
```

**Prerequisites**

- **Select an account.** Interactive `void init` or the first deploy signs you in, selects the sole account automatically or shows a Void account picker, and writes `account_id` to your root `wrangler.jsonc`. In CI, set `CLOUDFLARE_ACCOUNT_ID` when the token can access multiple accounts.
- **Authenticate with Cloudflare.** Interactive setup and deploy open secure browser OAuth immediately when needed and store credentials in the operating-system keychain; press Ctrl+C to cancel. You can explicitly manage the session with `void cloudflare login|status|logout`. CI uses `CLOUDFLARE_API_TOKEN`. Deploy needs `Workers Scripts:Edit` plus read on the resources you bind, and per-product `*:Edit` whenever automatic provisioning must create a missing D1 database, KV namespace, R2 bucket, Queue, or Hyperdrive config. Email setup needs a session from wrangler 4.81 or newer, which carries the Email Routing and Email Sending scopes, or a `CLOUDFLARE_API_TOKEN` that also has Email Routing Edit and Email Sending Edit (a Global API Key pair is refused).
- **Admit readiness probes through Cloudflare Access, when applicable.** If an Access policy protects the Worker's `workers.dev` hostname, export a complete `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` service-token pair that the policy allows. An interactive local deploy can instead export `CF_ACCESS_TOKEN="$(cloudflared access token --app=https://<worker>.<account>.workers.dev)"` to use the current user's short-lived session. Void sends either credential only to a matching HTTPS readiness URL, never to project build code or Cloudflare deployment tooling, and never stores it. When account-wide default-deny blocks a generated preview alias but the stable Worker hostname admits the credential, Void stages the new version at 0% and probes it through that stable hostname with a version override. An unresolved Access denial leaves a normal upload inactive or restores the prior 100% deployment; Cloudflare's required first-deploy bootstrap is already active behind Access when its probe is denied.
- **Identify the account's workers.dev subdomain in fresh CI, when version previews are unavailable.** Export `CLOUDFLARE_WORKERS_SUBDOMAIN` as the account subdomain (for example `my-team`, or `my-team.workers.dev`). Interactive/local deploys cache this value in ignored `.void/cloudflare.json` after a successful deploy reports a workers.dev URL, so it normally needs to be supplied only to a fresh checkout whose Worker uses Durable Objects or otherwise has no version preview URL.
- **`CLOUDFLARE_API_TOKEN` is required to provision a Hyperdrive config for the first time.** Browser OAuth covers every other resource, but the available Cloudflare tooling exposes no machine-readable Hyperdrive list, so Void checks whether the config already exists over the Cloudflare REST API, which OAuth cannot authenticate. Without a token automatic provisioning stops **before** touching your account rather than risk minting a duplicate config. Either export `CLOUDFLARE_API_TOKEN` with Hyperdrive edit permission, or create the Hyperdrive config in the dashboard and add its id to the `hyperdrive` binding in `wrangler.jsonc`; deploying an **already-provisioned** Hyperdrive app needs no token.
- **Workers Paid and Docker, if your app uses the sandbox.** Cloudflare Containers are unavailable on Workers Free, and the sandbox image is built locally. Before provisioning or building, Void verifies the selected account and credentials automatically. If the check fails, [enable Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans), then run `void cloudflare login` again; when using `CLOUDFLARE_API_TOKEN`, grant it Account / Containers: Edit and Account / Cloudchamber: Edit. See [Containers pricing](https://developers.cloudflare.com/containers/pricing/).

**What it does** (in order): settles the app class, pins the account and confirms Cloudflare authentication; when the app uses email (`sendEmail()` or `email/` handlers), reads your zone's email state and, before any project code runs, asks once to set it up (see the [email guide](../guide/email.md#your-own-cloudflare-account)); creates or adopts inferred resources, builds and validates the emitted artifact, preserves or creates the auth secret, applies checked-in PostgreSQL or MySQL migrations using `DATABASE_URL` (or remote D1 migrations), promotes explicit env schema `.secret()` values through Cloudflare's encrypted bulk-secret API, uploads an immutable Worker Version, probes that version directly for readiness, activates it at 100%, and synchronizes routes, custom domains, cron triggers, queue consumers, and Email Routing rules. PostgreSQL migrations are transactional; MySQL DDL is not.

Note that **the build runs before the secret, auth-schema, and migration gates** -- those gates read the real emitted worker, so there has to be one to read. A missing production secret or a bad migration is therefore reported _after_ resources may have been provisioned and the build has run, which is worth knowing if your build hooks are slow or have side effects. Remote D1 migrations and the worker upload still run only once every ground-truth gate has passed, so a failed gate does not alter the database schema or live worker.

**Trust boundary: the build runs your project's code.** This backend runs your project's build -- your config, every Vite plugin, and every build dependency -- with filesystem access before the credentialed deploy. Deploy narrows what that build can quietly change: it runs the build with your Cloudflare credentials scrubbed, verifies the emitted `wrangler.json` against a pre-build snapshot of your account, name, and binding identities, and checks that the bundled deployment tool was not modified during the build. Those checks catch a build that tampers with the deploy target or uploader. They do not sandbox the build itself, so a fully compromised build dependency remains a trust boundary. Vet your dependencies as you would for any deploy; stronger build isolation is future work.

Provisioning is automatic and **idempotent**. Void reads existing ids first, adopts matching resources when possible, creates anything missing, and writes the resolved ids into your root `wrangler.jsonc`. Queues carry no id in the config, so Void checks each one against your account and creates it when absent. Auth-enabled apps similarly reuse an existing `BETTER_AUTH_SECRET`; they generate a 32-byte random value only when the remote secret is absent, never once per deploy. The former `--provision` flag is still accepted for backwards compatibility but is no longer needed.

Activation is deliberately separate from upload. Void records the exact migration filenames and trigger snapshot in the Worker Version annotation, probes the uploaded version before it receives traffic, and only then promotes it to 100%. When Cloudflare exposes a version preview, Void probes that URL. Durable Object versions do not expose previews, so Void stages the new version at 0%, requests the production workers.dev URL with Cloudflare's version-override header, restores the prior deployment after a failed probe, and promotes only a ready version. If trigger synchronization fails, Void restores the previously active version. `void project status` lists available versions and `void project rollback [version]` activates one without rebuilding, then restores its versioned schedules, queues, workflows, routes, and domains. Versions that predate trigger snapshots cannot be rolled back safely and are rejected.

Cloudflare has three first-deploy exceptions: the Versions API cannot create a Worker, it cannot establish a new Worker's initial Durable Object migration history, and an account can leave preview URLs disabled until its first ordinary deployment. When Cloudflare requires an ordinary deploy for one of those reasons, Void first proves that the Worker did not exist before first-deploy secret provisioning, performs one guarded bootstrap deployment, then verifies the active Worker through `/__void/ready`. Cloudflare may create a placeholder version while attaching that first secret; Void carries its earlier absence proof across that step. This bootstrap is never used for a previously deployed application, because an ordinary deployment would bypass the readiness traffic guard. All later deployments return to immutable version upload, zero-traffic readiness probing, and explicit activation.

If the Worker already has a gradual deployment that splits traffic across versions, deploy stops before upload instead of flattening that rollout to 100%. Finish or cancel the gradual rollout in Cloudflare first.

#### Scope and limitations

- **Supported apps:** worker-bearing Void apps, static sites, SPAs, known SSGs, explicit `--dir` deploys, fully prerenderable Void Pages apps with `output: "static"`, and Cloudflare output from TanStack Start, React Router, vinext App Router, vinext Pages Router, SvelteKit, Nuxt, Analog, and Astro. Static deployments always use a thin Worker in front of Workers Assets so redirects, rewrites, fallbacks, and headers match the Void edge. Hybrid and SSR framework builds keep their generated application Worker. Worker-bearing apps support D1 (SQLite), KV, R2, Queues, typed SQLite-backed state from `durable-objects/`, PostgreSQL or MySQL through Hyperdrive, auth, WebSockets, AI, cron jobs, and ISR. Unsupported shapes fail closed **before** account operations, with guidance:
  - **Hybrid `output: "static"` remains worker-backed.** If a page opts out of prerendering, a dynamic page has no `getPrerenderPaths()`, or the app has another runtime feature, Void deploys the generated application Worker instead of dropping that functionality.
  - **WebSocket routes (`*.ws.ts`) use SQLite Durable Objects.** Void persists their bindings and append-only `new_sqlite_classes` history in `wrangler.jsonc`; commit that history and never delete or reorder deployed migration steps. Existing hosted projects whose earlier WebSocket classes used legacy `new_classes` keep those classes unchanged, while newly introduced classes use SQLite.
  - **Direct ISR uses the shared cache protocol.** Cache entries are deployment- and hostname-scoped, `routing.revalidateQueryAllowlist` creates bounded query variants, and `revalidate()` purges the direct entry plus every matching query variant from KV and the Cache API.
  - **Custom D1 migration layouts are supported.** When `migrations_dir`, `migrations_table`, or `migrations_pattern` is configured, Void resolves Cloudflare's exact file set and numeric order, then requires it to match the migration set it validated before any remote apply. Stray, missing, reordered, or byte-different SQL fails closed.
  - **Non-Cloudflare targets (`node` / `bun` / `deno`) are not supported here** -- this backend deploys Cloudflare Workers only.
  - **Email (`void/email`) is set up on the first deploy, on a zone you own.** Put `email.from` in `void.json`; the deploy reads your account, prints a checklist of what it would change, and asks once -- see [Your own Cloudflare account](../guide/email.md#your-own-cloudflare-account) in the email guide. What remains outside Void's reach: `email/_default.ts` and dynamic local parts (`email/[user].ts`) need a catch-all, which exists only on a zone apex, so on a mail subdomain they get no rule; a mail domain that already has non-Cloudflare MX records is refused, never routed over; `sendEmail()` to arbitrary recipients needs Workers Paid (Email Sending onboarding), otherwise verified destinations only; enabling routing on a subdomain goes through your session bearer and, if Cloudflare refuses it, falls back to a one-time dashboard step; in CI the email step never prompts -- run `void email setup --platform cloudflare` once, commit `wrangler.jsonc`, and deploy with `--require-email`; Void owns the top-level `addresses` array in `wrangler.jsonc`, so hand-written entries there skip the email step; and the `void email usage` / `logs` / `allow` / `destinations` commands are platform-only.
  - **`--skip-build` is limited to static deploys.** Static, SPA, and SSG output can be reused when its directory already exists. Worker-bearing apps require a fresh build because their checks validate the emitted worker `vars` and generated auth schema.
- **Sandbox requires Workers Paid.** Other Void SDK features on the native path remain Workers Free-compatible within Cloudflare's Free quotas. Importing `void/sandbox` or enabling `sandbox` in `void.json` is the opt-in that adds a Container application and triggers the entitlement preflight; apps that do not use it perform no Containers check.
- **PostgreSQL and MySQL migrations require `DATABASE_URL` in the deploy environment.** Cloudflare does not return the database password from an existing Hyperdrive config. The URL is used only to provision Hyperdrive and apply checked-in migrations before upload; it is never written to `wrangler.jsonc` or the generated Worker config.
- **Auth requires checked-in migrations that produce the Better Auth schema.** Run `void db generate`; when Void-managed auth is enabled, it resolves the production Better Auth configuration and includes its tables in Drizzle's schema input automatically, including configured renames and plugin tables. Review and commit the resulting SQL. Cloudflare deploy validates the generated schema against the checked-in migration history, then applies it with the application migrations. D1 receives an additional in-memory structural simulation before its remote apply; PostgreSQL relies on the dialect-aware Drizzle drift gate and transactional migration runner. If the generated schema and checked-in migration history differ, deploy fails closed and asks you to regenerate rather than mutating source during deployment.
- **Migrations must apply in the same order Void validated.** Deploy checks that the files Cloudflare will apply to remote D1, including a configured `migrations_pattern` and numeric-prefix ordering, exactly match Void's validated set -- no stray files, same content, same order. Deploy fails closed on a mismatch.
- **Avoid concurrent first deploys from different machines or CI runners.** The provisioning lock is per local config path and does not coordinate across hosts. Resource adoption makes later deploys idempotent, but two first deploys racing the same account could create duplicate resources whose names are not account-unique. Commit the updated `wrangler.jsonc` when practical so CI starts with the resolved ids.
- **Your `wrangler.jsonc` is rewritten on provision.** Void preserves your comments but may normalize the whole file's indentation when it writes new ids -- expect that in the diff.
- **Schema-marked secrets are encrypted automatically.** A key declared with a built-in helper's `.secret()` is removed from generated `vars`, bulk-uploaded over stdin, and added to `secrets.required`. Values can come from `.env`, `.env.production`, `.env.production.local`, or the deploy process environment (shell wins). Remote-only marked secrets are inherited, absent optional ones are skipped, and no remote secrets are pruned. Unmarked `.env` / `.env.production` values still ship as plaintext; unmarked local and shell values do not ship. Heuristic secret detection remains warning-only.
- **First deploy of a new worker.** Void can create schema-marked secrets on the draft Worker and automatically bootstraps `BETTER_AUTH_SECRET` for auth-enabled apps.
- **Named Cloudflare environments are intentionally not selected.** Direct commands always target the top-level root config and reject `CLOUDFLARE_ENV`, `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, and project-local name overrides. Use a separate checked-in root config per deployment target for now.
- **Operational commands follow the saved target.** `void secret list|put|sync|delete`, `void domain add|delete|list|status`, `void project status|list|logs|rollback`, `void db status`, `void db execute --remote`, and `void db migrate --remote` operate directly on the pinned Cloudflare Worker or D1 database when `.void/project.json` selects Cloudflare. Cloudflare logs are a live tail, not hosted historical log storage. Custom domains are stored as `custom_domain` routes and applied immediately through route-only trigger synchronization, so a domain edit cannot rewrite cron, queue, or workflow triggers. Deleting the final custom domain requires `CLOUDFLARE_API_TOKEN` with Workers Scripts: Edit permission because the standard trigger operation skips empty domain sets; Void uses Cloudflare's domain-record API for that one reconciliation and otherwise fails before changing state.
- **Database migrations remain forward-only during rollback.** Rolling back activates older code and restores the trigger snapshot Void stored with that Worker Version, but never reverses D1, PostgreSQL, or MySQL migrations. Void compares version annotations and asks for confirmation when older code will run against a newer schema, or when migration metadata is unavailable. A legacy version without a complete trigger snapshot is rejected instead of leaving non-versioned Cloudflare triggers attached to incompatible code.
- **Void does not tear down direct resources.** `void project delete` refuses for Cloudflare targets because inferred resources may be shared. Remove resources explicitly with Cloudflare tooling only after verifying ownership.

### Local development

`pnpm dev` continues to work as before -- Miniflare creates local instances of all bindings regardless of the IDs in your `wrangler.jsonc`. Your real resource IDs are only used during direct Cloudflare deployment.

### AI (self-host)

`void/ai` works on your own Cloudflare account, along two paths:

- **Workers AI** (`ai.run`, `ai.stream`, `ai.image`) works out of the box. When your app imports `void/ai`, `vite build` infers that you need AI and adds a Workers AI binding (`env.AI`) to the generated `wrangler.json` automatically -- you do **not** add it to `wrangler.jsonc`.
- **Provider models** (`ai.provider("openai").fetch(...)`) route through _your own_ Cloudflare AI Gateway. Set its id in `void.json` and add the provider's API key as a Worker secret.

```jsonc
// void.json
{
  "ai": {
    "gateway": "my-gateway", // an AI Gateway in YOUR Cloudflare account
  },
}
```

```bash
# provider API key, stored as a Worker secret (never committed)
void secret put OPENAI_API_KEY
```

```ts
// routes/chat.ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  // Workers AI -- uses env.AI directly
  const summary = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt: 'Summarize the changelog.',
  });

  // Provider model -- routes through your "my-gateway" AI Gateway,
  // authed with the OPENAI_API_KEY secret above
  const res = await ai.provider('openai').fetch('chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
  });

  return c.json({ summary, provider: await res.json() });
});
```

`ai.gateway` is required for `ai.provider().fetch()` -- without it, that call returns a `501`. No AI traffic or provider secret passes through Void's shared proxy: requests go directly to _your own_ Cloudflare AI Gateway, authenticated with provider secrets from _your_ Worker's environment. (The request and that secret are of course still sent onward to the AI Gateway and the upstream provider you call.)

Notes:

- **No cross-tenant usage metering.** On the Void platform, AI calls are metered and billed through a shared proxy. Self-hosted, there is no metering -- you get your own [Cloudflare AI Gateway analytics](https://developers.cloudflare.com/ai-gateway/) instead.
- **The runtime reads the `env.AI` binding by name** -- a custom-named root AI binding is not supported.
- **`void dev` has no local Workers AI emulation.** In development, AI still routes through Void, so `void dev` AI requires `void auth login` even when you deploy self-hosted.

### ISR (self-host)

[Revalidation (ISR)](../guide/edge/revalidation.md) works self-hosted. `void deploy --platform cloudflare` automatically creates or reuses the cache KV namespace and persists its `ISR_CACHE` binding in `wrangler.jsonc`, just like the other inferred resources.

Configure revalidation exactly as on the platform -- globally or per-path in `void.json`:

```jsonc
// void.json
{
  "routing": {
    "revalidate": { "/blog/*": 3600, "*": 60 },
  },
}
```

...or per page with an exported `revalidate` literal in a `.server.ts` companion (Pages mode):

```ts
// pages/blog/[slug].server.ts
export const revalidate = 3600; // seconds
```

On-demand purges work through `revalidate()`:

```ts
import { revalidate } from 'void/isr';

await revalidate({ paths: ['/blog/hello'] });
// or purge every ISR page:
await revalidate({ all: true });
```

Self-hosted, `revalidate()` purges this worker's own KV entries (global, authoritative) plus the current colo's edge cache.

Limits (the single-worker cache ladder can't do everything the platform's dispatch layer does):

- **No fleet-wide / cross-colo edge purge.** `revalidate()` clears KV globally and the _local_ colo's edge cache; other colos keep serving their edge copy until it expires (bounded by the response's `s-maxage`), then re-render on the next edge miss.
- **The pages-protocol JSON variant is not served from a cold colo's KV.** A colo that hasn't rendered the HTML yet re-renders the JSON live; the JSON edge cache is warmed only as a side effect of the HTML render path.
- **The warm cache is dropped on every redeploy.** Each `vite build` bakes a fresh deployment id into the cache keys, so cached HTML never outlives the hashed assets it references -- the first request after a deploy is a cold render.
