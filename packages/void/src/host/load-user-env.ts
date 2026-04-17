/**
 * Loader for the user's `env.ts` (and any other host-side TS module) that
 * respects tsconfig path aliases, workspace conventions, and JIT TS
 * transformation — which Node's bare `import()` does not.
 *
 * Used by:
 *   - `plugin-env-schema.ts` (dev plugin, HMR re-imports)
 *   - `cli/env-validation.ts` (deploy + `void env check`)
 *
 * Side-effect contract: loading the file evaluates the user's `defineEnv`
 * call, which registers the schema in the singleton state in
 * `runtime/env-public.ts`. Callers read the result from there.
 *
 * This module is Node-only (lives under `host/`). It must not be imported
 * from anything that ships in worker bundles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * Read tsconfig.json (and any base configs via `extends`) and return the
 * resolved `compilerOptions.paths` plus an absolute `baseUrl`. Returns
 * `null` when no tsconfig exists or no paths are declared.
 *
 * This is intentionally minimal — we don't try to be a full tsconfig
 * resolver. A best-effort read is enough for the common alias use case
 * (e.g. `"@/*": ["./src/*"]`); projects with exotic setups can fall back
 * to relative imports inside env.ts.
 */
function readTsconfigPaths(root: string, visited = new Set<string>()): TsconfigPaths | null {
  const tsconfigPath = resolve(root, 'tsconfig.json');
  if (!existsSync(tsconfigPath) || visited.has(tsconfigPath)) {
    return null;
  }
  visited.add(tsconfigPath);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(readFileSync(tsconfigPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Resolve `extends` chain first so child overrides win.
  let inherited: TsconfigPaths | null = null;
  const extendsField = parsed.extends;
  const extendsList = Array.isArray(extendsField)
    ? (extendsField.filter((v) => typeof v === 'string') as string[])
    : typeof extendsField === 'string'
      ? [extendsField]
      : [];
  for (const ext of extendsList) {
    const extPath = ext.startsWith('.') ? resolve(dirname(tsconfigPath), ext) : ext;
    const extDir = dirname(
      extPath.endsWith('.json') || extPath.endsWith('.jsonc') ? extPath : `${extPath}/dummy`,
    );
    const sub = readTsconfigPaths(extDir, visited);
    if (!sub) {
      continue;
    }
    if (inherited === null) {
      inherited = sub;
    } else {
      const prev: TsconfigPaths = inherited;
      inherited = {
        baseUrl: sub.baseUrl,
        paths: { ...prev.paths, ...sub.paths },
      };
    }
  }

  const compilerOptions = (parsed.compilerOptions ?? {}) as {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  const ownPaths = compilerOptions.paths;
  const baseUrl = compilerOptions.baseUrl
    ? resolve(dirname(tsconfigPath), compilerOptions.baseUrl)
    : (inherited?.baseUrl ?? dirname(tsconfigPath));

  if (!ownPaths || Object.keys(ownPaths).length === 0) {
    return inherited ? { ...inherited, baseUrl } : null;
  }
  const merged: Record<string, string[]> = { ...(inherited?.paths ?? {}), ...ownPaths };
  return { baseUrl, paths: merged };
}

/**
 * Convert tsconfig `paths` into the `alias` map shape jiti expects.
 *
 * jiti uses prefix-matching aliases (via mlly's `normalizeAliases`) — no
 * wildcard expansion, no `*` placeholders. We strip the trailing `/*`
 * from both the pattern and the target so a tsconfig entry like
 * `"@shared/*": ["./shared/*"]` becomes `"@shared": "<root>/shared"`,
 * which matches `import "@shared/anything"` correctly.
 */
function tsPathsToJitiAlias(tsPaths: TsconfigPaths): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const [pattern, targets] of Object.entries(tsPaths.paths)) {
    // tsconfig allows multiple targets for fallback; jiti takes one. Pick
    // the first existing target, otherwise fall back to the first entry.
    const stripStar = (s: string) => (s.endsWith('/*') ? s.slice(0, -2) : s);
    const target = targets.find((t) => existsSync(resolve(tsPaths.baseUrl, stripStar(t))));
    const chosen = target ?? targets[0];
    if (!chosen) {
      continue;
    }
    const targetNoStar = stripStar(chosen);
    const absoluteTarget = isAbsolute(targetNoStar)
      ? targetNoStar
      : resolve(tsPaths.baseUrl, targetNoStar);
    alias[stripStar(pattern)] = absoluteTarget;
  }
  return alias;
}

/**
 * Load the user's env.ts (or any TS module) through jiti so tsconfig
 * paths and aliases resolve. Caching is fully disabled so repeated calls
 * (HMR) re-evaluate the file and pick up edits.
 *
 * Errors from the underlying load are wrapped with the source file path
 * for clearer diagnostics.
 */
export async function loadUserEnvFile(envFile: string): Promise<void> {
  const root = dirname(envFile);
  const tsPaths = readTsconfigPaths(root);
  const alias = tsPaths ? tsPathsToJitiAlias(tsPaths) : {};

  // Lazy-load jiti so worker bundles never see it (defense in depth — this
  // file is also under host/ and isn't a public entry).
  const { createJiti } = await import('jiti');
  const jiti = createJiti(pathToFileURL(envFile).href, {
    // We never read the returned namespace — only the side effect (the
    // user's `defineEnv` call) matters. Leaving interopDefault off avoids
    // a Proxy wrapper that would auto-touch the module's `default` export
    // on inspection (which can throw for default exports like the `env`
    // proxy that resolves runtime bindings on read).
    interopDefault: false,
    // Disable both source-cache and module-cache so HMR re-imports re-evaluate.
    fsCache: false,
    moduleCache: false,
    alias,
  });

  try {
    await jiti.import(envFile);
  } catch (err) {
    throw new Error(`Failed to load ${envFile}: ${(err as Error).message}`);
  }
}
