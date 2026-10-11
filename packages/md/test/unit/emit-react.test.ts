import { describe, expect, it } from 'vite-plus/test';
import { emitReactComponent } from '../../src/emit-react.ts';
import { makeResult } from '../compile-result-fixture.ts';

describe('emitReactComponent', () => {
  it('emits valid React component code', () => {
    const code = emitReactComponent(makeResult(), []);
    expect(code).toContain('import React from "react"');
    expect(code).toContain('FrontmatterContext');
    expect(code).toContain('dangerouslySetInnerHTML');
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});

describe('emitReactComponent with islands', () => {
  it('emits island imports and wrappers', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More</p>\n',
    });
    const code = emitReactComponent(result, [
      {
        name: 'Counter',
        specifier: './Counter.tsx',
        strategy: 'visible',
        islandId: 'pages/Counter',
      },
    ]);

    expect(code).toContain('import _raw_island_0 from "./Counter.tsx"');
    expect(code).toContain('"data-island"');
    expect(code).toContain('"data-hydrate"');
    expect(code).toContain('"visible"');
    expect(code).toContain('React.createElement(Counter');
  });
});
