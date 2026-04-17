import { relative } from 'node:path';
import { walk } from 'estree-walker';
import { parseSync, type Plugin } from 'vite';

interface EnvPublicModule {
  _getRegisteredSchema(): Record<string, unknown> | null;
  _hasRegisteredSchema(): boolean;
}

let cachedModule: EnvPublicModule | null = null;

async function loadEnvPublic(): Promise<EnvPublicModule> {
  if (cachedModule) {
    return cachedModule;
  }
  const mod = (await import('./runtime/env-public')) as unknown as EnvPublicModule;
  cachedModule = mod;
  return mod;
}

// Files we don't bother parsing — the AST walker would either fail or have
// nothing relevant to find. Anything else with a `void/env` import is fair
// game.
const SKIP_EXT =
  /\.(?:css|s[ac]ss|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm|mp[34]|webm|md|mdx)(?:\?|$)/;

const SCRIPT_LANG_RE = /[?&]lang\.([a-z0-9]+)/i;

/**
 * Quick check: does the source mention `void/env` at all? If not, skip the
 * full AST walk. Catches static imports, dynamic imports, and edge cases
 * like comments — false positives here just mean we parse a file we didn't
 * have to, never that we miss a real reference.
 */
function mentionsVoidEnv(code: string): boolean {
  return code.includes('void/env');
}

interface ImportBindings {
  /** Identifiers that are the `env` proxy directly (e.g. `import { env }` or `import { env as e }`). */
  directNames: Set<string>;
  /** Identifiers that are the namespace import (e.g. `import * as voidEnv`); reads look like `<name>.env.X`. */
  namespaceNames: Set<string>;
}

function extractEnvBindings(program: any): ImportBindings | null {
  const direct = new Set<string>();
  const namespace = new Set<string>();
  let found = false;

  for (const node of program.body as any[]) {
    if (node.type !== 'ImportDeclaration') {
      continue;
    }
    if (node.source?.value !== 'void/env') {
      continue;
    }
    found = true;
    for (const spec of node.specifiers ?? []) {
      if (spec.type === 'ImportSpecifier') {
        // import { env } or import { env as e }
        const importedName = spec.imported?.name;
        if (importedName === 'env') {
          direct.add(spec.local.name);
        }
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        // import * as voidEnv
        namespace.add(spec.local.name);
      } else if (spec.type === 'ImportDefaultSpecifier') {
        // void/env has no default export — ignore.
      }
    }
  }

  if (!found || (direct.size === 0 && namespace.size === 0)) {
    return null;
  }
  return { directNames: direct, namespaceNames: namespace };
}

interface OffsetIndex {
  /** Sorted array of byte offsets at which a new line starts (line N starts at lineStarts[N-1]). */
  lineStarts: number[];
}

function buildOffsetIndex(code: string): OffsetIndex {
  const lineStarts: number[] = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) {
      lineStarts.push(i + 1);
    }
  }
  return { lineStarts };
}

function offsetToLineCol(index: OffsetIndex, offset: number): { line: number; column: number } {
  // Binary search for the largest lineStarts[i] <= offset.
  const arr = index.lineStarts;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (arr[mid]! <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo + 1, column: offset - arr[lo]! + 1 };
}

interface Hit {
  kind: 'error' | 'warn';
  property: string | null;
  start: number;
}

/**
 * Walk the AST collecting every `env.X` (or `<ns>.env.X`) read where `env`
 * is bound to the `void/env` proxy. Computed access produces a warning hit
 * with `property === null`; everything else carries the property name.
 */
function findHits(program: any, bindings: ImportBindings): Hit[] {
  const hits: Hit[] = [];

  walk(program as any, {
    enter(node: any) {
      if (node.type !== 'MemberExpression') {
        return;
      }

      // Case 1: direct env.X — node.object is an Identifier in directNames.
      if (node.object?.type === 'Identifier' && bindings.directNames.has(node.object.name)) {
        recordHit(node, hits);
        return;
      }

      // Case 2: namespace.env.X — node.object is itself a MemberExpression
      // matching <namespaceName>.env.
      const obj = node.object;
      if (
        obj?.type === 'MemberExpression' &&
        !obj.computed &&
        obj.object?.type === 'Identifier' &&
        bindings.namespaceNames.has(obj.object.name) &&
        obj.property?.type === 'Identifier' &&
        obj.property.name === 'env'
      ) {
        recordHit(node, hits);
      }
    },
  });

  return hits;
}

function recordHit(node: any, hits: Hit[]): void {
  if (node.computed) {
    hits.push({ kind: 'warn', property: null, start: node.start });
    return;
  }
  if (node.property?.type !== 'Identifier') {
    return;
  }
  hits.push({ kind: 'error', property: node.property.name, start: node.start });
}

/**
 * Vite plugin that fails the client build when a server-only env key
 * (anything in `defineEnv` not prefixed with `VITE_`) is referenced from a
 * module that ends up in the client bundle. The runtime proxy in
 * `env-public-client.ts` already throws for the same class of bug at
 * request time — this plugin moves the diagnosis forward to compile time
 * so it shows up in `pnpm build` and the dev overlay, not in production
 * after an admin clicks the offending route.
 *
 * No-op when no `env.ts` is registered. Server / SSR / worker environments
 * are skipped — only the `client` environment is checked.
 */
/** Default value matches Vite's default `envPrefix`. */
const DEFAULT_ENV_PREFIXES = ['VITE_'] as const;

export function envClientGuardPlugin(root: string): Plugin {
  let envPrefixes: readonly string[] = DEFAULT_ENV_PREFIXES;

  return {
    name: 'void:env-client-guard',
    configResolved(config) {
      // Honour the user's `envPrefix` (string or string[]) so projects that
      // customise it — e.g. `envPrefix: 'PUBLIC_'` for SvelteKit-like setups
      // — don't get false-positive errors on their public keys.
      const prefix = config.envPrefix;
      if (typeof prefix === 'string') {
        envPrefixes = [prefix];
      } else if (Array.isArray(prefix) && prefix.length > 0) {
        envPrefixes = prefix;
      }
    },
    async transform(code, id) {
      // Only run on the client environment. SSR, worker, RSC etc. legitimately
      // read server keys via the same `void/env` import.
      if (this.environment?.name !== 'client') {
        return;
      }

      // Skip non-source files. Anything we'd want to parse is JS/TS or has a
      // script sub-resource (Vue/Svelte SFC virtual chunks include a
      // `lang.tsx` / `lang.ts` / `lang.js` query). Bail out cheaply for the
      // rest before the schema load.
      if (id.includes('/node_modules/')) {
        return;
      }
      if (SKIP_EXT.test(id)) {
        return;
      }

      // For SFC virtual modules with a `?vue&type=script&lang.ts` style query
      // (or analogous Svelte/Solid output), make sure we still cover them.
      // For other files, require a recognised JS/TS extension.
      const langMatch = SCRIPT_LANG_RE.exec(id);
      const isScriptQuery = langMatch !== null && /^(?:m?[jt]sx?|cjs)$/i.test(langMatch[1]!);
      const isPlainScript = /\.(?:[mc]?[jt]sx?)(?:\?|$)/.test(id);
      if (!isScriptQuery && !isPlainScript) {
        return;
      }

      // Fast path: if the source doesn't even mention `void/env`, the only
      // thing we'd find is nothing. The vast majority of files take this
      // branch — keeps overhead negligible on every transform.
      if (!mentionsVoidEnv(code)) {
        return;
      }

      // No env.ts in the project → nothing to enforce against.
      const { _hasRegisteredSchema, _getRegisteredSchema } = await loadEnvPublic();
      if (!_hasRegisteredSchema()) {
        return;
      }
      const schema = _getRegisteredSchema();
      if (!schema || Object.keys(schema).length === 0) {
        return;
      }

      let parsed: ReturnType<typeof parseSync>;
      try {
        parsed = parseSync(id, code);
      } catch {
        // If the file doesn't parse with the rolldown parser, leave it alone
        // — Vite's own pipeline will surface the syntax error.
        return;
      }

      const bindings = extractEnvBindings(parsed.program);
      if (!bindings) {
        return;
      }

      const hits = findHits(parsed.program, bindings);
      if (hits.length === 0) {
        return;
      }

      const offsets = buildOffsetIndex(code);
      const relPath = relative(root, id.split('?')[0]!) || id;

      for (const hit of hits) {
        const { line, column } = offsetToLineCol(offsets, hit.start);

        if (hit.kind === 'warn') {
          this.warn({
            message:
              `Computed access to "env[…]" at ${relPath}:${line}:${column} cannot be statically verified. ` +
              `If the key being read is server-only, this will throw at runtime in the browser. ` +
              `Prefer literal property access (env.VITE_FOO) so the build can check the split.`,
            loc: { line, column, file: id },
          });
          continue;
        }

        const key = hit.property!;
        // Unknown to the schema? Could be a CF binding or a typo — neither
        // is the guard's concern. The runtime proxy still catches misuse.
        if (!(key in schema)) {
          continue;
        }
        // Already exposed to the client by Vite's own envPrefix filter.
        if (envPrefixes.some((p) => key.startsWith(p))) {
          continue;
        }

        const prefixHint =
          envPrefixes.length === 1
            ? `${envPrefixes[0]}* prefix`
            : `one of these prefixes: ${envPrefixes.join(', ')}`;
        this.error({
          message:
            `Server-only env "${key}" referenced from client code at ${relPath}:${line}:${column}.\n` +
            `If this should be available in the browser, rename it with the ${prefixHint} in env.ts.\n` +
            `If it must stay server-only, remove this reference and read the value via a server route or loader.`,
          loc: { line, column, file: id },
        });
      }
    },
  };
}
