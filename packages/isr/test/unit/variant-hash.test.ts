import { describe, expect, it } from 'vite-plus/test';
import {
  isrCacheKey,
  isrCachePrefix,
  isrCacheVariantPrefix,
  isrEdgeCacheUrl,
  isrEdgeCacheUrlForToken,
  isrLegacyCacheKey,
  isrLegacyCachePrefix,
  isrLegacyCacheVariantPrefix,
  splitIsrCacheKey,
} from '../../src/index.ts';

/**
 * Hashing the variant token (instead of base64url-encoding the original URL)
 * meets two operational concerns:
 *
 *   1. KV is operator-readable. A reversible token (`btoa(originalUrl)`) lets
 *      anyone with KV list access recover the URL — including any sensitive
 *      query strings (`?token=…`, `?email=…`) that produced the variant.
 *   2. Variant tokens are used as KV-key suffixes. KV's 512-byte name limit
 *      can be approached if a deployment serves long URLs; a fixed-length
 *      hash bounds key length irrespective of input.
 */
describe('ISR variant token hashing', () => {
  function variantSuffix(key: string): string {
    const idx = key.indexOf('#rw=');
    expect(idx).toBeGreaterThan(-1);
    return key.slice(idx + '#rw='.length);
  }

  it('produces a fixed-length hex token regardless of URL length', () => {
    const short = isrCacheKey('p', 'd', 'h', '/x', 'https://h/');
    const long = isrCacheKey(
      'p',
      'd',
      'h',
      '/x',
      'https://h/' + 'A'.repeat(4096) + '?q=' + 'B'.repeat(4096),
    );
    const a = variantSuffix(short);
    const b = variantSuffix(long);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(b).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeLessThanOrEqual(64); // bounded, not URL-length-dependent
  });

  it('does not embed any portion of the original URL in the token', () => {
    // Sentinel chosen so any base64url/identity scheme would surface it.
    const sentinel = 'leaky-secret-fragment';
    const key = isrCacheKey('p', 'd', 'h', '/x', `https://h/page?token=${sentinel}`);
    const token = variantSuffix(key);
    expect(token.toLowerCase()).not.toContain(sentinel.toLowerCase());
    // base64url of the URL would also contain the sentinel encoded — guard
    // against that too by checking a few likely encodings.
    expect(token).not.toContain('bGVha3k='.replace('=', '')); // partial b64
  });

  it('is deterministic — same URL produces the same token', () => {
    const a = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    const b = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    expect(a).toBe(b);
  });

  it('produces distinct tokens for distinct URLs', () => {
    const a = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    const b = isrCacheKey('p', 'd', 'h', '/x', 'https://h/bar');
    expect(a).not.toBe(b);
  });

  it('splitIsrCacheKey returns the (opaque) variant token, not a URL', () => {
    const fullKey = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    // splitIsrCacheKey consumes the suffix after the deployment+host prefix.
    const split = splitIsrCacheKey(fullKey.slice(`p/isr/v3/d/h/`.length));
    expect(split.variantToken).toMatch(/^[0-9a-f]+$/);
    expect(split.variantToken).not.toContain('https://');
  });

  it('current (v3) key strings are host-scoped', () => {
    // Direct hit and prefixes all live under the `v3` (host-scoped) namespace.
    expect(isrCacheKey('p', 'd', 'h', '/about')).toBe('p/isr/v3/d/h/about');
    expect(isrCacheKey('p', 'd', 'h', '/')).toBe('p/isr/v3/d/h/__index__');
    expect(isrCachePrefix('p', 'd')).toBe('p/isr/v3/d/');
    expect(isrCacheVariantPrefix('p', 'd', 'h', '/en/docs')).toBe('p/isr/v3/d/h/en/docs#rw=');
  });

  it('legacy (v2) helpers produce hostless isr/v2 strings', () => {
    // Legacy (pre-host-scoping) keys have no `<host>` segment and live under the
    // `v2` namespace: `<proj>/isr/v2/<D>/<normalizedPath>[#rw=]`.
    expect(isrLegacyCachePrefix('p', 'd')).toBe('p/isr/v2/d/');
    expect(isrLegacyCacheKey('p', 'd', '/en/docs')).toBe('p/isr/v2/d/en/docs');
    expect(isrLegacyCacheKey('p', 'd', '/')).toBe('p/isr/v2/d/__index__');
    expect(isrLegacyCacheKey('p', 'd', '/about/')).toBe('p/isr/v2/d/about');
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/en/docs')).toBe('p/isr/v2/d/en/docs#rw=');
    // Root and trailing slashes normalize identically to the host-scoped form.
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/')).toBe('p/isr/v2/d/__index__#rw=');
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/about/')).toBe('p/isr/v2/d/about#rw=');
    // The legacy variant prefix is the host-scoped one with BOTH the version
    // bumped down (v3→v2) and the `<host>/` segment removed.
    const hostScoped = isrCacheVariantPrefix('p', 'd', 'h', '/en/docs');
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/en/docs')).toBe(
      hostScoped.replace('/v3/', '/v2/').replace('/h/', '/'),
    );
  });

  it('legacy (v2) prefix matches a v2 hostless key but never a v3 host-scoped one', () => {
    const legacyPrefix = isrLegacyCacheVariantPrefix('p', 'd', '/en/docs');
    const legacyKey = 'p/isr/v2/d/en/docs#rw=deadbeefdeadbeef';
    expect(legacyKey.startsWith(legacyPrefix)).toBe(true);
    // A v3 host-scoped variant key is never under the v2 legacy prefix — the
    // version segment (`v3` vs `v2`) alone keeps the two namespaces disjoint.
    const hostScopedKey = isrCacheKey(
      'p',
      'd',
      'app.void.app',
      '/en/docs',
      'https://app.void.app/docs',
    );
    expect(hostScopedKey.startsWith(legacyPrefix)).toBe(false);
  });

  it('v3 host-scoped key does NOT collide with the v2 legacy key of a dotted path', () => {
    // The bug the v3 bump fixes: `normalizeIsrPath` does not escape `/` or `.`,
    // so a host-scoped key for `(host=example.com, /about)` and a legacy hostless
    // key for the page `/example.com/about` would be byte-identical under a
    // single version. The version segment now keeps them apart.
    const hostScoped = isrCacheKey('p', 'D', 'example.com', '/about');
    const legacy = isrLegacyCacheKey('p', 'D', '/example.com/about');
    expect(hostScoped).toBe('p/isr/v3/D/example.com/about');
    expect(legacy).toBe('p/isr/v2/D/example.com/about');
    // Byte-inequality is the whole point — a reader keying on either must not
    // read the other's slot.
    expect(hostScoped).not.toBe(legacy);
    // Concretely: they differ ONLY in the version segment.
    expect(hostScoped.replace('/isr/v3/', '/isr/v2/')).toBe(legacy);
    expect(isrCachePrefix('p', 'D')).toContain('/isr/v3/');
    expect(isrLegacyCachePrefix('p', 'D')).toContain('/isr/v2/');
  });

  it('isrEdgeCacheUrl and isrEdgeCacheUrlForToken agree for the same URL', () => {
    // The purger only knows the hashed token (URL is gone after hashing).
    // It must still reproduce the exact edge-cache URL the writer wrote.
    const original = 'https://app.void.app/docs?utm=x';
    const fromUrl = isrEdgeCacheUrl('app.void.app', '/en/docs', 'dpl_1', 'html', original);
    // Pull the token out of the writer's URL and feed it to the by-token
    // builder — they must produce byte-identical strings.
    const m = /__void_orig=([^&]+)/.exec(fromUrl);
    expect(m).not.toBeNull();
    const token = m![1]!;
    const fromToken = isrEdgeCacheUrlForToken('app.void.app', '/en/docs', 'dpl_1', 'html', token);
    expect(fromToken).toBe(fromUrl);
  });
});
