import { describe, expect, it } from 'vite-plus/test';
import { compile } from '../../src/compile.ts';

describe('compile', () => {
  it('compiles basic markdown to HTML', { timeout: 30_000 }, async () => {
    const result = await compile('# Hello\n\nWorld');
    expect(result.html).toContain('<h1');
    expect(result.html).toContain('Hello');
    expect(result.html).toContain('<p>World</p>');
  });

  it('extracts frontmatter', async () => {
    const result = await compile('---\ntitle: My Page\ndescription: A test\n---\n\n# Content');
    expect(result.frontmatter.title).toBe('My Page');
    expect(result.frontmatter.description).toBe('A test');
    expect(result.title).toBe('My Page');
  });

  it('uses first h1 as title when no frontmatter title', async () => {
    const result = await compile('# Hello World\n\nContent');
    expect(result.title).toBe('Hello World');
  });

  it('extracts headings', async () => {
    const result = await compile('# Title\n\n## Section 1\n\n### Subsection\n\n## Section 2');
    expect(result.headings).toHaveLength(4);
    expect(result.headings[0]).toMatchObject({ depth: 1, text: 'Title' });
    expect(result.headings[1]).toMatchObject({ depth: 2, text: 'Section 1' });
    expect(result.headings[2]).toMatchObject({ depth: 3, text: 'Subsection' });
    expect(result.headings[3]).toMatchObject({ depth: 2, text: 'Section 2' });
  });

  it('applies shiki highlighting to code blocks', async () => {
    const result = await compile('```ts\nconst x = 1;\n```');
    // Shiki produces <pre> with <code> containing <span> elements
    expect(result.html).toContain('<pre');
    expect(result.html).toContain('<code');
    expect(result.html).toContain('<span');
  });

  it('converts emoji shortcodes', async () => {
    const result = await compile('Hello :tada:');
    expect(result.html).toContain('\u{1F389}'); // 🎉
  });

  it('adds anchor links to headings', async () => {
    const result = await compile('## My Heading');
    expect(result.html).toContain('id=');
    expect(result.html).toContain('my-heading');
  });

  it('handles empty source', async () => {
    const result = await compile('');
    expect(result.html).toBe('');
    expect(result.frontmatter).toEqual({});
    expect(result.headings).toEqual([]);
    expect(result.title).toBe('');
  });

  it('handles frontmatter only', async () => {
    const result = await compile('---\ntitle: Test\n---\n');
    expect(result.frontmatter.title).toBe('Test');
    expect(result.title).toBe('Test');
  });
});
