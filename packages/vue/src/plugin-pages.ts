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

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin[] {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);

  return [
    {
      name: "void-vue:pages-transform",
      enforce: "pre",

      transform: {
        filter: { id: /\.vue$/ },
        handler(code, id) {
          if (!id.startsWith(pagesDir + "/")) return;
          const rel = id.slice(pagesDir.length + 1);
          if (rel.split("/").some((s) => s.startsWith("_"))) return;
          const basename = rel.slice(rel.lastIndexOf("/") + 1);
          if (basename === "layout.vue" || basename.endsWith(".island.vue")) return;

          // Find defineProps<...>( and strip the generic using bracket counting
          // to handle nested generics like InferProps<typeof loader>
          const match = /\bdefineProps\s*</.exec(code);
          if (!match) return;

          const start = match.index + match[0].length - 1; // position of '<'
          let depth = 0;
          let end = -1;
          let newlineCount = 0;
          for (let i = start; i < code.length; i++) {
            const ch = code[i];
            if (ch === "\n") newlineCount++;
            else if (ch === "<") depth++;
            else if (ch === ">") {
              depth--;
              if (depth === 0) {
                end = i;
                break;
              }
            }
          }
          if (end === -1) return;

          // Replace with equivalent newlines to preserve line count for source maps
          const transformed =
            code.slice(0, start) + "\n".repeat(newlineCount) + code.slice(end + 1);
          return { code: transformed, map: { mappings: "" } };
        },
      },
    },
    {
      name: "void-vue:pages",

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
            return generateRendererModule(pageScan, pagesDir);
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
          return {
            optimizeDeps: {
              // Pre-include Vue so it's not discovered late via dynamic
              // imports during SPA navigation, avoiding a full-page reload
              // from Vite's dep optimizer.
              include: ["vue"],
            },
          };
        }

        return {
          environments: {
            client: {
              build: {
                manifest: true,
                rollupOptions: {
                  input: { "pages-client": CLIENT_ENTRY_ID },
                },
              },
            },
          },
        };
      },
    },
  ];
}

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";

${generateComponentManifest(scan, pagesDir)}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function patchProps(comp, props) {
  if (comp.__voidPatched) return;
  comp.props = Object.keys(props);
  comp.__voidPatched = true;
}

export async function renderPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const app = createSSRApp({
    setup() {
      provide("__void_shared", reactive(pageObj.shared || {}));
      provide("__void_errors", reactive(pageObj.errors || {}));
      provide("__void_router", null);
      return () => {
        patchProps(PageComponent, pageObj.props);
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
  const pageData = escapeAttr(JSON.stringify(pageObj));

  return \`<!doctype html>
<html>
<head>\${assetTags.head}</head>
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
import { createSSRApp, h, reactive, provide, shallowRef, nextTick } from "vue";
import { createDeferred, resolveDeferred, rejectDeferred } from "@void-x/vue/deferred";

const VIEW_TRANSITIONS_ENABLED = ${!!viewTransitions};

${generateComponentManifest(scan, pagesDir)}

const initialPageData = JSON.parse(
  document.getElementById("app").getAttribute("data-page")
);

const shared = reactive(initialPageData.shared || {});
const errors = reactive(initialPageData.errors || {});

function patchProps(comp, props) {
  if (comp.__voidPatched) return;
  comp.props = Object.keys(props);
  comp.__voidPatched = true;
}

async function resolveComponent(id) {
  const loader = components[id];
  if (!loader) throw new Error("Unknown page component: " + id);
  return (await loader()).default;
}

async function resolveLayouts(componentId) {
  const ids = layoutTree[componentId] || [];
  return Promise.all(ids.map(async (id) => (await components[id]()).default));
}

const currentComponent = shallowRef(null);
const currentLayouts = shallowRef([]);
const currentProps = shallowRef(initialPageData.props);

// --- Deferred props ---

let activeKeyRefs = {};

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
      // Could be a named group (multiple keys) or a single object-valued prop.
      // Check if any keys in data match our keyRefs — if so, resolve individually.
      let resolvedAny = false;
      for (const [key, value] of Object.entries(data)) {
        if (activeKeyRefs[key]) {
          resolveDeferred(activeKeyRefs[key], value);
          resolvedAny = true;
        }
      }
      // If no individual keys matched, this is a single prop whose value is an object
      if (!resolvedAny && activeKeyRefs[group]) {
        resolveDeferred(activeKeyRefs[group], data);
      }
    } else {
      if (activeKeyRefs[group]) resolveDeferred(activeKeyRefs[group], data);
    }
  } else if (error !== undefined) {
    // Reject all keys in this group
    for (const [key, ref] of Object.entries(activeKeyRefs)) {
      if (ref.loading) {
        // Check if this key belongs to the errored group by checking deferredKeys
        rejectDeferred(ref, typeof error === "string" ? error : String(error));
      }
    }
  }
}

// Set up deferred props for initial page data
activeKeyRefs = setupDeferredProps(initialPageData);

// SSR deferred resolution via streamed script tags
window.__resolveDeferred = (group, data) => handleDeferredMessage(group, data, undefined);
window.__rejectDeferred = (group, error) => handleDeferredMessage(group, undefined, error);

// --- End deferred props ---

// Resolve all async work first, then update refs synchronously so Vue
// never renders with a new component but stale props.
async function updatePage(pageData) {
  const [comp, layouts] = await Promise.all([
    resolveComponent(pageData.component),
    resolveLayouts(pageData.component),
  ]);
  // Set props BEFORE component — if the component changes, the first render
  // will already see the new props.
  currentProps.value = pageData.props;
  currentLayouts.value = layouts;
  currentComponent.value = comp;
}

const _navListeners = new Set();
let _abortController = null;

export const router = {
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
          // Process any remaining buffer
          if (buffer.trim()) processLines();
        } catch (e) {
          if (e.name !== "AbortError") {
            // Stream closed unexpectedly — reject remaining deferred
            for (const ref of Object.values(activeKeyRefs)) {
              if (ref.loading) rejectDeferred(ref, "Stream closed before resolution");
            }
          }
        }
      })();
    } else {
      pageData = await response.json();
    }

    // Resolve async work before starting the transition
    const [comp, layouts] = await Promise.all([
      resolveComponent(pageData.component),
      resolveLayouts(pageData.component),
    ]);

    const applyUpdate = () => {
      Object.assign(shared, pageData.shared || {});
      for (const key of Object.keys(errors)) delete errors[key];
      Object.assign(errors, pageData.errors || {});
      currentProps.value = pageData.props;
      currentLayouts.value = layouts;
      currentComponent.value = comp;
    };

    const useTransition = options.viewTransition ?? VIEW_TRANSITIONS_ENABLED;
    if (useTransition && document.startViewTransition) {
      document.startViewTransition(() => {
        applyUpdate();
        return nextTick();
      });
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

// Resolve initial page components before mounting
await updatePage(initialPageData);

const app = createSSRApp({
  setup() {
    provide("__void_shared", shared);
    provide("__void_errors", errors);
    provide("__void_router", router);

    return () => {
      if (!currentComponent.value) return null;
      patchProps(currentComponent.value, currentProps.value);
      let vnode = h(currentComponent.value, currentProps.value);
      for (let i = currentLayouts.value.length - 1; i >= 0; i--) {
        const inner = vnode;
        vnode = h(currentLayouts.value[i], null, { default: () => inner });
      }
      return vnode;
    };
  }
});

app.mount("#app");
document.getElementById("app").setAttribute("data-hydrated", "true");

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
