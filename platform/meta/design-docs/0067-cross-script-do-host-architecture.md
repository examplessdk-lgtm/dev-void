---
title: Sandbox Container Ownership and Teardown
status: superseded
created: 2026-05-03
---

# Sandbox container ownership and teardown

Managed Sandboxes are currently disabled. Existing installations use the
[documented drain procedure](../../../docs/guide/platform-administration.md)
before restoring traffic. This record preserves the rejected host design and
the ownership and race constraints referenced by cleanup code; it is not a
deployment or migration recipe.

## Resolution: per-deploy architecture

The proposed stable `do-host-${slug}` Worker inside a dispatch namespace was
rejected by Cloudflare with error 10061 when another dispatched Worker tried to
bind to its Durable Object class. The `script_name` binding resolves
account-level Workers, not sibling scripts inside the dispatch namespace.
Keeping the host in that namespace therefore could not provide stable
cross-deployment ownership.

The replacement used same-script Durable Object bindings on each versioned
application Worker. Each deployment received a fresh namespace and its own
container application. Container names include project, deployment and container
identity. Container state is consequently local to that deployment; persistent
application data belongs in D1, KV or R2.

A container application's namespace binding is immutable. Never PATCH it to a
new namespace or silently delete an existing application to make a redeploy
succeed. A rollback within retention can select the existing target Worker and
its container; recreating an expired target is a separate recovery operation.

## Container lifecycle

- Create the Worker before resolving the namespace from that Worker's bindings.
- Create or recover the deterministic container application and verify its
  namespace before recording ownership.
- Delete container applications explicitly during retention and teardown.
  Deleting a Worker does not delete its container application.
- Reconcile provider resources as well as database rows. A failed write or
  interrupted deployment can leave a container without its final resource row.
- Treat provider 404 responses as already deleted; retain and report other
  cleanup failures so recovery can continue.

These rules remain relevant to legacy draining. They do not authorize new
managed Sandbox deployments or changes to native Cloudflare Sandbox behavior.

## Project teardown

A cleanup snapshot can race resource creation: teardown reads the resource
list, a concurrent request creates a provider resource, and a database cascade
then removes the new row without deleting the provider resource. A preflight
project-existence check alone cannot close this interval.

The full serialization solution requires provisioning and teardown to share a
per-project lock and a durable terminal state. Mark the project terminal before
taking the cleanup inventory; every writer must recheck that state after
acquiring the same lock. Locking only one path is insufficient.

Current cleanup code contains bounded sweeps, post-create project checks and
compensation for these races. Preserve them unless all competing writers
participate in a proven replacement. A delayed second snapshot is mitigation,
not proof that no later writer can create a resource. The same constraint
applies to destination allowlist writes racing project deletion or consent
revocation.

See [cleanup.ts](../../packages/api/src/provisioning/cleanup.ts),
[deployment admission](../../packages/api/src/routes/deploy.ts), and
[Sandbox draining](../../packages/api/src/sandbox-drain.ts) for the implemented
guards. The old stable-host bundling, migration, metadata-rewrite and cutover
instructions are retired.
