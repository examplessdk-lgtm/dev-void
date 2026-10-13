import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'pathslash';
import { defaultServerConditions, type Plugin } from 'vite';
import { type ApplicationAnalysis } from './application-analysis.ts';
import {
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  readWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  type WranglerCompat,
} from './cli/wrangler.ts';
import { readConfig } from './config.ts';
import { resolveLocalD1Target } from './local-d1.ts';
import { voidLog } from './log.ts';
import { bindingRuntimePlugin } from './plugin-binding-runtime.ts';
import { devTriggerSecretGuardPlugin } from './plugin-dev-config.ts';
import { devTriggersHintPlugin } from './plugin-dev-triggers-hint.ts';
import { drizzlePlugin } from './plugin-drizzle.ts';
import { envClientFoldPlugin } from './plugin-env-client-fold.ts';
import { envClientGuardPlugin } from './plugin-env-client-guard.ts';
import { envSchemaPlugin } from './plugin-env-schema.ts';
import {
  analogDevTriggerInjectPlugin,
  astroDevTriggerInjectPlugin,
  frameworkTriggersDispatchPath,
  frameworkTriggersPlugin,
  nitroDevTriggerInjectPlugin,
} from './plugin-framework-triggers.ts';
import { migrationPlugin } from './plugin-migration.ts';
import { createCloudflareBuiltinsExternalPlugin } from './plugin-worker-environment.ts';
import { injectSvelteKitBuildHooks, injectSvelteKitHooks } from './sveltekit-hooks-transform.ts';

const handlerFile = fileURLToPath(import.meta.resolve('#self/handler'));
const envModuleFile = fileURLToPath(import.meta.resolve('#self/_env'));

const ASTRO_SERVER_ENTRY = '@astrojs/cloudflare/entrypoints/server';
const ASTRO_SCOPED_SERVER_ENTRY = '\0void:astro-server-entry';

const NODE_BUILTIN = new RegExp(`^(?:node:)?(?:${builtinModules.join('|')})$`);
const NODE_BUILTIN_REQUIRE_PREFIX = '\0void:node-require:';

/**
 * The Node built-ins that workerd provides for the given compatibility settings, from the preset
 * the Cloudflare plugin builds Workers with (a dependency of `@cloudflare/vite-plugin`). Before
 * 2025-09-15 the preset fills in parts of `node:process` instead of listing it, but workerd
 * provides that module at every date.
 */
async function readWorkerdNodeBuiltins(compat: WranglerCompat): Promise<Set<string>> {
  const vitePlugin = fileURLToPath(import.meta.resolve('@cloudflare/vite-plugin'));
  const manifestPath = createRequire(vitePlugin).resolve('@cloudflare/unenv-preset/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports: { '.': { import: string } };
  };
  const { getCloudflarePreset } = (await import(
    pathToFileURL(join(dirname(manifestPath), manifest.exports['.'].import)).href
  )) as {
    getCloudflarePreset(compat: { compatibilityDate: string; compatibilityFlags: Array<string> }): {
      external: Array<string>;
    };
  };
  const { external } = getCloudflarePreset({
    compatibilityDate: compat.compatibilityDate,
    compatibilityFlags: compat.compatibilityFlags ?? [],
  });
  return new Set([...external.map((name) => name.replace(/^node:/, '')), 'process']);
}

export function createFrameworkPlugins(input: {
  readonly localD1: ReturnType<typeof resolveLocalD1Target>;
  readonly root: string;
  readonly directCloudflareDestination: boolean;
  readonly bindings: ApplicationAnalysis['bindings'];
  readonly config: ReturnType<typeof readConfig>;
  readonly dialect: ApplicationAnalysis['dialect'];
  readonly application: ApplicationAnalysis;
  readonly bindingNames: ApplicationAnalysis['bindingNames'];
  readonly websocketRoutes: ApplicationAnalysis['allWebsockets'];
  readonly liveConfig: ReturnType<typeof resolveLiveBindingConfig> | undefined;
  readonly detected: NonNullable<ApplicationAnalysis['framework']>;
  readonly clientStubsPlugin: Plugin;
  readonly serverRuntimeOptimizerPlugin: Plugin;
  readonly devTriggerToken: string;
  readonly implicitDeployGuard: Plugin;
}): Array<Plugin> {
  const {
    localD1,
    root,
    directCloudflareDestination,
    bindings,
    config,
    dialect,
    application,
    bindingNames,
    websocketRoutes,
    liveConfig,
    detected,
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    devTriggerToken,
    implicitDeployGuard,
  } = input;
  const frameworkPersistRoot = localD1.persistRoot;
  const syncFrameworkCompat = (compat: ReturnType<typeof readWranglerCompat>) => {
    const syncedDate = ensureWranglerCompatibilityDate(root, compat.compatibilityDate);
    if (syncedDate) {
      voidLog('Synced compatibility_date to Cloudflare config');
    }
  };

  // Ensure required compat flags are written before framework adapters
  // initialize Cloudflare dev runtime / Miniflare.
  const wranglerCompatPlugin: Plugin = {
    name: 'void:wrangler-compat',
    enforce: 'pre',
    config(_, env) {
      if (env.command === 'serve' && directCloudflareDestination && bindings.needsAI) {
        process.env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
      }
      syncFrameworkCompat(ensureWranglerCompat(root, config));
      if (env.command !== 'serve') {
        return;
      }
      const synced = ensureWranglerNodejsAlsFlag(root);
      if (synced) {
        voidLog('Synced nodejs_als to Cloudflare config');
      }
    },
    buildStart() {
      syncFrameworkCompat(ensureWranglerCompat(root, config));
    },
    configureServer() {
      syncFrameworkCompat(ensureWranglerCompat(root, config));
    },
  };

  // Sync before framework adapters read Wrangler during Vite configuration.
  // Repeat at configResolved for adapters that create the file later.
  const syncFrameworkBindings = (command: string): void => {
    if (command !== 'serve') {
      return;
    }
    const synced = syncWranglerBindings(
      root,
      {
        ...bindings,
        needsD1: dialect === 'sqlite' && application.needsDatabase,
      },
      {
        bindingNames,
        ...(directCloudflareDestination && bindings.needsAI
          ? { directCloudflareAi: { gateway: config.ai?.gateway } }
          : {}),
        websockets: websocketRoutes,
        live: liveConfig,
      },
    );
    if (synced) {
      voidLog('Synced bindings to Cloudflare config');
    }
  };

  const wranglerSyncPlugin: Plugin = {
    name: 'void:wrangler-sync',
    enforce: 'pre',
    config(_, env) {
      syncFrameworkBindings(env.command);
    },
    configResolved(resolvedConfig) {
      syncFrameworkCompat(readWranglerCompat(root, config));
      syncFrameworkBindings(resolvedConfig.command);
    },
  };

  // Nuxt's SSR Vite server can inherit the client HTTP server while also
  // receiving its own HMR port. That attaches two upgrade handlers to the
  // same socket under current Vite, so keep the SSR transport on its
  // dedicated port. Update both keys for Vite 7 and Vite 8 compatibility.
  const nuxtVite8WebSocketCompatPlugin: Plugin | undefined =
    detected.name === 'nuxt'
      ? {
          name: 'void:nuxt-vite8-websocket-compat',
          enforce: 'post',
          configResolved(resolvedConfig) {
            if (!resolvedConfig.build.ssr) {
              return;
            }
            if (
              typeof resolvedConfig.server.hmr === 'object' &&
              resolvedConfig.server.hmr.port !== undefined
            ) {
              resolvedConfig.server.hmr = {
                ...resolvedConfig.server.hmr,
                server: undefined,
              };
            }
            if (
              typeof resolvedConfig.server.ws === 'object' &&
              resolvedConfig.server.ws.port !== undefined
            ) {
              resolvedConfig.server.ws = {
                ...resolvedConfig.server.ws,
                server: undefined,
              };
            }
          },
        }
      : undefined;

  // SvelteKit hooks injection: transform get_hooks() to wrap `handle` with
  // withRuntimeEnv(adapter env, ...). Kit 2 passes event.platform.env;
  // Kit 3 exposes cloudflare:workers. This stores the env in
  // AsyncLocalStorage so void/db resolves it via envContext.getStore(), and
  // intercepts /__void/scheduled and /__void/queue so cron and queue
  // handlers run with the framework adapter's real bindings.
  // Single Miniflare instance (adapter-cloudflare's), no private APIs.
  const svelteKitHooksInjectPlugin: Plugin = {
    name: 'void:sveltekit-hooks-inject',
    apply: 'serve',
    config() {
      if (detected.class !== 'b') {
        return;
      }
      // Kit's dev server runs server code in Vite's Node SSR graph. That graph
      // externalizes a bare import resolving into node_modules before any plugin
      // sees it, so an installed void/db would load the package's D1 runtime
      // instead of the virtual module. Inlining keeps every void import, including
      // the injected env import below, in the graph that holds void/db's env module.
      return { ssr: { noExternal: ['void'] } };
    },
    resolveId: {
      order: 'pre',
      filter: { id: /^void$/ },
      handler() {
        if (detected.class !== 'b' || this.environment?.name === 'client') {
          return;
        }
        // Inlined, the package entry would load the whole Vite plugin into Kit's module
        // runner. Server code gets the lightweight handler subpath, as in Void apps.
        return handlerFile;
      },
    },
    transform(code, id) {
      if (detected.class !== 'b') {
        return;
      }
      if (
        !id.includes('.svelte-kit/generated/server/internal') &&
        !id.includes('.svelte-kit/generated/dev/server.js')
      ) {
        return;
      }
      return injectSvelteKitHooks(code, id, frameworkTriggersDispatchPath(root));
    },
  };

  // Astro's Cloudflare adapter owns the Worker entry. For PostgreSQL and MySQL, its default
  // entry runs each request inside Void's request scope (`withRuntimeEnv`), as the Class A
  // wrapper does, so void/db keeps one client per request instead of one per query. D1 apps
  // keep Astro's own entry: in a request scope, void/db reads D1 through a replica-capable
  // session instead of the primary.
  const astroRequestScopePlugin: Plugin | undefined =
    detected.name === 'astro' && dialect !== 'sqlite'
      ? {
          name: 'void:astro-request-scope',
          enforce: 'pre',
          resolveId: {
            filter: { id: /^@astrojs\/cloudflare\/entrypoints\/server(?:\.js)?$/ },
            handler(_id, importer) {
              if (importer === ASTRO_SCOPED_SERVER_ENTRY || this.environment?.name === 'client') {
                return;
              }
              return ASTRO_SCOPED_SERVER_ENTRY;
            },
          },
          load: {
            // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
            filter: { id: /^\0void:astro-server-entry$/ },
            handler() {
              return `import original from ${JSON.stringify(ASTRO_SERVER_ENTRY)};
import { withRuntimeEnv } from ${JSON.stringify(envModuleFile)};
export * from ${JSON.stringify(ASTRO_SERVER_ENTRY)};

export default {
  ...original,
  fetch(request, env, ctx) {
    return withRuntimeEnv(env, () => original.fetch(request, env, ctx));
  },
};
`;
            },
          },
        }
      : undefined;

  // SvelteKit builds its server in Vite's Node `ssr` environment, and the adapter's Worker runs
  // that output as it is. For PostgreSQL and MySQL, void/db's driver then fails in workerd: pg
  // loads pg-cloudflare's Node stub, and CommonJS requires of Node built-ins become
  // `createRequire(import.meta.url)`. A driver that Vite can resolve from the app root (npm, Yarn
  // and Bun installs, or an app that lists it) even stays external, and Void's browser-target
  // packaging bundles it with browser stubs. Build that environment as the Cloudflare plugin
  // builds Workers, and run each request in Void's request scope, as in dev, so void/db keeps one
  // client per request. D1 apps keep Kit's output: in a request scope, void/db reads D1 through a
  // replica-capable session instead of the primary.
  let workerdNodeBuiltins: Promise<Set<string>> | undefined;
  const svelteKitWorkerBuildPlugin: Plugin | undefined =
    detected.class === 'b' && dialect !== 'sqlite'
      ? {
          name: 'void:sveltekit-worker-build',
          apply: 'build',
          // Before Vite's resolver, which makes a required built-in external.
          enforce: 'pre',
          configEnvironment(name, environment) {
            if (name !== 'ssr') {
              return;
            }
            return {
              resolve: {
                conditions: environment.resolve?.conditions
                  ? ['workerd', 'worker']
                  : ['workerd', 'worker', ...defaultServerConditions],
                noExternal: true,
              },
              // Node output binds `require` at load with createRequire(import.meta.url). Neutral
              // output throws only when a require runs, as for mysql2's optional `cardinal`.
              build: { rolldownOptions: { platform: 'neutral' } },
            };
          },
          // Serve each required Node built-in that workerd provides from an import, as the
          // Cloudflare plugin does with rolldown's esmExternalRequirePlugin. That plugin works only
          // with the rolldown copy running the build, which need not be Void's. A require of any
          // other built-in stays as it is and throws only if it runs.
          resolveId: {
            filter: { id: NODE_BUILTIN },
            async handler(id, _importer, options) {
              if (this.environment?.name !== 'ssr' || options.kind !== 'require-call') {
                return;
              }
              const name = id.replace(/^node:/, '');
              workerdNodeBuiltins ??= readWorkerdNodeBuiltins(readWranglerCompat(root, config));
              if (!(await workerdNodeBuiltins).has(name)) {
                return;
              }
              return `${NODE_BUILTIN_REQUIRE_PREFIX}${name}`;
            },
          },
          load: {
            // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
            filter: { id: /^\0void:node-require:/ },
            handler(id) {
              // A built-in's default export is its CommonJS exports, and `require` returns an ES
              // module's "module.exports" export.
              const name = id.slice(NODE_BUILTIN_REQUIRE_PREFIX.length);
              return `import builtin from "node:${name}";\nexport { builtin as "module.exports" };\n`;
            },
          },
          transform(code, id) {
            if (
              !id.includes('.svelte-kit/generated/server/internal') &&
              !id.includes('.svelte-kit/generated/build/server.js')
            ) {
              return;
            }
            return injectSvelteKitBuildHooks(code, id, envModuleFile);
          },
        }
      : undefined;

  return [
    devTriggerSecretGuardPlugin(),
    createCloudflareBuiltinsExternalPlugin(),
    wranglerCompatPlugin,
    wranglerSyncPlugin,
    ...(nuxtVite8WebSocketCompatPlugin ? [nuxtVite8WebSocketCompatPlugin] : []),
    ...(astroRequestScopePlugin ? [astroRequestScopePlugin] : []),
    svelteKitHooksInjectPlugin,
    ...(svelteKitWorkerBuildPlugin ? [svelteKitWorkerBuildPlugin] : []),
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    bindingRuntimePlugin(bindingNames),
    // Framework-agnostic env DX: typegen, client leak guard, and build-time
    // folding all operate on env.ts + the Vite client module graph, so they
    // apply equally to SvelteKit/Nuxt/Analog/Astro. We intentionally omit
    // envPlugin itself — it mutates workerConfig.vars for Void's own CF
    // build, which Class B/C frameworks don't go through.
    envSchemaPlugin(root),
    envClientGuardPlugin(root),
    envClientFoldPlugin(),
    drizzlePlugin(root, false, dialect, {
      d1BindingName: bindingNames?.d1,
      forceVirtualDb: bindingNames?.d1 !== undefined,
      localD1DatabaseId: localD1.databaseId,
      localD1PersistRoot: frameworkPersistRoot,
    }),
    migrationPlugin(root, dialect, localD1.databaseId, frameworkPersistRoot, {
      enabled: false,
    }),
    devTriggersHintPlugin(root, devTriggerToken),
    frameworkTriggersPlugin(root, { devTriggerToken }),
    ...(detected.name === 'nuxt'
      ? [nitroDevTriggerInjectPlugin(root, { serverDir: 'server' })]
      : []),
    ...(detected.name === 'analog' ? [analogDevTriggerInjectPlugin(root)] : []),
    ...(detected.name === 'astro' ? [astroDevTriggerInjectPlugin(root)] : []),
    implicitDeployGuard,
  ];
}
