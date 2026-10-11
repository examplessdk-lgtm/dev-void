import { describe, expect, it } from 'vite-plus/test';
import { emitSolidComponent } from '../../src/emit-solid.ts';
import { makeResult } from '../compile-result-fixture.ts';

describe('emitSolidComponent', () => {
  it('emits valid Solid component code', () => {
    const code = emitSolidComponent(makeResult(), []);
    expect(code).toContain('FrontmatterContext.Provider');
    expect(code).toContain('innerHTML');
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});

describe('emitSolidComponent with islands', () => {
  it('emits island imports and wrapper markup', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More</p>\n',
    });
    const code = emitSolidComponent(result, [
      {
        name: 'Counter',
        specifier: './Counter.tsx',
        strategy: 'visible',
        islandId: 'pages/Counter',
      },
    ]);

    expect(code).toContain('import RawIsland0 from "./Counter.tsx"');
    expect(code).toContain('data-island="pages/Counter"');
    expect(code).toContain('data-hydrate="visible"');
    expect(code).toContain('<RawIsland0');
  });
});
