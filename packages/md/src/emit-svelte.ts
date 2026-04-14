import type { CompileResult } from './compile';
import { buildRenderChunks, toIslandId } from './emit-shared';
import type { IslandImport } from './extract-script';

function toSvelteLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

export function emitSvelteComponent(result: CompileResult): string {
  const frontmatter = toSvelteLiteral(result.frontmatter);
  const headings = toSvelteLiteral(result.headings);
  const html = toSvelteLiteral(result.html);

  return `<script context="module">
export const frontmatter = ${frontmatter};
export const headings = ${headings};
</script>

<script>
import { setFrontmatter } from "@void/md";

const __frontmatter = ${frontmatter};
setFrontmatter(__frontmatter);
</script>

{@html ${html}}
`;
}

export function emitSvelteComponentWithIslands(
  result: CompileResult,
  islandImports: IslandImport[],
): string {
  const chunks = buildRenderChunks(result.html, islandImports);

  const importAliasByName = new Map<string, string>();
  const frontmatter = toSvelteLiteral(result.frontmatter);
  const headings = toSvelteLiteral(result.headings);

  let source = `<script context="module">
export const frontmatter = ${frontmatter};
export const headings = ${headings};
</script>

<script>
import { setFrontmatter } from "@void/md";
`;

  for (let i = 0; i < islandImports.length; i++) {
    const item = islandImports[i];
    const alias = `RawIsland${i}`;
    importAliasByName.set(item.name, alias);
    source += `import ${alias} from ${JSON.stringify(item.specifier)};
`;
  }

  source += `
const __frontmatter = ${frontmatter};
setFrontmatter(__frontmatter);
`;

  const body: string[] = [];
  let index = 0;

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      body.push(`{@html ${toSvelteLiteral(chunk.html)}}`);
      continue;
    }

    const propsName = `__island_props_${index++}`;
    const alias = importAliasByName.get(chunk.islandImport.name) ?? chunk.islandImport.name;
    const propsLiteral = Object.keys(chunk.props).length > 0 ? toSvelteLiteral(chunk.props) : '{}';
    source += `const ${propsName} = ${propsLiteral};
`;
    body.push(
      `<div data-island="${toIslandId(chunk.islandImport)}" data-props={JSON.stringify(${propsName})} data-hydrate="${chunk.islandImport.strategy}"><${alias} {...${propsName}} /></div>`,
    );
  }

  source += `</script>

${body.join('\n')}
`;

  return source;
}
