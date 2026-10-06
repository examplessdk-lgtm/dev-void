import type { VoidConfig } from './config.ts';
import type { PageDefinition, PageScanResult } from './pages/types.ts';

/**
 * Whether a resolved `revalidate` value represents an active ISR configuration.
 * `null`/`undefined`/`0`/`{}` are treated as "no ISR", a positive number or a
 * non-empty path map is treated as "ISR on".
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
 * Merge the app's `routing.revalidate` config with per-page
 * `export const revalidate` rules discovered by the page scan, producing the
 * final revalidate map that gets baked into the deploy manifest (managed
 * `void deploy`) or the self-hosted worker build.
 *
 * This is the single source of truth for the flat fallback map shared by
 * managed and native builds. Page requests also carry `collectPages()`'s
 * ordered three-state policy, which is authoritative at runtime:
 *
 * - Config value seeds the result (`number | Record<string, number> | undefined`).
 * - Per-page rules (page pattern → revalidate seconds) are collected from the
 *   already-computed page scan (`null` when the app has no pages dir).
 * - When there are per-page rules:
 *   - config is a plain number → path map with per-page entries first and the
 *     config number applied to `"*"` as a fallback unless that page key exists;
 *   - config is an object map → per-page entries first (higher precedence in
 *     first-match ordering), then non-duplicate config entries;
 *   - config is absent → the per-page rules alone.
 * - Empty results (no config, no per-page rules) return `undefined`.
 */
export function collectRevalidate(
  config: VoidConfig,
  pageScan: PageScanResult | null,
): number | Record<string, number> | undefined {
  if (config.routing?.isr === false) {
    return undefined;
  }
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
        if (!Object.hasOwn(perPageRules, '*')) {
          perPageRules['*'] = revalidate;
        }
        revalidate = perPageRules;
      } else if (typeof revalidate === 'object') {
        // Per-page entries first (higher precedence in first-match). Remove
        // duplicate config keys so a later Object.fromEntries entry cannot
        // overwrite an explicit page opt-out while retaining its earlier slot.
        revalidate = Object.fromEntries([
          ...Object.entries(perPageRules),
          ...Object.entries(revalidate).filter(
            ([pattern]) => !Object.hasOwn(perPageRules, pattern),
          ),
        ]);
      } else {
        revalidate = perPageRules;
      }
    }
  }
  return revalidate;
}

/**
 * Resolve a single page's BUILD-time ISR TTL for the 3-STATE `pages` table.
 * Returns:
 *   - a number `> 0` — ISR ON with that baked TTL;
 *   - `0` — an EXPLICIT opt-out (a per-page `export const revalidate = 0`, or a
 *     global-number config of 0). Dispatch honors it verbatim and does NOT fall
 *     back to the per-path config;
 *   - `undefined` — INHERIT-eligible: the page bakes no TTL, and dispatch
 *     resolves the RAW per-path `routing.revalidate` OBJECT config (shipped as
 *     `manifest.pathRevalidate`) against the ACTUAL request path at the edge.
 *
 * Sources, in precedence order — SOURCE-SEPARATED, so a no-export page never
 * inherits a SIBLING page's per-page TTL (sibling exports never reach this
 * function):
 *   1. an explicit per-page `export const revalidate` is authoritative — a
 *      positive value turns ISR on; an explicit `0` opts the page OUT and is NOT
 *      overridden by the app-wide config;
 *   2. else a global-NUMBER `routing.revalidate` (applies to every
 *      page: `> 0` on, `0` off);
 *   3. else (an OBJECT config, or none) → `undefined` (inherit-eligible).
 *
 * Why an OBJECT config is resolved at the EDGE, not baked here: it is a per-PATH
 * rule set, and a single dynamic page pattern can straddle several of its entries
 * — INCLUDING a per-path `0` opt-out (e.g. page `/blog/:slug` under
 * `{ '/blog/private': 0, '/blog/*': 3600 }`). Collapsing that to one build-time
 * TTL cannot honor the `0` and would OVER-cache an opted-out path — a wrong-serve.
 * Dispatch has the concrete request path, so it resolves each rule per-path
 * correctly. Baking is only safe for the whole-site number config and per-page
 * exports (each maps to exactly one TTL). See plan 0077.
 */
function resolvePageBuildTtl(
  page: PageDefinition,
  revalidateConfig: number | Record<string, number> | undefined,
): number | undefined {
  // 1. Explicit per-page export wins (0 = explicit opt-out, preserved verbatim).
  if (page.revalidate != null) {
    return page.revalidate > 0 ? page.revalidate : 0;
  }
  // 2. App-wide `routing.revalidate` — global NUMBER only.
  if (typeof revalidateConfig === 'number') {
    return revalidateConfig > 0 ? revalidateConfig : 0;
  }
  // 3. Object config (or none) → inherit-eligible; dispatch resolves per-path.
  return undefined;
}

/**
 * Build the ordered page-route table shipped in the deploy manifest as `pages`.
 * Emits EVERY page route in `pageScan.pages` order — already specificity-sorted
 * (static → dynamic → catch-all), the exact order the framework's own
 * `matchRoute` (pages/manifest.ts) resolves in. Patterns are emitted RAW
 * (`:slug`, `:path{.+}`, `*`); the edge matcher (`matchSegmentPattern`) handles
 * `:name{.+}` natively, so — unlike the flat `revalidate` map — catch-alls are
 * NOT collapsed to `*`.
 *
 * Each entry carries a 3-STATE `revalidate` (see `resolvePageBuildTtl`):
 *   - `revalidate: N` (N > 0) — ISR on with baked TTL N;
 *   - `revalidate: 0` — EXPLICIT opt-out (per-page `= 0`, or global-0 config);
 *   - `revalidate` ABSENT — inherit-eligible; dispatch resolves the RAW per-path
 *     OBJECT config (`manifest.pathRevalidate`) against the real request path.
 *
 * The explicit-0 vs absent distinction is load-bearing: it lets dispatch tell a
 * deliberate opt-out (never cache) apart from "no baked TTL, ask the per-path
 * config" (which may cache), so a per-page `export const revalidate = 0` still
 * wins over any `routing.revalidate` rule for the same path.
 */
// Route-unaware by design: this table is built from `pageScan.pages` only, so a
// broad catch-all page with a TTL can shadow a non-`/api` `routes/` handler at
// dispatch and ISR-cache its response (the worker serves the route, but dispatch
// resolves the page catch-all's TTL). A global-number `routing.revalidate` has
// the same effect. Bounded by dispatch `shouldBypassIsr` (no cross-user auth
// leak) and `isApiPath` (`/api/*` excluded). See design doc 0077 for this known
// limitation and the planned fix (prepend `routes/` patterns as `revalidate: 0`).
export function collectPages(
  pageScan: PageScanResult | null,
  revalidateConfig?: number | Record<string, number> | undefined,
  isrEnabled = true,
): Array<{ pattern: string; revalidate?: number }> | undefined {
  if (!pageScan || pageScan.pages.length === 0) {
    return undefined;
  }
  return pageScan.pages.map((page) => {
    const ttl = isrEnabled ? resolvePageBuildTtl(page, revalidateConfig) : undefined;
    // `undefined` → inherit-eligible (omit `revalidate`); a number (0 or N) is
    // baked verbatim so dispatch can distinguish an explicit opt-out from inherit.
    return ttl === undefined
      ? { pattern: page.pattern }
      : { pattern: page.pattern, revalidate: ttl };
  });
}
