import { describe, it, expect } from 'vite-plus/test';
import { extractSlug } from '../../src/hostname.ts';

describe('extractSlug', () => {
  it('extracts slug from valid hostname', () => {
    expect(extractSlug('my-app.void.app')).toBe('my-app');
  });

  it('extracts single-word slug', () => {
    expect(extractSlug('hello.void.app')).toBe('hello');
  });

  it('extracts slug with numbers', () => {
    expect(extractSlug('app123.void.app')).toBe('app123');
  });

  it('extracts single-char slug', () => {
    expect(extractSlug('x.void.app')).toBe('x');
  });

  it('returns null for bare domain', () => {
    expect(extractSlug('void.app')).toBeNull();
  });

  it('returns null for nested subdomain', () => {
    expect(extractSlug('foo.bar.void.app')).toBeNull();
  });

  it('returns null for unrelated domain', () => {
    expect(extractSlug('example.com')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractSlug('')).toBeNull();
  });

  it('returns null for slug with leading dash', () => {
    expect(extractSlug('-bad.void.app')).toBeNull();
  });

  it('returns null for slug with trailing dash', () => {
    expect(extractSlug('bad-.void.app')).toBeNull();
  });

  it('returns null for slug with uppercase', () => {
    expect(extractSlug('MyApp.void.app')).toBeNull();
  });

  it('returns null for slug with underscores', () => {
    expect(extractSlug('my_app.void.app')).toBeNull();
  });

  describe('custom baseHostname', () => {
    it('extracts slug from staging hostname', () => {
      expect(extractSlug('my-app.staging.void.app', 'staging.void.app')).toBe('my-app');
    });

    it('returns null for production hostname when expecting staging', () => {
      expect(extractSlug('my-app.void.app', 'staging.void.app')).toBeNull();
    });

    it('returns null for staging hostname when expecting production', () => {
      expect(extractSlug('my-app.staging.void.app', 'void.app')).toBeNull();
    });

    it('returns null for bare staging domain', () => {
      expect(extractSlug('staging.void.app', 'staging.void.app')).toBeNull();
    });

    it('rejects nested subdomains on staging', () => {
      expect(extractSlug('foo.bar.staging.void.app', 'staging.void.app')).toBeNull();
    });

    it('uses default baseHostname when omitted', () => {
      expect(extractSlug('my-app.void.app')).toBe('my-app');
    });
  });
});
