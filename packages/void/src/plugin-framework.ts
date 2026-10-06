import { type Plugin } from 'vite';
import { type ApplicationAnalysis } from './application-analysis.ts';
import {
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  readWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
} from './cli/wrangler.ts';
import { readConfig } from './config.ts';
import { resolveLocalD1Target } from './local-d1.ts';
import { voidLog } from './log.ts';
import { bindingRuntimePlugin } from './plugin-binding-runtime.ts';
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
import { resolveSandboxConfig } from './sandbox/config.ts';
import { injectSvelteKitHooks } from './sveltekit-hooks-transform.ts';

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
  readonly sandboxConfig: ReturnType<typeof resolveSandboxConfig> | undefined;
  readonly liveConfig: ReturnType<typeof resolveLiveBindingConfig> | undefined;
  readonly detected: NonNullable<ApplicationAnalysis['framework']>;
  readonly clientStubsPlugin: Plugin;
  readonly serverRuntimeOptimizerPlugin: Plugin;
  readonly authEnabled: boolean;
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
    sandboxConfig,
    liveConfig,
    detected,
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    authEnabled,
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
        sandbox: sandboxConfig,
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

  return [
    createCloudflareBuiltinsExternalPlugin(),
    wranglerCompatPlugin,
    wranglerSyncPlugin,
    ...(nuxtVite8WebSocketCompatPlugin ? [nuxtVite8WebSocketCompatPlugin] : []),
    svelteKitHooksInjectPlugin,
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
      forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
      localD1DatabaseId: localD1.databaseId,
      localD1PersistRoot: frameworkPersistRoot,
    }),
    migrationPlugin(root, dialect, localD1.databaseId, frameworkPersistRoot, {
      enabled: false,
    }),
    devTriggersHintPlugin(root, { framework: true, devTriggerToken }),
    frameworkTriggersPlugin(root, { devTriggerToken }),
    ...(detected.name === 'nuxt'
      ? [nitroDevTriggerInjectPlugin(root, { serverDir: 'server' })]
      : []),
    ...(detected.name === 'analog' ? [analogDevTriggerInjectPlugin(root)] : []),
    ...(detected.name === 'astro' ? [astroDevTriggerInjectPlugin(root)] : []),
    implicitDeployGuard,
  ];
}
