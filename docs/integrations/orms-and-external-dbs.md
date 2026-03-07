---
outline: deep
---

# ORMs and External Databases

Void's built-in database layer uses [Drizzle ORM](../guide/database.md) with D1 out of the box. If you prefer a different query builder, any library that accepts a D1 binding works — just import `env.DB` from `cloudflare:workers` and pass it to your library's initialization function. Void still handles binding inference and deployment regardless of which query layer you use.

You're also free to skip D1 entirely and connect to an external database like PostgreSQL or MySQL — see [External Databases](#external-databases) below.

::: warning ⚠️ Cloudflare env access in meta frameworks
Some frameworks, like Nuxt and SvelteKit, do not run in workerd during dev and therefore do not support directly importing from `cloudflare:workers`.
:::

## Kysely

```ts
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { env } from "cloudflare:workers";

const db = new Kysely<Database>({ dialect: new D1Dialect({ database: env.DB }) });
```

## Raw D1

```ts
import { env } from "cloudflare:workers";

const { results } = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).all();
```

## External Databases

D1 isn't your only option. You can connect to external databases using [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) (connection pooling for PostgreSQL/MySQL) or direct TCP via any database driver that supports `connect()`.

Void's binding inference detects Hyperdrive usage from `env.HYPERDRIVE` and provisions the binding automatically. Add your connection string as a secret:

```bash
void secrets set HYPERDRIVE_CONNECTION_STRING "postgres://user:pass@host:5432/db"
```

```ts
// routes/api/data.ts
import { defineHandler } from "void";
import { env } from "cloudflare:workers";
import postgres from "postgres";

export const GET = defineHandler(async () => {
  const sql = postgres(env.HYPERDRIVE.connectionString);
  const rows = await sql`SELECT * FROM analytics LIMIT 100`;
  return rows;
});
```
