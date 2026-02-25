import type { Plugin } from "vite";
import type { PageScanResult } from "void/pages";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { scanPages } from "void/pages";

import { generateComponentManifest } from "./pages-manifest";

const ISLANDS_RENDERER_ID = "virtual:void-islands-renderer";
const ISLANDS_CLIENT_ENTRY_ID = "virtual:void-islands-client";

const COMPONENT_EXTENSIONS = [".vue", ".tsx", ".jsx", ".ts", ".js"];

interface IslandEntry {
  componentPath: string;
  islandId: string;
  hydrate: string;
}

/** Resolve a relative import specifier to an absolute path by checking extensions. */
function resolveSpecifier(specifier: string, importerDir: string): string | null {
  const base = resolve(importerDir, specifier);
  for (const ext of COMPONENT_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  if (existsSync(base)) return base;
  return null;
}

/** Quick sync check for .island.vue files in the pages directory. */
function hasIslandFiles(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(".island.vue")) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function islandsPlugin(pagesDir: string): Plugin {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();

  return {
    name: "void-vue:islands",
    enforce: "pre",

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
            const absPath = resolveSpecifier(spec, importerDir);
            if (absPath) {
              const islandId = relative(root, absPath).replace(/\.[^.]+$/, "");
              islandManifest.set(islandId, { componentPath: absPath, islandId, hydrate: strategy });
            }
          }
        }
      }
    },

    resolveId: {
      filter: { id: /^virtual:void-islands-(renderer|client)$/ },
      handler(source) {
        if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
          return "\0" + source;
        }
      },
    },

    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void-islands-(renderer|client)$/ },
      handler(id) {
        if (id === "\0" + ISLANDS_RENDERER_ID) {
          if (!pageScan) {
            return "export function renderIslandPage() { throw new Error('No pages found'); }";
          }
          return generateIslandRenderer(pageScan, pagesDir);
        }
        if (id === "\0" + ISLANDS_CLIENT_ENTRY_ID) {
          if (!pageScan) return "";
          return generateIslandClientEntry(islandManifest);
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
          const absPath = resolveSpecifier(spec, importerDir);
          if (absPath) {
            const islandId = relative(root, absPath).replace(/\.[^.]+$/, "");
            islandManifest.set(islandId, {
              componentPath: absPath,
              islandId,
              hydrate: strategy,
            });
          }

          const islandId = absPath ? relative(root, absPath).replace(/\.[^.]+$/, "") : spec;

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
      // Only add the islands client entry when island pages actually exist
      if (hasIslandFiles(pagesDir)) {
        return {
          environments: {
            client: {
              build: {
                rollupOptions: {
                  input: { "islands-client": ISLANDS_CLIENT_ENTRY_ID },
                },
              },
            },
          },
        };
      }
    },
  };
}

function generateIslandRenderer(scan: PageScanResult, pagesDir: string): string {
  return `
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";

${generateComponentManifest(scan, pagesDir)}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const app = createSSRApp({
    setup() {
      provide("__void_shared", reactive(pageObj.shared || {}));
      provide("__void_errors", reactive(pageObj.errors || {}));
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

  return \`<!doctype html>
<html>
<head>\${assetTags.head}</head>
<body>
  <div id="app">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
}
`;
}

function generateIslandClientEntry(manifest: Map<string, IslandEntry>): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: string[] = [];

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

function scheduleHydration(el, loader, props, strategy) {
  const hydrate = () => loader().then(mod => hydrateIsland(el, mod, props));

  if (strategy === "load") {
    hydrate();
  } else if (strategy === "visible") {
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        hydrate();
      }
    });
    observer.observe(el);
  } else if (strategy === "idle") {
    const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
    schedule(() => hydrate());
  } else if (strategy.startsWith("media:")) {
    const query = strategy.slice(6);
    const mql = matchMedia(query);
    const check = () => {
      if (mql.matches) {
        mql.removeEventListener("change", check);
        hydrate();
      }
    };
    mql.addEventListener("change", check);
    check();
  }
}

document.querySelectorAll("[data-island]").forEach(el => {
  const id = el.getAttribute("data-island");
  const props = JSON.parse(el.getAttribute("data-props") || "{}");
  const strategy = el.getAttribute("data-hydrate") || "load";
  const loader = islands[id];
  if (loader) scheduleHydration(el, loader, props, strategy);
});
`);

  return lines.join("\n");
}
