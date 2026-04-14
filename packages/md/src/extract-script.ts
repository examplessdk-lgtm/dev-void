const SCRIPT_RE = /^<script\b[^>]*>([\s\S]*?)<\/script>\s*\n?/;
const ISLAND_IMPORT_RE =
  /import\s+(\w+)\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;
const ISLAND_IMPORT_LINE_RE =
  /^[ \t]*import\s+\w+\s+from\s+(?:"[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*(?:"[^"]+"|'[^']+')\s*\}\s*;?\s*$/gm;

export interface IslandImport {
  name: string;
  specifier: string;
  strategy: string;
  /** Root-relative island ID (set during transform when file context is available). */
  islandId?: string;
}

export interface ScriptExtraction {
  script: string | null;
  body: string;
  islandImports: IslandImport[];
  clientCode: string | null;
}

export function extractScript(source: string): ScriptExtraction {
  const match = source.match(SCRIPT_RE);
  if (!match) {
    return { script: null, body: source, islandImports: [], clientCode: null };
  }

  const script = match[1].trim();
  const body = source.slice(match[0].length);

  const islandImports: IslandImport[] = [];
  let m;
  while ((m = ISLAND_IMPORT_RE.exec(script)) !== null) {
    islandImports.push({
      name: m[1],
      specifier: m[2].slice(1, -1),
      strategy: m[3].slice(1, -1),
    });
  }

  const stripped = script.replace(ISLAND_IMPORT_LINE_RE, '').trim();
  const clientCode = stripped || null;

  return { script, body, islandImports, clientCode };
}
