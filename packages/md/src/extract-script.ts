const SCRIPT_RE = /^<script\b[^>]*>([\s\S]*?)<\/script>\s*\n?/;
const ISLAND_IMPORT_RE =
  /import\s+([$_A-Za-z][$_\w]*)\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*,?\s*\}/g;
const ISLAND_IMPORT_LINE_RE =
  /^[ \t]*import\s+[$_A-Za-z][$_\w]*\s+from\s+(?:"[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*(?:"[^"]+"|'[^']+')\s*,?\s*\}\s*;?\s*$/gm;

export type IslandImport = {
  name: string;
  specifier: string;
  strategy: string;
  /** Root-relative island ID (set during transform when file context is available). */
  islandId?: string;
};

export type ScriptExtraction = Readonly<{
  script: string | null;
  body: string;
  islandImports: Array<IslandImport>;
  clientCode: string | null;
}>;

export function extractScript(source: string): ScriptExtraction {
  const match = source.match(SCRIPT_RE);
  if (!match) {
    return { script: null, body: source, islandImports: [], clientCode: null };
  }

  const script = match[1].trim();
  const body = source.slice(match[0].length);

  const islandImports: Array<IslandImport> = [];
  let importMatch: RegExpExecArray | null;
  while ((importMatch = ISLAND_IMPORT_RE.exec(script)) !== null) {
    islandImports.push({
      name: importMatch[1],
      specifier: importMatch[2].slice(1, -1),
      strategy: importMatch[3].slice(1, -1),
    });
  }

  const stripped = script.replace(ISLAND_IMPORT_LINE_RE, '').trim();
  const clientCode = stripped || null;

  return { script, body, islandImports, clientCode };
}
