import { resolvePathTtl } from '@void/isr/runtime';
import { describe, expect, it } from 'vite-plus/test';
import type { VoidConfig } from '../../src/config.ts';
import { collectPages, collectRevalidate, hasRevalidate } from '../../src/isr-config.ts';
import type { PageDefinition, PageScanResult } from '../../src/pages/types.ts';

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
  it('disables every page policy when routing.isr is false', () => {
    const scan = makeScan([makePage('/', 31536000), makePage('/dynamic', 60)]);
    expect(collectRevalidate({ routing: { isr: false, revalidate: 120 } }, scan)).toBeUndefined();
    expect(collectPages(scan, { '*': 120 }, false)).toEqual([
      { pattern: '/' },
      { pattern: '/dynamic' },
    ]);
    expect(collectRevalidate({ routing: { isr: true } }, scan)).toEqual({
      '/': 31536000,
      '/dynamic': 60,
    });
  });
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

  it('does not let the numeric fallback overwrite a page catch-all opt-out', () => {
    const scan = makeScan([makePage('*', 0)]);
    expect(collectRevalidate(configWith(60), scan)).toEqual({ '*': 0 });
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

  it('does not let a duplicate object-config key overwrite an explicit page opt-out', () => {
    const scan = makeScan([makePage('/private', 0)]);
    expect(collectRevalidate(configWith({ '/private': 60 }), scan)).toEqual({ '/private': 0 });
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

  // A per-page `export const revalidate` wins over any routing.revalidate config.
  it('per-page export wins over config', () => {
    const scan = makeScan([makePage('/p', 120)]);
    expect(collectPages(scan, 3600)).toEqual([{ pattern: '/p', revalidate: 120 }]);
    expect(collectPages(scan, { '/p': 9999 })).toEqual([{ pattern: '/p', revalidate: 120 }]);
  });

  // An explicit `export const revalidate = 0` is an opt-OUT: it bakes the
  // DISTINGUISHED marker `revalidate: 0` (NOT absent) so dispatch treats it as a
  // deliberate opt-out — never overridden by an app-wide config, never a per-path
  // inherit. The `0`-vs-absent distinction is load-bearing (see the 3-state test).
  it('explicit per-page revalidate=0 bakes the distinguished opt-out marker (revalidate:0)', () => {
    const scan = makeScan([makePage('/p', 0)]);
    expect(collectPages(scan, 3600)).toEqual([{ pattern: '/p', revalidate: 0 }]);
    // Even with an object rule for the same path, the explicit opt-out marker wins.
    expect(collectPages(scan, { '/p': 9999 })).toEqual([{ pattern: '/p', revalidate: 0 }]);
  });

  // The 3-STATE encoding in one table: a baked number `N` (ISR on), an explicit
  // `0` (opt-out marker), and an ABSENT revalidate (inherit — dispatch resolves
  // the per-path config against the real request path). Dispatch relies on the
  // `0`-vs-absent distinction to tell a deliberate opt-out from "ask the config".
  it('emits all three states: baked N, explicit 0 opt-out, and absent (inherit)', () => {
    const scan = makeScan([
      makePage('/on', 120), // per-page export > 0 → baked N
      makePage('/off', 0), // per-page export 0 → explicit opt-out marker
      makePage('/inherit'), // no export, object config → inherit (absent)
    ]);
    expect(collectPages(scan, { '/inherit': 60 })).toEqual([
      { pattern: '/on', revalidate: 120 },
      { pattern: '/off', revalidate: 0 },
      { pattern: '/inherit' },
    ]);
  });

  // A global-number config turns ISR on for every no-export page; otherwise
  // dispatch's resolvePageTtl would return 0 and disable page ISR site-wide.
  it('a global-number config applies to every no-export page', () => {
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    expect(collectPages(scan, 3600)).toEqual([
      { pattern: '/blog/:slug', revalidate: 3600 },
      { pattern: '/about', revalidate: 3600 },
    ]);
  });

  // An object (per-path) config bakes no per-page TTL. A page can straddle
  // several entries, so the raw config ships as `manifest.pathRevalidate` and
  // dispatch resolves it against the actual request path.
  it('an object config bakes no per-page TTL (pages are inherit-eligible)', () => {
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    expect(collectPages(scan, { '/blog/*': 3600 })).toEqual([
      { pattern: '/blog/:slug' }, // inherit-eligible → dispatch resolves per-path
      { pattern: '/about' },
    ]);
  });

  // A per-path `0` inside an object config is why baking is unsafe: a build-time
  // collapse would over-cache `/blog/private`.
  it('leaves an object-config page inherit-eligible so a per-path 0 opt-out is honored at the edge', () => {
    const scan = makeScan([makePage('/blog/:slug')]);
    expect(collectPages(scan, { '/blog/private': 0, '/blog/*': 3600 })).toEqual([
      { pattern: '/blog/:slug' }, // no baked TTL; edge honors /blog/private:0 per-path
    ]);
  });

  // A no-export page never inherits a sibling catch-all's per-page export.
  it('a no-export page does not inherit a sibling catch-all export', () => {
    const scan = makeScan([makePage('/docs/:path{.+}', 300), makePage('/docs/setup/install')]);
    expect(collectPages(scan)).toEqual([
      { pattern: '/docs/:path{.+}', revalidate: 300 },
      { pattern: '/docs/setup/install' }, // stays 0 — no sibling inheritance
    ]);
  });
});
