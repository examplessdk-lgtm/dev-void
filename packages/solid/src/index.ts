import type { Plugin } from "vite";

import { join } from "node:path";
import solid from "vite-plugin-solid";

import { islandsPlugin } from "./plugin-islands";
import { pagesPlugin } from "./plugin-pages";

export interface VoidSolidOptions {
  solid?: Parameters<typeof solid>[0];
  viewTransitions?: boolean;
}

export function voidSolid(options?: VoidSolidOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    solid({ ssr: true, ...options?.solid }),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
    islandsPlugin(pagesDir),
  ];
}
