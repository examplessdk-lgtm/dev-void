# Void — Feature Roadmap

**Date:** 2026-02-15
**Status:** Post-v1.0 planning (partially implemented)

---

## Implemented Features

The following features from the original roadmap have been built:

- **SSR support** — `src/main.ssr.ts` render entry convention
- **ISR (Incremental Static Regeneration)** — two-layer cache (edge + R2) in dispatch worker, `x-revalidate` response header, on-demand revalidation
- **Cron jobs** — `jobs/` directory convention, exported `cron` string, auto-registration
- **Built-in auth** — `void/auth` subpath with `AuthUser`, `requireAuth()`, session management, password hashing; configured via `auth` in `void.json`
- **Framework mode** — auto-detected TanStack Start / React Router integration via `detectFramework()`
- **Raw CF deployment** — `wrangler.json` respected; `mergeBindings` only adds missing placeholders
- **Schema-derived DB types** — DDL parser replays migrations → `.void/db.d.ts`
- **Typed query helper** — `db.list()`, `.get()`, `.insert()`, `.update()`, `.delete()`, `.raw()`, `.count()` with `select`, `IN` arrays, multi-column `orderBy`
- **Usage metering & tiers** — `free`/`solo`/`pro`/`sponsored`/`custom` with immediate, per-request, and async enforcement
- **Secrets** — `void secret set NAME=value`
- **Admin dashboard** — Hono JSX server-rendered, user/project management, plan controls, suspend/unsuspend
- **Staging environment** — fully isolated CF resources, auto-deploys on push to `main`
- **Custom domains** — `void domain add myapp.com` via CF Custom Hostnames API, automatic SSL

---

## Remaining Roadmap

### Priority 1 — Quick Wins

#### Per-Route Observability

Pipe Workers Logpush into analytics, map each request to its source route file. Dashboard: request volume, p50/p95 latency, error rates per route, D1 query timing.

#### Core Web Vitals Monitoring

Inject `web-vitals` (~1.5KB) into served HTML. Beacon to `/__vc/vitals`. Write to Analytics Engine. Dashboard: p75 per metric, trends, CWV threshold failures.

#### Privacy-First SPA Analytics

Inject ~1KB script for SPA navigation tracking. Full page loads counted at edge. GDPR-compliant (hashed IP + UA, no cookies). Dashboard: page views, unique visitors, referrers, countries.

#### Error Tracking

Server-side: try/catch wrapper around route handlers, capture with context. Client-side: `window.onerror` + `onunhandledrejection` beacon. Source map resolution is tractable because we control the bundler (Rolldown).

All four share one infrastructure pattern: injected script → beacon → Analytics Engine → dashboard.

### Priority 2 — Platform

#### GitHub Integration (Push to Deploy)

GitHub App webhook on push → build → provision → deploy. Preview deployments per PR at `{pr-num}--{project}.void.app`. Build infrastructure TBD (Cloudflare Containers or equivalent).

#### Preview Environments with Database Forks

Clone production D1 for preview deploys. Cleanup on PR close. Unique differentiator vs. competitors.

### Priority 3 — Ecosystem

#### Integration Marketplace

Plugin architecture for typed binding adapters: Resend (email), Stripe (payments), etc. Start with 3-4 first-party, open spec for third-party.

#### `@voidcloud/plugin-better-auth`

Advanced auth (2FA, passkeys, orgs, multiple linked accounts, password reset). Populates `c.get("user")` — route handler code unchanged.

### Priority 4 — Team & Enterprise

- Environment promotion (staging → production)
- Team RBAC & audit logs
- Managed auth SSO (SAML/OIDC)

---

## Key Design Decisions

**On SSR:** Minimal `src/main.ssr.ts` convention for basic SSR. Meta-frameworks (TanStack Start, React Router) handle advanced SSR — we're a deployment target, not a competitor.

**On Auth:** Two-layer design: (1) identity convention (`c.get("user")` + `requireAuth()`) always available, (2) pluggable providers. Route handlers never couple to a specific auth provider.

**On Frontend Observability:** We control both the deployment (Worker sits in front of every request) and the bundler output (Rolldown). Unique position for integrated analytics, error tracking, CWV monitoring.

**On D1 Scaling:** D1 is the right default for most apps. When users outgrow it (>10 GB, write-heavy, need Postgres features), the upgrade path is Hyperdrive + external Postgres.

**On Escape Hatches:** Tiered disclosure: Auto (inference) → config opt-in (Workers AI, Vectorize) → raw wrangler passthrough → full worker takeover. For any CF feature we don't abstract, the user treats it as an external service on their own CF account.
