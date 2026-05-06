import { describe, expect, it } from 'vitest';
import { serializePageData } from '../../src/pages/serialize.ts';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe('serializePageData', () => {
  it('escapes </script> so the inline script tag cannot be closed early', () => {
    const payload = { html: '</script><script>alert(1)</script>' };
    const out = serializePageData(payload);

    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(JSON.parse(out)).toEqual(payload);
  });

  it('escapes ampersands and U+2028 / U+2029 line separators', () => {
    const payload = { amp: 'a & b', ls: `a${LS}b`, ps: `a${PS}b` };
    const out = serializePageData(payload);

    expect(out).not.toContain('&');
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    expect(JSON.parse(out)).toEqual(payload);
  });
});
