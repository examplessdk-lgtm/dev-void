import type { CompileResult } from '../src/compile.ts';

export function makeResult(overrides?: Partial<CompileResult>): CompileResult {
  return {
    html: '<h1>Hello</h1>\n<p>World</p>\n',
    frontmatter: { title: 'Test' },
    headings: [{ depth: 1, slug: 'hello', text: 'Hello' }],
    title: 'Test',
    ...overrides,
  };
}
