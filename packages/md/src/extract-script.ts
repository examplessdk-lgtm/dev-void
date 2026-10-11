import { editIslandSource, findIslandImports } from 'void/pages-islands-plugin';

const SCRIPT_RE = /^<script\b[^>]*>([\s\S]*?)<\/script>\s*\n?/;

export type IslandImport = {
  name: string;
  specifier: string;
  strategy: string;
};

export type ScriptExtraction = Readonly<{
  body: string;
  islandImports: ReadonlyArray<IslandImport>;
  clientCode: string | null;
}>;

export function extractScript(source: string): ScriptExtraction {
  const match = source.match(SCRIPT_RE);
  if (!match) {
    return { body: source, islandImports: [], clientCode: null };
  }

  const script = match[1].trim();
  const body = source.slice(match[0].length);

  const imports = findIslandImports(script, 'page.md-script.ts');
  const islandImports: Array<IslandImport> = imports.map((entry) => ({
    name: entry.importName,
    specifier: entry.specifier,
    strategy: entry.hydrate,
  }));
  const stripped =
    imports.length > 0
      ? editIslandSource(
          script,
          imports.map((entry) => ({ start: entry.start, end: entry.end, text: '' })),
        ).code.trim()
      : script;
  const clientCode = stripped || null;

  return { body, islandImports, clientCode };
}
