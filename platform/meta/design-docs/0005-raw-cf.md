# Deploy to Raw Cloudflare

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-16
**Status:** Implemented

---

## Summary

Users can deploy directly to their own Cloudflare account (bypassing the Void platform) by adding a `wrangler.json` with real binding IDs and running `vite build && wrangler deploy`.

The void framework generates a **platform-agnostic** Worker: standard `{ fetch, scheduled }` export (Hono app) with standard CF bindings (`c.env.DB`, `c.env.KV`, `c.env.STORAGE`). No runtime dependency on the platform.

---

## How It Works

The `mergeBindings` function in `index.ts` checks the resolved config from the user's `wrangler.json` (via `@cloudflare/vite-plugin`'s `config` function form) and only adds placeholder bindings for inferred bindings that are **missing** from the user's config.

- **Dev mode:** Local placeholder bindings always work (Miniflare handles local dev regardless of config)
- **Build mode:** If user has a `wrangler.json`, their real binding IDs are preserved
- **Detection is automatic** — no explicit `target: "cloudflare"` option needed

---

## User Workflow

1. Create CF resources manually (`wrangler d1 create`, `wrangler kv namespace create`, etc.)
2. Add `wrangler.json` with real binding IDs:

```json
{
  "name": "my-app",
  "compatibility_date": "2025-12-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ]
}
```

3. Deploy: `vite build && wrangler deploy`

Migrations use wrangler's built-in D1 migration system: `wrangler d1 migrations apply DB --remote`.

---

## What Changes vs. Platform Deploy

| Concern       | Platform (`void deploy`)                 | Raw CF (`wrangler deploy`)                   |
| ------------- | ---------------------------------------- | -------------------------------------------- |
| Worker upload | Workers for Platforms dispatch namespace | Direct `wrangler deploy`                     |
| Static assets | R2 + dispatch worker                     | Workers Static Assets (built into CF plugin) |
| Provisioning  | Auto-create resources via CF API         | User creates manually                        |
| Migrations    | Platform runs via CF REST API            | `wrangler d1 migrations apply`               |
| Auth          | OAuth + JWT via platform API             | N/A (user's own CF account)                  |
| Routing       | `{slug}.apps.example.com` via KV         | User's own domain / `workers.dev`            |

**What doesn't change:** routing plugin, code generation, type generation, runtime (`defineHandler`, `defineMiddleware`, `convertReturnValue`), typed fetch client, DB query helper — all work identically.
