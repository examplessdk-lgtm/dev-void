import { describe, expect, it } from 'vite-plus/test';
import type { VoidConfig } from '../../src/config.ts';
import {
  collectPages,
  collectRevalidate,
  hasRevalidate,
  matchConfigPattern,
} from '../../src/isr-config.ts';
import type { PageDefinition, PageScanResult } from '../../src/pages/types.ts';
import { resolvePathTtl } from '../../src/runtime/isr-cache.ts';

describe('hasRevalidate', () => {
  it('treats null / undefined / 0 / negative / {} as no ISR', () => {
    expect(hasRevalidate(null)).toBe(false);
    expect(hasRevalidate(undefined)).toBe(false);
    expect(hasRevalidate(0)).toBe(false);
    expect(hasRevalidate(-5)).toBe(false);
    expect(hasRevalidate({})).toBe(false);
  });

  it('treats a positive number or a non-empty path map as ISR on', () => {
    expect(hasRevalidate(60)).toBe(true);
    expect(hasRevalidate({ '/x': 10 })).toBe(true);
  });

  it('treats non-number/non-object values as no ISR', () => {
    expect(hasRevalidate('60')).toBe(false);
    expect(hasRevalidate(true)).toBe(false);
  });
});

function makePage(pattern: string, revalidate?: number): PageDefinition {
  return {
    pattern,
    params: [],
    catchAll: false,
    componentPath: `${pattern}.vue`,
    serverPath: `${pattern}.server.ts`,
    methods: ['GET'],
    componentId: pattern.replace(/^\//, ''),
    revalidate,
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
  };
}

function makeScan(pages: Array<PageDefinition>): PageScanResult {
  return { pages, layouts: [], namedLayouts: [] };
}

function configWith(revalidate: number | Record<string, number> | undefined): VoidConfig {
  return (revalidate === undefined ? {} : { routing: { revalidate } }) as VoidConfig;
}

describe('collectRevalidate', () => {
  it('returns undefined with no config and no per-page rules', () => {
    expect(collectRevalidate(configWith(undefined), makeScan([]))).toBeUndefined();
    expect(collectRevalidate(configWith(undefined), null)).toBeUndefined();
  });

  it('passes the void.json config through when there are no per-page rules', () => {
    expect(collectRevalidate(configWith(60), makeScan([]))).toBe(60);
    expect(collectRevalidate(configWith({ '/docs/*': 30 }), makeScan([]))).toEqual({
      '/docs/*': 30,
    });
  });

  it('uses per-page rules alone when config is absent', () => {
    const scan = makeScan([makePage('/blog/:slug', 120), makePage('/about')]);
    expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/blog/:slug': 120 });
  });

  it('turns a numeric config into a path map with the number as the "*" fallback (per-page first)', () => {
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const result = collectRevalidate(configWith(60), scan);
    expect(result).toEqual({ '/blog/:slug': 120, '*': 60 });
    // Per-page entry must precede the fallback (first-match-wins ordering).
    expect(Object.keys(result as Record<string, number>)).toEqual(['/blog/:slug', '*']);
  });

  it('merges per-page rules ahead of an object config (per-page first in match order)', () => {
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const result = collectRevalidate(configWith({ '/docs/*': 30, '*': 10 }), scan);
    // Per-page entries are emitted before the config entries, so first-match
    // resolution consults the per-page pattern ahead of the config's catch-alls.
    expect(Object.entries(result as Record<string, number>)).toEqual([
      ['/blog/:slug', 120],
      ['/docs/*', 30],
      ['*', 10],
    ]);
  });

  it('ignores pages that declare no revalidate', () => {
    const scan = makeScan([makePage('/about'), makePage('/contact')]);
    expect(collectRevalidate(configWith(undefined), scan)).toBeUndefined();
    expect(collectRevalidate(configWith(60), scan)).toBe(60);
  });

  // FIX 3: single-segment params (`:slug`) stay as `:slug` so the matcher can
  // anchor them to ONE path segment (`[^/]+`); only named catch-alls (`:slug{.+}`)
  // and anonymous catch-alls (`*`) collapse to `*` (a splat that crosses `/`).
  describe('route-param → key conversion (generated page keys)', () => {
    it('keeps a single dynamic param `[slug]` (`/blog/:slug`) as `/blog/:slug`', () => {
      const scan = makeScan([makePage('/blog/:slug', 120)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/blog/:slug': 120 });
    });

    it('converts a catch-all param `[...slug]` (`/blog/:slug{.+}`) to `/blog/*`', () => {
      const scan = makeScan([makePage('/blog/:slug{.+}', 90)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/blog/*': 90 });
    });

    it('converts a root catch-all (`/:all{.+}`) to `/*`', () => {
      const scan = makeScan([makePage('/:all{.+}', 15)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/*': 15 });
    });

    it('keeps every single-segment param in a multi-param pattern (`/shop/:cat/:id`)', () => {
      const scan = makeScan([makePage('/shop/:cat/:id', 45)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/shop/:cat/:id': 45 });
    });

    it('leaves static page patterns untouched', () => {
      const scan = makeScan([makePage('/about', 300)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/about': 300 });
    });

    it('does NOT convert user `routing.revalidate` literal keys (only generated page keys)', () => {
      // A user-authored key that happens to contain a `:` must pass through
      // verbatim — only the scanned page patterns are converted.
      const scan = makeScan([makePage('/blog/:slug', 120)]);
      const result = collectRevalidate(configWith({ '/legacy/:kept': 30 }), scan);
      expect(Object.entries(result as Record<string, number>)).toEqual([
        ['/blog/:slug', 120],
        ['/legacy/:kept', 30],
      ]);
    });
  });

  // FIX 3 end-to-end: the emitted `:slug` key must anchor to ONE segment through
  // the same resolver the runtime uses (mirrors isr-cache resolvePathTtl).
  it('produces keys that resolvePathTtl anchors to a single dynamic path segment', () => {
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const revalidate = collectRevalidate(configWith(undefined), scan);
    // Single dynamic segment matches.
    expect(resolvePathTtl(revalidate, '/blog/hello')).toBe(120);
    // A DEEPER path must NOT match the single-segment `:slug` key (would have
    // matched the old `/blog/*` wildcard) — proves the segment anchoring.
    expect(resolvePathTtl(revalidate, '/blog/a/b')).toBe(0);
    // An unrelated path still resolves to 0 (no ISR).
    expect(resolvePathTtl(revalidate, '/about')).toBe(0);
  });
});

describe('collectPages', () => {
  it('returns undefined when there is no page scan', () => {
    expect(collectPages(null)).toBeUndefined();
  });

  it('returns undefined when the scan has no pages', () => {
    expect(collectPages(makeScan([]))).toBeUndefined();
  });

  it('emits every page in scan order with raw patterns; revalidate only when set', () => {
    // makeScan preserves array order; a real scan is pre-sorted static→dynamic→catch-all.
    const scan = makeScan([
      makePage('/docs/setup/install'), // specific, no revalidate (opt-out)
      makePage('/blog/:slug', 120), // single-segment dynamic
      makePage('/docs/:path{.+}', 3600), // named catch-all — RAW pattern, not `*`
    ]);
    expect(collectPages(scan)).toEqual([
      { pattern: '/docs/setup/install' },
      { pattern: '/blog/:slug', revalidate: 120 },
      { pattern: '/docs/:path{.+}', revalidate: 3600 },
    ]);
  });

  // Test 1 — a per-page `export const revalidate` is authoritative and wins over
  // ANY void.json routing.revalidate config (number or object).
  it('per-page export wins over config', () => {
    const scan = makeScan([makePage('/p', 120)]);
    expect(collectPages(scan, 3600)).toEqual([{ pattern: '/p', revalidate: 120 }]);
    expect(collectPages(scan, { '/p': 9999 })).toEqual([{ pattern: '/p', revalidate: 120 }]);
  });

  // An explicit `export const revalidate = 0` is an opt-OUT and must NOT be
  // overridden by an app-wide config (preserves pre-#272 opt-out semantics).
  it('explicit per-page revalidate=0 opts out and is not overridden by config', () => {
    const scan = makeScan([makePage('/p', 0)]);
    expect(collectPages(scan, 3600)).toEqual([{ pattern: '/p' }]);
  });

  // Test 2 — REGRESSION GUARD (the must-fix): a global-number config must turn
  // ISR ON for EVERY no-export page. Before this fix, such pages baked no TTL and
  // dispatch's resolvePageTtl returned 0 → page ISR silently OFF for the whole site.
  it('a global-number config applies to every no-export page', () => {
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    expect(collectPages(scan, 3600)).toEqual([
      { pattern: '/blog/:slug', revalidate: 3600 },
      { pattern: '/about', revalidate: 3600 },
    ]);
  });

  // Test 3 — an object config is resolved per-page against the config patterns
  // ONLY; a page not covered by any config pattern stays 0 (no ISR).
  it('an object config applies to matching no-export pages only', () => {
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    expect(collectPages(scan, { '/blog/*': 3600 })).toEqual([
      { pattern: '/blog/:slug', revalidate: 3600 },
      { pattern: '/about' }, // not covered by config → no revalidate (0)
    ]);
  });

  // Test 4 — SHADOWING PRESERVED (plan 0077): a specific no-export page under a
  // SIBLING catch-all that HAS an export must NOT inherit the sibling's per-page
  // TTL. With no matching config it stays 0; with a config that covers it, it
  // legitimately resolves from the config.
  it('a no-export page does not inherit a sibling catch-all export (config absent)', () => {
    const scan = makeScan([makePage('/docs/:path{.+}', 300), makePage('/docs/setup/install')]);
    expect(collectPages(scan)).toEqual([
      { pattern: '/docs/:path{.+}', revalidate: 300 },
      { pattern: '/docs/setup/install' }, // stays 0 — no sibling inheritance
    ]);
  });

  it('a no-export page DOES resolve from the config when the config covers it', () => {
    const scan = makeScan([makePage('/docs/:path{.+}', 300), makePage('/docs/setup/install')]);
    expect(collectPages(scan, { '/docs/*': 300 })).toEqual([
      { pattern: '/docs/:path{.+}', revalidate: 300 },
      { pattern: '/docs/setup/install', revalidate: 300 }, // from config, legitimately
    ]);
  });
});

// Test 5 — PARITY: the build-time config-pattern matcher MUST agree with the
// platform dispatch runtime matcher (`matchSegmentPattern`,
// `packages/dispatch/src/pattern.ts`) on every pattern an ISR config can use. If
// they diverge, the TTL baked into the `pages` table won't equal what dispatch
// resolves at the edge → silent wrong-TTL. The framework repo cannot import the
// platform matcher in its standalone CI, so this pins `matchConfigPattern` to an
// EXPLICIT golden truth table of dispatch's segment-anchored semantics:
// `:name` matches ONE segment, `:name{.+}` and `*` cross `/`, a literal dot is
// literal, patterns are fully anchored. Keep in sync if those semantics change.
describe('matchConfigPattern parity with dispatch matchSegmentPattern (golden)', () => {
  const cases: Array<[string, string, boolean]> = [
    // single-segment param — must NOT cross '/'
    ['/blog/:slug', '/blog/hello', true],
    ['/blog/:slug', '/blog/a/b', false],
    ['/blog/:slug', '/blog', false],
    // anonymous catch-all '*' — crosses '/'
    ['/blog/*', '/blog/hello', true],
    ['/blog/*', '/blog/a/b', true],
    ['/blog/*', '/blog', false],
    // named catch-all ':name{.+}' — crosses '/' (the case client patternToRegex gets wrong)
    ['/docs/:path{.+}', '/docs/x', true],
    ['/docs/:path{.+}', '/docs/x/y', true],
    ['/docs/:path{.+}', '/docs', false],
    // multiple params / multiple '*' (a non-/g '*' replace would break the second '*')
    ['/shop/:cat/:id', '/shop/a/1', true],
    ['/shop/:cat/:id', '/shop/a', false],
    ['/x/*/y/*', '/x/1/y/2', true],
    ['/x/*/y/*', '/x/1/2', false],
    // literal dot is a literal, not "any char"
    ['/a.b', '/a.b', true],
    ['/a.b', '/axb', false],
    // a ':name.ext' param GREEDILY swallows the '.ext' into the single-segment
    // param (matches dispatch — cf. '/blog/:slug.xml' → '^/blog/[^/]+$'); it is
    // NOT a literal-suffix match, but it still must not cross '/'.
    ['/files/:name.json', '/files/a.json', true],
    ['/files/:name.json', '/files/anything', true],
    ['/files/:name.json', '/files/a/b', false],
    // literal
    ['/about', '/about', true],
    ['/about', '/about/x', false],
  ];

  it('matches dispatch segment-anchored semantics across the golden matrix', () => {
    const wrong: Array<string> = [];
    for (const [pattern, path, expected] of cases) {
      if (matchConfigPattern(pattern, path) !== expected) {
        wrong.push(
          `pattern=${JSON.stringify(pattern)} path=${JSON.stringify(path)} expected=${expected}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});
