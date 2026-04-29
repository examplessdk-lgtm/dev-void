import vue from '@vitejs/plugin-vue';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';

export interface VoidVueOptions {
  vue?: Parameters<typeof vue>[0];
  viewTransitions?: boolean;
}

export function voidVue(options?: VoidVueOptions): Array<Plugin> {
  const pagesDir = join(process.cwd(), 'pages');
  return [
    vue(options?.vue) as Plugin,
    ...pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
    ...islandsPlugin(pagesDir),
  ];
}
