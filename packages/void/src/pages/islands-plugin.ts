import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'pathe';
import { normalizePath, type ResolvedConfig, type ViteDevServer } from 'vite';
import { resolveEffectiveLayoutChain, scanPages } from './scan.ts';
import type { PageScanResult } from './types.ts';

export const ISLANDS_RENDERER_ID = 'virtual:void-islands-renderer';
export const ISLANDS_CLIENT_ENTRY_ID = 'virtual:void-islands-client';

export interface IslandEntry {
  componentPath: string;
  islandId: string;
  hydrate: string;
}

interface VoidMdPluginApi {
  getClientScripts?(): Map<string, unknown>;
}

interface VoidMdPlugin {
  name: string;
  api?: VoidMdPluginApi;
}

/** Resolve a relative import specifier to an absolute path by checking extensions. */
export function resolveSpecifier(
  specifier: string,
  importerDir: string,
  extensions: Array<string>,
): string | null {
  const base = normalizePath(resolve(importerDir, specifier));
  for (const ext of extensions) {
    if (existsSync(base + ext)) {
      return base + ext;
    }
  }
  if (existsSync(base)) {
    return base;
  }
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
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name;
      if (islandFilePattern.test(name) || name.startsWith('layout.') || name.startsWith('_')) {
        const content = readFileSync(resolve(entry.parentPath!, name), 'utf-8');
        if (importAttrRe.test(content)) {
          return true;
        }
        if (styleRe && styleRe.test(content)) {
          return true;
        }
        if (cssImportRe.test(content)) {
          return true;
        }
      }
      if (name.endsWith('.md')) {
        const content = readFileSync(resolve(entry.parentPath!, name), 'utf-8');
        if (mdScriptRe.test(content)) {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
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
  if (specifier.startsWith('.')) {
    const absPath = normalizePath(resolve(dirname(sourceFilePath), specifier));
    return `import ${JSON.stringify(absPath)};`;
  }
  return matchedLine.trim() + ';';
}

/** Extract CSS import statements from a file and return them as @import rules. */
export function extractCssImports(filePath: string): string {
  const code = readFileSync(filePath, 'utf-8');
  const re =
    /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
  const imports: Array<string> = [];
  let match;
  while ((match = re.exec(code)) !== null) {
    imports.push(`@import ${JSON.stringify(match[1])};`);
  }
  return imports.join('\n');
}

/** Compute which island pages need client-side JavaScript. */
export function computePagesNeedingClientJS(
  pageScan: PageScanResult,
  pagesDir: string,
  resolvedConfig: ResolvedConfig | null,
): Set<string> {
  const mdPlugin = resolvedConfig?.plugins?.find(
    (plugin): plugin is VoidMdPlugin => plugin.name === 'void-md',
  );
  const mdScriptIds: Set<string> = new Set(mdPlugin?.api?.getClientScripts?.()?.keys() ?? []);

  const importAttrRe =
    /import\s+\w+\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;

  const layoutDirsWithIslands = new Set<string>();
  for (const layout of pageScan.layouts) {
    if (!layout.island) {
      continue;
    }
    const filePath = resolve(pagesDir, layout.filePath);
    const code = readFileSync(filePath, 'utf-8');
    importAttrRe.lastIndex = 0;
    if (importAttrRe.test(code)) {
      layoutDirsWithIslands.add(layout.directory);
    }
  }

  const result = new Set<string>();
  for (const page of pageScan.pages) {
    if (!page.island) {
      continue;
    }

    if (mdScriptIds.has(page.componentId)) {
      result.add(page.componentId);
      continue;
    }

    const filePath = resolve(pagesDir, page.componentPath);
    const code = readFileSync(filePath, 'utf-8');
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
 * Watch the pages directory for structural changes (add/remove) and .md content
 * changes (frontmatter layout field) so that new layouts and named layouts are
 * picked up without a dev server restart.
 *
 * Returns a `flush()` function that resolves when any pending rescan completes
 * (useful for tests).
 */
export function watchPagesForRescan(
  server: ViteDevServer,
  pagesDir: string,
  root: string,
  onRescan: (pageScan: PageScanResult) => void,
): { flush: () => Promise<void> } {
  let pending: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRescan = (path: string) => {
    if (!path.startsWith(pagesDir)) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pending = scanPages(root).then((pageScan) => {
        onRescan(pageScan);
        for (const env of Object.values(server.environments)) {
          const mod = env.moduleGraph.getModuleById('\0' + ISLANDS_RENDERER_ID);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
          }
        }
        pending = null;
      });
    }, 50);
  };

  server.watcher.on('add', scheduleRescan);
  server.watcher.on('unlink', scheduleRescan);
  server.watcher.on('change', (path) => {
    if (path.endsWith('.md')) {
      scheduleRescan(path);
    }
  });

  return {
    flush: () => pending ?? Promise.resolve(),
  };
}
