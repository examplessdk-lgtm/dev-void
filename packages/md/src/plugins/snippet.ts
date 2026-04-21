import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type MarkdownExit from 'markdown-exit';
import type { RuleBlock, Token } from 'markdown-exit';

const rawPathRegexp =
  /^(.+?(?:(?:\.([a-z0-9]+))?))(?:(#[\w-]+))?(?: ?(?:\{(\d+(?:[,-]\d+)*)? ?(\S+)? ?(\S+)?}))? ?(?:\[(.+)\])?$/;

interface SnippetToken {
  filepath: string;
  extension: string;
  region: string;
  lines: string;
  lang: string;
  attrs: string;
  title: string;
}

type FenceRender = (...args: unknown[]) => string;

function rawPathToToken(rawPath: string): SnippetToken {
  const [
    filepath = '',
    extension = '',
    region = '',
    lines = '',
    lang = '',
    attrs = '',
    rawTitle = '',
  ] = (rawPathRegexp.exec(rawPath) || []).slice(1);
  const title = rawTitle || filepath.split('/').pop() || '';
  return { filepath, extension, region, lines, lang, attrs, title };
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const minIndent = lines.reduce((acc, line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') {
        return Math.min(i, acc);
      }
    }
    return acc;
  }, Infinity);
  if (minIndent < Infinity) {
    return lines.map((x) => x.slice(minIndent)).join('\n');
  }
  return text;
}

interface RegionMarker {
  start: RegExp;
  end: RegExp;
}

const markers: RegionMarker[] = [
  { start: /^\/\/\s*#?region\b/, end: /^\/\/\s*#?endregion\b/ },
  { start: /^\/\*\s*#?region\b/, end: /^\/\*\s*#?endregion\b/ },
  { start: /^<!--\s*#?region\b/, end: /^<!--\s*#?endregion\b/ },
  { start: /^#\s*#?region\b/, end: /^#\s*#?endregion\b/ },
  { start: /^#pragma\s+region\b/, end: /^#pragma\s+endregion\b/ },
];

function findRegion(
  lines: string[],
  regionName: string,
): { start: number; end: number; re: RegionMarker } | null {
  for (const re of markers) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (re.start.test(line) && line.includes(regionName)) {
        for (let j = i + 1; j < lines.length; j++) {
          if (re.end.test(lines[j].trim())) {
            return { start: i, end: j, re };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Code snippet file imports via `<<< /path/to/file.ext`.
 * Supports region markers, line ranges, and title overrides.
 * Ported from VitePress.
 */
export function snippetPlugin(md: MarkdownExit, srcDir?: string): void {
  const CH = '<'.charCodeAt(0);

  const parser: RuleBlock = (state, startLine, _endLine, silent): boolean => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) {
      return false;
    }
    for (let i = 0; i < 3; ++i) {
      const ch = state.src.charCodeAt(pos + i);
      if (ch !== CH || pos + i >= max) {
        return false;
      }
    }
    if (silent) {
      return true;
    }

    const start = pos + 3;
    const end = state.skipSpacesBack(max, pos);
    const rawPath = state.src
      .slice(start, end)
      .trim()
      .replace(/^@/, srcDir ?? process.cwd())
      .trim();
    const { filepath, extension, region, lines, lang, attrs, title } = rawPathToToken(rawPath);

    state.line = startLine + 1;
    const token = state.push('fence', 'code', 0) as Token & { src?: [string, string] };
    token.info = `${lang || extension}${lines ? `{${lines}}` : ''}${title ? `[${title}]` : ''} ${attrs ?? ''}`;

    const resolvedPath = resolve(
      dirname(state.env?.realPath ?? state.env?.path ?? process.cwd()),
      filepath,
    );
    token.src = [resolvedPath, region.slice(1)];
    token.markup = '```';
    token.map = [startLine, startLine + 1];
    return true;
  };

  const fence = md.renderer.rules.fence as FenceRender;
  md.renderer.rules.fence = (...args: unknown[]) => {
    const [tokens, idx] = args as [Token[], number];
    const token = tokens[idx] as Token & { src?: [string, string] };
    const [src, regionName] = token.src ?? [];
    if (!src) {
      return fence(...args);
    }

    if (!existsSync(src) || !statSync(src).isFile()) {
      token.content = `Code snippet path not found: ${src}`;
      token.info = '';
      return fence(...args);
    }

    let content = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
    if (regionName) {
      const lines = content.split('\n');
      const region = findRegion(lines, regionName);
      if (region) {
        content = dedent(
          lines
            .slice(region.start, region.end)
            .filter((l) => !(region.re.start.test(l) || region.re.end.test(l)))
            .join('\n'),
        );
      }
    }
    token.content = content;
    return fence(...args);
  };

  md.block.ruler.before('fence', 'snippet', parser);
}
