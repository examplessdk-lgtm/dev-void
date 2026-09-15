---
title: Drizzle-Native Better Auth Integration
status: draft
created: 2026-03-10
depends: 0050-drizzle-first-class, 0052-postgres-hyperdrive, 0057-better-auth-integration
---

# Drizzle-Native Better Auth Integration

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Shift Void's Better Auth runtime from Better Auth's raw database / Kysely migration path to a Drizzle-native integration that reuses Void's database runtime and generated auth schema.

This work is specifically solving two inefficiencies in the original Better Auth integration:

- request-time auth for PostgreSQL created its own `pg.Pool`, even though production Void apps already connect through Hyperdrive
- `/api/auth/*` requests instantiated `betterAuth()` twice, once in auth middleware and again in the auth route handler

The new design keeps Better Auth as the auth engine, but makes Void responsible for generating the Drizzle schema and wiring the adapter/runtime around it.

At a high level:

- Void generates Better Auth Drizzle tables into `.void/better-auth-schema.ts`
- Void generates a Better Auth database adapter module into `.void/better-auth-db.ts`
- request-time auth uses `drizzleAdapter(db, { provider, schema })` on top of `void/db`
- auth middleware stashes the Better Auth instance on Hono context so `/api/auth/*` reuses it
- auth migrations use the generated auth schema directly through a small Void-owned live migrator instead of Better Auth's Kysely migration runner

## Motivation

### 1. Remove redundant auth-owned PostgreSQL pooling

The original PostgreSQL auth runtime created a `pg.Pool({ max: 1 })` per request inside `better-auth-pg.ts`, then disposed it after use.

That is the wrong shape for Void apps:

- production Void PostgreSQL apps connect through Hyperdrive, which already owns pooling
- the app already has a Drizzle database runtime via `void/db`
- auth requests already run inside the same Hono request flow as the rest of the app

If auth can talk to the database through the app's own Drizzle runtime, Better Auth does not need to create its own request-time PostgreSQL client path.

### 2. Stop instantiating Better Auth twice on auth routes

The original runtime always did:

1. middleware: create Better Auth, call `getSession()`
2. `/api/auth/*` route: create Better Auth again, call `handler()`

That means auth requests paid for two full Better Auth initializations even though both happen in the same Hono request.

### 3. Align the adapter story with Better Auth's Drizzle path

Better Auth's Drizzle adapter expects actual Drizzle table objects for auth tables. Void did not have those because:

- `void/db` only reflected the app's user schema
- Better Auth tables were being created through Better Auth's own migration runner
- auth runtime used raw D1 / `pg.Pool` objects rather than `drizzleAdapter(...)`

To make Better Auth truly Drizzle-native in Void, we need auth table definitions that Void owns and can pass explicitly.

## Goals

- Make Better Auth request handling use a Drizzle adapter instead of raw D1 / raw PostgreSQL objects.
- Reuse `void/db` for auth requests so auth follows the same database path as the app.
- Make `void/db` available even for schema-less auth apps.
- Avoid Better Auth-owned request-time PostgreSQL pools for normal auth traffic.
- Avoid double `betterAuth()` instantiation on `/api/auth/*`.
- Drive auth migrations from the generated auth schema instead of Better Auth's Kysely migration runner.

## Non-Goals

- Removing `pg.Pool` from the entire Void stack.
- Merging Better Auth tables into the user's own Drizzle schema or `void/db` type surface.
- Exposing Better Auth's CLI directly as a required part of Void auth setup.
- Supporting destructive auth schema diffs in the first migration pass.

## Why Not Use `npx auth generate` Directly

We checked Better Auth's CLI source and docs.

The CLI's `generate` command is just schema codegen. It derives auth table metadata from Better Auth config and emits ORM-specific schema. For Drizzle, it ultimately generates tables from `getAuthTables(...)`.

That means the CLI confirmed the right direction, but it is not the right integration boundary for Void:

- it expects a normal Better Auth config export, while Void apps expose `defineAuth(...)`
- it would force Void to shell out to an external CLI during codegen
- it would make the build more brittle than necessary

So Void adopts the same underlying model without invoking the CLI:

- resolve the effective Better Auth options from Void auth config
- derive auth table metadata from Better Auth's schema helpers
- emit the Drizzle schema directly during Void codegen

## Design

### 1. Generate a Better Auth Drizzle schema during Void codegen

New module:

- `packages/void/src/auth/drizzle.ts`

This module resolves the effective Better Auth config and generates:

- Drizzle table definitions for Better Auth tables
- a `schema` object suitable for `drizzleAdapter(...)`
- a normalized `migrationSchema` object for Void's auth migration runner

The generated file is:

- `.void/better-auth-schema.ts`

This file is internal to Void codegen. It is not meant to be part of the user-authored app surface.

### 2. Generate a Better Auth database adapter module

New generated file:

- `.void/better-auth-db.ts`

It looks conceptually like this:

```ts
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from 'void/db';
import { schema } from './better-auth-schema';

export const __voidAuthDatabase = drizzleAdapter(db, {
  provider: 'pg' | 'sqlite',
  schema,
});
```

Important design choice:

- this generates a separate Better Auth adapter
- but not a separate Drizzle instance in the normal case

The adapter rides on top of the app's `void/db` runtime.

### 3. Make `void/db` available for schema-less auth apps

Previously, `void/db` was only virtualized when a user Drizzle schema existed.

That is not enough for auth, because Better Auth can manage its own tables even when the user does not have a `db/schema.ts`.

So `plugin-drizzle.ts` now supports a forced runtime path:

- when auth is enabled, `void/db` is generated even without a user schema
- `.void/db.d.ts` is still emitted
- `.void/tsconfig.json` still maps `void/db`
- if no user schema exists, the database type is untyped (`Record<string, never>`) rather than schema-aware

This makes auth consistently "DB-backed" whenever auth is enabled.

### 4. Thread the generated auth adapter through route compilation

`plugin-routing.ts` now generates both:

- `.void/better-auth-schema.ts`
- `.void/better-auth-db.ts`

`compile.ts` imports those generated modules into the route table and passes the adapter into auth runtime helpers:

- `runVoidAuthMiddleware(...)`
- `handleVoidAuthRequest(...)`
- `resolveVoidAuthState(...)` for websocket auth

This means request-time auth uses the shared adapter instead of falling back to `resolveDatabase(env)` in the runtime package.

### 5. Reuse the Better Auth instance on auth routes

`better-auth-shared.ts` now stashes the middleware-created Better Auth instance on the Hono context:

```ts
c.set('__voidAuth', auth);
```

Then `/api/auth/*` handling does:

```ts
const auth = c.get("__voidAuth") ?? (await createVoidAuth(...)).auth;
```

Effect:

- normal requests still resolve session/user state in middleware
- `/api/auth/*` requests reuse that same Better Auth instance
- disposal stays centralized in the middleware `finally` path when reuse happens

This removes the second `betterAuth()` instantiation for auth requests.

### 6. Keep user database overrides higher priority

`defineAuth()` can still override Better Auth's `database` option.

The generated Drizzle adapter is passed into the runtime as a default database override, but `resolveUserConfig(...)` still lets explicit user config win.

That preserves the existing advanced escape hatch.

## Migration Strategy

### Better Auth's recommendation

Better Auth's docs say:

- if you use `drizzleAdapter(...)`, use generated Drizzle schema plus your ORM's migration flow
- Better Auth's own `migrate` command is for the built-in Kysely adapter path

Void's original integration violated that split:

- request-time auth was moved toward Drizzle
- but auth migrations still used Better Auth's Kysely migration runner

### Why Void does not use `drizzle-kit generate` for auth migrations

Auth schema is framework-generated into `.void/`, not user-owned source.

That creates a problem for snapshot-based Drizzle migrations:

- a fresh clone or CI environment only sees the latest generated auth schema
- it does not have a durable history of prior auth schema snapshots in source control
- generating SQL snapshots from `.void/` would risk producing a fresh baseline rather than a safe incremental migration

That is not acceptable for framework-managed auth tables.

### Void-owned live auth migrator

To avoid the snapshot-history problem, Void now owns a minimal auth migration runner:

- `packages/void/src/runtime/auth-migrations.ts`

It uses the generated `migrationSchema` and does live "ensure" diffs:

- create missing tables
- add missing columns
- create missing indexes

This runs in both places:

- local dev auth migrations via `src/auth/node.ts`
- deploy-time `/__void/migrate` auth migrations via `better-auth-shared.ts`

For SQLite:

- introspect `sqlite_master`, `PRAGMA table_info`, `PRAGMA index_list`

For PostgreSQL:

- introspect `information_schema.tables`
- introspect `information_schema.columns`
- introspect `pg_indexes`

For PostgreSQL serial IDs:

- the migrator creates `id` as `integer GENERATED BY DEFAULT AS IDENTITY`

### Scope of the current migrator

The current auth migrator is intentionally additive only.

It does not attempt to:

- drop columns
- rename columns
- change column types
- remove indexes
- reconcile changed nullability or changed foreign-key behavior on existing columns

This is acceptable for the current Better Auth integration because the immediate goal is to make framework-managed auth tables safe and cheap to initialize across local dev and deploys.

If Better Auth schema evolution later needs destructive or type-changing diffs, Void will need a second-phase migration design.

## Runtime Behavior After the Change

### D1 / SQLite

Request-time auth:

- `void/db` exposes the D1-backed Drizzle runtime
- Better Auth receives `drizzleAdapter(db, { provider: "sqlite", schema: authSchema })`

Auth migrations:

- local dev uses the local sqlite file path already used by Void
- deploy-time uses the app's `DB` binding through `/__void/migrate`

### PostgreSQL / Hyperdrive

Request-time auth:

- `void/db` is the single database path
- production requests use the Hyperdrive-backed Drizzle runtime
- Better Auth does not create its own request-time auth-specific PostgreSQL pool

Auth migrations:

- local dev connects with `pg.Client` using `DATABASE_URL`
- deploy-time worker migrations connect with `pg.Client` using `env.HYPERDRIVE.connectionString`

Important nuance:

- this removes redundant Better Auth-owned request-time pooling
- it does not remove `pg.Pool` from the underlying `void/db` local PostgreSQL runtime

That broader `void/db` pooling story remains separate work.

## Files Changed

### Codegen / DB surface

- `packages/void/src/auth/drizzle.ts`
- `packages/void/src/plugin-routing.ts`
- `packages/void/src/plugin-drizzle.ts`
- `packages/void/src/codegen/project-tsconfig.ts`
- `packages/void/src/index.ts`
- `packages/void/src/cli/gen.ts`
- `packages/void/src/cli/init.ts`
- `packages/void/src/router/compile.ts`

### Runtime

- `packages/void/src/runtime/better-auth-shared.ts`
- `packages/void/src/runtime/auth-migrations.ts`
- `packages/void/src/auth/node.ts`
- `packages/void/src/runtime/better-auth-pg.ts`

### Tests

- `packages/void/test/unit/auth-drizzle.test.ts`
- `packages/void/test/unit/auth-migrations.test.ts`
- `packages/void/test/unit/compile-auth.test.ts`
- `packages/void/test/unit/plugin-drizzle.test.ts`

## Verification

The implementation has been verified with:

- targeted unit coverage for auth Drizzle codegen, auth migration behavior, compile-time auth wiring, and schema-less `void/db`
- `pnpm -C framework check`
- `pnpm -C framework test packages/void`

At the time of writing, the full `packages/void` test suite passes with this design in place.

## Remaining Work / Open Questions

### 1. `void/db` PostgreSQL runtime still uses `pg.Pool` in local dev

This design removes the redundant Better Auth-specific pool, but the underlying `void/db` PostgreSQL dev runtime still uses `pg.Pool` when `DATABASE_URL` is present.

That was intentionally left alone because the original work was scoped at the auth layer first.

### 2. Auth schema evolution is additive-only

The new live migrator is not a full schema migration framework.

If Better Auth plugin expansion or upstream schema changes require non-additive diffs, Void will need a stronger migration format for framework-generated auth schema.

### 3. Auth tables remain separate from the app's user schema surface

This design keeps auth schema internal and passed explicitly into `drizzleAdapter(...)`.

That avoids user-schema collisions and keeps the implementation smaller, but it also means auth tables are not automatically part of the user-facing `void/db` schema types.

## Decision

Void should treat Better Auth as Drizzle-native at the framework boundary:

- generate Better Auth schema ourselves
- build a Better Auth Drizzle adapter on top of `void/db`
- make auth imply DB availability even without user schema files
- run auth migrations from the generated schema using a Void-owned additive migrator

This is the simplest design that removes redundant auth-owned PostgreSQL connections, keeps auth aligned with Void's Drizzle-first architecture, and avoids taking a build-time dependency on Better Auth's CLI.
