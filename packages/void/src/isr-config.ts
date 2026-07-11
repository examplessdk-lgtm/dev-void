import type { VoidConfig } from './config.ts';
import type { PageDefinition, PageScanResult } from './pages/types.ts';

/**
 * Whether a resolved `revalidate` value represents an active ISR configuration.
 *
 * Mirrors the presence check used when writing the deploy manifest
 * (`packages/void/src/cli/package.ts`): `null`/`undefined`/`0`/`{}` are treated
 * as "no ISR", a positive number or a non-empty path map is treated as "ISR on".
 */
export function hasRevalidate(r: unknown): boolean {
  if (r == null) {
    return false;
  }
  if (typeof r === 'number') {
    return r > 0;
  }
  if (typeof r === 'object') {
    return Object.keys(r as object).length > 0;
  }
  return false;
}

/**
 * Merge the app's `void.json` `routing.revalidate` config with per-page
 * `export const revalidate` rules discovered by the page scan, producing the
 * final revalidate map that gets baked into the deploy manifest (managed
 * `void deploy`) or the self-hosted worker build.
 *
 * This is the single source of truth for the merge so the managed and
 * self-host build paths cannot diverge. Behaviour is preserved verbatim from
 * the original inline logic in `void deploy`:
 *
 * - Config value seeds the result (`number | Record<string, number> | undefined`).
 * - Per-page rules (page pattern → revalidate seconds) are collected from the
 *   already-computed page scan (`null` when the app has no pages dir).
 * - When there are per-page rules:
 *   - config is a plain number → path map with per-page entries first and the
 *     config number applied to `"*"` as a fallback;
 *   - config is an object map → per-page entries first (higher precedence in
 *     first-match ordering), then the config entries;
 *   - config is absent → the per-page rules alone.
 * - Empty results (no config, no per-page rules) return `undefined`.
 */
export function collectRevalidate(
  config: VoidConfig,
  pageScan: PageScanResult | null,
): number | Record<string, number> | undefined {
  const vcRevalidate = config.routing?.revalidate;
  let revalidate: number | Record<string, number> | undefined;
  if (vcRevalidate != null) {
    revalidate = vcRevalidate;
  }
  // Merge per-page revalidate exports (pages mode)
  if (pageScan) {
    const perPageRules: Record<string, number> = {};
    for (const page of pageScan.pages) {
      if (page.revalidate != null) {
        // Single-segment params (:slug) stay as :slug so the matcher can anchor
        // them to ONE path segment; named catch-alls (:slug{.+}) and anonymous
        // catch-alls (*) stay/become '*' (a splat that crosses '/'). See
        // matchLiteralPattern. This applies ONLY to scanned page patterns — the
        // user's own `routing.revalidate` keys below are authored literals and
        // pass through untouched.
        const key = page.pattern.replace(/:[A-Za-z0-9_]+\{[^}]*\}/g, '*');
        perPageRules[key] = page.revalidate;
      }
    }
    if (Object.keys(perPageRules).length > 0) {
      if (typeof revalidate === 'number') {
        // Global number → pathmap with "*" fallback, per-page entries first
        revalidate = Object.fromEntries([...Object.entries(perPageRules), ['*', revalidate]]);
      } else if (typeof revalidate === 'object') {
        // Per-page entries first (higher precedence in first-match)
        revalidate = Object.fromEntries([
          ...Object.entries(perPageRules),
          ...Object.entries(revalidate),
        ]);
      } else {
        revalidate = perPageRules;
      }
    }
  }
  return revalidate;
}

/**
 * Resolve a single page's effective ISR TTL at BUILD time so the emitted
 * `pages` table is SELF-SUFFICIENT: dispatch's `resolvePageTtl` first-matches
 * the table and, on a match, uses ONLY that page's baked TTL — it never
 * consults the flat `revalidate` map for a matched page. Before this, a page
 * with no per-page `export const revalidate` baked no TTL, so a Void Pages app
 * that configured ISR through a global-number `void.json` `routing.revalidate`
 * silently lost ISR once the `pages` table shipped (page ISR OFF site-wide).
 *
 * Two sources, in order — SOURCE-SEPARATED, which is what preserves the
 * plan-0077 catch-all shadowing fix (a no-export page must NOT inherit a
 * SIBLING page's per-page TTL):
 *   1. an explicit per-page `export const revalidate` is authoritative — a
 *      positive value turns ISR on; an explicit 0 opts the page OUT and is NOT
 *      overridden by the app-wide config below;
 *   2. else a global-NUMBER `void.json` `routing.revalidate` (applies to every
 *      page); absent -> 0.
 *
 * An OBJECT (per-path map) `routing.revalidate` is deliberately NOT baked. It is
 * a per-PATH rule set, and a single page pattern can straddle several of its
 * entries — INCLUDING an explicit `0` opt-out on one of them (e.g. page
 * `/blog/:slug` under `{ '/blog/private': 0, '/blog/*': 3600 }`). Collapsing that
 * to one per-page TTL via a single representative probe path cannot honor the
 * `0` and would OVER-cache a path the user opted out of — a correctness
 * violation, not a mere under-cache. So an object-configured pages-mode app does
 * not drive page ISR through the table (matched pages resolve 0); per-page
 * `export const revalidate` is the supported per-route mechanism. See plan 0077.
 */
function resolvePageBuildTtl(
  page: PageDefinition,
  revalidateConfig: number | Record<string, number> | undefined,
): number {
  // 1. Explicit per-page export wins (0 = explicit opt-out, preserved).
  if (page.revalidate != null) {
    return page.revalidate > 0 ? page.revalidate : 0;
  }
  // 2. App-wide void.json `routing.revalidate` — global NUMBER only. An object
  //    (per-path) config is intentionally not collapsed to a per-page TTL: it
  //    cannot faithfully honor a per-path `0` opt-out (see the doc comment).
  if (typeof revalidateConfig === 'number') {
    return revalidateConfig > 0 ? revalidateConfig : 0;
  }
  return 0;
}

/**
 * Build the ordered page-route table shipped in the deploy manifest as
 * `pages`. Emits EVERY page route (with or without a TTL) in `pageScan.pages`
 * order — which is already specificity-sorted (static → dynamic → catch-all)
 * and is the exact order the framework's own `matchRoute` (pages/manifest.ts)
 * resolves in. Patterns are emitted RAW (`:slug`, `:path{.+}`, `*`); the edge
 * matcher (`matchSegmentPattern`) handles `:name{.+}` natively, so — unlike the
 * flat `revalidate` map — catch-alls are NOT collapsed to `*`.
 *
 * Each page's `revalidate` is resolved at BUILD time (`resolvePageBuildTtl`)
 * from its own `export const revalidate` first, then a global-NUMBER `void.json`
 * `routing.revalidate` config (`revalidateConfig`, the RAW config value — NOT
 * the merged `collectRevalidate` map; an OBJECT per-path config is not baked,
 * see `resolvePageBuildTtl`). This makes the table self-sufficient: dispatch's
 * `resolvePageTtl` never has to fall back to the flat map for a matched page (a
 * matched page with no baked TTL resolves to 0), so a Void Pages app that
 * configures ISR through a global-number `routing.revalidate` keeps its ISR.
 *
 * Consumers (dispatch, deploy prewarm) first-match over this list to pick the
 * winning route, then apply that route's `revalidate` (0/absent = not ISR).
 */
export function collectPages(
  pageScan: PageScanResult | null,
  revalidateConfig?: number | Record<string, number> | undefined,
): Array<{ pattern: string; revalidate?: number }> | undefined {
  if (!pageScan || pageScan.pages.length === 0) {
    return undefined;
  }
  return pageScan.pages.map((page) => {
    const ttl = resolvePageBuildTtl(page, revalidateConfig);
    return ttl > 0 ? { pattern: page.pattern, revalidate: ttl } : { pattern: page.pattern };
  });
}
