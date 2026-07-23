import { existsSync, readFileSync, statSync } from 'node:fs';
import type MarkdownExit from 'markdown-exit';
import type { RuleBlock, Token } from 'markdown-exit';
import { resolve, dirname } from 'pathslash';

const rawPathRegexp =
  /^(.+?(?:(?:\.([a-z0-9]+))?))(?:(#[\w-]+))?(?: ?(?:\{(\d+(?:[,-]\d+)*)? ?(\S+)? ?(\S+)?}))? ?(?:\[(.+)\])?$/;

type SnippetToken = {
  filepath: string;
  extension: string;
  region: string;
  lines: string;
  lang: string;
  attrs: string;
  title: string;
};

type FenceRender = (...args: ReadonlyArray<unknown>) => string;

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
    for (let characterIndex = 0; characterIndex < line.length; characterIndex++) {
      if (line[characterIndex] !== ' ' && line[characterIndex] !== '\t') {
        return Math.min(characterIndex, acc);
      }
    }
    return acc;
  }, Infinity);
  if (minIndent < Infinity) {
    return lines.map((line) => line.slice(minIndent)).join('\n');
  }
  return text;
}

type RegionMarker = {
  start: RegExp;
  end: RegExp;
};

const markers: ReadonlyArray<RegionMarker> = [
  { start: /^\/\/\s*#?region\b/, end: /^\/\/\s*#?endregion\b/ },
  { start: /^\/\*\s*#?region\b/, end: /^\/\*\s*#?endregion\b/ },
  { start: /^<!--\s*#?region\b/, end: /^<!--\s*#?endregion\b/ },
  { start: /^#\s*#?region\b/, end: /^#\s*#?endregion\b/ },
  { start: /^#pragma\s+region\b/, end: /^#pragma\s+endregion\b/ },
];

function findRegion(
  lines: ReadonlyArray<string>,
  regionName: string,
): { start: number; end: number; re: RegionMarker } | null {
  for (const marker of markers) {
    for (let startLineIndex = 0; startLineIndex < lines.length; startLineIndex++) {
      const line = lines[startLineIndex].trim();
      if (marker.start.test(line) && line.includes(regionName)) {
        for (let endLineIndex = startLineIndex + 1; endLineIndex < lines.length; endLineIndex++) {
          if (marker.end.test(lines[endLineIndex].trim())) {
            return { start: startLineIndex, end: endLineIndex, re: marker };
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
  const lessThanCharCode = '<'.charCodeAt(0);

  const parser: RuleBlock = (state, startLine, _endLine, silent): boolean => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) {
      return false;
    }
    for (let markerOffset = 0; markerOffset < 3; ++markerOffset) {
      const charCode = state.src.charCodeAt(pos + markerOffset);
      if (charCode !== lessThanCharCode || pos + markerOffset >= max) {
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
  md.renderer.rules.fence = (...args: ReadonlyArray<unknown>) => {
    const [tokens, idx] = args as [ReadonlyArray<Token>, number];
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
            .filter((line) => !(region.re.start.test(line) || region.re.end.test(line)))
            .join('\n'),
        );
      }
    }
    token.content = content;
    return fence(...args);
  };

  md.block.ruler.before('fence', 'snippet', parser);
}
