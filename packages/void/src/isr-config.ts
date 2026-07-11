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

// Private-use sentinels used while compiling a config pattern to a RegExp.
// Identical scheme to dispatch's `matchSegmentPattern` (see `matchConfigPattern`).
const SEGMENT_SENTINEL = String.fromCharCode(0xe000);
const CATCHALL_SENTINEL = String.fromCharCode(0xe001);

/**
 * Compile a `void.json` `routing.revalidate` CONFIG pattern to a RegExp and
 * test a pathname against it, using the EXACT segment-anchored semantics
 * dispatch applies at runtime (`matchSegmentPattern`,
 * `packages/dispatch/src/pattern.ts`). Parity here is load-bearing: the TTL we
 * bake into a page at build time MUST equal what dispatch's
 * `resolvePathTtl(config, <path the page serves>)` resolves at the edge, or we
 * ship a silently wrong TTL. This is a faithful port of that matcher (minus its
 * LRU cache — a runtime hot-path concern only).
 *
 * We deliberately do NOT reuse the framework's `patternToRegex`
 * (`pages/manifest.ts`): despite looking similar it is the CLIENT route matcher
 * and DIVERGES from dispatch on the two cases ISR configs care about most —
 * (1) it injects `(.+)` for a `:name{.+}` catch-all BEFORE its regex-escape
 * step, so the escape turns it into a literal `\(\.\+\)` that never matches a
 * real path, and (2) its `*` replace lacks the `/g` flag so only the FIRST `*`
 * in a pattern expands. Both would break parity on the exact patterns ISR
 * configs use (`/docs/:path{.+}`, multi-`*`). The parity cross-check test pins
 * this matcher to the parent repo's `matchSegmentPattern`. (Exported for that
 * cross-check test; not part of the package's public exports.)
 */
export function matchConfigPattern(pattern: string, pathname: string): boolean {
  let regex: RegExp;
  try {
    const escaped = pattern
      .replace(/(^|\/):[^/{}]+\{\.\+\}(?=\/|$)/g, `$1${CATCHALL_SENTINEL}`) // named catch-all :name{.+}
      .replace(/(^|\/):[^/]+(?=\/|$)/g, `$1${SEGMENT_SENTINEL}`) // whole-segment :name
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
      .replaceAll('*', '.*') // legacy `*` crosses '/'
      .replaceAll(SEGMENT_SENTINEL, '[^/]+') // one segment
      .replaceAll(CATCHALL_SENTINEL, '.+'); // >=1 char, crosses '/'
    regex = new RegExp(`^${escaped}$`);
  } catch {
    return false;
  }
  return regex.test(pathname);
}

/**
 * Substitute a page pattern's params to a concrete probe path so it can be
 * tested against config patterns. Each placeholder becomes a value the page's
 * OWN pattern would match:
 *   `:name`     -> one segment            (`_`)
 *   `:name{.+}` -> a value crossing `/`   (`_/_`)  (named catch-all)
 *   `*`         -> a value crossing `/`   (`_/_`)  (anonymous catch-all)
 * Literal segments pass through untouched. The named catch-all is substituted
 * FIRST (same ordering hazard as `matchSegmentPattern`) so `:name{.+}` is
 * consumed as a unit before the plain `:name` rule can grab it and strand the
 * `{.+}` / pick the wrong single-segment value. This is the one slightly-hacky
 * mechanic — kept small: it only builds a representative path, never persisted.
 */
function pagePatternToProbePath(pattern: string): string {
  return pattern
    .replace(/(^|\/):[^/{}]+\{\.\+\}(?=\/|$)/g, '$1_/_') // named catch-all -> crossing value
    .replace(/(^|\/):[^/]+(?=\/|$)/g, '$1_') // single-segment param -> one segment
    .replaceAll('*', '_/_'); // anonymous catch-all -> crossing value
}

/**
 * Resolve a single page's effective ISR TTL at BUILD time so the emitted
 * `pages` table is SELF-SUFFICIENT: dispatch's `resolvePageTtl` first-matches
 * the table and, on a match, uses ONLY that page's baked TTL — it never
 * consults the flat `revalidate` map for a matched page. Before this, a page
 * with no per-page `export const revalidate` baked no TTL, so a Void Pages app
 * that configured ISR through `void.json` `routing.revalidate` silently lost
 * ISR once the `pages` table shipped (worst case: a global-number config turned
 * page ISR OFF for the entire site).
 *
 * Order — SOURCE-SEPARATED, which is what preserves the plan-0077 catch-all
 * shadowing fix (a no-export page must NOT inherit a SIBLING page's per-page
 * TTL):
 *   1. an explicit per-page `export const revalidate` is authoritative — a
 *      positive value turns ISR on; an explicit 0 opts the page OUT and is NOT
 *      overridden by the app-wide config below;
 *   2. else resolve against the app's `void.json` `routing.revalidate` config
 *      ONLY (never the merged `collectRevalidate` map, never another page's
 *      export):
 *        - number -> that global TTL (applies to every page);
 *        - object -> the FIRST config pattern (dispatch first-match order) that
 *          matches the page's representative probe path; else 0;
 *        - absent -> 0.
 *
 * Accepted residual (do NOT try to fix): a single page pattern that straddles
 * MULTIPLE distinct config patterns (e.g. a root catch-all `/:path{.+}` with
 * config `{ '/blog/*': 3600, '/news/*': 1800 }`) can carry only ONE TTL — the
 * probe is a single representative path, so only the config pattern covering
 * that probe applies. This is a fundamental per-path-vs-per-page expressiveness
 * gap; it can only UNDER-cache (never wrong-serve) and is strictly better than
 * the pre-fix status quo where such a page lost ISR entirely.
 */
function resolvePageBuildTtl(
  page: PageDefinition,
  revalidateConfig: number | Record<string, number> | undefined,
): number {
  // 1. Explicit per-page export wins (0 = explicit opt-out, preserved).
  if (page.revalidate != null) {
    return page.revalidate > 0 ? page.revalidate : 0;
  }
  // 2. App-wide void.json `routing.revalidate` config ONLY.
  if (typeof revalidateConfig === 'number') {
    return revalidateConfig > 0 ? revalidateConfig : 0;
  }
  if (revalidateConfig != null && typeof revalidateConfig === 'object') {
    const probe = pagePatternToProbePath(page.pattern);
    for (const [pattern, ttl] of Object.entries(revalidateConfig)) {
      // First matching config pattern wins — mirrors dispatch `resolvePathTtl`.
      if (matchConfigPattern(pattern, probe)) {
        return ttl > 0 ? ttl : 0;
      }
    }
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
 * from its own `export const revalidate` first, then the app's `void.json`
 * `routing.revalidate` config (`revalidateConfig`, the RAW config value — NOT
 * the merged `collectRevalidate` map). This makes the table self-sufficient:
 * dispatch's `resolvePageTtl` never has to fall back to the flat map for a
 * matched page (a matched page with no baked TTL resolves to 0), so a Void Pages
 * app that configures ISR only through `routing.revalidate` keeps its ISR.
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
