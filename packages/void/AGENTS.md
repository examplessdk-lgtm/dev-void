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
- `basicAuth(options)` — built-in Basic Auth middleware for temporary site gates; excludes Void internals under `/__void`
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
  durable/
    scan.ts                 # durable-objects/* convention → binding/class/migration metadata
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
    durable.ts              # defineDurableState(), typed RPC stubs, persistence + state migrations
  inference/
    walk.ts                 # AST walking with vite's parseSync + estree-walker
  migrations/
    runner.ts               # Applies pending migrations via drizzle-orm's programmatic migrate()
    collect.ts              # Reads .sql files from db/migrations/ dir, sorted by filename
    validate.ts             # Destructive-op detection + pragma enforcement
  cli/
    cli.ts                  # CLI entry: `void deploy|link|login`
    deploy.ts               # Managed/native target dispatch and deployment orchestration
    cloudflare-deploy/
      classify.ts           # Fail-closed native app-shape classifier
      config.ts             # Shared Wrangler JSON/JSONC config readers
      execute.ts            # Verified final Wrangler upload executor
    cloudflare-operations.ts # Direct secrets, domains, versions, logs, rollback, and D1 operations
    project.ts              # Reads/creates .void/project.json (deploy platform + optional Void link)
    auth.ts                 # Token read/save + runLogin() (local server + browser OAuth)
    login.ts                # Login command UI (@clack/prompts)
    package.ts              # Packages dist/ into FormData (worker + assets + migrations + manifest)
    agents.ts               # Shared agent configs and detection
    client.ts               # HTTP client for platform API
    types.ts                # CLI-only deploy types and @void/deploy-core re-exports
```

### Key Design Decisions

- **Import redirection**: The routing plugin's `resolveId` hook redirects bare `"void"` imports to `void/handler` (the lightweight subpath). Without this, route files pull the entire plugin (vite, @cloudflare/vite-plugin, lightningcss) into the Worker bundle. Uses `import.meta.resolve()` to compute absolute paths at plugin init.
- **Pre-resolved paths in codegen**: Generated virtual module code uses absolute paths for `hono` and `void/response` (resolved via `import.meta.resolve()`). Virtual modules have no filesystem location, so bare specifiers can't resolve from them.
- **CF plugin API**: Worker config (`main`, `d1_databases`, `kv_namespaces`, `r2_buckets`) goes inside the `config` option of `cloudflare()`, NOT as top-level properties. `persistState` takes `{ path: string }`, not a raw string. The `config` option uses a **function form** `(resolved: WorkerConfig) => Partial<WorkerConfig>` so that bindings from the user's `wrangler.json` (if present) take precedence over inferred placeholder bindings.
- **Direct deploy package boundary**: target-neutral intents, artifacts, resources, migrations, and Durable Object plans live in public `@void/deploy-core`; root Wrangler config parsing and verified Cloudflare upload primitives live in public `@void/deploy-cloudflare`. The CLI consumes both packages directly. Hosted platform packages consume `@void/deploy-core` and must not be imported by public SDK packages.
- **Direct activation invariant**: native Cloudflare deploy uploads a Worker Version without traffic, records the validated migration filenames in its annotation, probes that version directly, activates it at 100%, and only then synchronizes triggers. A trigger-sync failure restores the prior active version. Database migrations are forward-only; rollback warns before activating code whose recorded migration set is older or unknown.
- **Direct Sandbox entitlement invariant**: `void/sandbox` is opt-in and is the only public Void feature that currently requires Workers Paid on the native Cloudflare path. When source inference or `void.json` enables it, deploy must verify Containers with a read-only account probe after authentication and before provisioning/building, then explain both the Workers Paid signup and Containers/Cloudchamber token permissions on failure. A non-Sandbox app must emit no Container and perform no Containers probe.
- **Migration DB path**: Miniflare stores D1 data at a deterministic path computed from the `database_id` using HMAC-SHA256. The `getMiniflareDatabasePath()` function in `migrations/runner.ts` replicates this algorithm so migrations target `<persist-root>/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` (for example `.void/v3/...` in default/class-A mode and `.wrangler/state/v3/...` in class-B/C framework mode).
- **Drizzle-first database**: Schema is defined in `db/schema.ts` (Drizzle table definitions). `void/db` exports a dialect-aware Drizzle instance for D1, PostgreSQL, or MySQL. `@schema` is an auto-configured alias for `db/schema.ts`. Migrations live in `db/migrations/`. CLI commands: `void db push` (prototype), `void db generate` (create migration files), `void db migrate` (apply locally). When auth is enabled, `void db generate` runs codegen in production mode and adds `.void/better-auth-schema.ts` to Drizzle Kit's schema inputs. Direct Cloudflare deploy applies PostgreSQL or MySQL migrations from the shell-provided production `DATABASE_URL`; PostgreSQL is transactional, while MySQL DDL is not. `drizzle-orm` and `drizzle-kit` ship with void.
- **Database provisioning adapters**: `void db connect <url>` saves an external database URL to `.env.local` and syncs a linked Void project; `--local-only` skips the sync. `void db connect --provider neon` provisions through the built-in Neon adapter using `NEON_API_KEY`. Third-party packages or local modules can export a `DatabaseProviderAdapter` built with `void/database-provider`; runtime database code remains provider-neutral.
- **Typed Durable State convention**: each default-exported `defineDurableState()` definition in `durable-objects/*.ts` becomes a filename-derived binding and worker class (`shopping-cart.ts` → `SHOPPING_CART` / `ShoppingCartDurableObject`). The generated entry calls the internal `__bind()` hook so named imports can use `State.get(name)` without touching `c.env`, exports `State.class`, and emits a stable `new_sqlite_classes` migration. `syncWranglerDurableObjects()` persists bindings and append-only class migration history in `wrangler.jsonc`; never regenerate migration order solely from the current sorted files. Runtime operations are serialized and persisted after successful typed RPC, `fetch`, or `alarm` handlers; versioned value migrations run on load. This is native-Void + Cloudflare only and is supported by direct Cloudflare deploys, unlike legacy KV-backed `*.ws.ts` classes.
- **Journal coherence invariant**: `db/migrations/*.sql` and `db/migrations/meta/_journal.json` must stay in sync — every `.sql` file has a matching journal entry (by `tag`) and vice versa. `assertJournalCoherence` in `src/migrations/validate.ts` is the gate, called from `deploy`, `db status`, `db migrate`, and `db reset`. The two CLI commands that mutate migration state — `void gen migration` and `void db rename-migrations` — are responsible for keeping the journal coherent themselves: the first appends a new entry when writing a file (failing loud if the journal is missing — run `drizzle-kit generate` first), the second rewrites `tag` values alongside the file renames and also renames the matching `meta/<prefix>_snapshot.json` (with byte-level rollback on failure). `gen migration` additionally copies the previous `meta/<idx:04d>_snapshot.json` forward to the new idx so drizzle-kit's drop/rollback tooling keeps working on mixed hand-written + drizzle projects; projects without prior snapshots are skipped silently. Drift will fail loudly before touching any remote DB. Motivated by [void-sdk/void#6](https://github.com/void-sdk/void/issues/6), where an orphan scaffolded `.sql` file half-applied against D1 and wedged the deploy.

### Self-Host AI + ISR

Two features need extra wiring on a self-hosted `vite build && wrangler deploy` (no Void platform proxy/dispatch in front of the worker). Both are inert on managed `void deploy`.

- **`ai.gateway` config + `__VOID_AI_GATEWAY` var** — `void.json`'s `ai.gateway` (validated in `config.ts` as `ai?: { gateway?: string }`; non-empty string, `additionalProperties: false`) names a Cloudflare AI Gateway in the user's own account. `mergeBindings` (`index.ts`): (1) injects `{ ai: { binding: 'AI' } }`, but only when `shouldBindWorkersAi()` is true — the app infers `needsAI`, `command === 'build'`, and neither the resolved root wrangler config nor the result already declares an `ai` binding (so it never clobbers a user's own `ai` binding); (2) emits `vars.__VOID_AI_GATEWAY = config.ai.gateway` whenever `config.ai?.gateway` is set. At runtime, `runtime/ai.ts` `resolveBackend()` selects the direct backend (Priority 3) when `env.AI` is present and no `__VOID_PROXY`/`__VOID_TOKEN` exists. `ai.run/stream/image` hit Workers AI directly; `ai.provider().fetch()` routes through the user's own gateway via `directAi.gateway(__VOID_AI_GATEWAY).getUrl(provider)` with the provider key from the user's own secret (`resolveProviderKey` → `env[PROVIDER_KEY_MAP[provider]]`), returning HTTP 501 if `__VOID_AI_GATEWAY` is unset. No cross-tenant metering on this path. The runtime reads `env.AI` **by name** — a custom-named root AI binding is not honored.
- **Internal-binding leak check permits exactly `__VOID_AI_GATEWAY`** — the integration guard (`test/integration/kitchen-sink-build.test.ts`) that asserts no `__VOID_*` var reaches `dist/ssr/wrangler.json` explicitly excludes `__VOID_AI_GATEWAY`, because it is a legitimate, non-credential runtime var (unlike the credential keys in `INTERNAL_ENV_KEYS`, which are stripped).
- **`ISR_CACHE` self-host requirement** — self-host ISR (`@void/isr/runtime`, `runtime/isr.ts`) reads `env.ISR_CACHE` (a `KVNamespace`) + `env.__VOID_ISR_DEPLOYMENT_ID`. Unlike D1/KV/R2, `ISR_CACHE` is **not** auto-injected (a KV binding needs a real namespace id), so the user must create the namespace and declare it as `ISR_CACHE` in their root wrangler config. `routing.revalidate` (void.json) and per-page `export const revalidate` are merged by `collectRevalidate` (`isr-config.ts`) and baked as `__VOID_ISR_REVALIDATE`. On-demand `revalidate()` on self-host purges the worker's own KV (global) plus the local-colo `caches.default` edge variants only.

### Package Exports

| Subpath          | What                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `void`           | `voidPlugin()` named export + `defineHandler` + `defineMiddleware` + `basicAuth` + `defineHead` + `defineQueue` + `CloudContext` type |
| `void/handler`   | `defineHandler()`, `defineHandler.withValidator()`, `defineMiddleware()`, `basicAuth()`, `defineHead()`, types                        |
| `void/response`  | `convertReturnValue()`                                                                                                                |
| `void/validator` | `runValidation()`, `ValidatorSlots`, `HandlerInput` types                                                                             |
| `void/routes`    | Empty `RouteMap` + `WebSocketRouteMap` stubs (augmented by generated `routes.d.ts`)                                                   |
| `void/client`    | Typed `fetch()` client + `fetchStream()` SSE consumer + `FetchError`                                                                  |
| `void/ws`        | `defineRoom()`, `defineWebSocket()`, typed `connect()`, and WebSocket context types                                                   |
| `void/durable`   | `defineDurableState()`, typed RPC stubs, state context, and state migration types                                                     |
| `void/db`        | `db` Drizzle D1 instance (auto-wired with user schema) + `createDb()` for custom D1 bindings                                          |
| `void/queues`    | `queues` typed proxy + `QueueMap` stub interface (augmented by generated `queues.d.ts`)                                               |
| `void/ai`        | `ai` proxy — `ai.run()`, `ai.stream()`, `ai.models()` with auto-detected backend (service binding / HTTPS / direct)                   |
| `void/log`       | `logger.error/warn/info(msg, fields?)` — emits stringified JSON to `console.*` so Cloudflare Tail captures level + msg                |
| `void/env`       | `defineEnv()`, typed `env` proxy, built-in schema helpers (`string`, `number`, `oneOf`, …) + global Cloudflare types                  |

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

Build output uses `.mjs` / `.d.mts` extensions (`vp pack` / tsdown default).

### Route Filename Parsing Rules

Applied in order to a path relative to `routes/`:

1. Strip extension (`.ts`, `.js`, `.mts`, `.mjs`)
2. Strip env suffix (`.dev`, `.prod`) and record it on `RouteDefinition.env`
3. Strip trailing `index`
4. Remove route group dirs `(groupname)`
5. Convert `[param]` → `:param`, `[...param]` → `:param{.+}`, `[...]` → `*`
6. Prefix with `/`

HTTP methods are determined by **named exports** in each file (detected by `detect-exports.ts` via `parseSync`), not by filename suffixes. Files/dirs starting with `_` are ignored by the scanner.

The recorded `env` is enforced by `isRouteEnabledForEnvironment()`. The scanners take an optional `environment` (`'dev' | 'prod'`); when it is omitted no filtering happens. `dev` is the Vite dev server, `prod` is every build, `void deploy`, and `vite preview`. A dev-only route is absent from the production bundle, types, and generated route/WebSocket config. Two paths do not follow it: `void prepare` boots no Vite, passes no `environment`, and so generates types for both environments; and `inferProjectBindings()` (`plugin-inference.ts`) globs source files without parsing route filenames, so a `void/storage` import in a `.dev.ts` route still emits and provisions an R2 binding in production. Over-emitting is the deliberate safe direction — under-emitting would drop a binding the running code needs — and the environment is not knowable at the `inferProjectBindings()` call site anyway (`index.ts:678`, versus `routeEnvironment` at `index.ts:1324`). The suffix is honoured in `routes/` only, not in `pages/`, `middleware/`, `crons/`, or `queues/`.

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
- **`void init --agents`** — runs all agent setup steps from a single detection/selection pass: injects Void instructions with versioned markers and symlinks skills from the `void` package.
- **`void init` in an empty directory** — scaffolds a Pages-mode starter, then lets you pick D1, PostgreSQL, MySQL, or Static Pages before running the same setup flow.
- **Cloudflare onboarding in `void init`** — Cloudflare is the default deployment choice. Init stores it in `.void/project.json`, creates or comment-preservingly augments `wrangler.jsonc`, checks `wrangler whoami --json`, offers `wrangler login`, and writes the sole or selected account as `account_id`. Void and Skip never run the Wrangler onboarding. A deploy-time `--platform` override is one-off and never changes either saved preference.

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

## Pitfalls / Things That Broke

- **`__VOID_ISR_DEPLOYMENT_ID` must be a compile-time literal.** `router/compile.ts` stringifies `crypto.randomUUID()` once at build time (`export const __VOID_ISR_DEPLOYMENT_ID = "..."`, exactly like `__VOID_BUILD_KEY`) so every isolate of a deployment shares one id. A bare runtime `crypto.randomUUID()` per-isolate in the emitted source would mint a fresh id per isolate, so the edge-cache key (`handleIsr`'s `deploymentId` option) and the KV key (`env.__VOID_ISR_DEPLOYMENT_ID`, also used by the `revalidate()` purge path) would disagree — breaking cache reads and on-demand purge.
- **Self-host ISR requires a user-declared `ISR_CACHE` KV.** There is no `id: 'local'` injection for it: a placeholder id is fine for miniflare-backed dev but breaks a real `wrangler deploy`, which rejects an unknown namespace id. The user creates the namespace and binds it as `ISR_CACHE`; `readIsrCache`/`writeIsrCache` fail open to a live render when it is absent.
- **Workers AI binding injection is `command === 'build'`-gated.** `shouldBindWorkersAi()` only injects `{ ai: { binding: 'AI' } }` on build, because dev/miniflare has no local Workers AI emulation — `void dev` AI still routes through the Void proxy (P2 `__VOID_TOKEN` path) and needs `void auth login`.
