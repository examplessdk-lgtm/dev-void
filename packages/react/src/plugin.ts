import react from '@vitejs/plugin-react';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

export interface VoidReactOptions {
  react?: Parameters<typeof react>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

export function voidReact(options?: VoidReactOptions): Array<Plugin> {
  const pagesDir = join(process.cwd(), 'pages');
  return [
    ...react(options?.react),
    pagesPlugin(pagesDir, {
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir),
  ];
}
