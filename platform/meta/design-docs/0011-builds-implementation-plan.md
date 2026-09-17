---
title: Builds Implementation Decisions
status: implemented
updated: 2026-09-17
---

# Builds implementation decisions

The original [build service design](./0010-builds.md) proposed a separate
artifact-upload pipeline. The implementation runs the real `void deploy` CLI
inside the build executor so local and remote builds use the same validation,
packaging and deployment path.

The durable decisions are:

- GitHub App webhooks enqueue container builds; GitHub Actions uses OIDC to
  obtain a short-lived, project-scoped deploy token. Both executors use the
  same project authorization and deployment API.
- `BuildScheduler` claims queued builds and enforces concurrency.
  `BuildManager` owns one build's container, status, cancellation and logs.
  Container size is persisted with the build; cancellation and cleanup must
  address the same Durable Object class that started it.
- The container agent downloads source, installs project dependencies and runs
  the CLI. There is no separate build-artifact upload endpoint.
- Build status is authoritative in PostgreSQL. Check runs and log presentation
  must agree with that status across concurrent cancellation and completion.
- Managed builds and their Containers are optional platform components. They
  are not a requirement of core platform installation or native app deployment.

The former step-by-step plan, copied source, file inventory and verification
transcript have been retired. Current implementation and operational details
live in the [API README](../../packages/api/README.md#deploy-on-github),
[GitHub identity design](./0074-github-deploy-identity-linking.md),
[check-run decisions](./0075-compare-failure-logging-github-check-runs.md) and
[build-log decisions](./0076-build-logs.md).
