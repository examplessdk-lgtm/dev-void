import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'pathe';
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
  let isDev = false;
  let viteConfig: ResolvedConfig | undefined;
  const root = dirname(pagesDir);

  return {
    name: 'void-react:pages',

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

      // In dev mode, exclude @void/react from dep optimization so the
      // virtual module and user components share the same React context objects.
      // Without this, Vite pre-bundles @void/react, creating separate
      // context instances that break useContext (React contexts use object identity).
      if (env.command === 'serve') {
        isDev = true;
        const reactOptimizeDeps = [
          'react',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          'react-dom',
          'react-dom/client',
          'react-dom/server',
        ];
        return {
          optimizeDeps: {
            // Exclude @void/react so the virtual module and user
            // components share the same React context objects (identity).
            exclude: ['@void/react'],
            // Pre-include React entries that are discovered late via dynamic
            // imports during SPA navigation, avoiding a full-page reload
            // from Vite's dep optimizer.
            include: reactOptimizeDeps,
          },
          ssr: {
            optimizeDeps: {
              include: reactOptimizeDeps,
            },
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
    : '';

  return `
import { renderReactPage } from "@void/react/pages-server";

${generateComponentManifest(scan, pagesDir)}

	const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};
	
	export async function renderPage(pageObj, assetTags) {
	  return renderReactPage({
	    pageObj,
	    assetTags,
	    components,
	    layoutTree,
	    preambleScript: PREAMBLE_SCRIPT,
	  });
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
	import { startReactPages } from "@void/react/pages-client";
	import { parseCacheFor } from "void/pages-prefetch";
	
	${generateComponentManifest(scan, pagesDir)}

	const { router } = await startReactPages({
	  components,
	  layoutTree,
	  routeMeta,
	  matchRoute,
	  staticPageData: ${!!staticPageData?.enabled},
	  staticPageDataFastPath: ${!!staticPageData?.fastPath},
	  viewTransitions: ${!!viewTransitions},
	  prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
	  prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
	});
	export { router };
	`;
}
