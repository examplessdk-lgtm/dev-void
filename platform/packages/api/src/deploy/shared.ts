import { platformProjectHostname, readPlatformApplication } from '@void/platform';
import type { ApiEnv } from '../env.ts';
import type { Project } from '../types.ts';
import { isCfAssetPlainText } from './migrations.ts';

// Cap on the number of presign requests in a single batch. Presigning is
// CPU-light (one HMAC chain per call) but unbounded fanout still costs
// memory and lets a malformed CLI burn server CPU without bound. 5000 is
// well above the largest realistic dist/ asset count. Asset manifests on the
// JSON-mode deploy share the same cap for symmetry.
export const MAX_UPLOAD_URLS_BATCH = 5000;

export const DEFAULT_TAIL_SERVICE_NAME = 'void-tail';

// CF's worker script size limit (free plan 1 MiB, paid plan 10 MiB compressed).
// Enforced per worker module so a single runaway worker file cannot OOM the
// request before the upload to CF ever happens.
export const MAX_WORKER_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Decode a base64 string to bytes with the lowest peak residency the
 * runtime allows. Prefers the (TC39 stage-4) `Uint8Array.fromBase64` helper
 * which performs the decode in a single allocation; falls back to the
 * `atob` + per-byte copy path on runtimes that don't expose it (notably
 * Node, where the integration tests run — the production CF Workers compat
 * date is 2026-02-12 and ships the helper natively).
 *
 * For a 32 MiB module the fast path drops peak residency from
 * roughly `raw + bin + decoded ≈ 86 + 64 + 32 = 182 MiB` to
 * `raw + decoded ≈ 86 + 32 = 118 MiB`, which fits under the 128 MiB
 * isolate cap with margin.
 */
export function decodeBase64ToBytes(raw: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array })
    .fromBase64;
  if (typeof fromBase64 === 'function') {
    return fromBase64(raw);
  }
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Public URLs for a project: active custom domains first, then the platform hostname. */
export function projectPublicUrls(
  env: ApiEnv['Bindings'],
  project: Project,
  domains: ReadonlyArray<Readonly<{ hostname: string; status: string }>>,
): Array<string> {
  return [
    ...domains.filter((domain) => domain.status === 'active').map((d) => `https://${d.hostname}`),
    `https://${platformProjectHostname(project, readPlatformApplication(env))}`,
  ];
}

export const CF_RETRY = { maxRetries: 3, delayMs: 1000 };

// Readiness probe: confirms the new worker is live in the dispatch namespace
// before dispatching migrations. Absorbs CF's WfP propagation delay.
// Backoff: 0 + 1 + 2 + 4 + 8 + 16 + 32 = ~63s max window.
export const CF_READINESS_RETRY = { maxRetries: 6, delayMs: 1000 };

export function sanitizeDeployErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (
    isCfAssetPlainText(trimmed) ||
    // JSON.parse SyntaxError truncates the original text (e.g. `Unexpected token 'A', "Assets hav"...`)
    // so the full substring won't match — detect the truncated form too
    /Unexpected token.*"Assets hav/.test(trimmed)
  ) {
    return 'asset upload returned an unexpected Cloudflare response';
  }
  return message;
}

// Bounded concurrency for the R2 head check that verifies declared assets
// were actually uploaded by the CLI before the JSON-mode deploy proceeds.
// 20 matches R2's typical head-throughput sweet spot — verifying 5000
// assets at this concurrency completes in well under the deploy heartbeat
// interval.
export const R2_HEAD_VERIFY_CONCURRENCY = 20;

// Keep each project-row-lock tenure bounded while reconciling external asset
// stores. A fresh retained/in-flight hash snapshot is taken for every batch.
export const ASSET_GC_LOCK_BATCH = 100;

// Retention is post-cutover and best-effort. Bound all eviction + orphan work
// across one request so cleanup can never consume the Worker's 1,000 external
// operation budget before the already-live deployment emits `done`.
export const ASSET_GC_MAX_HASHES_PER_DEPLOY = 200;

// Per-blake3 / per-md5 validation: 32 lowercase hex characters.
export const HEX_32_REGEX = /^[0-9a-f]{32}$/;

// Generous body cap for JSON-mode deploy POSTs. The body is dominated by
// `workerFiles` (base64-encoded user worker modules); MAX_WORKER_FILE_BYTES
// is 32 MiB per module and a worker can ship ~10 modules in practice.
//
// Base64 expansion is ~33%, so a single 32 MiB raw module weighs ~43 MiB
// on the wire. 64 MiB comfortably accommodates one full-size module (with
// safety margin) plus the manifest, assetManifest, vars, and source/commit
// JSON, while staying well under the 128 MiB Worker memory limit. Asset
// BYTES are NOT in this body — they go direct-to-R2 via presigned PUTs,
// which is the whole reason this endpoint exists.
export const MAX_JSON_DEPLOY_BODY_BYTES = 64 * 1024 * 1024;

export type UploadUrlsRequestAsset = Readonly<{
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
}>;

export function moduleContentType(filename: string): string {
  if (filename.endsWith('.wasm')) {
    return 'application/wasm';
  }
  if (filename.endsWith('.map')) {
    return 'application/source-map';
  }
  if (filename.endsWith('.json')) {
    return 'application/json';
  }
  if (filename.endsWith('.txt')) {
    return 'text/plain';
  }
  return 'application/javascript+module';
}
