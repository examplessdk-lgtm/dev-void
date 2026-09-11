import { extname } from 'node:path';
import { hash as blake3hash } from 'blake3-jit';
import mime from 'mime';
import { retryWithBackoff } from './cf-api.ts';
import type { AssetConfig } from './types.ts';

class AssetUploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Non-retriable error — the hash will never appear locally. */
class AssetHashMissError extends Error {}

export type AssetManifestEntry = Readonly<{
  hash: string;
  size: number;
}>;

export type AssetEntry = Readonly<{
  bytes: Uint8Array;
  contentType: string;
}>;

type UploadSessionResponse = Readonly<{
  result: {
    jwt: string;
    buckets: ReadonlyArray<ReadonlyArray<string>>;
  };
}>;

function tryParseJson<T>(text: string): T | null {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const ASSET_SESSION_MAX_RETRIES = 3;
const ASSET_SESSION_RETRY_DELAY_MS = 1000;
const ASSET_BUCKET_UPLOAD_RETRY_DELAY_MS = 1000;

const MAX_UPLOAD_RETRIES = 5; // 5 retries + 1 initial = 6 total tries (matching Wrangler)
const UPLOAD_CONCURRENCY = 3;
/**
 * Maximum concurrent static-asset KV/R2 PUTs per deploy. Used by the
 * worker-free (streamed) deploy path so the handler can fan uploads out
 * while the main parse loop keeps draining the inbound multipart request
 * body. Exported so the deploy handler shares the limit with
 * `uploadStaticAssets` (post-parse bulk upload), keeping the two paths
 * from accidentally drifting.
 */
export const STATIC_ASSET_UPLOAD_CONCURRENCY = 4;
const STATIC_ASSET_UPLOAD_MAX_RETRIES = 3;
const STATIC_ASSET_UPLOAD_RETRY_DELAY_MS = 250;
const GATEWAY_BACKOFF_BASE_MS = 5000;
const MAX_GATEWAY_ERRORS = 5; // start counting attempts after this many 524s (4 free retries)

/**
 * Strip a manifest down to the exact `{ hash, size }` shape CF's
 * `assets-upload-session` endpoint documents. v2 manifests carry extra
 * fields (e.g. `blake3`, `md5`) that the platform persists for future
 * preflight reasoning — those must NOT be forwarded to CF, whose API
 * documents only `{ hash, size }` per entry. CF may strictly validate
 * extras and break the deploy. Use this at every CF-bound call site.
 *
 * Always returns a fresh object (no shared references with the input).
 */
export function normalizeForCfAssetSession(
  entries: Record<string, AssetManifestEntry>,
): Record<string, AssetManifestEntry> {
  const out: Record<string, AssetManifestEntry> = {};
  for (const [path, entry] of Object.entries(entries)) {
    out[path] = { hash: entry.hash, size: entry.size };
  }
  return out;
}

/**
 * Step 1: Create an asset upload session with CF.
 * Sends the asset manifest (path → {hash, size}) and receives a completion JWT
 * plus "buckets" — groups of hashes that CF needs uploaded.
 *
 * CF's WfP assets API sometimes returns plain text (e.g. "Assets have already
 * been uploaded") instead of JSON when all asset hashes already exist. This is
 * a CF bug — the response varies by edge node. Retrying typically hits a
 * different node that returns proper JSON.
 */
export async function createAssetUploadSession(
  accountId: string,
  apiToken: string,
  namespace: string,
  workerName: string,
  manifest: Record<string, AssetManifestEntry>,
  { retryDelayMs = ASSET_SESSION_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<{ jwt: string; buckets: ReadonlyArray<ReadonlyArray<string>> }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}/assets-upload-session`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ manifest });

  return retryWithBackoff(
    async () => {
      const response = await fetch(url, { method: 'POST', headers, body });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[assets] upload session failed (${response.status}): ${error}`);
        throw new Error(`asset upload session failed: ${error}`);
      }

      const text = await response.text();
      const data = tryParseJson<UploadSessionResponse>(text);
      if (data?.result?.jwt && Array.isArray(data.result.buckets)) {
        const bucketCount = data.result.buckets.length;
        const hashCount = data.result.buckets.flat().length;
        console.log(
          `[assets] session created: ${bucketCount} bucket(s), ${hashCount} hash(es) to upload`,
        );
        if (hashCount === 0) {
          console.log('[assets] all assets cached — no uploads needed');
        }
        return { jwt: data.result.jwt, buckets: data.result.buckets };
      }
      console.warn(
        `[assets] session response missing jwt or buckets, retrying. raw: ${text.slice(0, 200)}`,
      );
      return undefined; // retry — likely CF plain-text bug
    },
    {
      maxRetries: ASSET_SESSION_MAX_RETRIES,
      delayMs: retryDelayMs,
      errorMessage: 'asset upload session returned invalid response after retries',
    },
  );
}

/**
 * Step 2: Upload asset file contents for each bucket.
 *
 * Buckets are uploaded concurrently (up to UPLOAD_CONCURRENCY). On CF gateway
 * errors (524), concurrency drops to 1 and gateway-specific backoff applies.
 * Gateway errors get several free retries before counting against the attempt
 * limit, matching Wrangler's behavior.
 */
export async function uploadAssetBuckets(
  accountId: string,
  jwt: string,
  buckets: ReadonlyArray<ReadonlyArray<string>>,
  assetsByHash: Map<string, AssetEntry>,
  {
    retryDelayMs = ASSET_BUCKET_UPLOAD_RETRY_DELAY_MS,
    gatewayDelayMs = GATEWAY_BACKOFF_BASE_MS,
  }: { retryDelayMs?: number; gatewayDelayMs?: number } = {},
): Promise<string> {
  if (!buckets.some((bucket) => bucket.length > 0)) {
    console.log('[assets] all assets cached — session JWT is completion token');
    return jwt;
  }

  let completionJwt = '';

  // Adaptive concurrency — shared across bucket tasks, drops to 1 on 524
  let concurrency = UPLOAD_CONCURRENCY;
  let activeCount = 0;
  const waiters: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    while (activeCount >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    activeCount++;
  }

  function releaseSlot(): void {
    activeCount--;
    const next = waiters.shift();
    if (next) {
      next();
    }
  }

  async function uploadBucket(bucket: ReadonlyArray<string>, bucketIndex: number): Promise<void> {
    console.log(
      `[assets] uploading bucket ${bucketIndex + 1}/${buckets.length}: ${bucket.length} file(s)`,
    );

    let attempts = 0;
    let bucketGatewayErrors = 0;
    let lastErr: unknown;

    while (true) {
      // Short-circuit: another bucket already got the JWT — upload is complete
      if (completionJwt) {
        return;
      }

      await acquireSlot();
      try {
        const parts = resolveAssetUploadParts(bucket, bucketIndex, assetsByHash);
        const { body, contentType } = createBase64MultipartBody(parts);

        const result = await postAssetUpload(accountId, jwt, body, contentType);
        if (result) {
          completionJwt = result;
        }
        return;
      } catch (err) {
        if (err instanceof AssetHashMissError) {
          throw err;
        } // non-retriable
        lastErr = err;
        if (attempts >= MAX_UPLOAD_RETRIES) {
          break;
        }
      } finally {
        releaseSlot();
      }

      // Error path — slot already released, backoff outside the concurrency limit
      console.warn(
        `[assets] bucket ${bucketIndex + 1} upload failed, retrying...`,
        lastErr instanceof Error ? lastErr.message : lastErr,
      );

      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempts) * retryDelayMs));

      if (lastErr instanceof AssetUploadError && lastErr.status === 524) {
        // Gateway error — throttle concurrency + additional backoff
        concurrency = 1;
        while (waiters.length > 0) {
          waiters.shift()!();
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, bucketGatewayErrors) * gatewayDelayMs),
        );
        bucketGatewayErrors++;
        console.warn(
          `[assets] bucket ${bucketIndex + 1} gateway error (524), ` +
            `concurrency → 1, gateway errors: ${bucketGatewayErrors}/${MAX_GATEWAY_ERRORS}`,
        );
        if (bucketGatewayErrors >= MAX_GATEWAY_ERRORS) {
          attempts++;
        }
      } else {
        attempts++;
      }
    }

    // All retries exhausted
    if (isJwtExpired(jwt)) {
      throw new Error(
        `Asset upload timed out on bucket ${bucketIndex + 1}/${buckets.length} — the upload session has expired. ` +
          `Assets already uploaded have been saved, so the next attempt will automatically resume from this point.`,
      );
    }
    throw lastErr;
  }

  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].length === 0) {
      continue;
    }
    const bucketIndex = i;
    tasks.push(uploadBucket(buckets[bucketIndex], bucketIndex));
  }
  // Use allSettled so a late bucket failure doesn't abort the deploy when the
  // completion JWT was already received (CF confirmed all hashes are present).
  const results = await Promise.allSettled(tasks);

  if (completionJwt) {
    return completionJwt;
  }

  // No JWT — find the first bucket error to surface, or throw a generic message
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  throw (
    failed?.reason ?? new Error('asset upload completed but no completion JWT received from CF')
  );
}

async function postAssetUpload(
  accountId: string,
  jwt: string,
  body: BodyInit,
  contentType: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': contentType,
      },
      body,
    },
  );

  if (!response.ok) {
    const status = response.status;
    const error = await response.text();
    console.error(`[assets] upload failed (${status}): ${error.slice(0, 500)}`);
    throw new AssetUploadError(status, `asset upload failed (${status}): ${error}`);
  }

  const text = await response.text();
  const data = tryParseJson<{ result?: { jwt?: string } }>(text);
  // Wrangler's fetchResult throws on malformed JSON responses. Match that:
  // a valid CF response always has a `result` key. Plain-text 2xx bodies
  // (CF edge-node bug) or unexpected JSON shapes should be retried.
  if (!data?.result) {
    throw new AssetUploadError(response.status, `malformed upload response: ${text.slice(0, 200)}`);
  }
  return data.result.jwt ?? null;
}

function isJwtExpired(jwt: string): boolean {
  try {
    // CF JWTs use base64url encoding — normalize to standard base64 before decoding
    const raw = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(raw));
    return typeof payload.exp === 'number' && payload.exp < Date.now() / 1000;
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const textEncoder = new TextEncoder();

type AssetUploadPart = Readonly<{
  hash: string;
  entry: AssetEntry;
}>;

function resolveAssetUploadParts(
  bucket: ReadonlyArray<string>,
  bucketIndex: number,
  assetsByHash: Map<string, AssetEntry>,
): ReadonlyArray<AssetUploadPart> {
  return bucket.map((hash) => {
    const entry = assetsByHash.get(hash);
    if (!entry) {
      throw new AssetHashMissError(
        `[assets] bucket ${bucketIndex}: hash ${hash} requested by CF but not found in assetsByHash. ` +
          `This indicates a manifest/upload mismatch — the hash was declared in the manifest ` +
          `but the corresponding file was not included in the upload.`,
      );
    }
    return { hash, entry };
  });
}

function createBase64MultipartBody(parts: ReadonlyArray<AssetUploadPart>): {
  body: ReadableStream<Uint8Array>;
  contentType: string;
} {
  const boundary = `----void-assets-${Math.random().toString(36).slice(2)}`;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  void (async () => {
    try {
      for (const { hash, entry } of parts) {
        await writer.write(
          textEncoder.encode(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${hash}"; filename="${hash}"\r\n` +
              `Content-Type: ${entry.contentType}\r\n\r\n`,
          ),
        );
        await writeBase64Bytes(writer, entry.bytes);
        await writer.write(textEncoder.encode('\r\n'));
      }
      await writer.write(textEncoder.encode(`--${boundary}--\r\n`));
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();

  return { body: readable, contentType: `multipart/form-data; boundary=${boundary}` };
}

// Emit base64 of `bytes` to `writer` in bounded chunks so a large asset is
// never rendered into a single mega-allocation. Chunks are aligned to 3 bytes
// (base64's natural boundary) except for the final tail, which pads as usual.
async function writeBase64Bytes(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  const STEP = 48 * 1024; // 48 KiB raw → 64 KiB of base64 output
  let offset = 0;
  while (offset + STEP < bytes.length) {
    await writer.write(textEncoder.encode(bytesToBase64(bytes.subarray(offset, offset + STEP))));
    offset += STEP;
  }
  if (offset < bytes.length) {
    await writer.write(textEncoder.encode(bytesToBase64(bytes.subarray(offset))));
  }
}

function digestToAssetHash(digest: Uint8Array): string {
  return [...digest]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute a CF-compatible asset hash: BLAKE3 of base64(content) + extension,
 * first 32 hex chars. Matches Wrangler's hashFile algorithm exactly.
 * Must match the CLI's computeAssetHash algorithm exactly.
 */
export function computeAssetHash(content: ArrayBuffer, filePath: string): string {
  const base64 = arrayBufferToBase64(content);
  const ext = extname(filePath).substring(1);
  const input = textEncoder.encode(base64 + ext);
  return digestToAssetHash(blake3hash(input));
}

export class AssetHashMismatchError extends Error {}

/**
 * Merge a declared (client-sent) asset manifest into a built-from-content manifest.
 * Validates that declared hashes match what we computed; if so, prefers the declared
 * entry verbatim so the upload manifest matches what the CLI sent.
 */
export function applyDeclaredAssetManifest(
  built: Record<string, AssetManifestEntry>,
  declared: Record<string, AssetManifestEntry> | undefined,
): Record<string, AssetManifestEntry> {
  // Always return a fresh object so callers may freely mutate the result
  // (e.g. preflight fill-ins) without reaching back through a shared reference
  // into the builder's state.
  const result: Record<string, AssetManifestEntry> = { ...built };
  if (!declared) {
    return result;
  }
  for (const [path, entry] of Object.entries(built)) {
    const declaredEntry = declared[path];
    if (
      declaredEntry &&
      typeof declaredEntry.hash === 'string' &&
      declaredEntry.hash.length === 32 &&
      Number.isFinite(declaredEntry.size) &&
      declaredEntry.size >= 0
    ) {
      if (declaredEntry.hash !== entry.hash) {
        throw new AssetHashMismatchError(
          `asset hash mismatch for ${path}: declared ${declaredEntry.hash}, computed ${entry.hash}`,
        );
      }
      if (declaredEntry.size === entry.size) {
        result[path] = declaredEntry;
      }
    }
  }
  return result;
}

/**
 * Determine content type from file path using the `mime` package (same as Wrangler).
 * Falls back to "application/null" for unknown extensions — a sentinel value that
 * signals CF to omit the Content-Type header. Matches Wrangler's behavior at
 * workers-sdk/packages/wrangler/src/assets.ts.
 */
/** MIME types that are text-based and should include charset=utf-8. */
const CHARSET_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/manifest+json',
  'image/svg+xml',
]);

export function getContentType(path: string): string {
  let contentType = mime.getType(path);
  if (contentType && !contentType.includes('charset')) {
    if (contentType.startsWith('text/') || CHARSET_TYPES.has(contentType)) {
      contentType = `${contentType}; charset=utf-8`;
    }
  }
  return contentType ?? 'application/null';
}

/**
 * Build the worker metadata with assets JWT and config attached.
 */
export function buildAssetMetadata(
  jwt: string,
  config?: AssetConfig,
): { jwt: string; config?: AssetConfig } {
  return {
    jwt,
    ...(config ? { config } : {}),
  };
}

export const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

async function uploadStaticAssetWithRetries(
  kv: KVNamespace,
  r2: R2Bucket,
  key: string,
  entry: AssetEntry,
  retryDelayMs: number,
): Promise<'kv' | 'r2'> {
  const store = entry.bytes.byteLength >= KV_THRESHOLD ? 'r2' : 'kv';
  let lastErr: unknown;

  for (let attempt = 0; attempt <= STATIC_ASSET_UPLOAD_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
    }

    try {
      if (store === 'r2') {
        await r2.put(key, entry.bytes, {
          httpMetadata: { contentType: entry.contentType },
        });
      } else {
        await kv.put(key, entry.bytes, {
          metadata: { ct: entry.contentType },
        });
      }
      return store;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[assets] static ${store} upload failed for ${key} ` +
          `(attempt ${attempt + 1}/${STATIC_ASSET_UPLOAD_MAX_RETRIES + 1})`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  throw lastErr ?? new Error(`static asset upload failed for ${key}`);
}

/**
 * Upload static assets to KV (< 2 MB) or R2 (>= 2 MB).
 * Content-addressed keys make puts idempotent, so no existence checks needed.
 * Uploads run with bounded concurrency to avoid holding every asset body in Worker memory.
 * Returns the set of hashes that were stored in R2 (large assets).
 */
export async function uploadStaticAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  assetsByHash: Map<string, AssetEntry>,
  projectId: string,
  { retryDelayMs = STATIC_ASSET_UPLOAD_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<Set<string>> {
  const largeHashes = new Set<string>();
  const entries = Array.from(assetsByHash);
  let index = 0;
  // Collected across all workers so that every in-flight put settles (or
  // stops picking up new entries) before this function returns. Without
  // this, Promise.all would reject on the first worker failure while the
  // remaining workers keep writing bytes in the background, racing any
  // abort-cleanup the caller triggers.
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (firstError === undefined && index < entries.length) {
      const [hash, entry] = entries[index++];
      const key = `assets/${projectId}/${hash}`;
      try {
        const store = await uploadStaticAssetWithRetries(kv, r2, key, entry, retryDelayMs);
        if (store === 'r2') {
          largeHashes.add(hash);
        }
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(STATIC_ASSET_UPLOAD_CONCURRENCY, entries.length) }, () =>
      worker(),
    ),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
  return largeHashes;
}

/**
 * Delete assets that are no longer referenced by any retained deployment.
 * Deletes from both KV and R2 (content-addressed keys live in one or the other,
 * but we clean both since we don't track which store holds a given hash).
 */
export async function deleteUnreferencedAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  evictedHashes: ReadonlyArray<string>,
  retainedHashes: Set<string>,
  projectId: string,
): Promise<void> {
  const toDelete = evictedHashes.filter((hash) => !retainedHashes.has(hash));
  if (toDelete.length === 0) {
    return;
  }

  for (const hash of toDelete) {
    await kv.delete(`assets/${projectId}/${hash}`);
  }

  // R2 supports batch delete up to 1000 keys at a time
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000).map((hash) => `assets/${projectId}/${hash}`);
    await r2.delete(batch);
  }
}

function workerBundlePrefix(projectId: string, deploymentId: string): string {
  return `worker-bundles/${projectId}/${deploymentId}/`;
}

/**
 * Persist a user-worker bundle to R2 so a future rollback can re-PUT the
 * exact same bytes. Each file becomes one R2 object under the key
 * `worker-bundles/{projectId}/{deploymentId}/{filePath}`.
 *
 * Caller MUST set `deployments.bundle_stored = true` only after this resolves
 * — the invariant is `bundle_stored=true ⇒ rollbackable`.
 *
 * Failure semantics: a bounded worker pool drains until either every file is
 * written or one put rejects. On the first rejection, we stop scheduling new
 * files but await all in-flight workers before re-throwing — without this,
 * Promise.all would reject while sibling writes were still in flight, racing
 * the deploy abort cleanup and leaking partial rollback artifacts under the
 * deployment prefix.
 */
const BUNDLE_UPLOAD_CONCURRENCY = 8;

export async function persistWorkerBundle(
  r2: R2Bucket,
  projectId: string,
  deploymentId: string,
  files: ReadonlyArray<{ name: string; content: Blob }>,
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const prefix = workerBundlePrefix(projectId, deploymentId);
  let index = 0;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (firstError === undefined && index < files.length) {
      const file = files[index++];
      try {
        const bytes = await file.content.arrayBuffer();
        await r2.put(`${prefix}${file.name}`, bytes, {
          httpMetadata: { contentType: file.content.type },
        });
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BUNDLE_UPLOAD_CONCURRENCY, files.length) }, () => worker()),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
}

/**
 * Read all bundle modules for a deploy from R2. Returns the module list ready
 * to drop into a multipart user-worker PUT (same shape as the in-memory
 * `workerFiles[]` collected during a fresh deploy).
 *
 * Throws if no bundle objects are found (rollback caller should validate
 * `target.bundle_stored=true` BEFORE calling this).
 */
export async function replayWorkerBundle(
  r2: R2Bucket,
  projectId: string,
  deploymentId: string,
): Promise<ReadonlyArray<{ name: string; content: Blob }>> {
  const prefix = workerBundlePrefix(projectId, deploymentId);
  const keys: Array<string> = [];
  let cursor: string | undefined;
  do {
    const listed = await r2.list({ prefix, cursor });
    for (const obj of listed.objects) {
      keys.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  if (keys.length === 0) {
    throw new Error(`no bundle objects found for deploy ${deploymentId} (project ${projectId})`);
  }

  return Promise.all(
    keys.map(async (key) => {
      const obj = await r2.get(key);
      if (obj === null) {
        throw new Error(`bundle object ${key} disappeared between list and get`);
      }
      const bytes = await obj.arrayBuffer();
      const contentType = obj.httpMetadata?.contentType ?? '';
      return {
        name: key.slice(prefix.length),
        content: new Blob([bytes], { type: contentType }),
      };
    }),
  );
}

/**
 * Skip keys uploaded within the pending-upload protection window. These may
 * be in-flight uploads for a not-yet-finalized deploy — `POST /deploy/upload-urls`
 * mints presigned PUTs that are not bound to a deploy lifecycle, so bytes
 * land in R2 BEFORE any manifest references them. The window is 2× the
 * presign TTL (1800s in `routes/deploy.ts`) to give the CLI time to upload
 * + finalize; halving the window risks deleting bytes the CLI is about to
 * reference. See `meta/design-docs/0068-direct-r2-asset-upload.md`.
 */
export const PENDING_UPLOAD_PROTECTION_SECONDS = 3600;

/** Maximum keys per R2 list/delete call. Per the R2 S3 compatibility limits. */
const R2_DELETE_BATCH = 1000;

/**
 * Walk every R2 object under `prefix` and delete it in batches of 1000.
 * Pure pagination: no concurrency, since the producers (teardown, retention
 * cleanup) run far from request critical paths and a single delete batch
 * is already a fan-out under the hood.
 *
 * `keepIf` is consulted per object — return `true` to KEEP, `false` to
 * delete. Omit it to delete every object under the prefix.
 *
 * Idempotent: a missing key inside a delete batch is a no-op on R2 (and on
 * the in-memory mock used in tests). Returns the number of keys actually
 * deleted so callers can log meaningful sweep counts.
 */
export async function paginatedR2Delete(
  r2: R2Bucket,
  prefix: string,
  options: { keepIf?: (obj: R2Object) => boolean } = {},
): Promise<number> {
  const keepIf = options.keepIf;
  const toDelete: Array<string> = [];
  let cursor: string | undefined;
  do {
    const listed = await r2.list({ prefix, cursor, limit: R2_DELETE_BATCH });
    for (const obj of listed.objects) {
      if (keepIf && keepIf(obj)) {
        continue;
      }
      toDelete.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  if (toDelete.length === 0) {
    return 0;
  }

  for (let i = 0; i < toDelete.length; i += R2_DELETE_BATCH) {
    await r2.delete(toDelete.slice(i, i + R2_DELETE_BATCH));
  }
  return toDelete.length;
}

/**
 * Delete all bundle modules for a deploy. Used by the retention loop when
 * a deploy is evicted past the retention window. Idempotent: deletes that
 * hit keys that don't exist are no-ops.
 */
export async function deleteWorkerBundle(
  r2: R2Bucket,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await paginatedR2Delete(r2, workerBundlePrefix(projectId, deploymentId));
}

/**
 * Delete every R2 object under `assets/{projectId}/...`. Used by project
 * teardown to sweep the entire static-asset keyspace for the project — both
 * hashes referenced by retained deployments AND orphans uploaded via the
 * direct-to-R2 presigned PUTs that never finalized into a live deploy.
 *
 * Idempotent — listing returns no objects for projects that never uploaded
 * any assets.
 */
export async function deleteProjectAssets(r2: R2Bucket, projectId: string): Promise<void> {
  await paginatedR2Delete(r2, `assets/${projectId}/`);
}

/**
 * Delete R2 objects under `assets/{projectId}/...` whose blake3 hash (the
 * trailing path segment) is NOT in `retainedHashes`. Used opportunistically
 * by retention cleanup to catch direct-to-R2 orphans (bytes uploaded via
 * presigned PUTs that never finalized into a live deploy on this project).
 *
 * Returns the number of orphan keys deleted.
 *
 * Race protection: keys uploaded within `PENDING_UPLOAD_PROTECTION_SECONDS`
 * are preserved even when not in `retainedHashes`. Without this guard, a
 * concurrent `upload-urls` flow on the same project (or even the same
 * deploy, finalizing slightly after the sweep starts) can have its bytes
 * deleted out from under it, breaking the next finalize with "asset not
 * found". Tradeoff: orphans uploaded within the window only get cleaned up
 * on the NEXT eligible deploy ≥ 1h later — see the `TODO(orphan-gc)` in
 * `routes/deploy.ts` for the periodic-sweep follow-up.
 *
 * KV is intentionally NOT swept here: KV-resident assets are written by the
 * server-side mirror path during finalize, not by direct-to-R2 PUTs, so
 * orphans only accrue in R2.
 */
export async function sweepProjectAssetOrphans(
  r2: R2Bucket,
  projectId: string,
  retainedHashes: Set<string>,
): Promise<number> {
  const prefix = `assets/${projectId}/`;
  const now = Date.now();
  const protectionMs = PENDING_UPLOAD_PROTECTION_SECONDS * 1000;
  return paginatedR2Delete(r2, prefix, {
    keepIf: (obj) => {
      const hash = obj.key.slice(prefix.length);
      // Malformed key (no hash segment after the prefix) — fall through
      // to the delete bucket so the cleanup loop self-heals.
      if (hash.length === 0) {
        return false;
      }
      // Manifest-referenced bytes are retained.
      if (retainedHashes.has(hash)) {
        return true;
      }
      // Pending-upload protection window — see `PENDING_UPLOAD_PROTECTION_SECONDS`.
      return now - obj.uploaded.getTime() < protectionMs;
    },
  });
}
