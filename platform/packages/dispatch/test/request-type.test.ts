import { describe, expect, it } from 'vite-plus/test';
import { classifyDynamicRequestType, hasExtension } from '../src/request-type.ts';

describe('hasExtension', () => {
  it('is true when the final segment contains a dot', () => {
    expect(hasExtension('/foo/bar.js')).toBe(true);
  });

  it('is true for a bare filename with an extension', () => {
    expect(hasExtension('/style.css')).toBe(true);
  });

  it('is false when the final segment has no dot', () => {
    expect(hasExtension('/foo/bar')).toBe(false);
  });

  it('is false for an api-style path with no extension', () => {
    expect(hasExtension('/api/x')).toBe(false);
  });

  it('is false for the root path', () => {
    expect(hasExtension('/')).toBe(false);
  });

  it('is false when the dot is only in a non-final segment', () => {
    expect(hasExtension('/a.b/c')).toBe(false);
  });
});

describe('classifyDynamicRequestType', () => {
  it("classifies '/api/*' as 'api' even when not ssr", () => {
    expect(classifyDynamicRequestType('/api/users', false)).toBe('api');
  });

  it("classifies exact '/api' as 'api' (api wins even when ssr)", () => {
    expect(classifyDynamicRequestType('/api', true)).toBe('api');
  });

  it("classifies an ssr, extension-less path as 'ssr'", () => {
    expect(classifyDynamicRequestType('/dashboard', true)).toBe('ssr');
  });

  it('returns null for an ssr path that has a file extension (keep default)', () => {
    expect(classifyDynamicRequestType('/logo.png', true)).toBe(null);
  });

  it("classifies an ssr path with a file extension as 'ssr' when the app answered", () => {
    expect(classifyDynamicRequestType('/sponsors.svg', true, true)).toBe('ssr');
  });

  it('returns null for an ssr path with a file extension the app did not answer', () => {
    expect(classifyDynamicRequestType('/logo.png', true, false)).toBe(null);
  });

  it('returns null for a non-ssr path the app answered (keep default)', () => {
    expect(classifyDynamicRequestType('/sponsors.svg', false, true)).toBe(null);
  });

  it("classifies an '/api' path with a file extension as 'api' when the app answered", () => {
    expect(classifyDynamicRequestType('/api/data.json', true, true)).toBe('api');
  });

  it('returns null for a non-ssr dynamic path (keep default)', () => {
    expect(classifyDynamicRequestType('/dashboard', false)).toBe(null);
  });

  it('returns null when ssr is undefined (keep default)', () => {
    expect(classifyDynamicRequestType('/dashboard', undefined)).toBe(null);
  });
});
