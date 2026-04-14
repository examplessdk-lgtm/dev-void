import type MarkdownExit from 'markdown-exit';

export function extractLang(info: string): string {
  return (
    /^[a-zA-Z0-9-_]+/
      .exec(info)?.[0]
      .replace(/-vue$/, '')
      .replace(/^vue-html$/, 'template')
      .replace(/^ansi$/, '') || ''
  );
}

export function extractTitle(info: string, html = false): string {
  if (html) {
    return info.replace(/<!--[^]*?-->/g, '').match(/data-title="(.*?)"/)?.[1] || '';
  }
  return info.match(/\[(.*)\]/)?.[1] || extractLang(info) || 'txt';
}

export interface PreWrapperOptions {
  codeCopyButtonTitle?: string;
}

/**
 * Wraps fenced code blocks with a language label and copy button.
 * Ported from VitePress.
 */
export function preWrapperPlugin(md: MarkdownExit, options?: PreWrapperOptions): void {
  const title = options?.codeCopyButtonTitle ?? 'Copy Code';
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = async (...args: any[]) => {
    const [tokens, idx] = args;
    const token = tokens[idx];
    // Strip title bracket notation before rendering
    token.info = token.info.replace(/\[.*\]/, '');
    // Handle active class for code-group
    const active = / active( |$)/.test(token.info) ? ' active' : '';
    token.info = token.info.replace(/ active$/, '').replace(/ active /, ' ');
    const lang = extractLang(token.info);
    const highlighted = await (fence as Function)(...args);
    return (
      `<div class="language-${lang}${active}">` +
      `<button title="${title}" class="copy"></button>` +
      `<span class="lang">${lang}</span>` +
      highlighted +
      `</div>`
    );
  };
}
