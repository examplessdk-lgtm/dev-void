import { svelte } from '@sveltejs/vite-plugin-svelte';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { islandsPlugin } from './plugin-islands';
import { pagesPlugin } from './plugin-pages';

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

export interface VoidSvelteOptions {
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

export function voidSvelte(options?: VoidSvelteOptions): Plugin[] {
  const pagesDir = join(process.cwd(), 'pages');
  return [
    ...(svelte(options?.svelte) as Plugin[]),
    pagesPlugin(pagesDir, {
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir),
  ];
}
