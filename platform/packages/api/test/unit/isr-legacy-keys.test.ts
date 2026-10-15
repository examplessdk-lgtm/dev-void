import { describe, expect, it } from 'vite-plus/test';
import {
  legacyIsrCacheKey,
  legacyIsrCachePrefix,
  legacyIsrCacheVariantPrefix,
} from '../../src/isr-legacy-keys.ts';

// Purges must match keys that older dispatch versions wrote, byte for byte.
describe('legacy (v2) ISR keys', () => {
  it('builds the hostless deployment prefix', () => {
    expect(legacyIsrCachePrefix('p', 'd')).toBe('p/isr/v2/d/');
  });

  it('builds direct-hit keys from the normalized path', () => {
    expect(legacyIsrCacheKey('p', 'd', '/en/docs')).toBe('p/isr/v2/d/en/docs');
    expect(legacyIsrCacheKey('p', 'd', '/')).toBe('p/isr/v2/d/__index__');
    expect(legacyIsrCacheKey('p', 'd', '/about/')).toBe('p/isr/v2/d/about');
  });

  it('builds rewrite-variant prefixes from the normalized path', () => {
    expect(legacyIsrCacheVariantPrefix('p', 'd', '/en/docs')).toBe('p/isr/v2/d/en/docs#rw=');
    expect(legacyIsrCacheVariantPrefix('p', 'd', '/')).toBe('p/isr/v2/d/__index__#rw=');
    expect(legacyIsrCacheVariantPrefix('p', 'd', '/about/')).toBe('p/isr/v2/d/about#rw=');
  });
});
