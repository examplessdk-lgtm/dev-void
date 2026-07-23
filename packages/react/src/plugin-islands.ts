import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'pathslash';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { scanPages, resolveEffectiveLayoutChain } from 'void/pages';
import type { PageScanResult } from 'void/pages';
import {
  resolveSpecifier,
  needsIslandClientBundle,
  extractCssImports,
  computePagesNeedingClientJS,
  watchPagesForRescan,
  rewriteCssImportForVirtualModule,
  ISLANDS_RENDERER_ID,
  ISLANDS_CLIENT_ENTRY_ID,
} from 'void/pages-islands-plugin';
import type { IslandEntry } from 'void/pages-islands-plugin';
import { generateComponentManifest } from './pages-manifest.ts';

const COMPONENT_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];
const ISLAND_IMPORT_RE =
  /import\s+([$_A-Za-z][$_\w]*)\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*,?\s*\}/g;

function findIslandImports(code: string) {
  const imports: Array<{
    statement: string;
    importName: string;
    specifierRaw: string;
    specifier: string;
    hydrate: string;
  }> = [];
  let match: RegExpExecArray | null;
  ISLAND_IMPORT_RE.lastIndex = 0;
  while ((match = ISLAND_IMPORT_RE.exec(code)) !== null) {
    const specifierRaw = match[2];
    imports.push({
      statement: match[0],
      importName: match[1],
      specifierRaw,
      specifier: specifierRaw.slice(1, -1),
      hydrate: match[3].slice(1, -1),
    });
  }
  return imports;
}

type MdPluginWithApi = Plugin & {
  api?: {
    getClientScripts?: () => Map<string, unknown>;
  };
};
type ScannableEntry = { filePath: string; island: boolean | undefined };

export function islandsPlugin(
  pagesDir: string,
  options?: { root?: string },
): ReadonlyArray<Plugin> {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  const root = options?.root ?? dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  let viteRoot = '';
  let resolvedConfig: ResolvedConfig | null = null;

  function computePagesNeedingClientJSLocal(): Set<string> {
    if (!pageScan) {
      return new Set();
    }
    return computePagesNeedingClientJS(pageScan, pagesDir, resolvedConfig);
  }

  return [
    {
      name: 'void-react:islands',

      configResolved(config) {
        resolvedConfig = config;
        viteRoot = config.root;
        isDev = config.command === 'serve';
      },

      configureServer(server) {
        watchPagesForRescan(server, pagesDir, root, (scan: PageScanResult) => {
          pageScan = scan;
        });
      },

      async buildStart() {
        if (existsSync(pagesDir)) {
          pageScan = await scanPages(root, { pagesDir });
          // Pre-scan island pages to populate the manifest eagerly.
          // This is needed because the client build may load the virtual
          // islands-client entry before island page transforms run.
          // Scan both pages AND layouts for island imports
          const filesToScan: ReadonlyArray<ScannableEntry> = [
            ...pageScan.pages.map((page) => ({
              filePath: page.componentPath,
              island: page.island,
            })),
            ...pageScan.layouts.map((layout) => ({
              filePath: layout.filePath,
              island: layout.island,
            })),
            ...pageScan.namedLayouts.map((namedLayout) => ({
              filePath: namedLayout.filePath,
              island: namedLayout.island,
            })),
          ];
          for (const entry of filesToScan) {
            if (!entry.island) {
              continue;
            }
            const filePath = resolve(pagesDir, entry.filePath);
            const code = readFileSync(filePath, 'utf-8');
            const importerDir = dirname(filePath);
            for (const islandImport of findIslandImports(code)) {
              const spec = islandImport.specifier;
              const strategy = islandImport.hydrate;
              const absPath = resolveSpecifier(spec, importerDir, COMPONENT_EXTENSIONS);
              if (absPath) {
                const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, '');
                islandManifest.set(islandId, {
                  componentPath: absPath,
                  islandId,
                  hydrate: strategy,
                });
              }
            }
          }

          // Collect page and layout files needing CSS for island pages
          for (const page of pageScan.pages) {
            if (!page.island) {
              continue;
            }
            if (/\.(tsx|jsx)$/.test(page.componentPath)) {
              islandCssFiles.add(normalizePath(resolve(pagesDir, page.componentPath)));
            }
            const layoutChain = resolveEffectiveLayoutChain(
              page,
              pageScan.layouts,
              pageScan.namedLayouts,
            );
            for (const layout of layoutChain) {
              islandCssFiles.add(normalizePath(resolve(pagesDir, layout.filePath)));
            }
          }
        }
      },

      resolveId: {
        filter: { id: /^virtual:void-islands-(renderer|client)$|\.(tsx|jsx)\.css$/ },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return '\0' + source;
          }
          // Virtual island CSS modules — no \0 prefix so Vite CSS pipeline processes them.
          // Return absolute path so CSS @import resolution uses the correct directory.
          if (source.endsWith('.css')) {
            const srcPath = normalizePath(source.slice(0, -4));
            if (islandCssFiles.has(srcPath)) {
              return srcPath + '.css';
            }
            if (srcPath.startsWith('/')) {
              const absPath = normalizePath(resolve(viteRoot, srcPath.slice(1)));
              if (islandCssFiles.has(absPath)) {
                return absPath + '.css';
              }
            }
          }
        },
      },

      load: {
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
        filter: { id: /^\0virtual:void-islands-(renderer|client)$|\.(tsx|jsx)\.css$/ },
        handler(id) {
          if (id === '\0' + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            const mdPlugin = resolvedConfig?.plugins?.find(
              (plugin): plugin is MdPluginWithApi => plugin.name === 'void-md',
            );
            const mdScriptIds: Set<string> = new Set(
              mdPlugin?.api?.getClientScripts?.()?.keys() ?? [],
            );
            const needsJS = computePagesNeedingClientJSLocal();
            return generateIslandRenderer(pageScan, pagesDir, isDev, mdScriptIds, needsJS);
          }
          if (id === '\0' + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) {
              return '';
            }
            return generateIslandClientEntry(islandManifest, islandCssFiles, isDev);
          }
          // Virtual island CSS module — resolveId returns absolute path
          if (id.endsWith('.css') && !id.startsWith('\0')) {
            const srcPath = id.slice(0, -4);
            if (islandCssFiles.has(srcPath)) {
              return extractCssImports(srcPath);
            }
          }
        },
      },

      // Rewrite island imports inline — the workerd module runner resolves imports
      // from the pre-transform AST, so we can't rely on resolveId to intercept
      // rewritten specifiers. Instead, we replace each island import with:
      //   1. A renamed import of the raw component
      //   2. An inline wrapper that adds data-island/data-props/data-hydrate attributes
      // This also populates the islandManifest for the client entry.
      transform: {
        filter: { id: /\.island\.(tsx|jsx)$/ },
        handler(code, id) {
          if (/import\s+\{[^}]*\buseForm\b/.test(code)) {
            this.warn(
              `islands: useForm cannot be imported in island page '${id}'. Use useIslandForm instead.`,
            );
          }

          const importerDir = dirname(id);
          let transformed = code;
          const wrappers: Array<string> = [];
          let idx = 0;

          for (const islandImport of findIslandImports(code)) {
            const name = islandImport.importName;
            const specRaw = islandImport.specifierRaw;
            const strategy = islandImport.hydrate;
            const spec = islandImport.specifier;
            const rawName = `_raw_island_${idx++}`;

            // Resolve to absolute path for the island manifest
            const absPath = resolveSpecifier(spec, importerDir, COMPONENT_EXTENSIONS);
            if (absPath) {
              const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, '');
              islandManifest.set(islandId, {
                componentPath: absPath,
                islandId,
                hydrate: strategy,
              });
            }

            const islandId = absPath
              ? normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, '')
              : spec;

            // Replace the import with a renamed import
            const replacement = `import ${rawName} from ${specRaw}`;
            transformed = transformed.replace(islandImport.statement, replacement);

            // Generate wrapper that adds data-island attributes during SSR.
            // Uses _React_island (imported below) for createElement.
            wrappers.push(
              `var ${name} = function ${name}(props) {` +
                ` return _React_island.createElement("div", {` +
                ` "data-island": ${JSON.stringify(islandId)},` +
                ` "data-props": JSON.stringify(props),` +
                ` "data-hydrate": ${JSON.stringify(strategy)}` +
                ` }, _React_island.createElement(${rawName}, props));` +
                ` };`,
            );
          }

          if (wrappers.length > 0) {
            // Prepend a React import for the wrapper functions
            transformed =
              `import _React_island from "react";\n` + transformed + '\n' + wrappers.join('\n');
            return { code: transformed, map: null };
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }
        // Only add the islands client entry when content needs it
        if (
          env.command !== 'serve' &&
          needsIslandClientBundle(pagesDir, /\.island\.(tsx|jsx)$/, false)
        ) {
          return {
            build: {
              manifest: true,
              rollupOptions: {
                input: { 'islands-client': ISLANDS_CLIENT_ENTRY_ID },
              },
            },
          };
        }
      },
    },
  ];
}

function generateIslandRenderer(
  scan: PageScanResult,
  pagesDir: string,
  isDev: boolean,
  mdScriptIds: Set<string>,
  pagesNeedingClientJS: Set<string>,
): string {
  const preambleScript = isDev
    ? `
<script type="module">
  import RefreshRuntime from "/@react-refresh"
  RefreshRuntime.injectIntoGlobalHook(window)
  window.$RefreshReg$ = () => {}
  window.$RefreshSig$ = () => (type) => type
  window.__vite_plugin_react_preamble_installed__ = true
</script>`
    : '';

  const mdScriptIdsCode = `const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});`;
  const needsJSCode = `const __pagesNeedingClientJS = new Set(${JSON.stringify([...pagesNeedingClientJS])});`;

  return `
import React from "react";
import { renderToString } from "react-dom/server";
import { SharedContext, ErrorsContext, ParamsContext } from "@void/react";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}
${mdScriptIdsCode}
${needsJSCode}

const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  let element = React.createElement(PageComponent, pageObj.props);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = React.createElement(layoutComponents[i], null, element);
  }

  // No RouterContext — islands have no Void Router
  element = React.createElement(
    SharedContext.Provider,
    { value: pageObj.shared || {} },
    React.createElement(
      ParamsContext.Provider,
      { value: pageObj.params || {} },
      React.createElement(
        ErrorsContext.Provider,
        { value: pageObj.errors || {} },
        element
      )
    )
  );

  const html = renderToString(element);
  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${PREAMBLE_SCRIPT}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
<body\${bodyAttrs}>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
  \${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.body : ""}
</body>
</html>\`;
}
`;
}

function generateIslandClientEntry(
  manifest: Map<string, IslandEntry>,
  cssFiles: Set<string>,
  isDev: boolean,
): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: Array<string> = [];

  lines.push('import { initIslands } from "void/pages-client";');

  // In dev, first-paint CSS is provided by Void's shared dev CSS collector.
  // Skip CSS imports here to avoid duplicate client injection.
  // In production, the <link> tags aren't used — the imports below ensure
  // the CSS is included in the bundled output.
  if (!isDev) {
    const cssImportRe =
      /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf-8');
      cssImportRe.lastIndex = 0;
      let match;
      while ((match = cssImportRe.exec(content)) !== null) {
        lines.push(rewriteCssImportForVirtualModule(match[0], match[1], file));
      }
    }
  }

  lines.push('const islands = {');
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push('};');

  lines.push(`
async function hydrateIsland(el, mod, props) {
  const { hydrateRoot } = await import("react-dom/client");
  const React = await import("react");
  const Component = mod.default || mod;
  hydrateRoot(el, React.createElement(Component, props));
  el.setAttribute("data-hydrated", "true");
}

initIslands(islands, hydrateIsland);
`);

  return lines.join('\n');
}
