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

function isVuePageFile(id: string, pagesDir: string): boolean {
  if (!id.startsWith(pagesDir + '/')) {
    return false;
  }
  const rel = id.slice(pagesDir.length + 1);
  if (rel.split('/').some((s) => s.startsWith('_'))) {
    return false;
  }
  const basename = rel.slice(rel.lastIndexOf('/') + 1);
  return basename !== 'layout.vue' && !basename.endsWith('.island.vue');
}

function stripDefinePropsTypeArgument(code: string): string | null {
  // Find defineProps<...>( and strip the generic using bracket counting
  // to handle nested generics like InferProps<typeof loader>
  const match = /\bdefineProps\s*</.exec(code);
  if (!match) {
    return null;
  }

  const start = match.index + match[0].length - 1; // position of '<'
  let depth = 0;
  let end = -1;
  let newlineCount = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') {
      newlineCount++;
    } else if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }

  return code.slice(0, start) + '\n'.repeat(newlineCount) + code.slice(end + 1);
}

/** Check if the pages directory has any non-island Vue page files. */
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
      if (name.endsWith('.vue') && !name.includes('.island.')) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Array<Plugin> {
  let pageScan: PageScanResult | null = null;
  let viteConfig: ResolvedConfig | undefined;
  const root = dirname(pagesDir);

  return [
    {
      name: 'void-vue:pages-transform',
      enforce: 'pre',

      transform: {
        filter: { id: /\.vue$/ },
        handler(code, id) {
          if (!isVuePageFile(id, pagesDir)) {
            return;
          }
          const transformed = stripDefinePropsTypeArgument(code);
          if (!transformed) {
            return;
          }
          return { code: transformed, map: { mappings: '' } };
        },
      },

      handleHotUpdate: {
        order: 'pre',
        handler(ctx) {
          if (!isVuePageFile(ctx.file, pagesDir)) {
            return;
          }

          const read = ctx.read;
          // Vue reparses raw SFC source during HMR, so apply the same rewrite here.
          ctx.read = async () => {
            const code = await read();
            return stripDefinePropsTypeArgument(code) ?? code;
          };
        },
      },
    },
    {
      name: 'void-vue:pages',

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
              // Pre-include Vue so it's not discovered late via dynamic
              // imports during SPA navigation, avoiding a full-page reload
              // from Vite's dep optimizer.
              include: ['vue'],
            },
          };
        }

        // Skip the pages-client bundle when all pages are island pages
        if (!hasNonIslandPages(pagesDir)) {
          return;
        }

        return {
          environments: {
            client: {
              build: {
                manifest: true,
                rollupOptions: {
                  input: { 'pages-client': CLIENT_ENTRY_ID },
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
      provide("__void_router", createSsrRouter(pageObj.url || "/"));
      provide("__void_navigation", idleNavigationState());
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
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${assetTags.css}\${assetTags.preloads}</head>
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
import { createSSRApp, h, reactive, provide, shallowRef, nextTick, ref } from "vue";
import { createDeferred, resolveDeferred, rejectDeferred } from "@void/vue/deferred";
import { setActionRouter } from "@void/vue";
import { createPageRouter, createRouterFacade, idleNavigationState } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

const shared = reactive({});
const errors = reactive({});
const currentComponent = shallowRef(null);
const currentLayouts = shallowRef([]);
const currentProps = shallowRef({});
const routeUrl = ref(window.location.pathname + window.location.search + window.location.hash);
const navigation = reactive(idleNavigationState());

function patchProps(comp, props) {
  if (comp.__voidPatched) return;
  comp.props = Object.keys(props);
  comp.__voidPatched = true;
}

const { router, initialPageData, initialComponent, initialLayouts, start } =
  await createPageRouter({
    adapter: {
      createDeferred: () => createDeferred(),
      resolveDeferred(ref, value) { resolveDeferred(ref, value); return ref; },
      rejectDeferred(ref, error) { rejectDeferred(ref, error); return ref; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layouts) {
        Object.assign(shared, pageData.shared || {});
        for (const key of Object.keys(errors)) delete errors[key];
        Object.assign(errors, pageData.errors || {});
        currentProps.value = pageData.props;
        currentLayouts.value = layouts;
        currentComponent.value = comp;
        return nextTick();
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    staticPageData: ${!!staticPageData?.enabled},
    staticPageDataFastPath: ${!!staticPageData?.fastPath},
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
    onRouteChange(url) {
      routeUrl.value = url;
    },
    onNavigationChange(next) {
      navigation.state = next.state;
      navigation.location = next.location;
      navigation.method = next.method;
    },
  });

const reactiveRouter = createRouterFacade(router, () => routeUrl.value);

setActionRouter(reactiveRouter);

Object.assign(shared, initialPageData.shared || {});
Object.assign(errors, initialPageData.errors || {});
currentProps.value = initialPageData.props;
currentComponent.value = initialComponent;
currentLayouts.value = initialLayouts;

const app = createSSRApp({
  setup() {
    provide("__void_shared", shared);
    provide("__void_errors", errors);
    provide("__void_router", reactiveRouter);
    provide("__void_navigation", navigation);

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
export { reactiveRouter as router };
start();
`;
}
