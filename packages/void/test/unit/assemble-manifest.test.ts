import { describe, expect, it } from 'vite-plus/test';
import { assembleVoidManifest } from '../../src/cli/deploy.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';
import type { PageDefinition, PageScanResult } from '../../src/pages/types.ts';

// Minimal all-false bindings — `manifest.pages` emission is independent of
// bindings, so this is the smallest valid `buildVoidManifest` input.
const MINIMAL_BINDINGS: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

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

// This is the production seam `runFullDeploy` uses to forward `pageScan` into
// `manifest.pages`. If the `pages: collectPages(pageScan)` injection is dropped
// from `assembleVoidManifest`, the first assertion below fails (`.toEqual`
// mismatch) and the second fails (`pages` stays undefined) — so this test goes
// RED the moment the wiring regresses.
describe('assembleVoidManifest', () => {
  it('forwards the page scan into manifest.pages (ordered, raw patterns, ISR TTL preserved)', () => {
    const pageScan = makeScan([
      makePage('/docs/setup/install'), // static, no revalidate
      makePage('/blog/:slug', 120), // dynamic segment, ISR
      makePage('/docs/:path{.+}', 3600), // catch-all, ISR, RAW pattern
    ]);
    const manifest = assembleVoidManifest(pageScan, false, { bindings: MINIMAL_BINDINGS });
    expect(manifest.pages).toEqual([
      { pattern: '/docs/setup/install' },
      { pattern: '/blog/:slug', revalidate: 120 },
      { pattern: '/docs/:path{.+}', revalidate: 3600 },
    ]);
  });

  it('omits manifest.pages when the scan has no pages', () => {
    expect(
      assembleVoidManifest(makeScan([]), false, { bindings: MINIMAL_BINDINGS }).pages,
    ).toBeUndefined();
    expect(assembleVoidManifest(null, false, { bindings: MINIMAL_BINDINGS }).pages).toBeUndefined();
  });

  it('emits manifest.pages for a void app (isFrameworkMode = false)', () => {
    const scan = makeScan([makePage('/isr', 60)]);
    expect(assembleVoidManifest(scan, false, { bindings: MINIMAL_BINDINGS }).pages).toEqual([
      { pattern: '/isr', revalidate: 60 },
    ]);
  });

  it('omits manifest.pages in framework mode even with a populated scan (isFrameworkMode = true)', () => {
    // `pages` is a Void pages-mode concept: a Class-A framework routed through
    // runFullDeploy must NOT emit it, even when it happens to have a pages/ dir.
    const scan = makeScan([makePage('/isr', 60)]);
    expect(assembleVoidManifest(scan, true, { bindings: MINIMAL_BINDINGS }).pages).toBeUndefined();
  });
});
