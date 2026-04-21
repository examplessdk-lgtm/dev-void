import matter from 'gray-matter';
import MarkdownExit from 'markdown-exit';
import type { Token } from 'markdown-exit';
import anchor from 'markdown-it-anchor';
import type { Heading } from './compile';

let metadataCompiler: MarkdownExit | null = null;

function getMetadataCompiler(): MarkdownExit {
  if (metadataCompiler) {
    return metadataCompiler;
  }
  const md = new MarkdownExit({ html: true, linkify: true });
  // @ts-expect-error markdown-it-anchor types reference @types/markdown-it, structurally incompatible with markdown-exit
  md.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });
  metadataCompiler = md;
  return md;
}

function extractHeadings(tokens: Token[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.('id') ?? '';
      const inline = tokens[i + 1];
      const text = (
        inline?.children
          ?.filter((t) => t.type === 'text' || t.type === 'code_inline')
          .map((t) => t.content)
          .join('') ?? ''
      ).trim();
      headings.push({ depth, slug, text });
    }
  }
  return headings;
}

export interface MetadataResult {
  frontmatter: Record<string, unknown>;
  headings: Heading[];
  title: string;
}

export function extractMetadata(source: string): MetadataResult {
  const { data: frontmatter, content } = matter(source);
  const compiler = getMetadataCompiler();

  const env: Record<string, unknown> = {};
  const tokens = compiler.parse(content, env);
  const headings = extractHeadings(tokens);

  const title = (frontmatter.title as string) ?? headings.find((h) => h.depth === 1)?.text ?? '';

  return { frontmatter, headings, title };
}
