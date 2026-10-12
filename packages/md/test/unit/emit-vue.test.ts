import { describe, expect, it } from 'vite-plus/test';
import { emitVueComponent } from '../../src/emit-vue.ts';
import { makeResult } from '../compile-result-fixture.ts';

describe('emitVueComponent', () => {
  it('emits valid Vue component code', () => {
    const code = emitVueComponent(
      makeResult({ html: '<h1>My Title</h1>', frontmatter: { title: 'Page', draft: true } }),
      [],
    );
    expect(code).toContain('defineComponent');
    expect(code).toContain('createStaticVNode');
    expect(code).toContain('provide');
    expect(code).toContain('__void_frontmatter');
    expect(code).toContain('My Title');
    expect(code).toContain('"title":"Page"');
    expect(code).toContain('"draft":true');
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});

describe('emitVueComponent with islands', () => {
  it('emits island wrapper components', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More content</p>\n',
    });
    const code = emitVueComponent(result, [
      {
        name: 'Counter',
        specifier: './Counter.vue',
        strategy: 'visible',
        islandId: 'pages/Counter',
      },
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
    const code = emitVueComponent(result, [
      { name: 'Counter', specifier: './Counter.vue', strategy: 'load', islandId: 'pages/Counter' },
      { name: 'Widget', specifier: './Widget.vue', strategy: 'idle', islandId: 'pages/Widget' },
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
    const code = emitVueComponent(result, [
      { name: 'Counter', specifier: './Counter.vue', strategy: 'load', islandId: 'pages/Counter' },
    ]);
    // Should have createStaticVNode for content before and after the island
    const staticCount = (code.match(/createStaticVNode/g) || []).length;
    expect(staticCount).toBeGreaterThanOrEqual(2);
  });
});
