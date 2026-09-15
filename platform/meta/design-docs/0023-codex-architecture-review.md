# Codex Architecture Review

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-24
**Scope:** Current platform architecture (`api`, `dispatch`, `ai-proxy`, `dashboard`) with focus on one question:
**If we scale to millions of users, what limitations will we hit, and how do we prepare without lock-in?**

## Executive Summary

The platform architecture is directionally strong: clear control plane/data plane split, Cloudflare-native runtime, and explicit roadmap toward Postgres/Hyperdrive and build orchestration.
The main risk is not raw compute scalability first; it is **correctness under scale** in four areas:

1. Security boundaries (AI proxy trust model, OAuth redirect validation)
2. Metering correctness (cache-hit traffic currently bypasses usage accounting)
3. Multi-tenant consistency (global slug collisions, env isolation drift)
4. Control-plane idempotency/reliability (deploy/provision/migration retry behavior)

If those are fixed early, current architecture can scale significantly without major re-platforming.

## Top Limitations And How To Prepare

### 1) AI proxy trust boundary can be abused (critical)

**Limitation:** AI proxy accepts unauthenticated POST requests (service-binding path) with caller-supplied `projectId`, and is reachable via public route. At scale, this enables cost abuse and cross-tenant billing tampering.

**Evidence:**

- `packages/ai-proxy/src/index.ts` checks JWT only when `Authorization` exists.
- Service-binding path trusts `projectId` from body.
- Public route configured in `packages/ai-proxy/wrangler.jsonc`.

**Prepare now:**

- Require authenticated identity on all AI requests, including non-browser/service flows.
- Bind project identity to server-issued claims, not body fields.
- Split internal service-only ingress from external dev ingress.

### 2) Cache-hit traffic is not metered (critical)

**Limitation:** Dispatch returns early on edge cache hits before `recordRequest()` is called. At high cache-hit ratios, request-based billing/limits undercount heavily.

**Evidence:**

- `platform/packages/dispatch/src/index.ts`: early `cache.match` return happens before metering closure is used.

**Prepare now:**

- Meter cache hits as first-class events (`cache_hit` dimension).
- Add tests that assert metering on both cache miss and cache hit paths.

### 3) Global slug uniqueness is not DB-enforced (critical)

**Limitation:** Slug uniqueness relies on pre-insert lookup. Schema only enforces `(user_id, slug)` uniqueness. Concurrent creates can race and collide at global routing/worker name level.

**Evidence:**

- `platform/packages/api/src/routes/projects.ts` uses `getProjectBySlug` then insert.
- `platform/packages/api/src/schema.ts` unique index is `projects_user_id_slug_unique`.
- Worker script name derives from slug in `platform/packages/api/src/routes/deploy.ts`.

**Prepare now:**

- Add unique DB index on `projects.slug`.
- Handle insert conflicts explicitly.
- Derive worker identity from immutable `project_id` rather than slug.

### 4) Environment isolation has drift risk (high)

**Limitation:** Some defaults are production-oriented and can be used if staging vars are incomplete (for example proxy service binding name and dispatch worker name). This increases cross-env blast radius risk.

**Evidence:**

- `platform/packages/api/src/provisioning/provision.ts` hardcodes `void-ai-proxy`.
- `platform/packages/api/src/routes/deploy.ts` defaults `dispatchWorkerName` to `void-dispatch`.
- Ops doc claims strict env isolation.

**Prepare now:**

- Make env-specific names mandatory for runtime wiring.
- Add startup assertions that fail fast on missing env config.
- Add CI contract tests to assert prod/staging isolation invariants.

### 5) Scheduled suspension loop scales poorly (`users x projects x external calls`) (high)

**Limitation:** Every 5 minutes, cron batches through users/projects and fans out usage queries. With millions of users, runtime overlap and stale decisions become likely.

**Evidence:**

- `platform/packages/api/src/index.ts`: batched scheduled loop + per-project usage and AI queries.
- AI limit enforcement currently only for free plan branch.

**Prepare now:**

- Move to event-driven counters/rollups (queue + durable aggregation).
- Keep cron as reconciliation/backstop, not primary enforcement.
- Enforce AI limits consistently across plans.

### 6) Usage queries fail open to zero + dataset name drift (high)

**Limitation:** Analytics/GraphQL query failures return zero usage, which can silently disable enforcement. Dataset name in code/query/docs also shows inconsistency risk.

**Evidence:**

- `platform/packages/api/src/routes/usage.ts` returns zero on non-OK responses.
- Query references hardcoded dataset/table names.
- Ops docs and wrangler files contain mixed dataset naming history.

**Prepare now:**

- Fail closed for enforcement paths, fail open only for user-facing display.
- Centralize dataset/table config in one typed source.
- Alert on metering query failure rates.

### 7) OAuth redirect validation is prefix-based (high)

**Limitation:** Redirect URL allowlist uses `startsWith`, which is vulnerable to crafted host/path forms that can leak login token redirects.

**Evidence:**

- `platform/packages/api/src/routes/auth.ts` `isAllowedRedirect` uses string prefix checks.

**Prepare now:**

- Parse URL and compare exact allowed origins.
- Issue short-lived one-time auth codes instead of passing JWT in query params.

### 8) Deploy/provision/migration flow is not robustly idempotent (high)

**Limitation:** Multi-step external side effects lack a single idempotency contract and per-project serialization. Retries/concurrency can create orphans or inconsistent state.

**Evidence:**

- `platform/packages/api/src/migrations/remote-runner.ts` executes SQL then inserts migration record separately.
- `platform/packages/api/src/provisioning/provision.ts` checks then creates resources without global lock.

**Prepare now:**

- Add per-project deploy lock (Durable Object).
- Add idempotency keys for deploy requests and resource creation.
- Add reconciler job to detect and clean orphaned resources.

### 9) Deletion path leaks queue resources/mappings and queue relay can drop data (high)

**Limitation:** Project delete flow does not clearly remove queue resources and queue routing keys. Dispatch queue relay acks when routing missing, which can drop messages.

**Evidence:**

- `platform/packages/api/src/routes/delete.ts` resource cleanup handles d1/kv/r2 paths, not queue teardown path.
- `platform/packages/dispatch/src/index.ts` queue handler `ackAll()` on missing routing.

**Prepare now:**

- Add queue delete + `queue:*` KV cleanup in teardown.
- Route missing-mapping queue batches to DLQ/retry strategy (not immediate ack).

### 10) Access-control/policy consistency gaps (medium)

**Limitation:** Some ownership and policy checks are inconsistent (for example project detail route visibility and provider-specific signup policy).

**Evidence:**

- `GET /projects/:id` in `platform/packages/api/src/routes/projects.ts` returns project without owner check.
- Signup allowlist logic applies only to Google new users in `platform/packages/api/src/routes/auth.ts`.

**Prepare now:**

- Standardize authorization policy by route category.
- Apply signup policy uniformly across auth providers.
- Add API-level authorization regression tests for each route.

### 11) Operational resilience still concentrated in single-operator model (medium)

**Limitation:** Operations ownership and incident response are still heavily centralized.

**Evidence:**

- The original operations runbook concentrated access in one administrator.
- The original progress tracker left monitoring and health checks as future work.

**Prepare now:**

- Define on-call rotation and escalation paths.
- Establish service SLOs and alert thresholds.
- Add incident runbooks for deploy, metering, and auth failures.

## Avoiding Lock-In While Preparing For Scale

### 1) Keep a stable internal contract for metering events

Treat request/metering events as your internal source-of-truth contract.
You can change storage/query backend (AE today, different warehouse later) without rewriting control-plane logic.

### 2) Make idempotency and reconciliation first-class platform features

Once control-plane actions are idempotent and reconcilable, growth mostly changes volume, not architecture.

### 3) Move platform DB to Postgres via Hyperdrive, keep Drizzle domain model stable

The proposed migration path in `platform/meta/design-docs/0015-platform-d1-to-planetscale.md` is strategically correct: isolate the control plane schema from storage engine details.

### 4) Separate environment config from code defaults

Defaults are convenient in early stage, but explicit per-env wiring is mandatory before high-scale operations.

### 5) Keep deploy protocol versioned and backward-compatible

Current manifest versioning approach is a good anti-lock-in mechanism between framework and platform repos. Continue enforcing strict compatibility checks.

## Suggested Execution Order

### P0 (immediate)

- Fix AI proxy trust model and ingress boundaries.
- Fix cache-hit metering gaps.
- Enforce global slug uniqueness in DB.
- Harden OAuth redirect validation.

### P1 (next)

- Implement per-project deploy locking and idempotency keys.
- Add queue teardown and queue-loss protections.
- Fail-closed metering in enforcement code paths.
- Add env isolation contract checks in CI.

### P2 (near-term)

- Complete control-plane DB migration to Postgres/Hyperdrive.
- Replace cron-heavy enforcement with streaming rollups + reconciliation.
- Add SLOs, alerting, and on-call runbooks.

## Closing

The platform can scale to millions if security boundaries, metering correctness, and control-plane idempotency are fixed now.
Without those fixes, growth amplifies billing leakage, abuse surface, and operational inconsistency faster than infra cost becomes the bottleneck.
