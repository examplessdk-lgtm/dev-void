---
title: KV/R2-Based Static Deployments
status: implemented
created: 2026-03-07
depends: [0028-per-worker-assets, 0054-versioned-deployments]
---

# KV/R2-Based Static Deployments

## Summary

Static-only deployments (type `"static"` / `"spa"`) now bypass Workers for Platforms entirely. Assets are stored with content-addressed keys in KV (primary) with R2 fallback for files `>= 2 MB`, and dispatch serves them directly. This removes the per-script cost for retained static deployments and allows a fixed retention limit of 100 static deployments across all tiers.

## Current Behavior

### Storage layout

- Assets are stored by content hash under `assets/{hash}`.
- `STATIC_ASSETS` KV stores files smaller than `2 MB`.
- `STATIC_ASSETS_R2` stores files `>= 2 MB`.
- Per-deployment serving manifests are stored in `ROUTING` KV as `manifest:{deploymentId}`.
- R2-backed hashes are prefixed with `!` in the serving manifest.

### Static deploy flow

1. The CLI sends the static asset manifest and changed blobs.
2. The API uploads new assets to KV or R2 based on size.
3. The API stores the serving manifest in `ROUTING` KV and the deploy asset manifest in the database.
4. The API updates slug/domain routing with `staticDeploymentId` instead of `workerName`.
5. Dispatch serves those assets directly without creating a WfP worker script.

### Dispatch serving behavior

- Routing entries with `staticDeploymentId` take the static path.
- Dispatch fetches the per-deployment manifest from `ROUTING`.
- Requests resolve through `assetConfig` rules such as SPA fallback and HTML handling.
- Assets are served from KV or R2 and then edge-cached with versioned cache keys.
- Metering still records these requests as `"static"`.

### Retention

- **Static deployments:** 100 for all tiers (constant, not tier-bound)
- **Worker deployments:** unchanged (free: 1, solo: 5, pro: 25)
- Retention limit is determined by project type at deploy time

Eviction is content-aware:

1. Read the evicted deployment’s `asset_hashes`.
2. Collect hashes still referenced by remaining retained deployments.
3. Delete only unreferenced assets from KV/R2.
4. Delete the serving manifest from `ROUTING`.
5. Mark the deployment as no longer retained.

### Rollback

Rollback works by updating routing to point to an older `staticDeploymentId`. Because assets are content-addressed and retained independently of the worker path, rollback is effectively immediate.

### Notes

- This document is now implementation-aligned rather than aspirational. The source of truth is the static deploy branch in `packages/api/src/routes/deploy.ts` plus dispatch static serving in `packages/dispatch/src/static.ts`.
- Worker-based versioned deployments are covered separately in [0054-versioned-deployments.md](./0054-versioned-deployments.md).
