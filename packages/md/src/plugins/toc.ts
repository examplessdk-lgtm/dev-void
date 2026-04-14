import type MarkdownExit from 'markdown-exit';

export interface TocOptions {
  pattern?: RegExp;
  level?: number[];
  containerTag?: string;
  containerClass?: string;
  listTag?: string;
}

interface Header {
  depth: number;
  slug: string;
  text: string;
}

function renderHeaders(headers: Header[], listTag: string): string {
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
    (state: any, startLine: number, _endLine: number, silent: boolean) => {
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
    },
    { alt: ['paragraph', 'reference', 'blockquote'] },
  );

  md.renderer.rules.toc_open = (tokens: any[], idx: number, options: any, _env: any, self: any) => {
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.toc_body = (tokens: any[]) => {
    // Walk all tokens to find headings at the specified levels
    const headers: Header[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'heading_open') {
        const depth = Number(token.tag.slice(1));
        if (level.includes(depth)) {
          const slug = token.attrGet?.('id') ?? '';
          const inline = tokens[i + 1];
          const text = (
            inline?.children
              ?.filter((t: any) => t.type === 'text' || t.type === 'code_inline')
              .map((t: any) => t.content)
              .join('') ?? ''
          ).trim();
          headers.push({ depth, slug, text });
        }
      }
    }
    return renderHeaders(headers, listTag);
  };

  md.renderer.rules.toc_close = (
    tokens: any[],
    idx: number,
    options: any,
    _env: any,
    self: any,
  ) => {
    return self.renderToken(tokens, idx, options);
  };
}
