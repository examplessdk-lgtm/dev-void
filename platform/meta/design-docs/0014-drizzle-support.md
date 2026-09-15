# Drizzle ORM Support + Postgres Migration Path

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-20
**Status:** Proposed

---

## Problem

`void/db` is a custom query client over D1 (SQLite). It's low-friction for simple CRUD but has two scaling problems:

1. **Power ceiling.** No joins, subqueries, aggregations, or relations. Users hit `db.raw()` quickly and lose all type safety. The alternative — building these into the custom API — means rebuilding half of Kysely/Drizzle.

2. **No Postgres path.** The entire system is D1-native: raw SQL migrations use SQLite syntax, types are derived from SQLite DDL parsing, the runtime calls `D1Database` directly. When users outgrow D1 and want Postgres (via PlanetScale + Hyperdrive), it's a full rewrite of migrations, schema, and query code.

Drizzle ORM solves both. It provides a full type-safe query builder that works identically across D1 and Postgres. If we make Drizzle the foundation, users get power from day one and a clean upgrade path to Postgres later.

## Design

### Source of Truth: `db/schema.ts`

Users define their schema in Drizzle's TypeScript DSL. This is the single source of truth for types, migrations, and queries.

```ts
// db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id')
    .notNull()
    .references(() => users.id),
});
```

### Migration Generation

void auto-generates SQL migrations from the schema. During dev, the `dbPlugin` watches `db/schema.ts` and runs Drizzle Kit's `generate` API programmatically when it changes. No `drizzle.config.ts` needed — void infers everything.

```
db/schema.ts          (user edits)
    ↓ drizzle-kit generate (automatic)
migrations/0000_*.sql (auto-generated, committed to git)
    ↓ applied at dev start + deploy
D1 database
```

The `migrations/` directory stays as it is today — SQL files applied in order. The difference is that they're generated from the schema instead of hand-written.

### Runtime Module: `void/db`

The `void/db` export changes from the custom `QueryClient` to a pre-configured Drizzle instance.

```ts
// runtime/db.ts
import { drizzle } from 'drizzle-orm/d1';
import { env } from 'cloudflare:workers';

export const db = drizzle(() => (env as any).DB);
```

Users import their schema tables alongside `db`:

```ts
import { db } from 'void/db';
import { users, posts } from '../db/schema';
import { eq } from 'drizzle-orm';

// Simple
const allUsers = await db.select().from(users);

// Joins
const postsWithAuthors = await db
  .select()
  .from(posts)
  .leftJoin(users, eq(posts.authorId, users.id));

// Insert
await db.insert(users).values({ name: 'Alice', email: 'a@a.com' });

// Update
await db.update(users).set({ name: 'Bob' }).where(eq(users.id, 1));
```

No schema pass-through to `drizzle()` is needed — users import tables directly. This avoids the `db.query.users.findMany()` relational API (which has limitations on PlanetScale Postgres anyway) in favor of the standard select/insert/update/delete builder.

### `void gen model`

The command changes from generating raw SQL to appending Drizzle schema entries:

```bash
void gen model posts title:string body:text views:integer?
```

**Before (current):** Creates `migrations/001_create_posts.sql`

**After:** Appends to `db/schema.ts`:

```ts
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  views: integer('views'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});
```

Then auto-runs migration generation. Route scaffolding (`routes/api/posts/index.ts`) changes to use Drizzle syntax:

```ts
import { db } from 'void/db';
import { posts } from '../../db/schema';

export const GET = defineHandler(async () => {
  return db.select().from(posts);
});

export const POST = defineHandler.withValidator({
  body: v.object({
    title: v.pipe(v.string(), v.minLength(1)),
    body: v.string(),
  }),
})(async (c, { body }) => {
  await db.insert(posts).values({ title: body.title, body: body.body });
  return { created: true };
});
```

### Type Generation

The current `parseMigrationSchema()` → `generateDbTypes()` pipeline is **removed**. Drizzle provides types natively via `$inferSelect` and `$inferInsert` on table definitions. The `.void/db.d.ts` file and the `DbTables`/`DbInsertTables` interfaces are no longer needed.

Users who want explicit types:

```ts
import { users } from './db/schema';
type User = typeof users.$inferSelect;
type NewUser = typeof users.$inferInsert;
```

### Detection / Binding Inference

The import detection in `inference/walk.ts` stays the same — `"void/db"` still triggers `needsD1 = true`. No change needed.

### Local Dev

Drizzle migrations are applied automatically at dev server start via the existing migration plugin. The flow:

1. `vite dev` starts
2. `dbPlugin` checks if `db/schema.ts` exists
3. If schema changed since last generate, runs `drizzle-kit generate`
4. Migration plugin applies any unapplied migrations to local D1 (Miniflare)

### Deploy

No change to the deploy flow. `void deploy` applies SQL migrations to the remote D1 before uploading the worker, same as today. The migrations are just generated by Drizzle Kit instead of hand-written.

---

## Postgres via Hyperdrive

When a user outgrows D1, the migration to PlanetScale Postgres + Hyperdrive is a controlled change:

### Step 1: Change schema dialect

```diff
-import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
+import { pgTable, text, integer, serial, timestamp } from "drizzle-orm/pg-core";

-export const users = sqliteTable("users", {
+export const users = pgTable("users", {
-  id: integer("id").primaryKey({ autoIncrement: true }),
+  id: serial("id").primaryKey(),
   name: text("name").notNull(),
   email: text("email").notNull(),
-  createdAt: text("created_at").default(sql`(datetime('now'))`),
+  createdAt: timestamp("created_at").defaultNow(),
 });
```

### Step 2: Configure Hyperdrive

Add connection string to `.env`:

```
DATABASE_URL=postgres://user:pass@host:6432/postgres?sslmode=verify-full
```

void detects the dialect change (pg-core imports in schema) and switches:

- Binding inference: `needsHyperdrive = true` instead of `needsD1`
- Runtime: `drizzle(env.HYPERDRIVE.connectionString)` instead of `drizzle(env.DB)`
- Migrations: generated with Postgres dialect, applied via Drizzle Kit `migrate()`

### Step 3: Query code unchanged

```ts
// This code works identically on D1 and Postgres
const postsWithAuthors = await db
  .select()
  .from(posts)
  .leftJoin(users, eq(posts.authorId, users.id));
```

The query builder API is dialect-agnostic. Only the schema definition and the driver change.

### Runtime Module (Postgres mode)

When the schema uses `pg-core`, `void/db` switches to the Postgres driver:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from 'cloudflare:workers';

export const db = drizzle(() => (env as any).HYPERDRIVE.connectionString);
```

The dialect detection happens at build time (the plugin scans schema imports), so the correct driver is bundled.

### Deploy (Postgres mode)

The platform provisions a Hyperdrive config using the user's `DATABASE_URL` secret:

1. User runs `void secrets set DATABASE_URL postgres://...`
2. `void deploy` sends `manifest.bindings.hyperdrive = ["HYPERDRIVE"]`
3. Platform calls `POST /accounts/{id}/hyperdrive/configs` with the connection string
4. Hyperdrive binding is attached to the uploaded worker
5. Migrations are applied to the remote Postgres via the connection string

The `resources` table gets a new type: `"hyperdrive"`.

---

## Migration from Current API

### Breaking change

Switching from the custom `QueryClient` to Drizzle is a breaking change for existing users. The old `db.list("users")` / `db.insert("users", {...})` API goes away.

### Migration path

Given that Void is pre-1.0, this is acceptable as a clean break. For users with existing projects:

1. **Schema:** Convert `migrations/*.sql` to a `db/schema.ts` using `drizzle-kit introspect` (reads an existing database and generates a schema file). void could provide `void migrate-to-drizzle` to automate this.
2. **Queries:** Rewrite `db.list("users")` → `db.select().from(users)`, `db.insert("users", data)` → `db.insert(users).values(data)`, etc. The mapping is mechanical.
3. **Types:** Remove any usage of `DbTables` / `DbInsertTables` — use `$inferSelect` / `$inferInsert` instead.

### What gets removed

- `runtime/db.ts`: Custom `QueryClient`, `createDb()`, `buildWhere()`, `createQueryClient()`
- `codegen/db-types.ts`: `generateDbTypes()`
- `migrations/schema.ts`: `parseMigrationSchema()` and all DDL parsing
- `.void/db.d.ts`: No longer generated
- `DbTables` / `DbInsertTables` interfaces

### What stays

- `migrations/` directory (now auto-generated by Drizzle Kit)
- Migration application at dev start and deploy
- `void gen model` (generates Drizzle schema entries instead of SQL)
- Import detection for `"void/db"` → `needsD1`

---

## Validation Library Interaction

### Current State

`void gen model` auto-detects the user's validation library (valibot, zod, or arktype) and generates standalone validation schemas in route handlers. These schemas are hand-crafted — they duplicate the column types already expressed in the migration SQL:

```ts
// Generated route — validation schema is independent of DB schema
export const POST = defineHandler.withValidator({
  body: v.object({
    title: v.pipe(v.string(), v.minLength(1)),
    body: v.string(),
  }),
})(async (c, { body }) => {
  await db.insert(posts).values(body);
});
```

This works but creates two sources of truth: the DB schema and the validation schema. They can drift apart.

### Drizzle Companion Libraries

Drizzle provides official companion packages that derive validation schemas directly from table definitions:

- [`drizzle-valibot`](https://orm.drizzle.team/docs/valibot) — `createInsertSchema(table)`, `createSelectSchema(table)`
- [`drizzle-zod`](https://orm.drizzle.team/docs/zod) — same API surface
- [`drizzle-typebox`](https://orm.drizzle.team/docs/typebox) — same API surface

```ts
import { createInsertSchema } from 'drizzle-valibot';
import { posts } from '../../db/schema';

const insertPostSchema = createInsertSchema(posts);

export const POST = defineHandler.withValidator({
  body: insertPostSchema,
})(async (c, { body }) => {
  await db.insert(posts).values(body);
});
```

This eliminates the dual source of truth — the validation schema is always in sync with the DB columns, nullability, and defaults.

### Considerations

1. **`void gen model` should use companion libraries.** When generating route handlers, instead of building up validation schemas field-by-field, import and use `createInsertSchema(table)`. This keeps the schema as the single source of truth and makes the generated code shorter.

2. **Refinements on top of derived schemas.** Drizzle schemas only capture column types and nullability — not business rules like `minLength(1)`, `email()`, or `maxLength(255)`. Users need to layer refinements on top:

   ```ts
   import { createInsertSchema } from 'drizzle-valibot';
   import * as v from 'valibot';

   const insertPostSchema = createInsertSchema(posts, {
     title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
     body: v.pipe(v.string(), v.minLength(1)),
   });
   ```

   The companion libraries support per-column overrides as a second argument. `gen model` could generate these override stubs so users have a natural place to add constraints.

3. **ArkType gap.** There is no official `drizzle-arktype` companion library. ArkType users would still need standalone schemas or a manual mapping. Options:
   - Drop ArkType from `gen model` (simplifies maintenance, ArkType usage is minimal)
   - Keep ArkType with standalone schemas as a fallback
   - Wait for a community `drizzle-arktype` package

4. **Standard Schema compatibility.** Drizzle companion schemas conform to Standard Schema, which is what `defineHandler.withValidator()` already accepts. No adapter layer is needed — the derived schemas plug directly into the existing validation pipeline.

5. **Optional dependency.** The companion library (`drizzle-valibot`, `drizzle-zod`) should be a peer/optional dependency, not bundled with `void`. Users who don't use `gen model` or prefer handwritten schemas shouldn't pay for it. `gen model` can prompt to install it (similar to how it currently prompts for the validation library choice).

---

## Open Questions

1. **Schema location:** `db/schema.ts` vs `src/schema.ts` vs `schema.ts`? `db/schema.ts` mirrors the `routes/` and `middleware/` top-level directory convention.

2. **Multiple schema files:** Should we support `db/users.ts`, `db/posts.ts` with barrel export from `db/index.ts`? Or keep it single-file to start?

3. **Drizzle as dependency:** Drizzle becomes a runtime dependency of `void/db`. Currently void has zero runtime ORM deps. We'd add `drizzle-orm` (~7 KB gzipped). `drizzle-kit` stays dev-only.

4. **Relational queries:** Drizzle's `db.query.users.findMany({ with: { posts: true } })` API requires passing the schema to `drizzle()`. Do we support this? It uses lateral joins which PlanetScale Postgres doesn't support, so it may be better to skip it and steer users toward explicit joins.

5. **`createDb()` escape hatch:** Should we still export a `createDb(binding)` for users who want to instantiate Drizzle with a specific D1 binding (e.g., in tests or multi-DB setups)?

6. **Seed data:** Currently `migrations/seed.sql` is excluded from schema parsing. With Drizzle, seed data would be a `db/seed.ts` script using Drizzle's insert API. Do we provide `void db seed` to run it?

7. **`drizzle-kit` version management:** Should `drizzle-kit` be a dependency of `void` (so we control the version), or a peer dependency the user installs?
