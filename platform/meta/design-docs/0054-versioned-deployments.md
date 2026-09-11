---
title: Versioned Deployments
status: implemented
created: 2026-03-05
depends: []
---

# Versioned Deployments

## Summary

Void now deploys worker-based projects as versioned scripts in the Workers for Platforms dispatch namespace. Each deployment gets its own worker (`user-{slug}-{deployId}`), migrations run inside that new worker via `/__void/migrate`, and routing flips only after the deployment is validated.

Implemented results:

- safe migration execution before traffic flips
- rollback to retained deployments
- per-deployment log filtering
- deployment retention cleanup without replacing the active worker in place

## Current Behavior

### Worker naming

```
user-{slug}-{deployId}
```

`deployId` is the deployment row ID from the database. The worker name is deterministic and does not require extra routing state.

### Deploy flow

```
1. Build and package the worker
2. Provision bindings
3. Upload `user-{slug}-{deployId}` to the dispatch namespace
4. If migrations are pending, call `POST /__void/migrate` on that new worker
5. On migration failure, mark the deployment failed and delete the new worker script
6. Update KV routing and queue routing to point to the versioned worker
7. Mark the deployment live, set `projects.active_deployment_id`, and mark it retained
8. Delete the legacy unversioned worker if present
9. Evict old retained worker scripts beyond the plan limit
```

### Database state tracked by the platform

The platform stores:

- `projects.active_deployment_id`
- `deployments.retained`
- `deployments.applied_migrations`

### Retention

| Plan      | Retained deployments |
| --------- | -------------------- |
| Free      | 1 (current only)     |
| Solo      | 5                    |
| Pro       | 25                   |
| Unlimited | unlimited            |

Cleanup runs after a successful deploy. The active deployment is never deleted.

### Rollback

Rollback is code-only. The API switches routing to a previously retained deployment and returns any migration diff so the caller can see if the database has moved forward since that deploy.

### Logging

Versioned worker names allow logs to be filtered by deployment. The tail pipeline stores both the per-project key and the deploy ID so project-level and deployment-level log views can coexist.

### Notes

- This document is now historical/implementation-aligned rather than aspirational. The source of truth is the current deploy flow in `packages/api/src/routes/deploy.ts`.
- Static-only deployments are covered separately in [0055-kv-r2-static-deployments.md](./0055-kv-r2-static-deployments.md).
