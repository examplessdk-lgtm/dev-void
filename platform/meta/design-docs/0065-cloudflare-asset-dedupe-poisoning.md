---
title: Cloudflare WfP Asset-Dedupe Poisoning — Known Issue, Accepted
status: accepted
created: 2026-04-22
---

# Cloudflare WfP Asset-Dedupe Poisoning — Known Issue, Accepted

## Context

Cloudflare Workers for Platforms (WfP) includes an asset-upload API used by the `packages/api` deploy route. The handshake is three steps:

1. `POST /workers/dispatch/.../assets-upload-session` — client sends a manifest `{path → hash}`; CF responds with a completion JWT and `buckets` (the subset of hashes it wants uploaded). Hashes in the manifest but absent from the buckets are ones CF claims are already stored.
2. `POST /assets-upload` per bucket — client uploads the requested bytes.
3. The completion JWT is attached to the worker script upload.

CF dedupes asset bytes across sessions within a single CF account by content hash. Hashes are content-addressed (BLAKE3 of `base64(content) + ext`), so identical bytes across different projects produce the same hash — the dedupe is intentionally cross-project.

## The bug

CF's dedupe **index** ("I have bytes for hash X") can get out of sync with the **blob store** (the actual bytes). The index claims certain hashes are stored when the backing bytes are not actually present. Possible causes (inferred; we have no internal CF visibility):

- **Bytes evicted, index entry persists.** Blob-store garbage collection runs without cleaning up the index.
- **Partial upload registered before completing.** A prior upload reached the index-registration step but failed before the bytes were durably committed.
- **Replication desync.** The index and the blob store are distributed through different paths; a rollback or region failover leaves them inconsistent.

When our deploy pipeline sends CF a manifest containing a poisoned hash:

1. CF's session response omits that hash from `buckets` — it believes it has the bytes.
2. Our pipeline trusts the dedupe claim and does not upload the bytes.
3. Deploy finalizes successfully. Worker script is attached with the completion JWT.
4. CF promotes the worker live.
5. At runtime, any request for a path referencing that hash triggers `env.ASSETS.fetch(...)` → CF looks up the hash in the blob store → blob store has nothing → CF returns a 36-byte fallback body:

   ```
   Assets have not yet been deployed to this script.
   ```

6. The browser receives that stub in place of the expected asset (JS, CSS, image, etc.) and renders or executes it as though it were the real file. Usually a syntax error for JS/CSS, a broken image for binaries.

The user sees a broken site. The deploy logs say success. There's no signal from CF that anything is wrong.

## Why content-addressed hashing makes it worse for fresh projects

The hash depends only on content and extension. Every React 18.3 app produces byte-identical `react-dom.production.min.js` and therefore the same hash. If CF's index is poisoned for that one hash, **every new React deploy on any project in the account** trips over the same bad entry. A single historical poisoning can block a class of new deploys.

## Tracking

- Upstream: [`cloudflare/workers-sdk#12586`](https://github.com/cloudflare/workers-sdk/issues/12586)
- Internal CF ticket: **WC-4511**
- Observed prod incidents in our account:
  - `source-map-viewer` (`proj_pdszrn3030tp`) — `dpl_49ehj42935ji`, `dpl_cda6upl0laud`, `dpl_sxt86xioqvr8` on 2026-04-21; `dpl_v9tz4upy6pwm` on 2026-04-22 (`logo.svg` hash `874a24587da1faf3ab2af28348bc8ca6`).

## Decision: accept the bug

We are **not** implementing platform-side workarounds for this bug. Specifically, the following approaches were tried and reverted:

- **Per-project corroboration + platform-wide corroboration + salt-on-collision + hard refusal** — shipped in PR #103 (commit `82e3eb0`) and extended in an abandoned follow-up branch. The salt layer modifies user asset bytes to produce new hashes and bypass CF's dedupe. The corroboration layers refuse deploys that we can't prove CF has the bytes for. Both were removed in commit on branch `revert/asset-session-cascade`.

Reasons for reverting:

1. **Never modify user assets.** Even syntactically inert markers (a `/* comment */` in JS) are changes to content the user uploaded. The platform's job is to host user bytes, not rewrite them. This is the hard-line policy point.
2. **Refusal-on-uncorroborated is high false-positive.** CF's dedupe claim may be truthful for a hash we have no record of (another account, a project we don't know about). Refusing correct deploys because we can't prove CF is telling the truth punishes the user for CF's opaque state.
3. **Complexity cost.** The cascade required multiple correctness follow-ups (P1, P2, rollout safety, legacy manifest classification). Each fix surface was non-trivial. The maintenance burden is disproportionate to the benefit.

## Current behavior

On the `main` branch, the WfP deploy path trusts CF's session response verbatim:

1. Inject the deploy-scoped cache-buster file `/.void-deploy/<deployId>.txt` (this addresses a separate CF bug where the session endpoint can return a cached plain-text "Assets have already been uploaded" response instead of a proper session; injecting a unique file forces CF to actually process the request). This is an **added** file, not a modification of user content.
2. Call `createAssetUploadSession` with the manifest.
3. Upload whatever buckets CF asks for. Skip whatever CF omits.
4. Persist `deployments.asset_hashes` for preflight dedupe and retention cleanup.
5. Upload the worker script with the completion JWT.

If CF's dedupe lies, the deploy ships referencing a missing hash. The user sees the 36-byte stub at runtime. Mitigation: retry the deploy. CF's dedupe may clear itself (if the index entry gets invalidated and the next upload actually registers bytes).

## What users see

On deploy: success. No error.

At runtime: the broken path serves the 36-byte string `Assets have not yet been deployed to this script.` with the expected Content-Type. Depending on what the asset is:

- JavaScript: syntax error in the browser console.
- CSS: silently ignored / applied as whitespace.
- Image/font/wasm: broken render, 404-like behavior.
- Source map (.map): devtools source maps broken; site still works.

Workaround in the user's hands: redeploy. If CF's dedupe entry has cleared between attempts, the retry will actually upload the bytes.

## Future options (not committed)

If this becomes a frequent user-visible pain point, the architectural fix is to serve assets from platform-owned storage (R2 + `packages/dispatch` worker) instead of CF's asset cache. The SPA/static deploy path already uses this model. Extending it to WfP deploys would eliminate the dedupe dependency entirely.

Out of scope for now. This document exists so the next engineer who triages a "broken assets on first deploy" report can find the cause quickly and knows we've already decided not to work around it.

## Update (2026-04-23)

Safety-net fallback implemented in [0066](./0066-wfp-asset-r2-fallback.md). CF remains the primary serving path and the workarounds documented above (`/.void-deploy/` cache-buster + early `asset_hashes` persistence) remain in place. When CF returns the 36-byte stub, `packages/dispatch` detects it and serves the real asset from a platform-owned R2/KV mirror written at deploy time. The CF bug itself is not fixed — we mask the user-visible symptom.

## References

- Upstream: [`cloudflare/workers-sdk#12586`](https://github.com/cloudflare/workers-sdk/issues/12586)
- Internal: WC-4511
- Historical commits (for archaeology):
  - `29e567e` — original defense (per-project corroboration + novel-hash cache-buster + salt). Removed.
  - `32933ef` (PR #102) — early `asset_hashes` persistence (survives downstream failures). Kept.
  - `82e3eb0` (PR #103) — platform-wide corroboration + salt cascade. Removed in this branch.
  - Abandoned feature branch `feat/deployment-assets-normalization` (`f2705b0`) — normalized hash storage, SVG salting, transactional dual-write, rollout-compat fallback. Never merged.
  - This branch `revert/asset-session-cascade` — removes the cascade.
