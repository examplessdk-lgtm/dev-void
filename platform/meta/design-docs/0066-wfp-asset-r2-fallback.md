---
title: WfP Asset Safety-Net Fallback via R2
status: accepted
created: 2026-04-23
---

# WfP Asset Safety-Net Fallback via R2

## Context

Doc [0065](./0065-cloudflare-asset-dedupe-poisoning.md) documents a Cloudflare Workers for Platforms bug (`cloudflare/workers-sdk#12586`, internal WC-4511) where the `assets-upload-session` API can report a content hash as already cached when the bytes are missing from CF's blob store. At runtime, requests for poisoned paths receive a 36-byte `Assets have not yet been deployed to this script.` stub instead of the real asset.

0065 accepted the bug and left platform-side mitigation as a future option. This doc commits to the safety-net variant of that future option — keeping CF as the primary asset-serving path, mirroring assets to platform-owned R2/KV, and falling back to the mirror at request time when dispatch detects the stub.

A full cutover (serving everything from R2/KV, dropping the CF asset API entirely) was considered and deferred. Rationale is in the variant-comparison appendix.

## Decision

For every WfP deploy with assets:

1. The CF `assets-upload-session` path runs unchanged (with the `/.void-deploy/<deployId>.txt` cache-buster from 0065 still in place).
2. After CF acknowledges the upload, the assets are _also_ mirrored to the platform's existing static stores — `STATIC_ASSETS` KV for files < 2 MB, `STATIC_ASSETS_R2` for larger. Scoped under `assets/{projectId}/{hash}`, same keys the static-only deploy path writes to.
3. A serving manifest (`Record<path, hash-or-!hash>`) is written to `ROUTING.put('manifest:{deploymentId}', ...)`. Same shape and same KV key the static-only path uses.
4. The routing entry written under the project slug gains `assetManifestId` and `assetConfig` fields so dispatch knows the mirror exists.

At request time in `packages/dispatch`:

1. Dispatch calls the user worker as today. CF's native asset binding may intercept asset paths before the worker runs (default `run_worker_first: false`) or serve them from the worker's `env.ASSETS.fetch()` fallback.
2. Dispatch inspects every worker response that can come from CF's asset binding, including worker-backed `fallbackRules` re-dispatches and ISR background revalidation renders. If and only if the routing entry has `assetManifestId` AND the response matches the stub fingerprint (status 200, `Content-Type` starts with `text/plain`, `Content-Length` 1–199), dispatch reads the body and checks for the known stub marker substring.
3. On marker match, dispatch loads the serving manifest from `ROUTING`, resolves the path via the same `resolveStaticPath` used for static-only deploys, and serves the bytes from the mirror via `fetchStaticAsset`.
4. On any miss — missing manifest, unresolved path, missing bytes — dispatch returns the original (stub) response. Behavior identical to today for the paths we can't cover.

Every fallback hit logs a structured event (`event: 'wfp-asset-fallback'`) carrying project id, deployment id, pathname, user agent, and timestamp. This is the signal used to later evaluate graduating to full cutover.

## What does not change

- CF `assets-upload-session` / `uploadAssetBuckets` / `completionJwt` path (`packages/api/src/routes/deploy.ts` asset-upload block).
- The `/.void-deploy/<deploymentId>.txt` cache-buster.
- The `ASSETS` binding attached to the user worker's metadata.
- The `assets: buildAssetMetadata(...)` metadata entry.
- Framework code (`framework/packages/void/...`, adapters). `serveWithAssets` in the Void router is already `!env.ASSETS`-guarded and continues to call CF's binding as today.
- Worker script upload pipeline.
- CF-native `assetConfig` semantics (`not_found_handling`, `html_handling`, `run_worker_first`). CF continues to own these on the happy path; the fallback path uses the same `resolveStaticPath` logic the static-only path uses.

## Detection heuristic

```
if (response.status === 200
    && response.headers.get('content-type')?.toLowerCase().startsWith('text/plain')
    && 0 < parseInt(response.headers.get('content-length') ?? '0', 10) < 200) {
  const body = await response.clone().text();
  if (body.includes('Assets have not yet been deployed to this script')) {
    // fallback
  }
}
```

The pre-check gates the body read so non-asset responses (JSON APIs, HTML, large binaries, streaming responses) pass through untouched. Only plausibly-stub responses (small text/plain 200s) pay the `clone().text()` cost — a fraction of a millisecond for ≤200-byte bodies.

The marker is a **substring**, not full-body equality. This tolerates trailing whitespace or newline variants if CF emits them. A full-body equality check was considered and rejected because the exact body representation isn't documented and has no versioning contract.

## Observed stub response

_Filled in after pre-implementation verification._

TBD — record the exact observed shape here when the detection is first exercised against a real poisoned response. Expected shape:

- Status: 200
- Content-Type: `text/plain;charset=UTF-8`
- Body: `Assets have not yet been deployed to this script.` (possibly with trailing newline)

If the observed shape diverges from this expectation, update the detection heuristic accordingly.

## Detection fragility and telemetry

The marker string is a contract we do not control. CF can change the text at any time and we'd stop detecting. Mitigations:

- **Log every fallback hit** with structured fields so the rate over time is queryable (`packages/tail` pipeline).
- **Monitor for sudden drops to zero** of the fallback rate. If the rate falls to zero globally without a corresponding CF release note, the detection may have broken.
- **Canary** (future work): a synthetic deploy that can be set up to trigger the stub on demand, exercised daily, and alerts if detection misses.

## Backfill and migration

Existing live WfP deploys were deployed _before_ this code was in place and have no mirrored assets. They continue to serve from CF until they next redeploy, at which point they pick up the mirror automatically. No backfill required.

Users who actively hit the bug today still see it until their next deploy. This is the same as the pre-mirror behavior — the fix is prospective.

One caveat: the first WfP deploy after this code lands on a given project may not fully cover every path in the serving manifest. Preflight-skipped assets (hashes that existed in a prior pre-mirror deploy) don't have bytes in `assetsByHash` because the client didn't re-upload them. Such paths are omitted from the serving manifest, so fallback can't cover them until a subsequent deploy uploads the bytes. Over time, the mirror fills in.

## Retention and GC

The existing `deleteUnreferencedAssets` in `packages/api/src/assets.ts` is keyed on `assets/{projectId}/{hash}` and uses the `retained`-flag set from `deployments.asset_hashes` — works unchanged for WfP. The WfP retention-cleanup block in `packages/api/src/routes/deploy.ts` is extended to call `deleteUnreferencedAssets` and `ROUTING.delete('manifest:{id}')` for deployments being evicted from the retention window. Per-project GC for mirrored bytes is now a side effect of WfP deploys, matching the behavior of static-only deploys.

## Pre-routing failure cleanup

A deploy that fails before routing switches is never marked `retained`, so the retention GC above will never see its asset hashes. Without explicit cleanup, the mirror blobs and the `manifest:{id}` KV entry written during the WfP branch would accumulate on repeated failed deploys.

The mirror integrates with the existing abort-cleanup path (`cleanupStreamedAssetsOnAbort` in `packages/api/src/routes/deploy.ts`):

- Hashes are registered in `streamedHashStores` **before** calling `uploadStaticAssets`, not after. `uploadStaticAssets` runs concurrent workers and rejects on the first worker failure, leaving already-settled writes on disk; post-call registration would miss those on partial failure. Placement (`kv` vs `r2`) is a pure function of `entry.bytes.byteLength` vs `KV_THRESHOLD`, so we compute it up-front instead of waiting for the return value. The shared abort cleanup then sweeps mirrored blobs alongside streamed-static uploads, gated by retained-hash protection (hashes still referenced by any retained or in-flight deployment are kept).
- The `manifest:{deploymentId}` KV entry is tracked via a request-scoped identifier and deleted unconditionally by the abort closure, independent of the blob sweep. This covers the edge case where every asset was preflight-skipped (no new blobs uploaded, but the manifest KV was still written with carry-forward entries).

Both actions only run when `!routingSwitched` (the same guard that protects against evicting assets still serving live traffic).

## Preflight classification

`POST /:id/deploy/preflight` previously used the presence of `manifest:{active_deployment_id}` KV as a signal to infer "previous deploy was static." Because this doc introduces a WfP-side write of that key, the preflight reads the **live routing entry** under `project.slug` and checks for `staticDeploymentId` as the static-backend signal. Dedup is still restricted to the static → static case.

The routing entry is authoritative because it is what is actually serving traffic — the last step of a successful deploy is the `ROUTING.put(project.slug, ...)` call, and even if downstream updates like `updateProjectType` fail (the post-routing recovery path silently swallows that failure), the routing entry reflects the backend that was successfully installed. Using `project.type` directly would be vulnerable to drift in that edge case and could cause a subsequent static preflight to dedup against a WfP deploy's `asset_hashes`, skipping uploads for hashes that may no longer live in our R2/KV after retention cleanup.

## Telemetry and exit criteria

Telemetry signals we'll watch:

- **Fallback hits per day per project.** Rising rate suggests the CF bug is a persistent issue.
- **Unique hashes triggering fallback.** Helps distinguish systemic CF regressions from project-specific poisoning.
- **Detection-miss proxy metric (future):** ratio of `text/plain;200` responses from worker dispatch that don't match the marker, correlated with user-reported incidents.

Criteria for graduating to the full cutover (Variant A — R2/KV primary, no CF asset API):

- **Confidence in the R2 serving path:** sustained non-trivial fallback rate over 4+ weeks, where the mirror served correct bytes with no additional incidents.
- **Multi-framework verification:** `resolveStaticPath` behavior confirmed against TanStack Start, SvelteKit, Nuxt, Astro — not just Void.
- **`run_worker_first: true` telemetry:** understanding what (if any) user base relies on this, so we can plan accordingly for a cutover.

If telemetry shows **zero** fallback hits over the evaluation window, staying on this safety-net design indefinitely is acceptable — the bug may have been fixed upstream, or the existing mitigations (cache-buster + `asset_hashes` persistence from 0065) may be adequate.

## Rollback

The change is strictly additive at deploy time and has a narrow gated check at request time. To disable:

1. **Deploy side:** comment out the `uploadStaticAssets` call + serving-manifest write in the WfP branch of `packages/api/src/routes/deploy.ts`, and remove the `assetManifestId` / `assetConfig` arguments from `buildRoutingJson`.
2. **Dispatch side:** the fallback path is gated on `routing.assetManifestId`. Removing that field from routing entries (or rolling back the `buildRoutingJson` change) disables the fallback without any dispatch change required.

A one-line feature flag could be added if needed (`process.env.WFP_ASSET_MIRROR_ENABLED`) but wasn't included in the initial rollout to keep the code surface small.

## Files changed (implementation)

- `packages/api/src/routing.ts` — `buildRoutingJson` accepts `assetManifestId`, `assetConfig`.
- `packages/api/src/routes/deploy.ts` — R2/KV mirror after CF upload, `assetManifestId` emitted on WfP routing JSON, retention block extended to evict mirrored assets.
- `packages/dispatch/src/index.ts` — `RoutingEntry.assetManifestId`, stub detection, fallback helper, telemetry.
- `packages/dispatch/test/unit/wfp-asset-fallback.test.ts` — new test file.
- `packages/api/test/unit/routing.test.ts` — new test file.

## References

- [0065-cloudflare-asset-dedupe-poisoning](./0065-cloudflare-asset-dedupe-poisoning.md) — the bug this mitigates.
- [0028-per-worker-assets](./0028-per-worker-assets.md) — how CF WfP's native asset binding works.
- [0042-dispatch-asset-caching](./0042-dispatch-asset-caching.md) — edge-cache layer that fronts static assets (now also fronts this fallback path).
- Upstream: [`cloudflare/workers-sdk#12586`](https://github.com/cloudflare/workers-sdk/issues/12586).
- Internal: WC-4511.
