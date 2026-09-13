import { matchLiteralPattern, matchSegmentPattern } from '@void/edge';

export type IsrCacheMetadata = Readonly<{
  /** HTTP status code. */
  s: number;
  /** Creation time in milliseconds since the Unix epoch. */
  c: number;
  /** Freshness lifetime in seconds. */
  t: number;
}>;

export type IsrCacheEntry = Readonly<{
  body: ReadableStream;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number;
}>;

const PAGE_DATA_SCRIPT_RE =
  /<script\b[^>]*\bid=(["'])__VOID_PAGE_DATA__\1[^>]*>([\s\S]*?)<\/script>/i;
const SKIP_HEADERS = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

/** Map of literal path pattern to the query names retained in an ISR cache variant. */
export type QueryAllowlist = Record<string, ReadonlyArray<string>>;

/**
 * Normalize a request URL for cache-key use by retaining only query parameters
 * explicitly allowlisted for its user-facing pathname.
 */
export function buildVariantOriginalUrl(
  requestUrl: string,
  pathname: string,
  queryAllowlist: QueryAllowlist | undefined,
): string {
  const url = new URL(requestUrl);
  if (!url.search) {
    return url.toString();
  }
  const allowed = resolveQueryAllowlist(queryAllowlist, pathname);
  if (allowed.size === 0) {
    url.search = '';
    return url.toString();
  }
  const keys = [...new Set(url.searchParams.keys())].filter((key) => allowed.has(key)).sort();
  const filtered = new URLSearchParams();
  for (const key of keys) {
    for (const value of url.searchParams.getAll(key)) {
      filtered.append(key, value);
    }
  }
  const filteredString = filtered.toString();
  url.search = filteredString ? `?${filteredString}` : '';
  return url.toString();
}

/** Keep only exact allowlist patterns for uncapped static-cache consumers. */
export function exactQueryAllowlist(
  allowlist: QueryAllowlist | undefined,
): QueryAllowlist | undefined {
  if (!allowlist) {
    return undefined;
  }
  const exact = Object.fromEntries(
    Object.entries(allowlist).filter(([pattern]) => !pattern.includes('*')),
  );
  return Object.keys(exact).length > 0 ? exact : undefined;
}

function resolveQueryAllowlist(
  allowlist: QueryAllowlist | undefined,
  pathname: string,
): Set<string> {
  if (!allowlist) {
    return new Set();
  }
  for (const [pattern, params] of Object.entries(allowlist)) {
    if (matchLiteralPattern(pattern, pathname)) {
      return new Set(params);
    }
  }
  return new Set();
}

/** Pack response headers and body into the canonical ISR binary value. */
export function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/** Unpack a canonical ISR binary value, returning null for malformed bytes. */
export function unpackIsrValue(
  buffer: ArrayBuffer,
): { headers: Record<string, string>; body: ArrayBuffer } | null {
  if (buffer.byteLength < 4) {
    return null;
  }
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  if (buffer.byteLength < 4 + headerLength) {
    return null;
  }
  try {
    const headerBytes = new Uint8Array(buffer, 4, headerLength);
    const parsed = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        return null;
      }
      headers[name] = value;
    }
    return { headers, body: buffer.slice(4 + headerLength) };
  } catch {
    return null;
  }
}

/** Decode and validate a KV value plus metadata into a safe cache entry. */
export function decodeIsrCacheEntry(
  value: ArrayBuffer | null,
  metadata: IsrCacheMetadata | null,
): IsrCacheEntry | null {
  if (!value || !metadata) {
    return null;
  }
  const unpacked = unpackIsrValue(value);
  if (!unpacked) {
    return null;
  }
  if (!Number.isInteger(metadata.s) || metadata.s < 200 || metadata.s > 599) {
    return null;
  }
  if (
    !Number.isFinite(metadata.c) ||
    metadata.c <= 0 ||
    !Number.isFinite(metadata.t) ||
    metadata.t <= 0
  ) {
    return null;
  }
  try {
    new Headers(unpacked.headers);
  } catch {
    return null;
  }
  return {
    body: new ReadableStream({
      start(controller): void {
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

/** Check whether an ISR cache entry has passed its freshness lifetime. */
export function isStale(entry: IsrCacheEntry, now: number = Date.now()): boolean {
  return now - entry.createdAt > entry.ttl * 1000;
}

/** Build an edge-cacheable response from a validated ISR cache entry. */
export function isrCacheResponse(
  entry: IsrCacheEntry,
  stale: boolean,
  now: number = Date.now(),
): Response {
  const headers = new Headers(entry.headers);
  headers.set('x-isr-cache', stale ? 'STALE' : 'HIT');
  if (stale) {
    headers.set(
      'Cache-Control',
      `public, s-maxage=${Math.min(10, entry.ttl)}, max-age=0, must-revalidate`,
    );
  } else {
    const remainingSeconds = Math.max(
      0,
      Math.floor((entry.createdAt + entry.ttl * 1000 - now) / 1000),
    );
    headers.set(
      'Cache-Control',
      `public, s-maxage=${remainingSeconds}, max-age=0, must-revalidate`,
    );
  }
  return new Response(entry.body, { status: entry.status, headers });
}

/** Resolve an x-revalidate override, falling back for absent or invalid values. */
export function resolveRevalidateTtl(response: Response, defaultTtl: number): number {
  const header = response.headers.get('x-revalidate');
  if (header === null) {
    return defaultTtl;
  }
  const value = Number.parseInt(header, 10);
  return Number.isNaN(value) || value < 0 ? defaultTtl : value;
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

/** Return whether credentials or EventSource semantics require an ISR bypass. */
export function shouldBypassIsr(request: Request): boolean {
  return (
    request.headers.has('Cookie') ||
    request.headers.has('Authorization') ||
    acceptsEventStream(request)
  );
}

/** Resolve the first matching path TTL using Void route-pattern semantics. */
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

/** Extract response headers while removing ISR-managed and private headers. */
export function serializeHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  });
  return result;
}

/** Validate page data before storing it as the JSON ISR variant. */
export function normalizePageDataForJsonCache(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { deferred?: unknown; deferredKeys?: unknown };
    return parsed.deferred === undefined && parsed.deferredKeys === undefined ? raw : null;
  } catch {
    return null;
  }
}

/** Extract validated Void Pages data embedded in an HTML response. */
export function extractPageDataFromHtml(html: string): string | null {
  const match = html.match(PAGE_DATA_SCRIPT_RE);
  return match ? normalizePageDataForJsonCache(match[2]!) : null;
}
