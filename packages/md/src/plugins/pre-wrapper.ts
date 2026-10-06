import type MarkdownExit from 'markdown-exit';
import type { RenderOptions, Renderer, Token } from 'markdown-exit';

type MarkdownEnv = { [key: string]: unknown };
type FenceRender = (
  tokens: ReadonlyArray<Token>,
  idx: number,
  options: RenderOptions,
  env: MarkdownEnv,
  self: Renderer,
) => string | Promise<string>;

function extractLang(info: string): string {
  return (
    /^[a-zA-Z0-9-_]+/
      .exec(info)?.[0]
      .replace(/-vue$/, '')
      .replace(/^vue-html$/, 'template')
      .replace(/^ansi$/, '') || ''
  );
}

export type PreWrapperOptions = Readonly<{
  codeCopyButtonTitle?: string;
}>;

/**
 * Wraps fenced code blocks with a language label and copy button.
 * Ported from VitePress.
 */
export function preWrapperPlugin(md: MarkdownExit, options?: PreWrapperOptions): void {
  const title = options?.codeCopyButtonTitle ?? 'Copy Code';
  const fence = md.renderer.rules.fence as FenceRender;
  md.renderer.rules.fence = async (...args: Parameters<FenceRender>) => {
    const [tokens, idx] = args;
    const token = tokens[idx];
    // Strip title bracket notation before rendering
    token.info = token.info.replace(/\[.*\]/, '');
    // Handle active class for code-group
    const active = / active( |$)/.test(token.info) ? ' active' : '';
    token.info = token.info.replace(/ active$/, '').replace(/ active /, ' ');
    const lang = extractLang(token.info);
    const highlighted = await fence(...args);
    return (
      `<div class="language-${lang}${active}">` +
      `<button title="${title}" class="copy"></button>` +
      `<span class="lang">${lang}</span>` +
      highlighted +
      `</div>`
    );
  };
}
