import { describe, expect, it } from 'vitest';
import type { CompileResult } from '../../src/compile.ts';
import { emitReactComponent, emitReactComponentWithIslands } from '../../src/emit-react.ts';

function makeResult(overrides?: Partial<CompileResult>): CompileResult {
  return {
    html: '<h1>Hello</h1>\n<p>World</p>\n',
    frontmatter: { title: 'Test' },
    headings: [{ depth: 1, slug: 'hello', text: 'Hello' }],
    title: 'Test',
    ...overrides,
  };
}

describe('emitReactComponent', () => {
  it('emits valid React component code', () => {
    const code = emitReactComponent(makeResult());
    expect(code).toContain('import React from "react"');
    expect(code).toContain('FrontmatterContext');
    expect(code).toContain('dangerouslySetInnerHTML');
  });

  it('exports frontmatter and headings', () => {
    const code = emitReactComponent(makeResult());
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});

describe('emitReactComponentWithIslands', () => {
  it('emits island imports and wrappers', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More</p>\n',
    });
    const code = emitReactComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.tsx', strategy: 'visible' },
    ]);

    expect(code).toContain('import _raw_island_0 from "./Counter.tsx"');
    expect(code).toContain('"data-island"');
    expect(code).toContain('"data-hydrate"');
    expect(code).toContain('"visible"');
    expect(code).toContain('React.createElement(Counter');
  });

  it('exports frontmatter and headings', () => {
    const result = makeResult({
      html: '<Counter />\n',
    });
    const code = emitReactComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.tsx', strategy: 'load' },
    ]);

    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});
