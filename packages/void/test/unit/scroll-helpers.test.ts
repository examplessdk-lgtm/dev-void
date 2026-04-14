import { describe, it, expect } from 'vitest';

describe('scroll restoration helpers', () => {
  describe('hash extraction', () => {
    function extractHash(url: string) {
      const hashIndex = url.indexOf('#');
      const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
      const fetchUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;
      return { hash, fetchUrl };
    }

    it('extracts hash from URL', () => {
      expect(extractHash('/docs#api')).toEqual({ hash: '#api', fetchUrl: '/docs' });
    });

    it('returns empty hash for URLs without fragment', () => {
      expect(extractHash('/docs')).toEqual({ hash: '', fetchUrl: '/docs' });
    });

    it('handles hash-only URL', () => {
      expect(extractHash('#top')).toEqual({ hash: '#top', fetchUrl: '' });
    });

    it('preserves query string before hash', () => {
      expect(extractHash('/search?q=foo#results')).toEqual({
        hash: '#results',
        fetchUrl: '/search?q=foo',
      });
    });
  });

  describe('scroll priority', () => {
    function resolveScroll(opts: {
      preserveScroll?: boolean;
      scrollPosition?: { x: number; y: number } | null;
      hash?: string;
    }): { action: 'none' | 'restore' | 'hash' | 'top'; x?: number; y?: number; hash?: string } {
      if (opts.preserveScroll) {
        return { action: 'none' };
      }
      if (opts.scrollPosition) {
        return { action: 'restore', x: opts.scrollPosition.x, y: opts.scrollPosition.y };
      }
      if (opts.hash) {
        return { action: 'hash', hash: opts.hash };
      }
      return { action: 'top' };
    }

    it('preserveScroll wins over everything', () => {
      expect(
        resolveScroll({ preserveScroll: true, scrollPosition: { x: 0, y: 500 }, hash: '#foo' }),
      ).toEqual({ action: 'none' });
    });

    it('popstate scroll position wins over hash', () => {
      expect(resolveScroll({ scrollPosition: { x: 0, y: 300 }, hash: '#bar' })).toEqual({
        action: 'restore',
        x: 0,
        y: 300,
      });
    });

    it('hash wins over scroll-to-top', () => {
      expect(resolveScroll({ hash: '#section' })).toEqual({ action: 'hash', hash: '#section' });
    });

    it('defaults to scroll-to-top', () => {
      expect(resolveScroll({})).toEqual({ action: 'top' });
    });
  });
});
