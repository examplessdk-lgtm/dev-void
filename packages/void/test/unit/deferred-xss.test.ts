import { describe, it, expect } from 'vite-plus/test';
import { safeJsonStringify } from '../../src/pages/protocol.ts';

describe('deferred data XSS prevention (real implementation)', () => {
  it('escapes </script> in string values', () => {
    const malicious = { name: '</script><script>alert(1)</script>' };
    const result = safeJsonStringify(malicious);
    expect(result).not.toContain('</script>');
    expect(result).toContain('\\u003c/script\\u003e');
  });

  it('escapes < and > characters', () => {
    const result = safeJsonStringify('<img onerror=alert(1)>');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('escapes & character', () => {
    const result = safeJsonStringify('a&b');
    expect(result).toContain('\\u0026');
  });

  it('preserves normal data', () => {
    const data = { name: 'hello world', count: 42, nested: { ok: true } };
    const result = safeJsonStringify(data);
    expect(JSON.parse(result)).toEqual(data);
  });

  it('escapes unicode line/paragraph separators', () => {
    const result = safeJsonStringify('line\u2028para\u2029');
    expect(result).not.toContain('\u2028');
    expect(result).not.toContain('\u2029');
  });

  it('handles undefined without throwing', () => {
    const result = safeJsonStringify(undefined);
    expect(result).toBe('null');
  });

  it('handles function values without throwing', () => {
    const result = safeJsonStringify(() => {});
    expect(result).toBe('null');
  });
});
