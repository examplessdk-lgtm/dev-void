import { join } from 'pathe';
import type { Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

export interface VoidSolidOptions {
  solid?: Parameters<typeof solid>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

// The runtime entry exports raw `.tsx` source. Without these hints, Vite's SSR
// dep optimizer prebundles the package with esbuild's default `automatic` JSX
// transform, emitting `import { jsx } from "react/jsx-runtime"` — which then
// fails to resolve in a Solid project. Letting `vite-plugin-solid` see the
// source directly keeps JSX compilation correct.
// TODO: remove the *-sdk alias later
const VOID_SOLID_PKGS = ['@void/solid', '@void-sdk/solid'];

function configPlugin(): Plugin {
  return {
    name: 'void:solid:config',
    config() {
      return {
        optimizeDeps: { exclude: VOID_SOLID_PKGS },
        ssr: {
          noExternal: VOID_SOLID_PKGS,
          optimizeDeps: { exclude: VOID_SOLID_PKGS },
        },
      };
    },
  };
}

export function voidSolid(options?: VoidSolidOptions): Array<Plugin> {
  const pagesDir = join(process.cwd(), 'pages');
  return [
    configPlugin(),
    solid({ ssr: true, ...options?.solid }),
    pagesPlugin(pagesDir, {
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir),
  ];
}
