---
title: GitHub Comparison Logging and Check Runs
status: implemented
created: 2026-06-23
---

# GitHub comparison logging and check runs

Comparison diagnostics and GitHub check runs make remote build failures
visible without making GitHub's availability a prerequisite for deployment.
Current user-facing behavior is documented in the
[API README](../../packages/api/README.md#deploy-on-github).

## Comparison failures

`getBranchHeadComparisonStatus` returns `null` when comparison cannot be
established. Token-mint, network and HTTP failures produce bounded structured
warnings; logging does not change the caller's freshness decision or turn a
comparison failure into an uncaught exception. Keep the retry policy in
[installation-token.ts](../../packages/api/src/github/installation-token.ts)
and its tests authoritative.

## Check-run lifecycle

Container builds publish a `Void Build` check run. Its head SHA comes from
the build's captured commit, not a deployment row that may not exist yet.
Creating or completing the check is best-effort: a GitHub API failure must
not fail a build or prevent the scheduler from being notified.

The run ID is stored in both Durable Object storage and the nullable
`builds.check_run_id` column. Finalization falls back to the database when
the local cache is absent. Old rows with no ID remain valid.

Cancellation can interleave with check creation. After creating and recording
a check, re-read the authoritative build state before starting work. If another
handler already terminalized the build, complete the check to that recorded
outcome. A lost conditional database update must never publish a contradictory
success or failure. A timeout on the database wait does not cancel the write;
reconcile its eventual result.

The same build identity, ownership, branch-head and deduplication guards apply
to rerun webhooks. GitHub App Checks write permission and the relevant webhook
subscriptions are part of enabling this optional integration. GitHub Actions
builds keep their native workflow result; adding another check surface is not
required by this design.

See [check-run.ts](../../packages/api/src/github/check-run.ts),
[BuildManager](../../packages/api/src/build-manager.ts), and the
[build-log record](./0076-build-logs.md) for output and drain invariants.
The original implementation recipe, copied tests and review transcript are
retired.
