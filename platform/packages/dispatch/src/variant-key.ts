import { matchLiteralPattern } from './pattern.ts';

/**
 * Map of path-pattern → allowlisted query-param names. Patterns are matched
 * against the user-facing (pre-rewrite) pathname; first match wins. A `*`
 * entry acts as a catch-all default. An empty array means "no params kept".
 */
export type QueryAllowlist = Record<string, ReadonlyArray<string>>;

/**
 * Build the variant-key URL from the original request URL on a rewrite.
 *
 * Without normalization, the cache key would split per full request URL —
 * a request to `/foo?utm_source=tw` and `/foo?utm_source=fb` (both rewritten
 * to the same destination) would create two cache slots, and an attacker
 * can fan out the cache by varying any query param. The fix:
 *
 *   - Default (no allowlist match): drop every query param. All requests
 *     to `/foo` share one variant slot regardless of incoming query.
 *   - Per-pathname allowlist: keep declared params only, sorted for
 *     deterministic ordering so `?a=1&b=2` and `?b=2&a=1` produce the
 *     same key.
 *
 * `pathname` is the pre-rewrite path (what the user actually requested),
 * since that's what they author the allowlist patterns against.
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
  const allowed = resolveAllowlist(queryAllowlist, pathname);
  if (allowed.size === 0) {
    url.search = '';
    return url.toString();
  }
  // Sort param names for deterministic ordering. `URLSearchParams` preserves
  // insertion order for multi-valued keys, which matters when the user lists
  // a param like `tag` that legitimately appears twice — the original input
  // order is the cache-relevant axis.
  const sortedKeys = [...new Set(url.searchParams.keys())].filter((key) => allowed.has(key));
  sortedKeys.sort();
  const filtered = new URLSearchParams();
  for (const key of sortedKeys) {
    for (const value of url.searchParams.getAll(key)) {
      filtered.append(key, value);
    }
  }
  const filteredString = filtered.toString();
  url.search = filteredString ? `?${filteredString}` : '';
  return url.toString();
}

/**
 * Keep only EXACT (wildcard-free) allowlist patterns. The uncapped
 * static-candidate edge cache uses this so a broad `*` / prefix-wildcard entry —
 * safe on the capped ISR variant path — cannot fan its params out across true
 * static assets. Returns undefined when nothing exact remains, so the caller
 * strips the query entirely (its pathname-only default).
 */
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

function resolveAllowlist(allowlist: QueryAllowlist | undefined, pathname: string): Set<string> {
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
