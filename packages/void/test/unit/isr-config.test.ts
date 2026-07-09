import { describe, expect, it } from 'vite-plus/test';
import type { VoidConfig } from '../../src/config.ts';
import { collectRevalidate, hasRevalidate } from '../../src/isr-config.ts';
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
