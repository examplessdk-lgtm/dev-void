# Architecture

```
                              VOID — SYSTEM ARCHITECTURE
 ═══════════════════════════════════════════════════════════════════════════════

                          ┌───────────────────────────────────────┐
                          │         DEVELOPER'S MACHINE           │
                          │                                       │
                          │  src/  routes/  middleware/  jobs/    │
                          │  vite.config.ts (voidPlugin())        │
                          │  void.json                            │
                          │                                       │
                          │  ┌─────────────────────────────────┐  │
                          │  │  void (npm package)             │  │
                          │  │                                 │  │
                          │  │  Vite Plugins:                  │  │
                          │  │   ├─ routing (file-based)       │  │
                          │  │   ├─ db-types (DDL → .d.ts)     │  │
                          │  │   ├─ migration                  │  │
                          │  │   ├─ inference (binding scan)   │  │
                          │  │   ├─ prerender / SSR / ISR      │  │
                          │  │   └─ @cloudflare/vite-plugin    │  │
                          │  │                                 │  │
                          │  │  Runtime Exports:               │  │
                          │  │   ├─ void         (core)        │  │
                          │  │   ├─ void/db      (typed D1)    │  │
                          │  │   ├─ void/kv      (typed KV)    │  │
                          │  │   ├─ void/storage (typed R2)    │  │
                          │  │   ├─ void/client  (typed fetch) │  │
                          │  │   ├─ void/auth    (app auth)    │  │
                          │  │   └─ void/ai      (Workers AI)  │  │
                          │  │                                 │  │
                          │  │  CLI (void):                    │  │
                          │  │   ├─ void init                  │  │
                          │  │   ├─ void deploy                │  │
                          │  │   ├─ void login                 │  │
                          │  │   ├─ void link / list / delete  │  │
                          │  │   ├─ void secret set/delete     │  │
                          │  │   ├─ void domain add/remove     │  │
                          │  │   └─ void db push/studio        │  │
                          │  │                                 │  │
                          │  │  Framework Integrations:        │  │
                          │  │   ├─ @void/vue                │  │
                          │  │   ├─ @void/react              │  │
                          │  │   ├─ @void/solid              │  │
                          │  │   └─ @void/svelte             │  │
                          │  └─────────────────────────────────┘  │
                          └────────┬─────────────────┬────────────┘
                                   │                 │
                         vite dev  │                 │  void deploy
                                   │                 │
                ┌──────────────────▼───┐             │
                │   LOCAL DEV SERVER   │             │
                │                      │             │
                │  Vite Dev Server     │             │
                │    ├─ HMR + assets   │             │
                │    └─ proxy /api/*   │             │
                │                      │             │
                │  workerd (local)     │             │
                │    ├─ API routes     │             │
                │    ├─ D1 (SQLite)    │             │
                │    ├─ KV (fs)        │             │
                │    └─ R2 (fs)        │             │
                │                      │             │
                │  Remote Bindings ────────┐         │
                │  (optional, via proxy)   │         │
                └──────────────────────┘   │         │
                                           │         │
 ══════════════════════════════════════════════════════════════════════════════
                              CLOUDFLARE EDGE
 ══════════════════════════════════════════════════════════════════════════════

                                           │         │
         ┌─────────────────────────────────▼───┐     │
         │  void-proxy  (proxy.void.cloud)     │     │
         │                                     │     │
         │  Two modes:                         │     │
         │                                     │     │
         │  1. AI Proxy (production)           │     │
         │     user worker ──service binding──►│     │
         │     metered billing for Workers AI  │     │
         │                   │                 │     │
         │              ┌────▼─────┐           │     │
         │              │Workers AI│           │     │
         │              │(via AI   │           │     │
         │              │ Gateway) │           │     │
         │              └──────────┘           │     │
         │                                     │     │
         │  2. Remote Bindings (local dev)     │     │
         │     CLI ──HTTPS + JWT──►            │     │
         │     D1/KV/R2 via CF REST APIs       │     │
         └─────────────────────────────────────┘     │
                                                     │
                ┌────────────────────────────────────▼───┐
                │  void-api  (api.void.cloud)            │
                │                                        │
                │  Control Plane:                        │
                │   ├─ OAuth (GitHub / Google)           │
                │   ├─ Project CRUD                      │
                │   ├─ Deploy Pipeline:                  │
                │   │   ├─ Validate manifest             │
                │   │   ├─ Provision D1/KV/R2            │
                │   │   ├─ Run migrations (CF REST)      │
                │   │   ├─ Upload assets → R2            │
                │   │   ├─ Upload worker → dispatch NS   │
                │   │   └─ Update KV routing entry       │
                │   ├─ Usage Metering (Analytics Engine) │
                │   ├─ Tier Enforcement (DO)             │
                │   ├─ Secrets Management                │
                │   ├─ Custom Domains (CF for SaaS)      │
                │   └─ Admin Dashboard (/admin)          │
                │                                        │
                │  Bindings:                             │
                │   DB ─── D1    ASSETS ─── R2           │
                │   ROUTING ─── KV    DISPATCH ─── WfP   │
                │   USAGE_COUNTER ─── DO                 │
                │   Queue ─── void-usage-events          │
                └────────────────────────────────────────┘
                         │
                         │ provisions + deploys
                         ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    USER PROJECT RESOURCES                           │
 │                                                                     │
 │   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      │
 │   │    D1    │    │    KV    │    │    R2    │    │  Queue   │      │
 │   │(database)│    │(key-val) │    │(objects) │    │(optional)│      │
 │   └─────┬────┘    └─────┬────┘    └─────┬────┘    └─────┬────┘      │
 │         └───────────┬───┴──────────┬────┘               │           │
 │                     │              │                    │           │
 │              ┌──────▼──────────────▼────────────────────▼────┐      │
 │              │         User Worker                           │      │
 │              │  (Workers for Platforms — dispatch namespace) │      │
 │              │                                               │      │
 │              │  routes/api/* → Hono handlers                 │      │
 │              │  middleware/* → request pipeline              │      │
 │              │  jobs/*       → cron triggers                 │      │
 │              │  SSR          → main.ssr.ts                   │      │
 │              │                       │                       │      │
 │              │                  service binding              │      │
 │              │                       │                       │      │
 │              │                  void-proxy (AI)              │      │
 │              └───────────────────────────────────────────────┘      │
 │                              ▲                                      │
 └──────────────────────────────┼──────────────────────────────────────┘
                                │
         ┌──────────────────────┼────────────────────────────────┐
         │  void-dispatch  (*.void.app / custom domains)         │
         │                      │                                │
         │  Request Flow:       │                                │
         │   browser ──►  extract slug from hostname             │
         │                      │                                │
         │              ┌───────▼───────┐                        │
         │              │  KV ROUTING   │                        │
         │              │  slug → config│                        │
         │              └───────┬───────┘                        │
         │                      │                                │
         │          ┌───────────┼───────────┐                    │
         │          │           │           │                    │
         │     /api/*      static/*    SPA/SSR                   │
         │          │           │           │                    │
         │          ▼           ▼           ▼                    │
         │     Workers      R2 assets   index.html               │
         │     for          (edge       fallback                 │
         │     Platforms    cached)                              │
         │                                                       │
         │  Bindings:                                            │
         │   DISPATCH ─── WfP    ASSETS ─── R2                   │
         │   ROUTING ─── KV      ANALYTICS ─── AE                │
         │   USAGE_QUEUE ─── Queue                               │
         │                                                       │
         │  Also: custom domains via CF for SaaS                 │
         │  (CNAME → cname.void.app)                             │
         └───────────────────────────────────────────────────────┘

         ┌───────────────────────────────────────────────────────┐
         │  void-dashboard  (dash.void.cloud)                    │
         │                                                       │
         │  Vue SSR app (@void/vue)                            │
         │   ├─ Login (OAuth via API)                            │
         │   ├─ Projects (list, create, detail)                  │
         │   ├─ Deployments, Domains, Secrets                    │
         │   ├─ Usage Metrics                                    │
         │   └─ Settings                                         │
         │                                                       │
         │  BFF: server loaders → API via HTTP                   │
         │  Auth: JWT in httpOnly cookie (void_token)            │
         └───────────────────────────────────────────────────────┘

 ══════════════════════════════════════════════════════════════════════════════
                              DATA FLOW SUMMARY
 ══════════════════════════════════════════════════════════════════════════════

  Developer                    Platform                        End User
  ─────────                    ────────                        ────────
  void deploy ──────────────► api.void.cloud
                                │ provision
                                │ upload
                                ▼
                              R2 + WfP + KV
                                                ◄──────────── browser
                                              dispatch         {slug}.void.app
                                                │
                                          ┌─────┴─────┐
                                          ▼           ▼
                                       Worker      R2 assets
                                       (API)       (static)
                                          │
                                     service bind
                                          ▼
                                       Proxy
                                       (AI metering)
```
