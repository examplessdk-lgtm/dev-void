import type { CompileResult } from './compile';
import { toIslandId } from './emit-shared';
import type { IslandImport } from './extract-script';

export function emitVueComponent(result: CompileResult): string {
  return `
import { defineComponent, createStaticVNode, provide } from "vue";

const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};
const __html = ${JSON.stringify(result.html)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default defineComponent({
  setup() {
    provide("__void_frontmatter", __frontmatter);
    return () => createStaticVNode(__html, 1);
  }
});
`;
}

// Match self-closing uppercase tags: <Counter />, <Counter attr="val" />
// and paired uppercase tags: <Counter>...</Counter>
const ISLAND_TAG_RE =
  /<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)\/\s*>|<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\3\s*>/g;

interface IslandMatch {
  name: string;
  start: number;
  end: number;
  attrs: string;
  children: string;
}

function findIslandTags(html: string, names: Set<string>): IslandMatch[] {
  const matches: IslandMatch[] = [];
  let m;
  ISLAND_TAG_RE.lastIndex = 0;
  while ((m = ISLAND_TAG_RE.exec(html)) !== null) {
    const name = m[1] ?? m[3];
    if (names.has(name)) {
      matches.push({
        name,
        start: m.index,
        end: m.index + m[0].length,
        attrs: (m[2] ?? m[4] ?? '').trim(),
        children: m[5] ?? '',
      });
    }
  }
  return matches;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    result[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return result;
}

export function emitVueComponentWithIslands(
  result: CompileResult,
  islandImports: IslandImport[],
): string {
  const nameSet = new Set(islandImports.map((i) => i.name));
  const islandTags = findIslandTags(result.html, nameSet);

  let code = `import { defineComponent, h, createStaticVNode, provide } from "vue";\n`;

  // Import raw island components
  for (let i = 0; i < islandImports.length; i++) {
    const imp = islandImports[i];
    code += `import _raw_island_${i} from ${JSON.stringify(imp.specifier)};\n`;
  }

  // Create island wrapper components
  for (let i = 0; i < islandImports.length; i++) {
    const imp = islandImports[i];
    code += `const ${imp.name} = { inheritAttrs: false, render() {
  const props = this.$attrs;
  return h("div", {
    "data-island": ${JSON.stringify(toIslandId(imp))},
    "data-props": JSON.stringify(props),
    "data-hydrate": ${JSON.stringify(imp.strategy)}
  }, h(_raw_island_${i}, props));
}};\n`;
  }

  // Build render function that interleaves static segments and island vnodes
  const vnodes: string[] = [];
  let cursor = 0;

  for (const tag of islandTags) {
    // Static HTML before this island tag
    if (tag.start > cursor) {
      const segment = result.html.slice(cursor, tag.start);
      if (segment.trim()) {
        vnodes.push(`createStaticVNode(${JSON.stringify(segment)}, 1)`);
      }
    }

    const attrs = parseAttrs(tag.attrs);
    const propsStr = Object.keys(attrs).length > 0 ? JSON.stringify(attrs) : 'null';
    // Use the wrapper component
    vnodes.push(`h(${tag.name}, ${propsStr})`);

    cursor = tag.end;
  }

  // Remaining HTML after last island tag
  if (cursor < result.html.length) {
    const segment = result.html.slice(cursor);
    if (segment.trim()) {
      vnodes.push(`createStaticVNode(${JSON.stringify(segment)}, 1)`);
    }
  }

  code += `
const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default defineComponent({
  setup() {
    provide("__void_frontmatter", __frontmatter);
    return () => [
      ${vnodes.join(',\n      ')}
    ];
  }
});
`;

  return code;
}
