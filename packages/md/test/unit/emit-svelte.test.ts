import { describe, expect, it } from 'vitest';
import type { CompileResult } from '../../src/compile.ts';
import { emitSvelteComponent, emitSvelteComponentWithIslands } from '../../src/emit-svelte.ts';

function makeResult(overrides?: Partial<CompileResult>): CompileResult {
  return {
    html: '<h1>Hello</h1>\n<p>World</p>\n',
    frontmatter: { title: 'Test' },
    headings: [{ depth: 1, slug: 'hello', text: 'Hello' }],
    title: 'Test',
    ...overrides,
  };
}

describe('emitSvelteComponent', () => {
  it('emits module exports and runtime frontmatter setup', () => {
    const code = emitSvelteComponent(makeResult());
    expect(code).toContain('<script context="module">');
    expect(code).toContain('export const frontmatter');
    expect(code).toContain('import { setFrontmatter } from "@void/md"');
    expect(code).toContain('setFrontmatter(__frontmatter)');
    expect(code).toContain('{@html');
  });
});

describe('emitSvelteComponentWithIslands', () => {
  it('emits island imports and wrapper markup', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More</p>\n',
    });
    const code = emitSvelteComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.svelte', strategy: 'idle' },
    ]);

    expect(code).toContain('import RawIsland0 from "./Counter.svelte"');
    expect(code).toContain('data-island="./Counter"');
    expect(code).toContain('data-hydrate="idle"');
    expect(code).toContain('<RawIsland0');
    expect(code).toContain('{@html');
  });

  it('exports frontmatter and headings', () => {
    const result = makeResult({
      html: '<Counter />\n',
    });
    const code = emitSvelteComponentWithIslands(result, [
      { name: 'Counter', specifier: './Counter.svelte', strategy: 'load' },
    ]);

    expect(code).toContain('export const frontmatter');
    expect(code).toContain('export const headings');
  });
});
