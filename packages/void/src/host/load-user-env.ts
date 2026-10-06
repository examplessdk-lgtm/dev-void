/**
 * Loader for the user's `env.ts`.
 *
 * Uses Node's native `import()` (type-stripping is on by default in the
 * supported Node version), so only relative imports and bare package
 * specifiers resolve. tsconfig path aliases (`@/foo`, `~/foo`) are NOT
 * supported — if the user writes one, we detect the resulting resolution
 * error and re-throw with guidance pointing at the offending specifier.
 *
 * Used by:
 *   - `plugin-env-schema.ts` (dev plugin, HMR re-imports)
 *   - `cli/env-validation.ts` (deploy + `void env check`)
 *
 * Side-effect contract: loading the file evaluates the user's `defineEnv`
 * call, which registers the schema in the singleton state in
 * `runtime/env-public.ts`. Callers read the result from there.
 *
 * Node-only (lives under `host/`). Must not be imported from anything
 * that ships in worker bundles.
 */
import { pathToFileURL } from 'node:url';

let loadCounter = 0;

/** Returns the failed specifier from a Node module-resolution error, or `null`. */
function extractFailedSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return null;
  }
  // Node's message shapes: `Cannot find package '@/foo' imported from ...`
  // or `Cannot find module '@/foo' imported from ...`.
  const match = /Cannot find (?:package|module) '([^']+)'/.exec(err.message);
  return match ? (match[1] ?? null) : null;
}

/** A specifier is alias-shaped if it isn't relative, absolute, a node: URL, or a valid bare package name. */
function looksLikeAlias(specifier: string): boolean {
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('file:')
  ) {
    return false;
  }
  // Bare scoped package: `@scope/name[/subpath]` where scope and name are valid.
  // Alias forms like `@/foo` fail this because the scope is empty.
  if (specifier.startsWith('@')) {
    return !/^@[^/]+\/[^/]+/.test(specifier);
  }
  // Tilde and plain `#` prefixes are common alias conventions that aren't
  // valid bare packages.
  return specifier.startsWith('~') || specifier.startsWith('#');
}

/**
 * Load the user's env.ts via native `import()`. The URL gets a cache-busting
 * query param so HMR re-imports re-evaluate the file.
 *
 * On resolution failures, wraps the error with the source file path, and if
 * the failed specifier looks like a tsconfig path alias, appends guidance
 * explaining that env.ts doesn't resolve aliases.
 */
export async function loadUserEnvFile(envFile: string): Promise<void> {
  // Counter + timestamp so back-to-back HMR reloads in the same millisecond
  // still produce distinct URLs (Node's ESM loader caches by URL).
  const url = pathToFileURL(envFile).href + `?t=${Date.now()}-${++loadCounter}`;
  try {
    await import(/* @vite-ignore */ url);
  } catch (err) {
    const specifier = extractFailedSpecifier(err);
    const base = `env: Failed to load '${envFile}': '${(err as Error).message}'.`;
    if (specifier && looksLikeAlias(specifier)) {
      throw new Error(
        `${base}\n\n` +
          `Hint: '${specifier}' looks like a tsconfig path alias. ` +
          `env.ts is loaded directly by Node and does not resolve tsconfig "paths" — ` +
          `use a relative import (e.g. "./shared/...") instead.`,
      );
    }
    throw new Error(base);
  }
}
