/**
 * Single-tenant ISR (incremental static regeneration) cache ladder for the
 * self-hosted Void worker (`vite build && wrangler deploy`).
 *
 * On managed Void, ISR lives in the dispatch worker that sits IN FRONT of the
 * user worker. Self-host has no dispatch worker, so this module ports that
 * caching ladder INTO the user worker, collapsed from multi-tenant to a single
 * deployment:
 *
 *   - No `projectId`, no cross-tenant metering.
 *   - No `#rw=` rewrite variant, no query-string variant fanout, no variant cap.
 *   - The deployment id is baked at build time as a compile-time literal and
 *     surfaced on `env.__VOID_ISR_DEPLOYMENT_ID` (Task 7). The KV helpers read
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
 * Ported from `void-platform/packages/dispatch` (`isr.ts`, `index.ts`,
 * `pattern.ts`) and `void-platform/packages/isr-shared`.
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

export type IsrCacheEntry = Readonly<{
  body: ReadableStream;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number;
}>;

export type IsrCacheMetadata = Readonly<{
  /** HTTP status code */
  s: number;
  /** createdAt (ms) */
  c: number;
  /** TTL (seconds) */
  t: number;
}>;

/** Renders a live response for a request (worker dispatch + asset serving). */
export type RenderFn = (request: Request) => Promise<Response>;

export type HandleIsrOptions = Readonly<{
  revalidate: number | Record<string, number> | undefined;
  deploymentId: string;
}>;

// ---------------------------------------------------------------------------
// Path normalization (ported from isr-shared/src/index.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Collapsed single-tenant cache keys
// ---------------------------------------------------------------------------

/**
 * KV cache key for an ISR-cached page. Deployment- AND host-scoped: cached HTML
 * cannot outlive the hashed assets of the deployment that produced it (a fresh
 * `wrangler deploy` mints a new deployment id → cold cache), and one host's
 * cached content never bleeds into another host served by the same worker
 * (custom domain + workers.dev, apex + www, etc.).
 */
export function isrKey(deploymentId: string, host: string, pathname: string): string {
  return `void-isr/${deploymentId}/${host}/${normalizeIsrPath(pathname)}`;
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
export function htmlEdgeKey(host: string, pathname: string, id: string): string {
  return `https://${host}${canonicalIsrPathname(pathname)}?__void_isr=${id}`;
}

/**
 * Edge-cache key for the JSON (pages-protocol) variant. Separated from HTML by
 * the `&__void=json` marker.
 */
export function jsonEdgeKey(host: string, pathname: string, id: string): string {
  return `${htmlEdgeKey(host, pathname, id)}&__void=json`;
}

// ---------------------------------------------------------------------------
// Literal path-pattern matching + LRU (ported from dispatch/src/pattern.ts)
// ---------------------------------------------------------------------------

const MAX_CACHE = 256;
const literalRegexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname using LITERAL semantics — no named
 * captures. Two wildcards are special: `*` matches any characters INCLUDING `/`
 * (a splat), and a WHOLE-segment `:name` (preceded by `/` or start, followed by
 * `/` or end) matches exactly ONE path segment (`[^/]+`). A mid-segment literal
 * `:` (e.g. `/api/v1:health`) is left alone. This is a strict SUPERSET of the
 * old `*`-only matcher (old `*`-only manifests match identically). Malformed
 * patterns yield `false` rather than throwing.
 */
export function matchLiteralPattern(pattern: string, pathname: string): boolean {
  let regex = literalRegexCache.get(pattern);
  if (regex) {
    // LRU touch — re-inserting moves the entry to the most-recently-used end.
    literalRegexCache.delete(pattern);
    literalRegexCache.set(pattern, regex);
  } else {
    try {
      const escaped = pattern
        .replace(/(^|\/):[A-Za-z0-9_]+(?=\/|$)/g, '$1') // whole-segment :name -> sentinel
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
        .replaceAll('*', '.*') // catch-all crosses '/'
        .replaceAll('', '[^/]+'); // sentinel -> single segment
      regex = new RegExp(`^${escaped}$`);
    } catch {
      return false;
    }
    if (literalRegexCache.size >= MAX_CACHE) {
      const first = literalRegexCache.keys().next();
      if (!first.done) {
        literalRegexCache.delete(first.value);
      }
    }
    literalRegexCache.set(pattern, regex);
  }
  try {
    return regex.test(pathname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pack / unpack (ported verbatim from dispatch/src/isr.ts)
// ---------------------------------------------------------------------------

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
): Promise<IsrCacheEntry | null> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return null;
  }
  const key = isrKey(env.__VOID_ISR_DEPLOYMENT_ID ?? '', host, pathname);
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
  if (!value || !metadata) {
    return null;
  }

  const unpacked = unpackIsrValue(value);
  if (!unpacked) {
    return null;
  }

  // Validate at this single choke point so `isrCacheResponse` — the only consumer
  // of the returned entry — can never throw when it builds a Response from it. A
  // corrupt/tampered/schema-drifted KV entry degrades to a live render, never 500.

  // Status must be an integer in the valid HTTP Response range; otherwise
  // `new Response(body, { status })` throws.
  if (!Number.isInteger(metadata.s) || metadata.s < 200 || metadata.s > 599) {
    return null;
  }
  // createdAt (ms) and TTL (s) must be finite positive numbers — rejects
  // NaN/Infinity/<=0 (tightens the previous truthy-only check).
  if (
    !Number.isFinite(metadata.c) ||
    metadata.c <= 0 ||
    !Number.isFinite(metadata.t) ||
    metadata.t <= 0
  ) {
    return null;
  }
  // Headers must be constructible; an invalid header name/value would otherwise
  // throw later in `isrCacheResponse`'s `new Headers(entry.headers)`.
  try {
    new Headers(unpacked.headers);
  } catch {
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
): Promise<void> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return;
  }
  // Clone synchronously (no await before this) — the clone has its own
  // independent body; the original is free to be consumed elsewhere.
  const responseClone = response.clone();
  const headers = serializeHeaders(responseClone);
  const status = responseClone.status;

  const id = env.__VOID_ISR_DEPLOYMENT_ID ?? '';
  try {
    const body = await responseClone.arrayBuffer();
    const packed = packIsrValue(headers, body);
    await kv.put(isrKey(id, host, pathname), packed, {
      metadata: {
        s: status,
        c: Date.now(),
        t: ttl,
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
): Promise<void> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return;
  }
  try {
    await kv.delete(isrKey(env.__VOID_ISR_DEPLOYMENT_ID ?? '', host, pathname));
  } catch {
    // Fail open.
  }
}

// ---------------------------------------------------------------------------
// Cache-entry helpers (ported verbatim from dispatch/src/isr.ts)
// ---------------------------------------------------------------------------

/** Check if a cached entry is stale. */
export function isStale(entry: IsrCacheEntry): boolean {
  return Date.now() - entry.createdAt > entry.ttl * 1000;
}

/** Build a Response from an ISR cache entry. */
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
 * Returns the override TTL, or the default. A value of 0 means "do not cache".
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
 * Accepts the `revalidate` config (number, object, or undefined). For the
 * object form, the first matching pattern wins.
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
    if (matchLiteralPattern(pattern, pathname)) {
      return ttl;
    }
  }
  return 0;
}

/** Extract response headers as a plain object, skipping ISR-managed headers. */
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

// ---------------------------------------------------------------------------
// Page-data extraction for the JSON edge variant (ported from dispatch/src/isr.ts)
// ---------------------------------------------------------------------------

const PAGE_DATA_SCRIPT_RE =
  /<script\b[^>]*\bid=(["'])__VOID_PAGE_DATA__\1[^>]*>([\s\S]*?)<\/script>/i;

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
  return normalizePageDataForJsonCache(match[2]!);
}

// ---------------------------------------------------------------------------
// Response builders (ported from dispatch/src/index.ts:61–101)
// ---------------------------------------------------------------------------

const CLIENT_REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export function clientRevalidateResponse(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
  return res;
}

export function isEventStreamResponse(response: Response): boolean {
  return (
    response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim() ===
    'text/event-stream'
  );
}

function jsonCacheResponse(pageData: string, ttl: number, state: 'HIT' | 'MISS'): Response {
  return new Response(pageData, {
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

// ---------------------------------------------------------------------------
// Background revalidation (ported from dispatch/src/index.ts:1206–1295,
// stripped of getWorker / applyWorkerFallbackRules / maybeServeWfpAssetFallback
// / rebuildRequest — single-tenant re-renders through the `render` closure)
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
 * stale, don't retry. `ttl === 0` means the worker permanently opted out:
 * delete the KV entry and both edge variants.
 */
async function revalidateInBackground(
  env: IsrCacheEnv,
  request: Request,
  host: string,
  pathname: string,
  defaultTtl: number,
  keys: { htmlKey: string; jsonKey: string },
  render: RenderFn,
): Promise<void> {
  try {
    const cleanRequest = cloneWithoutVoidPages(request);
    const response = await render(cleanRequest);
    if (isEventStreamResponse(response)) {
      return;
    }
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = edgeCache();
    if (ttl > 0 && response.status === 200) {
      await writeIsrCache(env, host, pathname, response, ttl);
      // Update HTML edge cache with the fresh response.
      const headers = new Headers(response.headers);
      headers.set('x-isr-cache', 'HIT');
      headers.set('Cache-Control', `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
      headers.delete('set-cookie');
      headers.delete('x-void-page-data');
      await safeCachePut(
        cache,
        keys.htmlKey,
        new Response(response.clone().body, {
          status: response.status,
          headers,
        }),
      );
      await populateJsonEdgeCache(cache, keys.jsonKey, response, ttl, 'HIT');
    } else if (ttl === 0) {
      // Worker permanently opted out — remove KV + both edge variants.
      await deleteIsrCache(env, host, pathname);
      await safeCacheDelete(cache, keys.htmlKey);
      await safeCacheDelete(cache, keys.jsonKey);
    }
  } catch (err) {
    console.error('ISR revalidation failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the ISR caching ladder for a request.
 *
 * Returns a cached/rendered `Response` when ISR applies, or `null` when the
 * caller should render live itself (request not ISR-eligible, or a read/hit
 * cache op failed open).
 *
 * Ladder:
 *   - Bail (`null`) if not GET, a Range request, `shouldBypassIsr`, or the path
 *     has no ISR TTL. Range requests bail BEFORE any cache read/write so they
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
  const { revalidate, deploymentId } = options;

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
  const isrTtl = resolvePathTtl(revalidate, pathname);
  if (isrTtl <= 0) {
    return null;
  }

  // Keep the KV helpers (which derive the deployment id from env — matching the
  // `revalidate()` purge path) aligned with the edge keys built here. Task 7
  // already sets this at the top of the fetch handler; the `??=` makes the
  // module correct in isolation when a caller only passes the option.
  env.__VOID_ISR_DEPLOYMENT_ID ??= deploymentId;

  const host = url.hostname;
  const cache = edgeCache();

  // Pages protocol: JSON edge cache only (cold colo re-renders JSON).
  if (request.headers.has('X-VoidPages')) {
    const jsonKey = jsonEdgeKey(host, pathname, deploymentId);
    let jsonCached: Response | undefined;
    try {
      // `cache?.` — an absent/degraded Cache API (edgeCache() → undefined) is a
      // miss, not a throw, so we fall through to a live JSON render.
      jsonCached = await cache?.match(jsonKey);
    } catch {
      return null; // fail open → caller renders live
    }
    if (jsonCached) {
      return clientRevalidateResponse(jsonCached);
    }
    // Miss — render live JSON and return it. The JSON path never writes the edge
    // cache: a pages-protocol JSON response carries no embedded page data, so the
    // JSON edge variant is warmed only as a side-effect of the HTML render path
    // (cold colo re-renders JSON). Matches the platform dispatch behavior.
    return render(request);
  }

  // HTML path: L1 edge → L2 KV → live render.
  const htmlKey = htmlEdgeKey(host, pathname, deploymentId);
  const jsonKey = jsonEdgeKey(host, pathname, deploymentId);

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
  if (edgeCached) {
    return clientRevalidateResponse(edgeCached);
  }

  // L2: KV (global, authoritative). `readIsrCache` fails open to null.
  const cached = await readIsrCache(env, host, pathname);
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
          ),
        );
      }
      const cacheResponse = isrCacheResponse(cached, stale);
      // Warm the edge cache from KV; client consumes the original body.
      ctx.waitUntil(safeCachePut(cache, htmlKey, cacheResponse.clone()));
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
  if (ttl > 0 && response.status === 200) {
    // Every clone below is taken synchronously (before `response.body` is read
    // for the client) so no consumer races the body away.
    ctx.waitUntil(writeIsrCache(env, host, pathname, response, ttl));
    ctx.waitUntil(populateJsonEdgeCache(cache, jsonKey, response, ttl, 'MISS'));

    const cacheHeaders = new Headers(response.headers);
    cacheHeaders.set('Cache-Control', `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
    cacheHeaders.set('x-isr-cache', 'MISS');
    cacheHeaders.delete('x-void-page-data');
    cacheHeaders.delete('set-cookie');
    const cacheResponse = new Response(response.clone().body, {
      status: response.status,
      headers: cacheHeaders,
    });
    ctx.waitUntil(safeCachePut(cache, htmlKey, cacheResponse));

    const clientHeaders = new Headers(cacheHeaders);
    clientHeaders.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
    // The shared cache/KV/edge copy above is intentionally stripped of Set-Cookie,
    // but the CLIENT must still receive the first-render cookies (session/CSRF/
    // prefs). Re-append each Set-Cookie from the ORIGINAL render response — folding
    // via `getSetCookie()` preserves multiple distinct cookies.
    for (const cookie of response.headers.getSetCookie()) {
      clientHeaders.append('set-cookie', cookie);
    }
    return new Response(response.body, {
      status: response.status,
      headers: clientHeaders,
    });
  }
  return response;
}
