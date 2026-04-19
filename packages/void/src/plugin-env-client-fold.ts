import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { parseSync, type Plugin, type ResolvedConfig } from 'vite';

interface EnvPublicModule {
  _getRegisteredSchema(): Record<string, unknown> | null;
  _hasRegisteredSchema(): boolean;
  _getSchemaDefaults(): Record<string, string>;
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

// Mirror of the skip list used by the client-guard plugin. Anything that
// doesn't plausibly contain JS/TS source is cheap to bail out on.
const SKIP_EXT =
  /\.(?:css|s[ac]ss|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm|mp[34]|webm|md|mdx)(?:\?|$)/;
const SCRIPT_LANG_RE = /[?&]lang\.([a-z0-9]+)/i;

function mentionsVoidEnv(code: string): boolean {
  return code.includes('void/env');
}

interface ImportBindings {
  directNames: Set<string>;
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
        const importedName = spec.imported?.name;
        if (importedName === 'env') {
          direct.add(spec.local.name);
        }
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        namespace.add(spec.local.name);
      }
    }
  }

  if (!found || (direct.size === 0 && namespace.size === 0)) {
    return null;
  }
  return { directNames: direct, namespaceNames: namespace };
}

interface FoldHit {
  start: number;
  end: number;
  property: string;
}

/**
 * Walk the AST and collect every static `env.FOO` / `env["FOO"]` (or
 * `<ns>.env.FOO`) read. Dynamic keys (`env[variable]`) are intentionally
 * ignored — the Proxy still serves them at runtime, and we can't prove
 * they'd be folded the same way Vite folds `import.meta.env.FOO`.
 */
function findFoldHits(program: any, bindings: ImportBindings): FoldHit[] {
  const hits: FoldHit[] = [];

  walk(program as any, {
    enter(node: any) {
      if (node.type !== 'MemberExpression') {
        return;
      }

      // Direct `env.FOO` / `env["FOO"]`
      if (node.object?.type === 'Identifier' && bindings.directNames.has(node.object.name)) {
        pushHit(node, hits);
        return;
      }

      // Namespace: `voidEnv.env.FOO`. The outer MemberExpression is the read,
      // and `node.object` is itself the `voidEnv.env` MemberExpression.
      const obj = node.object;
      if (
        obj?.type === 'MemberExpression' &&
        !obj.computed &&
        obj.object?.type === 'Identifier' &&
        bindings.namespaceNames.has(obj.object.name) &&
        obj.property?.type === 'Identifier' &&
        obj.property.name === 'env'
      ) {
        pushHit(node, hits);
      }
    },
  });

  return hits;
}

function pushHit(node: any, hits: FoldHit[]): void {
  // Static dot access: `env.FOO`
  if (!node.computed && node.property?.type === 'Identifier') {
    hits.push({ start: node.start, end: node.end, property: node.property.name });
    return;
  }
  // Static bracket access with a string literal: `env["FOO"]`
  if (
    node.computed &&
    node.property?.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    hits.push({ start: node.start, end: node.end, property: node.property.value });
    return;
  }
  // Everything else (identifiers, template literals, etc.) falls through
  // to the runtime Proxy — not our problem.
}

/** Default Vite `envPrefix`. */
const DEFAULT_ENV_PREFIXES = ['VITE_'] as const;

/**
 * Build-time constant folding for client-only `env.FOO` reads.
 *
 * Purpose: match what Vite already does for `import.meta.env.FOO` so that
 * branches like `if (env.MODE === "production") { ... }` get dead-code
 * eliminated in production client bundles. The runtime `env` Proxy on the
 * client already resolves keys via `import.meta.env`, so *semantics* don't
 * change — we just move the lookup from runtime to build time, which
 * unlocks DCE and bundler minification of guarded blocks.
 *
 * Safety properties:
 *   • Runs only when `this.environment.name === 'client'`. Server / SSR /
 *     worker builds keep the full runtime Proxy (secrets, runtime-injected
 *     vars, HMR remain live).
 *   • Only folds keys that match the configured `envPrefix` — the exact
 *     set Vite is already willing to ship to the browser bundle. A
 *     server-only key is never folded (and the env-client-guard plugin
 *     would have errored out earlier anyway).
 *   • Only folds static member access: `env.FOO` and `env["FOO"]`.
 *     Dynamic access, destructuring, and reassignment fall through to the
 *     runtime Proxy.
 *   • Only folds keys with a known build-time value (loaded .env* merged
 *     with schema `.default(...)` entries). Unknown keys are left as-is
 *     and the Proxy handles them at runtime — no "undefined" shoved in.
 *   • Build-only (`apply: 'build'`). Dev runs through the Proxy so HMR
 *     and editing `.env.local` take effect without a full rebuild.
 */
export function envClientFoldPlugin(): Plugin {
  let envPrefixes: readonly string[] = DEFAULT_ENV_PREFIXES;
  let loadedEnv: Record<string, string> = {};
  const schemaDefaults: Record<string, string> = {};

  /** The merged view the transform consults for each key. */
  function resolveValue(key: string): string | undefined {
    if (key in loadedEnv) {
      return loadedEnv[key];
    }
    if (key in schemaDefaults) {
      return schemaDefaults[key];
    }
    return undefined;
  }

  function isExposedToClient(key: string): boolean {
    return envPrefixes.some((p) => key.startsWith(p));
  }

  return {
    name: 'void:env-client-fold',
    apply: 'build',
    // Run after SFC compilers (Svelte/Vue/Astro) so the `.svelte` / `.vue` /
    // `.astro` id arrives as compiled JS we can parse and fold. The inner
    // `transform.order: 'pre'` still runs this pass before Vite's
    // `import.meta.env` replacement pass, which is the only ordering we care
    // about for folding correctness.
    enforce: 'post',
    async configResolved(config: ResolvedConfig) {
      const prefix = config.envPrefix;
      if (typeof prefix === 'string') {
        envPrefixes = [prefix];
      } else if (Array.isArray(prefix) && prefix.length > 0) {
        envPrefixes = prefix;
      } else {
        envPrefixes = DEFAULT_ENV_PREFIXES;
      }

      // Vite has already resolved `.env*` + process.env into config.env,
      // filtered by the same envPrefix list. Reuse it so we match exactly
      // what Vite injects into `import.meta.env`.
      loadedEnv = { ...(config.env ?? {}) } as Record<string, string>;

      // Schema `.default(...)` values back-fill keys missing from .env*.
      // We only surface client-exposed ones so server-only defaults never
      // leak into the client bundle.
      try {
        const mod = await loadEnvPublic();
        if (mod._hasRegisteredSchema()) {
          const defaults = mod._getSchemaDefaults();
          for (const [key, value] of Object.entries(defaults)) {
            if (isExposedToClient(key) && !(key in loadedEnv)) {
              schemaDefaults[key] = value;
            }
          }
        }
      } catch {
        // If the schema module can't load here, we simply fold less. The
        // Proxy still handles unfoldable reads at runtime.
      }
    },
    async transform(code, id) {
      if (this.environment?.name !== 'client') {
        return;
      }
      if (id.includes('/node_modules/')) {
        return;
      }
      if (SKIP_EXT.test(id)) {
        return;
      }

      const langMatch = SCRIPT_LANG_RE.exec(id);
      const isScriptQuery = langMatch !== null && /^(?:m?[jt]sx?|cjs)$/i.test(langMatch[1]!);
      const isPlainScript = /\.(?:[mc]?[jt]sx?)(?:\?|$)/.test(id);
      const isSfc = /\.(?:svelte|vue|astro)(?:\?|$)/.test(id);
      if (!isScriptQuery && !isPlainScript && !isSfc) {
        return;
      }

      if (!mentionsVoidEnv(code)) {
        return;
      }

      // Nothing to fold against — bail out before parsing.
      if (Object.keys(loadedEnv).length === 0 && Object.keys(schemaDefaults).length === 0) {
        return;
      }

      let parsed: ReturnType<typeof parseSync>;
      try {
        parsed = parseSync(id, code);
      } catch {
        return;
      }

      const bindings = extractEnvBindings(parsed.program);
      if (!bindings) {
        return;
      }

      const hits = findFoldHits(parsed.program, bindings);
      if (hits.length === 0) {
        return;
      }

      let ms: MagicString | null = null;
      for (const hit of hits) {
        if (!isExposedToClient(hit.property)) {
          // Server-only key — let the client-guard plugin handle it.
          continue;
        }
        const value = resolveValue(hit.property);
        if (value === undefined) {
          // Client-exposed but no known build-time value — Proxy will
          // read it from `import.meta.env` at runtime.
          continue;
        }
        if (!ms) {
          ms = new MagicString(code);
        }
        ms.overwrite(hit.start, hit.end, JSON.stringify(value));
      }

      if (!ms) {
        return;
      }
      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: 'boundary' }),
      };
    },
  };
}
