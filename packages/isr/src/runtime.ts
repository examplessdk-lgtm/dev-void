import { matchSegmentPattern } from '@void/edge';
import {
  buildVariantOriginalUrl,
  decodeIsrCacheEntry,
  extractPageDataFromHtml,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  isFrameworkDocumentRequest,
  isSharedCacheableResponse,
  isrCacheResponse,
  isStale,
  normalizePageDataForJsonCache,
  packIsrValue,
  markSharedCachePolicy,
  resolvePageTtl,
  resolveRevalidateTtl,
  SHARED_CACHE_POLICY_VERSION,
  SHARED_CACHE_POLICY_HEADER,
  serializeHeaders,
  shouldBypassIsr,
  type IsrCacheEntry,
  type IsrCacheMetadata,
  type QueryAllowlist,
} from './core.ts';
import { isrCacheKey, isrCachePrefix, isrCacheVariantPrefix, isrEdgeCacheUrl } from './index.ts';

export {
  extractPageDataFromHtml,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  isSharedCacheableResponse,
  isrCacheResponse,
  isStale,
  normalizePageDataForJsonCache,
  packIsrValue,
  markSharedCachePolicy,
  resolvePathTtl,
  resolveRevalidateTtl,
  serializeHeaders,
  shouldBypassIsr,
  SHARED_CACHE_POLICY_HEADER,
  SHARED_CACHE_POLICY_VERSION,
  unpackIsrValue,
  type IsrCacheEntry,
  type IsrCacheMetadata,
} from './core.ts';
export { matchSegmentPattern as matchLiteralPattern };
export { canonicalIsrPathname, denormalizeIsrPath, normalizeIsrPath } from './index.ts';

/**
 * Single-tenant ISR (incremental static regeneration) cache ladder for the
 * direct Cloudflare Worker (Void apps and framework deploy wrappers).
 *
 * On managed Void, ISR lives in the dispatch worker that sits IN FRONT of the
 * user worker. Self-host has no dispatch worker, so this module ports that
 * caching ladder INTO the user worker, collapsed from multi-tenant to a single
 * deployment:
 *
 *   - No `projectId`, no cross-tenant metering.
 *   - No `#rw=` rewrite variant, no query-string variant fanout, no variant cap.
 *   - The deployment id is baked at build time as a compile-time literal and
 *     surfaced on `env.__VOID_ISR_DEPLOYMENT_ID`. The KV helpers read
 *     it from `env` (matching the `revalidate()` purge path in `runtime/isr.ts`),
 *     while `handleIsr` uses the `deploymentId` option for the edge-cache keys —
 *     the two are the same value.
 *
 * Fail-open contract: every `env.ISR_CACHE` (KV) and `caches.default` operation
 * is wrapped so a misconfigured or erroring cache degrades to a live render,
 * never a 500. Read/hit-path failures bail (caller renders live); write-path
 * failures are swallowed.
 *
 * Worker-only: no `lib.dom` types — globals come from `@cloudflare/workers-types`.
 *
 * Ported from the hosted dispatch runtime and the shared `@void/isr` contract.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal env surface this module needs. Both fields are optional so a worker
 * with no ISR binding (or a caller that only knows the deployment id) still
 * typechecks and fails open at runtime.
 */
export interface IsrCacheEnv {
  ISR_CACHE?: KVNamespace;
  __VOID_ISR_DEPLOYMENT_ID?: string;
}

/** Renders a live response for a request (worker dispatch + asset serving). */
export type RenderFn = (request: Request) => Promise<Response>;

export type HandleIsrOptions = Readonly<{
  revalidate: number | Record<string, number> | undefined;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  deploymentId: string;
  queryAllowlist?: QueryAllowlist;
}>;

export const MAX_ISR_VARIANTS_PER_PATH = 200;
// Match managed ISR: tolerate removal responses for 24 hours after expiry.
const ISR_STALE_EVICT_GRACE_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Collapsed single-tenant cache keys
// ---------------------------------------------------------------------------

const DIRECT_ISR_PROJECT_ID = '__void_direct__';

/** Prefix for the current direct deployment's host-scoped cache entries. */
export function isrPrefix(deploymentId: string): string {
  return isrCachePrefix(DIRECT_ISR_PROJECT_ID, deploymentId);
}

/**
 * KV cache key for an ISR-cached page. Deployment- AND host-scoped: cached HTML
 * cannot outlive the hashed assets of the deployment that produced it (a fresh
 * `wrangler deploy` mints a new deployment id → cold cache), and one host's
 * cached content never bleeds into another host served by the same worker
 * (custom domain + workers.dev, apex + www, etc.).
 */
export function isrKey(
  deploymentId: string,
  host: string,
  pathname: string,
  variantUrl?: string | null,
): string {
  return isrCacheKey(DIRECT_ISR_PROJECT_ID, deploymentId, host, pathname, variantUrl);
}

export function isrVariantPrefix(deploymentId: string, host: string, pathname: string): string {
  return isrCacheVariantPrefix(DIRECT_ISR_PROJECT_ID, deploymentId, host, pathname);
}

/**
 * Host-registry key. Every host that has written cached content registers itself
 * under `void-isr-hosts/<id>/<host>` (value `''`) so a purge with no request host
 * (cron / queue `revalidate({ paths })`) can enumerate the hosts to purge.
 * Scoped by deployment id so registrations from an old deploy do not leak.
 */
export function hostRegistryKey(deploymentId: string, host: string): string {
  return `void-isr-hosts/${deploymentId}/${host}`;
}

/**
 * Edge-cache (`caches.default`) key for the HTML variant. The public URL stays
 * clean; this internal key carries the deployment id so a new deploy never
 * reads HTML produced by an older deploy.
 */
export function htmlEdgeKey(
  host: string,
  pathname: string,
  id: string,
  variantUrl?: string | null,
): string {
  return isrEdgeCacheUrl(host, pathname, id, 'html', variantUrl);
}

/**
 * Edge-cache key for the JSON (pages-protocol) variant. Separated from HTML by
 * the `&__void=json` marker.
 */
export function jsonEdgeKey(
  host: string,
  pathname: string,
  id: string,
  variantUrl?: string | null,
): string {
  return isrEdgeCacheUrl(host, pathname, id, 'json', variantUrl);
}

// ---------------------------------------------------------------------------
// KV cache (single-tenant; fail-open on every ISR_CACHE op)
// ---------------------------------------------------------------------------

/**
 * Read an ISR cache entry from KV. Returns null on cache miss, malformed
 * metadata, or ANY KV error (fail-open → caller renders live). The KV key is
 * deployment-scoped via `env.__VOID_ISR_DEPLOYMENT_ID` (see module header) and
 * host-scoped via `host` so one host never reads another host's cached bytes.
 */
export async function readIsrCache(
  env: IsrCacheEnv,
  host: string,
  pathname: string,
  variantUrl?: string | null,
): Promise<IsrCacheEntry | null> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return null;
  }
  const key = isrKey(env.__VOID_ISR_DEPLOYMENT_ID ?? '', host, pathname, variantUrl);
  let value: ArrayBuffer | null;
  let metadata: IsrCacheMetadata | null;
  try {
    const result = await kv.getWithMetadata<IsrCacheMetadata>(key, 'arrayBuffer');
    value = result.value;
    metadata = result.metadata;
  } catch {
    // Fail open — a broken ISR_CACHE must degrade to a live render, never 500.
    return null;
  }
  return decodeIsrCacheEntry(value, metadata);
}

/**
 * Write an ISR cache entry to KV. The `response.clone()` is taken SYNCHRONOUSLY
 * before any `await` so a caller that consumes `response.body` for the client
 * response (after kicking us off via `ctx.waitUntil`) cannot race the body
 * away. Any KV error is swallowed (fail-open on the write path).
 */
export async function writeIsrCache(
  env: IsrCacheEnv,
  host: string,
  pathname: string,
  response: Response,
  ttl: number,
  variantUrl?: string | null,
): Promise<void> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return;
  }
  const responseClone = response.clone();
  const headers = serializeHeaders(responseClone);
  const status = responseClone.status;

  const id = env.__VOID_ISR_DEPLOYMENT_ID ?? '';
  try {
    const key = isrKey(id, host, pathname, variantUrl);
    if (variantUrl && !(await isVariantWriteAllowed(kv, id, host, pathname, key))) {
      await registerIsrHost(kv, id, host);
      return;
    }
    const body = await responseClone.arrayBuffer();
    const packed = packIsrValue(headers, body);
    await kv.put(key, packed, {
      metadata: {
        s: status,
        c: Date.now(),
        t: ttl,
        p: SHARED_CACHE_POLICY_VERSION,
      } satisfies IsrCacheMetadata,
    });
  } catch {
    // Fail open — swallow write errors so a broken ISR_CACHE never 500s.
  }
  // Register this host so a host-less purge (cron / queue) can find it. Guarded
  // by an in-isolate Set so it costs one KV write per (isolate, id, host), not
  // one per page write. Fail-open — a registry write error never 500s a render.
  await registerIsrHost(kv, id, host);
}

async function isVariantWriteAllowed(
  kv: KVNamespace,
  deploymentId: string,
  host: string,
  pathname: string,
  key: string,
): Promise<boolean> {
  const listed = await kv.list({
    prefix: isrVariantPrefix(deploymentId, host, pathname),
    limit: 1000,
  });
  return (
    listed.keys.length < MAX_ISR_VARIANTS_PER_PATH ||
    listed.keys.some((entry) => entry.name === key)
  );
}

/**
 * In-isolate guard: `${id}/${host}` values whose host-registry key this isolate
 * has already written (or attempted). Bounds host registration to ~one KV write
 * per (isolate, deployment, host) instead of one per page write.
 */
const registeredHosts = new Set<string>();

async function registerIsrHost(kv: KVNamespace, deploymentId: string, host: string): Promise<void> {
  const guardKey = `${deploymentId}/${host}`;
  if (registeredHosts.has(guardKey)) {
    return;
  }
  // Mark BEFORE the await so concurrent page writes in this isolate don't all
  // fire the registry put. On failure, CLEAR the guard so a later write in this
  // same (possibly long-lived) isolate retries — otherwise one transient error
  // would permanently drop this host from `listIsrHosts()`, and a cron/queue
  // `revalidate()` (which has no request host) could never purge it.
  registeredHosts.add(guardKey);
  try {
    await kv.put(hostRegistryKey(deploymentId, host), '');
  } catch {
    // Fail open — a registry write failure must never 500 a page render — but
    // allow a retry on a subsequent write instead of skipping this host forever.
    registeredHosts.delete(guardKey);
  }
}

/**
 * List every host that has registered cached content for a deployment. Used by
 * the on-demand `revalidate({ paths })` purge when there is no request host
 * (cron / queue). Fail-open: a registry read error yields the hosts collected so
 * far (or none) rather than throwing — degraded purge coverage, never a 500.
 */
export async function listIsrHosts(kv: KVNamespace, deploymentId: string): Promise<Array<string>> {
  const prefix = `void-isr-hosts/${deploymentId}/`;
  const hosts: Array<string> = [];
  try {
    let cursor: string | undefined;
    do {
      const list = await kv.list({ prefix, cursor });
      for (const key of list.keys) {
        hosts.push(key.name.slice(prefix.length));
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  } catch {
    // Fail open — a broken registry degrades purge coverage, never throws.
  }
  return hosts;
}

/**
 * Delete an ISR cache entry from KV. Used when a worker permanently opts out
 * via `x-revalidate: 0`. Any KV error is swallowed (fail-open).
 */
export async function deleteIsrCache(
  env: IsrCacheEnv,
  host: string,
  pathname: string,
  variantUrl?: string | null,
): Promise<void> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return;
  }
  try {
    await kv.delete(isrKey(env.__VOID_ISR_DEPLOYMENT_ID ?? '', host, pathname, variantUrl));
  } catch {
    // Fail open.
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

const CLIENT_REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export function clientRevalidateResponse(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
  res.headers.delete(SHARED_CACHE_POLICY_HEADER);
  return res;
}

function mediaType(response: Response): string | undefined {
  return response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim();
}

export function isEventStreamResponse(response: Response): boolean {
  return mediaType(response) === 'text/event-stream';
}

function isHtmlResponse(response: Response): boolean {
  return mediaType(response) === 'text/html';
}

/** Whether a fresh render may be written to the shared KV and edge caches. */
function isStorableRender(response: Response, ttl: number, htmlOnly: boolean): boolean {
  return ttl > 0 && isSharedCacheableResponse(response) && (!htmlOnly || isHtmlResponse(response));
}

/** Whether a successful render opts out of sharing, so cached copies must go. */
function isUncacheableRender(response: Response, ttl: number, htmlOnly: boolean): boolean {
  return (
    response.status === 200 &&
    (ttl === 0 || hasSharedCacheOptOut(response) || (htmlOnly && !isHtmlResponse(response)))
  );
}

/** Headers for a shared HTML cache copy, without ISR-managed or private headers. */
function sharedHtmlCacheHeaders(response: Response, ttl: number, state: 'HIT' | 'MISS'): Headers {
  const headers = new Headers(response.headers);
  headers.set('x-isr-cache', state);
  headers.set('Cache-Control', `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
  markSharedCachePolicy(headers);
  headers.delete('set-cookie');
  headers.delete('x-void-page-data');
  return headers;
}

function jsonCacheResponse(pageData: string, ttl: number, state: 'HIT' | 'MISS'): Response {
  const response = new Response(pageData, {
    headers: {
      'content-type': 'application/json',
      // Mirror the live JSON responder `pageJsonResponse` (pages/protocol.ts):
      // it stamps `X-VoidPages: true` + `Vary: X-VoidPages`. The Pages client
      // gates JSON parsing on `X-VoidPages` (navigation-engine.ts) — a cached
      // JSON variant served on a later navigation without it is treated as
      // non-JSON and hard-reloads the whole page. Keep name/value/casing exact.
      'X-VoidPages': 'true',
      Vary: 'X-VoidPages',
      'Cache-Control': `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
      'x-isr-cache': state,
    },
  });
  markSharedCachePolicy(response.headers);
  return response;
}

/**
 * Populate the JSON edge cache from a response's embedded page data (the
 * `x-void-page-data` header or the `__VOID_PAGE_DATA__` inline script). No-ops
 * when there is no extractable page data. Any cache error is swallowed
 * (fail-open) so this is always safe to fire inside `ctx.waitUntil`.
 */
export async function populateJsonEdgeCache(
  cache: Cache | undefined,
  cacheKey: string,
  response: Response,
  ttl: number,
  state: 'HIT' | 'MISS',
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    const fromHeader = response.headers.get('x-void-page-data');
    const pageData = fromHeader
      ? normalizePageDataForJsonCache(fromHeader)
      : extractPageDataFromHtml(await response.clone().text());
    if (!pageData) {
      return;
    }
    await cache.put(cacheKey, jsonCacheResponse(pageData, ttl, state));
  } catch {
    // Fail open — a broken edge cache must never 500.
  }
}

// ---------------------------------------------------------------------------
// Fail-open edge-cache wrappers
// ---------------------------------------------------------------------------

/**
 * The per-colo edge cache (`caches.default`), or `undefined` when the Cache API
 * is absent/degraded. Accessed through a cast because this package has both
 * `@types/node` and `@cloudflare/workers-types` in scope, and Node's ambient
 * `CacheStorage` (which lacks `.default`) otherwise shadows the Workers one on
 * the `caches` global.
 *
 * Non-throwing by contract: dereferencing `caches.default` can throw if the
 * Cache API is missing (e.g. a non-worker runtime) or degraded. We swallow that
 * here and return `undefined` so `handleIsr` never rejects before its fail-open
 * guards run — the serving invariant is a degraded cache must render live, never
 * 500. Every call site guards `undefined` (via `if (!cache)` or `cache?.`).
 */
function edgeCache(): Cache | undefined {
  try {
    return (caches as unknown as { default: Cache }).default;
  } catch {
    return undefined;
  }
}

async function safeCachePut(
  cache: Cache | undefined,
  key: string,
  response: Response,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, response);
  } catch {
    // Fail open.
  }
}

async function safeCacheDelete(cache: Cache | undefined, key: string): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.delete(key);
  } catch {
    // Fail open.
  }
}

async function deleteSharedIsrVariants(
  env: IsrCacheEnv,
  cache: Cache | undefined,
  host: string,
  pathname: string,
  keys: { htmlKey: string; jsonKey: string },
  variantUrl: string | null,
): Promise<void> {
  await deleteIsrCache(env, host, pathname, variantUrl);
  await safeCacheDelete(cache, keys.htmlKey);
  await safeCacheDelete(cache, keys.jsonKey);
}

// ---------------------------------------------------------------------------
// Background revalidation (single-tenant: re-renders through `render`)
// ---------------------------------------------------------------------------

/**
 * Build a new Request with the `X-VoidPages` header removed. Headers on an
 * existing Request are immutable, so we must clone into a fresh Request. ISR
 * only runs for GET, so there is no body to preserve.
 */
export function cloneWithoutVoidPages(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('X-VoidPages');
  // Construct from the Request OBJECT (not a string URL): workerd copies the
  // `cf` blob from the input Request, so `request.cf` is preserved on the clone.
  // Do not "simplify" this into `new Request(request.url, { headers })` — the
  // string-URL form drops `cf`.
  return new Request(request, { headers });
}

/**
 * Revalidate an ISR page in the background. Re-renders as HTML (X-VoidPages
 * stripped), writes fresh HTML to KV + HTML edge cache, and populates the JSON
 * edge cache from embedded page data. Errors are caught and logged — serve
 * stale, don't retry. An explicit cache opt-out (including `ttl === 0`)
 * deletes the KV entry and both edge variants.
 */
async function revalidateInBackground(
  env: IsrCacheEnv,
  request: Request,
  host: string,
  pathname: string,
  defaultTtl: number,
  keys: { htmlKey: string; jsonKey: string },
  render: RenderFn,
  variantUrl: string | null,
  htmlOnly: boolean,
  staleSinceMs: number,
): Promise<void> {
  try {
    const cleanRequest = cloneWithoutVoidPages(request);
    const response = await render(cleanRequest);
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = edgeCache();
    if (response.status === 200 && isEventStreamResponse(response)) {
      if (isUncacheableRender(response, ttl, false)) {
        await deleteSharedIsrVariants(env, cache, host, pathname, keys, variantUrl);
      }
      return;
    }
    if (isStorableRender(response, ttl, htmlOnly)) {
      await writeIsrCache(env, host, pathname, response, ttl, variantUrl);
      await safeCachePut(
        cache,
        keys.htmlKey,
        new Response(response.clone().body, {
          status: response.status,
          headers: sharedHtmlCacheHeaders(response, ttl, 'HIT'),
        }),
      );
      await populateJsonEdgeCache(cache, keys.jsonKey, response, ttl, 'HIT');
    } else if (
      isUncacheableRender(response, ttl, htmlOnly) ||
      ((response.status === 404 || response.status === 410) &&
        Date.now() - staleSinceMs > ISR_STALE_EVICT_GRACE_MS)
    ) {
      // Preserve the last good render during transient failures. Confirmed
      // removals converge after the grace measured from expiry, not creation.
      await deleteSharedIsrVariants(env, cache, host, pathname, keys, variantUrl);
    }
  } catch (err) {
    console.error('ISR revalidation failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Cache only framework document HTML; leave client data requests and other response types live. */
export async function handleFrameworkIsr(
  request: Request,
  env: IsrCacheEnv,
  ctx: ExecutionContext,
  options: HandleIsrOptions,
  render: RenderFn,
): Promise<Response | null> {
  if (!isFrameworkDocumentRequest(request)) {
    return null;
  }
  return handleIsrInternal(request, env, ctx, options, render, true);
}

/**
 * Run the ISR caching ladder for a request.
 *
 * Returns a cached/rendered `Response` when ISR applies, or `null` when the
 * caller should render live itself (request not ISR-eligible, or a read/hit
 * cache op failed open).
 *
 * Ladder:
 *   - Bail (`null`) if not GET, an API path, a Range request, `shouldBypassIsr`,
 *     or the path has no ISR TTL. Range requests bail BEFORE any cache read/write so they
 *     render live (correct 206) and never touch the shared full-response entry.
 *   - JSON (X-VoidPages) path: edge match → hit serves `clientRevalidateResponse`;
 *     miss renders live JSON and returns it — the JSON path never writes the edge
 *     cache. The JSON edge variant is warmed only as a side-effect of the HTML
 *     render path (cold colo re-renders JSON).
 *   - HTML path: L1 edge match → L2 KV. Hit serves `isrCacheResponse`
 *     (stale hits also queue a background revalidation). Miss renders live and,
 *     when cacheable, writes KV + JSON edge + HTML edge in the background.
 */
export async function handleIsr(
  request: Request,
  env: IsrCacheEnv,
  ctx: ExecutionContext,
  options: HandleIsrOptions,
  render: RenderFn,
): Promise<Response | null> {
  return handleIsrInternal(request, env, ctx, options, render, false);
}

async function handleIsrInternal(
  request: Request,
  env: IsrCacheEnv,
  ctx: ExecutionContext,
  options: HandleIsrOptions,
  render: RenderFn,
  htmlOnly: boolean,
): Promise<Response | null> {
  const { revalidate, pages, pathRevalidate, deploymentId, queryAllowlist } = options;

  if (request.method !== 'GET') {
    return null;
  }
  // Range requests must render LIVE so the origin produces a correct partial
  // response (`206 Partial Content`) for the requested byte range. They must
  // never read or write the shared ISR entry: reading would serve a full-body
  // entry for a partial request, and writing would poison the shared (host,path)
  // key with a truncated 206 that a later full request would then be served.
  // Return null here (→ caller renders live) BEFORE any cache read or write.
  if (request.headers.has('range')) {
    return null;
  }
  if (shouldBypassIsr(request)) {
    return null;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return null;
  }
  const isrTtl = resolvePageTtl(pages, revalidate, pathRevalidate, pathname);
  if (isrTtl <= 0) {
    return null;
  }

  // Keep the KV helpers (which derive the deployment id from env — matching the
  // `revalidate()` purge path) aligned with the edge keys built here. The worker
  // entry usually sets this already; the `??=` covers callers that only pass
  // the option.
  env.__VOID_ISR_DEPLOYMENT_ID ??= deploymentId;

  const host = url.hostname;
  const normalizedVariantUrl = buildVariantOriginalUrl(request.url, pathname, queryAllowlist);
  const variantUrl = new URL(normalizedVariantUrl).search ? normalizedVariantUrl : null;
  const cache = edgeCache();
  const htmlKey = htmlEdgeKey(host, pathname, deploymentId, variantUrl);
  const jsonKey = jsonEdgeKey(host, pathname, deploymentId, variantUrl);

  // Pages protocol: JSON edge cache only (cold colo re-renders JSON).
  if (request.headers.has('X-VoidPages')) {
    let jsonCached: Response | undefined;
    try {
      // `cache?.` — an absent/degraded Cache API (edgeCache() → undefined) is a
      // miss, not a throw, so we fall through to a live JSON render.
      jsonCached = await cache?.match(jsonKey);
    } catch {
      return null; // fail open → caller renders live
    }
    if (jsonCached && hasCurrentSharedCachePolicy(jsonCached)) {
      return clientRevalidateResponse(jsonCached);
    }
    if (jsonCached) {
      await safeCacheDelete(cache, jsonKey);
    }
    // Miss — render live JSON and return it. The JSON path never writes the edge
    // cache: a pages-protocol JSON response carries no embedded page data, so the
    // JSON edge variant is warmed only as a side-effect of the HTML render path
    // (cold colo re-renders JSON). Matches the platform dispatch behavior.
    const response = await render(request);
    const ttl = resolveRevalidateTtl(response, isrTtl);
    if (isUncacheableRender(response, ttl, false)) {
      ctx.waitUntil(
        deleteSharedIsrVariants(env, cache, host, pathname, { htmlKey, jsonKey }, variantUrl),
      );
    }
    return response;
  }

  // HTML path: L1 edge → L2 KV → live render.

  // L1: edge cache (per-colo, sub-ms).
  let edgeCached: Response | undefined;
  try {
    // `cache?.` — an absent/degraded Cache API (edgeCache() → undefined) is an
    // L1 miss, not a throw, so we fall through to the L2 KV read below (KV still
    // serves cached content even with no per-colo edge cache).
    edgeCached = await cache?.match(htmlKey);
  } catch {
    return null; // fail open → caller renders live
  }
  if (edgeCached && hasCurrentSharedCachePolicy(edgeCached)) {
    return clientRevalidateResponse(edgeCached);
  }
  if (edgeCached) {
    await safeCacheDelete(cache, htmlKey);
  }

  // L2: KV (global, authoritative). `readIsrCache` fails open to null.
  const cached = await readIsrCache(env, host, pathname, variantUrl);
  if (cached) {
    // Belt-and-suspenders: `readIsrCache` already validates the entry so the
    // Response constructors below can't throw, but the never-500 fail-open
    // contract must hold even if a future change slips a throwable past that
    // choke point. On any throw, fall open (null → caller renders live).
    try {
      const stale = isStale(cached);
      if (stale) {
        ctx.waitUntil(
          revalidateInBackground(
            env,
            request,
            host,
            pathname,
            isrTtl,
            { htmlKey, jsonKey },
            render,
            variantUrl,
            htmlOnly,
            cached.createdAt + cached.ttl * 1000,
          ),
        );
      }
      const cacheResponse = isrCacheResponse(cached, stale);
      // A stale entry is being replaced or evicted by revalidation. Warming it
      // concurrently can race an authoritative private/no-store response and
      // restore stale public HTML after that response deletes the cache.
      if (!stale) {
        ctx.waitUntil(safeCachePut(cache, htmlKey, cacheResponse.clone()));
      }
      return clientRevalidateResponse(cacheResponse);
    } catch {
      return null; // fail open → caller renders live
    }
  }

  // Miss: render live, cache in the background (only when cacheable).
  const response = await render(request);
  if (isEventStreamResponse(response)) {
    return response;
  }
  const ttl = resolveRevalidateTtl(response, isrTtl);
  if (isStorableRender(response, ttl, htmlOnly)) {
    // Every clone below is taken synchronously (before `response.body` is read
    // for the client) so no consumer races the body away.
    ctx.waitUntil(writeIsrCache(env, host, pathname, response, ttl, variantUrl));
    ctx.waitUntil(populateJsonEdgeCache(cache, jsonKey, response, ttl, 'HIT'));

    const cacheResponse = new Response(response.clone().body, {
      status: response.status,
      headers: sharedHtmlCacheHeaders(response, ttl, 'HIT'),
    });
    ctx.waitUntil(safeCachePut(cache, htmlKey, cacheResponse));

    const clientHeaders = sharedHtmlCacheHeaders(response, ttl, 'MISS');
    clientHeaders.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
    clientHeaders.delete(SHARED_CACHE_POLICY_HEADER);
    return new Response(response.body, {
      status: response.status,
      headers: clientHeaders,
    });
  }
  if (isUncacheableRender(response, ttl, htmlOnly)) {
    ctx.waitUntil(
      deleteSharedIsrVariants(env, cache, host, pathname, { htmlKey, jsonKey }, variantUrl),
    );
  }
  return response;
}
