import { describe, expect, it } from 'vite-plus/test';
import { compile } from '../../src/compile.ts';
import { extractMetadata } from '../../src/metadata.ts';

describe('extractMetadata', () => {
  it('extracts headings, title, and frontmatter', () => {
    const result = extractMetadata('---\ntitle: Doc\n---\n\n# Heading\n\n## Section');
    expect(result.title).toBe('Doc');
    expect(result.frontmatter.title).toBe('Doc');
    expect(result.headings).toMatchObject([
      { depth: 1, text: 'Heading', slug: 'heading' },
      { depth: 2, text: 'Section', slug: 'section' },
    ]);
  });

  it('strips footnote refs from heading text/slug to match rendered anchor ids', async () => {
    const source = '## API[^1]\n\nBody[^1].\n\n[^1]: note';

    const meta = extractMetadata(source);
    expect(meta.headings).toMatchObject([{ depth: 2, text: 'API', slug: 'api' }]);

    // The metadata slug must equal the id actually rendered by compile(),
    // so links built from `@void/md/pages` resolve to a real anchor.
    const compiled = await compile(source);
    expect(meta.headings[0]?.slug).toBe(compiled.headings[0]?.slug);
    expect(compiled.html).toContain('id="api"');
  });
});
