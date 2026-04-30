# void

Core Vite plugin — routing, inference, migrations, CLI.

## Architecture

The main export `voidPlugin()` returns an array of Vite plugins. For the default Cloudflare target, this includes the `cloudflare()` plugin. For non-CF targets (`node`, `bun`, `deno`), it replaces `cloudflare()` with `nodeTargetPlugin()`:

```
# Cloudflare (default)
voidPlugin() → [routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]

# Node.js / Bun / Deno
voidPlugin() → [routingPlugin, prerenderPlugin, nodeTargetPlugin()]
```

Non-CF targets disable CF-only bindings (`void/db`, `void/kv`, `void/auth`, `void/storage`, `void/ai`, `void/env`, `void/ws`) at compile time. The `nodeTargetPlugin` provides a binding guard (compile-time errors for CF imports), a Vite dev server middleware (SSR-loads the Hono app), and a build entry generator for the target runtime.

### Runtime Framework

**Hono** is used as the runtime framework. The generated virtual module creates a Hono app with file-based routes and middleware. Route handlers receive a Hono `Context` object (`c`) and can use the full Hono API (`c.json()`, `c.text()`, `c.req.param()`, etc.) plus the Hono middleware ecosystem.

- `defineHandler(fn)` — wraps a route handler `(c: CloudContext) => R`, returns `TypedHandler<{}, R>`
- `defineHandler.withValidator(validators)(fn)` — validates body/query/params via Standard Schema before calling handler, returns `TypedHandler<V, R>` with phantom types for codegen
- `defineMiddleware(fn)` — wraps Hono middleware `(c, next) => void`
- Handlers can return plain objects/strings (auto-converted via `convertReturnValue`) or use Hono's `c.json()` / `c.text()` directly.
- Route files use **named HTTP method exports** (`export const GET`, `export const POST`, etc.) — one file per path, multiple methods per file.

### Source Layout

```
src/
  index.ts                  # Main export: voidPlugin() → Plugin[]
  config.ts                 # readConfig(), VoidConfig, convertHeadersConfig(), redirect/header helpers
  plugin-routing.ts         # Virtual module resolution, file watching, HMR, type codegen
  plugin-node-target.ts     # Non-CF deploy targets (Node.js, Bun, Deno) — binding guard, dev server, build entry
  plugin-inference.ts       # Binding inference orchestration (calls walk.ts)
  plugin-migration.ts       # Local migration runner on dev startup
  standard-schema.ts        # Inlined Standard Schema V1 types (no @standard-schema/spec dep)
  routes-stub.ts            # Empty RouteMap/WebSocketRouteMap interfaces (augmented by generated routes.d.ts)
  router/
    parse-filename.ts       # Route filename → RouteDefinition (pure function)
    detect-exports.ts       # Detects named HTTP method exports (GET, POST, etc.) via parseSync
    websocket.ts            # .ws.ts scanner + DO class metadata extraction
    scan.ts                 # Filesystem scanner using tinyglobby + export detection
    compile.ts              # Generates Hono app code + worker entry + websocket wiring
  codegen/
    route-types.ts          # Generates .void/routes.d.ts (RouteMap + WebSocketRouteMap)
    db-types.ts             # (removed — Drizzle schema is now the type source)
    queue-types.ts          # Generates .void/queues.d.ts (QueueMap with payload types)
  queues/
    scan.ts                 # Queue file scanner (queues/ dir, name from filename + consumer options)
  runtime/
    handler.ts              # defineHandler(), defineHandler.withValidator(), defineMiddleware(), defineHead(), defineQueue()
    queues.ts               # QueueMap stub interface + typed `queues` proxy using env.QUEUE_*
    validator.ts            # runValidation() — Standard Schema body/query/params validation
    response.ts             # convertReturnValue() — return → Response
    fetch.ts                # Typed fetch client for void/client
    fetch-stream.ts         # SSE stream consumer (fetchStream) for void/client
    ws.ts                   # defineRoom(), defineWebSocket(), typed connect() client
    ws-server.ts            # DO runtime helpers for generated websocket routes
    ai.ts                   # AI proxy — auto-detects backend (service binding / HTTPS / direct binding)
    db.ts                   # Drizzle D1 instance (auto-wired with user schema via virtual module)
  inference/
    walk.ts                 # AST walking with vite's parseSync + estree-walker
  migrations/
    runner.ts               # Applies pending migrations via drizzle-orm's programmatic migrate()
    collect.ts              # Reads .sql files from db/migrations/ dir, sorted by filename
    validate.ts             # Destructive-op detection + pragma enforcement
  cli/
    cli.ts                  # CLI entry: `void deploy|link|login`
    deploy.ts               # Orchestrator: build → collect/validate migrations → package → upload
    project.ts              # Reads/creates .void/project.json (projectId + slug only)
    auth.ts                 # Token read/save + runLogin() (local server + browser OAuth)
    login.ts                # Login command UI (@clack/prompts)
    package.ts              # Packages dist/ into FormData (worker + assets + migrations + manifest)
    agents.ts               # Shared agent configs, detection, MCP config targets
    client.ts               # HTTP client for platform API
    types.ts                # DeployManifest, MigrationMeta types
```

### Key Design Decisions

- **Import redirection**: The routing plugin's `resolveId` hook redirects bare `"void"` imports to `void/handler` (the lightweight subpath). Without this, route files pull the entire plugin (vite, @cloudflare/vite-plugin, lightningcss) into the Worker bundle. Uses `import.meta.resolve()` to compute absolute paths at plugin init.
- **Pre-resolved paths in codegen**: Generated virtual module code uses absolute paths for `hono` and `void/response` (resolved via `import.meta.resolve()`). Virtual modules have no filesystem location, so bare specifiers can't resolve from them.
- **CF plugin API**: Worker config (`main`, `d1_databases`, `kv_namespaces`, `r2_buckets`) goes inside the `config` option of `cloudflare()`, NOT as top-level properties. `persistState` takes `{ path: string }`, not a raw string. The `config` option uses a **function form** `(resolved: WorkerConfig) => Partial<WorkerConfig>` so that bindings from the user's `wrangler.json` (if present) take precedence over inferred placeholder bindings.
- **Migration DB path**: Miniflare stores D1 data at a deterministic path computed from the `database_id` using HMAC-SHA256. The `getMiniflareDatabasePath()` function in `migrations/runner.ts` replicates this algorithm so migrations target `<persist-root>/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` (for example `.void/v3/...` in default/class-A mode and `.wrangler/state/v3/...` in class-B/C framework mode).
- **Drizzle-first database**: Schema is defined in `db/schema.ts` (Drizzle table definitions). `void/db` exports a Drizzle D1 instance. `@schema` is an auto-configured alias for `db/schema.ts`. Migrations live in `db/migrations/`. CLI commands: `void db push` (prototype), `void db generate` (create migration files), `void db migrate` (apply locally). `drizzle-orm` and `drizzle-kit` ship with void.
- **Journal coherence invariant**: `db/migrations/*.sql` and `db/migrations/meta/_journal.json` must stay in sync — every `.sql` file has a matching journal entry (by `tag`) and vice versa. `assertJournalCoherence` in `src/migrations/validate.ts` is the gate, called from `deploy`, `db status`, `db migrate`, and `db reset`. The two CLI commands that mutate migration state — `void gen migration` and `void db rename-migrations` — are responsible for keeping the journal coherent themselves: the first appends a new entry when writing a file (failing loud if the journal is missing — run `drizzle-kit generate` first), the second rewrites `tag` values alongside the file renames and also renames the matching `meta/<prefix>_snapshot.json` (with byte-level rollback on failure). `gen migration` additionally copies the previous `meta/<idx:04d>_snapshot.json` forward to the new idx so drizzle-kit's drop/rollback tooling keeps working on mixed hand-written + drizzle projects; projects without prior snapshots are skipped silently. Drift will fail loudly before touching any remote DB. Motivated by [void-sdk/void#6](https://github.com/void-sdk/void/issues/6), where an orphan scaffolded `.sql` file half-applied against D1 and wedged the deploy.

### Package Exports

| Subpath          | What                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `void`           | `voidPlugin()` named export + `defineHandler` + `defineMiddleware` + `defineHead` + `defineQueue` + `CloudContext` type |
| `void/handler`   | `defineHandler()`, `defineHandler.withValidator()`, `defineMiddleware()`, `defineHead()`, types                         |
| `void/response`  | `convertReturnValue()`                                                                                                  |
| `void/validator` | `runValidation()`, `ValidatorSlots`, `HandlerInput` types                                                               |
| `void/routes`    | Empty `RouteMap` + `WebSocketRouteMap` stubs (augmented by generated `routes.d.ts`)                                     |
| `void/client`    | Typed `fetch()` client + `fetchStream()` SSE consumer + `FetchError`                                                    |
| `void/ws`        | `defineRoom()`, `defineWebSocket()`, typed `connect()`, and WebSocket context types                                     |
| `void/db`        | `db` Drizzle D1 instance (auto-wired with user schema) + `createDb()` for custom D1 bindings                            |
| `void/queues`    | `queues` typed proxy + `QueueMap` stub interface (augmented by generated `queues.d.ts`)                                 |
| `void/ai`        | `ai` proxy — `ai.run()`, `ai.stream()`, `ai.models()` with auto-detected backend (service binding / HTTPS / direct)     |
| `void/log`       | `logger.error/warn/info(msg, fields?)` — emits stringified JSON to `console.*` so Cloudflare Tail captures level + msg  |
| `void/env`       | `defineEnv()`, typed `env` proxy, built-in schema helpers (`string`, `number`, `oneOf`, …) + global Cloudflare types    |

The CLI binary is at `dist/cli/cli.mjs` (declared in `bin` field of package.json).

### Internal Staging Projects

Internal-only staging is selected per linked project with `.void/project.json`:

```json
{
  "projectId": "proj_...",
  "slug": "my-app",
  "voidInternalStaging": true
}
```

A pre-link file containing only `{ "voidInternalStaging": true }` is valid for Void platform developers who need `void auth login` or `void project link` to target staging before a project is linked.

When `voidInternalStaging` is true:

- **Token**: reads/writes `stagingToken` in `~/.void/config.json` instead of `token`
- **API URL**: defaults to `https://api.void.cloud` (prod); when staging is active, uses `https://api.staging.void.cloud` (unless overridden by `VOID_API_URL` or `api` config field)
- **Site domain**: uses `staging.void.app` for generated project URLs
- **Proxy**: injects staging proxy bindings for local dev AI and prerendering

Build output uses `.mjs` / `.d.mts` extensions (tsdown 0.20.3 default).

### Route Filename Parsing Rules

Applied in order to a path relative to `routes/`:

1. Strip extension (`.ts`, `.js`, `.mts`, `.mjs`)
2. Strip env suffix (`.dev`, `.prod`)
3. Strip trailing `index`
4. Remove route group dirs `(groupname)`
5. Convert `[param]` → `:param`, `[...param]` → `:param{.+}`, `[...]` → `*`
6. Prefix with `/`

HTTP methods are determined by **named exports** in each file (detected by `detect-exports.ts` via `parseSync`), not by filename suffixes. Files/dirs starting with `_` are ignored by the scanner.

## Code Generation (`void gen`)

Rails/Laravel-style scaffolding commands for common boilerplate:

| Command                                            | Creates                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `void gen model <name> [cols...]`                  | Drizzle table in `db/schema/` + barrel export + CRUD routes |
| `void gen migration <name>`                        | Empty migration file with auto-numbered prefix              |
| `void gen route <path> [--methods get,post,...]`   | Route file with `defineHandler` exports                     |
| `void gen middleware <name>`                       | Numbered middleware file with `defineMiddleware`            |
| `void gen ssr [--react\|--vue\|--svelte\|--solid]` | SSR entry + client entry + App component                    |
| `void gen cron <name>`                             | Cron job file with `defineScheduled` in `crons/`            |
| `void gen queue <name>`                            | Queue consumer file with `defineQueue`                      |

Column types for `gen model`: `string`, `text`, `datetime` → `text()`, `integer` → `integer()`, `boolean` → `integer({ mode: "boolean" })`, `real` → `real()`. Append `?` for nullable (omits `.notNull()`).

`gen model` creates Drizzle table definitions in `db/schema/` and updates the `db/schema.ts` barrel export. Auto-detects your validation library (valibot, zod, or arktype) from `package.json`. If none is found, prompts to choose one or skip validation.

Source: `src/cli/gen-args.ts` (arg parsing), `src/cli/gen.ts` (command runner). Tests: `test/unit/gen-args.test.ts`, `test/unit/gen.test.ts`.

## Coding Agent Integration

Void ships with first-class support for coding agents (Claude Code, Cursor, Codex, etc.):

- **`AGENT_PROMPT.md`** — compressed reference prompt shipped in the `void` npm package. Covers project structure, routing, DB, auth, typed fetch, KV/storage/queues/cron, CLI, and deployment.
- **`skills/`** — Claude Code skills shipped in the npm package:
  - `void` — unified app + CLI skill covering project architecture, runtime APIs, deployment flows, and CLI operations (deploy, db, gen, secrets, domains, projects) with lazy-loaded reference files.
  - `migrate-cloudflare-to-void` — guides migration from `@cloudflare/vite-plugin` to `void`.
- **`docs/`** — all 23 docs markdown files are included in the npm package at `node_modules/void/docs/`.
- **`void init --agents`** — runs all agent setup steps from a single detection/selection pass: injects Void instructions with versioned markers, symlinks skills from the `void` package, and writes MCP config (or prints manual commands/JSON for unsupported/generic agents).
- **`void init` in an empty directory** — scaffolds a Pages-mode starter (React, Vue, Svelte, or Solid), then lets you pick D1, PostgreSQL, or Static Pages before running the same setup flow.

Agent instructions use versioned markers (`<!--injected-by-void-v0.0.1-->` / `<!--/injected-by-void-->`) for safe update-in-place across version upgrades.

## Tests

| Test file                                   | Covers                                                         |
| ------------------------------------------- | -------------------------------------------------------------- |
| `test/unit/parse-filename.test.ts`          | Route filename parsing (21 tests)                              |
| `test/unit/scan.test.ts`                    | Filesystem scanning + queue consumers (13 tests)               |
| `test/unit/detect-exports.test.ts`          | Named HTTP method export detection (8 tests)                   |
| `test/unit/compile.test.ts`                 | Code generation + queue routes (10 tests)                      |
| `test/unit/response.test.ts`                | Return value → Response (8 tests)                              |
| `test/unit/inference.test.ts`               | AST-based binding inference + queues + AI (19 tests)           |
| `test/unit/fetch-stream.test.ts`            | SSE stream consumer (fetchStream) (5 tests)                    |
| `test/unit/validate-migrations.test.ts`     | Destructive-op detection + pragma (12 tests)                   |
| `test/unit/collect-migrations.test.ts`      | Migration file collection (4 tests)                            |
| `test/unit/validator.test.ts`               | Standard Schema validation runtime (8 tests)                   |
| `test/unit/validator-real-schemas.test.ts`  | Real schema validation (zod/valibot/arktype) (16 tests)        |
| `test/unit/define-handler.test.ts`          | defineHandler + middleware composition (18 tests)              |
| `test/unit/fetch.test.ts`                   | Typed fetch client (9 tests)                                   |
| `test/unit/ws.test.ts`                      | Typed websocket client (3 tests)                               |
| `test/unit/route-types.test.ts`             | Route type codegen output (6 tests)                            |
| `test/unit/route-type-extraction.test.ts`   | Type extraction pipeline (Serialize + ExtractInput) (14 tests) |
| `test/unit/db.test.ts`                      | Drizzle D1 instance + schema wiring (25 tests)                 |
| `test/unit/queue-types.test.ts`             | Queue type codegen output (3 tests)                            |
| `test/unit/plugin-node-target.test.ts`      | Node target plugin — binding guard, plugin creation (5 tests)  |
| `test/integration/node-target.test.ts`      | Node app playground — dev server + production build (5 tests)  |
| `test/integration/queue-playground.test.ts` | Queue send → consumer → KV round-trip (1 test)                 |
