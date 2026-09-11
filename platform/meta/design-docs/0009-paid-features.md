# Paid Feature Analysis

**Date:** 2026-02-19
**Status:** Draft

---

## Context

Void runs on Cloudflare Workers. We control the full stack: build toolchain (Vite plugin), framework layer (routing, codegen, migrations), and runtime (dispatch worker, platform API). This vertical integration — plus CF's cost structure (no egress fees, included DDoS, global edge by default) — shapes what we can offer cheaply and what's worth charging for.

Current tier system: `free`, `solo`, `pro`, `sponsored`, `custom`. Enforcement already exists for deploys/day, CPU time, sub-requests, and monthly request count.

## Competitive Landscape

| Feature         | Vercel                     | Netlify                    | Void                            |
| --------------- | -------------------------- | -------------------------- | ------------------------------- |
| Custom domains  | Free                       | Free                       | **Must be free**                |
| Preview deploys | Free (hobby) / Pro (teams) | Free                       | Not yet                         |
| Cron/scheduled  | Pro ($20/mo)               | Not built-in               | Not yet                         |
| Log streaming   | Pro                        | Pro                        | Not yet                         |
| Observability   | $20/mo add-on              | $9/mo add-on               | Not yet                         |
| AI inference    | N/A                        | N/A                        | Not yet                         |
| Background jobs | N/A (external)             | Background Functions (Pro) | Not yet                         |
| Edge functions  | Included                   | Included                   | Included (CF Workers)           |
| Bandwidth       | 100GB free, then paid      | 100GB free, then paid      | Free (CF doesn't charge egress) |

**Key takeaway:** Custom domains are table stakes (free everywhere). Bandwidth is not a differentiator on CF. The monetization opportunities are in developer tooling and runtime capabilities.

## Feature Candidates

### Tier 1 — High value, low-medium effort

#### Preview Deployments

Deploy per branch/PR with isolated URL and its own D1 database clone.

- **Why it converts:** The #1 feature teams pay Vercel for. Gateway to multi-user/team plans.
- **CF advantage:** Workers for Platforms makes spinning up isolated workers cheap. D1 databases are free to create.
- **Implementation:** Extend deploy flow with branch-based naming (`{branch}-{slug}.void.app`), D1 snapshot for preview isolation, auto-cleanup on merge/close.
- **Effort:** Medium. Deploy pipeline exists; need branch routing + DB cloning + lifecycle management.
- **Tier:** Pro (or Team).

#### Cron Jobs / Scheduled Tasks

User-defined scheduled tasks alongside API routes (e.g. `routes/cron/daily-cleanup.ts`).

- **Why it converts:** Unlocks real app use cases (cleanup, reports, syncs). Every non-trivial app needs this.
- **CF advantage:** Cron Triggers is a native CF primitive. Zero additional infra cost — just configuration.
- **Implementation:** Detect cron route files at build time, configure triggers on the dispatch namespace, route invocations to user worker.
- **Effort:** Low. CF does the scheduling; we wire configuration.
- **Tier:** Pro.

#### Log Streaming

Real-time `console.log` output from user workers via CLI (`void logs --follow`) and/or dashboard.

- **Why it converts:** Developers expect this for any production workload. Hard to debug without it.
- **CF advantage:** Workers tail API already exists. We wrap it.
- **Implementation:** CLI command that opens a WebSocket to CF's tail endpoint. Optional dashboard view later.
- **Effort:** Low.
- **Tier:** Pro (real-time). Free tier could get last-N logs.

### Tier 2 — Low effort, unique positioning

#### Workers AI Binding

Expose `env.AI` to user workers with a monthly inference quota.

- **Why it converts:** AI features are trending. Making it a one-line import (`c.env.AI.run(...)`) with zero config is a compelling DX story.
- **CF advantage:** Workers AI is a native binding. Near-zero implementation — just add the binding during provisioning.
- **Implementation:** Add AI binding to worker upload, meter usage via Analytics Engine, enforce quota.
- **Effort:** Very low.
- **Tier:** Pro (e.g. 10k inference calls/mo included). Free tier gets a small trial quota.

#### Per-Route Rate Limiting

Declarative rate limits defined in route files:

```ts
export const rateLimit = { window: '1m', max: 100 };
```

- **Why it converts:** Every API needs rate limiting. Making it declarative and zero-config is uniquely possible because we control build + dispatch.
- **CF advantage:** Can implement with KV counters at the dispatch layer, or CF's native rate limiting.
- **Implementation:** Extract config at build time, enforce at dispatch before routing to user worker.
- **Effort:** Low-medium.
- **Tier:** Pro.

#### Queues / Background Jobs

Queue producers and consumers alongside routes, backed by CF Queues.

- **Why it converts:** Opens up async workloads (emails, image processing, webhooks) that can't run in request-response cycle.
- **CF advantage:** CF Queues is the primitive. Predictable pricing.
- **Implementation:** Detect queue consumer files, provision CF Queue, wire producer binding + consumer dispatch.
- **Effort:** Medium.
- **Tier:** Pro.

### Tier 3 — Long-term moat (build + runtime integration)

These features are uniquely possible because we control the build toolchain AND the runtime. They're harder for competitors to replicate.

#### Deploy-over-Deploy Bundle Analysis

Capture per-route bundle sizes at build time, compare across deploys.

- **Signal:** "This deploy added 47kb to `/api/users`" — surfaced in CLI output and dashboard.
- **Implementation:** Store build metadata (route → bundle size mapping) per deployment, diff against previous.
- **Effort:** Low (build metadata is available; just needs storage + comparison).
- **Tier:** Pro.

#### Source-Mapped Error Traces

Capture worker exceptions at dispatch, apply source maps from the build, surface clean stack traces.

- **Signal:** Free tier gets "Error in worker". Pro gets the actual file, line, and code context.
- **Implementation:** Store source maps per deployment in R2, process exceptions via tail API or error handler.
- **Effort:** Medium.
- **Tier:** Pro.

#### Fullstack Observability Dashboard

Request logs, latency percentiles (p50/p95/p99), error rates, per-route breakdowns. Built on existing Analytics Engine data.

- **Signal:** Vercel charges $20/mo for this. We already record every request with method, status, duration, response bytes.
- **Implementation:** Dashboard UI + richer AE queries. Data layer already exists.
- **Effort:** Medium (UI work, but backend is done).
- **Tier:** Pro or separate add-on.

## Recommended Pro Tier ($20/mo)

Prioritized by impact-to-effort ratio:

| Priority | Feature             | Effort     | Rationale                   |
| -------- | ------------------- | ---------- | --------------------------- |
| 1        | Preview deployments | Medium     | Conversion driver for teams |
| 2        | Cron jobs           | Low        | Unlocks real app use cases  |
| 3        | Log streaming       | Low        | Expected for production use |
| 4        | Workers AI quota    | Very low   | Trendy, easy differentiator |
| 5        | Rate limiting       | Low-medium | Unique DX advantage         |
| 6        | Observability       | Medium     | Proven willingness-to-pay   |

**Free tier (always free):**

- Custom domains (1 per project)
- Deploys/day limit (current enforcement)
- Basic usage metrics (current AE data)
- Community support

**Pro tier adds:**

- Preview deployments
- Cron jobs
- Real-time log streaming
- Workers AI quota
- Per-route rate limiting
- Priority support

**Future Enterprise adds:**

- Observability dashboard + alerts
- Source-mapped error traces
- Bundle analysis
- Team workspaces + RBAC
- Multiple custom domains per project
- SLA

## Key Principle

CF's cost structure means most of these features have near-zero marginal cost. The value is in the **DX layer** — making powerful CF primitives accessible through the Void framework with zero configuration. We're not reselling compute; we're selling developer experience.
