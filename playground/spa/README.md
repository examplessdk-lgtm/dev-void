# SPA Playground

React SPA with API routes demonstrating routing, input validation, typed database queries, middleware, and cron jobs.

## Structure

```
src/
  App.tsx              # React UI with typed fetch client
  main.tsx             # React DOM entry point
routes/api/
  hello.ts             # GET — returns { message, timestamp }
  users/
    index.ts           # GET list + POST create (valibot validation)
    [id].ts            # GET single user by param
  kv/
    [key].ts           # PUT store + GET read a value in KV (:key param)
middleware/
  01.logger.ts         # Logs method + path for every request
db/
  schema.ts            # Drizzle schema
  migrations/          # Creates users table (id, name, email, created_at)
  seed.sql             # Seeds sample data
crons/
  hourly-heartbeat.ts  # Writes last-heartbeat timestamp to KV every hour
```

## Features

- **Named method exports** — route files export `GET`, `POST`, etc. as separate handlers
- **Input validation** — `defineHandler.withValidator()` with valibot schemas for body and params
- **Typed fetch client** — `fetch` from `void/client` with full type inference from route definitions
- **Typed DB queries** — Drizzle ORM via `db` from `void/db` with schema defined in `db/schema.ts`
- **KV storage** — `c.env.KV` read/write in a route, plus the cron writing a heartbeat key
- **Middleware** — `defineMiddleware` for cross-cutting concerns (request logging)
- **Cron jobs** — `defineScheduled` with cron expression syntax (`"0 * * * *"`)
- **SQL migrations** — auto-applied on dev server start
- **Seamless tsconfig** — extends `.void/tsconfig.json` for auto type discovery
