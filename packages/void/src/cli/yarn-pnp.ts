import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'pathslash';

export const drizzleKitBin: string = join(
  fileURLToPath(import.meta.resolve('drizzle-kit')),
  '..',
  'bin.cjs',
);

/** Read the PnP runtime files in `dir` only, or `undefined` when neither exists. */
function readPnpRuntimeAt(dir: string): { pnpCjs?: string; pnpLoader?: string } | undefined {
  const cjs = join(dir, '.pnp.cjs');
  const loader = join(dir, '.pnp.loader.mjs');
  const cjsExists = existsSync(cjs);
  const loaderExists = existsSync(loader);
  if (!cjsExists && !loaderExists) {
    return undefined;
  }
  return {
    pnpCjs: cjsExists ? cjs : undefined,
    pnpLoader: loaderExists ? loader : undefined,
  };
}

/**
 * Whether `dir` has its own package-manager lockfile, i.e. it is an install
 * root: workspace members share the root lockfile. `packageManager` is not a
 * signal, because a Yarn workspace member may pin it and still resolve through
 * the root's `.pnp.cjs`.
 */
export function hasLocalLockfile(dir: string): boolean {
  return (
    existsSync(join(dir, 'pnpm-lock.yaml')) ||
    existsSync(join(dir, 'package-lock.json')) ||
    existsSync(join(dir, 'yarn.lock')) ||
    existsSync(join(dir, 'bun.lock')) ||
    existsSync(join(dir, 'bun.lockb'))
  );
}

/**
 * Find Yarn Berry PnP runtime files at `start` or its nearest ancestor, since a
 * monorepo keeps `.pnp.cjs` at the workspace root. A lockfile at `start` stops
 * the walk: an outer PnP graph lacks the local install's dependencies.
 */
function findYarnPnpRuntime(
  start: string,
): { dir: string; runtime: { pnpCjs?: string; pnpLoader?: string } } | undefined {
  const local = readPnpRuntimeAt(start);
  if (local !== undefined) {
    return { dir: start, runtime: local };
  }
  if (hasLocalLockfile(start)) {
    return undefined;
  }
  let dir = dirname(start);
  if (dir === start) {
    return undefined;
  }
  while (true) {
    const found = readPnpRuntimeAt(dir);
    if (found !== undefined) {
      return { dir, runtime: found };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Like {@link findYarnPnpRuntime}, but only when Yarn has installed into that
 * same directory. A committed `.pnp.cjs` alone does not prove an install: its
 * ZIP archives may not be fetched yet.
 */
export function findInstalledYarnPnpRuntime(
  start: string,
): { pnpCjs?: string; pnpLoader?: string } | undefined {
  const found = findYarnPnpRuntime(start);
  return found && isYarnPnpInstalled(found.dir) ? found.runtime : undefined;
}

/**
 * Yarn writes `.yarn/install-state.gz` on every install; a zero-install
 * checkout instead commits a populated `.yarn/cache`.
 */
function isYarnPnpInstalled(dir: string): boolean {
  if (existsSync(join(dir, '.yarn', 'install-state.gz'))) {
    return true;
  }
  const cacheDir = join(dir, '.yarn', 'cache');
  if (!existsSync(cacheDir)) {
    return false;
  }
  try {
    const entries = readdirSync(cacheDir);
    return entries.some((e) => e.endsWith('.zip'));
  } catch {
    return false;
  }
}

/**
 * Build a child env that loads the Yarn PnP runtime found at or above `root`,
 * like `yarn node` does. Existing `NODE_OPTIONS` go after our flags so the PnP
 * `--require` patches resolution first.
 */
export function buildDrizzleKitSpawnEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pnp = findYarnPnpRuntime(root)?.runtime;
  if (!pnp) {
    return env;
  }
  const flags: Array<string> = [];
  if (pnp.pnpCjs) {
    // `JSON.stringify` double-quotes the path, which is how Node's
    // NODE_OPTIONS parser handles spaces (e.g. "My Project").
    flags.push(`--require ${JSON.stringify(pnp.pnpCjs)}`);
  }
  if (pnp.pnpLoader) {
    // `--experimental-loader` takes a URL, not a path. `pathToFileURL`
    // emits a valid `file://` URL with any spaces percent-encoded.
    flags.push(`--experimental-loader ${pathToFileURL(pnp.pnpLoader).href}`);
  }
  const injected = flags.join(' ');
  env.NODE_OPTIONS = process.env.NODE_OPTIONS
    ? `${injected} ${process.env.NODE_OPTIONS}`
    : injected;
  return env;
}
