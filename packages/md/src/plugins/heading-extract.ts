import type { RenderOptions, Token } from 'markdown-exit';
import type MarkdownExit from 'markdown-exit';

export interface HeadingData {
  depth: number;
  slug: string;
  text: string;
}

interface MarkdownEnv extends Record<string, unknown> {
  headings?: HeadingData[];
}

/**
 * Extracts heading metadata into env.headings during rendering.
 * Ported from VitePress headersPlugin.
 */
export function headingExtractPlugin(md: MarkdownExit): void {
  const render = md.renderer.render.bind(md.renderer);
  md.renderer.render = (tokens: Token[], options: RenderOptions, env: MarkdownEnv = {}) => {
    env.headings = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'heading_open') {
        const depth = Number(token.tag.slice(1));
        const slug = token.attrGet?.('id') ?? '';
        const inline = tokens[i + 1];
        const text = (
          inline?.children
            ?.filter((child) => child.type === 'text' || child.type === 'code_inline')
            .map((child) => child.content)
            .join('') ?? ''
        ).trim();
        env.headings.push({ depth, slug, text });
      }
    }
    return render(tokens, options, env);
  };
}
