# User Dashboard

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-03-08
**Status:** Implemented (living document)

---

## Summary

A user-facing dashboard for Void, built as a Vue Pages mode app that dogfoods the platform. It provides project management, deployment history, usage monitoring, domain/secrets management, and account settings.

## Architecture

### Package: `platform/packages/dashboard`

- Vue Pages mode app using `voidPlugin()` + `voidVue()`
- Deploys separately at `dash.platform.example.net` / `dash.staging.platform.example.net`
- Tailwind CSS v4 with shared tokens from `@voidcloud/ui`

### Data Access

- **Direct DB reads via Hyperdrive** — middleware creates a Drizzle client from `env.HYPERDRIVE.connectionString`, and read-heavy loaders query the platform Postgres database directly.
- **API for mutations and non-DB reads** — domain changes, secret changes, usage metrics, and similar operations still go through the platform API.

### Auth

OAuth (GitHub/Google) → platform issues JWT → stored in `void_token` httpOnly cookie → middleware validates token and sets request-scoped user state.

### Shared Design System: `platform/packages/ui`

`platform/packages/ui` currently exports shared CSS tokens (`base.css`, `theme.css`) consumed by the dashboard. It is not yet a component library.

## Pages

| Route            | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `/login`         | OAuth buttons                                   |
| `/auth/callback` | Receives platform token and sets cookie         |
| `/`              | Project list + aggregate usage summary          |
| `/projects/:id`  | Deployments, usage, domains, secrets, resources |
| `/settings`      | Profile, provider, plan, limits                 |
| `/logout`        | Clears cookie and redirects                     |

## Source Layout

```text
platform/packages/dashboard/
  middleware/
    01.auth.ts               # Hyperdrive DB init, cookie auth, shared user state
  lib/
    api.ts                   # Typed platform API client
  pages/
    layout.vue
    login.vue
    login.server.ts
    logout.vue
    logout.server.ts
    index.vue
    index.server.ts
    settings.vue
    settings.server.ts
    auth/
      callback.vue
      callback.server.ts
    projects/
      [id].vue
      [id].server.ts
```

## Notes

- This doc replaces the original API-only BFF design. The implemented dashboard now uses a mixed model: direct DB reads via Hyperdrive for loaders, API calls for writes and non-DB reads.
- The dashboard is intentionally deployed outside the main `pnpm run deploy` pipeline.
