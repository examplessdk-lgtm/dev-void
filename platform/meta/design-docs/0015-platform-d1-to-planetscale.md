# Platform: Migrate from D1 to PlanetScale Postgres

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-20
**Status:** Proposed

---

## Overview

Migrate the platform worker's database from Cloudflare D1 (SQLite) to PlanetScale Postgres, accessed via Hyperdrive. The platform already uses Drizzle ORM, so most query code transfers directly. The main work is schema dialect conversion, driver swap, `.get()` elimination, and test infrastructure.

**Scope:** Only the platform worker's own database. User D1 databases (provisioned per-project, queried via `remote-runner.ts` and CF REST API) are unaffected.

---

## Pre-work: PlanetScale Setup

1. Create a PlanetScale account and organization
2. Create a Postgres database (pick region closest to where the platform worker runs — probably `aws:us-east-1` or `gcp:us-east4`)
3. Create two branches: `main` (production) and `staging`
4. Create roles with `pg_read_all_data` + `pg_write_all_data` for each branch
5. Note connection strings for both (use port 6432 for PgBouncer pooling)

---

## Step 1: Schema Conversion

**File:** `platform/packages/api/src/schema.ts`

Convert from SQLite to Postgres dialect. This is the most mechanical step.

### Imports

```diff
-import { index, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
+import { index, pgTable, text, unique, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
```

### Table definitions

Replace `sqliteTable` → `pgTable` for all 5 tables.

### Date columns

All 6 `created_at` / `deployed_at` / `billing_cycle_start` columns change from `text` with ISO string defaults to native `timestamp`:

```diff
-    created_at: text("created_at")
-      .notNull()
-      .default(sql`(datetime('now'))`),
+    created_at: timestamp("created_at", { mode: "string" })
+      .notNull()
+      .defaultNow(),
```

Using `mode: "string"` keeps the JS-side type as `string` (ISO format), avoiding a large refactor of all code that currently does `new Date().toISOString()` and string comparisons. This can be changed to `mode: "date"` later if desired.

### Column type mapping

| SQLite                                               | Postgres                                                   | Notes     |
| ---------------------------------------------------- | ---------------------------------------------------------- | --------- |
| `text("id").primaryKey()`                            | `text("id").primaryKey()`                                  | Same      |
| `text("foo").notNull()`                              | `text("foo").notNull()`                                    | Same      |
| `text("foo").$type<T>()`                             | `text("foo").$type<T>()`                                   | Same      |
| `text("created_at").default(sql\`datetime('now')\`)` | `timestamp("created_at", { mode: "string" }).defaultNow()` | See above |

Good news: every non-date column is `text`, so the only real change is the 6 datetime columns.

### Indexes

SQLite index syntax and Postgres index syntax are the same in Drizzle's API. No changes needed for `index()`, `unique()`, `uniqueIndex()`.

### Foreign keys

Same API. The default `ON DELETE no action ON UPDATE no action` is the same in both. No changes.

---

## Step 2: Driver Swap

### `db.ts`

```diff
-import { drizzle } from "drizzle-orm/d1";
+import { drizzle } from "drizzle-orm/node-postgres";

-export function createDb(d1: D1Database) {
-  return drizzle(d1, { schema });
+export function createDb(connectionString: string) {
+  return drizzle(connectionString, { schema });
 }
```

### `index.ts` middleware

```diff
 app.use("*", async (c, next) => {
-  c.set("db", createDb(c.env.DB));
+  c.set("db", createDb(c.env.HYPERDRIVE.connectionString));
   await next();
 });
```

### Scheduled handler

```diff
 async function scheduled(
   _controller: ScheduledController,
   env: ApiEnv["Bindings"],
   _ctx: ExecutionContext,
 ): Promise<void> {
-  const db = createDb(env.DB);
+  const db = createDb(env.HYPERDRIVE.connectionString);
```

### Env type

In `env.ts` (or wherever `ApiEnv` is defined):

```diff
 Bindings: {
-  DB: D1Database;
+  HYPERDRIVE: Hyperdrive;
   // ... other bindings unchanged
 };
```

---

## Step 3: Eliminate `.get()`

The D1 adapter has `.get()` which returns `T | undefined` for single-row queries. The `node-postgres` adapter does not — it returns arrays. There are **16 `.get()` calls** in `db.ts`.

Two options:

### Option A: Index into array (simple)

```diff
-  return (await db.select().from(users).where(eq(users.id, id)).get()) ?? null;
+  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
+  return row ?? null;
```

### Option B: Helper function (DRY)

```ts
async function getOne<T>(query: { limit(n: number): { then: Function } }): Promise<T | null> {
  const [row] = await (query as any).limit(1);
  return (row as T) ?? null;
}
```

**Recommendation:** Option A. It's explicit, and with 16 call sites it's a quick find-and-replace. Most already have `.limit(1)` or `.where(eq(..., id))` which returns at most one row anyway.

### Also: `.all()` calls

The D1 adapter requires explicit `.all()` to get an array. With `node-postgres`, the query result is already an array — `.all()` may or may not exist depending on Drizzle version. Check whether Drizzle's postgres adapter exposes `.all()` for compatibility, or just `await` the query directly.

---

## Step 4: Fix SQLite-Specific SQL

### `countUserDeploymentsToday` (db.ts:86)

```diff
-    .where(and(eq(projects.user_id, userId), sql`${deployments.created_at} >= date('now')`))
+    .where(and(eq(projects.user_id, userId), sql`${deployments.created_at} >= CURRENT_DATE`))
```

### `updateDeploymentStatus` (db.ts:167-168)

The `COALESCE` usage is standard SQL — works in both SQLite and Postgres. No change needed.

### `createUser` / `createProject` / `createDeployment` / etc.

These manually set `new Date().toISOString()` for returned objects. With `timestamp` columns in `mode: "string"`, Postgres will return ISO strings natively. The manual `.toISOString()` in the return objects still works but could be replaced by returning the actual inserted row. Low priority — cosmetic.

---

## Step 5: Drizzle Kit Config

**File:** `platform/packages/api/drizzle.config.ts`

```diff
 export default defineConfig({
   schema: "./src/schema.ts",
   out: "./drizzle",
-  dialect: "sqlite",
+  dialect: "postgresql",
 });
```

---

## Step 6: Generate Fresh Migrations

Since we're changing database engines entirely, the existing SQLite migrations are useless for Postgres. Start fresh:

```bash
# Archive old migrations
mv platform/packages/api/drizzle platform/packages/api/drizzle-d1-archive

# Generate new Postgres migration from schema
cd platform/packages/api
npx drizzle-kit generate
```

This produces a single baseline migration that creates all 5 tables with Postgres DDL. Review it for correctness (timestamp types, indexes, constraints).

---

## Step 7: Wrangler Config

**File:** `platform/packages/api/wrangler.jsonc`

### Production

```diff
-  "d1_databases": [
-    {
-      "binding": "DB",
-      "database_name": "void-api",
-      "database_id": "<PREVIOUS_D1_DATABASE_ID>",
-      "migrations_dir": "drizzle"
-    }
-  ],
+  "hyperdrive": [
+    {
+      "binding": "HYPERDRIVE",
+      "id": "<HYPERDRIVE_CONFIG_ID>"
+    }
+  ],
```

### Staging env

Same change, different Hyperdrive config ID.

### Create Hyperdrive configs

```bash
# Production
npx wrangler hyperdrive create void-api \
  --connection-string="postgres://user:pass@host:6432/postgres?sslmode=verify-full"

# Staging
npx wrangler hyperdrive create void-api-staging \
  --connection-string="postgres://user:pass@staging-host:6432/postgres?sslmode=verify-full"
```

Note the output IDs and put them in `wrangler.jsonc`.

### Placement hint

Add a placement hint to reduce latency between the Worker and PlanetScale:

```jsonc
{
  "placement": {
    "region": "gcp:us-east4", // match your PlanetScale region
  },
}
```

---

## Step 8: Test Infrastructure

Currently tests use Miniflare's in-memory D1. Options:

### Option A: Test against a real Postgres (recommended)

Use a local Postgres via Docker or a PlanetScale dev branch:

```ts
// test/integration/helpers.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

const client = new Client({
  connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/vite_cloud_test',
});
await client.connect();

const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: 'drizzle' });
```

Add to CI:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_DB: vite_cloud_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - 5432:5432
```

### Option B: PGlite (in-process Postgres)

[PGlite](https://github.com/electric-sql/pglite) runs Postgres in-process via WASM. No Docker needed. Drizzle supports it via `drizzle-orm/pglite`:

```ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const client = new PGlite();
const db = drizzle(client, { schema });
```

This is the most frictionless option for local dev and CI — no external service needed. Check if PGlite supports all the Postgres features used (timestamps, indexes, constraints — it should).

### Clearing tables between tests

The existing `clearTables` helper uses `db.delete(table)`. This works identically in Postgres. May need to respect FK ordering or use `TRUNCATE ... CASCADE`.

---

## Step 9: Apply Migrations to PlanetScale

```bash
# Against the staging branch
cd platform/packages/api
DATABASE_URL="postgres://..." npx drizzle-kit migrate

# Against the production branch
DATABASE_URL="postgres://..." npx drizzle-kit migrate
```

Or programmatically on first deploy, the same way the D1 migrations were applied.

---

## Step 10: Data Migration

If there's existing data in D1 that needs to move:

1. Export from D1:

   ```bash
   wrangler d1 export void-api --output=d1-export.sql
   ```

2. Transform the SQL dump:
   - `datetime('now')` → `now()` in any DEFAULT clauses (but the data itself is ISO strings, which Postgres timestamps accept)
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → not applicable (our PKs are text UUIDs)
   - Remove SQLite-specific PRAGMA statements

3. Import to PlanetScale:

   ```bash
   psql $DATABASE_URL < d1-export-transformed.sql
   ```

   Or use a script that reads from D1 REST API and inserts via Drizzle into Postgres.

**Alternative:** If the data set is small, write a migration script using both adapters:

```ts
// scripts/migrate-data.ts
const d1Db = drizzleD1(d1binding, { schema });
const pgDb = drizzlePg(connectionString, { schema });

for (const table of [users, projects, deployments, resources, domains]) {
  const rows = await d1Db.select().from(table).all();
  if (rows.length > 0) {
    await pgDb.insert(table).values(rows);
  }
}
```

---

## Step 11: Deploy

### Staging first

1. Apply Postgres migrations to staging PlanetScale branch
2. Migrate data from staging D1 (if needed)
3. Update `wrangler.jsonc` staging env with Hyperdrive config
4. `pnpm run deploy:staging`
5. Smoke test all endpoints: auth, project CRUD, deploy, domains, admin dashboard, usage, scheduled job

### Production

1. Apply Postgres migrations to production PlanetScale branch
2. Migrate data from production D1
3. Update `wrangler.jsonc` production env with Hyperdrive config
4. `pnpm run deploy`
5. Verify everything works

### Rollback plan

Keep the D1 binding in wrangler config (commented out) and the old code on a git branch. If something goes wrong, revert the deploy. D1 data is still there. The main risk is data written to Postgres during the window between deploy and rollback — this is a one-way door for new data.

---

## Step 12: Cleanup

After stable on Postgres:

1. Remove `d1_databases` from `wrangler.jsonc`
2. Delete `drizzle-d1-archive/` (the old SQLite migrations)
3. Remove `D1Database` from env types
4. Remove `@cloudflare/workers-types` D1 type references if no longer needed
5. Update `platform/packages/api/README.md` to reflect Postgres
6. Update `CLAUDE.md` / `README.md` monorepo docs

---

## Inventory of Changes

| File                          | What changes                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/schema.ts`               | `sqliteTable` → `pgTable`, date columns → `timestamp`                                               |
| `src/db.ts`                   | `drizzle-orm/d1` → `drizzle-orm/node-postgres`, `D1Database` → `string`, 16x `.get()` → destructure |
| `src/index.ts`                | `c.env.DB` → `c.env.HYPERDRIVE.connectionString` (2 places: middleware + scheduled)                 |
| `src/env.ts`                  | `DB: D1Database` → `HYPERDRIVE: Hyperdrive` in bindings                                             |
| `drizzle.config.ts`           | `dialect: "sqlite"` → `"postgresql"`                                                                |
| `wrangler.jsonc`              | `d1_databases` → `hyperdrive` (both prod + staging)                                                 |
| `drizzle/*.sql`               | Re-generated for Postgres dialect                                                                   |
| `test/integration/helpers.ts` | Miniflare D1 → PGlite or real Postgres                                                              |
| `package.json`                | Add `pg` (or keep using drizzle's built-in), possibly add `@electric-sql/pglite` for tests          |

### What does NOT change

- All 40+ query functions in `db.ts` (select/insert/update/delete syntax is identical)
- `remote-runner.ts` (queries user D1 databases via CF REST API — unrelated)
- Analytics Engine queries in `routes/usage.ts` (separate system)
- All route handlers, admin views, middleware (they call `db.ts` functions, not D1 directly)
- Auth flow, deploy pipeline, domain management logic
- All business logic

---

## Risks

1. **Latency.** D1 is colocated with the Worker. PlanetScale is a network hop away, even with Hyperdrive connection pooling. Measure P50/P99 latency before and after. Placement hints help.

2. **Cost.** D1 has a generous free tier. PlanetScale starts at $5/month + per-query costs. For the control plane's volume this is negligible.

3. **Timestamp semantics.** D1 stores datetimes as text strings. Postgres has native `TIMESTAMP`. With `mode: "string"`, Drizzle returns ISO strings, so the JS-side behavior is the same. But sorting/filtering on timestamps is now done natively by Postgres (faster, correct timezone handling).

4. **Connection limits.** PlanetScale with PgBouncer (port 6432) handles high concurrency. Hyperdrive adds its own connection pooling on top. Should be fine for a control plane workload.

5. **Test speed.** Miniflare D1 is fast (in-memory SQLite). PGlite is also fast but not as fast. Real Postgres adds network overhead. Measure and decide.
