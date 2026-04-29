import { describe, expect, it } from 'vitest';
import type { CompileResult } from '../../src/compile.ts';
import { emitVueComponent, emitVueComponentWithIslands } from '../../src/emit-vue.ts';

function makeResult(overrides?: Partial<CompileResult>): CompileResult {
  return {
    html: '<h1>Hello</h1>\n<p>World</p>\n',
    frontmatter: { title: 'Test' },
    headings: [{ depth: 1, slug: 'hello', text: 'Hello' }],
    title: 'Test',
    ...overrides,
  };
}

describe('emitVueComponent', () => {
  it('emits valid Vue component code', () => {
    const code = emitVueComponent(makeResult());
    expect(code).toContain('defineComponent');
    expect(code).toContain('createStaticVNode');
    expect(code).toContain('provide');
    expect(code).toContain('__void_frontmatter');
  });

  it('exports frontmatter and headings', () => {
    const code = emitVueComponent(makeResult());
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });

  it('includes HTML in static vnode', () => {
    const code = emitVueComponent(makeResult({ html: '<h1>My Title</h1>' }));
    expect(code).toContain('My Title');
  });

  it('serializes frontmatter as JSON', () => {
    const code = emitVueComponent(makeResult({ frontmatter: { title: 'Page', draft: true } }));
    expect(code).toContain('"title":"Page"');
    expect(code).toContain('"draft":true');
  });
});

describe('emitVueComponentWithIslands', () => {
  it('emits island wrapper components', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More content</p>\n',
    });
    const code = emitVueComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.vue', strategy: 'visible' },
    ]);
    expect(code).toContain('import _raw_island_0 from "./Counter.vue"');
    expect(code).toContain('data-island');
    expect(code).toContain('data-hydrate');
    expect(code).toContain('"visible"');
    expect(code).toContain('h(Counter');
  });

  it('handles multiple island components', () => {
    const result = makeResult({
      html: '<Counter />\n<Widget />\n',
    });
    const code = emitVueComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.vue', strategy: 'load' },
      { name: 'Widget', specifier: './Widget.vue', strategy: 'idle' },
    ]);
    expect(code).toContain('import _raw_island_0 from "./Counter.vue"');
    expect(code).toContain('import _raw_island_1 from "./Widget.vue"');
    expect(code).toContain('h(Counter');
    expect(code).toContain('h(Widget');
  });

  it('interleaves static HTML with island vnodes', () => {
    const result = makeResult({
      html: '<h1>Title</h1>\n<Counter />\n<p>After</p>\n',
    });
    const code = emitVueComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.vue', strategy: 'load' },
    ]);
    // Should have createStaticVNode for content before and after the island
    const staticCount = (code.match(/createStaticVNode/g) || []).length;
    expect(staticCount).toBeGreaterThanOrEqual(2);
  });

  it('exports frontmatter and headings', () => {
    const result = makeResult({
      html: '<Counter />\n',
    });
    const code = emitVueComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.vue', strategy: 'load' },
    ]);
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});
