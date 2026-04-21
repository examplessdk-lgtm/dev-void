import type MarkdownExit from 'markdown-exit';

const EXTERNAL_URL_RE = /^[a-z]+:/i;

export interface ImageOptions {
  lazyLoading?: boolean;
}

interface MarkdownToken {
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}

type ImageRenderRule = (
  tokens: MarkdownToken[],
  idx: number,
  mdOptions: unknown,
  env: unknown,
  self: unknown,
) => string;

/**
 * Normalizes relative image paths and optionally adds loading="lazy".
 * Ported from VitePress.
 */
export function imagePlugin(md: MarkdownExit, options?: ImageOptions): void {
  const imageRule = md.renderer.rules.image as ImageRenderRule;
  md.renderer.rules.image = (
    tokens: MarkdownToken[],
    idx: number,
    mdOptions: unknown,
    env: unknown,
    self: unknown,
  ) => {
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
    return imageRule(tokens, idx, mdOptions, env, self);
  };
}
