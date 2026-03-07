---
outline: deep
---

# Database

Void provides a first-class [Drizzle ORM](https://orm.drizzle.team) integration for [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite). Define your schema as TypeScript, import a pre-wired Drizzle instance from `void/db`, and start querying — no extra install needed.

D1 is suitable for most small to medium apps that are read heavy. It's also great for prototyping as Void will seamlessly create a local instance for you without any setup. That said, you are welcome to use any [ORM or external database](../integrations/orms-and-external-dbs.md) you prefer.

## Schema Definition

Define your tables in `db/schema.ts` using [Drizzle's SQLite column helpers](https://orm.drizzle.team/docs/column-types/sqlite). This file is the source of truth for your database structure:

```ts
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-helpers";
import { sql } from "void/db";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("user"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

Everything ships with `void` — there is nothing extra to install. You don't have to write this by hand — use `void gen model` or let your coding agent generate it.

You can also split your schema across multiple files under `db/schema/` and re-export from a barrel file:

```ts
// db/schema/users.ts
export const users = sqliteTable("users", { ... });

// db/schema/posts.ts
export const posts = sqliteTable("posts", { ... });

// db/schema.ts (barrel)
export * from "./schema/users";
export * from "./schema/posts";
```

## Querying

Void re-exports all common [Drizzle query operators](https://orm.drizzle.team/docs/select) from `void/db` so you don't need to install `drizzle-orm` separately. Import `db` from `void/db` and your tables from `@schema` (an alias for `db/schema.ts` that the framework configures automatically):

```ts
import { db } from "void/db";
import { users } from "@schema";
```

### List rows

```ts
const allUsers = await db.select().from(users).all();
```

### Filter with `where`

```ts
import { db, eq, and, or } from "void/db";
import { users } from "@schema";

// Single condition
const user = await db.select().from(users).where(eq(users.id, 1)).get();

// Multiple conditions
const admins = await db
  .select()
  .from(users)
  .where(and(eq(users.role, "admin"), eq(users.name, "Alice")))
  .all();

// OR conditions
const result = await db
  .select()
  .from(users)
  .where(or(eq(users.role, "admin"), eq(users.role, "editor")))
  .all();
```

### Insert

```ts
// Single row
await db.insert(users).values({
  name: "Alice",
  email: "alice@example.com",
});

// Insert and return the created row
const [created] = await db
  .insert(users)
  .values({ name: "Bob", email: "bob@example.com" })
  .returning();

// Multiple rows
await db.insert(users).values([
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
]);
```

### Update

```ts
await db.update(users).set({ role: "admin" }).where(eq(users.id, 1));

// Update and return the modified row
const [updated] = await db.update(users).set({ role: "admin" }).where(eq(users.id, 1)).returning();
```

### Delete

```ts
await db.delete(users).where(eq(users.id, 1));
```

### Column selection

```ts
const names = await db.select({ name: users.name, email: users.email }).from(users).all();
// names: { name: string; email: string }[]
```

### Ordering and pagination

```ts
import { db, desc } from "void/db";
import { users } from "@schema";

const page = await db
  .select()
  .from(users)
  .orderBy(desc(users.createdAt))
  .limit(10)
  .offset(20)
  .all();
```

### Joins

```ts
import { db, eq } from "void/db";
import { users, posts } from "@schema";

const results = await db
  .select({
    id: posts.id,
    title: posts.title,
    author: users.name,
  })
  .from(posts)
  .innerJoin(users, eq(posts.userId, users.id))
  .all();
```

### Batch operations

D1 supports batching multiple statements into a single round-trip:

```ts
await db.batch([
  db.delete(posts).where(eq(posts.userId, userId)),
  db.delete(users).where(eq(users.id, userId)),
]);
```

### Relational queries

If your schema defines [relations](https://orm.drizzle.team/docs/relations), you can use Drizzle's relational query API:

```ts
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

The user schema is automatically loaded into the `db` instance via a Vite plugin, so relational queries work out of the box.

::: warning ⚠️ Nuxt limitation
Nuxt uses Nitro, which bundles server routes outside of Vite's plugin pipeline. The schema cannot be injected into the `db` instance, so `db.query.*` relational queries are not available in Nuxt. Use the standard query builder API (`db.select().from(table)`) instead.
:::

## Migrations & Prototyping

Void offers two workflows for applying schema changes to your database.

### Prototyping with `push`

During development, use `void db push` to apply your schema directly to the local D1 database — no migration files created:

```bash
void db push
```

This diffs your Drizzle schema against the local database and applies the changes immediately. It's fast and ideal for iterating on your schema before committing to a migration.

### Production migrations

When you're ready to ship, generate SQL migration files from your schema:

```bash
void db generate
```

This creates timestamped SQL files in `db/migrations/` that capture the diff between your schema and the last generated migration. On deploy, these migrations run against the remote D1 database before the new worker goes live.

To apply pending migrations locally:

```bash
void db migrate
```

## CLI Commands

| Command            | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `void db push`     | Apply schema directly to local D1 (no migration files)        |
| `void db generate` | Generate SQL migration files from schema changes              |
| `void db migrate`  | Apply pending migrations locally                              |
| `void db status`   | Show schema drift and pending migrations                      |
| `void db reset`    | Drop the local DB and re-apply all migrations                 |
| `void db seed`     | Reset + run seed file (`--file <path>`)                       |
| `void db execute`  | Run ad-hoc SQL against local DB (`--file <path>`)             |
| `void db studio`   | Open Drizzle Studio for the local database                    |
| `void db export`   | Dump local DB as SQL (`--output`, `--no-data`, `--no-schema`) |

See the [CLI reference](../reference/cli.md#database) for details.

## Scaffolding

The `void gen model` command scaffolds a Drizzle table definition and updates your barrel export:

```bash
void gen model post title:string body:text published:boolean
```

This creates:

1. `db/schema/post.ts` — a Drizzle table definition with `id`, `createdAt`, `updatedAt`, and your columns
2. Updates `db/schema.ts` with `export * from "./schema/post"`
3. `routes/api/posts/index.ts` — GET (list) + POST (insert with validation)
4. `routes/api/posts/[id].ts` — GET by id with 404 handling

**Validator detection:** The generated routes use whichever validation library your project already has installed. The CLI checks `package.json` for [valibot](https://valibot.dev/), [zod](https://zod.dev/), or [arktype](https://arktype.io/) (in that order). If none is found, you'll be prompted to choose one or skip validation entirely.

Column format is `name:type`, with an optional `?` suffix for nullable:

| Type                         | Drizzle Column                                | Nullable             |
| ---------------------------- | --------------------------------------------- | -------------------- |
| `string`, `text`, `datetime` | `text(...).notNull()`                         | `text(...)`          |
| `integer`                    | `integer(...).notNull()`                      | `integer(...)`       |
| `boolean`                    | `integer(..., { mode: "boolean" }).notNull()` | without `.notNull()` |
| `real`                       | `real(...).notNull()`                         | `real(...)`          |

See the [CLI reference](../reference/cli.md#code-generation) for the full list of generators.

## Schema-Derived Validators

Instead of writing validator schemas by hand, you can derive them directly from your Drizzle tables using [`drizzle-valibot`](https://orm.drizzle.team/docs/typebox) or [`drizzle-zod`](https://orm.drizzle.team/docs/zod). This keeps your validation in sync with your database schema automatically.

::: code-group

```ts [Valibot]
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-helpers";
import { sql } from "void/db";
import { createInsertSchema } from "drizzle-valibot";
import { pipe, minLength, email } from "valibot";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const insertUserSchema = createInsertSchema(users, {
  name: (schema) => pipe(schema, minLength(1)),
  email: (schema) => pipe(schema, email()),
});
```

```ts [Zod]
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-helpers";
import { sql } from "void/db";
import { createInsertSchema } from "drizzle-zod";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const insertUserSchema = createInsertSchema(users, {
  name: (schema) => schema.min(1),
  email: (schema) => schema.email(),
});
```

:::

`createInsertSchema` generates a validator that matches `$inferInsert` — columns with defaults or auto-increments become optional, `NOT NULL` columns are required. The optional second argument refines individual columns via a callback that receives the auto-generated schema.

Use the derived schema in your route handlers with [`withValidator()`](./server-routing.md#validation):

```ts
// routes/api/users/index.ts
import { defineHandler } from "void";
import { db } from "void/db";
import { users, insertUserSchema } from "@schema";

export const POST = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  const [created] = await db.insert(users).values(body).returning();
  return created;
});
```

Three functions are available:

| Function             | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `createInsertSchema` | Validates insert data — excludes auto-generated columns, applies defaults |
| `createSelectSchema` | Matches the shape of selected rows                                        |
| `createUpdateSchema` | Like insert but all fields are optional (partial update)                  |

Install whichever package matches your validator:

```bash
npm install drizzle-valibot valibot
# or
npm install drizzle-zod zod
```

## Deploy Workflow

When you run `void deploy`:

1. The app is built
2. Migration files are collected from `db/migrations/`
3. If the schema has drifted ahead of the migrations, you're prompted to generate and commit the new migrations
4. Pending migrations run against the remote D1 database
5. The new worker goes live

Deploy always goes through migration files — `push` is for local development only.
