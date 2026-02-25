import type { Plugin } from "vite";
import type { PageScanResult } from "void/pages";

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { scanPages } from "void/pages";

import { generateComponentManifest } from "./pages-manifest";

const RENDERER_ID = "virtual:void-pages-renderer";
const CLIENT_ENTRY_ID = "virtual:void-pages-client";

interface PagesPluginOptions {
  viewTransitions?: boolean;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  const root = dirname(pagesDir);

  return {
    name: "void-svelte:pages",

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
          return generateClientEntry(pageScan, pagesDir, options?.viewTransitions);
        }
      },
    },

    config(_, env) {
      if (!existsSync(pagesDir)) return;

      if (env.command === "serve") {
        isDev = true;
        return {
          optimizeDeps: {
            // Exclude @void-x/svelte so the virtual module and user
            // components share the same Svelte context (identity).
            exclude: ["@void-x/svelte"],
            // Pre-include Svelte so it's not discovered late via dynamic imports.
            include: ["svelte", "svelte/store", "svelte/internal", "svelte/internal/client"],
          },
        };
      }

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

function generateRendererModule(scan: PageScanResult, pagesDir: string, _isDev: boolean): string {
  return `
import { render } from "svelte/server";
import App from "@void-x/svelte/App.svelte";

${generateComponentManifest(scan, pagesDir)}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderPage(pageObj, assetTags) {
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

  const pageData = escapeAttr(JSON.stringify(pageObj));

  return \`<!doctype html>
<html>
<head>\${head}\${assetTags.head}</head>
<body>
  <div id="app" data-page="\${pageData}">\${html}</div>
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
): string {
  return `
import { hydrate } from "svelte";
import { writable } from "svelte/store";
import App from "@void-x/svelte/App.svelte";

const VIEW_TRANSITIONS_ENABLED = ${!!viewTransitions};

${generateComponentManifest(scan, pagesDir)}

// --- Component resolution ---
async function resolveComponent(id) {
  const loader = components[id];
  if (!loader) throw new Error("Unknown page component: " + id);
  return (await loader()).default;
}

async function resolveLayouts(componentId) {
  const ids = layoutTree[componentId] || [];
  return Promise.all(ids.map(async (id) => (await components[id]()).default));
}

// --- Stores ---
const pageStore = writable(null);
const propsStore = writable({});
const layoutsStore = writable([]);
const sharedStore = writable({});
const errorsStore = writable({});

// --- Deferred props ---
let activeKeyRefs = {};
let currentPropsObj = {};
let _abortController = null;

function createDeferred() {
  return { value: null, loading: true, error: null };
}

function setupDeferredProps(pageData) {
  const keyRefs = {};
  if (!pageData.deferredKeys) return keyRefs;
  for (const [key, group] of Object.entries(pageData.deferredKeys)) {
    const ref = createDeferred();
    keyRefs[key] = ref;
    pageData.props[key] = ref;
  }
  return keyRefs;
}

function handleDeferredMessage(group, data, error) {
  if (data !== undefined) {
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      let resolvedAny = false;
      for (const [key, value] of Object.entries(data)) {
        if (activeKeyRefs[key]) {
          const newRef = { value, loading: false, error: null };
          activeKeyRefs[key] = newRef;
          currentPropsObj[key] = newRef;
          resolvedAny = true;
        }
      }
      if (!resolvedAny && activeKeyRefs[group]) {
        const newRef = { value: data, loading: false, error: null };
        activeKeyRefs[group] = newRef;
        currentPropsObj[group] = newRef;
      }
    } else {
      if (activeKeyRefs[group]) {
        const newRef = { value: data, loading: false, error: null };
        activeKeyRefs[group] = newRef;
        currentPropsObj[group] = newRef;
      }
    }
  } else if (error !== undefined) {
    const errStr = typeof error === "string" ? error : String(error);
    for (const [key, ref] of Object.entries(activeKeyRefs)) {
      if (ref.loading) {
        const newRef = { value: null, loading: false, error: new Error(errStr) };
        activeKeyRefs[key] = newRef;
        currentPropsObj[key] = newRef;
      }
    }
  }
  propsStore.set({ ...currentPropsObj });
}

window.__resolveDeferred = (group, data) => handleDeferredMessage(group, data, undefined);
window.__rejectDeferred = (group, error) => handleDeferredMessage(group, undefined, error);

// Queue drain is done after setupDeferredProps below

// --- Router ---
const _navListeners = new Set();

const router = {
  onNavigation(onStart, onEnd) {
    const entry = { onStart, onEnd };
    _navListeners.add(entry);
    return () => _navListeners.delete(entry);
  },
  async visit(url, options = {}) {
    for (const l of _navListeners) l.onStart?.();
    try {
    // Abort any in-flight deferred stream from previous navigation
    _abortController?.abort();
    _abortController = new AbortController();

    const method = (options.method || "GET").toUpperCase();
    const headers = { "X-VoidPages": "true", "Accept": "application/json" };
    const fetchOptions = { method, headers, signal: _abortController.signal };

    if (options.data && method !== "GET") {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.data);
    }

    const response = await fetch(url, fetchOptions);

    if (response.redirected) {
      return router.visit(response.url);
    }

    if (!response.headers.get("X-VoidPages")) {
      window.location.href = url;
      return;
    }

    const contentType = response.headers.get("content-type") || "";
    let pageData;

    if (contentType.includes("application/x-ndjson")) {
      // Streaming response with deferred props — read NDJSON
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstLine = true;
      const signal = _abortController.signal;

      const processLines = () => {
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          if (firstLine) {
            pageData = JSON.parse(line);
            activeKeyRefs = setupDeferredProps(pageData);
            currentPropsObj = pageData.props;
            firstLine = false;
          } else {
            const msg = JSON.parse(line);
            if (msg.__deferred) {
              handleDeferredMessage(msg.__deferred, msg.data, msg.error);
            }
          }
        }
      };

      // Read first line synchronously to get pageData for mounting
      while (firstLine) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        processLines();
      }

      // Continue reading deferred data in background
      (async () => {
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            processLines();
          }
          if (buffer.trim()) processLines();
        } catch (e) {
          if (e.name !== "AbortError") {
            for (const [key, ref] of Object.entries(activeKeyRefs)) {
              if (ref.loading) {
                const newRef = { value: null, loading: false, error: new Error("Stream closed before resolution") };
                activeKeyRefs[key] = newRef;
                currentPropsObj[key] = newRef;
              }
            }
            propsStore.set({ ...currentPropsObj });
          }
        }
      })();
    } else {
      pageData = await response.json();
    }

    // Resolve async work before updating stores
    const [comp, layouts] = await Promise.all([
      resolveComponent(pageData.component),
      resolveLayouts(pageData.component),
    ]);

    const applyUpdate = () => {
      // Update props before page to avoid rendering new component with stale props
      propsStore.set(pageData.props);
      sharedStore.update((s) => ({ ...s, ...(pageData.shared || {}) }));
      errorsStore.set(pageData.errors || {});
      layoutsStore.set(layouts);
      pageStore.set(comp);
    };

    const useTransition = options.viewTransition ?? VIEW_TRANSITIONS_ENABLED;
    if (useTransition && document.startViewTransition) {
      document.startViewTransition(applyUpdate);
    } else {
      applyUpdate();
    }

    if (!options.preserveState) {
      window.history.pushState({}, "", pageData.url);
    }

    if (!options.preserveScroll) {
      window.scrollTo(0, 0);
    }

    return pageData;
    } finally {
      for (const l of _navListeners) l.onEnd?.();
    }
  },

  async reload() {
    return router.visit(window.location.pathname + window.location.search, {
      preserveState: true,
      preserveScroll: true,
    });
  },

  post(url, data, options = {}) {
    return router.visit(url, { ...options, method: "POST", data });
  },
  put(url, data, options = {}) {
    return router.visit(url, { ...options, method: "PUT", data });
  },
  patch(url, data, options = {}) {
    return router.visit(url, { ...options, method: "PATCH", data });
  },
  delete(url, options = {}) {
    return router.visit(url, { ...options, method: "DELETE" });
  },
};

// --- Initialize ---
const appEl = document.getElementById("app");
const initialPageData = JSON.parse(appEl.getAttribute("data-page"));

const [initialComp, initialLayouts] = await Promise.all([
  resolveComponent(initialPageData.component),
  resolveLayouts(initialPageData.component),
]);

activeKeyRefs = setupDeferredProps(initialPageData);
currentPropsObj = initialPageData.props;

pageStore.set(initialComp);
propsStore.set(initialPageData.props);
layoutsStore.set(initialLayouts);
sharedStore.set(initialPageData.shared || {});
errorsStore.set(initialPageData.errors || {});

hydrate(App, {
  target: appEl,
  props: {
    page: initialComp,
    layouts: initialLayouts,
    pageProps: initialPageData.props,
    shared: initialPageData.shared || {},
    errors: initialPageData.errors || {},
    router,
    stores: {
      page: pageStore,
      props: propsStore,
      layouts: layoutsStore,
      shared: sharedStore,
      errors: errorsStore,
    },
  },
});

appEl.setAttribute("data-hydrated", "true");

// Drain any deferred resolutions that arrived before the module loaded (after hydration)
if (window.__deferredQueue) {
  for (const entry of window.__deferredQueue) {
    if (entry.length === 3) handleDeferredMessage(entry[0], undefined, entry[2]);
    else handleDeferredMessage(entry[0], entry[1], undefined);
  }
  delete window.__deferredQueue;
}

window.addEventListener("popstate", () => {
  router.visit(window.location.pathname + window.location.search, { preserveState: true });
});
`;
}
