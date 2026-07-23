import { existsSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { globSync } from 'tinyglobby';
import { inferBindingsFromSource, mergeBindings, type InferredBindings } from './inference/walk.ts';
import { readProjectPaths, type ProjectPaths } from './project-paths.ts';
import { getSsrServerEntryPath } from './ssr/entry.ts';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,js,jsx,mjs,astro}';

/** Framework class determines integration depth. */
export type FrameworkClass = 'a' | 'b' | 'c';

export type DetectedFramework = {
  name: string;
  class: FrameworkClass;
};

/** Class A framework names (used for entry point lookup). */
export type Framework = 'tanstack-start' | 'react-router' | 'vinext-app' | 'vinext-pages';

/** Directories to scan for binding inference in framework mode. */
export const FRAMEWORK_SCAN_DIRS = [
  'src',
  'app',
  'pages',
  'routes',
  'server',
  'crons',
  'queues',
] as const;

/** Directories to scan for binding inference in Void app mode. */
export const DEFAULT_SCAN_DIRS = [
  'routes',
  'middleware',
  'queues',
  'pages',
  'crons',
  'src',
] as const;

/**
 * Map from npm package name to framework identifier.
 * Only packages that unambiguously indicate framework mode are listed.
 * For example, `react-router` alone is a client-side router — only
 * `@react-router/dev` signals the framework (Vite plugin) mode.
 */
const FRAMEWORK_PACKAGES: Record<string, DetectedFramework> = {
  '@tanstack/react-start': { name: 'tanstack-start', class: 'a' },
  '@react-router/dev': { name: 'react-router', class: 'a' },
  vinext: { name: 'vinext-pages', class: 'a' },
  '@sveltejs/kit': { name: 'sveltekit', class: 'b' },
  nuxt: { name: 'nuxt', class: 'c' },
  '@analogjs/platform': { name: 'analog', class: 'c' },
  astro: { name: 'astro', class: 'c' },
};

/**
 * Detect a meta-framework by checking package.json dependencies.
 * Returns the detected framework with class info, or `undefined`.
 */
export function detectFramework(root: string): DetectedFramework | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  for (const [pkgName, framework] of Object.entries(FRAMEWORK_PACKAGES)) {
    if (pkgName in deps) {
      // vinext has two modes: App Router (app/ exists) vs Pages Router
      if (framework.name === 'vinext-pages' && existsSync(join(root, 'app'))) {
        return { name: 'vinext-app', class: 'a' };
      }
      return framework;
    }
  }
  return undefined;
}

export type InferenceOptions = {
  /** Explicit binding overrides — takes precedence over inference */
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean;
  };
  paths?: ProjectPaths;
};

function extractAstroFrontmatter(code: string): string {
  const match = code.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

function inferBindingsFromFile(file: string, code: string): InferredBindings {
  const filename = file.split('/').pop() ?? 'unknown.ts';
  if (!filename.endsWith('.astro')) {
    return inferBindingsFromSource(code, filename);
  }

  const frontmatter = extractAstroFrontmatter(code);
  const virtualFilename = filename.replace(/\.astro$/, '.ts');
  return inferBindingsFromSource(frontmatter, virtualFilename);
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
  scanDirs?: ReadonlyArray<string>,
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
      needsSandbox: false,
      needsLive: false,
    };
  }

  const paths = options?.paths ?? readProjectPaths(root);
  const dirs = scanDirs ?? (paths.sourceDir ? [paths.sourceDir] : DEFAULT_SCAN_DIRS);
  const allBindings: Array<InferredBindings> = [];

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let files: Array<string>;
    try {
      files = globSync(SOURCE_GLOB, { cwd: dirPath, absolute: true });
    } catch {
      continue;
    }

    for (const file of files) {
      const code = readFileSync(file, 'utf-8');
      allBindings.push(inferBindingsFromFile(file, code));
    }
  }

  const ssrEntry = getSsrServerEntryPath(root, paths);
  if (ssrEntry) {
    const code = readFileSync(ssrEntry, 'utf-8');
    const filename = ssrEntry.split('/').pop() ?? 'main.ssr.ts';
    allBindings.push(inferBindingsFromSource(code, filename));
  }

  // Custom scan directories should still see client/auth helpers and colocated
  // server-only modules under src/.
  const dirsSet = new Set(dirs);
  const srcRel = paths.sourceDir ? paths.sourceDir : 'src';
  if (!dirsSet.has(srcRel)) {
    const srcPath = paths.sourceDir ? paths.sourceRoot : join(root, 'src');
    let srcFiles: Array<string>;
    try {
      srcFiles = globSync(SOURCE_GLOB, { cwd: srcPath, absolute: true });
    } catch {
      srcFiles = [];
    }
    for (const file of srcFiles) {
      const code = readFileSync(file, 'utf-8');
      allBindings.push(inferBindingsFromFile(file, code));
    }
  }

  return mergeBindings(allBindings);
}
