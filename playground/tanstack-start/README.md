# TanStack Start Playground

Demonstrates Void integration with the TanStack Start meta-framework — TanStack handles routing and SSR, Void provides Cloudflare bindings, migrations, and deployment.

## Structure

```
src/
  router.tsx              # Router configuration
  routeTree.gen.ts        # Auto-generated route tree
  routes/
    __root.tsx            # Root layout with nav
    index.tsx             # Home page with server function
    users.tsx             # Users page — D1 query via server function
  types/
    bindings.d.ts         # Worker bindings type
db/
  schema.ts                # Drizzle schema
  migrations/              # Users table with sample data
```

## Features

- **File-based routing** — TanStack's file-based routing from `src/routes/`
- **Server functions** — `createServerFn().handler()` for type-safe server-side operations
- **Data loaders** — `loader()` on routes pre-fetches data before component render
- **D1 integration** — server function queries D1 through `db` from `void/db`
- **SSR** — TanStack Start handles SSR + client hydration automatically
- **Plugin ordering** — `voidPlugin()` must come **before** `tanstackStart()` in the Vite plugins array
