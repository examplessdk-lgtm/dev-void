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

/** Check if the pages directory has any non-island page files (.tsx/.jsx without .island.). */
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
      if (/\.(tsx|jsx)$/.test(name) && !name.includes('.island.')) {
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
  let viteConfig: ResolvedConfig | undefined;
  const root = dirname(pagesDir);

  return {
    name: 'void-solid:pages',

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
          return generateRendererModule(pageScan, pagesDir);
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
        return {
          optimizeDeps: {
            // Exclude @void/solid so the virtual module and user
            // components share the same Solid context objects (identity).
            exclude: ['@void/solid'],
            // Pre-include Solid entries discovered late via dynamic imports
            include: ['solid-js', 'solid-js/web', 'solid-js/store'],
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

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { renderToStringAsync, generateHydrationScript } from "solid-js/web";
import { createComponent } from "solid-js";
import { SharedContext, ErrorsContext, RouterContext, NavigationContext } from "@void/solid";
import { createSsrRouter, idleNavigationState } from "void/pages-client";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";
import { serializePageData } from "void/pages-server";

${generateComponentManifest(scan, pagesDir)}

export async function renderPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  function ServerApp() {
    return createComponent(SharedContext.Provider, {
      value: pageObj.shared || {},
      get children() {
        return createComponent(ErrorsContext.Provider, {
          value: pageObj.errors || {},
          get children() {
            return createComponent(RouterContext.Provider, {
              value: createSsrRouter(pageObj.url || "/"),
              get children() {
                return createComponent(NavigationContext.Provider, {
                  value: () => idleNavigationState(),
                  get children() {
                    // Build layout chain inside providers so contexts are available
                    let element = createComponent(PageComponent, pageObj.props);
                    for (let i = layoutComponents.length - 1; i >= 0; i--) {
                      const Layout = layoutComponents[i];
                      const child = element;
                      element = createComponent(Layout, { get children() { return child; } });
                    }
                    return element;
                  }
                });
              }
            });
          }
        });
      }
    });
  }

  // Use createComponent to match the client's hydration tree structure
  const html = await renderToStringAsync(() => createComponent(ServerApp, {}));

  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${assetTags.css}\${assetTags.preloads}\${generateHydrationScript()}</head>
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
import { createSignal, createComponent, batch } from "solid-js";
import { hydrate } from "solid-js/web";
import { SharedContext, ErrorsContext, RouterContext, NavigationContext, setActionRouter } from "@void/solid";
import { createRouterFacade, createVoidRouter, idleNavigationState } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

const [component, setComponent] = createSignal(null);
const [pageProps, setPageProps] = createSignal({});
const [layouts, setLayouts] = createSignal([]);
const [shared, setShared] = createSignal({});
const [errors, setErrors] = createSignal({});
const [routeUrl, setRouteUrl] = createSignal(window.location.pathname + window.location.search + window.location.hash);
const [navigation, setNavigation] = createSignal(idleNavigationState());

const { router, initialPageData, initialComponent, initialLayouts, start } =
  await createVoidRouter({
    adapter: {
      createDeferred: () => ({ value: null, loading: true, error: null }),
      resolveDeferred(ref, value) { return { value, loading: false, error: null }; },
      rejectDeferred(ref, error) { return { value: null, loading: false, error: new Error(error) }; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layoutComps) {
        batch(() => {
          setPageProps(pageData.props);
          setComponent(() => comp);
          setLayouts(layoutComps);
          setShared((prev) => ({ ...prev, ...(pageData.shared || {}) }));
          setErrors(pageData.errors || {});
        });
      },
      onDeferredUpdate(props) {
        batch(() => { setPageProps({ ...props }); });
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    staticPageData: ${!!staticPageData?.enabled},
    staticPageDataFastPath: ${!!staticPageData?.fastPath},
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
    onRouteChange(url) {
      setRouteUrl(url);
    },
    onNavigationChange(next) {
      setNavigation(next);
    },
  });

const reactiveRouter = createRouterFacade(router, () => routeUrl());

setActionRouter(reactiveRouter);

batch(() => {
  setComponent(() => initialComponent);
  setPageProps(initialPageData.props);
  setLayouts(initialLayouts);
  setShared(initialPageData.shared || {});
  setErrors(initialPageData.errors || {});
});

function App() {
  return createComponent(SharedContext.Provider, {
    get value() { return shared(); },
    get children() {
      return createComponent(ErrorsContext.Provider, {
        value: errors,
        get children() {
          return createComponent(RouterContext.Provider, {
            value: reactiveRouter,
            get children() {
              return createComponent(NavigationContext.Provider, {
                value: navigation,
                get children() {
                  const Comp = component();
                  if (!Comp) return null;
                  let element = createComponent(Comp, pageProps());
                  const layoutList = layouts();
                  for (let i = layoutList.length - 1; i >= 0; i--) {
                    const Layout = layoutList[i];
                    const child = element;
                    element = createComponent(Layout, { get children() { return child; } });
                  }
                  return element;
                }
              });
            }
          });
        }
      });
    }
  });
}

const appEl = document.getElementById("app");
hydrate(() => createComponent(App, {}), appEl);
appEl.setAttribute("data-hydrated", "true");
export { reactiveRouter as router };
start();
`;
}
