import type { RuleBlock, StateBlock, Token } from 'markdown-exit';
import type MarkdownExit from 'markdown-exit';
import type { Heading } from '../compile.ts';
import { extractHeadings } from '../metadata.ts';

export type TocOptions = Readonly<{
  pattern?: RegExp;
  level?: ReadonlyArray<number>;
  containerTag?: string;
  containerClass?: string;
  listTag?: string;
}>;

function renderHeaders(headers: ReadonlyArray<Heading>, listTag: string): string {
  if (headers.length === 0) {
    return '';
  }

  let result = `<${listTag}>`;
  for (const h of headers) {
    result += `<li><a href="#${h.slug}">${h.text}</a></li>`;
  }
  result += `</${listTag}>`;
  return result;
}

/**
 * [[toc]] directive — renders inline table of contents.
 * Ported from VitePress.
 */
export function tocPlugin(md: MarkdownExit, options?: TocOptions): void {
  const pattern = options?.pattern ?? /^\[\[toc\]\]$/i;
  const containerTag = options?.containerTag ?? 'nav';
  const containerClass = options?.containerClass ?? 'table-of-contents';
  const listTag = options?.listTag ?? 'ul';
  const level = options?.level ?? [2, 3];

  md.block.ruler.before(
    'heading',
    'toc',
    ((state: StateBlock, startLine: number, _endLine: number, silent: boolean) => {
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const content = state.src.slice(pos, max).trim();

      if (!pattern.test(content)) {
        return false;
      }
      if (silent) {
        return true;
      }

      state.line = startLine + 1;
      const openToken = state.push('toc_open', containerTag, 1);
      openToken.markup = content;
      openToken.attrSet('class', containerClass);

      const bodyToken = state.push('toc_body', '', 0);
      bodyToken.markup = content;

      const closeToken = state.push('toc_close', containerTag, -1);
      closeToken.markup = content;

      return true;
    }) satisfies RuleBlock,
    { alt: ['paragraph', 'reference', 'blockquote'] },
  );

  md.renderer.rules.toc_body = (tokens: Array<Token>) => {
    const headers = extractHeadings(tokens).filter((heading) => level.includes(heading.depth));
    return renderHeaders(headers, listTag);
  };
}
