import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import type { RewriteDestination } from 'void/routes';
import type { DevRedirectRule, HeaderRule, RedirectRule } from './cli/types.ts';
export type { RedirectRule };
import {
  VOID_AUTH_PROVIDERS,
  isVoidAuthProvider,
  type VoidAuthProvider,
} from './auth/providers.ts';
import type { HeadConfig } from './pages/head.ts';
import { validateSourceDir } from './project-paths.ts';
import type { SandboxConfig, SandboxInstanceType } from './sandbox/config.ts';

/** Redirect destination — string (302) or object with explicit status. */
export type RedirectDestination = string | { to: string; status?: 301 | 302 | 303 | 307 | 308 };

/** Supported database dialects (internal representation). */
export type DatabaseDialect = 'sqlite' | 'postgresql';

/** Curated wrangler fields that can be set via void.json. */
export type WranglerConfig = {
  compatibility_date?: string;
  compatibility_flags?: Array<string>;
  vars?: Record<string, string>;
};

/** Routing configuration — headers, redirects, rewrites, fallbacks, revalidation, prerendering. */
export type RoutingConfig = {
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  prerender?: Array<string>;
  headers?: Record<string, Array<string>>;
  redirects?: Record<string, RedirectDestination>;
  rewrites?: Record<string, RewriteDestination>;
  fallbacks?: Record<string, RewriteDestination>;
};

/** Inference configuration — bindings, scanDirs, build, outputDir, appType. */
export type InferenceConfig = {
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean;
  };
  scanDirs?: ReadonlyArray<string>;
  build?: string;
  outputDir?: string;
  appType?: 'spa' | 'static' | 'void' | 'framework';
};

/** Auth configuration — high-level provider selection for Better Auth defaults. */
export type AuthConfig = {
  providers?: Array<VoidAuthProvider>;
};

/** AI configuration — the Cloudflare AI Gateway used by `ai.provider().fetch()` on self-hosted deploys (Workers AI `ai.run`/`ai.image` use the `env.AI` binding directly). */
export type AiConfig = {
  gateway?: string;
};

/** Shape of the `void.json` config file. All fields optional. */
export type VoidConfig = {
  $schema?: string;
  sourceDir?: string;
  target?: 'cloudflare' | 'node' | 'bun' | 'deno';
  output?: 'server' | 'static';
  auth?: AuthConfig;
  head?: HeadConfig;
  routing?: RoutingConfig;
  inference?: InferenceConfig;
  sandbox?: boolean | SandboxConfig;
  remote?: boolean;
  worker?: WranglerConfig;
  database?: 'pg';
  ai?: AiConfig;
};

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
const VALID_SANDBOX_INSTANCE_TYPES = new Set<SandboxInstanceType>([
  'dev',
  'lite',
  'basic',
  'standard',
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
]);

/**
 * Count anonymous `*` wildcards in a pattern, ignoring the `*` that
 * terminates a `:name*` multi-segment named capture.
 *
 * Both the framework's emitted `__compilePattern` (router/compile.ts) and
 * dispatch's `compilePattern` (packages/dispatch/src/pattern.ts) emit a
 * distinct `(?<name>.*)` group for `:name*` and a `(?<splat>.*)` group for
 * the first bare `*` — those don't clash, so a pattern with both a named
 * multi-segment capture and a bare splat is legitimate and must validate.
 * Walking raw chars would over-count and cause `assertSingleSplat` to
 * reject such patterns.
 *
 * The identifier character class matches `[A-Za-z0-9_]+` from both compilers.
 */
export function countSplats(source: string): number {
  // Strip `:name*` first — the `*` there is the tail of a named multi-segment
  // capture (matches `[A-Za-z0-9_]+` per both compilers' identifier class),
  // not an anonymous splat. The remaining `*`s are the ones validators care
  // about for duplicate-group-name avoidance.
  return source.replace(/:[A-Za-z0-9_]+\*/g, '').match(/\*/g)?.length ?? 0;
}

/**
 * Reject a rule source containing more than one `*` wildcard. The dispatch
 * worker compiles each `*` into a `(?<splat>...)` named capture group; having
 * two of them in one pattern means `new RegExp()` throws at startup with a
 * cryptic "duplicate group name" error. Fail at config-read time with a
 * clear message instead. `kind` is a capitalised noun (e.g. "Redirect",
 * "Rewrite") used in the error text.
 */
export function assertSingleSplat(source: string, kind: string): void {
  const count = countSplats(source);
  if (count > 1) {
    throw new Error(
      `${kind} source "${source}" in ${CONFIG_FILE} must contain at most one "*" wildcard (got ${count}); the matched portion is captured once as :splat`,
    );
  }
}

/**
 * Reject patterns whose compilation would produce duplicate named-capture
 * groups, which makes `new RegExp()` throw `SyntaxError: Duplicate capture
 * group name` at request time. Two cases:
 *
 *   1. Two `:name` (or `:name` + trailing `*`) tokens with the same
 *      identifier — e.g. `/:id/:id`, or two named-multi-segment captures
 *      sharing a name.
 *   2. A `:splat` (named) token alongside a bare `*` — both compile to a
 *      `(?<splat>...)` group.
 *
 * `assertSingleSplat` already prevents two bare `*`s clashing on the
 * implicit `splat` name. This complements it. The runtime emitter has a
 * try/catch defense-in-depth in `emitApplyRoutingRules`, but failing at
 * config-read with a precise message is friendlier than a CLI-log warn.
 */
export function assertUniqueCaptureNames(source: string, kind: string): void {
  const seen = new Set<string>();
  const dups = new Set<string>();
  // Same identifier class as both compilers (`__compilePattern` and
  // dispatch's `compilePattern`). Trailing `*` is optional — `:name` and
  // `:name*` both produce a `<name>` capture group.
  const captureNameRe = /:([A-Za-z0-9_]+)\*?/g;
  let captureMatch: RegExpExecArray | null;
  while ((captureMatch = captureNameRe.exec(source)) !== null) {
    const name = captureMatch[1]!;
    if (seen.has(name)) {
      dups.add(name);
    }
    seen.add(name);
  }
  // Bare `*` (post-`:name*` strip) emits `(?<splat>...)`. If the pattern
  // also has a `:splat` token, both produce the same group name.
  if (countSplats(source) >= 1 && seen.has('splat')) {
    dups.add('splat');
  }
  if (dups.size > 0) {
    const names = [...dups].map((name) => `:${name}`).join(', ');
    throw new Error(
      `${kind} source "${source}" in ${CONFIG_FILE} has duplicate capture group name(s) (${names}); each :name token must be unique within a pattern, and :splat collides with a bare "*"`,
    );
  }
}

/**
 * Predicate for the "protocol-relative" shape: a leading `//` parses as
 * `//host/path` → `https://host/path`, which silently turns an intended
 * in-worker rewrite/redirect into a cross-origin proxy.
 *
 * Shared by the `void.json` validators below and the `_redirects` parser
 * (`cli/headers.ts`). The `c.rewrite()` codegen in `router/compile.ts`
 * inlines an equivalent check in emitted worker code — it validates
 * runtime user input rather than config, so it can't call through here.
 */
export function isProtocolRelative(dest: string): boolean {
  return dest.startsWith('//');
}

function assertNotProtocolRelative(
  dest: string,
  source: string,
  kind: 'Redirect' | 'Rewrite' | 'Fallback',
): void {
  if (!isProtocolRelative(dest)) {
    return;
  }
  const suffix =
    kind === 'Redirect'
      ? 'use a single-slash path for internal redirects or an explicit "https://..." URL for external'
      : 'only internal paths are supported';
  throw new Error(
    `${kind} destination for "${source}" in ${CONFIG_FILE} must not start with "//" (protocol-relative URLs parse as cross-origin; ${suffix})`,
  );
}

/**
 * Strict literal-hostname regex used by `parseHostPrefixedSource` to validate
 * the host portion of an `https://host/path` rule source. Mirrors
 * `LITERAL_HOSTNAME_REGEX` in `packages/api/src/routes/deploy.ts` and the
 * regex in `packages/api/src/routes/domains.ts`. Rejects scheme prefixes,
 * ports, paths, whitespace, control chars, wildcards, single-label hosts,
 * IPv4 literals, and userinfo. The host is lowercased before testing so the
 * same byte-exact form reaches dispatch (which compares against the
 * lowercase `url.hostname`).
 */
const LITERAL_HOSTNAME_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export type ParsedRuleSource = {
  host: string | undefined;
  path: string;
};

/**
 * Split an optional `https://host/path` prefix from a rule source.
 *
 * Path-only sources (no scheme) are returned as `{ host: undefined, path }`.
 * Sources starting with `https://` have the host portion extracted and
 * lowercase-normalized; the remaining path becomes `path` (including the
 * leading `/`, which the caller may further validate).
 *
 * Rejected (returns `{ error }`):
 * - `http://...` — TLS terminates upstream of the dispatch worker; only
 *   `https://` requests ever reach the runtime, so an `http://`-scoped rule
 *   physically cannot fire.
 * - `//host/path` — protocol-relative; ambiguous and rejected by the same
 *   reasoning.
 * - `https://` with a wildcarded, ported, or otherwise non-literal host
 *   (v1 only supports literal hosts).
 * - `https://` with no path (`https://host`) — accepted and normalized to
 *   `https://host/` so the path is always non-empty.
 */
export function parseHostPrefixedSource(raw: string): ParsedRuleSource | { error: string } {
  if (raw.startsWith('//')) {
    return {
      error: `must not start with "//" (protocol-relative URLs are ambiguous; use "/path" for path-only or "https://host/path")`,
    };
  }
  if (raw.startsWith('http://')) {
    return {
      error: `must not start with "http://" (TLS terminates upstream of the worker; only "https://" requests reach the runtime — use "https://host/path" instead)`,
    };
  }
  if (!raw.startsWith('https://')) {
    return { host: undefined, path: raw };
  }

  // Find the first `/` after `https://` — that's where the path starts.
  const afterScheme = raw.slice('https://'.length);
  const slashIdx = afterScheme.indexOf('/');
  const rawHost = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  const path = slashIdx === -1 ? '/' : afterScheme.slice(slashIdx);
  const host = rawHost.toLowerCase();
  if (!LITERAL_HOSTNAME_REGEX.test(host)) {
    return {
      error: `host must be a literal hostname (e.g. "https://www.example.com/path"; no port, wildcards, or userinfo): ${JSON.stringify(rawHost)}`,
    };
  }
  return { host, path };
}

/**
 * Shared guard for rewrite/fallback destinations: they preserve the incoming
 * request's query string, so embedding one in the destination would silently
 * override (or merge confusingly with) the request query.
 */
function assertNoQueryString(dest: string, source: string, kind: 'Rewrite' | 'Fallback'): void {
  if (!dest.includes('?')) {
    return;
  }
  throw new Error(
    `${kind} destination for "${source}" in ${CONFIG_FILE} must not contain "?" (query strings are not supported in ${kind.toLowerCase()} destinations; the incoming request's query is preserved automatically)`,
  );
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
    throw new Error(`config: Invalid JSON in ${CONFIG_FILE}.`);
  }

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`config: ${CONFIG_FILE} must be a JSON object.`);
  }

  const obj = config as Record<string, unknown>;

  // Check for old flat keys that have moved
  for (const [key, message] of Object.entries(MIGRATION_ERRORS)) {
    if (obj[key] !== undefined) {
      throw new Error(`config: ${message} in ${CONFIG_FILE}.`);
    }
  }

  // Validate sourceDir
  if (obj.sourceDir !== undefined) {
    if (typeof obj.sourceDir !== 'string') {
      throw new Error(`config: "sourceDir" in ${CONFIG_FILE} must be a string.`);
    }
    validateSourceDir(obj.sourceDir);
  }

  // Validate target
  if (obj.target !== undefined) {
    if (typeof obj.target !== 'string' || !VALID_TARGETS.has(obj.target)) {
      throw new Error(
        `config: "target" in ${CONFIG_FILE} must be one of: cloudflare, node, bun, deno.`,
      );
    }
  }

  // Validate output
  if (obj.output !== undefined) {
    if (typeof obj.output !== 'string' || !VALID_OUTPUTS.has(obj.output)) {
      throw new Error(`config: "output" in ${CONFIG_FILE} must be one of: server, static.`);
    }
  }

  // Validate auth
  if (obj.auth !== undefined) {
    if (typeof obj.auth !== 'object' || obj.auth === null || Array.isArray(obj.auth)) {
      throw new Error(`config: "auth" in ${CONFIG_FILE} must be an object.`);
    }

    const auth = obj.auth as Record<string, unknown>;
    for (const key of Object.keys(auth)) {
      if (key !== 'providers') {
        throw new Error(`config: Unknown key 'auth.${key}' in ${CONFIG_FILE}. Valid: providers.`);
      }
    }

    if (auth.providers !== undefined) {
      if (!Array.isArray(auth.providers)) {
        throw new Error(`config: "auth.providers" in ${CONFIG_FILE} must be an array of strings.`);
      }
      if (auth.providers.length === 0) {
        throw new Error(`config: "auth.providers" in ${CONFIG_FILE} must not be empty.`);
      }

      const seen = new Set<string>();
      for (const provider of auth.providers) {
        if (typeof provider !== 'string') {
          throw new Error(
            `config: "auth.providers" in ${CONFIG_FILE} must be an array of strings.`,
          );
        }
        if (!isVoidAuthProvider(provider)) {
          throw new Error(
            `config: "auth.providers" value '${provider}' in ${CONFIG_FILE} must be one of: ${VOID_AUTH_PROVIDERS.join(', ')}.`,
          );
        }
        if (seen.has(provider)) {
          throw new Error(
            `config: "auth.providers" in ${CONFIG_FILE} must not contain duplicates.`,
          );
        }
        seen.add(provider);
      }
    }
  }

  // Validate head
  if (obj.head !== undefined) {
    if (typeof obj.head !== 'object' || obj.head === null || Array.isArray(obj.head)) {
      throw new Error(`config: "head" in ${CONFIG_FILE} must be an object.`);
    }
    const h = obj.head as Record<string, unknown>;
    if (h.title !== undefined && typeof h.title !== 'string') {
      throw new Error(`config: "head.title" in ${CONFIG_FILE} must be a string.`);
    }
    if (h.titleTemplate !== undefined && typeof h.titleTemplate !== 'string') {
      throw new Error(`config: "head.titleTemplate" in ${CONFIG_FILE} must be a string.`);
    }
    if (h.meta !== undefined) {
      if (!Array.isArray(h.meta)) {
        throw new Error(`config: "head.meta" in ${CONFIG_FILE} must be an array.`);
      }
      for (const entry of h.meta) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new Error(`config: "head.meta" entries in ${CONFIG_FILE} must be objects.`);
        }
      }
    }
    if (h.link !== undefined) {
      if (!Array.isArray(h.link)) {
        throw new Error(`config: "head.link" in ${CONFIG_FILE} must be an array.`);
      }
    }
    if (h.script !== undefined) {
      if (!Array.isArray(h.script)) {
        throw new Error(`config: "head.script" in ${CONFIG_FILE} must be an array.`);
      }
    }
    if (h.htmlAttrs !== undefined) {
      if (typeof h.htmlAttrs !== 'object' || h.htmlAttrs === null || Array.isArray(h.htmlAttrs)) {
        throw new Error(`config: "head.htmlAttrs" in ${CONFIG_FILE} must be an object.`);
      }
    }
    if (h.bodyAttrs !== undefined) {
      if (typeof h.bodyAttrs !== 'object' || h.bodyAttrs === null || Array.isArray(h.bodyAttrs)) {
        throw new Error(`config: "head.bodyAttrs" in ${CONFIG_FILE} must be an object.`);
      }
    }
  }

  // Validate routing
  if (obj.routing !== undefined) {
    if (typeof obj.routing !== 'object' || obj.routing === null || Array.isArray(obj.routing)) {
      throw new Error(`config: "routing" in ${CONFIG_FILE} must be an object.`);
    }
    const routing = obj.routing as Record<string, unknown>;

    // Validate routing.revalidate
    if (routing.revalidate !== undefined) {
      if (typeof routing.revalidate === 'number') {
        if (!Number.isFinite(routing.revalidate) || routing.revalidate < 0) {
          throw new Error(
            `config: "routing.revalidate" in ${CONFIG_FILE} must be a non-negative finite number.`,
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
              `config: "routing.revalidate" key '${pattern}' in ${CONFIG_FILE} must start with "/" or be "*".`,
            );
          }
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(
              `config: "routing.revalidate" value for '${pattern}' in ${CONFIG_FILE} must be a non-negative finite number.`,
            );
          }
        }
      } else {
        throw new Error(
          `config: "routing.revalidate" in ${CONFIG_FILE} must be a number or an object of path patterns to numbers.`,
        );
      }
    }

    // Validate routing.prerender
    if (routing.prerender !== undefined) {
      if (
        !Array.isArray(routing.prerender) ||
        !routing.prerender.every((p) => typeof p === 'string')
      ) {
        throw new Error(
          `config: "routing.prerender" in ${CONFIG_FILE} must be an array of strings.`,
        );
      }
      for (const p of routing.prerender as Array<string>) {
        if (!p.startsWith('/')) {
          throw new Error(
            `config: "routing.prerender" path '${p}' in ${CONFIG_FILE} must start with "/".`,
          );
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
        throw new Error(`config: "routing.headers" in ${CONFIG_FILE} must be an object.`);
      }
      const h = routing.headers as Record<string, unknown>;
      for (const [pattern, values] of Object.entries(h)) {
        if (!pattern.startsWith('/')) {
          throw new Error(
            `config: Header pattern '${pattern}' in ${CONFIG_FILE} must start with "/".`,
          );
        }
        assertSingleSplat(pattern, 'Header');
        if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
          throw new Error(
            `config: Headers for '${pattern}' in ${CONFIG_FILE} must be an array of strings.`,
          );
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
        throw new Error(`config: "routing.redirects" in ${CONFIG_FILE} must be an object.`);
      }
      const r = routing.redirects as Record<string, unknown>;
      for (const [source, dest] of Object.entries(r)) {
        const parsed = parseHostPrefixedSource(source);
        if ('error' in parsed) {
          throw new Error(
            `config: Redirect source '${source}' in ${CONFIG_FILE}: ${parsed.error}.`,
          );
        }
        if (!parsed.path.startsWith('/')) {
          throw new Error(
            `config: Redirect source '${source}' in ${CONFIG_FILE} must start with "/" (or be "https://host/path" with a path-absolute path).`,
          );
        }
        assertSingleSplat(parsed.path, 'Redirect');
        assertUniqueCaptureNames(parsed.path, 'Redirect');
        if (typeof dest === 'string') {
          if (dest.startsWith('/')) {
            assertNotProtocolRelative(dest, source, 'Redirect');
          }
        } else if (typeof dest === 'object' && dest !== null && !Array.isArray(dest)) {
          const d = dest as Record<string, unknown>;
          if (typeof d.to !== 'string') {
            throw new Error(
              `config: Redirect for '${source}' in ${CONFIG_FILE} must have a "to" string.`,
            );
          }
          if ((d.to as string).startsWith('/')) {
            assertNotProtocolRelative(d.to as string, source, 'Redirect');
          }
          if (d.status !== undefined && !VALID_REDIRECT_STATUSES.has(d.status as number)) {
            throw new Error(
              `config: Redirect status for '${source}' in ${CONFIG_FILE} must be 301, 302, 303, 307, or 308.`,
            );
          }
        } else {
          throw new Error(
            `config: Redirect for '${source}' in ${CONFIG_FILE} must be a string or an object with "to" and optional "status".`,
          );
        }
      }
    }

    // Validate routing.revalidateQueryAllowlist
    if (routing.revalidateQueryAllowlist !== undefined) {
      if (
        typeof routing.revalidateQueryAllowlist !== 'object' ||
        routing.revalidateQueryAllowlist === null ||
        Array.isArray(routing.revalidateQueryAllowlist)
      ) {
        throw new Error(`"routing.revalidateQueryAllowlist" in ${CONFIG_FILE} must be an object`);
      }
      for (const [pattern, params] of Object.entries(routing.revalidateQueryAllowlist)) {
        if (pattern !== '*' && !pattern.startsWith('/')) {
          throw new Error(
            `config: revalidateQueryAllowlist pattern '${pattern}' in ${CONFIG_FILE} must start with "/" or be "*".`,
          );
        }
        if (pattern !== '*') {
          assertSingleSplat(pattern, 'revalidateQueryAllowlist');
        }
        if (!Array.isArray(params) || !params.every((v) => typeof v === 'string')) {
          throw new Error(
            `config: revalidateQueryAllowlist for '${pattern}' in ${CONFIG_FILE} must be an array of strings.`,
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
        const parsed = parseHostPrefixedSource(source);
        if ('error' in parsed) {
          throw new Error(`Rewrite source "${source}" in ${CONFIG_FILE}: ${parsed.error}`);
        }
        if (!parsed.path.startsWith('/')) {
          throw new Error(
            `Rewrite source "${source}" in ${CONFIG_FILE} must start with "/" (or be "https://host/path" with a path-absolute path)`,
          );
        }
        assertSingleSplat(parsed.path, 'Rewrite');
        assertUniqueCaptureNames(parsed.path, 'Rewrite');
        if (typeof dest !== 'string') {
          throw new Error(`Rewrite destination for "${source}" in ${CONFIG_FILE} must be a string`);
        }
        if (!dest.startsWith('/')) {
          throw new Error(
            `Rewrite destination for "${source}" in ${CONFIG_FILE} must start with "/" (only internal paths are supported)`,
          );
        }
        assertNotProtocolRelative(dest, source, 'Rewrite');
        assertNoQueryString(dest, source, 'Rewrite');
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
        const parsed = parseHostPrefixedSource(source);
        if ('error' in parsed) {
          throw new Error(`Fallback source "${source}" in ${CONFIG_FILE}: ${parsed.error}`);
        }
        if (!parsed.path.startsWith('/')) {
          throw new Error(
            `Fallback source "${source}" in ${CONFIG_FILE} must start with "/" (or be "https://host/path" with a path-absolute path)`,
          );
        }
        assertSingleSplat(parsed.path, 'Fallback');
        assertUniqueCaptureNames(parsed.path, 'Fallback');
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
        assertNotProtocolRelative(dest, source, 'Fallback');
        assertNoQueryString(dest, source, 'Fallback');
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
      throw new Error(`config: "inference" in ${CONFIG_FILE} must be an object.`);
    }
    const inf = obj.inference as Record<string, unknown>;

    if (inf.auth !== undefined) {
      throw new Error(
        `config: "inference.auth" in ${CONFIG_FILE} is no longer supported. Use auth.ts or import from "void/auth"/"void/client" instead.`,
      );
    }

    // Validate inference.bindings
    if (inf.bindings !== undefined) {
      if (
        typeof inf.bindings !== 'object' ||
        inf.bindings === null ||
        Array.isArray(inf.bindings)
      ) {
        throw new Error(`config: "inference.bindings" in ${CONFIG_FILE} must be an object.`);
      }
      const b = inf.bindings as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (!['db', 'kv', 'storage', 'ai'].includes(key)) {
          throw new Error(
            `config: Unknown binding '${key}' in ${CONFIG_FILE}. Valid: db, kv, storage, ai.`,
          );
        }
        if (key === 'ai') {
          if (typeof b[key] !== 'boolean') {
            throw new Error(
              `config: "inference.bindings.${key}" in ${CONFIG_FILE} must be a boolean.`,
            );
          }
        } else {
          if (typeof b[key] !== 'boolean' && typeof b[key] !== 'string') {
            throw new Error(
              `config: "inference.bindings.${key}" in ${CONFIG_FILE} must be a boolean or a string custom binding name.`,
            );
          }
        }
      }
    }

    // Validate inference.build
    if (inf.build !== undefined && typeof inf.build !== 'string') {
      throw new Error(`config: "inference.build" in ${CONFIG_FILE} must be a string.`);
    }

    // Validate inference.scanDirs
    if (inf.scanDirs !== undefined) {
      if (!Array.isArray(inf.scanDirs) || !inf.scanDirs.every((d) => typeof d === 'string')) {
        throw new Error(
          `config: "inference.scanDirs" in ${CONFIG_FILE} must be an array of strings.`,
        );
      }
      for (const d of inf.scanDirs as Array<string>) {
        if (d.startsWith('/') || d.startsWith('..')) {
          throw new Error(
            `config: "inference.scanDirs" path '${d}' in ${CONFIG_FILE} must be a relative directory.`,
          );
        }
      }
    }

    // Validate inference.appType
    if (inf.appType !== undefined) {
      if (typeof inf.appType !== 'string' || !VALID_APP_TYPES.has(inf.appType)) {
        throw new Error(
          `config: "inference.appType" in ${CONFIG_FILE} must be one of: spa, static, void, framework.`,
        );
      }
    }

    // Validate inference.outputDir
    if (inf.outputDir !== undefined && typeof inf.outputDir !== 'string') {
      throw new Error(`config: "inference.outputDir" in ${CONFIG_FILE} must be a string.`);
    }
  }

  // Validate remote
  if (obj.remote !== undefined && typeof obj.remote !== 'boolean') {
    throw new Error(`config: "remote" in ${CONFIG_FILE} must be a boolean.`);
  }

  // Validate sandbox
  if (obj.sandbox !== undefined) {
    if (typeof obj.sandbox === 'boolean') {
      // ok
    } else if (
      typeof obj.sandbox === 'object' &&
      obj.sandbox !== null &&
      !Array.isArray(obj.sandbox)
    ) {
      const sandbox = obj.sandbox as Record<string, unknown>;
      for (const key of Object.keys(sandbox)) {
        if (
          ![
            'binding',
            'className',
            'containerName',
            'image',
            'imageBuildContext',
            'platformImage',
            'instanceType',
            'maxInstances',
          ].includes(key)
        ) {
          throw new Error(
            `config: Unknown key 'sandbox.${key}' in ${CONFIG_FILE}. Valid: binding, className, containerName, image, imageBuildContext, platformImage, instanceType, maxInstances.`,
          );
        }
      }
      for (const key of [
        'binding',
        'className',
        'containerName',
        'image',
        'imageBuildContext',
        'platformImage',
      ]) {
        if (sandbox[key] !== undefined && typeof sandbox[key] !== 'string') {
          throw new Error(`config: "sandbox.${key}" in ${CONFIG_FILE} must be a string.`);
        }
      }
      if (
        sandbox.instanceType !== undefined &&
        (typeof sandbox.instanceType !== 'string' ||
          !VALID_SANDBOX_INSTANCE_TYPES.has(sandbox.instanceType as SandboxInstanceType))
      ) {
        throw new Error(
          `config: "sandbox.instanceType" in ${CONFIG_FILE} must be one of: ${[...VALID_SANDBOX_INSTANCE_TYPES].join(', ')}.`,
        );
      }
      if (
        sandbox.maxInstances !== undefined &&
        (typeof sandbox.maxInstances !== 'number' ||
          !Number.isInteger(sandbox.maxInstances) ||
          sandbox.maxInstances < 1)
      ) {
        throw new Error(
          `config: "sandbox.maxInstances" in ${CONFIG_FILE} must be a positive integer.`,
        );
      }
    } else {
      throw new Error(`config: "sandbox" in ${CONFIG_FILE} must be a boolean or an object.`);
    }
  }

  // Validate worker
  if (obj.worker !== undefined) {
    if (typeof obj.worker !== 'object' || obj.worker === null || Array.isArray(obj.worker)) {
      throw new Error(`config: "worker" in ${CONFIG_FILE} must be an object.`);
    }
    const w = obj.worker as Record<string, unknown>;
    if (w.compatibility_date !== undefined) {
      if (typeof w.compatibility_date !== 'string') {
        throw new Error(`config: "worker.compatibility_date" in ${CONFIG_FILE} must be a string.`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date)) {
        throw new Error(
          `config: "worker.compatibility_date" in ${CONFIG_FILE} must use YYYY-MM-DD format.`,
        );
      }
    }
    if (w.compatibility_flags !== undefined) {
      if (
        !Array.isArray(w.compatibility_flags) ||
        !w.compatibility_flags.every((f) => typeof f === 'string')
      ) {
        throw new Error(
          `config: "worker.compatibility_flags" in ${CONFIG_FILE} must be an array of strings.`,
        );
      }
    }
    if (w.vars !== undefined) {
      if (typeof w.vars !== 'object' || w.vars === null || Array.isArray(w.vars)) {
        throw new Error(`config: "worker.vars" in ${CONFIG_FILE} must be an object.`);
      }
      for (const [key, value] of Object.entries(w.vars)) {
        if (typeof value !== 'string') {
          throw new Error(`config: "worker.vars.${key}" in ${CONFIG_FILE} must be a string.`);
        }
      }
    }
  }

  // Validate database
  if (obj.database !== undefined) {
    if (typeof obj.database !== 'string' || !VALID_DATABASE_VALUES.has(obj.database)) {
      throw new Error(`config: "database" in ${CONFIG_FILE} must be "pg".`);
    }
  }

  // Validate ai
  if (obj.ai !== undefined) {
    if (typeof obj.ai !== 'object' || obj.ai === null || Array.isArray(obj.ai)) {
      throw new Error(`config: "ai" in ${CONFIG_FILE} must be an object.`);
    }

    const aiCfg = obj.ai as Record<string, unknown>;
    for (const key of Object.keys(aiCfg)) {
      if (key !== 'gateway') {
        throw new Error(`config: Unknown key 'ai.${key}' in ${CONFIG_FILE}. Valid: gateway.`);
      }
    }

    if (
      aiCfg.gateway !== undefined &&
      (typeof aiCfg.gateway !== 'string' || aiCfg.gateway.length === 0)
    ) {
      throw new Error(`config: "ai.gateway" in ${CONFIG_FILE} must be a non-empty string.`);
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
 * Convert the `redirects` config field into `DevRedirectRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/old") and each value is either a string
 * destination (defaults to 302) or an object with `to` and optional `status`.
 * Returns undefined if the input is empty or undefined.
 */
export function convertRedirectsConfig(
  redirects: Record<string, RedirectDestination> | undefined,
): Array<DevRedirectRule> | undefined {
  if (!redirects) {
    return undefined;
  }

  const origin = 'void.json#routing.redirects';
  const rules: Array<DevRedirectRule> = [];
  for (const [rawSource, dest] of Object.entries(redirects)) {
    // `readConfig` already validated the source via `parseHostPrefixedSource`
    // and threw on errors, so the parse here is effectively re-extraction.
    // Defensive: callers that bypass `readConfig` (e.g. tests, programmatic
    // config) get the same parse path, and an error here surfaces as a
    // thrown exception for diagnosability.
    const parsed = parseHostPrefixedSource(rawSource);
    if ('error' in parsed) {
      throw new Error(`convertRedirectsConfig: source "${rawSource}": ${parsed.error}`);
    }
    const { host, path } = parsed;
    const base = { source: path, status: 302, origin, ...(host && { host }) };
    if (typeof dest === 'string') {
      rules.push({ ...base, destination: dest });
    } else {
      rules.push({ ...base, destination: dest.to, status: dest.status ?? 302 });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `rewrites` config field into `DevRedirectRule[]` with status 200.
 *
 * Each key is a URL pattern (e.g. "/docs") and each value is a destination path.
 * Rewrites serve content from the destination without changing the browser URL.
 * Emits `force: true` so these rules fire unconditionally, overriding any
 * matching static asset (Netlify-compat `200!` semantics). Returns undefined
 * if the input is empty or undefined.
 */
export function convertRewritesConfig(
  rewrites: Record<string, RewriteDestination> | undefined,
): Array<DevRedirectRule> | undefined {
  if (!rewrites) {
    return undefined;
  }

  const origin = 'void.json#routing.rewrites';
  const rules: Array<DevRedirectRule> = [];
  for (const [rawSource, destination] of Object.entries(rewrites)) {
    const parsed = parseHostPrefixedSource(rawSource);
    if ('error' in parsed) {
      throw new Error(`convertRewritesConfig: source "${rawSource}": ${parsed.error}`);
    }
    const { host, path } = parsed;
    rules.push({
      source: path,
      destination,
      status: 200,
      force: true,
      origin,
      ...(host && { host }),
    });
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `fallbacks` config field into `DevRedirectRule[]` with status 200.
 *
 * Fallbacks fire only when the static asset resolver would otherwise return
 * 404. They share the rewrite shape (status 200, pathname-only destination)
 * but are evaluated at a different pipeline phase — post-lookup instead of
 * pre-lookup. Emits `force: false` (Netlify-compat plain `200` semantics).
 * Returns undefined if the input is empty or undefined.
 */
export function convertFallbacksConfig(
  fallbacks: Record<string, RewriteDestination> | undefined,
): Array<DevRedirectRule> | undefined {
  if (!fallbacks) {
    return undefined;
  }

  const origin = 'void.json#routing.fallbacks';
  const rules: Array<DevRedirectRule> = [];
  for (const [rawSource, destination] of Object.entries(fallbacks)) {
    const parsed = parseHostPrefixedSource(rawSource);
    if ('error' in parsed) {
      throw new Error(`convertFallbacksConfig: source "${rawSource}": ${parsed.error}`);
    }
    const { host, path } = parsed;
    rules.push({
      source: path,
      destination,
      status: 200,
      force: false,
      origin,
      ...(host && { host }),
    });
  }

  return rules.length > 0 ? rules : undefined;
}
