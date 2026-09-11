# Deploy Asset Deduplication (Client → API)

**Date:** 2026-02-28
**Status:** Implemented

---

## Summary

Reduce deploy upload size by adding a preflight step where the CLI sends only asset hashes, and the API responds with which assets actually need uploading. Currently, every `void deploy` uploads all assets to the API even when most haven't changed. The API already benefits from CF's built-in dedup (API → CF), but the client → API leg sends everything every time.

---

## Problem

The deploy flow has three hops:

```
CLI  →  API  →  CF
```

CF's asset upload session API already deduplicates at the API → CF boundary — the API sends a manifest of hashes, CF responds with which hashes it needs, and only those get uploaded. This works well.

The problem is the **CLI → API** leg. The CLI packages every asset file into a FormData and POSTs the entire payload to the API. For a project with 5MB of static assets that deploys frequently, that's 5MB uploaded on every deploy even when only a single CSS file changed.

This is wasteful for:

- **Bandwidth**: uploading unchanged assets on every deploy
- **Latency**: larger request body = slower uploads, especially on slower connections
- **API worker CPU**: hashing every asset server-side on every deploy

---

## Design

Add an optional **preflight** step to the deploy protocol. The CLI computes asset hashes locally, asks the API which assets are needed, and then only includes those in the deploy FormData.

### New flow

```
CLI:        1. Build project
            2. Compute SHA-256 hashes for all assets locally
            3. POST /projects/:id/deploy/preflight  (asset manifest only)
               → { assetManifest: { "/index.html": { hash, size }, ... } }
API:        4. Look up last successful deployment's stored asset manifest
            5. Diff: return list of asset paths whose hashes differ or are new
               → { needed: ["/index.html", "/assets/app-xyz.js"], total: 42, skipped: 40 }
CLI:        6. POST /projects/:id/deploy  (FormData with only needed assets)
               → manifest, worker:*, asset:* (only paths from step 5), migration:*
API:        7. Merge: for assets not in FormData, carry forward from stored manifest
            8. Continue existing 3-step CF upload flow
```

### Backwards compatibility

- **Old CLI + new API**: No preflight → all assets in FormData → works exactly as before. The deploy endpoint doesn't require a preflight.
- **New CLI + old API**: Preflight returns 404 → CLI falls back to sending all assets. Zero risk.
- No manifest version bump needed — this is purely additive.

---

## API Changes

### New endpoint: `POST /projects/:id/deploy/preflight`

```ts
// Request
{
  assetManifest: Record<string, { hash: string; size: number }>
}

// Response
{
  needed: string[]    // asset paths that need uploading
  total: number       // total assets in manifest
  skipped: number     // assets that can be skipped (hash match)
}
```

The endpoint:

1. Validates project ownership (same auth as deploy)
2. Queries the last `"live"` deployment for this project
3. Parses its stored `asset_hashes` (JSON column)
4. Diffs: any path whose hash differs or doesn't exist in the previous manifest → `needed`
5. Returns the list

Edge cases:

- **First deploy** (no previous deployment): returns all paths as `needed`
- **No assets in manifest**: returns `{ needed: [], total: 0, skipped: 0 }`
- **Rollback scenario** (re-deploying an older version): hashes still diff correctly against the most recent live deploy

### Deploy endpoint changes

The existing `POST /projects/:id/deploy` gets two small changes:

1. **Accept partial assets**: The `collectAssets()` function already only processes `asset:*` keys from FormData. If the CLI sends fewer assets, fewer get collected. No change needed there.

2. **Merge with previous manifest for CF session**: When creating the CF asset upload session, the API needs the _complete_ manifest (all paths, not just the ones uploaded this time). For assets not in the FormData, carry forward the hash + size from the previous deployment's stored manifest.

```ts
// In deploy route, after collectAssets():
if (preflightUsed) {
  // Merge: previous manifest provides hashes for assets not re-uploaded
  const prevAssetManifest = await getPreviousAssetManifest(db, projectId);
  for (const [path, entry] of Object.entries(prevAssetManifest)) {
    if (!(path in assetManifest)) {
      assetManifest[path] = entry; // carry forward hash + size
    }
  }
}
```

The `assetsByHash` map only needs entries for assets that CF requests in its `buckets` response. Since carried-forward assets already exist in CF's storage, CF won't request them — so we don't need the actual file contents for those.

3. **Store asset manifest on success**: After a successful deploy, store the complete asset manifest in the deployment record.

### How the API knows preflight was used

The CLI includes a `preflight: true` flag in the FormData (or a header). This tells the API to merge with previous manifest rather than treating the FormData assets as the complete set.

---

## DB Changes

Add an `asset_hashes` text column to the `deployments` table:

```sql
ALTER TABLE deployments ADD COLUMN asset_hashes TEXT;
```

Stores `JSON.stringify(Record<string, { hash: string; size: number }>)` — the complete asset manifest for the deployment. For a typical project with 100 assets, this is ~5-10KB of JSON.

The deploy route writes this column after a successful deploy:

```ts
// After deploy succeeds, before marking as "live"
await db
  .update(deployments)
  .set({ asset_hashes: JSON.stringify(assetManifest) })
  .where(eq(deployments.id, deployment.id));
```

Query for preflight:

```ts
// Get the most recent live deployment's asset manifest
const lastDeploy = await db.query.deployments.findFirst({
  where: and(eq(deployments.project_id, projectId), eq(deployments.status, 'live')),
  orderBy: desc(deployments.deployed_at),
  columns: { asset_hashes: true },
});
```

---

## CLI Changes

### Client-side hashing

Port the `computeAssetHash` function to the CLI (it's the same algorithm — SHA-256 truncated to 32 hex chars). The CLI already reads all asset files into memory during `packageBuild` / `packageStaticBuild` / `packageFrameworkBuild`, so hashing adds minimal overhead.

```ts
// In package.ts — compute hash as files are collected
import { createHash } from 'node:crypto';

function computeAssetHash(content: Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return hash.slice(0, 32);
}
```

### Two-phase deploy in `PlatformClient`

```ts
// New method
async preflight(
  projectId: string,
  assetManifest: Record<string, { hash: string; size: number }>,
): Promise<{ needed: string[]; total: number; skipped: number }> {
  const res = await fetch(`${this.baseUrl}/projects/${projectId}/deploy/preflight`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    },
    body: JSON.stringify({ assetManifest }),
  });

  if (!res.ok) {
    // Preflight not supported (old API) or error — return all as needed
    return {
      needed: Object.keys(assetManifest),
      total: Object.keys(assetManifest).length,
      skipped: 0,
    };
  }

  return res.json();
}
```

### Modified packaging flow

The `packageBuild` / `packageStaticBuild` / `packageFrameworkBuild` functions change to:

1. Collect files and compute hashes → build `assetManifest`
2. Return both the `assetManifest` and a `Map<path, { content, contentType }>` of all assets
3. Caller (deploy.ts) does preflight, then builds FormData with only needed assets

```ts
// deploy.ts — new flow
s.start('Hashing assets...');
const { assetManifest, assetFiles } = collectAndHashAssets(clientDir);

s.message('Checking for changes...');
const { needed, skipped } = await client.preflight(config.projectId, assetManifest);

if (skipped > 0) {
  log.info(`Skipping ${skipped} unchanged asset(s)`);
}

s.message('Packaging...');
const formData = buildDeployFormData({
  manifest,
  workerDir,
  assetFiles,
  neededAssets: new Set(needed), // only include these in FormData
  migrations,
});
formData.append('preflight', 'true'); // signal to API

s.message('Deploying...');
const result = await client.deploy(config.projectId, formData);
```

---

## What This Does NOT Change

- **CF asset upload flow**: The API → CF upload session + bucket upload is unchanged
- **Worker uploads**: Worker files are always sent in full (they're small and change every deploy)
- **Migrations**: Unchanged
- **Deploy manifest version**: Stays at 2 — this is a transport optimization, not a protocol change
- **Existing CLI behavior**: Old CLIs work without modification

---

## UX

The deploy output changes to show dedup stats:

```
◇  Deployed!
│
│  3 worker module(s), 42 static asset(s) (40 unchanged, 2 uploaded)
│  SSR enabled
│
└  https://myapp.void.app
```

On first deploy (no previous manifest), all assets are uploaded as before — no visual change.

---

## Implementation Steps

1. **DB migration**: Add `asset_hashes` column to `deployments`
2. **API: store asset manifest**: Write `asset_hashes` on successful deploy (no preflight yet — just start recording)
3. **API: preflight endpoint**: `POST /projects/:id/deploy/preflight` with diffing logic
4. **API: merge logic in deploy**: When `preflight: true`, merge previous manifest for the CF session
5. **CLI: client-side hashing**: Port `computeAssetHash` to Node.js crypto
6. **CLI: preflight call**: Add `PlatformClient.preflight()` and wire into deploy flow
7. **CLI: selective packaging**: Only include `asset:*` entries for needed paths
8. **CLI: deploy output**: Show skipped/uploaded counts

Steps 1-2 can ship first (start recording manifests for all deploys). Steps 3-8 ship together in a subsequent release. This means the first deploy after step 2 ships will record the manifest, and the second deploy after step 6 ships will benefit from dedup.

---

## Alternatives Considered

### Client-side local cache

CLI caches the last deploy's manifest locally (e.g. `.void/deploy-cache.json`) and diffs without a server round-trip. Simpler but fragile — breaks on CI, multiple machines, or when the cache is cleared. The preflight approach works everywhere because state lives server-side.

### Direct CLI → CF upload (bypassing API for assets)

The CF asset upload session returns a scoped, short-lived JWT that only authorizes uploads for a specific worker. In theory the API could create the session, hand the JWT + buckets back to the CLI, and let the CLI upload assets directly to CF — skipping the API as a middleman entirely. This would also eliminate the need for our own manifest diffing since CF's session response already says which hashes are needed.

Rejected because:

- **Protocol complexity**: 3-way handshake (CLI → API → CLI → CF → CLI → API) vs. simple preflight + deploy
- **CF coupling**: CLI would need to know CF's upload URL format, base64 multipart encoding, bucket grouping — all internal CF details that could change
- **Split error handling**: Asset upload failures on the client, worker upload failures on the server
- **Session JWT lifetime**: Slow connections risk JWT expiry mid-upload with no clean recovery
- **Marginal benefit**: The API worker runs on CF's network, so API → CF asset uploads are nearly free. The only waste is CLI → API bandwidth for unchanged assets, which the preflight approach already eliminates.

Worth revisiting if deploy payloads routinely exceed 50MB+, where the double-hop becomes a real bottleneck.

### Manifest version bump

Bump to version 3 to indicate the CLI supports two-phase deploy. Unnecessary because the protocol is backwards-compatible in both directions — preflight is optional and the deploy endpoint works with or without it.
