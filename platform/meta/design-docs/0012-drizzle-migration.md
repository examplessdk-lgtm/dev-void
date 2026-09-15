# Platform DB: Migrate from Raw D1 SQL to Drizzle ORM

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Status:** Implemented

## Problem

The platform's `db.ts` has ~40 functions using raw D1 SQL with manually-maintained TypeScript interfaces in `types.ts`. This creates:

- **Schema-type drift**: 5 interfaces are hand-authored with no compile-time link to the actual D1 schema. Drift already exists (`User.plan` is `string` instead of `PlanId`, `Project.mode` is `string`, `Domain.status` is `string`).
- **Ghost columns**: `github_id`/`github_login` are `NOT NULL` in SQLite and can't be dropped without a table rebuild. Every INSERT must provide fake values.
- **Unsafe casts**: `SELECT *` results are cast via `.first<User>()` which is a promise, not a guarantee. `getSystemStats` uses `as { count: number }` on `D1Result<unknown>[]`.
- **Manual migrations**: 10 hand-written SQL files with no auto-generation from schema changes.

## Solution

Adopt **Drizzle ORM** with the D1 adapter. Drizzle adds ~7 KB gzipped to the bundle, provides schema-as-code with inferred types, native D1 `batch()` support, and auto-generated migrations via `drizzle-kit`.

## Design

### Schema file (`src/schema.ts`)

Single source of truth for all 5 tables. Uses `.$type<T>()` for union types:

- `users.plan` → `.$type<PlanId>()` (`"free" | "solo" | "pro" | "sponsored" | "custom"`)
- `users.role` → `.$type<"user" | "admin">()`
- `projects.mode` → `.$type<"fullstack" | "spa" | "ssg" | "framework">()`
- `deployments.status` → `.$type<"pending" | "uploading" | "migrating" | "live" | "failed">()`
- `domains.status` → `.$type<"pending" | "active">()`

Ghost columns (`github_id`, `github_login`) are NOT included — dropped via table rebuild migration.

### Migration strategy

**Phase 1 — Baseline (no schema change):**

1. Define current schema in `src/schema.ts` (including ghost columns temporarily for introspection)
2. Generate baseline migration via `drizzle-kit generate`
3. On production/staging: create `__drizzle_migrations` table and mark baseline as applied via `wrangler d1 execute`
4. In tests: replace 10-file migration replay with `drizzle migrate()`

**Phase 2 — Drop ghost columns:**
Generate a migration that does a SQLite table rebuild (CREATE new → INSERT SELECT → DROP old → RENAME). Removes `github_id`/`github_login` and the `ABS(RANDOM())` hack.

**Going forward:** Changes to `src/schema.ts` → `drizzle-kit generate` → SQL migration files in `drizzle/`. Old `migrations/` folder becomes inert.

### `db.ts` rewrite

Introduce a Drizzle instance factory:

```ts
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
export type Db = ReturnType<typeof createDb>;
```

All ~40 functions switch from `D1Database` first arg to `Db`. Query patterns:

- `.first<T>()` → `.get()` (returns `T | undefined`)
- `.all<T>().results` → `.all()` (returns `T[]` directly)
- `db.batch([...])` → Drizzle's typed `db.batch([...])`
- JOINs use `.leftJoin()` with inferred result types
- Inline queries (3 locations) consolidated into `db.ts`

### Hono integration

Middleware creates Drizzle instance per request, stores in context:

```ts
// env.ts Variables adds: db: Db
app.use('*', async (c, next) => {
  c.set('db', createDb(c.env.DB));
  await next();
});
```

Route handlers: `c.env.DB` → `c.get("db")`. Scheduled cron: `createDb(env.DB)`.

### Types

`types.ts` interfaces replaced by Drizzle-inferred types:

```ts
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
// etc.
```

Non-DB types (`DeployManifest`, `MigrationMeta`, `ScheduleMeta`, `QueueMeta`, `HeaderRule`) stay as-is.

### Tests

- `helpers.ts`: Replace migration replay with `migrate(createDb(d1), { migrationsFolder: "drizzle" })`
- Test fixtures (`createTestUser` etc.): Rewrite with Drizzle insert syntax, no ghost column hack
- `clearTables`: Use `db.delete(table)` syntax

### What's NOT changing

- `remote-runner.ts` — queries user D1 databases via CF REST API (not our schema)
- Analytics Engine SQL in `routes/usage.ts` — different query engine
- `drizzle-kit` — dev-time only, not bundled into worker

### Package exports

`"./db"` and `"./types"` paths stay the same. Exported shapes are identical. No breaking changes to consumers.

## Implementation Notes

Migration completed across 12 tasks. Key outcomes:

- **882 tests passing** (all existing + no regressions), lint/fmt/check clean
- **`drizzle-kit generate`** produced correct baseline + ghost column drop migrations (D1's SQLite 3.45+ supports `ALTER TABLE DROP COLUMN` natively)
- **`projects.mode` NOT NULL** added via table rebuild migration (original `ALTER TABLE ADD COLUMN` didn't include NOT NULL)
- **Admin view JOINs** preserved flat result shapes using `getTableColumns()` in SELECT — avoided changes to 3 admin view files
- **`getSystemStats`** replaced unsafe `D1Result<unknown>[]` casts with `Promise.all()` of typed Drizzle count queries
- **3 inline queries** consolidated into `db.ts`: `getFirstAdmin`, `updateUserProviderId`, `getAllUsersWithPlan`
- **`PRAGMA foreign_keys=OFF` is not allowed on D1** — Drizzle-generated migrations use `PRAGMA foreign_keys=OFF/ON` for table rebuilds, but D1 enforces `foreign_keys=ON` always. Hand-edited to use `PRAGMA defer_foreign_keys=on/off` instead (defers FK checks to end of transaction). Any future `drizzle-kit generate` that produces a table rebuild will need the same fix.

### Production deployment

This is a manual one-time step required before deploying the Drizzle-migrated code to production/staging. The baseline migration (`0000_messy_patriot`) represents the existing schema — it must be marked as "already applied" so Drizzle doesn't try to re-create tables that already exist. The second migration (`0001_perpetual_ezekiel`) drops ghost columns and will run automatically.

**Step 1: Deploy to staging first**

Mark the baseline migration as applied on the staging D1:

```bash
wrangler d1 execute void-api-staging --env staging --command \
  "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)"

wrangler d1 execute void-api-staging --env staging --command \
  "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0000_messy_patriot', 1771545874568)"
```

Then deploy and verify all API endpoints work:

```bash
pnpm run deploy:staging
```

**Step 2: Deploy to production**

Repeat the same `wrangler d1 execute` commands against the production D1:

```bash
wrangler d1 execute void-api --command \
  "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)"

wrangler d1 execute void-api --command \
  "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0000_messy_patriot', 1771545874568)"
```

Then deploy:

```bash
pnpm run deploy
```

The ghost column drop migration (`0001_perpetual_ezekiel`) will run automatically on the first request after deploy.
