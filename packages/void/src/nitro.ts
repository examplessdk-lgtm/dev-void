import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathslash';
import { normalizePath, type Plugin } from 'vite';
import { bundleWorkerSqlDriver } from './cli/wrapper.ts';
import { getDatabaseDialect, readConfig } from './config.ts';
import { voidDbBundlerPlugin } from './plugin-drizzle.ts';

const envModuleFile = fileURLToPath(import.meta.resolve('#self/_env'));
// The package's built modules, where the env runtime and its AsyncLocalStorage live.
const packageDistDir = `${normalizePath(dirname(dirname(envModuleFile)))}/`;
const REQUEST_SCOPE_PLUGIN = '#void/nitro-request-scope';

/** The parts of a Nitro instance that the module uses. */
type NitroInstance = {
  options: {
    dev: boolean;
    rootDir: string;
    buildDir: string;
    exportConditions?: Array<string>;
    plugins: Array<string>;
    virtual: Record<string, string | (() => string | Promise<string>)>;
    rollupConfig?: { plugins?: unknown };
  };
};

/**
 * A Nitro runtime plugin that runs each request in Void's request scope, as the Class A wrapper
 * does, so void/db keeps one PostgreSQL or MySQL client per request instead of one per query.
 */
function requestScopePluginSource(): string {
  return `import { withRuntimeEnv } from ${JSON.stringify(envModuleFile)};

export default function voidRequestScope(nitroApp) {
  const handler = nitroApp.h3App.handler;
  // Nitro's Cloudflare entry and dev plugins keep the env here; a dev plugin may first set a
  // promise of it.
  nitroApp.h3App.handler = async (event) =>
    withRuntimeEnv(await globalThis.__env__, () => handler(event));
}
`;
}

/**
 * Keep Void's `node:async_hooks` imports for workerd's own module. Without nodejs_compat in a
 * Wrangler config that it reads, Nitro bundles a stub whose AsyncLocalStorage loses the request
 * scope at the first await.
 */
const nativeAsyncHooksPlugin: Plugin = {
  name: 'void:nitro-async-hooks',
  resolveId(id, importer) {
    if (
      id === 'node:async_hooks' &&
      importer !== undefined &&
      normalizePath(importer).startsWith(packageDistDir)
    ) {
      return { id, external: true };
    }
    return null;
  },
};

/**
 * Nitro module for apps whose server routes Nitro bundles (Nuxt and Analog). Nitro's bundler
 * does not run Vite plugins, so without this module `void/db` in a server route, page server
 * load or cron job is the package's D1 client without the app's schema. Register it in the
 * Nitro config: `modules: ['void/nitro']`.
 */
const voidNitroModule = {
  name: 'void',
  setup(nitro: NitroInstance): void {
    const { options } = nitro;
    const config = readConfig(options.rootDir);
    const dialect = getDatabaseDialect(config);
    // Development runs Nitro in Node, which loads the drivers itself.
    const workerd = !options.dev && options.exportConditions?.includes('workerd') === true;
    const plugins: Array<Plugin> = [
      voidDbBundlerPlugin(options.rootDir, {
        config,
        ...(workerd && {
          sqlDriver: (sqlDialect) =>
            bundleWorkerSqlDriver(sqlDialect, join(options.buildDir, 'void')),
        }),
      }),
    ];
    // D1 apps keep Nitro's requests as they are: in a request scope, void/db reads D1 through
    // a replica-capable session instead of the primary.
    if (dialect !== 'sqlite') {
      options.virtual[REQUEST_SCOPE_PLUGIN] = requestScopePluginSource();
      options.plugins.push(REQUEST_SCOPE_PLUGIN);
      if (workerd) {
        plugins.push(nativeAsyncHooksPlugin);
      }
    }
    const rollupConfig = (options.rollupConfig ??= {});
    const existing = rollupConfig.plugins;
    // Nitro adds its own resolvers after these, so `void/db` never reaches them.
    rollupConfig.plugins = [
      ...plugins,
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
    ];
  },
};

export default voidNitroModule;
