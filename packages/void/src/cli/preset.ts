import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { hasSsrEntry } from "../ssr/entry";

/** Build output conventions for a meta-framework (Class B/C). */
export interface FrameworkPreset {
  /** Default build command (overridable via void.json `build`). */
  buildCommand: string;
  /** Directory containing the worker entry, relative to project root. */
  workerDir: string;
  /** Worker entry module filename within workerDir. */
  workerMain: string;
  /** Directory containing static assets, relative to project root. */
  assetsDir: string;
  /** URL-level prefix for hashed/immutable assets (used by dispatch for cache headers + edge cache keys). */
  hashedAssetsPrefix?: string;
}

/**
 * Known output conventions for Class B/C meta-frameworks.
 * Keyed by the framework name from `detectFramework()`.
 */
export const FRAMEWORK_PRESETS: Record<string, FrameworkPreset> = {
  sveltekit: {
    buildCommand: "vite build",
    workerDir: ".svelte-kit/cloudflare",
    workerMain: "_worker.js",
    assetsDir: ".svelte-kit/cloudflare",
    hashedAssetsPrefix: "_app/immutable",
  },
  nuxt: {
    buildCommand: "nuxt build",
    workerDir: ".output/server",
    workerMain: "index.mjs",
    assetsDir: ".output/public",
    hashedAssetsPrefix: "_nuxt",
  },
  astro: {
    buildCommand: "astro build",
    workerDir: "dist/_worker.js",
    workerMain: "index.js",
    assetsDir: "dist",
    hashedAssetsPrefix: "_astro",
  },
};

export interface StaticPreset {
  buildCommand: string | null;
  outputDir: string;
  mode: "spa" | "ssg";
}

/**
 * Detect a static deploy preset based on the project root.
 * Returns null when the project requires a full worker deploy.
 */
export function detectPreset(
  root: string,
  options?: { dir?: string; spa?: boolean },
): StaticPreset | null {
  // 1. Explicit --dir flag: skip build, use provided directory
  if (options?.dir) {
    return {
      buildCommand: null,
      outputDir: resolve(root, options.dir),
      mode: options.spa ? "spa" : "ssg",
    };
  }

  // 2. VitePress detected
  const pkg = readPackageJson(root);
  if (pkg && hasVitePress(pkg)) {
    const srcDir = detectVitePressSourceDir(root);
    const buildArg = srcDir === "." ? "" : ` ${srcDir}`;
    return {
      buildCommand: `${localBin(root, "vitepress")} build${buildArg}`,
      outputDir: resolve(root, srcDir, ".vitepress/dist"),
      mode: "ssg",
    };
  }

  // 3. Has backend files → full deploy
  if (hasBackendFiles(root)) {
    return null;
  }

  // 4. Vite in deps → static SPA
  if (pkg && hasVite(pkg)) {
    return {
      buildCommand: `${localBin(root, "vite")} build`,
      outputDir: resolve(root, "dist"),
      mode: options?.spa ? "spa" : "spa",
    };
  }

  // 5. No build tool — look for pre-built output
  if (existsSync(join(root, "dist/index.html"))) {
    return {
      buildCommand: null,
      outputDir: resolve(root, "dist"),
      mode: options?.spa ? "spa" : "ssg",
    };
  }

  if (existsSync(join(root, "index.html"))) {
    return {
      buildCommand: null,
      outputDir: root,
      mode: options?.spa ? "spa" : "ssg",
    };
  }

  return null;
}

/**
 * Resolve a local node_modules/.bin executable path.
 * Falls back to bare command name if the bin doesn't exist locally.
 */
function localBin(root: string, name: string): string {
  const bin = join(root, "node_modules", ".bin", name);
  return existsSync(bin) ? bin : name;
}

function readPackageJson(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

function getAllDeps(pkg: Record<string, unknown>): Record<string, string> {
  return {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
}

function hasVitePress(pkg: Record<string, unknown>): boolean {
  return "vitepress" in getAllDeps(pkg);
}

function hasVite(pkg: Record<string, unknown>): boolean {
  return "vite" in getAllDeps(pkg);
}

/**
 * Detect the VitePress source directory.
 * VitePress docs can live at root (has `.vitepress/`) or in `docs/` (has `docs/.vitepress/`).
 */
function detectVitePressSourceDir(root: string): string {
  if (existsSync(join(root, "docs/.vitepress"))) {
    return "docs";
  }
  return ".";
}

/**
 * Check whether the project has backend files that require a full worker deploy.
 */
export function hasBackendFiles(root: string): boolean {
  if (existsSync(join(root, "routes"))) return true;
  if (existsSync(join(root, "pages"))) return true;
  if (existsSync(join(root, "middleware"))) return true;
  if (existsSync(join(root, "crons"))) return true;
  if (existsSync(join(root, "queues"))) return true;
  if (hasSsrEntry(root)) return true;
  return false;
}
