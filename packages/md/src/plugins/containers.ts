import type MarkdownExit from 'markdown-exit';
import container from 'markdown-it-container';

export interface ContainerOptions {
  tipLabel?: string;
  infoLabel?: string;
  warningLabel?: string;
  dangerLabel?: string;
  detailsLabel?: string;
}

function createContainer(
  md: MarkdownExit,
  klass: string,
  defaultTitle: string,
): [typeof container, string, object] {
  return [
    container,
    klass,
    {
      render(tokens: any[], idx: number, _options: unknown, env: any) {
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
export function containerPlugin(md: MarkdownExit, options?: ContainerOptions): void {
  md.use(...createContainer(md, 'tip', options?.tipLabel ?? 'TIP'))
    .use(...createContainer(md, 'info', options?.infoLabel ?? 'INFO'))
    .use(...createContainer(md, 'warning', options?.warningLabel ?? 'WARNING'))
    .use(...createContainer(md, 'danger', options?.dangerLabel ?? 'DANGER'))
    .use(...createContainer(md, 'details', options?.detailsLabel ?? 'Details'));
}
