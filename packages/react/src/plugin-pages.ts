import type { Plugin } from "vite";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { scanPages } from "void/pages";
import type { PageScanResult } from "void/pages";
import { generateComponentManifest } from "./pages-manifest";

const RENDERER_ID = "virtual:void-pages-renderer";
const CLIENT_ENTRY_ID = "virtual:void-pages-client";

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

interface PagesPluginOptions {
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

/** Check if the pages directory has any non-island page files (.tsx/.jsx without .island.). */
function hasNonIslandPages(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name.startsWith("_") || name.startsWith("layout.")) continue;
      if (/\.(tsx|jsx)$/.test(name) && !name.includes(".island.")) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  const root = dirname(pagesDir);

  return {
    name: "void-react:pages",

    async buildStart() {
      if (existsSync(pagesDir)) {
        pageScan = await scanPages(root);
      }
    },

    resolveId: {
      filter: { id: /^virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        return "\0" + id;
      },
    },

    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        if (id === "\0" + RENDERER_ID) {
          if (!pageScan)
            return "export function renderPage() { throw new Error('No pages found'); }";
          return generateRendererModule(pageScan, pagesDir, isDev);
        }
        if (id === "\0" + CLIENT_ENTRY_ID) {
          if (!pageScan) return "";
          return generateClientEntry(
            pageScan,
            pagesDir,
            options?.viewTransitions,
            options?.prefetch,
          );
        }
      },
    },

    config(_, env) {
      if (!existsSync(pagesDir)) return;

      // In dev mode, exclude @void/react from dep optimization so the
      // virtual module and user components share the same React context objects.
      // Without this, Vite pre-bundles @void/react, creating separate
      // context instances that break useContext (React contexts use object identity).
      if (env.command === "serve") {
        isDev = true;
        return {
          optimizeDeps: {
            // Exclude @void/react so the virtual module and user
            // components share the same React context objects (identity).
            exclude: ["@void/react"],
            // Pre-include React entries that are discovered late via dynamic
            // imports during SPA navigation, avoiding a full-page reload
            // from Vite's dep optimizer.
            include: ["react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client"],
          },
        };
      }

      // Skip the pages-client bundle when all pages are island pages
      if (!hasNonIslandPages(pagesDir)) return;

      return {
        build: {
          manifest: true,
          rollupOptions: {
            input: { "pages-client": CLIENT_ENTRY_ID },
          },
        },
      };
    },
  };
}

function generateRendererModule(scan: PageScanResult, pagesDir: string, isDev: boolean): string {
  // In dev mode, inject the React Refresh preamble as an inline script.
  // SSR-generated HTML bypasses Vite's transformIndexHtml, so @vitejs/plugin-react
  // can't inject it automatically. Without this, React Fast Refresh breaks and
  // the client entry module fails to load.
  const preambleScript = isDev
    ? `
<script type="module">
  import RefreshRuntime from "/@react-refresh"
  RefreshRuntime.injectIntoGlobalHook(window)
  window.$RefreshReg$ = () => {}
  window.$RefreshSig$ = () => (type) => type
  window.__vite_plugin_react_preamble_installed__ = true
</script>`
    : "";

  return `
import React from "react";
import { renderToString } from "react-dom/server";
import { SharedContext, ErrorsContext, RouterContext } from "@void/react";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}

const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};

function serializePageData(pageObj) {
  return JSON.stringify(pageObj).replace(/[<>&\\u2028\\u2029]/g, function(c) {
    return String.fromCharCode(92) + "u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

export async function renderPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  // Build layout chain: outermost layout wraps inner layouts wrapping the page
  let element = React.createElement(PageComponent, pageObj.props);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = React.createElement(layoutComponents[i], null, element);
  }

  // Wrap in context providers
  element = React.createElement(
    SharedContext.Provider,
    { value: pageObj.shared || {} },
    React.createElement(
      ErrorsContext.Provider,
      { value: pageObj.errors || {} },
      React.createElement(
        RouterContext.Provider,
        { value: null },
        element
      )
    )
  );

  const html = renderToString(element);
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${PREAMBLE_SCRIPT}\${assetTags.css}\${assetTags.preloads}</head>
<body\${bodyAttrs}>
  <script id="__VOID_PAGE_DATA__" type="application/json">\${pageData}</script>
  <div id="app">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
}
`;
}

function generateClientEntry(
  scan: PageScanResult,
  pagesDir: string,
  viewTransitions?: boolean,
  prefetch?: PrefetchConfig,
): string {
  return `
import React, { useSyncExternalStore } from "react";
import { hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SharedContext, ErrorsContext, RouterContext, setActionRouter } from "@void/react";
import { createPageRouter } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

// --- Module-level store ---
let state = {
  component: null,
  props: {},
  layouts: [],
  shared: {},
  errors: {},
};

const listeners = new Set();
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot() {
  return state;
}
function setState(partial) {
  state = { ...state, ...partial };
  for (const l of listeners) l();
}

const { router, initialPageData, initialComponent, initialLayouts, start } =
  await createPageRouter({
    adapter: {
      createDeferred: () => ({ value: null, loading: true, error: null }),
      resolveDeferred(ref, value) { return { value, loading: false, error: null }; },
      rejectDeferred(ref, error) { return { value: null, loading: false, error: new Error(error) }; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layouts) {
        flushSync(() => {
          setState({
            component: comp,
            props: pageData.props,
            layouts,
            shared: { ...state.shared, ...(pageData.shared || {}) },
            errors: pageData.errors || {},
          });
        });
      },
      onDeferredUpdate(props) {
        setState({ props: { ...props } });
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? "30s")}),
  });

setActionRouter(router);

state = {
  component: initialComponent,
  props: initialPageData.props,
  layouts: initialLayouts,
  shared: initialPageData.shared || {},
  errors: initialPageData.errors || {},
};

function App() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!snap.component) return null;

  let element = React.createElement(snap.component, snap.props);
  for (let i = snap.layouts.length - 1; i >= 0; i--) {
    element = React.createElement(snap.layouts[i], null, element);
  }

  return React.createElement(
    SharedContext.Provider,
    { value: snap.shared },
    React.createElement(
      ErrorsContext.Provider,
      { value: snap.errors },
      React.createElement(
        RouterContext.Provider,
        { value: router },
        element
      )
    )
  );
}

const appEl = document.getElementById("app");
hydrateRoot(appEl, React.createElement(App));
appEl.setAttribute("data-hydrated", "true");
export { router };
start();
`;
}
