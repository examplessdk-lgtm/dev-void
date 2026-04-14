import type MarkdownExit from 'markdown-exit';

const EXTERNAL_URL_RE = /^[a-z]+:/i;

export interface ImageOptions {
  lazyLoading?: boolean;
}

/**
 * Normalizes relative image paths and optionally adds loading="lazy".
 * Ported from VitePress.
 */
export function imagePlugin(md: MarkdownExit, options?: ImageOptions): void {
  const imageRule = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens: any[], idx: number, mdOptions: any, env: any, self: any) => {
    const token = tokens[idx];
    let url = token.attrGet('src');
    if (url && !EXTERNAL_URL_RE.test(url)) {
      if (!/^\.?\//.test(url)) {
        url = './' + url;
      }
      token.attrSet('src', decodeURIComponent(url));
    }
    if (options?.lazyLoading) {
      token.attrSet('loading', 'lazy');
    }
    return (imageRule as Function)(tokens, idx, mdOptions, env, self);
  };
}
