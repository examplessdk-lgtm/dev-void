import { describe, expect, it } from 'vitest';
import { generateRendererModule } from '../../src/plugin-pages.ts';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

// The Vue renderer module is emitted as a template literal, so the
// `serializePageData` it ships only exists in the *generated* source.
// Extract that function from the generated output and exercise it directly,
// the same way it runs at SSR time.
function loadSerializePageData(): (pageObj: unknown) => string {
  const emitted = generateRendererModule(
    { pages: [], layouts: [], namedLayouts: [] },
    '/tmp/void-test-pages',
  );
  const match = emitted.match(/function serializePageData\(pageObj\) \{[\s\S]*?\n\}/);
  if (!match) {
    throw new Error('Could not locate serializePageData in generated renderer module');
  }
  return new Function(`${match[0]}\nreturn serializePageData;`)() as (pageObj: unknown) => string;
}

describe('vue serializePageData (emitted)', () => {
  const serialize = loadSerializePageData();

  it('escapes </script> so the inline script tag cannot be closed early', () => {
    const payload = { html: '</script><script>alert(1)</script>' };
    const out = serialize(payload);

    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(JSON.parse(out)).toEqual(payload);
  });

  it('escapes ampersands and U+2028 / U+2029 line separators', () => {
    const payload = { amp: 'a & b', ls: `a${LS}b`, ps: `a${PS}b` };
    const out = serialize(payload);

    expect(out).not.toContain('&');
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    expect(JSON.parse(out)).toEqual(payload);
  });
});
