// Shared helpers for environment resolution. Imported by the Vite plugin
// (index.ts), the prerender runner (prerender.ts), and the prerender Vite
// plugin (plugin-prerender.ts). Keep these as leaf helpers — they must not
// import from any non-leaf module, otherwise the prerender subprocess's
// worker bundle acquires unwanted transitive dependencies.

/**
 * Strip shell environment pollution from a Vite `loadEnv(mode, root, '')`
 * result. Vite returns `.env`-file entries AND every `process.env` entry
 * when called with an empty prefix; we want only the keys that came from
 * `.env` files (either new keys or keys that override a shell value).
 *
 * Used anywhere we need to populate worker vars from `.env` without
 * shipping the developer's shell environment (PATH, HOME, etc.) into
 * `wrangler.json` or the prerender Miniflare instance.
 */
export function filterLoadedEnv(
  loaded: Record<string, string>,
  shellEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const shellKeys = new Set(Object.keys(shellEnv));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(loaded)) {
    if (!shellKeys.has(key) || shellEnv[key] !== value) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Resolve whether the plugin should run in "remote" mode (proxy real
 * D1/KV/R2 via the platform) based on the project config plus an optional
 * `VOID_REMOTE` env override.
 *
 * Tri-state override semantics:
 *   - `VOID_REMOTE=1` → force remote mode on
 *   - `VOID_REMOTE=0` → force remote mode off (e.g. local/CI builds of a
 *     project whose `void.json` has `remote: true`)
 *   - unset / any other value → fall back to `config.remote`
 *
 * Both the dev-server plugin (index.ts) and the prerender build plugin
 * (plugin-prerender.ts) must derive `remoteMode` through this helper so
 * dev and build stay in lockstep.
 */
export function resolveRemoteMode(configRemote: boolean | undefined): boolean {
  const override = process.env.VOID_REMOTE;
  if (override === '1') {
    return true;
  }
  if (override === '0') {
    return false;
  }
  return configRemote === true;
}

/**
 * Internal env keys reserved for Void runtime use. These are how the Vite
 * plugin and deploy pipeline pass credential/runtime state to workerd. None
 * of them should ever originate from user-authored `.env` files, shell env,
 * or CI config — if they do, we strip them and warn at the call site.
 *
 * Callers: `index.ts` envPlugin.config (dev/build wrangler.json vars),
 * `prerender.ts` buildPrerenderBindings (CF prerender subprocess bindings),
 * `prerender.ts` runNodePrerenderRunner (Node prerender child process env),
 * `cli/deploy.ts` loadDeployEnv (deploy manifest vars).
 */
export const INTERNAL_ENV_KEYS = [
  '__VOID_TOKEN',
  '__VOID_PROJECT_ID',
  '__VOID_REMOTE',
  '__VOID_STAGING',
  '__VOID_PROXY_URL',
  '__VOID_PROXY_TOKEN',
] as const;

const INTERNAL_ENV_KEY_SET: ReadonlySet<string> = new Set(INTERNAL_ENV_KEYS);

export type StripInternalEnvKeysResult<T> = {
  sanitized: T;
  stripped: Array<string>;
};

/**
 * Remove any internal Void env keys from a user-supplied env record. Returns
 * the sanitized record plus the list of keys that were stripped so callers
 * (which live in non-leaf modules) can emit a warning via `voidWarn`.
 *
 * This module is a leaf — it must not import from `../log` or any non-leaf
 * module, otherwise the prerender subprocess's worker bundle acquires
 * unwanted transitive dependencies. That's why warnings are the caller's
 * responsibility.
 */
export function stripInternalEnvKeys<T extends Record<string, unknown>>(
  input: T | undefined,
): StripInternalEnvKeysResult<T> {
  if (!input) {
    return { sanitized: {} as T, stripped: [] };
  }
  const sanitized: Record<string, unknown> = {};
  const stripped: Array<string> = [];
  for (const [key, value] of Object.entries(input)) {
    if (INTERNAL_ENV_KEY_SET.has(key)) {
      stripped.push(key);
      continue;
    }
    sanitized[key] = value;
  }
  return { sanitized: sanitized as T, stripped };
}
