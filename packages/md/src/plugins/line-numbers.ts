import type MarkdownExit from 'markdown-exit';

/**
 * Adds line number gutter to code blocks.
 * Supports `:line-numbers` / `:no-line-numbers` per-block control and `{=N}` start line.
 * Ported from VitePress.
 */
export function lineNumberPlugin(md: MarkdownExit, enable = false): void {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = async (...args: any[]) => {
    const rawCode = await (fence as Function)(...args);
    const [tokens, idx] = args;
    const info = tokens[idx].info;

    if ((!enable && !/:line-numbers\b/.test(info)) || (enable && /:no-line-numbers\b/.test(info))) {
      return rawCode;
    }

    let startLineNumber = 1;
    const matchStart = info.match(/=(\d+)/);
    if (matchStart?.[1]) {
      startLineNumber = parseInt(matchStart[1]);
    }

    const code = rawCode.slice(rawCode.indexOf('<code>'), rawCode.indexOf('</code>'));
    const lines = code.split('\n');
    const lineNumbersCode = [...Array(lines.length)]
      .map((_, i) => `<span class="line-number">${i + startLineNumber}</span><br>`)
      .join('');
    const lineNumbersWrapper = `<div class="line-numbers-wrapper" aria-hidden="true">${lineNumbersCode}</div>`;

    return rawCode
      .replace(/<\/div>$/, `${lineNumbersWrapper}</div>`)
      .replace(/"(language-[^"]*?)"/, '"$1 line-numbers-mode"');
  };
}
