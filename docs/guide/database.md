---
outline: deep
---

<script setup>
const dbFileItems = [
  {
    name: "db/",
    children: [
      { name: "schema.ts", description: "Table definitions (source of truth)" },
      {
        name: "schema/",
        description: "Split schema files (optional)",
        children: [
          { name: "users.ts" },
          { name: "posts.ts" },
        ],
      },
      {
        name: "migrations/",
        description: "Generated SQL migration files",
        children: [
          { name: "0000_initial.sql" },
          { name: "0001_add_posts.sql" },
        ],
      },
      { name: "seed.ts", description: "Seed script (optional)" },
    ],
  },
]
</script>

# Database

Void provides a first-class [Drizzle ORM](https://orm.drizzle.team) integration. Define your schema as TypeScript, import a pre-wired Drizzle instance from `void/db`, and start querying — no extra install needed.

<FileTree :items="dbFileItems" default-expanded />

## Choosing a Dialect

Void supports two database backends. Both use the same Drizzle-based workflow for schema definition, querying, and migrations.

|            | [D1 (SQLite)](./database/d1) | [PostgreSQL](./database/postgresql)          |
| ---------- | ---------------------------- | -------------------------------------------- |
| Config     | Default (no config needed)   | `"database": "pg"` in `void.json`            |
| Managed by | Void (fully managed)         | Bring your own database                      |
| Best for   | Read-heavy apps, prototyping | Write-heavy, complex queries, existing infra |
| Connection | Automatic D1 binding         | Hyperdrive connection pooling                |

## Schema Definition

Define your tables in `db/schema.ts` using column helpers from `void/schema-d1` or `void/schema-pg`. This file is the source of truth for your database structure:

::: code-group

```ts [SQLite (D1)]
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-d1";
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

```ts [PostgreSQL]
// db/schema.ts
import { pgTable, serial, text, timestamp } from "void/schema-pg";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

:::

Everything ships with `void` — there is nothing extra to install. You don't have to write this by hand — use `void gen model` or let your coding agent generate it.

You can also split your schema across multiple files under `db/schema/` and re-export from a barrel file:

```ts
// db/schema/users.ts
export const users = ...;

// db/schema/posts.ts
export const posts = ...;

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
const allUsers = await db.select().from(users);
```

### Filter with `where`

```ts
import { db, eq, and, or } from "void/db";
import { users } from "@schema";

// Single condition
const user = await db.select().from(users).where(eq(users.id, 1));

// Multiple conditions
const admins = await db
  .select()
  .from(users)
  .where(and(eq(users.role, "admin"), eq(users.name, "Alice")));

// OR conditions
const result = await db
  .select()
  .from(users)
  .where(or(eq(users.role, "admin"), eq(users.role, "editor")));
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
const names = await db.select({ name: users.name, email: users.email }).from(users);
// names: { name: string; email: string }[]
```

### Ordering and pagination

```ts
import { db, desc } from "void/db";
import { users } from "@schema";

const page = await db.select().from(users).orderBy(desc(users.createdAt)).limit(10).offset(20);
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
  .innerJoin(users, eq(posts.userId, users.id));
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

## Schema-Derived Validators

Instead of writing validator schemas by hand, you can derive them directly from your Drizzle tables using [`drizzle-zod`](https://orm.drizzle.team/docs/zod), [`drizzle-valibot`](https://orm.drizzle.team/docs/typebox), or [`drizzle-arktype`](https://orm.drizzle.team/docs/arktype). This keeps your validation in sync with your database schema automatically.

::: code-group

```ts [Zod]
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-d1";
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

```ts [Valibot]
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-d1";
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

```ts [ArkType]
// db/schema.ts
import { sqliteTable, text, integer } from "void/schema-d1";
import { sql } from "void/db";
import { createInsertSchema } from "drizzle-arktype";
import { type } from "arktype";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const insertUserSchema = createInsertSchema(users, {
  name: type("string > 0"),
  email: type("string.email"),
});
```

:::

`createInsertSchema` generates a validator that matches `$inferInsert` — columns with defaults or auto-increments become optional, `NOT NULL` columns are required. The optional second argument refines individual columns — either via a callback that receives the auto-generated schema, or by passing a type directly to override the field.

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
npm install drizzle-zod zod
# or
npm install drizzle-valibot valibot
# or
npm install drizzle-arktype arktype
```

## CLI Commands

| Command            | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `void db push`     | Apply schema directly to local database (no migration files)  |
| `void db generate` | Generate SQL migration files from schema changes              |
| `void db migrate`  | Apply pending migrations locally                              |
| `void db status`   | Show schema drift and pending migrations                      |
| `void db reset`    | Drop the local DB and re-apply all migrations                 |
| `void db seed`     | Reset + run seed file (`--file <path>`)                       |
| `void db execute`  | Run ad-hoc SQL against local DB (`--file <path>`)             |
| `void db studio`   | Open Drizzle Studio for the local database                    |
| `void db export`   | Dump local DB as SQL (`--output`, `--no-data`, `--no-schema`) |
| `void db set-url`  | Update the PostgreSQL connection string for deployment        |

See the [CLI reference](../reference/cli.md#database) for details.

## Scaffolding

The `void gen model` command scaffolds a Drizzle table definition and updates your barrel export. It generates dialect-appropriate code — `sqliteTable` for D1, `pgTable` for PostgreSQL:

```bash
void gen model post title:string body:text published:boolean
```

This creates:

1. `db/schema/post.ts` — a Drizzle table definition with `id`, `createdAt`, `updatedAt`, and your columns
2. Updates `db/schema.ts` with `export * from "./schema/post"`
3. `routes/api/posts/index.ts` — GET (list) + POST (insert with validation)
4. `routes/api/posts/[id].ts` — GET by id with 404 handling

See the [CLI reference](../reference/cli.md#code-generation) for the full list of generators.
