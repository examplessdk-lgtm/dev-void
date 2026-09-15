---
title: First-Class Drizzle Integration
status: draft
created: 2026-03-05
---

# First-Class Drizzle Integration

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Replace the current `void/db` lightweight query client with a Drizzle-powered database layer. Drizzle becomes the sole database abstraction for Void — schema-as-code, auto-wired D1 binding, push-based prototyping, migration-based deploys.

This is a breaking change: the existing `void/db` QueryClient API (list/get/insert/update/delete/raw/count) and the SQL migration parser / `.void/db.d.ts` type codegen are removed entirely.

## Motivation

- **Schema duplication** — today, users who want Drizzle must maintain both SQL migration files (for Void's type generation) and a Drizzle schema file (for the ORM). First-class integration eliminates this.
- **Type quality** — Drizzle's schema types are richer than Void's auto-generated `DbTables` (relations, custom types, `.$type<T>()`). Making Drizzle the source of truth gives users better types with less effort.
- **Ecosystem alignment** — Drizzle is the dominant TypeScript ORM. Most developers reaching for a database will use it anyway. Making it first-class removes boilerplate.
- **Maintenance** — removes the custom SQL migration parser, `DbTables`/`DbInsertTables` codegen, and the QueryClient implementation. Less surface area.
- **Push workflow** — Drizzle Kit's `push` command enables rapid prototyping (edit schema, push, iterate) without accumulating throwaway migration files. This is a major DX improvement Void doesn't offer today.

## User Experience

### Setup

No extra install needed — `drizzle-orm` and `drizzle-kit` ship as direct dependencies of `void`.

### Define Schema

```ts
// db/schema.ts
import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

### Use It

```ts
import { db } from 'void/db';
import { users } from '@schema';
import { eq } from 'drizzle-orm';

// List
const allUsers = await db.select().from(users).all();

// Get by ID
const user = await db.select().from(users).where(eq(users.id, 1)).get();

// Insert
await db.insert(users).values({ name: 'Alice', email: 'alice@example.com' });

// Relational queries (schema auto-loaded)
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

### Prototype

```bash
void db push    # Schema -> local D1 directly, no migration files
```

### Ship

```bash
void deploy     # Detects drift -> "Generate and commit migrations?" -> deploys
```

## Design

### Runtime API (`void/db`)

The `void/db` export path is preserved but now exports a Drizzle instance:

```ts
// void/db (framework runtime)
import { drizzle } from 'drizzle-orm/d1';

// Auto-wired Drizzle instance with user's schema
export const db: DrizzleD1Database<UserSchema>;

// For custom D1 bindings
export function createDb(d1: D1Database): DrizzleD1Database<UserSchema>;
```

`db` resolves the `DB` binding from the runtime environment via `requireRuntimeBinding("DB")`, same mechanism as today. The user's schema is auto-discovered and passed to `drizzle()` via a build-time virtual module, so relational queries work out of the box.

### Schema Discovery

The framework auto-discovers the user's Drizzle schema at build time:

1. Check for `db/schema.ts` (single file or barrel re-export)
2. Fall back to `db/schema/` directory (glob `db/schema/*.ts`)
3. Respect `drizzle.config.ts`'s `schema` field if present

The discovered schema is used for:

- Creating the auto-wired `db` instance (relational queries)
- Drizzle Kit operations (push, generate)
- Build-time validation

### `@schema` Import Alias

To eliminate deep relative imports (`../../../db/schema`), the framework auto-configures an `@schema` alias:

**Vite alias:**

```ts
resolve: {
  alias: { "@schema": resolve(root, "db/schema.ts") }
}
```

**TypeScript paths** (auto-generated in `.void/tsconfig.json`):

```json
{
  "compilerOptions": {
    "paths": {
      "@schema": ["./db/schema.ts"],
      "@schema/*": ["./db/schema/*"]
    }
  }
}
```

Both patterns work:

```ts
import { users } from '@schema'; // db/schema.ts barrel
import { users } from '@schema/users'; // db/schema/users.ts direct
```

### CLI Commands

| Command                 | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `void db push`          | Diff Drizzle schema against local D1, apply directly. For prototyping. |
| `void db generate`      | Generate SQL migration files into `db/migrations/` via Drizzle Kit.    |
| `void db migrate`       | Apply pending migrations via `drizzle-orm`'s programmatic `migrate()`. |
| `void db status`        | Show schema drift and pending migrations.                              |
| `void db reset`         | Reset local D1 database.                                               |
| `void db seed`          | Run seed file.                                                         |
| `void db execute`       | Run arbitrary SQL against local D1.                                    |
| `void db export`        | Export local database.                                                 |
| `void gen model <name>` | Scaffold Drizzle table definition + update barrel export.              |

`push` and `generate` spawn Drizzle Kit via subprocess with a framework-generated config. `migrate` uses `drizzle-orm`'s programmatic `migrate()` function (lightweight, no subprocess). The framework supplies `dbCredentials` (local Miniflare D1 SQLite path), `dialect: "sqlite"`, schema path, and output directory — the user does not need a `drizzle.config.ts` for basic usage.

### `void gen model`

`void gen model post` generates:

```ts
// db/schema/post.ts
import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

If `db/schema.ts` exists as a barrel file, auto-appends:

```ts
export * from './schema/post';
```

If `db/schema.ts` doesn't exist yet, creates it with the barrel export.

### Dev Server Behavior

On `void dev` startup:

1. Apply pending migrations from `db/migrations/` via `drizzle-orm`'s programmatic `migrate()`
2. Detect schema drift (Drizzle schema ahead of local D1)
3. If drift detected, warn:
   ```
   ⚠ Schema out of sync with local database.
     Run `void db push` to apply, or `void db generate` to create a migration.
   ```

No auto-push — destructive changes (dropping columns/tables) should require explicit user action.

### Deploy Flow

1. Build the application
2. Collect `db/migrations/`
3. Detect drift between Drizzle schema and `db/migrations/`
4. If drift detected, prompt: **"Generate and commit the migrations?"**
   - On confirm: run Drizzle Kit generate, `git add db/migrations/`, `git commit` (if in a git repo)
   - On decline: abort deploy
5. Run pending SQL migrations on remote D1 via existing remote runner
6. Deploy worker

Deploy always goes through migration files — push is local dev only.

### Binding Inference

Detect `import ... from "void/db"` (same import path as today). Triggers D1 provisioning. Also detect `env.DB` as a fallback. No changes to the inference mechanism, just the import it detects.

### Build-Time Plugin Changes

The existing `plugin-db-types.ts` is replaced. The new plugin:

1. Discovers schema file(s) via the schema discovery rules above
2. Generates a virtual module that imports the user's schema and creates the Drizzle instance
3. Sets up `@schema` Vite resolve alias
4. Generates TypeScript paths in `.void/tsconfig.json`
5. Client stubs plugin continues to stub `void/db` in browser builds

The SQL migration parser (`migrations/schema.ts`) and `.void/db.d.ts` codegen (`codegen/db-types.ts`) are removed.

### Drizzle Kit Configuration

For basic usage, no `drizzle.config.ts` is needed — the framework infers everything:

- `schema`: discovered via schema discovery rules
- `dialect`: `"sqlite"` (D1 is SQLite)
- `out`: `"db/migrations/"`
- `dbCredentials.url`: local Miniflare D1 SQLite path

Users can create `drizzle.config.ts` for advanced options (e.g., `migrations.prefix`, `strict`, `verbose`). The framework reads and merges with its defaults.

## Error Handling

| Scenario                                                | Behavior                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `drizzle-orm` not resolvable (corrupted install)        | Error: _"Cannot resolve drizzle-orm. Try reinstalling dependencies."_                  |
| No schema file found                                    | Error: _"No schema found at db/schema.ts. Create one or run `void gen model <name>`."_ |
| `void db push` with destructive changes                 | Drizzle Kit strict mode prompts for confirmation                                       |
| Deploy with no `db/migrations/` (push-only prototyping) | Prompt: _"Generate and commit the migrations?"_                                        |

## What's Removed

- `void/db` QueryClient implementation (list/get/insert/update/delete/raw/count)
- SQL migration parser (`migrations/schema.ts`)
- `.void/db.d.ts` type generation from SQL
- `DbTables` / `DbInsertTables` interfaces
- Custom migration runner (`migrations/runner.ts`'s `runMigrations`) — replaced by `drizzle-orm`'s `migrate()`

## What's Unchanged

- Deploy pipeline — remote migration runner still applies SQL files
- D1 provisioning via CF API
- Proxy worker (remote D1 bindings for local dev)
- Binding inference mechanism
- `void/kv`, `void/ai`, `void/storage` — unaffected

## Migration Guide (Breaking Change)

Users upgrading from the old `void/db`:

1. Update `void` to the latest version (drizzle-orm and drizzle-kit are now included)
2. Create `db/schema.ts` defining tables (replaces the hand-written SQL migrations as source of truth)
3. Move existing migrations: `migrations/` -> `db/migrations/`
4. Replace QueryClient calls with Drizzle query builder:
   - `db.list("users")` -> `db.select().from(users).all()`
   - `db.get("users", { where: { id } })` -> `db.select().from(users).where(eq(users.id, id)).get()`
   - `db.insert("users", data)` -> `db.insert(users).values(data)`
   - `db.update("users", { set, where })` -> `db.update(users).set(set).where(...)`
   - `db.delete("users", { where })` -> `db.delete(users).where(...)`
   - `db.raw(sql, bindings)` -> `db.run(sql`...`)`
   - `db.count("users")` -> `db.select({ count: count() }).from(users).get()`
5. Update imports: `import { db } from "void/db"` still works (same path), but schema imports change to `import { users } from "@schema"`
