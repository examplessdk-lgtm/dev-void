import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { resolveStaticPageDataBuildOptions, scanPages } from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';
import { generateComponentManifest } from './pages-manifest.ts';

const RENDERER_ID = 'virtual:void-pages-renderer';
const CLIENT_ENTRY_ID = 'virtual:void-pages-client';

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

interface PagesPluginOptions {
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

/** Check if the pages directory has any non-island Svelte page files. */
function hasNonIslandPages(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name;
      if (name.startsWith('_') || name.startsWith('layout.')) {
        continue;
      }
      if (name.endsWith('.svelte') && !name.includes('.island.')) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  let viteConfig: ResolvedConfig | undefined;
  const root = dirname(pagesDir);

  return {
    name: 'void-svelte:pages',

    async buildStart() {
      if (existsSync(pagesDir)) {
        pageScan = await scanPages(root);
      }
    },

    resolveId: {
      filter: { id: /^virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        return '\0' + id;
      },
    },

    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        if (id === '\0' + RENDERER_ID) {
          if (!pageScan) {
            return "export function renderPage() { throw new Error('No pages found'); }";
          }
          return generateRendererModule(pageScan, pagesDir, isDev);
        }
        if (id === '\0' + CLIENT_ENTRY_ID) {
          if (!pageScan) {
            return '';
          }
          return generateClientEntry(
            pageScan,
            pagesDir,
            options?.viewTransitions,
            options?.prefetch,
            resolveStaticPageDataBuildOptions(root, { publicDir: viteConfig?.publicDir }),
          );
        }
      },
    },

    configResolved(config) {
      viteConfig = config;
    },

    config(_, env) {
      if (!existsSync(pagesDir)) {
        return;
      }

      if (env.command === 'serve') {
        isDev = true;
        return {
          optimizeDeps: {
            // Exclude @void/svelte so the virtual module and user
            // components share the same Svelte context (identity).
            exclude: ['@void/svelte'],
            // Pre-include Svelte so it's not discovered late via dynamic imports.
            include: ['svelte', 'svelte/store', 'svelte/internal', 'svelte/internal/client'],
          },
        };
      }

      // Skip the pages-client bundle when all pages are island pages
      if (!hasNonIslandPages(pagesDir)) {
        return;
      }

      return {
        build: {
          manifest: true,
          rollupOptions: {
            input: { 'pages-client': CLIENT_ENTRY_ID },
          },
        },
      };
    },
  };
}

function generateRendererModule(scan: PageScanResult, pagesDir: string, _isDev: boolean): string {
  return `
import { render } from "svelte/server";
import App from "@void/svelte/App.svelte";
import { createSsrRouter, idleNavigationState } from "void/pages-client";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}

function serializePageData(pageObj) {
  return JSON.stringify(pageObj)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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
      router: createSsrRouter(pageObj.url || "/"),
      routeUrl: pageObj.url || "/",
      navigation: idleNavigationState(),
      stores: null,
    },
  });

  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${head}\${assetTags.css}\${assetTags.preloads}</head>
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
  staticPageData?: StaticPageDataBuildOptions,
): string {
  return `
import { hydrate } from "svelte";
import { writable } from "svelte/store";
import App from "@void/svelte/App.svelte";
import { setActionRouter } from "@void/svelte";
import { createPageRouter, createRouterFacade, idleNavigationState } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

const pageStore = writable(null);
const propsStore = writable({});
const layoutsStore = writable([]);
const sharedStore = writable({});
const errorsStore = writable({});
let routeUrl = window.location.pathname + window.location.search + window.location.hash;
const routeStore = writable(routeUrl);
const navigationStore = writable(idleNavigationState());

const { router, initialPageData, initialComponent, initialLayouts, start } =
  await createPageRouter({
    adapter: {
      createDeferred: () => ({ value: null, loading: true, error: null }),
      resolveDeferred(ref, value) { return { value, loading: false, error: null }; },
      rejectDeferred(ref, error) { return { value: null, loading: false, error: new Error(error) }; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layouts) {
        propsStore.set(pageData.props);
        sharedStore.update((s) => ({ ...s, ...(pageData.shared || {}) }));
        errorsStore.set(pageData.errors || {});
        layoutsStore.set(layouts);
        pageStore.set(comp);
      },
      onDeferredUpdate(props) {
        propsStore.set({ ...props });
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    staticPageData: ${!!staticPageData?.enabled},
    staticPageDataFastPath: ${!!staticPageData?.fastPath},
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
    onRouteChange(url) {
      routeUrl = url;
      routeStore.set(url);
    },
    onNavigationChange(navigation) {
      navigationStore.set(navigation);
    },
  });

const reactiveRouter = createRouterFacade(router, () => routeUrl);

setActionRouter(reactiveRouter);

pageStore.set(initialComponent);
propsStore.set(initialPageData.props);
layoutsStore.set(initialLayouts);
sharedStore.set(initialPageData.shared || {});
errorsStore.set(initialPageData.errors || {});

const appEl = document.getElementById("app");
hydrate(App, {
  target: appEl,
  props: {
    page: initialComponent,
    layouts: initialLayouts,
    pageProps: initialPageData.props,
    shared: initialPageData.shared || {},
    errors: initialPageData.errors || {},
    router,
    routeUrl,
    navigation: idleNavigationState(),
    stores: {
      page: pageStore,
      props: propsStore,
      layouts: layoutsStore,
      shared: sharedStore,
      errors: errorsStore,
      route: routeStore,
      navigation: navigationStore,
    },
  },
});

appEl.setAttribute("data-hydrated", "true");
export { reactiveRouter as router };
start();
`;
}
