import type { VoidConfig } from './config.ts';
import type { PageScanResult } from './pages/types.ts';

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
