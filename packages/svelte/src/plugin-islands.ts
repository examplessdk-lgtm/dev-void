import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { scanPages, resolveEffectiveLayoutChain } from 'void/pages';
import type { PageScanResult } from 'void/pages';
import {
  resolveSpecifier,
  needsIslandClientBundle,
  rewriteCssImportForVirtualModule,
  fileHasCssImports,
  extractCssImports,
  rebuildIslandCssMap as rebuildIslandCssMapShared,
  computePagesNeedingClientJS as computePagesNeedingClientJSShared,
  configureIslandCssServer,
  watchPagesForRescan,
  ISLANDS_RENDERER_ID,
  ISLANDS_CLIENT_ENTRY_ID,
} from 'void/pages-islands-plugin';
import type { IslandEntry } from 'void/pages-islands-plugin';
import { generateComponentManifest } from './pages-manifest';

const COMPONENT_EXTENSIONS = ['.svelte', '.ts', '.js'];

/**
 * Prefix for virtual island wrapper modules. Must NOT use the `\0` prefix
 * because `@sveltejs/vite-plugin-svelte` skips `\0`-prefixed modules in
 * its transform filter.
 */
const WRAPPER_PREFIX = '/@void-island-wrap/';

export function islandsPlugin(pagesDir: string): Plugin[] {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  let isDev = false;
  let viteRoot = '';
  const islandCssMap = new Map<string, string[]>();
  let resolvedConfig: any;

  /** Rebuild islandCssMap from current file contents (re-runs fileHasCssImports). */
  function rebuildIslandCssMap(): void {
    if (!pageScan) {
      return;
    }
    rebuildIslandCssMapShared(pageScan, pagesDir, islandCssMap, fileHasCssImports);
  }

  function computePagesNeedingClientJS(): Set<string> {
    if (!pageScan) {
      return new Set();
    }
    return computePagesNeedingClientJSShared(pageScan, pagesDir, resolvedConfig);
  }

  return [
    {
      name: 'void-svelte:islands',
      enforce: 'pre',

      configResolved(config) {
        resolvedConfig = config;
        viteRoot = config.root;
        isDev = config.command === 'serve';
      },

      // Serve virtual island CSS as raw text/css in dev. The client transform
      // produces a JS module with `__vite__css = "..."` for HMR — we extract
      // the CSS string and serve it directly for render-blocking <link> tags.
      configureServer(server) {
        configureIslandCssServer(server, islandCssFiles, viteRoot, rebuildIslandCssMap);
        watchPagesForRescan(server, pagesDir, root, (scan: PageScanResult) => {
          pageScan = scan;
          rebuildIslandCssMap();
        });
      },

      async buildStart() {
        if (existsSync(pagesDir)) {
          pageScan = await scanPages(root);
          // Pre-scan island pages to populate the manifest eagerly.
          // This is needed because the client build may load the virtual
          // islands-client entry before island page transforms run.
          const importAttrRe =
            /import\s+\w+\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;
          // Scan both pages AND layouts for island imports
          const filesToScan: { filePath: string; island: boolean }[] = [
            ...pageScan.pages.map((p: any) => ({ filePath: p.componentPath, island: p.island })),
            ...pageScan.layouts.map((l: any) => ({ filePath: l.filePath, island: l.island })),
            ...pageScan.namedLayouts.map((nl: any) => ({
              filePath: nl.filePath,
              island: nl.island,
            })),
          ];
          for (const entry of filesToScan) {
            if (!entry.island) {
              continue;
            }
            const filePath = resolve(pagesDir, entry.filePath);
            const code = readFileSync(filePath, 'utf-8');
            const importerDir = dirname(filePath);
            importAttrRe.lastIndex = 0;
            let m;
            while ((m = importAttrRe.exec(code)) !== null) {
              const spec = m[1].slice(1, -1);
              const strategy = m[2].slice(1, -1);
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
            if (page.componentPath.endsWith('.svelte')) {
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

          // Build CSS map for dev FOUC prevention (only files with CSS imports)
          rebuildIslandCssMap();
        }
      },

      resolveId: {
        filter: {
          id: /^(virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)|\.svelte\.css$/,
        },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return '\0' + source;
          }
          // Virtual wrapper modules — resolve without \0 prefix so the
          // Svelte vite plugin processes them as .svelte files
          if (source.startsWith(WRAPPER_PREFIX)) {
            return source;
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
        filter: {
          // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
          id: /^(\0virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)|\.svelte\.css$/,
        },
        handler(id) {
          if (id === '\0' + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            const mdPlugin = resolvedConfig?.plugins?.find((p: any) => p.name === 'void-md');
            const mdScriptIds: Set<string> = new Set(
              mdPlugin?.api?.getClientScripts?.()?.keys() ?? [],
            );
            const needsJS = computePagesNeedingClientJS();
            return generateIslandRenderer(
              pageScan,
              pagesDir,
              isDev,
              islandCssMap,
              viteRoot,
              mdScriptIds,
              needsJS,
            );
          }
          if (id === '\0' + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) {
              return '';
            }
            return generateIslandClientEntry(islandManifest, islandCssFiles, isDev);
          }
          // Virtual wrapper component — generates a .svelte wrapper
          if (id.startsWith(WRAPPER_PREFIX)) {
            return generateWrapperComponent(id);
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

      // Rewrite island imports to point to virtual wrapper components.
      // The wrapper module is a generated .svelte file that the Svelte
      // vite plugin compiles normally, wrapping the original component
      // with data-island/data-props/data-hydrate attributes.
      transform: {
        filter: { id: /\.island\.svelte$/ },
        handler(code, id) {
          if (/import\s+\{[^}]*\buseForm\b/.test(code)) {
            this.warn(
              `useForm imported in island page "${id}" — useForm requires the Inertia client-side router. Use useIslandForm instead.`,
            );
          }

          const importAttrRe =
            /import\s+(\w+)\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;

          const importerDir = dirname(id);
          let transformed = code;
          let match;

          while ((match = importAttrRe.exec(code)) !== null) {
            const name = match[1];
            const specRaw = match[2];
            const strategyRaw = match[3];
            const spec = specRaw.slice(1, -1);
            const strategy = strategyRaw.slice(1, -1);

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

            // Rewrite import to point to virtual wrapper component
            const wrapperUrl =
              WRAPPER_PREFIX +
              encodeURIComponent(islandId) +
              '.svelte?src=' +
              encodeURIComponent(absPath || spec) +
              '&island=' +
              encodeURIComponent(islandId) +
              '&hydrate=' +
              encodeURIComponent(strategy);
            const replacement = `import ${name} from ${JSON.stringify(wrapperUrl)}`;
            transformed = transformed.replace(match[0], replacement);
          }

          if (transformed !== code) {
            return { code: transformed, map: null };
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }
        if (env.command === 'serve') {
          return { optimizeDeps: { include: ['svelte'] } };
        }
        // Only add the islands client entry when content needs it
        if (needsIslandClientBundle(pagesDir, /\.island\.svelte$/, true)) {
          return {
            environments: {
              client: {
                build: {
                  manifest: true,
                  rollupOptions: {
                    input: { 'islands-client': ISLANDS_CLIENT_ENTRY_ID },
                  },
                },
              },
            },
          };
        }
      },
    },
    {
      name: 'void-svelte:islands-style',

      resolveId: {
        filter: { id: /\?island-style&/ },
        handler(source) {
          return source;
        },
      },

      load: {
        filter: { id: /\?island-style&/ },
        handler(id) {
          // ?island-style&index=N&lang.{ext} — return raw CSS of Nth <style> block
          const filePath = id.replace(/\?island-style&.*$/, '');
          const params = new URLSearchParams(id.slice(id.indexOf('?island-style&') + 1));
          const index = parseInt(params.get('index') || '0', 10);
          const content = readFileSync(filePath, 'utf-8');
          const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
          let match;
          let i = 0;
          while ((match = styleBlockRe.exec(content)) !== null) {
            if (i === index) {
              return match[1];
            }
            i++;
          }
          return '/* style block not found */';
        },
      },
    },
  ];
}

/**
 * Generate a virtual Svelte wrapper component from a wrapper URL.
 * The URL encodes: src (absolute component path), island (ID), hydrate (strategy).
 */
function generateWrapperComponent(id: string): string {
  const url = new URL(id, 'file://');
  const src = decodeURIComponent(url.searchParams.get('src') || '');
  const islandId = decodeURIComponent(url.searchParams.get('island') || '');
  const hydrate = decodeURIComponent(url.searchParams.get('hydrate') || 'load');

  return `<script>
  import Cmp from ${JSON.stringify(src)};
  let props = $props();
</script>
<div data-island="${islandId}" data-props={JSON.stringify(props)} data-hydrate="${hydrate}">
  <Cmp {...props} />
</div>
`;
}

function generateIslandRenderer(
  scan: PageScanResult,
  pagesDir: string,
  isDev: boolean,
  islandCssMap: Map<string, string[]>,
  viteRoot: string,
  mdScriptIds: Set<string>,
  pagesNeedingClientJS: Set<string>,
): string {
  // Build CSS link map for dev FOUC prevention
  let cssMapCode = '';
  if (isDev && islandCssMap.size > 0) {
    const cssMapObj: Record<string, string[]> = {};
    for (const [compId, paths] of islandCssMap) {
      cssMapObj[compId] = paths.map((p) => '/' + normalizePath(relative(viteRoot, p)) + '.css');
    }
    cssMapCode = `const __cssPaths = ${JSON.stringify(cssMapObj)};`;
  }

  const mdScriptIdsCode = `const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});`;
  const needsJSCode = `const __pagesNeedingClientJS = new Set(${JSON.stringify([...pagesNeedingClientJS])});`;

  return `
import { render } from "svelte/server";
import App from "@void/svelte/App.svelte";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}
${cssMapCode}
${mdScriptIdsCode}
${needsJSCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const { html, head } = render(App, {
    props: {
      page: PageComponent,
      layouts: layoutComponents,
      pageProps: pageObj.props,
      shared: pageObj.shared || {},
      errors: pageObj.errors || {},
      router: null,
      stores: null,
    },
  });

  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${typeof __cssPaths !== "undefined" ? (__cssPaths[pageObj.component] || []).map(url => '<link rel="stylesheet" href="' + url + '">').join("\\n") : ""}\${head}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
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

  const lines: string[] = [];

  lines.push('import { initIslands } from "void/pages-client";');

  // In dev, page/layout CSS is served via render-blocking <link> tags
  // injected in the SSR HTML. Skip CSS imports here to avoid duplicate injection.
  // In production, the <link> tags aren't used — the imports below ensure
  // the CSS is included in the bundled output.
  if (!isDev) {
    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf-8');

      // Extract <style> blocks → emit ?island-style imports
      const styleRe = /<style\b([^>]*)>/g;
      styleRe.lastIndex = 0;
      let styleIndex = 0;
      let styleMatch;
      while ((styleMatch = styleRe.exec(content)) !== null) {
        const attrs = styleMatch[1];
        const langMatch = attrs.match(/\blang\s*=\s*["'](\w+)["']/);
        const lang = langMatch ? langMatch[1] : 'css';
        lines.push(
          `import ${JSON.stringify(file + '?island-style&index=' + styleIndex + '&lang.' + lang)};`,
        );
        styleIndex++;
      }

      // Extract CSS imports from <script> blocks
      const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
      const cssImportRe =
        /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
      let scriptMatch;
      while ((scriptMatch = scriptRe.exec(content)) !== null) {
        const scriptContent = scriptMatch[1];
        let cssMatch;
        cssImportRe.lastIndex = 0;
        while ((cssMatch = cssImportRe.exec(scriptContent)) !== null) {
          lines.push(rewriteCssImportForVirtualModule(cssMatch[0], cssMatch[1], file));
        }
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
  const { hydrate } = await import("svelte");
  const Component = mod.default || mod;
  hydrate(Component, { target: el, props });
  el.setAttribute("data-hydrated", "true");
}

initIslands(islands, hydrateIsland);
`);

  return lines.join('\n');
}
