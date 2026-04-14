import type MarkdownExit from 'markdown-exit';

const markerRE = /^\[!(TIP|NOTE|INFO|IMPORTANT|WARNING|CAUTION|DANGER)\]([^\n\r]*)/i;

export interface GitHubAlertsOptions {
  tipLabel?: string;
  noteLabel?: string;
  infoLabel?: string;
  importantLabel?: string;
  warningLabel?: string;
  cautionLabel?: string;
  dangerLabel?: string;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * GitHub-flavored alerts: > [!NOTE], > [!TIP], > [!WARNING], etc.
 * Ported from VitePress.
 */
export function gitHubAlertsPlugin(md: MarkdownExit, options?: GitHubAlertsOptions): void {
  const titleMark: Record<string, string> = {
    tip: options?.tipLabel ?? 'TIP',
    note: options?.noteLabel ?? 'NOTE',
    info: options?.infoLabel ?? 'INFO',
    important: options?.importantLabel ?? 'IMPORTANT',
    warning: options?.warningLabel ?? 'WARNING',
    caution: options?.cautionLabel ?? 'CAUTION',
    danger: options?.dangerLabel ?? 'DANGER',
  };

  md.core.ruler.after('block', 'github-alerts', (state: any) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'blockquote_open') {
        const startIndex = i;
        const open = tokens[startIndex];
        let endIndex = i + 1;
        while (
          endIndex < tokens.length &&
          (tokens[endIndex].type !== 'blockquote_close' || tokens[endIndex].level !== open.level)
        ) {
          endIndex++;
        }
        if (endIndex === tokens.length) {
          continue;
        }
        const close = tokens[endIndex];
        const firstContent = tokens
          .slice(startIndex, endIndex + 1)
          .find((token: any) => token.type === 'inline');
        if (!firstContent) {
          continue;
        }
        const match = firstContent.content.match(markerRE);
        if (!match) {
          continue;
        }
        const type = match[1].toLowerCase();
        const title = match[2].trim() || titleMark[type] || capitalize(type);
        firstContent.content = firstContent.content.slice(match[0].length).trimStart();
        open.type = 'github_alert_open';
        open.tag = 'div';
        open.meta = { title, type };
        close.type = 'github_alert_close';
        close.tag = 'div';
      }
    }
  });

  md.renderer.rules.github_alert_open = function (tokens: any[], idx: number) {
    const { title, type } = tokens[idx].meta;
    return `<div class="${type} custom-block github-alert"><p class="custom-block-title">${title}</p>\n`;
  };
}
