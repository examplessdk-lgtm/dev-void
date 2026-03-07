---
outline: deep
---

# Cloudflare

Void runs on Cloudflare Workers. This page covers how bindings work, how the plugin merges your wrangler config, and how to deploy directly to your own Cloudflare account.

## Bindings

Void automatically infers and provisions Cloudflare bindings (D1, KV, R2, AI, Queues) by scanning your source files. There are two ways to access them at runtime depending on your setup.

### Via Hono context (`c.env`)

In Void's default routing mode, route handlers and middleware receive a Hono `Context` object with bindings on `c.env`:

```ts
// routes/api/users.ts
import { defineHandler } from "void";

export const GET = defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users").all();
  return c.json(results);
});
```

```ts
// routes/api/cache.ts
import { defineHandler } from "void";

export const GET = defineHandler(async (c) => {
  const value = await c.env.KV.get("key");
  return c.json({ value });
});
```

`c.env` is fully typed via `CloudContext` -- no manual type declarations needed.

### Via `cloudflare:workers` import

When using framework mode (TanStack Start, React Router, SolidStart), the framework owns routing and you access bindings through the `cloudflare:workers` module instead:

::: warning ⚠️ Cloudflare env access in meta frameworks
Some frameworks, like Nuxt and SvelteKit, do not run in workerd during dev and therefore do not support directly importing from `cloudflare:workers`.
:::

```ts
import { env } from "cloudflare:workers";

const result = await env.DB.prepare("SELECT * FROM users").all();
```

This also works in server functions:

```tsx
// src/routes/users.tsx (TanStack Start)
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const getUsers = createServerFn().handler(async () => {
  const { results } = await env.DB.prepare("SELECT * FROM users").all();
  return results;
});

export const Route = createFileRoute("/users")({
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

| Binding   | Type          | Trigger                                                         |
| --------- | ------------- | --------------------------------------------------------------- |
| `DB`      | `D1Database`  | `env.DB` / `c.env.DB` or `import from "void/db"`                |
| `KV`      | `KVNamespace` | `env.KV` / `c.env.KV` or `import from "void/kv"`                |
| `STORAGE` | `R2Bucket`    | `env.STORAGE` / `c.env.STORAGE` or `import from "void/storage"` |
| `AI`      | `Ai`          | `env.AI` / `c.env.AI` or `import from "void/ai"`                |
| `QUEUE_*` | `Queue<T>`    | `defineQueue()` or `import from "void/queue"`                   |

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

### Wrangler passthrough

You can set non-binding wrangler fields like `compatibility_date` and `compatibility_flags` in `void.json`:

```json
{
  "worker": {
    "compatibility_date": "2026-02-12",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

For environment variables, use `.env` files instead of `worker.vars` — Void automatically loads `.env` files via Vite's `loadEnv` and merges them into the worker's `vars` bindings:

```bash
# .env
API_URL=https://api.example.com
```

Binding arrays (`d1_databases`, `kv_namespaces`, `r2_buckets`) are not allowed in the `worker` field — bindings are fully managed by Void. To use custom bindings with real resource IDs, add a `wrangler.jsonc` to your project root instead. See [Wrangler config merging](#wrangler-config-merging) for how Void handles this.

## Wrangler config merging

By default, Void configures the Cloudflare plugin entirely programmatically -- you don't need a `wrangler.jsonc`. Bindings are inferred from your source code and provisioned with local placeholder IDs for development.

If you add a `wrangler.jsonc` (or `wrangler.json`) to your project root, Void respects it -- but **how** depends on whether Void owns the Cloudflare integration or a meta-framework does.

### Void-only mode and Vite-based frameworks

In Void's default mode and when using frameworks where Void controls the Cloudflare integration (TanStack Start, React Router), Void manages the `@cloudflare/vite-plugin` directly. It passes a `config` callback that merges inferred bindings into whatever the plugin resolves from your `wrangler.jsonc`:

1. The plugin reads your `wrangler.jsonc` and resolves it into a config object with `d1_databases`, `kv_namespaces`, `r2_buckets`, etc.
2. Void checks each inferred binding **by name** (e.g. `"DB"`, `"KV"`, `"STORAGE"`). If a binding with that name already exists in your config, it is left untouched.
3. Only bindings that are **missing** from your config are added with local placeholder IDs (e.g. `database_id: "local"`).
4. The merged config is used for both `vite dev` (Miniflare) and `vite build` (output `wrangler.json` in `dist/`).

All other fields in your `wrangler.jsonc` -- `name`, `routes`, `services`, `vars`, `env`, `compatibility_date`, etc. -- are preserved in the resolved config and flow through to the build output.

Fields that Void always sets (`main`, `triggers`, `assets`) don't need to be in your wrangler config -- they're added programmatically based on your project structure.

In this mode, Void does **not** modify your `wrangler.jsonc` file on disk. The merge is purely in-memory.

### Adapter-based frameworks (SvelteKit, Nuxt, Astro)

When using SvelteKit, Nuxt, or Astro, the framework's own Cloudflare adapter owns the worker build and dev server. Void does **not** provide the `@cloudflare/vite-plugin` — instead, it only contributes DB type codegen, migration management, and binding sync.

Because Void doesn't control the CF plugin in this mode, it can't merge bindings via a config callback. Instead, on dev startup Void syncs inferred bindings directly to your `wrangler.jsonc` file on disk:

- Only adds bindings that are **missing** by name -- existing bindings are never modified or removed.
- Also ensures the `nodejs_als` compatibility flag is present.
- The framework adapter then reads this `wrangler.jsonc` normally.

This means your `wrangler.jsonc` is the single source of truth for bindings in this mode. Void keeps it up to date as you add new resource imports to your code, but you're responsible for replacing placeholder IDs with real ones before deploying.

### Merge precedence

| Source                     | Priority             | What it controls                                                    |
| -------------------------- | -------------------- | ------------------------------------------------------------------- |
| Your `wrangler.jsonc`      | Highest for bindings | Real resource IDs, service bindings, routes, vars, environments     |
| `void.json` `worker` field | Highest for compat   | `compatibility_date`, `compatibility_flags`, `vars`                 |
| Void inference             | Fills gaps only      | Adds placeholder bindings for inferred resources not in your config |
| Built-in defaults          | Lowest               | `compatibility_date: "2026-02-12"` when nothing else is set         |

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

This means `pnpm dev` works out of the box (Miniflare creates local instances of all bindings), while `wrangler deploy` uses your real D1 database ID and service bindings.

### What ends up in the build output

After `vite build`, the Cloudflare Vite plugin writes a merged `wrangler.json` to the `dist/` directory. This file contains:

- All fields from your `wrangler.jsonc` (bindings with real IDs, routes, services, vars, environments)
- Any inferred bindings Void added (with placeholder IDs -- replace these before deploying)
- Fields set by Void (`main`, `assets`, `triggers`)

When you run `wrangler deploy`, it picks up this generated `wrangler.json` and deploys everything.

::: tip
When deploying via `void deploy` (to the Void platform), the `wrangler.json` in the build output is **skipped** -- the platform manages worker configuration via its own deploy manifest. The merge behavior described here only applies to direct `wrangler deploy`.
:::

## Deploy to your own Cloudflare account

Void's default deployment path is `void deploy`, which uploads to the Void platform. But the generated worker is a standard Cloudflare Worker -- you can deploy it directly to your own account with `wrangler deploy`.

### 1. Create your resources

Create whatever bindings your app uses:

```bash
# D1 database
wrangler d1 create my-app-db

# KV namespace
wrangler kv namespace create KV

# R2 bucket
wrangler r2 bucket create my-app-storage
```

### 2. Add a `wrangler.jsonc`

Create `wrangler.jsonc` in your project root with the resource IDs from step 1:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-12",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "<your-database-id>",
    },
  ],
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "<your-namespace-id>",
    },
  ],
  "r2_buckets": [
    {
      "binding": "STORAGE",
      "bucket_name": "my-app-storage",
    },
  ],
}
```

Only include the bindings your app actually uses. You can also add service bindings, custom routes, environment overrides, and any other standard wrangler fields -- they all flow through to the build output. You don't need `main` or `assets` -- those are set by the plugin.

### 3. Run migrations

If your app uses D1, apply migrations before deploying:

```bash
wrangler d1 migrations apply DB --remote
```

This uses the same `migrations/` directory that Void uses locally.

### 4. Build and deploy

```bash
vite build && wrangler deploy
```

That's it. The Cloudflare Vite plugin produces a complete build output with a merged `wrangler.json` in the dist directory (containing your real resource IDs and any inferred bindings), and `wrangler deploy` picks it up.

### Local development

`pnpm dev` continues to work as before -- Miniflare creates local instances of all bindings regardless of the IDs in your `wrangler.jsonc`. Your real resource IDs are only used when you run `wrangler deploy`.
