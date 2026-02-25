import type { Plugin } from "vite";

import react from "@vitejs/plugin-react";
import { join } from "node:path";

import { islandsPlugin } from "./plugin-islands";
import { pagesPlugin } from "./plugin-pages";

export interface VoidReactOptions {
  react?: Parameters<typeof react>[0];
  viewTransitions?: boolean;
}

export function voidReact(options?: VoidReactOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...react(options?.react),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
    islandsPlugin(pagesDir),
  ];
}
