/**
 * Shared ISR key/URL helpers used by both the API (purge) and the dispatch
 * worker (read/write). These functions MUST produce byte-identical output:
 * the API purges KV keys and edge URLs that dispatch writes and reads.
 *
 * Dispatch derives the deployment id for its keys via
 * `routing.version ?? 'legacy'`, which allows any non-nullish value —
 * including the empty string — to pass through unchanged. The helpers below
 * preserve that shape so the API can compute the exact same key for purge.
 */

const ISR_CACHE_KEY_VERSION = 'v3';

/**
 * Previous key version. `v3` keys are ALWAYS host-scoped
 * (`<proj>/isr/v3/<D>/<host>/<path>`); `v2` keys are ALWAYS hostless
 * (`<proj>/isr/v2/<D>/<path>`) — the `<host>` segment did not exist yet.
 *
 * The bump to `v3` was forced by a real aliasing hazard: under a single
 * version, a host-scoped key `<D>/<host>/<path>` and a legacy hostless key
 * `<D>/<host>/<path>` are byte-identical whenever the legacy path's leading
 * segment happens to look like a hostname. Dotted leading path segments are
 * legal (`[domain]` → `:domain`, `[...slug]` → `(.+)`), so a hostless key for
 * the page `/example.com/about` collides exactly with the host-scoped key for
 * `(host=example.com, /about)`. The stored metadata is only `{s,c,t}` (no
 * path/host), so a reader cannot tell them apart and could serve one page's
 * body for the other. Encoding the shape in the version removes the ambiguity:
 * the version alone determines whether a `<host>` segment is present, so no
 * runtime heuristic (e.g. "is the first segment an attached hostname?") is
 * needed to classify a key. Package-internal, like `ISR_CACHE_KEY_VERSION`.
 */
const ISR_LEGACY_CACHE_KEY_VERSION = 'v2';

/**
 * KV metadata stored alongside every ISR cache entry. This is the single
 * canonical shape shared by the dispatch worker (which writes it on a live
 * miss and reads it back on a hit — see `dispatch/src/isr.ts`) AND the API
 * prerender-warm path (`api/src/deploy/publish-worker.ts`), which pre-populates the
 * same KV keys during deploy. Both writers MUST use these exact field names:
 * the reader requires `c` (createdAt) and `t` (ttl) and returns null without
 * them, so a writer that drifts (e.g. writes `context` instead of `c`) produces
 * a permanent cold miss that no typecheck would catch unless it is annotated
 * `satisfies IsrCacheMetadata`. Keep the fields terse — this is stored on every
 * KV entry.
 */
export type { IsrCacheMetadata } from './core.ts';

/**
 * Build the normalized path segment for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export function normalizeIsrPath(pathname: string): string {
  let normalized = pathname;
  if (normalized === '/') {
    normalized = '__index__';
  } else {
    // Strip leading slash
    normalized = normalized.startsWith('/') ? normalized.slice(1) : normalized;
    // Strip trailing slash
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized;
}

/**
 * Inverse of `normalizeIsrPath`: turn a normalized segment back into a
 * pathname starting with `/`.
 */
export function denormalizeIsrPath(normalized: string): string {
  return normalized === '__index__' ? '/' : `/${normalized}`;
}

/**
 * Canonicalize an inbound pathname to the form used inside edge cache URLs.
 * Equivalent to `denormalizeIsrPath(normalizeIsrPath(pathname))` — strips any
 * trailing slash except for root.
 */
export function canonicalIsrPathname(pathname: string): string {
  return denormalizeIsrPath(normalizeIsrPath(pathname));
}

function versionedIsrCachePrefix(
  projectId: string,
  version: string,
  deploymentId: string | undefined,
): string {
  if (deploymentId !== undefined) {
    return `${projectId}/isr/${version}/${deploymentId}/`;
  }
  return `${projectId}/isr/`;
}

/**
 * Prefix for listing/purging ISR keys.
 *
 * `deploymentId === ''` must still produce the versioned prefix with an
 * empty segment (`<projectId>/isr/v3//`) because dispatch uses
 * `routing.version ?? 'legacy'`, which allows empty strings and writes
 * keys at `<projectId>/isr/v3//<path>`. Only `undefined` selects the
 * legacy scan-all prefix (`<projectId>/isr/`).
 */
export function isrCachePrefix(projectId: string, deploymentId?: string): string {
  return versionedIsrCachePrefix(projectId, ISR_CACHE_KEY_VERSION, deploymentId);
}

/**
 * Prefix for listing/purging LEGACY (pre-host-scoping) ISR keys — the `v2`
 * namespace `<projectId>/isr/v2/<deploymentId>/`. Mirrors `isrCachePrefix`'s
 * optional-`deploymentId` behavior exactly (empty string yields the versioned
 * prefix with an empty segment; only `undefined` selects the scan-all
 * `<projectId>/isr/` prefix).
 *
 * Exists SOLELY for the host-scoping rollout: the purger sweeps this namespace
 * to reap orphaned `v2` KV keys and purge their edge URLs. Current dispatch
 * neither reads nor writes `v2` keys. Transition-only — remove once `v2`
 * entries have aged out.
 */
export function isrLegacyCachePrefix(projectId: string, deploymentId?: string): string {
  return versionedIsrCachePrefix(projectId, ISR_LEGACY_CACHE_KEY_VERSION, deploymentId);
}

/**
 * Separator that marks the rewrite-variant suffix on an ISR cache key or
 * the corresponding edge-cache URL parameter. `#` cannot appear in
 * `url.pathname` (fragments are stripped before the request reaches the
 * server) and does not survive `normalizeIsrPath`, so it unambiguously
 * identifies the variant suffix.
 */
const ISR_VARIANT_SEPARATOR = '#rw=';

/**
 * Build the cache key for an ISR-cached page.
 * ISR is deployment-scoped so cached HTML cannot outlive the hashed assets
 * referenced by the deployment that produced it, and host-scoped (`<host>`
 * segment after the deployment id) so the same path served under different
 * hostnames — e.g. a project slug and a custom domain, or two custom
 * domains — never share a cache slot. `host` is the request hostname the
 * dispatch worker saw (`new URL(request.url).hostname`).
 *
 * Host-scoping is a `v3` key format: `<proj>/isr/v3/<D>/<host>/<path>`. The
 * version bump is load-bearing, not cosmetic — see `ISR_LEGACY_CACHE_KEY_VERSION`.
 *
 * When `originalUrl` is provided, the request was served via a dispatch-side
 * rewrite (`redirectRules`/`fallbackRules` with status 200). The original
 * request URL is mixed into the key so a direct hit to `/en/docs` and a
 * rewrite from `/docs` to `/en/docs` do not collide — user code can branch
 * on `c.isRewritten()` / `c.originalUrl()`, and the cache must honor that.
 * A missing `originalUrl` means "direct hit" and produces the unsuffixed key.
 */
export function isrCacheKey(
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null,
): string {
  const base = `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}`;
  if (!originalUrl) {
    return base;
  }
  return `${base}${ISR_VARIANT_SEPARATOR}${hashOriginalUrl(originalUrl)}`;
}

/**
 * Prefix used to list/purge every variant of a given pathname under a
 * deployment — both the direct-hit key and any rewrite-variant keys.
 */
export function isrCacheVariantPrefix(
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
): string {
  return `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;
}

/**
 * Build the exact LEGACY (pre-host-scoping) direct-hit key for a pathname under
 * a deployment: `<projectId>/isr/v2/<deploymentId>/<normalizedPath>` — the
 * hostless counterpart of `isrCacheKey` with no `<host>/` segment and no
 * rewrite-variant suffix. Used by the purger to reap the orphaned `v2`
 * direct-hit KV key for a requested path.
 *
 * Exists SOLELY for the host-scoping rollout — current dispatch neither writes
 * nor reads hostless keys. Transition-only. Do not use it on the hot path.
 */
export function isrLegacyCacheKey(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${isrLegacyCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}`;
}

/**
 * Prefix used to list/purge the pre-host-scoped ("legacy") rewrite variants of
 * a given pathname under a deployment. Before ISR keys grew a `<host>` segment,
 * variant keys were written as
 * `<projectId>/isr/v2/<deploymentId>/<normalizedPath>#rw=<token>` — identical to
 * `isrCacheVariantPrefix` but with NO `<host>/` segment. Those entries still
 * persist during the host-scoping rollout (ISR puts set no `expirationTtl`),
 * so the purger must scan this hostless `v2` prefix in addition to the
 * host-scoped `v3` one to recover their variant tokens and purge the matching
 * edge URLs.
 *
 * Built off `isrLegacyCachePrefix` (the `v2` namespace), NOT `isrCachePrefix`
 * (now `v3`), so it targets the legacy hostless keys it is meant to sweep.
 *
 * Exists SOLELY for that rollout cleanup — current dispatch neither writes nor
 * reads hostless keys. Transition-only. Do not use it on the hot path.
 */
export function isrLegacyCacheVariantPrefix(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${isrLegacyCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;
}

/**
 * Hash an original-URL value into a fixed-length, opaque variant token.
 * Used as both the KV-key suffix and the `__void_orig` query value, so the
 * writer and purger paths see byte-identical tokens for the same URL.
 *
 * Properties:
 *   - Sync (Workers `crypto.subtle.digest` is async; we don't want to push
 *     async through every read/write path for this).
 *   - 16 hex chars (64 bits) — bounds the KV key length regardless of input.
 *   - Non-recoverable: KV is operator-readable, so the token must not reveal
 *     original URLs (including sensitive query strings like `?token=…`).
 *   - Not cryptographic: collision resistance is ~2^32 (birthday). Fine for
 *     the per-deployment, per-pathname variant set we ever store in one slot.
 *
 * Implementation: FNV-1a 64-bit over UTF-8 bytes. BigInt arithmetic for the
 * multiply (no native u64 in JS), but inputs are short (URLs, sub-1KB) and
 * this only runs once per ISR-touched request.
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export function hashOriginalUrl(originalUrl: string): string {
  const bytes = new TextEncoder().encode(originalUrl);
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i]!)) & FNV_MASK;
    h = (h * FNV_PRIME) & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Split a fully-qualified ISR KV key into the normalized pathname segment
 * and the optional rewrite-variant token. Returns `null` token when the
 * key has no `#rw=` suffix (direct hit).
 *
 * The token is opaque (a hash); the original URL it was derived from is not
 * recoverable. Callers that need to reproduce the matching edge-cache URL
 * pass the token through `isrEdgeCacheUrlForToken`.
 */
export function splitIsrCacheKey(fullKey: string): {
  normalizedPath: string;
  variantToken: string | null;
} {
  const sepIdx = fullKey.indexOf(ISR_VARIANT_SEPARATOR);
  if (sepIdx === -1) {
    return { normalizedPath: fullKey, variantToken: null };
  }
  return {
    normalizedPath: fullKey.slice(0, sepIdx),
    variantToken: fullKey.slice(sepIdx + ISR_VARIANT_SEPARATOR.length),
  };
}

/**
 * Build the edge cache URL that dispatch uses as its `caches.default` key
 * (wrapped in a GET `Request`). The public URL stays clean; the internal
 * cache key carries the deployment id so a new deploy never reads HTML
 * produced by an older deploy. The `json` variant separates pages-protocol
 * JSON responses from HTML for the same path+deployment.
 *
 * This MUST match the URL dispatch writes. Dispatch builds the URL from
 * `new URL(request.url).hostname`; for standard-port HTTPS traffic (all CF
 * edge traffic) that yields the same origin as the one produced here.
 */
export function isrEdgeCacheUrl(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  originalUrl?: string | null,
): string {
  return buildIsrEdgeCacheUrl(
    hostname,
    pathname,
    deploymentId,
    variant,
    originalUrl ? hashOriginalUrl(originalUrl) : null,
  );
}

/**
 * Like `isrEdgeCacheUrl`, but takes a pre-hashed variant token (from
 * `splitIsrCacheKey`). Used by the purger, which only knows the hashed
 * token: the original URL is not recoverable from a KV key.
 */
export function isrEdgeCacheUrlForToken(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  variantToken?: string | null,
): string {
  return buildIsrEdgeCacheUrl(hostname, pathname, deploymentId, variant, variantToken ?? null);
}

function buildIsrEdgeCacheUrl(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  variantToken: string | null,
): string {
  const normalizedPathname = canonicalIsrPathname(pathname);
  const url = new URL(`https://${hostname}${normalizedPathname}`);
  if (variant === 'json') {
    url.searchParams.set('__void', 'json');
  }
  url.searchParams.set('__void_isr', deploymentId);
  if (variantToken) {
    url.searchParams.set('__void_orig', variantToken);
  }
  return url.toString();
}
