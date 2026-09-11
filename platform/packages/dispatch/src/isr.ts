import { isrCacheKey, isrCacheVariantPrefix, isrEdgeCacheUrl } from '@voidcloud/isr-shared';
import type { IsrCacheMetadata } from '@voidcloud/isr-shared';
import type { Env } from './env.ts';
import { matchSegmentPattern } from './pattern.ts';

// Re-export so callers that import from `./isr` (tests, index.ts) still work.
export { isrCacheKey };
export type { IsrCacheMetadata };

/**
 * Hard cap on rewrite-variant ISR entries per (project, deployment, pathname).
 * The default `revalidateQueryAllowlist = {}` already drops every query param,
 * so most fanout vectors are closed at the variant-key level — but a path
 * with an allowlisted param (e.g. `/search` with `q`) can still be probed
 * with random `q` values. The cap is the second line of defense: once the
 * KV slot for a pathname holds this many variants, new variants stop being
 * written. The worker still renders fresh content; we simply refuse to
 * persist it, so KV growth and revalidation cost stay bounded.
 *
 * Existing variants continue to update so legitimate ISR refresh keeps
 * working; only NEW variants are rejected past the cap.
 */
export const MAX_ISR_VARIANTS_PER_PATH = 200;

export type IsrCacheEntry = Readonly<{
  body: ReadableStream;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number;
}>;

const PAGE_DATA_SCRIPT_RE =
  /<script\b[^>]*\bid=(["'])__VOID_PAGE_DATA__\1[^>]*>([\s\S]*?)<\/script>/i;

/**
 * Pack response headers + body into a single ArrayBuffer.
 * Format: [4 bytes uint32 LE header length][UTF-8 header JSON][raw body]
 */
export function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true); // little-endian
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/**
 * Unpack headers + body from a packed ArrayBuffer.
 * Returns null if the buffer is too small or malformed.
 */
export function unpackIsrValue(
  buffer: ArrayBuffer,
): { headers: Record<string, string>; body: ArrayBuffer } | null {
  if (buffer.byteLength < 4) {
    return null;
  }
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, true);
  if (buffer.byteLength < 4 + headerLen) {
    return null;
  }
  try {
    const headerBytes = new Uint8Array(buffer, 4, headerLen);
    const headers: Record<string, string> = JSON.parse(new TextDecoder().decode(headerBytes));
    const body = buffer.slice(4 + headerLen);
    return { headers, body };
  } catch {
    return null;
  }
}

/**
 * Read an ISR cache entry from KV.
 * Returns null on cache miss or if metadata is malformed.
 */
export async function readIsrCache(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null,
): Promise<IsrCacheEntry | null> {
  const key = isrCacheKey(projectId, deploymentId, host, pathname, originalUrl);
  const { value, metadata } = await env.ISR_CACHE.getWithMetadata<IsrCacheMetadata>(
    key,
    'arrayBuffer',
  );
  if (!value || !metadata) {
    return null;
  }

  const unpacked = unpackIsrValue(value);
  if (!unpacked) {
    return null;
  }

  if (!metadata.c || !metadata.t) {
    return null;
  }

  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(unpacked.body));
        controller.close();
      },
    }),
    status: metadata.s,
    headers: unpacked.headers,
    createdAt: metadata.c,
    ttl: metadata.t,
  };
}

/**
 * Delete an ISR cache entry from KV.
 * Used when a worker permanently opts out via x-revalidate: 0.
 */
export async function deleteIsrCache(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null,
): Promise<void> {
  const key = isrCacheKey(projectId, deploymentId, host, pathname, originalUrl);
  await env.ISR_CACHE.delete(key);
}

/**
 * Write an ISR cache entry to KV. Variant writes are gated by
 * `MAX_ISR_VARIANTS_PER_PATH` — past the cap, only updates to existing
 * variant slots go through. Direct-hit entries (no `originalUrl`) are
 * never gated.
 */
export async function writeIsrCache(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  response: Response,
  ttl: number,
  originalUrl?: string | null,
): Promise<void> {
  const key = isrCacheKey(projectId, deploymentId, host, pathname, originalUrl);
  // Clone synchronously so the cap-check `await` below cannot race with
  // callers (in `index.ts`) that consume `response.body` for the client
  // response after kicking us off via `ctx.waitUntil`. The clone has its
  // own independent body; the original is free to be consumed elsewhere.
  const responseClone = response.clone();
  const headers = serializeHeaders(responseClone);
  const status = responseClone.status;

  if (
    originalUrl &&
    !(await isVariantWriteAllowed(env, projectId, deploymentId, host, pathname, key))
  ) {
    return;
  }

  const body = await responseClone.arrayBuffer();
  const packed = packIsrValue(headers, body);

  await env.ISR_CACHE.put(key, packed, {
    metadata: {
      s: status,
      c: Date.now(),
      t: ttl,
    } satisfies IsrCacheMetadata,
  });
}

/**
 * Returns true if writing the given variant key is allowed under the
 * per-pathname cap. Always allows updates to existing variants (so ISR
 * revalidation keeps working after a path saturates).
 *
 * The KV list call is alphabetically ordered; we list up to `1000` entries
 * (the KV per-call max) which comfortably covers any realistic cap. If a
 * pathname has more variants than the listing returns, we conservatively
 * refuse new writes — that case shouldn't occur with the cap enforced.
 */
async function isVariantWriteAllowed(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  key: string,
): Promise<boolean> {
  const prefix = isrCacheVariantPrefix(projectId, deploymentId, host, pathname);
  const listed = await env.ISR_CACHE.list({ prefix, limit: 1000 });
  if (listed.keys.length < MAX_ISR_VARIANTS_PER_PATH) {
    return true;
  }
  // At or over cap: only allow updates to existing keys.
  return listed.keys.some((cacheKey) => cacheKey.name === key);
}

/**
 * Check if a cached entry is stale.
 */
export function isStale(entry: IsrCacheEntry): boolean {
  return Date.now() - entry.createdAt > entry.ttl * 1000;
}

/**
 * Build a Response from an ISR cache entry.
 */
export function isrCacheResponse(entry: IsrCacheEntry, stale: boolean): Response {
  const headers = new Headers(entry.headers);
  headers.set('x-isr-cache', stale ? 'STALE' : 'HIT');

  // Edge-cacheable: s-maxage controls CDN TTL based on remaining ISR freshness.
  // Browser always revalidates (max-age=0) so users see updates after edge expiry.
  if (stale) {
    // Stale: short edge TTL while background revalidation runs.
    // Cap at entry.ttl so short-TTL configs don't serve stale longer than their ISR window.
    const staleTtl = Math.min(10, entry.ttl);
    headers.set('Cache-Control', `public, s-maxage=${staleTtl}, max-age=0, must-revalidate`);
  } else {
    const remainingSeconds = Math.max(
      0,
      Math.floor((entry.createdAt + entry.ttl * 1000 - Date.now()) / 1000),
    );
    headers.set(
      'Cache-Control',
      `public, s-maxage=${remainingSeconds}, max-age=0, must-revalidate`,
    );
  }

  return new Response(entry.body, {
    status: entry.status,
    headers,
  });
}

/**
 * Read the `x-revalidate` header from a worker response.
 * Returns the override TTL, or null to use the default.
 * A value of 0 means "do not cache this response".
 */
export function resolveRevalidateTtl(response: Response, defaultTtl: number): number {
  const header = response.headers.get('x-revalidate');
  if (header === null) {
    return defaultTtl;
  }

  const value = parseInt(header, 10);
  if (isNaN(value) || value < 0) {
    return defaultTtl;
  }
  return value;
}

function acceptsEventStream(request: Request): boolean {
  return (
    request.headers
      .get('Accept')
      ?.toLowerCase()
      .split(',')
      .some((part) => part.split(';', 1)[0]?.trim() === 'text/event-stream') ?? false
  );
}

/**
 * ISR should be bypassed for requests with credentials and EventSource
 * requests. Pages protocol navigation (X-VoidPages) uses a separate JSON edge
 * cache.
 */
export function shouldBypassIsr(request: Request): boolean {
  return (
    request.headers.has('Cookie') ||
    request.headers.has('Authorization') ||
    acceptsEventStream(request)
  );
}

/**
 * Resolve the ISR TTL for a given pathname.
 * Accepts the `revalidate` config from the routing entry (number, object, or undefined).
 * For object form, first matching pattern wins.
 *
 * Uses `matchSegmentPattern` (not literal) because the folded flat `revalidate`
 * map also carries GENERATED page-pattern keys (`:slug`, `:path{.+}`) that must
 * param-match. Bounded known limitation (plan 0077): a user-authored key whose
 * segment STARTS with a literal colon (`/:batchGet`) is therefore matched as a
 * param (`^/[^/]+$`) and over-matches unrelated single-segment paths. Near-zero
 * reachability — a real colon-in-URL is MID-segment (`/v1/users:batchGet`) and
 * stays literal; a leading-`:` segment is not a real URL shape and is
 * undocumented (docs sanction literal paths + `*` globs only). Bounded by
 * `shouldBypassIsr`.
 */
export function resolvePathTtl(
  revalidate: number | Record<string, number> | undefined,
  pathname: string,
): number {
  if (revalidate == null) {
    return 0;
  }
  if (typeof revalidate === 'number') {
    return revalidate;
  }
  for (const [pattern, ttl] of Object.entries(revalidate)) {
    if (matchSegmentPattern(pattern, pathname)) {
      return ttl;
    }
  }
  return 0;
}

/**
 * Effective ISR TTL for a `pages` entry that ALREADY matched `pathname`,
 * decoding the 3-STATE table the framework's `collectPages` emits:
 *   - a baked number is authoritative — `> 0` = ISR on, `0` = an EXPLICIT
 *     opt-out (a per-page `export const revalidate = 0`, or a global-0 config);
 *   - an ABSENT `revalidate` is INHERIT-eligible — resolve the RAW per-path
 *     `pathRevalidate` OBJECT config against the ACTUAL path, so a per-path `0`
 *     opt-out (or a wildcard / exact rule) that a dynamic page pattern straddles
 *     is honored at the edge (build-time baking cannot — hence the split).
 * Keep in sync with `collectPages` (`packages/void/src/isr-config.ts`) and the api
 * prewarm mirror (`packages/api/src/routes/deploy.ts`).
 */
function matchedPageTtl(
  page: { pattern: string; revalidate?: number },
  pathRevalidate: Record<string, number> | undefined,
  pathname: string,
): number {
  if (page.revalidate === undefined) {
    return resolvePathTtl(pathRevalidate, pathname);
  }
  return page.revalidate > 0 ? page.revalidate : 0;
}

/**
 * Route-aware ISR TTL resolution. Iterates `pages` in the framework's
 * authoritative order (do NOT re-sort — it is already the order the worker's
 * own matchRoute resolves in) and first-matches via `matchSegmentPattern`, so
 * dispatch picks the SAME winning route the worker renders. The winner's TTL is
 * authoritative via `matchedPageTtl` (0 when it opts out; an inherit-eligible
 * winner resolves the per-path `pathRevalidate` object config). Only when NO
 * page route matches do we fall back to the flat `revalidate` map (user
 * void.json patterns). When `pages` is absent, behavior is identical to
 * `resolvePathTtl`.
 */
export function resolvePageTtl(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  revalidate: number | Record<string, number> | undefined,
  pathRevalidate: Record<string, number> | undefined,
  pathname: string,
): number {
  if (pages && pages.length > 0) {
    for (const page of pages) {
      if (matchSegmentPattern(page.pattern, pathname)) {
        return matchedPageTtl(page, pathRevalidate, pathname);
      }
    }
    return resolvePathTtl(revalidate, pathname);
  }
  return resolvePathTtl(revalidate, pathname);
}

/**
 * A pattern is LITERAL when it has no param (`:name`), regex (`{...}`), or
 * wildcard (`*`) marker — so `matchSegmentPattern` matches ONLY the exact path,
 * never an arbitrary one. Used by `matchesLiteralPage` (applied to the whole
 * pattern).
 */
export function isLiteralPattern(pattern: string): boolean {
  return !/[:{*]/.test(pattern);
}

/**
 * True iff `target` EXACTLY matches a declared LITERAL ISR page (positive TTL).
 * A literal page pattern matches exactly one path, so a match POSITIVELY
 * identifies the fallback target as that specific author-declared ISR page.
 * A catch-all (`/:path{.+}`) or param page (`/:slug`) is NOT literal and never
 * vouches — it matches arbitrary paths, so it cannot certify an arbitrary
 * fallback target as public page content.
 */
export function matchesLiteralPage(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  target: string,
  pathRevalidate: Record<string, number> | undefined,
): boolean {
  if (!pages) {
    return false;
  }
  for (const page of pages) {
    if (matchSegmentPattern(page.pattern, target)) {
      // First matching route WINS — mirror resolvePageTtl / the framework's
      // matchRoute order (0077's invariant: never re-order, never skip a matching
      // route). Authorize shared-caching of a fallback render only when that WINNING
      // route is an exact literal page with a positive effective TTL; a catch-all/param
      // winner means the framework renders this path dynamically, so it must NOT be
      // cached. `matchedPageTtl` resolves an inherit-eligible literal page against the
      // per-path config (a literal page maps to exactly one path — no straddle).
      return isLiteralPattern(page.pattern) && matchedPageTtl(page, pathRevalidate, target) > 0;
    }
  }
  return false;
}

/**
 * A pattern is a BROAD catch-all when it crosses segment boundaries — a named
 * catch-all `:name{.+}` (compiles to `.+`) or a `*` wildcard (compiles to `.*`).
 * Such a pattern matches ANY path, including genuine static assets, so it cannot
 * certify a dotted path as page ISR content. A single-segment param (`/blog/:slug`
 * → `[^/]+`) or a literal (`/feed.xml`) is NOT broad. See `pattern.ts`'s
 * catch-all syntax (`:[^/{}]+\{\.\+\}` and `*`).
 */
export function isBroadCatchAll(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('{.+}');
}

/**
 * A dotted request path is ISR page content (not a static asset) when it matches a
 * declared page route that is NOT a broad catch-all: a literal (`/feed.xml`) or a
 * single-segment param (`/blog/:slug`) that matches means the framework serves it
 * as that page, so `/blog/release.v2` gets ISR even though it has a dot. A broad
 * catch-all (`/:path{.+}`, `*`) matches everything including genuine static assets
 * (`/robots.txt`), so it does NOT make a dotted path ISR content. Mirrors
 * `resolvePageTtl`'s match order: pages first-match, then the flat map. A bare
 * global-NUMBER `revalidate` declares no pattern, so dotted paths under it are NOT
 * treated as ISR-eligible page content (documented narrow residual).
 */
export function isDottedPathIsrEligible(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  revalidate: number | Record<string, number> | undefined,
  pathRevalidate: Record<string, number> | undefined,
  pathname: string,
): boolean {
  if (pages && pages.length > 0) {
    for (const page of pages) {
      if (matchSegmentPattern(page.pattern, pathname)) {
        // `matchedPageTtl` resolves an inherit-eligible page against the per-path
        // config; a broad catch-all winner never certifies a dotted path as page
        // content (it also matches genuine static assets like `/robots.txt`).
        return matchedPageTtl(page, pathRevalidate, pathname) > 0 && !isBroadCatchAll(page.pattern);
      }
    }
    // no page matched → fall through to the flat map (mirror resolvePageTtl)
  }
  if (revalidate && typeof revalidate === 'object') {
    for (const [pattern, ttl] of Object.entries(revalidate)) {
      if (matchSegmentPattern(pattern, pathname)) {
        return ttl > 0 && !isBroadCatchAll(pattern);
      }
    }
  }
  return false;
}

export function normalizePageDataForJsonCache(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { deferred?: unknown; deferredKeys?: unknown };
    if (parsed.deferred !== undefined || parsed.deferredKeys !== undefined) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function extractPageDataFromHtml(html: string): string | null {
  const match = html.match(PAGE_DATA_SCRIPT_RE);
  if (!match) {
    return null;
  }
  return normalizePageDataForJsonCache(match[2]);
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
const SKIP_HEADERS = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

export function serializeHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

/**
 * Build a normalized cache key Request for the edge cache (caches.default).
 * The public URL stays clean; the internal cache key carries the deployment
 * id so a new deploy never reads HTML produced by an older deploy.
 *
 * When `originalUrl` is provided (the request was dispatch-rewritten), it is
 * mixed into the key so direct and rewritten requests to the same rewritten
 * pathname do not share a cache slot. See `isrCacheKey` for rationale.
 */
export function isrEdgeCacheKey(
  request: Request,
  pathname: string,
  deploymentId: string,
  originalUrl?: string | null,
): Request {
  return new Request(
    isrEdgeCacheUrl(new URL(request.url).hostname, pathname, deploymentId, 'html', originalUrl),
    { method: 'GET' },
  );
}

/**
 * Build an edge cache key for the JSON variant (pages protocol navigation).
 * Uses `?__void=json` plus the deployment id to separate it from both HTML
 * and JSON generated by other deployments. `originalUrl` is mixed in under
 * the same rules as `isrEdgeCacheKey`.
 */
export function isrEdgeCacheKeyJson(
  request: Request,
  pathname: string,
  deploymentId: string,
  originalUrl?: string | null,
): Request {
  return new Request(
    isrEdgeCacheUrl(new URL(request.url).hostname, pathname, deploymentId, 'json', originalUrl),
    { method: 'GET' },
  );
}
