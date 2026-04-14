import type { CompileResult } from './compile';
import { buildRenderChunks, toIslandId } from './emit-shared';
import type { IslandImport } from './extract-script';

export function emitReactComponent(result: CompileResult): string {
  return `
import React from "react";
import { FrontmatterContext } from "@void/md";

const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};
const __html = ${JSON.stringify(result.html)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default function MarkdownPage() {
  return React.createElement(
    FrontmatterContext.Provider,
    { value: __frontmatter },
    React.createElement("div", { dangerouslySetInnerHTML: { __html: __html } })
  );
}
`;
}

export function emitReactComponentWithIslands(
  result: CompileResult,
  islandImports: IslandImport[],
): string {
  const chunks = buildRenderChunks(result.html, islandImports);

  let code = `import React from "react";\n`;
  code += `import { FrontmatterContext } from "@void/md";\n`;

  for (let i = 0; i < islandImports.length; i++) {
    const item = islandImports[i];
    code += `import _raw_island_${i} from ${JSON.stringify(item.specifier)};\n`;
  }

  for (let i = 0; i < islandImports.length; i++) {
    const item = islandImports[i];
    code += `function ${item.name}(props) {
  return React.createElement(
    "div",
    {
      "data-island": ${JSON.stringify(toIslandId(item))},
      "data-props": JSON.stringify(props),
      "data-hydrate": ${JSON.stringify(item.strategy)}
    },
    React.createElement(_raw_island_${i}, props)
  );
}\n`;
  }

  const children: string[] = [];

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      children.push(
        `React.createElement("div", { dangerouslySetInnerHTML: { __html: ${JSON.stringify(chunk.html)} } })`,
      );
    } else {
      const propsCode = Object.keys(chunk.props).length > 0 ? JSON.stringify(chunk.props) : 'null';
      children.push(`React.createElement(${chunk.islandImport.name}, ${propsCode})`);
    }
  }

  if (children.length === 0) {
    children.push('null');
  }

  code += `
const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default function MarkdownPage() {
  return React.createElement(
    FrontmatterContext.Provider,
    { value: __frontmatter },
    React.createElement(
      React.Fragment,
      null,
      ${children.join(',\n      ')}
    )
  );
}
`;

  return code;
}
