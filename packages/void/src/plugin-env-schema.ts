import { mkdirSync } from 'node:fs';
import { join } from 'pathslash';
import { type Plugin, type ResolvedConfig } from 'vite';
import { findEnvFile, generateEnvTypes } from './codegen/env-types.ts';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import { loadUserEnvFile } from './host/load-user-env.ts';
import { voidLog, voidWarn } from './log.ts';
import { afterServerReady } from './plugin-dev-config.ts';
import { loadEnvPublic } from './plugin-env-client-guard.ts';
import { findLegacyEnvFiles, isClientEnvKey, loadLocalEnv } from './shared/env.ts';

export type EnvSchemaPluginOptions = {
  /**
   * Called after env.ts is imported with the structural facts needed to
   * configure production bindings. Values never cross this callback.
   */
  onSchema?: (facts: EnvSchemaFacts) => void;
};

export type EnvSchemaFacts = {
  keys: Array<string>;
  clientKeys: Array<string>;
  serverKeys: Array<string>;
  requiredServerKeys: Array<string>;
};

/** Patterns Vite's `define` typically uses for env-shaped constants. */
const DEFINE_ENV_PATTERN =
  /^(?:globalThis\.)?(?:process\.env|import\.meta\.env)\.([A-Z_][A-Z0-9_]*)$/;

/**
 * Vite plugin that auto-discovers `env.ts` at the project root and:
 *   - imports it (registering the user's schema via `defineEnv`)
 *   - generates `.void/env.d.ts` so `env.X` and `c.env.X` are typed
 *   - validates the local dev env (`.env` + process.env) and warns
 *     on missing/invalid required keys
 *   - regenerates types + re-validates when env.ts changes (HMR)
 *
 * Hard errors are reserved for builds and deploys; dev keeps moving with warnings
 * so unrelated work isn't blocked by a stale local value.
 */
export function envSchemaPlugin(root: string, options: EnvSchemaPluginOptions = {}): Plugin {
  const outDir = join(root, '.void');
  let envFile: string | null = null;
  let command: 'serve' | 'build' = 'serve';
  const appliedClientDefaults = new Map<string, string>();

  async function emitSchemaFacts() {
    if (!envFile || !options.onSchema) {
      return;
    }
    const { _hasRegisteredSchema, _getRegisteredSchema } = await loadEnvPublic();
    if (!_hasRegisteredSchema()) {
      return;
    }
    const schema = _getRegisteredSchema() ?? {};
    const keys = Object.keys(schema);
    const clientKeys = keys.filter(isClientEnvKey);
    const clientKeySet = new Set(clientKeys);
    const serverKeys = keys.filter((key) => !clientKeySet.has(key));
    const requiredServerKeys: Array<string> = [];
    for (const key of serverKeys) {
      const result = schema[key]!['~standard'].validate(undefined);
      const resolved = result instanceof Promise ? await result : result;
      if (resolved.issues) {
        requiredServerKeys.push(key);
      }
    }
    options.onSchema({ keys, clientKeys, serverKeys, requiredServerKeys });
  }

  function regenerateTypes() {
    if (!envFile) {
      return;
    }
    mkdirSync(outDir, { recursive: true });
    const { dts } = generateEnvTypes(envFile, outDir);
    writeFileIfChanged(join(outDir, 'env.d.ts'), dts);
  }

  async function importUserEnv(strict = false) {
    if (!envFile) {
      return;
    }
    try {
      await loadUserEnvFile(envFile);
    } catch (err) {
      if (strict) {
        throw err;
      }
      voidWarn((err as Error).message);
    }
  }

  async function warnOnDefineOverlap(define: Record<string, unknown>): Promise<void> {
    const { _hasRegisteredSchema, _getRegisteredSchema } = await loadEnvPublic();
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
    const { _hasRegisteredSchema, validateAllEnv } = await loadEnvPublic();
    if (!_hasRegisteredSchema()) {
      return;
    }
    const local = loadLocalEnv(root, { onWarn: (message) => voidWarn(message) });
    const report = await validateAllEnv({ ...local, ...process.env });
    if (report.valid) {
      return;
    }
    const lines: Array<string> = ['Env validation issues:'];
    for (const key of report.missing) {
      lines.push(`  • ${key} is required but missing — add it to .env or set it in your shell`);
    }
    for (const { key, messages } of report.invalid) {
      lines.push(`  • ${key}: ${messages.join('; ')}`);
    }
    voidWarn(lines.join('\n'));
  }

  async function applyClientValuesToViteEnv(config: ResolvedConfig) {
    if (!envFile) {
      return;
    }
    const configEnv = config.env ?? {};

    for (const [key, value] of appliedClientDefaults) {
      if (configEnv[key] === value) {
        delete configEnv[key];
      }
    }
    appliedClientDefaults.clear();

    const { _hasRegisteredSchema, _getRegisteredSchema, _getSchemaDefaults } =
      await loadEnvPublic();
    if (!_hasRegisteredSchema()) {
      return;
    }

    const schema = _getRegisteredSchema() ?? {};
    const local = command === 'serve' ? loadLocalEnv(root) : {};
    const readable = { ...local, ...process.env };
    for (const key of Object.keys(schema)) {
      if (!isClientEnvKey(key) || configEnv[key] !== undefined) {
        continue;
      }
      const value = readable[key];
      if (value !== undefined) {
        configEnv[key] = value;
      }
    }

    for (const [key, value] of Object.entries(_getSchemaDefaults())) {
      if (!isClientEnvKey(key) || configEnv[key] !== undefined) {
        continue;
      }
      configEnv[key] = value;
      appliedClientDefaults.set(key, value);
    }
  }

  return {
    name: 'void:env-schema',
    enforce: 'pre',
    async config(_config, environment) {
      const legacyFiles = findLegacyEnvFiles(root);
      if (legacyFiles.length > 0) {
        throw new Error(
          `void/env supports one local file: .env. Remove ${legacyFiles.join(', ')} and follow the env migration guide.`,
        );
      }
      envFile = findEnvFile(root);
      if (!envFile) {
        return;
      }
      regenerateTypes();
      // Import env.ts at config time so onSchema can configure required
      // secrets before the Cloudflare plugin resolves worker bindings.
      await importUserEnv(environment.command === 'build');
      await emitSchemaFacts();
    },
    async configResolved(config) {
      command = config.command;
      await emitSchemaFacts();

      // `.env` is local-only. Vite loads it during production builds by
      // default, so remove file-sourced client values before its replacement
      // pass. CI/shell values remain available, and schema defaults are added
      // immediately below.
      if (command === 'build') {
        const local = loadLocalEnv(root, { onWarn: (message) => voidWarn(message) });
        for (const [key, value] of Object.entries(local)) {
          if (process.env[key] === undefined && config.env[key] === value) {
            delete config.env[key];
          }
        }
      }
      await applyClientValuesToViteEnv(config);

      if (command === 'build' && envFile) {
        const { validateAllEnv } = await loadEnvPublic();
        const report = await validateAllEnv({ ...config.env, ...process.env });
        const missing = report.missing.filter(isClientEnvKey);
        const invalid = report.invalid.filter(({ key }) => isClientEnvKey(key));
        if (missing.length > 0 || invalid.length > 0) {
          const lines = ['Client env validation failed:'];
          for (const key of missing) {
            lines.push(
              `  • ${key} is required — set it in the build shell or add a schema default`,
            );
          }
          for (const { key, messages } of invalid) {
            lines.push(`  • ${key}: ${messages.join('; ')}`);
          }
          throw new Error(lines.join('\n'));
        }
      }
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
      afterServerReady(server, () => {
        void validateAndWarn();
      });
      server.watcher.add(envFile);
      server.watcher.on('change', async (file) => {
        if (file === envFile) {
          voidLog('env.ts changed — regenerating types');
          regenerateTypes();
          await importUserEnv();
          await emitSchemaFacts();
          await applyClientValuesToViteEnv(server.config);
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
