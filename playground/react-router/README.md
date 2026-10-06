# React Router v7 Playground

Demonstrates Void integration with React Router v7 framework mode — React Router handles routing and SSR, Void provides Cloudflare bindings, migrations, and deployment.

## Structure

```
app/
  root.tsx                # Root layout with nav
  routes.ts               # Explicit route config
  routes/
    home.tsx              # Home page
    users.tsx             # Users page — D1 query via loader
    smoke.tsx             # Smoke test — D1 + KV via void/db and void/kv
db/
  schema.ts                # Drizzle schema
  migrations/              # Users table with sample data
```

## Features

- **Explicit route config** — React Router v7 uses `app/routes.ts` for route definitions
- **Loaders** — `loader()` exports for server-side data fetching
- **D1 integration** — loader queries D1 through `db` from `void/db`
- **SSR** — React Router v7 handles SSR + client hydration automatically
- **Plugin ordering** — `voidPlugin()` must come **before** `reactRouter()` in the Vite plugins array
