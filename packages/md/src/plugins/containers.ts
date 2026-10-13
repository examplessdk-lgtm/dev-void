import type MarkdownExit from 'markdown-exit';
import type { Token } from 'markdown-exit';
import container from 'markdown-it-container';

type MarkdownEnv = {
  references?: Record<string, { title: string; href: string }>;
  [key: string]: unknown;
};

function createContainer(
  md: MarkdownExit,
  klass: string,
  defaultTitle: string,
): [typeof container, string, object] {
  return [
    container,
    klass,
    {
      render(tokens: ReadonlyArray<Token>, idx: number, _options: unknown, env: MarkdownEnv) {
        const token = tokens[idx];
        if (token.nesting === 1) {
          token.attrJoin('class', `${klass} custom-block`);
          const attrs = md.renderer.renderAttrs(token);
          const info = token.info.trim().slice(klass.length).trim();
          const title = md.renderInline(info || defaultTitle, {
            references: env.references,
          });
          const titleClass = 'custom-block-title' + (info ? '' : ' custom-block-title-default');
          if (klass === 'details') {
            return `<details${attrs}><summary>${title}</summary>\n`;
          }
          return `<div${attrs}><p class="${titleClass}">${title}</p>\n`;
        }
        return klass === 'details' ? `</details>\n` : `</div>\n`;
      },
    },
  ];
}

/**
 * Custom container blocks: :::tip, :::info, :::warning, :::danger, :::details
 * Ported from VitePress.
 */
export function containerPlugin(md: MarkdownExit): void {
  md.use(...createContainer(md, 'tip', 'TIP'))
    .use(...createContainer(md, 'info', 'INFO'))
    .use(...createContainer(md, 'warning', 'WARNING'))
    .use(...createContainer(md, 'danger', 'DANGER'))
    .use(...createContainer(md, 'details', 'Details'));
}
