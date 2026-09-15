---
title: Transactional Queue Setup In Deploy Pipeline
status: proposed
created: 2026-04-19
---

# Transactional Queue Setup In Deploy Pipeline

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Context

`platform/packages/api/src/routes/deploy.ts` `queue_setup` mutates Cloudflare state before the deploy is committed. The current implementation is already two-pass:

1. Pass 1 runs `addQueueConsumer(...)` for every queue in the manifest, collects conflicts, and throws before pass 2 if any are found.
2. Pass 2 writes `queue:*` KV entries pointing at the new `workerName`.

This closes the original regression where a conflicting queue would overwrite the live route with a pointer to a worker the failure cleanup was about to tear down (see Codex review 2, finding 1 of 3).

What it does **not** close: any failure **after** pass 2 but before `routingSwitched = true`. Specifically the cron setup, prerender, migration, or manifest-put steps can still throw. When they do, the outer catch handler tears down the new worker script and clears cron state, but it does not:

- delete newly created consumer subscriptions at Cloudflare (so the new `void-dispatch` subscription lingers; messages will still arrive, but the deleted worker cannot receive them); OR
- restore the prior `queue:*` KV values that pass 2 overwrote (so dispatch will relay messages to the deleted worker until the next successful deploy or rollback).

Both failure windows are small but real:

- `queue_setup` completes, `cron_setup` throws on a CF/DO error.
- `queue_setup` completes, cancellation fires before `routingSwitched`.

## Constraints

- Must not add per-deploy latency for the healthy path.
- Must not break the existing two-pass contract that already made rollout safe for the conflict case.
- Must tolerate `JWT_SECRET` rotation (see [0063-backfill-concurrency-safety.md](./0063-backfill-concurrency-safety.md) for the analogous constraint on the backfill tool).

## Proposed approaches

### Approach A — Snapshot + compensating restore

Before pass 2, snapshot the current `queue:*` KV value for every queue the manifest declares:

```ts
const routingSnapshot = new Map<string, string | null>();
for (const outcome of consumerOutcomes) {
  const key = `queue:${outcome.queueBinding.queue_name}`;
  routingSnapshot.set(key, await c.env.ROUTING.get(key));
}
```

Write pass 2. If any step between pass 2 and `routingSwitched` throws, iterate the snapshot and restore each entry (put the old value, or delete if it was null). Compensate for the consumer subscriptions by calling a new `removeQueueConsumer(...)` on every queue we registered this deploy.

- **Pros:** localized fix, no schema changes, tests can simulate each failure with a throwing DO/fetch.
- **Cons:** restore pass itself can fail mid-way (partial rollback of the rollback). The compensating `removeQueueConsumer` call widens the CF API surface.

### Approach B — Defer all queue writes to `routingSwitched`

Collect the target `queue:*` writes into a queued list during `queue_setup`, but do not flush them until `routingSwitched = true`. At that moment they commit atomically with the main routing flip (also KV, also non-atomic, but colocated).

- **Pros:** closes the window entirely for `ROUTING` KV writes. No new CF APIs.
- **Cons:** the consumer subscription is still mutated out-of-band. CF Queues does not offer a pending/draft state.

### Approach C — Record queue routing state in Postgres, reconcile on demand

Move queue routing off KV into `resources` (or a dedicated `queue_routing` table), with a background reconciler that writes KV from the SQL row. Deploy updates SQL inside the same transaction that flips `active_deployment_id`; KV is eventually consistent.

- **Pros:** fully transactional end-to-end, matches the pattern already used for deployment/routing state.
- **Cons:** biggest change. Requires a migration path for live KV entries (see backfill doc). Dispatch has to tolerate KV staleness for up to the reconciler tick.

## Recommendation

Approach B, with Approach A as a follow-up for the consumer-subscription side.

B closes the `ROUTING` KV window with the least code. The consumer-subscription leak is a narrower blast radius because `void-dispatch` is idempotent: re-running `addQueueConsumer` on the next deploy reconciles settings, and orphaned subscriptions do not misroute messages. Still worth a cleanup sweep eventually, but not blocking.

C is the right long-term direction but is a standalone project (schema migration, reconciler, dispatch read path).

## Test cases

- A failure injected during `cron_setup` (after `queue_setup` completed) must leave `queue:*` entries pointing at the previously-live worker.
- A cancellation fired between `queue_setup` and `routingSwitched` must behave identically.
- The conflict path (regression from Codex review 2) must continue to NOT overwrite live routes.
- A successful deploy must write the new routes exactly once with the correct `proxyToken`.

## Related

- `platform/packages/api/src/routes/deploy.ts` — `queue_setup` block around line 2315.
- `platform/packages/api/src/routes/projects.ts` — rollback cleanup semantics to mirror.
- Codex adversarial review pass 3 (2026-04-19), finding 1 of 3.
