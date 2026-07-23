import { mkdirSync } from 'node:fs';
import { join } from 'pathslash';
import { type Plugin, type ResolvedConfig } from 'vite';
import { findEnvFile, generateEnvTypes } from './codegen/env-types.ts';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import { loadUserEnvFile } from './host/load-user-env.ts';
import { voidLog, voidWarn } from './log.ts';
import { filterLoadedEnv } from './shared/env.ts';

type RegisteredSchemaModule = {
  _getRegisteredSchema(): Record<
    string,
    { '~standard': { validate: (v: unknown) => unknown } }
  > | null;
  _hasRegisteredSchema(): boolean;
  _getSchemaDefaults(): Record<string, string>;
  validateAllEnv(values: Record<string, unknown>): Promise<{
    valid: boolean;
    missing: Array<string>;
    invalid: Array<{ key: string; messages: Array<string> }>;
  }>;
};

export type EnvSchemaPluginOptions = {
  /**
   * Called with the schema's `.default(value)` entries (stringified) so the
   * caller can seed worker bindings, deploy manifest vars, or any other env
   * sink. Invoked after the user's `env.ts` has been imported so the
   * registered schema is up-to-date. User-provided values in `.env*` /
   * shell env should take precedence — the caller is responsible for
   * "skip if already set" semantics.
   */
  onDefaults?: (defaults: Record<string, string>) => void;
};

let cachedSchemaModule: RegisteredSchemaModule | null = null;

async function loadSchemaModule(): Promise<RegisteredSchemaModule> {
  if (cachedSchemaModule) {
    return cachedSchemaModule;
  }
  const mod = (await import('./runtime/env-public.ts')) as unknown as RegisteredSchemaModule;
  cachedSchemaModule = mod;
  return mod;
}

/**
 * Vite plugin that auto-discovers `env.ts` at the project root and:
 *   - imports it (registering the user's schema via `defineEnv`)
 *   - generates `.void/env.d.ts` so `env.X` and `c.env.X` are typed
 *   - validates the merged dev env (.env files + process.env) and warns
 *     on missing/invalid required keys
 *   - regenerates types + re-validates when env.ts changes (HMR)
 *
 * Hard errors are reserved for `void deploy`; dev keeps moving with warnings
 * so unrelated work isn't blocked by a stale .env.local.
 */
/** Patterns Vite's `define` typically uses for env-shaped constants. */
const DEFINE_ENV_PATTERN =
  /^(?:globalThis\.)?(?:process\.env|import\.meta\.env)\.([A-Z_][A-Z0-9_]*)$/;
const DEFAULT_ENV_PREFIXES: ReadonlyArray<string> = ['VITE_'];

function resolveEnvPrefixes(prefix: ResolvedConfig['envPrefix']): ReadonlyArray<string> {
  if (typeof prefix === 'string') {
    return [prefix];
  }
  if (Array.isArray(prefix) && prefix.length > 0) {
    return prefix;
  }
  return DEFAULT_ENV_PREFIXES;
}

export function envSchemaPlugin(root: string, options: EnvSchemaPluginOptions = {}): Plugin {
  const outDir = join(root, '.void');
  let envFile: string | null = null;
  let viteMode = 'development';
  let envDir = root;
  const appliedClientDefaults = new Map<string, string>();

  async function emitDefaults() {
    if (!envFile || !options.onDefaults) {
      return;
    }
    const { _hasRegisteredSchema, _getSchemaDefaults } = await loadSchemaModule();
    if (!_hasRegisteredSchema()) {
      return;
    }
    options.onDefaults(_getSchemaDefaults());
  }

  function regenerateTypes() {
    if (!envFile) {
      return;
    }
    mkdirSync(outDir, { recursive: true });
    const { dts } = generateEnvTypes(envFile, outDir);
    writeFileIfChanged(join(outDir, 'env.d.ts'), dts);
  }

  async function importUserEnv() {
    if (!envFile) {
      return;
    }
    try {
      await loadUserEnvFile(envFile);
    } catch (err) {
      voidWarn((err as Error).message);
    }
  }

  async function warnOnDefineOverlap(define: Record<string, unknown>): Promise<void> {
    const { _hasRegisteredSchema, _getRegisteredSchema } = await loadSchemaModule();
    if (!_hasRegisteredSchema()) {
      return;
    }
    const schema = _getRegisteredSchema();
    if (!schema) {
      return;
    }
    const overlaps: Array<{ defineKey: string; schemaKey: string }> = [];
    for (const defineKey of Object.keys(define)) {
      const match = DEFINE_ENV_PATTERN.exec(defineKey);
      if (!match) {
        continue;
      }
      const name = match[1]!;
      if (name in schema) {
        overlaps.push({ defineKey, schemaKey: name });
      }
    }
    if (overlaps.length === 0) {
      return;
    }
    const lines = ['Vite `define` is shadowing schema env keys:'];
    for (const { defineKey, schemaKey } of overlaps) {
      lines.push(
        `  • "${defineKey}" → schema key "${schemaKey}". ` +
          `The compiled client code receives the define value, but the typed env.X proxy and validation still source from the schema. Prefer one or the other for any given key.`,
      );
    }
    voidWarn(lines.join('\n'));
  }

  async function validateAndWarn() {
    if (!envFile) {
      return;
    }
    const { _hasRegisteredSchema, validateAllEnv } = await loadSchemaModule();
    if (!_hasRegisteredSchema()) {
      return;
    }
    const { loadEnv } = await import('vite');
    const merged = filterLoadedEnv(loadEnv(viteMode, envDir, ''));
    const report = await validateAllEnv(merged as Record<string, unknown>);
    if (report.valid) {
      return;
    }
    const lines: Array<string> = ['Env validation issues:'];
    for (const key of report.missing) {
      lines.push(`  • ${key} is required but missing — add it to .env.local or set in your shell`);
    }
    for (const { key, messages } of report.invalid) {
      lines.push(`  • ${key}: ${messages.join('; ')}`);
    }
    voidWarn(lines.join('\n'));
  }

  async function applyClientDefaultsToViteEnv(config: ResolvedConfig) {
    if (!envFile) {
      return;
    }

    for (const [key, value] of appliedClientDefaults) {
      if (config.env[key] === value) {
        delete config.env[key];
      }
    }
    appliedClientDefaults.clear();

    const { _hasRegisteredSchema, _getSchemaDefaults } = await loadSchemaModule();
    if (!_hasRegisteredSchema()) {
      return;
    }

    const prefixes = resolveEnvPrefixes(config.envPrefix);
    for (const [key, value] of Object.entries(_getSchemaDefaults())) {
      if (!prefixes.some((prefix) => key.startsWith(prefix))) {
        continue;
      }
      if (config.env[key] !== undefined) {
        continue;
      }
      config.env[key] = value;
      appliedClientDefaults.set(key, value);
    }
  }

  return {
    name: 'void:env-schema',
    async config() {
      envFile = findEnvFile(root);
      if (!envFile) {
        return;
      }
      regenerateTypes();
      // Import env.ts at config time so onDefaults can fire before the
      // Cloudflare plugin's mergeBindings reads workerConfig.vars.
      await importUserEnv();
      await emitDefaults();
    },
    async configResolved(config) {
      viteMode = config.mode;
      // `envDir: false` disables Vite's .env loading entirely — fall back to
      // root so our own validate-against-merged-env still picks up shell vars.
      envDir = typeof config.envDir === 'string' ? config.envDir : root;
      await applyClientDefaultsToViteEnv(config);
      // Warn when vite `define` shadows a schema key. The two systems coexist
      // — define replaces source literals at build time; defineEnv types and
      // validates the runtime env — but using both for the same name causes
      // silent skew (client sees the define value, server sees .env / schema).
      if (envFile && config.define) {
        await warnOnDefineOverlap(config.define as Record<string, unknown>);
      }
    },
    async configureServer(server) {
      if (!envFile) {
        return;
      }
      await importUserEnv();
      // Defer validation until after the server prints "ready".
      const run = () => {
        void validateAndWarn();
      };
      if (server.httpServer) {
        server.httpServer.once('listening', () => setTimeout(run, 100));
      } else {
        run();
      }
      server.watcher.add(envFile);
      server.watcher.on('change', async (file) => {
        if (file === envFile) {
          voidLog('env.ts changed — regenerating types');
          regenerateTypes();
          await importUserEnv();
          await emitDefaults();
          await applyClientDefaultsToViteEnv(server.config);
          await validateAndWarn();
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
    async buildStart() {
      // For non-dev (build, prerender), still load the schema so it's
      // available to subsequent plugins / codegen consumers.
      if (envFile) {
        await importUserEnv();
      }
    },
  };
}
