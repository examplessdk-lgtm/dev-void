---
title: PostgreSQL via Hyperdrive
status: done
created: 2026-03-06
depends: 0054-versioned-deployments
---

# PostgreSQL via Hyperdrive

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

Extend Void's built-in Drizzle integration to support PostgreSQL via Cloudflare Hyperdrive, alongside the existing D1/SQLite default.

## Motivation

D1 is great for read-heavy apps and prototyping, but some projects need PostgreSQL — richer types, full-text search, JSON operators, or compatibility with an existing database. Cloudflare Hyperdrive provides connection pooling and caching for external Postgres databases, making it a natural fit.

With the Drizzle-first-class work (0050), the plugin already uses virtual modules and config-driven code generation. Adding a second dialect is architecturally feasible.

## Configuration

```jsonc
// void.json
{
  "database": {
    "dialect": "postgresql", // default: "sqlite"
  },
}
```

When `dialect` is `"postgresql"`, the plugin swaps every D1-specific piece for its Postgres equivalent.

## What Changes Per Dialect

| Piece                    | `sqlite` (default)                       | `postgresql`                                                |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| `void/schema-helpers`    | re-exports `drizzle-orm/sqlite-core`     | re-exports `drizzle-orm/pg-core`                            |
| `void/db` virtual module | `drizzle(d1)` via `drizzle-orm/d1`       | `drizzle(connectionString)` via `drizzle-orm/node-postgres` |
| Runtime binding          | `env.DB` (D1)                            | `env.HYPERDRIVE.connectionString`                           |
| `drizzle-kit` config     | `dialect: "sqlite"`, `driver: "d1-http"` | `dialect: "postgresql"`                                     |
| Local dev                | auto-provisioned SQLite file             | requires `DATABASE_URL` in `.dev.vars`                      |
| `void gen model`         | `sqliteTable` + `integer`/`text`         | `pgTable` + `serial`/`varchar`/`timestamp`                  |

## Design

### `void/schema-helpers` (virtual module)

Currently a static re-export of `drizzle-orm/sqlite-core`. With dialect support, the plugin intercepts the import and serves the right dialect's exports:

```ts
// dialect: "sqlite"
export * from 'drizzle-orm/sqlite-core';

// dialect: "postgresql"
export * from 'drizzle-orm/pg-core';
```

The `sql` tag and `void/db` operators (`eq`, `desc`, etc.) are dialect-agnostic — no changes needed.

### `void/db` (virtual module)

```ts
// dialect: "postgresql"
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@schema';

let _env;
try {
  _env = (await import('cloudflare:workers')).env;
} catch {}

export const db = drizzle(_env.HYPERDRIVE.connectionString, { schema });
```

### Deploy Manifest

The manifest declares Hyperdrive bindings using the same flat pattern as D1:

```ts
bindings: {
  d1?: string[];         // e.g. ["DB"]
  hyperdrive?: string[]; // e.g. ["HYPERDRIVE"]
  kv?: string[];
  r2?: string[];
  ai?: boolean;
}
```

The binding name defaults to `"HYPERDRIVE"`. Binding inference is config-driven — the framework reads `dialect` from `void.json` and sets `needsHyperdrive` instead of `needsD1`. The existing import-based inference (`void/db`) still triggers database detection; the config determines which binding type.

### Hyperdrive Provisioning

**The platform owns the Hyperdrive lifecycle**, matching the D1 precedent where the user never interacts with the underlying CF resource directly.

User provides their Postgres connection string as a project secret:

```bash
void secrets set DATABASE_URL "postgresql://user:pass@host:5432/db"
```

On first deploy with `dialect: "postgresql"`, the API:

1. Reads the `DATABASE_URL` secret
2. Creates a Hyperdrive config via CF API (`POST /hyperdrive/configs`)
3. Stores the Hyperdrive config ID on the project record
4. Binds it to the user's worker as `HYPERDRIVE`

Subsequent deploys reuse the existing Hyperdrive config. If the user updates `DATABASE_URL`, the API updates the Hyperdrive config accordingly. On project deletion, the Hyperdrive config is cleaned up.

### Local Dev

Requires a `DATABASE_URL` in `.dev.vars` pointing at a real Postgres (local or remote):

```
DATABASE_URL=postgresql://user:pass@localhost:5432/myapp
```

The `void/db` virtual module in dev mode connects directly via `pg` — no Hyperdrive shim, no proxy worker involvement. This is consistent with how `wrangler dev` handles Hyperdrive locally (falls back to direct connection).

CLI commands (`void db push`, `void db generate`, `void db migrate`, `void db studio`) use the same connection string.

### Deploy Migrations (via Versioned Deploys)

Depends on **0054 Versioned Deployments**. The migration flow:

1. Framework bundles migration SQL into the worker at build time (embedded in a virtual module)
2. Framework injects a `/__void/migrate` reserved route into the worker entry point
3. API deploys the new worker version (not yet serving traffic)
4. API invokes the new worker via `env.DISPATCH.get("user-{slug}-v{N}")` with a request to `/__void/migrate`
5. Worker runs migration SQL against its own `HYPERDRIVE` binding, returns success/failure
6. On success: API updates KV routing to the new version, traffic switches atomically
7. On failure: deployment marked as failed, routing unchanged

This eliminates the need for the API to handle user database credentials at migration time — the worker uses its own Hyperdrive binding. It also works identically for D1 projects once versioned deploys are implemented.

### Migration Bundling

Migration SQL files are embedded into the worker at build time via a virtual module:

```ts
// virtual:void-migrations (generated by plugin)
export const migrations = [
  { name: '0001_initial', sql: 'CREATE TABLE ...' },
  { name: '0002_add_posts', sql: 'ALTER TABLE ...' },
];
```

The `/__void/migrate` handler reads this module, checks a `_void_migrations` tracking table, and applies pending migrations in order within a transaction.

### `void gen model`

Generates dialect-appropriate table definitions:

```ts
// dialect: "postgresql" — void gen model post
import { pgTable, serial, text, timestamp } from 'void/schema-helpers';

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

## Decisions

| Question                               | Decision                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Multi-dialect in one project?          | No — one dialect per project.                                                |
| Other dialects (MySQL, Turso)?         | Same pattern applies, but scoped to Postgres first.                          |
| PGlite for zero-config local dev?      | Deferred — compatibility risk too high for v1. Revisit when PGlite matures.  |
| Who provisions Hyperdrive?             | Platform — user provides `DATABASE_URL` secret, API manages Hyperdrive CRUD. |
| Who runs deploy migrations?            | The user's worker itself, via versioned deploys (0054).                      |
| Where is the connection string stored? | Existing secrets system (`DATABASE_URL`).                                    |
| How are migrations bundled?            | Embedded in the worker at build time as a virtual module.                    |
| How does the worker expose migrations? | Reserved `/__void/migrate` route, invoked by API before traffic switch.      |

## Implementation Scope

### Framework changes (`void` package)

- `void/schema-helpers` virtual module: dialect-aware re-exports
- `void/db` virtual module: Postgres code path via `drizzle-orm/node-postgres`
- `void gen model`: Postgres table scaffolding
- CLI commands: Postgres-aware `drizzle-kit` config generation
- Migration bundling: virtual module embedding SQL files
- `/__void/migrate` route injection in worker entry point
- Deploy manifest: `bindings.hyperdrive` field
- Binding inference: config-driven `needsHyperdrive` flag

### Platform changes (`api` package)

- Hyperdrive CRUD via CF API (create, update, delete)
- Project record: store Hyperdrive config ID
- Deploy flow: provision Hyperdrive binding, invoke `/__void/migrate` on new version
- Secret handling: read `DATABASE_URL` for Hyperdrive provisioning
- Depends on 0054 (versioned deploys) for migration execution flow
