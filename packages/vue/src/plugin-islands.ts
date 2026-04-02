import { normalizePath, type Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { scanPages, resolveEffectiveLayoutChain } from "void/pages";
import type { PageScanResult } from "void/pages";
import {
  resolveSpecifier,
  needsIslandClientBundle,
  rebuildIslandCssMap as rebuildIslandCssMapShared,
  computePagesNeedingClientJS as computePagesNeedingClientJSShared,
  configureIslandCssServer,
  ISLANDS_RENDERER_ID,
  ISLANDS_CLIENT_ENTRY_ID,
} from "void/pages-islands-plugin";
import type { IslandEntry } from "void/pages-islands-plugin";
import { generateComponentManifest } from "./pages-manifest";

const COMPONENT_EXTENSIONS = [".vue", ".tsx", ".jsx", ".ts", ".js"];

function fileHasCss(filePath: string): boolean {
  try {
    const code = readFileSync(filePath, "utf-8");
    // JS-style CSS imports
    if (/import\b[^"']*["'][^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)["']/.test(code))
      return true;
    // Vue <style> blocks (non-scoped — scoped needs Vue plugin processing)
    if (/<style\b(?![^>]*\bscoped\b)[^>]*>/.test(code)) return true;
    return false;
  } catch {
    return false;
  }
}

function extractCss(filePath: string): string {
  const code = readFileSync(filePath, "utf-8");
  const parts: string[] = [];

  // JS-style CSS imports → @import
  const jsRe =
    /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
  let match;
  while ((match = jsRe.exec(code)) !== null) {
    parts.push(`@import ${JSON.stringify(match[1])};`);
  }

  // Vue <style> block contents (non-scoped only)
  const styleBlockRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/g;
  while ((match = styleBlockRe.exec(code)) !== null) {
    const attrs = match[1];
    if (/\bscoped\b/.test(attrs)) continue;
    const content = match[2].trim();
    if (content) parts.push(content);
  }

  return parts.join("\n");
}

export function islandsPlugin(pagesDir: string): Plugin[] {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  let isDev = false;
  let viteRoot = "";
  const islandCssMap = new Map<string, string[]>();
  let resolvedConfig: any;

  /** Rebuild islandCssMap from current file contents (re-runs fileHasCss). */
  function rebuildIslandCssMap(): void {
    if (!pageScan) return;
    rebuildIslandCssMapShared(pageScan, pagesDir, islandCssMap, fileHasCss);
  }

  function computePagesNeedingClientJS(): Set<string> {
    if (!pageScan) return new Set();
    return computePagesNeedingClientJSShared(pageScan, pagesDir, resolvedConfig);
  }

  return [
    {
      name: "void-vue:islands",
      enforce: "pre",

      configResolved(config) {
        resolvedConfig = config;
        viteRoot = config.root;
        isDev = config.command === "serve";
      },

      // Serve virtual island CSS as raw text/css in dev. The client transform
      // produces a JS module with `__vite__css = "..."` for HMR — we extract
      // the CSS string and serve it directly for render-blocking <link> tags.
      configureServer(server) {
        configureIslandCssServer(server, islandCssFiles, viteRoot, rebuildIslandCssMap);
      },

      async buildStart() {
        if (existsSync(pagesDir)) {
          pageScan = await scanPages(root);
          // Pre-scan island pages to populate the manifest eagerly.
          // This is needed because the client build may load the virtual
          // islands-client entry before island page transforms run.
          const importAttrRe =
            /import\s+\w+\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;
          for (const page of pageScan.pages) {
            if (!page.island) continue;
            const filePath = resolve(pagesDir, page.componentPath);
            const code = readFileSync(filePath, "utf-8");
            const importerDir = dirname(filePath);
            importAttrRe.lastIndex = 0;
            let m;
            while ((m = importAttrRe.exec(code)) !== null) {
              const spec = m[1].slice(1, -1);
              const strategy = m[2].slice(1, -1);
              const absPath = resolveSpecifier(spec, importerDir, COMPONENT_EXTENSIONS);
              if (absPath) {
                const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, "");
                islandManifest.set(islandId, {
                  componentPath: absPath,
                  islandId,
                  hydrate: strategy,
                });
              }
            }
          }

          // Collect .vue files needing CSS for island pages
          for (const page of pageScan.pages) {
            if (!page.island) continue;
            if (page.componentPath.endsWith(".vue")) {
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
        filter: { id: /^virtual:void-islands-(renderer|client)$|\.vue\.css$/ },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return "\0" + source;
          }
          // Virtual island CSS modules — no \0 prefix so Vite CSS pipeline processes them.
          // Return absolute path so CSS @import resolution uses the correct directory.
          if (source.endsWith(".css")) {
            const srcPath = normalizePath(source.slice(0, -4));
            if (islandCssFiles.has(srcPath)) return srcPath + ".css";
            if (srcPath.startsWith("/")) {
              const absPath = normalizePath(resolve(viteRoot, srcPath.slice(1)));
              if (islandCssFiles.has(absPath)) return absPath + ".css";
            }
          }
        },
      },

      load: {
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
        filter: { id: /^\0virtual:void-islands-(renderer|client)$|\.vue\.css$/ },
        handler(id) {
          if (id === "\0" + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            const mdPlugin = resolvedConfig?.plugins?.find((p: any) => p.name === "void-md");
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
          if (id === "\0" + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) return "";
            return generateIslandClientEntry(islandManifest, islandCssFiles, isDev);
          }
          // Virtual island CSS module — resolveId returns absolute path
          if (id.endsWith(".css") && !id.startsWith("\0")) {
            const srcPath = id.slice(0, -4);
            if (islandCssFiles.has(srcPath)) {
              return extractCss(srcPath);
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
        filter: { id: /\.island\.vue$/ },
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
          const wrappers: string[] = [];
          let idx = 0;
          let match;

          while ((match = importAttrRe.exec(code)) !== null) {
            const name = match[1];
            const specRaw = match[2];
            const strategyRaw = match[3];
            const spec = specRaw.slice(1, -1);
            const strategy = strategyRaw.slice(1, -1);
            const rawName = `_raw_island_${idx++}`;

            // Resolve to absolute path for the island manifest
            const absPath = resolveSpecifier(spec, importerDir, COMPONENT_EXTENSIONS);
            if (absPath) {
              const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, "");
              islandManifest.set(islandId, {
                componentPath: absPath,
                islandId,
                hydrate: strategy,
              });
            }

            const islandId = absPath
              ? normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, "")
              : spec;

            // Replace the import with a renamed import
            const replacement = `import ${rawName} from ${specRaw}`;
            transformed = transformed.replace(match[0], replacement);

            // Generate wrapper that adds data-island attributes during SSR.
            // Uses Vue's h() function for createElement.
            wrappers.push(
              `const ${name} = {` +
                ` inheritAttrs: false,` +
                ` render() {` +
                ` const props = this.$attrs;` +
                ` return _h_island("div", {` +
                ` "data-island": ${JSON.stringify(islandId)},` +
                ` "data-props": JSON.stringify(props),` +
                ` "data-hydrate": ${JSON.stringify(strategy)}` +
                ` }, _h_island(${rawName}, props));` +
                ` }` +
                ` };`,
            );
          }

          if (wrappers.length > 0) {
            // Inject into <script setup> block — this transform runs with enforce: "pre"
            // so the Vue SFC compiler hasn't processed the file yet. We must place
            // the h() import and wrapper consts inside the script block.
            const scriptSetupRe = /<script\b[^>]*\bsetup\b[^>]*>/;
            const setupMatch = transformed.match(scriptSetupRe);
            if (setupMatch) {
              const openEnd = setupMatch.index! + setupMatch[0].length;
              const closeIdx = transformed.indexOf("</script>", openEnd);
              if (closeIdx !== -1) {
                transformed =
                  transformed.slice(0, openEnd) +
                  '\nimport { h as _h_island } from "vue";' +
                  transformed.slice(openEnd, closeIdx) +
                  "\n" +
                  wrappers.join("\n") +
                  "\n" +
                  transformed.slice(closeIdx);
              }
            }
            return { code: transformed, map: null };
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) return;
        if (env.command === "serve") {
          return { optimizeDeps: { include: ["vue"] } };
        }
        // Only add the islands client entry when content needs it
        if (needsIslandClientBundle(pagesDir, /\.island\.vue$/, true)) {
          return {
            environments: {
              client: {
                build: {
                  manifest: true,
                  rollupOptions: {
                    input: { "islands-client": ISLANDS_CLIENT_ENTRY_ID },
                  },
                },
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
  islandCssMap: Map<string, string[]>,
  viteRoot: string,
  mdScriptIds: Set<string>,
  pagesNeedingClientJS: Set<string>,
): string {
  // Build CSS link map for dev FOUC prevention
  let cssMapCode = "";
  if (isDev && islandCssMap.size > 0) {
    const cssMapObj: Record<string, string[]> = {};
    for (const [compId, paths] of islandCssMap) {
      cssMapObj[compId] = paths.map((p) => "/" + normalizePath(relative(viteRoot, p)) + ".css");
    }
    cssMapCode = `const __cssPaths = ${JSON.stringify(cssMapObj)};`;
  }

  const mdScriptIdsCode = `const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});`;
  const needsJSCode = `const __pagesNeedingClientJS = new Set(${JSON.stringify([...pagesNeedingClientJS])});`;

  return `
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}
${cssMapCode}
${mdScriptIdsCode}
${needsJSCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const __pageModule = await components[pageObj.component]();
  const PageComponent = __pageModule.default;
  const __frontmatter = __pageModule.frontmatter;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const app = createSSRApp({
    setup() {
      provide("__void_shared", reactive(pageObj.shared || {}));
      provide("__void_errors", reactive(pageObj.errors || {}));
      if (__frontmatter) provide("__void_frontmatter", __frontmatter);
      // No router provided — islands have no client-side router
      return () => {
        let vnode = h(PageComponent, pageObj.props);
        for (let i = layoutComponents.length - 1; i >= 0; i--) {
          const inner = vnode;
          vnode = h(layoutComponents[i], null, { default: () => inner });
        }
        return vnode;
      };
    }
  });

  const html = await renderToString(app);
  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${typeof __cssPaths !== "undefined" ? (__cssPaths[pageObj.component] || []).map(url => '<link rel="stylesheet" href="' + url + '">').join("\\n") : ""}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
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
  // injected in the SSR HTML (see generateIslandRenderer). Skip the
  // ?vue&type=style imports here to avoid duplicate injection.
  // In production, the <link> tags aren't used — the style imports below
  // ensure the CSS is included in the bundled output.
  if (!isDev) {
    const styleRe = /<style\b([^>]*)>/g;
    const cssImportRe =
      /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
    for (const file of cssFiles) {
      const content = readFileSync(file, "utf-8");
      // Extract <style> blocks via Vue SFC query params
      styleRe.lastIndex = 0;
      let index = 0;
      let match;
      while ((match = styleRe.exec(content)) !== null) {
        const attrs = match[1];
        const scoped = /\bscoped\b/.test(attrs);
        const langMatch = attrs.match(/\blang\s*=\s*["'](\w+)["']/);
        const lang = langMatch ? langMatch[1] : "css";
        let query = `?vue&type=style&index=${index}&lang.${lang}`;
        if (scoped) query += "&scoped=true";
        lines.push(`import ${JSON.stringify(file + query)};`);
        index++;
      }
      // Extract JS-style CSS imports (e.g. import "@void/md/theme.css")
      cssImportRe.lastIndex = 0;
      while ((match = cssImportRe.exec(content)) !== null) {
        lines.push(match[0].trim() + ";");
      }
    }
  }

  lines.push("const islands = {");
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push("};");

  lines.push(`
async function hydrateIsland(el, mod, props) {
  const { createSSRApp, h } = await import("vue");
  const Component = mod.default || mod;
  const app = createSSRApp({ render: () => h(Component, props) });
  app.mount(el);
  el.setAttribute("data-hydrated", "true");
}

initIslands(islands, hydrateIsland);
`);

  return lines.join("\n");
}
