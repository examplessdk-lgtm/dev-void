import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'pathslash';

/**
 * Read PnP runtime files at a single directory without walking
 * ancestors. Returns a descriptor with the files that exist, or
 * `undefined` when neither is present.
 */
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
 * Returns true when `dir` contains a local package-manager lockfile
 * (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`,
 * `bun.lockb`). A lockfile at `dir` is definitive proof that a package
 * manager runs install from this directory: Yarn / pnpm / npm / bun
 * all write the lockfile at the install root, and workspace members
 * SHARE the root lockfile rather than carrying their own.
 *
 * Two independent call sites depend on this signal:
 *
 *   1. `findYarnPnpRuntime` / `findInstalledYarnPnpRuntime` below use
 *      it as the "leaf-managed install ownership" gate: a nested
 *      project with its own lockfile must NOT inherit an outer Yarn
 *      PnP runtime into `NODE_OPTIONS`, because the outer `.pnp.cjs`
 *      patches `Module._resolveFilename` to consult a graph that
 *      doesn't contain the leaf's dependencies — drizzle-kit then
 *      fails to resolve `drizzle-orm/...`.
 *   2. `resolveWorkspaceDeferral` in `init.ts` uses it as the
 *      "workspace-skip boundary": a subpackage with its own lockfile
 *      is not governed by the workspace install and must run install
 *      + starter migration locally.
 *
 * Both call sites must check the same set of lockfile paths — if one
 * drifts (for example, adding a new package manager's lockfile to
 * only one helper), the two paths will silently disagree on the same
 * directory. Exported as the single source of truth to lock the
 * invariant in one place.
 *
 * Note: `package.json#packageManager` (Corepack pin) is deliberately
 * NOT a signal here. A Yarn Berry workspace member can legitimately
 * declare its own `packageManager: "yarn@..."` while still resolving
 * through the workspace root's `.pnp.cjs`; treating the pin as
 * leaf-managed would stop the ancestor walk before reaching the real
 * PnP root and break `void db generate` / starter migration
 * generation in valid Yarn PnP monorepos. The lockfile check is
 * sufficient: a fresh-cloned leaf project with only a Corepack pin
 * will still trigger install, which writes the lockfile before
 * `generateStarterMigration()` fires, at which point the gate engages.
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
 * Walk ancestors from `start` (inclusive) looking for Yarn Berry PnP
 * runtime files. Returns the directory containing them (with both
 * possibly-existing paths) if found, or `undefined` otherwise.
 *
 * Walking ancestors is important for workspace subpackages — in a Yarn
 * PnP monorepo, `.pnp.cjs` lives at the workspace root, not in each
 * subpackage. Checking only `start` would miss the common shape.
 *
 * Local PnP files at `start` are always authoritative and take
 * precedence over the leaf-managed guard below. When `start` has no
 * local PnP files but DOES have a local lockfile, stop here — ancestor
 * PnP data belongs to a different install graph and injecting it will
 * break resolution for the local one. Only walk past `start` when
 * neither condition holds.
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
 * Stricter variant of {@link findYarnPnpRuntime}: only returns a result
 * when the PnP runtime files AND a post-install marker live in the
 * SAME ancestor directory.
 *
 * Yarn Berry repos commonly commit `.pnp.cjs` to
 * version control but NOT `.yarn/cache/*.zip` (zero-install is an
 * opt-in, not the default). A fresh `git clone` before `yarn install`
 * therefore has `.pnp.cjs` on disk while the PnP data points at ZIP
 * archives that haven't been fetched yet. Trusting `.pnp.cjs` existence
 * alone as proof that "yarn install has run" leads `init` to skip the
 * install step, and the subsequent `drizzle-kit generate` spawn crashes
 * because PnP tries to load `void/schema-d1` from a missing ZIP.
 *
 * Accept EITHER of two markers, to cover both non-zero-install
 * and zero-install shapes:
 *
 *   1. `.yarn/install-state.gz` in the same dir. Yarn Berry (3.x and
 *      4.x) writes this on every successful `yarn install` and it is
 *      gitignored by convention, so its presence strictly implies
 *      "yarn install has populated this checkout at least once". This
 *      is the only marker present in a classic (non-zero-install) repo.
 *   2. `.yarn/cache/` containing at least one `.zip` entry in the same
 *      dir. In zero-install repos (`nodeLinker: pnp`, cache committed
 *      to git), `install-state.gz` is commonly gitignored or absent,
 *      but the populated cache IS on disk — that's the whole point of
 *      zero-install. A populated cache is therefore sufficient proof
 *      that the checkout is ready to resolve dependencies.
 *
 * The same-directory requirement locks the invariant — a committed
 * `.pnp.cjs` in a subdirectory must not be covered by markers sitting
 * at an unrelated ancestor.
 *
 * NOTE: `findYarnPnpRuntime` intentionally does NOT apply this stricter
 * check. NODE_OPTIONS injection for drizzle-kit spawns should still
 * happen whenever PnP runtime files are present: if install hasn't run,
 * drizzle-kit will crash with or without the injected env, so the
 * inject is harmless; if the user is about to run install and then hits
 * a spawn, the env needs to be prepared.
 */
export function findInstalledYarnPnpRuntime(
  start: string,
): { pnpCjs?: string; pnpLoader?: string } | undefined {
  const found = findYarnPnpRuntime(start);
  return found && isYarnPnpInstalled(found.dir) ? found.runtime : undefined;
}

/**
 * Return true when `dir` looks like a post-install Yarn Berry PnP
 * checkout. Two valid markers (see `findInstalledYarnPnpRuntime`):
 *
 *   - `.yarn/install-state.gz` — written by every successful
 *     `yarn install` in a classic (non-zero-install) repo.
 *   - `.yarn/cache/*.zip` — present in a zero-install checkout, where
 *     archives are committed to git and `install-state.gz` is often
 *     gitignored or absent.
 */
function isYarnPnpInstalled(dir: string): boolean {
  // Non-zero-install: Yarn writes this on every successful
  // `yarn install`.
  if (existsSync(join(dir, '.yarn', 'install-state.gz'))) {
    return true;
  }
  // Zero-install: archives are committed to git. A populated cache is
  // the post-install proof.
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
 * Build a child-process env that injects Yarn Berry PnP loaders into
 * `NODE_OPTIONS` when a PnP runtime is found at or above `root`. This
 * mirrors what `yarn node` does under the hood: `--require` the PnP
 * CJS shim (patches `fs` + `Module._resolveFilename` to understand ZIP
 * virtual paths) and, when present, `--experimental-loader` the PnP
 * ESM loader.
 *
 * Any pre-existing `NODE_OPTIONS` from the parent process (for example
 * when the command is invoked as `yarn void ...` and yarn already set
 * it) is appended AFTER our injected flags so our PnP `--require` runs
 * first. Non-PnP projects inherit `process.env` unchanged.
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
  // Preserve any pre-existing NODE_OPTIONS by prepending ours — order
  // matters for `--require` so the PnP loader patches `fs` /
  // `Module._resolveFilename` before anything the user registered.
  env.NODE_OPTIONS = process.env.NODE_OPTIONS
    ? `${injected} ${process.env.NODE_OPTIONS}`
    : injected;
  return env;
}
