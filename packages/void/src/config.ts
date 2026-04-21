import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RewriteDestination } from 'void/routes';
import type { HeaderRule, RedirectRule } from './cli/types';
export type { RedirectRule };
import { VOID_AUTH_PROVIDERS, isVoidAuthProvider, type VoidAuthProvider } from './auth/providers';
import type { HeadConfig } from './pages/head';

/** Redirect destination — string (302) or object with explicit status. */
export type RedirectDestination = string | { to: string; status?: 301 | 302 | 303 | 307 | 308 };

/** Supported database dialects (internal representation). */
export type DatabaseDialect = 'sqlite' | 'postgresql';

/** Curated wrangler fields that can be set via void.json. */
export interface WranglerConfig {
  compatibility_date?: string;
  compatibility_flags?: Array<string>;
}

/** Routing configuration — headers, redirects, rewrites, fallbacks, revalidation, prerendering. */
export interface RoutingConfig {
  revalidate?: number | Record<string, number>;
  prerender?: Array<string>;
  headers?: Record<string, Array<string>>;
  redirects?: Record<string, RedirectDestination>;
  rewrites?: Record<string, RewriteDestination>;
  fallbacks?: Record<string, RewriteDestination>;
}

/** Inference configuration — bindings, scanDirs, build, outputDir, appType. */
export interface InferenceConfig {
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean;
  };
  scanDirs?: Array<string>;
  build?: string;
  outputDir?: string;
  appType?: 'spa' | 'static' | 'void' | 'framework';
}

/** Auth configuration — high-level provider selection for Better Auth defaults. */
export interface AuthConfig {
  providers?: Array<VoidAuthProvider>;
}

/** Shape of the `void.json` config file. All fields optional. */
export interface VoidConfig {
  $schema?: string;
  target?: 'cloudflare' | 'node' | 'bun' | 'deno';
  output?: 'server' | 'static';
  auth?: AuthConfig;
  head?: HeadConfig;
  routing?: RoutingConfig;
  inference?: InferenceConfig;
  remote?: boolean;
  worker?: WranglerConfig;
  database?: 'pg';
}

const CONFIG_FILE = 'void.json';

const VALID_TARGETS = new Set(['cloudflare', 'node', 'bun', 'deno']);
const VALID_APP_TYPES = new Set(['spa', 'static', 'void', 'framework']);
const VALID_OUTPUTS = new Set(['server', 'static']);
/**
 * Allowed 3xx redirect statuses. Source of truth for the framework, the
 * `_redirects` parser (`cli/headers.ts`), and the schema.json enum. 303 is
 * included for POST→GET after-submit patterns; 304/305/306 aren't
 * cacheable-safe / are deprecated.
 */
export const VALID_REDIRECT_STATUSES: Set<number> = new Set([301, 302, 303, 307, 308]);
const VALID_DATABASE_VALUES = new Set(['pg']);

/**
 * Reject a rule source containing more than one `*` wildcard. The dispatch
 * worker compiles each `*` into a `(?<splat>...)` named capture group; having
 * two of them in one pattern means `new RegExp()` throws at startup with a
 * cryptic "duplicate group name" error. Fail at config-read time with a
 * clear message instead. `kind` is a capitalised noun (e.g. "Redirect",
 * "Rewrite") used in the error text.
 */
export function assertSingleSplat(source: string, kind: string): void {
  let count = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '*') {
      count++;
    }
  }
  if (count > 1) {
    throw new Error(
      `${kind} source "${source}" in ${CONFIG_FILE} must contain at most one "*" wildcard (got ${count}); the matched portion is captured once as :splat`,
    );
  }
}

/** Old flat keys that have moved into namespaces. */
const MIGRATION_ERRORS: Record<string, string> = {
  bindings: '"bindings" has moved to "inference.bindings"',
  build: '"build" has moved to "inference.build"',
  scanDirs: '"scanDirs" has moved to "inference.scanDirs"',
  appType: '"appType" has moved to "inference.appType"',
  outputDir: '"outputDir" has moved to "inference.outputDir"',
  headers: '"headers" has moved to "routing.headers"',
  redirects: '"redirects" has moved to "routing.redirects"',
  cache:
    '"cache" has been replaced by "routing" — use "routing.revalidate" and "routing.prerender"',
  wrangler: '"wrangler" has been renamed to "worker"',
  mode: '"mode" has been renamed to "inference.appType"',
  revalidate: '"revalidate" has moved to "routing.revalidate"',
};

/**
 * Read and validate the `void.json` config file from the project root.
 * Returns an empty config object if no file exists.
 */
export function readConfig(root: string): VoidConfig {
  const filePath = join(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_FILE}`);
  }

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`${CONFIG_FILE} must be a JSON object`);
  }

  const obj = config as Record<string, unknown>;

  // Check for old flat keys that have moved
  for (const [key, message] of Object.entries(MIGRATION_ERRORS)) {
    if (obj[key] !== undefined) {
      throw new Error(`${message} in ${CONFIG_FILE}`);
    }
  }

  // Validate target
  if (obj.target !== undefined) {
    if (typeof obj.target !== 'string' || !VALID_TARGETS.has(obj.target)) {
      throw new Error(`"target" in ${CONFIG_FILE} must be one of: cloudflare, node, bun, deno`);
    }
  }

  // Validate output
  if (obj.output !== undefined) {
    if (typeof obj.output !== 'string' || !VALID_OUTPUTS.has(obj.output)) {
      throw new Error(`"output" in ${CONFIG_FILE} must be one of: server, static`);
    }
  }

  // Validate auth
  if (obj.auth !== undefined) {
    if (typeof obj.auth !== 'object' || obj.auth === null || Array.isArray(obj.auth)) {
      throw new Error(`"auth" in ${CONFIG_FILE} must be an object`);
    }

    const auth = obj.auth as Record<string, unknown>;
    for (const key of Object.keys(auth)) {
      if (key !== 'providers') {
        throw new Error(`Unknown key "auth.${key}" in ${CONFIG_FILE}. Valid: providers`);
      }
    }

    if (auth.providers !== undefined) {
      if (!Array.isArray(auth.providers)) {
        throw new Error(`"auth.providers" in ${CONFIG_FILE} must be an array of strings`);
      }
      if (auth.providers.length === 0) {
        throw new Error(`"auth.providers" in ${CONFIG_FILE} must not be empty`);
      }

      const seen = new Set<string>();
      for (const provider of auth.providers) {
        if (typeof provider !== 'string') {
          throw new Error(`"auth.providers" in ${CONFIG_FILE} must be an array of strings`);
        }
        if (!isVoidAuthProvider(provider)) {
          throw new Error(
            `"auth.providers" value "${provider}" in ${CONFIG_FILE} must be one of: ${VOID_AUTH_PROVIDERS.join(', ')}`,
          );
        }
        if (seen.has(provider)) {
          throw new Error(`"auth.providers" in ${CONFIG_FILE} must not contain duplicates`);
        }
        seen.add(provider);
      }
    }
  }

  // Validate head
  if (obj.head !== undefined) {
    if (typeof obj.head !== 'object' || obj.head === null || Array.isArray(obj.head)) {
      throw new Error(`"head" in ${CONFIG_FILE} must be an object`);
    }
    const h = obj.head as Record<string, unknown>;
    if (h.title !== undefined && typeof h.title !== 'string') {
      throw new Error(`"head.title" in ${CONFIG_FILE} must be a string`);
    }
    if (h.titleTemplate !== undefined && typeof h.titleTemplate !== 'string') {
      throw new Error(`"head.titleTemplate" in ${CONFIG_FILE} must be a string`);
    }
    if (h.meta !== undefined) {
      if (!Array.isArray(h.meta)) {
        throw new Error(`"head.meta" in ${CONFIG_FILE} must be an array`);
      }
      for (const entry of h.meta) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new Error(`"head.meta" entries in ${CONFIG_FILE} must be objects`);
        }
      }
    }
    if (h.link !== undefined) {
      if (!Array.isArray(h.link)) {
        throw new Error(`"head.link" in ${CONFIG_FILE} must be an array`);
      }
    }
    if (h.script !== undefined) {
      if (!Array.isArray(h.script)) {
        throw new Error(`"head.script" in ${CONFIG_FILE} must be an array`);
      }
    }
    if (h.htmlAttrs !== undefined) {
      if (typeof h.htmlAttrs !== 'object' || h.htmlAttrs === null || Array.isArray(h.htmlAttrs)) {
        throw new Error(`"head.htmlAttrs" in ${CONFIG_FILE} must be an object`);
      }
    }
    if (h.bodyAttrs !== undefined) {
      if (typeof h.bodyAttrs !== 'object' || h.bodyAttrs === null || Array.isArray(h.bodyAttrs)) {
        throw new Error(`"head.bodyAttrs" in ${CONFIG_FILE} must be an object`);
      }
    }
  }

  // Validate routing
  if (obj.routing !== undefined) {
    if (typeof obj.routing !== 'object' || obj.routing === null || Array.isArray(obj.routing)) {
      throw new Error(`"routing" in ${CONFIG_FILE} must be an object`);
    }
    const routing = obj.routing as Record<string, unknown>;

    // Validate routing.revalidate
    if (routing.revalidate !== undefined) {
      if (typeof routing.revalidate === 'number') {
        if (!Number.isFinite(routing.revalidate) || routing.revalidate < 0) {
          throw new Error(
            `"routing.revalidate" in ${CONFIG_FILE} must be a non-negative finite number`,
          );
        }
      } else if (
        typeof routing.revalidate === 'object' &&
        routing.revalidate !== null &&
        !Array.isArray(routing.revalidate)
      ) {
        const r = routing.revalidate as Record<string, unknown>;
        for (const [pattern, value] of Object.entries(r)) {
          if (pattern !== '*' && !pattern.startsWith('/')) {
            throw new Error(
              `"routing.revalidate" key "${pattern}" in ${CONFIG_FILE} must start with "/" or be "*"`,
            );
          }
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(
              `"routing.revalidate" value for "${pattern}" in ${CONFIG_FILE} must be a non-negative finite number`,
            );
          }
        }
      } else {
        throw new Error(
          `"routing.revalidate" in ${CONFIG_FILE} must be a number or an object of path patterns to numbers`,
        );
      }
    }

    // Validate routing.prerender
    if (routing.prerender !== undefined) {
      if (
        !Array.isArray(routing.prerender) ||
        !routing.prerender.every((p) => typeof p === 'string')
      ) {
        throw new Error(`"routing.prerender" in ${CONFIG_FILE} must be an array of strings`);
      }
      for (const p of routing.prerender as Array<string>) {
        if (!p.startsWith('/')) {
          throw new Error(`"routing.prerender" path "${p}" in ${CONFIG_FILE} must start with "/"`);
        }
      }
    }

    // Validate routing.headers
    if (routing.headers !== undefined) {
      if (
        typeof routing.headers !== 'object' ||
        routing.headers === null ||
        Array.isArray(routing.headers)
      ) {
        throw new Error(`"routing.headers" in ${CONFIG_FILE} must be an object`);
      }
      const h = routing.headers as Record<string, unknown>;
      for (const [pattern, values] of Object.entries(h)) {
        if (!pattern.startsWith('/')) {
          throw new Error(`Header pattern "${pattern}" in ${CONFIG_FILE} must start with "/"`);
        }
        assertSingleSplat(pattern, 'Header');
        if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
          throw new Error(`Headers for "${pattern}" in ${CONFIG_FILE} must be an array of strings`);
        }
      }
    }

    // Validate routing.redirects
    if (routing.redirects !== undefined) {
      if (
        typeof routing.redirects !== 'object' ||
        routing.redirects === null ||
        Array.isArray(routing.redirects)
      ) {
        throw new Error(`"routing.redirects" in ${CONFIG_FILE} must be an object`);
      }
      const r = routing.redirects as Record<string, unknown>;
      for (const [source, dest] of Object.entries(r)) {
        if (!source.startsWith('/')) {
          throw new Error(`Redirect source "${source}" in ${CONFIG_FILE} must start with "/"`);
        }
        assertSingleSplat(source, 'Redirect');
        if (typeof dest === 'string') {
          // ok
        } else if (typeof dest === 'object' && dest !== null && !Array.isArray(dest)) {
          const d = dest as Record<string, unknown>;
          if (typeof d.to !== 'string') {
            throw new Error(`Redirect for "${source}" in ${CONFIG_FILE} must have a "to" string`);
          }
          if (d.status !== undefined && !VALID_REDIRECT_STATUSES.has(d.status as number)) {
            throw new Error(
              `Redirect status for "${source}" in ${CONFIG_FILE} must be 301, 302, 303, 307, or 308`,
            );
          }
        } else {
          throw new Error(
            `Redirect for "${source}" in ${CONFIG_FILE} must be a string or an object with "to" and optional "status"`,
          );
        }
      }
    }

    // Validate routing.rewrites
    if (routing.rewrites !== undefined) {
      if (
        typeof routing.rewrites !== 'object' ||
        routing.rewrites === null ||
        Array.isArray(routing.rewrites)
      ) {
        throw new Error(`"routing.rewrites" in ${CONFIG_FILE} must be an object`);
      }
      const rw = routing.rewrites as Record<string, unknown>;
      for (const [source, dest] of Object.entries(rw)) {
        if (!source.startsWith('/')) {
          throw new Error(`Rewrite source "${source}" in ${CONFIG_FILE} must start with "/"`);
        }
        assertSingleSplat(source, 'Rewrite');
        if (typeof dest !== 'string') {
          throw new Error(`Rewrite destination for "${source}" in ${CONFIG_FILE} must be a string`);
        }
        if (!dest.startsWith('/')) {
          throw new Error(
            `Rewrite destination for "${source}" in ${CONFIG_FILE} must start with "/" (only internal paths are supported)`,
          );
        }
        if (dest.includes('?')) {
          throw new Error(
            `Rewrite destination for "${source}" in ${CONFIG_FILE} must not contain "?" (query strings are not supported in rewrite destinations; the incoming request's query is preserved automatically)`,
          );
        }
      }
    }

    // Validate routing.fallbacks
    if (routing.fallbacks !== undefined) {
      if (
        typeof routing.fallbacks !== 'object' ||
        routing.fallbacks === null ||
        Array.isArray(routing.fallbacks)
      ) {
        throw new Error(`"routing.fallbacks" in ${CONFIG_FILE} must be an object`);
      }
      const fb = routing.fallbacks as Record<string, unknown>;
      for (const [source, dest] of Object.entries(fb)) {
        if (!source.startsWith('/')) {
          throw new Error(`Fallback source "${source}" in ${CONFIG_FILE} must start with "/"`);
        }
        assertSingleSplat(source, 'Fallback');
        if (typeof dest !== 'string') {
          throw new Error(
            `Fallback destination for "${source}" in ${CONFIG_FILE} must be a string`,
          );
        }
        if (!dest.startsWith('/')) {
          throw new Error(
            `Fallback destination for "${source}" in ${CONFIG_FILE} must start with "/" (only internal paths are supported)`,
          );
        }
        if (dest.includes('?')) {
          throw new Error(
            `Fallback destination for "${source}" in ${CONFIG_FILE} must not contain "?" (query strings are not supported in fallback destinations; the incoming request's query is preserved automatically)`,
          );
        }
      }
    }
  }

  // Validate inference
  if (obj.inference !== undefined) {
    if (
      typeof obj.inference !== 'object' ||
      obj.inference === null ||
      Array.isArray(obj.inference)
    ) {
      throw new Error(`"inference" in ${CONFIG_FILE} must be an object`);
    }
    const inf = obj.inference as Record<string, unknown>;

    if (inf.auth !== undefined) {
      throw new Error(
        `"inference.auth" in ${CONFIG_FILE} is no longer supported; use auth.ts or import from "void/auth"/"void/client" instead`,
      );
    }

    // Validate inference.bindings
    if (inf.bindings !== undefined) {
      if (
        typeof inf.bindings !== 'object' ||
        inf.bindings === null ||
        Array.isArray(inf.bindings)
      ) {
        throw new Error(`"inference.bindings" in ${CONFIG_FILE} must be an object`);
      }
      const b = inf.bindings as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (!['db', 'kv', 'storage', 'ai'].includes(key)) {
          throw new Error(`Unknown binding "${key}" in ${CONFIG_FILE}. Valid: db, kv, storage, ai`);
        }
        if (key === 'ai') {
          if (typeof b[key] !== 'boolean') {
            throw new Error(`"inference.bindings.${key}" in ${CONFIG_FILE} must be a boolean`);
          }
        } else {
          if (typeof b[key] !== 'boolean' && typeof b[key] !== 'string') {
            throw new Error(
              `"inference.bindings.${key}" in ${CONFIG_FILE} must be a boolean or a string (custom binding name)`,
            );
          }
        }
      }
    }

    // Validate inference.build
    if (inf.build !== undefined && typeof inf.build !== 'string') {
      throw new Error(`"inference.build" in ${CONFIG_FILE} must be a string`);
    }

    // Validate inference.scanDirs
    if (inf.scanDirs !== undefined) {
      if (!Array.isArray(inf.scanDirs) || !inf.scanDirs.every((d) => typeof d === 'string')) {
        throw new Error(`"inference.scanDirs" in ${CONFIG_FILE} must be an array of strings`);
      }
      for (const d of inf.scanDirs as Array<string>) {
        if (d.startsWith('/') || d.startsWith('..')) {
          throw new Error(
            `"inference.scanDirs" path "${d}" in ${CONFIG_FILE} must be a relative directory`,
          );
        }
      }
    }

    // Validate inference.appType
    if (inf.appType !== undefined) {
      if (typeof inf.appType !== 'string' || !VALID_APP_TYPES.has(inf.appType)) {
        throw new Error(
          `"inference.appType" in ${CONFIG_FILE} must be one of: spa, static, void, framework`,
        );
      }
    }

    // Validate inference.outputDir
    if (inf.outputDir !== undefined && typeof inf.outputDir !== 'string') {
      throw new Error(`"inference.outputDir" in ${CONFIG_FILE} must be a string`);
    }
  }

  // Validate remote
  if (obj.remote !== undefined && typeof obj.remote !== 'boolean') {
    throw new Error(`"remote" in ${CONFIG_FILE} must be a boolean`);
  }

  // Validate worker
  if (obj.worker !== undefined) {
    if (typeof obj.worker !== 'object' || obj.worker === null || Array.isArray(obj.worker)) {
      throw new Error(`"worker" in ${CONFIG_FILE} must be an object`);
    }
    const w = obj.worker as Record<string, unknown>;
    if (w.compatibility_date !== undefined) {
      if (typeof w.compatibility_date !== 'string') {
        throw new Error(`"worker.compatibility_date" in ${CONFIG_FILE} must be a string`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date)) {
        throw new Error(`"worker.compatibility_date" in ${CONFIG_FILE} must be YYYY-MM-DD format`);
      }
    }
    if (w.compatibility_flags !== undefined) {
      if (
        !Array.isArray(w.compatibility_flags) ||
        !w.compatibility_flags.every((f) => typeof f === 'string')
      ) {
        throw new Error(
          `"worker.compatibility_flags" in ${CONFIG_FILE} must be an array of strings`,
        );
      }
    }
  }

  // Validate database
  if (obj.database !== undefined) {
    if (typeof obj.database !== 'string' || !VALID_DATABASE_VALUES.has(obj.database)) {
      throw new Error(`"database" in ${CONFIG_FILE} must be "pg"`);
    }
  }

  return obj as VoidConfig;
}

/** Returns true if the target is a non-Cloudflare runtime (Node.js, Bun, Deno). */
export function isNodeTarget(target: VoidConfig['target']): boolean {
  return target === 'node' || target === 'bun' || target === 'deno';
}

/**
 * Extract custom binding names from config. Returns only entries where
 * a string name was explicitly provided (not `true`).
 */
export function resolveBindingNames(
  bindings: InferenceConfig['bindings'],
): { d1?: string; kv?: string; r2?: string } | undefined {
  if (!bindings) {
    return undefined;
  }
  const names: { d1?: string; kv?: string; r2?: string } = {};
  let hasCustom = false;
  if (typeof bindings.db === 'string') {
    names.d1 = bindings.db;
    hasCustom = true;
  }
  if (typeof bindings.kv === 'string') {
    names.kv = bindings.kv;
    hasCustom = true;
  }
  if (typeof bindings.storage === 'string') {
    names.r2 = bindings.storage;
    hasCustom = true;
  }
  return hasCustom ? names : undefined;
}

/**
 * Get the database dialect from config. Defaults to "sqlite".
 */
export function getDatabaseDialect(config: VoidConfig): DatabaseDialect {
  return config.database === 'pg' ? 'postgresql' : 'sqlite';
}

/**
 * Convert the `headers` config field into `HeaderRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/assets/*") and each value is an array of
 * "Name: value" strings. Returns undefined if the input is empty or undefined.
 */
export function convertHeadersConfig(
  headers: Record<string, Array<string>> | undefined,
): Array<HeaderRule> | undefined {
  if (!headers) {
    return undefined;
  }

  const rules: Array<HeaderRule> = [];

  for (const [pattern, values] of Object.entries(headers)) {
    const parsed: Array<[string, string]> = [];
    for (const entry of values) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }
      const name = entry.slice(0, colonIdx).trim();
      const value = entry.slice(colonIdx + 1).trim();
      if (name) {
        parsed.push([name, value]);
      }
    }
    if (parsed.length > 0) {
      rules.push({ pattern, headers: parsed });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `redirects` config field into `RedirectRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/old") and each value is either a string
 * destination (defaults to 302) or an object with `to` and optional `status`.
 * Returns undefined if the input is empty or undefined.
 */
export function convertRedirectsConfig(
  redirects: Record<string, RedirectDestination> | undefined,
): Array<RedirectRule> | undefined {
  if (!redirects) {
    return undefined;
  }

  const origin = 'void.json#routing.redirects';
  const rules: Array<RedirectRule> = [];
  for (const [source, dest] of Object.entries(redirects)) {
    if (typeof dest === 'string') {
      rules.push({ source, destination: dest, status: 302, origin });
    } else {
      rules.push({ source, destination: dest.to, status: dest.status ?? 302, origin });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `rewrites` config field into `RedirectRule[]` with status 200.
 *
 * Each key is a URL pattern (e.g. "/docs") and each value is a destination path.
 * Rewrites serve content from the destination without changing the browser URL.
 * Emits `force: true` so these rules fire unconditionally, overriding any
 * matching static asset (Netlify-compat `200!` semantics). Returns undefined
 * if the input is empty or undefined.
 */
export function convertRewritesConfig(
  rewrites: Record<string, RewriteDestination> | undefined,
): RedirectRule[] | undefined {
  if (!rewrites) {
    return undefined;
  }

  const origin = 'void.json#routing.rewrites';
  const rules: RedirectRule[] = [];
  for (const [source, destination] of Object.entries(rewrites)) {
    rules.push({ source, destination, status: 200, force: true, origin });
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `fallbacks` config field into `RedirectRule[]` with status 200.
 *
 * Fallbacks fire only when the static asset resolver would otherwise return
 * 404. They share the rewrite shape (status 200, pathname-only destination)
 * but are evaluated at a different pipeline phase — post-lookup instead of
 * pre-lookup. Emits `force: false` (Netlify-compat plain `200` semantics).
 * Returns undefined if the input is empty or undefined.
 */
export function convertFallbacksConfig(
  fallbacks: Record<string, RewriteDestination> | undefined,
): RedirectRule[] | undefined {
  if (!fallbacks) {
    return undefined;
  }

  const origin = 'void.json#routing.fallbacks';
  const rules: RedirectRule[] = [];
  for (const [source, destination] of Object.entries(fallbacks)) {
    rules.push({ source, destination, status: 200, force: false, origin });
  }

  return rules.length > 0 ? rules : undefined;
}
