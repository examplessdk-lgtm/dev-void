import { fileURLToPath } from 'node:url';
import { type Plugin } from 'vite';
import { ensureWranglerCompat } from './cli/wrangler.ts';
import { readConfig, isNodeTarget } from './config.ts';

const CLOUDFLARE_BUILTIN_IMPORT = /^cloudflare:/;

const SANDBOX_SDK_IMPORT = '@cloudflare/sandbox';

const SANDBOX_SDK_IMPORT_FILTER = /^@cloudflare\/sandbox$/;

export const DEFAULT_WORKER_ENVIRONMENT_NAME = 'void_worker';

const DEFAULT_WORKER_OUT_DIR = 'dist/ssr';

export const DEV_ASSET_ROUTING_EXCLUSIONS: Array<string> = [
  '!/@vite/*',
  '!/@id/*',
  '!/@fs/*',
  '!/@react-refresh',
  '!/@svelte/*',
  '!/node_modules/*',
  '!/__uno.css',
];

function resolveSandboxSdkEntry(): string {
  return fileURLToPath(import.meta.resolve(SANDBOX_SDK_IMPORT));
}

export function createCloudflareBuiltinsExternalPlugin(): Plugin {
  return {
    name: 'void:cloudflare-builtins-external',
    config(_, env) {
      if (env.command !== 'build') {
        return;
      }

      return {
        build: {
          rollupOptions: {
            external: [CLOUDFLARE_BUILTIN_IMPORT],
          },
        },
      };
    },
  };
}

export function createDefaultWorkerEnvironmentPlugin(): Plugin {
  return {
    name: 'void:default-worker-environment',
    config(config) {
      const currentEnvironment = config.environments?.[DEFAULT_WORKER_ENVIRONMENT_NAME];
      return {
        environments: {
          [DEFAULT_WORKER_ENVIRONMENT_NAME]: {
            ...currentEnvironment,
            build: {
              ...currentEnvironment?.build,
              outDir: currentEnvironment?.build?.outDir ?? DEFAULT_WORKER_OUT_DIR,
            },
          },
        },
      };
    },
  };
}

export function createWorkerEnvironmentSanitizerPlugin(
  environmentNames: ReadonlyArray<string>,
): Plugin {
  const names = new Set(environmentNames);
  return {
    name: 'void:worker-environment-sanitizer',
    enforce: 'pre',
    configResolved(config) {
      for (const name of names) {
        const resolve = config.environments[name]?.resolve;
        if (resolve && 'external' in resolve) {
          // Test runners may seed Node externals into every Vite environment.
          // Cloudflare Worker environments cannot externalize dependencies, but
          // Cloudflare's validator expects the normalized array shape to remain.
          resolve.external = [];
        }
      }
    },
  };
}

export function createSandboxSdkResolvePlugin(): Plugin {
  let resolved: string | undefined;

  return {
    name: 'void:sandbox-sdk-resolve',
    enforce: 'pre',
    resolveId: {
      filter: { id: SANDBOX_SDK_IMPORT_FILTER },
      handler(id) {
        if (id !== SANDBOX_SDK_IMPORT) {
          return;
        }
        resolved ??= resolveSandboxSdkEntry();
        return resolved;
      },
    },
  };
}

export function createWranglerCompatPersistPlugin(
  root: string,
  config: ReturnType<typeof readConfig>,
): Plugin {
  let persisted = false;
  const persist = () => {
    if (persisted || isNodeTarget(config.target)) {
      return;
    }
    persisted = true;
    ensureWranglerCompat(root, config);
  };

  return {
    name: 'void:wrangler-compat-persist',
    buildStart() {
      persist();
    },
    configureServer() {
      persist();
    },
  };
}

export function createServerRuntimeOptimizerPlugin(voidOwnsWorkerRuntime: boolean): Plugin {
  const serverRuntimeOptimizerPlugin: Plugin = {
    name: 'void:server-runtime-optimizer',
    configEnvironment(name) {
      if (name === 'client') {
        return;
      }
      if (!voidOwnsWorkerRuntime) {
        return { optimizeDeps: { exclude: ['void'] } };
      }
      return {
        optimizeDeps: {
          exclude: ['void'],
          // Excluding void also skips converting its CommonJS dependencies, which workerd cannot
          // evaluate: an installed void/email fails with "exports is not defined". Runtimes a
          // framework owns stay untouched; Node loads CommonJS itself, and forcing an include
          // there turns on SSR prebundling the framework did not ask for.
          include: ['void > email-validator'],
        },
      };
    },
  };

  return serverRuntimeOptimizerPlugin;
}
