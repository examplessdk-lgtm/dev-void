---
title: Backfill Concurrency Safety For Routing KV Migrations
status: proposed
created: 2026-04-19
---

# Backfill Concurrency Safety For Routing KV Migrations

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Context

`POST /admin/backfill-queue-tokens` (`platform/packages/api/src/admin/backfill-queue-tokens.ts`) exists to stamp `proxyToken` on legacy `queue:*` KV entries written before dispatch started forwarding `x-void-internal`. The current implementation performs a global, paginated sweep:

```
list(prefix: 'queue:', cursor) → get(name) → parse → resolve token → re-read(name) → if unchanged: put
```

The re-read-before-put check narrows the race with concurrent deploys and rollbacks, but Cloudflare KV has no compare-and-swap primitive. A concurrent writer finishing **after** our re-read but **before** our put is still free to lose: we will write our stale snapshot back, drop the concurrent writer's `workerName`/`queueName`, and count the row as `updated`. Because the endpoint scans the whole fleet outside any deploy lock, one manual invocation during normal operations can clobber fresh routing on arbitrary projects.

This is a general hazard for any admin-initiated bulk migration over live routing KV — not just queue tokens. Any future rollout that needs to rewrite `queue:*`, `domain:*`, or the project-slug routing key inherits the same concern.

## Constraints

- We cannot add a real CAS to Cloudflare KV (absent product change from CF).
- The backfill should be infrequent and short-lived; heavy-weight infra (Durable Object locks, Postgres advisory locks across regions) is overkill if the tool is supposed to run a handful of times in a deployment's lifetime.
- The tool must be safe to run during normal operations. "Schedule a maintenance window" is not an acceptable default answer if a simple guardrail works.

## Proposed approaches

### Approach A — Global deploy lock in KV

Deploy and rollback already hold a per-project lock at the Postgres level. Extend that with a coarse-grained `deploy-lock:global` KV key that the bulk backfill acquires (write-with-TTL). Deploys check the key at start; if held, they wait or fail with a clear message.

- **Pros:** explicit, visible, closes the window around the critical `re-read → put` step. Reusable for future migrations.
- **Cons:** KV puts are eventually consistent (up to 60s across regions); a tenant in a different region could race the lock. Adds a new coordination primitive the platform did not previously require.

### Approach B — Per-project lock, not global

Acquire a per-project `deploy-lock:${projectId}` TTL lock only around the re-read+put for each entry. Deploy/rollback check this lock before their own writes.

- **Pros:** finer-grained, does not halt the whole fleet for a small migration.
- **Cons:** still relies on KV eventual consistency. N extra KV operations proportional to the entry count.

### Approach C — Move the authoritative copy to Postgres

Treat Postgres as the source of truth for queue routing and have a reconciler push to KV. The backfill becomes a pure SQL update with no KV race. Same direction recommended in [0062-transactional-queue-setup.md](./0062-transactional-queue-setup.md) for the deploy path.

- **Pros:** end-to-end solution that removes the KV-as-database pattern for routing metadata.
- **Cons:** biggest change. Requires a parallel design + migration path.

### Approach D — Remove the concurrency claim from the tool

Lean the other way: make the endpoint explicitly unsafe under load. Require the operator to POST with `?confirm=1&maintenance=1`, and document that normal deploys must be paused for the duration.

- **Pros:** zero new code, honest about the guarantees we can actually provide.
- **Cons:** requires human coordination; backfill may be run rarely enough that Approach A/B is not worth the engineering cost.

## Recommendation

Start with **Approach D** today, plan **Approach C** for the long term.

- D is honest. The current tool claims race-safety ("raced" counter) without actually being safe. Fixing the documentation and adding a confirmation gate eliminates the implicit guarantee.
- A and B add infrastructure that will eventually be subsumed by C. Skipping them saves migration work later.
- C is the principled answer but is a standalone project (affects queue routing, possibly domain routing, dispatch read path). Worth scoping separately.

## Test cases (for the eventual fix)

- Backfill with a concurrent deploy writing a newer `queue:*` entry: the concurrent writer's value must survive, the backfill must either retry or report `raced`.
- Backfill with a concurrent rollback mutating the same key: same expectation.
- Backfill with a deploy that starts mid-sweep and finishes after: deploy's own writes must not be clobbered.
- Bulk backfill must complete deterministically under continuous deploy load in a test harness that injects timing.

## Related

- `platform/packages/api/src/admin/backfill-queue-tokens.ts`
- `platform/packages/api/src/admin/routes/system.tsx` — `POST /admin/backfill-queue-tokens`
- Codex adversarial review pass 3 (2026-04-19), finding 4 of 4.
- [0062-transactional-queue-setup.md](./0062-transactional-queue-setup.md) — shares the KV-as-source-of-truth constraint.
