import type { Plugin } from "vite";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { join } from "node:path";

import { islandsPlugin } from "./plugin-islands";
import { pagesPlugin } from "./plugin-pages";

export interface VoidSvelteOptions {
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
}

export function voidSvelte(options?: VoidSvelteOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...(svelte(options?.svelte) as Plugin[]),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
    islandsPlugin(pagesDir),
  ];
}
