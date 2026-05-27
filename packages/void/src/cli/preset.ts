import { existsSync } from 'node:fs';
import { join, resolve } from 'pathe';
import { readProjectPaths } from '../project-paths.ts';
import {
  getPackageDependencies,
  hasPackageDependency,
  readPackageJson,
} from '../shared/package-json.ts';
import { hasSsrEntry } from '../ssr/entry.ts';

/** Build output conventions for a known SSG (static site generator). */
export type SsgPreset = {
  /** Package name to detect in package.json dependencies. */
  dep: string;
  /** Default build command (binary name — localBin resolves the full path). */
  buildCommand: string;
  /** Default output directory, relative to project root. */
  outputDir: string;
  /** App type for the deploy manifest. */
  appType: 'static' | 'spa';
  /** Optional project-aware overrides. */
  resolve?: (root: string) => Partial<Pick<StaticPreset, 'buildCommand' | 'outputDir'>> | undefined;
};

/**
 * Known output conventions for SSGs.
 * Keyed by the SSG name — detection iterates in insertion order.
 */
export const SSG_PRESETS: Record<string, SsgPreset> = {
  vitepress: {
    dep: 'vitepress',
    buildCommand: 'vitepress build',
    outputDir: '.vitepress/dist',
    appType: 'static',
    resolve(root) {
      if (existsSync(join(root, 'docs/.vitepress'))) {
        return {
          buildCommand: 'vitepress build docs',
          outputDir: 'docs/.vitepress/dist',
        };
      }
    },
  },
  docusaurus: {
    dep: '@docusaurus/core',
    buildCommand: 'docusaurus build',
    outputDir: 'build',
    appType: 'static',
  },
};

/** Build output conventions for a meta-framework. */
export type FrameworkPreset = {
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
  /** Whether the worker entry needs bundling (bare imports not resolved by framework build). */
  bundle?: boolean;
};

/**
 * Known output conventions for meta-frameworks.
 * Keyed by the framework name from `detectFramework()`.
 *
 * Class A frameworks (tanstack-start, react-router, vinext) use the project's
 * Vite-compatible build command (`vite build` or `vp build`) and have their
 * output structure determined by the framework's Vite plugin.
 *
 * Class B/C frameworks (sveltekit, nuxt, analog, astro) use their own build CLI
 * and have framework-specific output conventions.
 */
export const FRAMEWORK_PRESETS: Record<string, FrameworkPreset> = {
  // Class A
  'tanstack-start': {
    buildCommand: 'vite build',
    workerDir: 'dist/server',
    workerMain: 'index.js',
    assetsDir: 'dist/client',
  },
  'react-router': {
    buildCommand: 'vite build',
    workerDir: 'build/server',
    workerMain: 'index.js',
    assetsDir: 'build/client',
  },
  'vinext-app': {
    buildCommand: 'vite build',
    workerDir: 'dist/rsc',
    workerMain: 'index.js',
    assetsDir: 'dist/client',
  },
  'vinext-pages': {
    buildCommand: 'vite build',
    workerDir: 'dist/ssr',
    workerMain: 'index.js',
    assetsDir: 'dist/client',
  },
  // Class B/C
  sveltekit: {
    buildCommand: 'vite build',
    workerDir: '.svelte-kit/cloudflare',
    workerMain: '_worker.js',
    assetsDir: '.svelte-kit/cloudflare',
    hashedAssetsPrefix: '_app/immutable',
    bundle: true,
  },
  nuxt: {
    buildCommand: 'nuxt build',
    workerDir: '.output/server',
    workerMain: 'index.mjs',
    assetsDir: '.output/public',
    hashedAssetsPrefix: '_nuxt',
  },
  analog: {
    buildCommand: 'vite build',
    workerDir: 'dist/analog/server',
    workerMain: 'index.mjs',
    assetsDir: 'dist/analog/public',
    hashedAssetsPrefix: 'assets',
  },
  astro: {
    buildCommand: 'astro build',
    workerDir: 'dist/server',
    workerMain: 'entry.mjs',
    assetsDir: 'dist/client',
    hashedAssetsPrefix: '_astro',
  },
};

export type StaticPreset = {
  buildCommand: string | null;
  outputDir: string;
  appType: 'spa' | 'static';
};

/**
 * Resolve a project-local command, rewriting `vite` to `vp` when the project
 * depends on Vite+ and preferring node_modules/.bin when available.
 */
export function resolveProjectCommand(root: string, command: string): string {
  const [bin, ...args] = command.trim().split(/\s+/);
  const resolvedBin = localBin(root, resolveCommandBin(root, bin));
  return args.length > 0 ? `${resolvedBin} ${args.join(' ')}` : resolvedBin;
}

/**
 * Format a user-facing command string, rewriting `vite` to `vp` when the
 * project depends on Vite+ without expanding to an absolute local bin path.
 */
export function formatProjectCommand(root: string, command: string): string {
  const [bin, ...args] = command.trim().split(/\s+/);
  const formattedBin = resolveCommandBin(root, bin);
  return args.length > 0 ? `${formattedBin} ${args.join(' ')}` : formattedBin;
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
      appType: options.spa ? 'spa' : 'static',
    };
  }

  // 2. Known SSG detected
  const pkg = readPackageJson(root);
  if (pkg) {
    const allDeps = getPackageDependencies(pkg);
    for (const preset of Object.values(SSG_PRESETS)) {
      if (preset.dep in allDeps) {
        const overrides = preset.resolve?.(root);
        const cmd = overrides?.buildCommand ?? preset.buildCommand;
        const out = overrides?.outputDir ?? preset.outputDir;
        return {
          buildCommand: resolveProjectCommand(root, cmd),
          outputDir: resolve(root, out),
          appType: preset.appType,
        };
      }
    }
  }

  // 3. Has backend files → full deploy
  if (hasBackendFiles(root)) {
    return null;
  }

  // 4. Vite/Vite+ in deps → static SPA
  if (pkg && hasViteLike(pkg)) {
    const buildCommand = resolveProjectScriptCommand(root, 'build');
    return {
      buildCommand: buildCommand ?? resolveProjectCommand(root, 'vite build'),
      outputDir: resolve(root, 'dist'),
      appType: 'spa',
    };
  }

  // 5. No build tool — look for pre-built output
  if (existsSync(join(root, 'dist/index.html'))) {
    return {
      buildCommand: null,
      outputDir: resolve(root, 'dist'),
      appType: options?.spa ? 'spa' : 'static',
    };
  }

  if (existsSync(join(root, 'index.html'))) {
    return {
      buildCommand: null,
      outputDir: root,
      appType: options?.spa ? 'spa' : 'static',
    };
  }

  return null;
}

/**
 * Resolve a local node_modules/.bin executable path.
 * Falls back to bare command name if the bin doesn't exist locally.
 */
function localBin(root: string, name: string): string {
  const bin = join(root, 'node_modules', '.bin', name);
  return existsSync(bin) ? bin : name;
}

function resolveCommandBin(root: string, name: string): string {
  if (name === 'vite') {
    return detectViteBinary(root);
  }
  return name;
}

function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm';
}

function resolveProjectScriptCommand(root: string, scriptName: string): string | null {
  const pkg = readPackageJson(root);
  const script = pkg?.scripts;
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    return null;
  }
  if (typeof (script as Record<string, unknown>)[scriptName] !== 'string') {
    return null;
  }

  switch (detectPackageManager(root)) {
    case 'pnpm':
      return `pnpm ${scriptName}`;
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

function hasViteLike(pkg: Record<string, unknown>): boolean {
  return hasPackageDependency(pkg, 'vite') || hasPackageDependency(pkg, 'vite-plus');
}

function detectViteBinary(root: string): 'vite' | 'vp' {
  const pkg = readPackageJson(root);
  if (pkg && hasPackageDependency(pkg, 'vite-plus')) {
    return 'vp';
  }
  return 'vite';
}

/**
 * Check whether the project has backend files that require a full worker deploy.
 */
export function hasBackendFiles(root: string): boolean {
  const paths = readProjectPaths(root);
  if (existsSync(paths.routesDir)) {
    return true;
  }
  if (existsSync(paths.pagesDir)) {
    return true;
  }
  if (existsSync(paths.middlewareDir)) {
    return true;
  }
  if (existsSync(paths.cronsDir)) {
    return true;
  }
  if (existsSync(paths.queuesDir)) {
    return true;
  }
  if (hasSsrEntry(root, paths)) {
    return true;
  }
  return false;
}
