import { describe, expect, it } from 'vite-plus/test';
import { resolvePageTtl } from '../../src/core.ts';

describe('resolvePageTtl', () => {
  it('preserves an explicit page opt-out over a conflicting flat config', () => {
    expect(
      resolvePageTtl(
        [{ pattern: '/private', revalidate: 0 }],
        { '/private': 60 },
        { '/private': 60 },
        '/private',
      ),
    ).toBe(0);
  });

  it('first-matches the ordered page table before consulting flat fallback rules', () => {
    const pages = [
      { pattern: '/docs/private', revalidate: 0 },
      { pattern: '/docs/:path{.+}', revalidate: 300 },
    ];

    expect(resolvePageTtl(pages, { '/docs/*': 60 }, undefined, '/docs/private')).toBe(0);
    expect(resolvePageTtl(pages, { '/docs/*': 60 }, undefined, '/docs/guides/start')).toBe(300);
  });

  it('resolves an inherit-eligible page against the raw per-path policy', () => {
    const pages = [{ pattern: '/blog/:slug' }];
    const pathRevalidate = { '/blog/private': 0, '/blog/*': 3600 };

    expect(resolvePageTtl(pages, undefined, pathRevalidate, '/blog/private')).toBe(0);
    expect(resolvePageTtl(pages, undefined, pathRevalidate, '/blog/post')).toBe(3600);
  });

  it('uses the flat policy only when no page route matches', () => {
    expect(
      resolvePageTtl(
        [{ pattern: '/page', revalidate: 0 }],
        { '/legacy/*': 90 },
        undefined,
        '/legacy/x',
      ),
    ).toBe(90);
  });
});
