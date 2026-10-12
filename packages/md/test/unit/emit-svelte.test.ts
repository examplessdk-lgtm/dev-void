import { describe, expect, it } from 'vite-plus/test';
import { emitSvelteComponent } from '../../src/emit-svelte.ts';
import { makeResult } from '../compile-result-fixture.ts';

describe('emitSvelteComponent', () => {
  it('emits module exports and runtime frontmatter setup', () => {
    const code = emitSvelteComponent(makeResult(), []);
    expect(code).toContain('<script context="module">');
    expect(code).toContain('export const frontmatter');
    expect(code).toContain('export const headings');
    expect(code).toContain('import { setFrontmatter } from "@void/md"');
    expect(code).toContain('setFrontmatter(__frontmatter)');
    expect(code).toContain('{@html');
  });
});

describe('emitSvelteComponent with islands', () => {
  it('emits island imports and wrapper markup', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More</p>\n',
    });
    const code = emitSvelteComponent(result, [
      {
        name: 'Counter',
        specifier: './Counter.svelte',
        strategy: 'idle',
        islandId: 'pages/Counter',
      },
    ]);

    expect(code).toContain('import RawIsland0 from "./Counter.svelte"');
    expect(code).toContain('data-island="pages/Counter"');
    expect(code).toContain('data-hydrate="idle"');
    expect(code).toContain('<RawIsland0');
    expect(code).toContain('{@html');
  });
});
