import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'pathe';
import { type Plugin } from 'vite';
import { findEnvFile, generateEnvTypes } from './codegen/env-types';
import { voidLog, voidWarn } from './log';
import { filterLoadedEnv } from './shared/env';

interface RegisteredSchemaModule {
  _getRegisteredSchema(): Record<
    string,
    { '~standard': { validate: (v: unknown) => unknown } }
  > | null;
  validateAllEnv(values: Record<string, unknown>): {
    valid: boolean;
    missing: string[];
    invalid: { key: string; messages: string[] }[];
  };
}

let cachedSchemaModule: RegisteredSchemaModule | null = null;

async function loadSchemaModule(): Promise<RegisteredSchemaModule> {
  if (cachedSchemaModule) {
    return cachedSchemaModule;
  }
  const mod = (await import('./runtime/env-public')) as unknown as RegisteredSchemaModule;
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
export function envSchemaPlugin(root: string): Plugin {
  const outDir = join(root, '.void');
  let envFile: string | null = null;
  let viteMode = 'development';

  function regenerateTypes() {
    if (!envFile) {
      return;
    }
    mkdirSync(outDir, { recursive: true });
    const { dts } = generateEnvTypes(envFile, outDir);
    writeFileSync(join(outDir, 'env.d.ts'), dts);
  }

  async function importUserEnv() {
    if (!envFile) {
      return;
    }
    try {
      // Cache-bust on each import so HMR picks up edits.
      const url = pathToFileURL(envFile).href + `?t=${Date.now()}`;
      await import(/* @vite-ignore */ url);
    } catch (err) {
      voidWarn(`Failed to load ${envFile}: ${(err as Error).message}`);
    }
  }

  async function validateAndWarn() {
    if (!envFile) {
      return;
    }
    const { _getRegisteredSchema, validateAllEnv } = await loadSchemaModule();
    if (!_getRegisteredSchema()) {
      return;
    }
    const { loadEnv } = await import('vite');
    const merged = filterLoadedEnv(loadEnv(viteMode, root, ''));
    const report = validateAllEnv(merged as Record<string, unknown>);
    if (report.valid) {
      return;
    }
    const lines: string[] = ['Env validation issues:'];
    for (const key of report.missing) {
      lines.push(`  • ${key} is required but missing — add it to .env.local or set in your shell`);
    }
    for (const { key, messages } of report.invalid) {
      lines.push(`  • ${key}: ${messages.join('; ')}`);
    }
    voidWarn(lines.join('\n'));
  }

  return {
    name: 'void:env-schema',
    async config() {
      envFile = findEnvFile(root);
      if (!envFile) {
        return;
      }
      regenerateTypes();
    },
    async configResolved(config) {
      viteMode = config.mode;
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
          await validateAndWarn();
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
