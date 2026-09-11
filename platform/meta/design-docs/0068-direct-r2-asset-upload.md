---
title: Direct-to-R2 Asset Upload (manifest-only deploy POST)
status: proposed
created: 2026-05-07
---

# Direct-to-R2 Asset Upload

## Context

`pnpm void deploy` for static / SPA projects with large `dist/` payloads
fails with `Connection lost during deploy: 'terminated'` and leaves the
deployment row stuck in `pending` (issue
[void-sdk/void#23](https://github.com/void-sdk/void/issues/23)).

Root cause is pinned: the API Worker streams the entire multipart body
through its handler, hashing each `asset:*` part inline and piping it to
KV/R2 from inside the parse loop. Cloudflare's edge-to-Worker
streaming-body pipe has an undocumented ~60 s envelope, and Smart
Placement on the API worker (US edge) plus a Singapore client made it
impossible for the parse loop to fully drain the body in time.
Empirical measurement on the memora repro: `cpuTime=817ms`,
`wallTime=64534ms`, `outcome=canceled`, `exceptions=[]` (CF runtime
killed the request from outside; handler `try/catch/finally` never ran,
so no postmortem cleanup either).

The cliff scales with `dist/` size. Memora is 142 MB / 570 files. The
next user with 250 MB hits it sooner. CF gives us no knob to extend the
timeout. The architectural answer is to remove asset bytes from the
deploy POST body entirely.

## Decision

Move asset upload off the API Worker's request path. The CLI uploads
asset bytes **directly to R2** via presigned PUT URLs, then calls a
manifest-only deploy endpoint that finalizes the deployment without
streaming any asset bytes through the platform. Integrity is guaranteed
by R2's native `Content-MD5` verification on every PUT — the upload
itself fails if bytes don't match the declared MD5. (R2's S3
compatibility layer documents `Content-MD5` as the supported PutObject
checksum; `x-amz-checksum-sha256` is not enforced and would silently no-op.)

BLAKE3 stays as the **storage key** (`assets/${projectId}/${blake3}`)
because the WfP path requires it for compatibility with Cloudflare's
first-party Workers Static Assets upload API. Each asset declares both
hashes:

```json
{ "blake3": "<32 hex>", "md5": "<32 hex>", "size": 1234 }
```

The CLI computes both in a single file read using two streaming
hashers. The presigned URL mandates the `Content-Md5` header as a
SIGNED header, so R2 enforces "uploaded bytes' MD5 matches the declared
header" at write time. No server-side re-hashing, no extra round-trips.

MD5's weaker collision resistance (2^64 vs 2^128) is acceptable here
because (a) the hash is _only_ an upload-integrity primitive, not a
security primitive, (b) the canonical content key is BLAKE3, which is
collision-resistant, and (c) project-scoped namespacing
(`assets/${projectId}/${blake3}`) means any MD5 collision attack is
exploitable only against the attacker's own project.

## Scope

**In scope (v1, this PR series):**

- Static / SPA deploys
- WfP deploys (asset bytes via direct-to-R2; worker bundle stays in
  the deploy body as base64-encoded JSON since worker bundles are
  bounded at 32 MiB total)
- Backward compatibility: the multipart deploy endpoint stays
  functional for old CLIs. Server detects request shape via
  `Content-Type`.

**Out of scope:**

- Removing the multipart deploy endpoint (deferred to a later cleanup
  PR after the new path proves stable in production)
- Cross-project content-addressed dedupe (still per-project)
- Direct-to-R2 for `worker:*` modules (kept in body — small, bounded)

## Wire contract changes

### `assetManifest` schema v2

```ts
type AssetManifestV2Entry = {
  blake3: string; // 32 hex chars, key into assets/${projectId}/${blake3}
  md5: string; // 32 hex chars, R2 Content-MD5 server-side checksum
  size: number;
};

type DeployManifestV2 = DeployManifestV1 & {
  assetManifestVersion: 2;
};
```

V1 (single `hash` field) stays accepted by the multipart endpoint.

### New endpoint: `POST /projects/:id/deploy/upload-urls`

```ts
// Request
{
  assets: Array<{
    blake3: string;
    md5: string;
    size: number;
    contentType: string;
  }>;
}

// Response
{
  urls: Record<
    string /* blake3 */,
    {
      url: string; // presigned R2 PUT URL, ~10 min TTL
      headers: Record<string, string>; // includes Content-Md5
    }
  >;
}
```

Auth: same as `/deploy/preflight` (project ownership).

### Modified endpoint: `POST /projects/:id/deploy` (JSON mode)

When `Content-Type: application/json`:

```ts
// Request body
{
  manifest: DeployManifestV2;       // assetManifestVersion: 2
  assetManifest: Record<string, AssetManifestV2Entry>;
  source: string | null;
  commit: string | null;
  preflight: 'true' | null;
  vars?: Record<string, string>;
  workerFiles?: Record<string /* relative path */, string /* base64 */>;
  // No asset bytes anywhere in the body.
}
```

Server:

1. Skip multipart parse entirely.
2. Validate manifest and assetManifest shape.
3. For each declared asset: parallel `R2.head(assets/${projectId}/${blake3})`
   to verify the upload completed. Fail-fast if any are missing with a
   clear error pointing at the missing hash(es).
4. Continue the existing pipeline: `createDeployment`, status
   transitions, routing switch, retention cleanup, NDJSON event stream.

The multipart code path is preserved verbatim. Detection is via
`Content-Type` header at handler entry.

## Implementation tasks

### Task 1 — Platform: R2 presigning utility

**File:** `packages/api/src/r2-presign.ts` (new, ~150 LOC)

Implement AWS Signature V4 PUT presigning for R2. Use
[`aws4fetch`](https://github.com/mhart/aws4fetch) (already a CF
recommended pattern, lightweight, no `node:crypto`). If `aws4fetch` is
not yet a workspace dep, add it via `npm view aws4fetch version` →
catalog.

```ts
export type PresignAssetPutOptions = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  md5: string; // 32 hex chars
  contentType: string;
  ttlSeconds?: number; // default 600
};

export async function presignAssetPut(
  opts: PresignAssetPutOptions,
): Promise<{ url: string; headers: Record<string, string> }>;
```

The returned URL must include the MD5 as a _signed header_ such that
R2 enforces it. Include `Content-Md5: <base64-of-binary-md5>` in the
returned `headers` (RFC 1864: base64 of the raw 16 bytes with standard
padding, not URL-safe — encode accordingly inside the helper). Use
`aws4fetch` with `allHeaders: true` so the header is genuinely included
in the canonical signed-headers list (R2 won't enforce a header that
isn't part of the signature).

Read R2 endpoint from existing platform conventions (R2 S3 endpoint:
`https://${accountId}.r2.cloudflarestorage.com/${bucket}`).

**Tests** in `packages/api/test/unit/r2-presign.test.ts`:

- Returns a URL pointing at the right bucket/key
- Rejects malformed `md5` input (not 32 hex chars)
- The returned `Content-Md5` is correct base64-of-hex
- Signature includes the `content-md5` header (lowercased per AWS V4
  canonical-form convention)

**Secrets needed:** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Add to
`packages/api/wrangler.jsonc` env section as documented secrets (no
default values committed). Update `meta/operations.md` to mention
they're required.

### Task 2 — Platform: New endpoints + JSON-mode deploy

**File:** `packages/api/src/routes/deploy.ts`

(a) Add `POST /:id/deploy/upload-urls` — body validates with the
existing project-ownership middleware. For each asset, call
`presignAssetPut(...)` with the project's R2 bucket key. Bounded
concurrency for the presign batch (e.g. 50 in flight) — presigning is
CPU-light but we shouldn't fan out unboundedly.

(b) At the top of the existing `POST /:id/deploy` handler, branch on
`Content-Type`:

```ts
const contentType = c.req.header('content-type') ?? '';
if (contentType.startsWith('application/json')) {
  return handleManifestOnlyDeploy(c);
}
// existing multipart path follows
```

`handleManifestOnlyDeploy` is a new function (or inlined block) that:

1. Parses the JSON body. Validate `manifest.assetManifestVersion === 2`
   — reject v1 in JSON mode (v1 must use multipart).
2. Validates each `assetManifest` entry has well-formed `blake3`,
   `md5`, `size`.
3. Reads worker module bytes from `workerFiles` if present
   (base64-decoded). Skips this for static-only deploys.
4. For each declared asset hash, issues parallel
   `STATIC_ASSETS_R2.head(`assets/${projectId}/${blake3}`)`. Bounded
   concurrency (e.g. 20). If any are missing, return a 400 with the
   missing hashes listed. (Suggests a stale presign or upload failure
   the CLI didn't surface.)
5. Threads through to the rest of the deploy pipeline. Reuse
   `createDeployment`, the `start` event emit, status transitions, the
   routing switch, retention cleanup. The structured logger added in
   PR #136 should be wired through with `branch: 'wfp' | 'static'` and
   `currentStatus` tracking exactly as the multipart path does.

(c) Preserve **all** existing semantics that the multipart path
provides: dedupe-skip when the manifest matches the live deploy,
per-deploy cache-buster keying, retention-aware asset cleanup, the
two-phase cancellation hooks.

**Tests** in `packages/api/test/integration/deploy-direct-r2.test.ts`:

- A static deploy with all assets pre-uploaded to R2 succeeds and
  reaches `live`.
- A static deploy that declares an asset whose hash isn't in R2 fails
  with a 400 mentioning the missing hash.
- A WfP deploy with `workerFiles` succeeds and reaches `live`.
- The dedupe short-circuit fires when the manifest matches the live
  deploy.
- Cancellation between asset-verify and routing-switch lands the row in
  `canceled`, not `pending`.

### Task 3 — Framework: MD5 hashing + assetManifest v2

**Files:** `framework/packages/void/src/cli/package.ts`,
`framework/packages/void/src/cli/types.ts`

Update `collectAndHashAssets` to compute both BLAKE3 (existing recipe:
`blake3(base64(content) + extension).hex().slice(0, 32)`) and MD5
(plain `md5(content)` hex) in a single pass. Use streaming hashers so
memory stays O(chunk-size).

Update the emitted asset manifest entries to v2:
`{ blake3, md5, size }`. Keep emitting a `hash` alias equal to
`blake3` for one release so any code paths or tests that read `.hash`
keep working — flag this for removal in a follow-up.

Add `assetManifestVersion: 2` to the deploy manifest builder.

**Tests** in
`framework/packages/void/test/unit/asset-hashing.test.ts`:

- Both hashes match expected values for known fixtures
- BLAKE3 still matches Wrangler's `hashFile` output exactly
- MD5 matches Node's `crypto.createHash('md5')` output exactly
- Single file read per asset (no double-read)

### Task 4 — Framework: Direct-to-R2 upload flow

**Files:** `framework/packages/void/src/cli/client.ts`,
`framework/packages/void/src/cli/deploy.ts`

Add to `PlatformClient`:

```ts
async requestUploadUrls(
  projectId: string,
  assets: Array<{ blake3: string; md5: string; size: number; contentType: string }>,
): Promise<Record<string, { url: string; headers: Record<string, string> }>>;

async finalizeDeploy(
  projectId: string,
  payload: ManifestOnlyDeployPayload,
): AsyncGenerator<DeployEvent>;
```

`finalizeDeploy` POSTs JSON (no multipart) and streams the NDJSON
response — same shape as the existing `client.deploy(...)` async
generator, just with a smaller request body.

In `runDeploy` / `streamDeploy`:

1. Build `assetManifest` v2 + run preflight (existing call). Preflight
   returns `needed` (assets to upload) and `skipped` (cached on the
   server side from the previous live deploy).
2. For static deploys with at least one needed asset, OR WfP deploys
   regardless: call `client.requestUploadUrls(needed)`.
3. Issue direct-to-R2 PUTs in a bounded pool (concurrency 10). Each
   PUT: `fetch(url, { method: 'PUT', body, headers })`. On 4xx: surface
   the error. On 5xx: retry up to 3 times with exponential backoff.
4. Once all PUTs succeed, call `client.finalizeDeploy(projectId, {
manifest, assetManifest, source, commit, preflight: 'true',
workerFiles? })`. Stream the NDJSON response and apply events
   exactly as `streamDeploy` does today.

The multipart `client.deploy(...)` method stays in the codebase but is
no longer the default for static or WfP deploys. Hide behind
`--legacy-upload` flag for one release as an escape hatch.

The `cliLog` (added by the persistent-JSONL logging PR) gets new
events: `presign_request_start`, `presign_request_end`,
`r2_put_start`, `r2_put_end` (per asset, with hash + duration), and
`finalize_start` / `finalize_end`.

**Tests** in
`framework/packages/void/test/integration/direct-r2-deploy.test.ts`:

- Mock the platform's preflight + upload-urls + finalize endpoints
- Mock R2 PUT (verify the Content-MD5 header is present and signed)
- Verify successful deploy of a multi-asset fixture
- Verify R2 PUT 5xx triggers retry, 4xx surfaces error
- Verify the failure-mode error message ends with the JSONL log path

## Migration

- PR 1 (platform): adds new endpoints, multipart endpoint untouched.
  Deploy to staging + production.
- PR 2 (framework): CLI flips to direct-to-R2 by default. Old CLIs keep
  working against the multipart endpoint (no platform-side break).
- Multipart endpoint deprecated in a future cleanup PR (separate
  scope) once the new path is proven on production traffic.

## Test plan (end-to-end)

After both PRs land, repro memora:

```bash
cd /tmp/void-repro/memora
pnpm build
pnpm void deploy --dir packages/web/dist --spa --debug
```

Expected outcome:

- Deploy succeeds in <30 s
- No `pending` zombie row
- JSONL trace shows: preflight → presign → 570 parallel R2 PUTs (mostly
  fast, three slow ones for the wasm files) → finalize → live
- Server-side tail shows: structured `phase_start: r2_verify` →
  `phase_start: db_finalize` → `live`

## Risks

1. **R2 presigned URL TTL expiry mid-upload.** A user with a slow
   connection takes >10 min for the wasm files. Mitigation: TTL is
   per-asset, set generously (10 min default). Increase to 30 min if
   issues observed. CLI surfaces the URL expiry as a clear error.
2. **R2 Content-MD5 verification failure on legitimate bytes.** Bug or
   client mishash. Mitigation: clear error message points at the
   specific asset; CLI hashes are deterministic and tested. The
   integrity claim rests on Cloudflare's S3 compatibility documentation
   listing `Content-MD5` as the supported PutObject checksum, in
   contrast to `x-amz-checksum-sha256` which is silently ignored —
   picking MD5 is what makes the "R2 rejects mismatched bytes at write
   time" guarantee actually true on the wire.
3. **Backward-compat regression in multipart endpoint.** Mitigation:
   the multipart path is untouched; integration tests for it stay green.
4. **R2 keys leaking via presigned URLs.** Mitigation: URL is scoped
   to single PUT, single key, single mandatory checksum, 10-min TTL.
   No read access. Even leaked, the worst an attacker can do is upload
   bytes to a key they could already overwrite via a normal deploy.
5. **No-overwrite guard regression / replay safety.** A naive
   direct-to-R2 design risks replaying a stale signed URL or a buggy
   CLI clobbering a live-serving asset key with mismatched bytes.
   Mitigation: this class is closed by Content-MD5 enforcement —
   because the MD5 of the bytes is part of the signed request, R2
   rejects any PUT whose body doesn't hash to the declared digest, so
   a replay or buggy retry can only re-upload the _exact_ same bytes
   that were already there. No `If-None-Match: *` guard needed.
6. **MD5 collision resistance.** MD5 is broken for collision
   resistance (2^64 vs SHA-256's 2^128). Acceptable here because the
   hash is purely an upload-integrity primitive: content addressing
   and identity stay on BLAKE3, the storage key is project-scoped
   (`assets/${projectId}/${blake3}`), and any collision attack is
   exploitable only against the attacker's own project — there is no
   cross-tenant blast radius.

## Migration complete

The legacy multipart `POST /:id/deploy` upload path was removed in
follow-up commits to this design (CLI: `feat/cli-direct-r2-upload`;
platform: `feat/api-direct-r2-upload`). Direct-to-R2 is now the only
supported deploy flow, and the `--legacy-upload` CLI flag, the
`packageBuild`/`packageStaticBuild`/`packageFrameworkBuild` FormData
builders, the multipart streaming handler in `packages/api/src/routes/deploy.ts`,
and the `packages/api/src/multipart.ts` parser have all been deleted.
Old CLI versions on npm fail against the new platform with a clear
error until users upgrade.
