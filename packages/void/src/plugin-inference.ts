import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "tinyglobby";

import { inferBindingsFromSource, mergeBindings, type InferredBindings } from "./inference/walk";
import { getSsrServerEntryPath } from "./ssr/entry";

/** Framework class determines integration depth. */
export type FrameworkClass = "a" | "b" | "c";

export interface DetectedFramework {
  name: string;
  class: FrameworkClass;
}

/** Class A framework names (used for entry point lookup). */
export type Framework = "tanstack-start" | "react-router";

/** Directories to scan for binding inference in framework mode. */
export const FRAMEWORK_SCAN_DIRS = ["src", "app", "routes", "server"] as const;

/**
 * Map from npm package name to framework identifier.
 * Only packages that unambiguously indicate framework mode are listed.
 * For example, `react-router` alone is a client-side router — only
 * `@react-router/dev` signals the framework (Vite plugin) mode.
 */
const FRAMEWORK_PACKAGES: Record<string, DetectedFramework> = {
  "@tanstack/react-start": { name: "tanstack-start", class: "a" },
  "@react-router/dev": { name: "react-router", class: "a" },
  "@sveltejs/kit": { name: "sveltekit", class: "b" },
  nuxt: { name: "nuxt", class: "c" },
  astro: { name: "astro", class: "c" },
};

/**
 * Detect a meta-framework by checking package.json dependencies.
 * Returns the detected framework with class info, or `undefined`.
 */
export function detectFramework(root: string): DetectedFramework | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  for (const [pkgName, framework] of Object.entries(FRAMEWORK_PACKAGES)) {
    if (pkgName in deps) return framework;
  }
  return undefined;
}

export interface InferenceOptions {
  /** Explicit binding overrides — takes precedence over inference */
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean;
  };
}

/**
 * Synchronously infer which Cloudflare bindings the project needs
 * by scanning route/middleware files and optional src/main.ssr.ts with oxc-parser.
 *
 * This runs once when voidPlugin() is called (before plugins initialize),
 * so results are available to configure the Cloudflare plugin.
 *
 * @param scanDirs - Override the default scan directories (e.g., for framework mode)
 */
export function inferProjectBindings(
  root: string,
  options?: InferenceOptions,
  scanDirs?: readonly string[],
): InferredBindings {
  // If user provided explicit overrides, use those
  if (options?.bindings) {
    return {
      needsD1: Boolean(options.bindings.db),
      needsKV: Boolean(options.bindings.kv),
      needsR2: Boolean(options.bindings.storage),
      needsAuth: false,
      needsQueues: false,
      needsAI: Boolean(options.bindings.ai),
    };
  }

  const dirs = scanDirs ?? ["routes", "middleware", "queues", "pages", "crons"];
  const allBindings: InferredBindings[] = [];

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = globSync("**/*.{ts,tsx,mts,js,jsx,mjs}", { cwd: dirPath, absolute: true });
    } catch {
      continue;
    }

    for (const file of files) {
      const code = readFileSync(file, "utf-8");
      const filename = file.split("/").pop()!;
      allBindings.push(inferBindingsFromSource(code, filename));
    }
  }

  const ssrEntry = getSsrServerEntryPath(root);
  if (ssrEntry) {
    const code = readFileSync(ssrEntry, "utf-8");
    const filename = ssrEntry.split("/").pop() ?? "main.ssr.ts";
    allBindings.push(inferBindingsFromSource(code, filename));
  }

  // Also scan src/ for auth imports (unless src/ is already in scanDirs)
  const dirsSet = new Set(dirs);
  if (!dirsSet.has("src")) {
    const srcPath = join(root, "src");
    let srcFiles: string[];
    try {
      srcFiles = globSync("**/*.{ts,tsx,mts,js,jsx,mjs}", { cwd: srcPath, absolute: true });
    } catch {
      srcFiles = [];
    }
    for (const file of srcFiles) {
      const code = readFileSync(file, "utf-8");
      const filename = file.split("/").pop()!;
      allBindings.push(inferBindingsFromSource(code, filename));
    }
  }

  return mergeBindings(allBindings);
}
