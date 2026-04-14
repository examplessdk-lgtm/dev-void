import type { IslandImport } from './extract-script';

// Match self-closing uppercase tags: <Counter />, <Counter attr="val" />
// and paired uppercase tags: <Counter>...</Counter>
const ISLAND_TAG_RE =
  /<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)\/\s*>|<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\3\s*>/g;

interface IslandMatch {
  name: string;
  start: number;
  end: number;
  attrs: string;
}

interface HtmlChunk {
  type: 'html';
  html: string;
}

interface IslandChunk {
  type: 'island';
  islandImport: IslandImport;
  props: Record<string, string>;
}

export type RenderChunk = HtmlChunk | IslandChunk;

function findIslandTags(html: string, names: Set<string>): IslandMatch[] {
  const matches: IslandMatch[] = [];
  let match: RegExpExecArray | null;
  ISLAND_TAG_RE.lastIndex = 0;
  while ((match = ISLAND_TAG_RE.exec(html)) !== null) {
    const name = match[1] ?? match[3];
    if (names.has(name)) {
      matches.push({
        name,
        start: match.index,
        end: match.index + match[0].length,
        attrs: (match[2] ?? match[4] ?? '').trim(),
      });
    }
  }
  return matches;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const attrRe = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrStr)) !== null) {
    result[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

export function toIslandId(imp: IslandImport): string {
  return imp.islandId ?? imp.specifier.replace(/\.[^.]+$/, '');
}

export function buildRenderChunks(html: string, islandImports: IslandImport[]): RenderChunk[] {
  const islandByName = new Map(islandImports.map((item) => [item.name, item]));
  const tags = findIslandTags(html, new Set(islandByName.keys()));

  const chunks: RenderChunk[] = [];
  let cursor = 0;

  for (const tag of tags) {
    if (tag.start > cursor) {
      const segment = html.slice(cursor, tag.start);
      if (segment.trim()) {
        chunks.push({ type: 'html', html: segment });
      }
    }

    const islandImport = islandByName.get(tag.name);
    if (islandImport) {
      chunks.push({
        type: 'island',
        islandImport,
        props: parseAttrs(tag.attrs),
      });
    }

    cursor = tag.end;
  }

  if (cursor < html.length) {
    const segment = html.slice(cursor);
    if (segment.trim()) {
      chunks.push({ type: 'html', html: segment });
    }
  }

  return chunks;
}
