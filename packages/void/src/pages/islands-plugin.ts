import { normalizePath, type ViteDevServer } from "vite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveEffectiveLayoutChain } from "./scan";
import type { PageScanResult } from "./types";

export const ISLANDS_RENDERER_ID = "virtual:void-islands-renderer";
export const ISLANDS_CLIENT_ENTRY_ID = "virtual:void-islands-client";

export interface IslandEntry {
  componentPath: string;
  islandId: string;
  hydrate: string;
}

/** Resolve a relative import specifier to an absolute path by checking extensions. */
export function resolveSpecifier(
  specifier: string,
  importerDir: string,
  extensions: string[],
): string | null {
  const base = normalizePath(resolve(importerDir, specifier));
  for (const ext of extensions) {
    if (existsSync(base + ext)) return base + ext;
  }
  if (existsSync(base)) return base;
  return null;
}

/**
 * Check whether the islands client bundle is needed by scanning file contents.
 * Returns true if any island/layout file has island imports or CSS,
 * or any .md file has a `<script>` block.
 */
export function needsIslandClientBundle(
  dir: string,
  islandFilePattern: RegExp,
  checkStyleBlocks: boolean,
): boolean {
  const importAttrRe = /import\s+\w+\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:/;
  const cssImportRe =
    /import\b[^"']*["'][^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)["']/;
  const mdScriptRe = /^<script\b/m;
  const styleRe = checkStyleBlocks ? /<style\b/ : null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (islandFilePattern.test(name) || name.startsWith("layout.") || name.startsWith("_")) {
        const content = readFileSync(resolve(entry.parentPath!, name), "utf-8");
        if (importAttrRe.test(content)) return true;
        if (styleRe && styleRe.test(content)) return true;
        if (cssImportRe.test(content)) return true;
      }
      if (name.endsWith(".md")) {
        const content = readFileSync(resolve(entry.parentPath!, name), "utf-8");
        if (mdScriptRe.test(content)) return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/** Check if a file has CSS import statements (JS-style imports). */
export function fileHasCssImports(filePath: string): boolean {
  try {
    const code = readFileSync(filePath, "utf-8");
    return /import\b[^"']*["'][^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)["']/.test(
      code,
    );
  } catch {
    return false;
  }
}

/**
 * Rewrite a matched CSS import line so relative specifiers resolve from the
 * virtual module. Absolute and bare specifiers are kept as-is.
 */
export function rewriteCssImportForVirtualModule(
  matchedLine: string,
  specifier: string,
  sourceFilePath: string,
): string {
  if (specifier.startsWith(".")) {
    const absPath = normalizePath(resolve(dirname(sourceFilePath), specifier));
    return `import ${JSON.stringify(absPath)};`;
  }
  return matchedLine.trim() + ";";
}

/** Extract CSS import statements from a file and return them as @import rules. */
export function extractCssImports(filePath: string): string {
  const code = readFileSync(filePath, "utf-8");
  const re =
    /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
  const imports: string[] = [];
  let match;
  while ((match = re.exec(code)) !== null) {
    imports.push(`@import ${JSON.stringify(match[1])};`);
  }
  return imports.join("\n");
}

/** Rebuild islandCssMap from current file contents. */
export function rebuildIslandCssMap(
  pageScan: PageScanResult,
  pagesDir: string,
  islandCssMap: Map<string, string[]>,
  fileHasCssFn: (filePath: string) => boolean,
): void {
  islandCssMap.clear();
  for (const page of pageScan.pages) {
    if (!page.island) continue;
    const cssPaths: string[] = [];
    const layoutChain = resolveEffectiveLayoutChain(page, pageScan.layouts, pageScan.namedLayouts);
    for (const layout of layoutChain) {
      const layoutPath = resolve(pagesDir, layout.filePath);
      if (fileHasCssFn(layoutPath)) cssPaths.push(layoutPath);
    }
    const pagePath = resolve(pagesDir, page.componentPath);
    if (fileHasCssFn(pagePath)) cssPaths.push(pagePath);
    if (cssPaths.length > 0) {
      islandCssMap.set(page.componentId, cssPaths);
    }
  }
}

/** Compute which island pages need client-side JavaScript. */
export function computePagesNeedingClientJS(
  pageScan: PageScanResult,
  pagesDir: string,
  resolvedConfig: any,
): Set<string> {
  const mdPlugin = resolvedConfig?.plugins?.find((p: any) => p.name === "void-md");
  const mdScriptIds: Set<string> = new Set(mdPlugin?.api?.getClientScripts?.()?.keys() ?? []);

  const importAttrRe =
    /import\s+\w+\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;

  const layoutDirsWithIslands = new Set<string>();
  for (const layout of pageScan.layouts) {
    if (!layout.island) continue;
    const filePath = resolve(pagesDir, layout.filePath);
    const code = readFileSync(filePath, "utf-8");
    importAttrRe.lastIndex = 0;
    if (importAttrRe.test(code)) {
      layoutDirsWithIslands.add(layout.directory);
    }
  }

  const result = new Set<string>();
  for (const page of pageScan.pages) {
    if (!page.island) continue;

    if (mdScriptIds.has(page.componentId)) {
      result.add(page.componentId);
      continue;
    }

    const filePath = resolve(pagesDir, page.componentPath);
    const code = readFileSync(filePath, "utf-8");
    importAttrRe.lastIndex = 0;
    if (importAttrRe.test(code)) {
      result.add(page.componentId);
      continue;
    }

    const layoutChain = resolveEffectiveLayoutChain(page, pageScan.layouts, pageScan.namedLayouts);
    for (const layout of layoutChain) {
      if (layoutDirsWithIslands.has(layout.directory)) {
        result.add(page.componentId);
        break;
      }
    }
  }

  return result;
}

/**
 * Configure the Vite dev server for island CSS serving.
 * Sets up file watching and a middleware for serving virtual CSS modules.
 */
export function configureIslandCssServer(
  server: ViteDevServer,
  islandCssFiles: Set<string>,
  viteRoot: string,
  rebuildCssMap: () => void,
): void {
  server.watcher.on("change", (path) => {
    const normalizedPath = normalizePath(path);
    if (!islandCssFiles.has(normalizedPath)) return;
    rebuildCssMap();
    for (const env of Object.values(server.environments)) {
      const mod = env.moduleGraph.getModuleById("\0" + ISLANDS_RENDERER_ID);
      if (mod) env.moduleGraph.invalidateModule(mod);
    }
    const cssMod = server.environments.client?.moduleGraph.getModuleById(normalizedPath + ".css");
    if (cssMod) server.environments.client.moduleGraph.invalidateModule(cssMod);
  });

  server.middlewares.use(async (req, res, next) => {
    if (!req.url) return next();
    const url = req.url.split("?")[0];
    if (!url.endsWith(".css")) return next();
    const srcPath = normalizePath(resolve(viteRoot, url.slice(1, -4)));
    if (!islandCssFiles.has(srcPath)) return next();
    try {
      const result = await server.environments.client.transformRequest(url);
      if (result) {
        const m =
          result.code.match(/\b__vite__css\s*=\s*("(?:[^"\\]|\\.)*")/) ||
          result.code.match(/export\s+default\s+("(?:[^"\\]|\\.)*")/);
        if (m) {
          res.setHeader("Content-Type", "text/css");
          res.statusCode = 200;
          res.end(JSON.parse(m[1]));
          return;
        }
      }
    } catch {
      // fall through
    }
    next();
  });
}
