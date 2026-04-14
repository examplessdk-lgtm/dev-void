import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { findVoidAuthConfig, loadVoidAuthConfig } from './auth/config';
import { generateVoidAuthDatabaseModule, generateVoidAuthDrizzleSchema } from './auth/drizzle';
import { generateQueueTypes } from './codegen/queue-types';
import { generateRouteTypes } from './codegen/route-types';
import { readConfig, getDatabaseDialect } from './config';
import {
  compileRouteTable,
  compileBrowserClient,
  compileWorkerEntry,
  compileWorkerClient,
  compileNodeApp,
  compileNodeServer,
  compileNodeClient,
  type CompileOptions,
  type SsrCompileOptions,
  type PagesCompileOptions,
} from './router/compile';
import { scanRoutes, type ScanResult } from './router/scan';
import type { VoidAuthRuntimeOptions } from './runtime/better-auth-shared';
import {
  validateSsrEntries,
  SSR_SERVER_ENTRY_RELATIVE_PATHS,
  SSR_CLIENT_ENTRY_RELATIVE_PATHS,
} from './ssr/entry';

const VIRTUAL_ROUTES_ID = 'virtual:void-routes';
const VIRTUAL_CLIENT_WORKER_ID = 'virtual:void-client-worker';
const VIRTUAL_CLIENT_BROWSER_ID = 'virtual:void-client-browser';
// Rolldown resolveId hook filters currently require RegExp for `id`.
const RESOLVE_ID_FILTER =
  /^(virtual:void-(routes|client-worker|client-browser)|void(\/client|\/queues)?)$/;
const LOAD_ID_FILTER = /^virtual:void-(routes|client-worker|client-browser)$/;

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
interface RoutingPluginOptions {
  isAuthEnabled: () => boolean;
  headConfig?: import('./pages/head').HeadConfig;
  output?: 'server' | 'static';
  prerenderPaths?: string[];
  remoteMode?: boolean;
  target?: 'node' | 'bun' | 'deno';
  headerRules?: import('./cli/types').HeaderRule[];
  redirectRules?: import('./cli/types').RedirectRule[];
}

export function routingPlugin(root: string, options: RoutingPluginOptions): Plugin {
  let scan: ScanResult | null = null;
  let ssr: SsrCompileOptions | null = null;
  let authConfigPath: string | null = null;
  const routesDir = join(root, 'routes');
  const middlewareDir = join(root, 'middleware');
  const jobsDir = join(root, 'crons');
  const queuesDir = join(root, 'queues');
  const pagesDir = join(root, 'pages');
  const srcDir = join(root, 'src');
  const authConfigDir = root;
  const ssrEntryAbsPaths = new Set(
    [...SSR_SERVER_ENTRY_RELATIVE_PATHS, ...SSR_CLIENT_ENTRY_RELATIVE_PATHS].map((path) =>
      join(root, path),
    ),
  );

  function writeRouteTypes() {
    if (!scan) {
      return;
    }
    const { dts } = generateRouteTypes(scan, routesDir, outDir, pagesDir);
    writeFileSync(join(outDir, 'routes.d.ts'), dts);
  }

  function writeQueueTypes() {
    if (!scan) {
      return;
    }
    const dts = generateQueueTypes(scan.queues, queuesDir, outDir);
    writeFileSync(join(outDir, 'queues.d.ts'), dts);
  }

  async function rescan() {
    scan = await scanRoutes(root, { output: options.output });
    authConfigPath = findVoidAuthConfig(root);
    const entries = validateSsrEntries(root);
    ssr = entries
      ? {
          serverEntryPath: entries.server.absolutePath,
          clientEntryRelativePath: entries.client.relativePath,
        }
      : null;
  }

  // Pre-resolve all runtime module paths so generated code uses absolute paths.
  // This is necessary because:
  // 1. "void" bare import would pull in the entire plugin
  // 2. "hono" is a dep of void, not the user's project
  // 3. Virtual modules have no filesystem location for relative resolution
  const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

  const handlerFile = resolveFile('#self/handler');
  const runtimeDir = dirname(resolveFile('#self/client'));
  const fetchPath = resolveFile('#self/runtime/fetch');
  const fetchStreamPath = resolveFile('#self/runtime/fetch-stream');
  const drizzleAdapterPath = resolveFile('better-auth/adapters/drizzle');
  let authClientPath = join(runtimeDir, 'auth-client.mjs');
  const remote = options.remoteMode
    ? {
        remotePath: resolveFile('#self/remote'),
        envPath: resolveFile('#self/_env'),
      }
    : undefined;
  const compileOptions: CompileOptions = {
    honoPath: resolveFile('hono'),
    responsePath: resolveFile('#self/response'),
    runtimeEnvPath: resolveFile('#self/_env'),
    projectRoot: root,
    homeDir: homedir(),
    webSocketRuntimePath: resolveFile('#self/runtime/ws-server'),
    reactRefresh: false,
    dev: false,
    auth: null,
    nodeTarget: !!options.target,
    headerRules: options.headerRules,
    redirectRules: options.redirectRules,
    explicitPrerenderPaths: options.prerenderPaths,
    bindingHandlerPath: options.target ? undefined : resolveFile('#self/remote/binding-handler'),
  };

  // Auth compile options are set up lazily in buildStart (after env plugin
  // has run its config hook and the auth config file path is known).
  function resolveAuthCompileOptions(): void {
    if (!options.isAuthEnabled() && !authConfigPath) {
      compileOptions.auth = null;
      return;
    }
    const config = readConfig(root);
    const dialect = getDatabaseDialect(config);
    compileOptions.auth = {
      authRuntimePath:
        dialect === 'postgresql'
          ? join(runtimeDir, 'better-auth-pg.mjs')
          : join(runtimeDir, 'better-auth.mjs'),
      authConfigPath,
      authDatabasePath: null,
      authSchemaPath: null,
      dialect,
      providers: config.auth?.providers ?? null,
    };
  }

  async function writeAuthDatabaseFiles(): Promise<void> {
    if (!compileOptions.auth) {
      return;
    }

    const authRuntime: VoidAuthRuntimeOptions = {
      dialect: compileOptions.auth.dialect,
      providers: compileOptions.auth.providers,
      userConfig: await loadVoidAuthConfig(compileOptions.auth.authConfigPath),
    };
    const env = loadEnv(resolvedConfig?.mode ?? 'development', root, '') as Record<string, unknown>;
    const schemaPath = join(outDir, 'better-auth-schema.ts');
    const databasePath = join(outDir, 'better-auth-db.ts');

    writeFileSync(schemaPath, generateVoidAuthDrizzleSchema(authRuntime, env));
    writeFileSync(
      databasePath,
      generateVoidAuthDatabaseModule({
        dialect: compileOptions.auth.dialect,
        schemaImportPath: schemaPath,
        drizzleAdapterPath,
      }),
    );
    compileOptions.auth.authSchemaPath = schemaPath;
    compileOptions.auth.authDatabasePath = databasePath;
  }

  let resolvedConfig: import('vite').ResolvedConfig | null = null;

  function resolveAuthClientPath(config: import('vite').ResolvedConfig): string {
    if (config.plugins.some((plugin) => plugin.name === 'void-react:pages')) {
      return join(runtimeDir, 'auth-client-react.mjs');
    }
    if (config.plugins.some((plugin) => plugin.name === 'void-vue:pages')) {
      return join(runtimeDir, 'auth-client-vue.mjs');
    }
    if (config.plugins.some((plugin) => plugin.name === 'void-svelte:pages')) {
      return join(runtimeDir, 'auth-client-svelte.mjs');
    }
    if (config.plugins.some((plugin) => plugin.name === 'void-solid:pages')) {
      return join(runtimeDir, 'auth-client-solid.mjs');
    }
    return join(runtimeDir, 'auth-client.mjs');
  }

  function isPotentialAuthConfigPath(path: string): boolean {
    if (!path.startsWith(authConfigDir + '/')) {
      return false;
    }
    const rel = path.slice(authConfigDir.length + 1);
    return /^auth\.(c|m)?[jt]s$/.test(rel);
  }

  function getPagesCompileOptions(): PagesCompileOptions | null {
    if (!scan || scan.pages.pages.length === 0) {
      return null;
    }
    const hasIslandPages = scan.pages.pages.some((p) => p.island);
    // Detect md plugin and read its client entry ID for island pages
    const mdPlugin = resolvedConfig?.plugins?.find((p: any) => p.name === 'void-md');
    const mdClientEntryId =
      hasIslandPages && mdPlugin?.api?.clientEntryId
        ? (mdPlugin.api.clientEntryId as string)
        : undefined;
    return {
      pagesDir,
      pagesDirRelative: relative(root, pagesDir).replaceAll('\\', '/'),
      protocolPath: resolveFile('#self/pages-protocol'),
      headPath: resolveFile('#self/pages-head'),
      clientEntryId: 'virtual:void-pages-client',
      islandClientEntryId: hasIslandPages ? 'virtual:void-islands-client' : undefined,
      mdClientEntryId,
      headConfig: options.headConfig,
    };
  }

  // Generate the entry file and tsconfig eagerly (at plugin creation time,
  // during voidPlugin()). The CF plugin needs the `main` file to exist at
  // config resolution time, which is before any hooks like buildStart fire.
  // The tsconfig.json allows users to extend it from their root tsconfig
  // so generated types (.void/routes.d.ts) are discovered automatically.
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  // Write initial entry — will be re-written with hasQueues once scan completes
  if (options.target) {
    writeFileSync(join(outDir, 'app.ts'), compileNodeApp(options.target, compileOptions.honoPath));
    writeFileSync(join(outDir, 'index.ts'), compileNodeServer(options.target));
  } else {
    writeFileSync(
      join(outDir, 'entry.ts'),
      compileWorkerEntry(false, remote, undefined, undefined, compileOptions.runtimeEnvPath),
    );
  }

  return {
    name: 'void:routing',
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      authClientPath = resolveAuthClientPath(config);
      compileOptions.dev = config.command === 'serve';
      compileOptions.reactRefresh = config.plugins.some(
        (plugin) =>
          plugin.name === 'vite:react-babel' ||
          plugin.name === 'vite:react-refresh' ||
          plugin.name === 'vite:react-swc',
      );
    },
    config(_, env) {
      if (env.command === 'serve' && options.isAuthEnabled()) {
        // Alias better-auth client subpaths to absolute file paths so
        // Vite can resolve them during SSR without the bare specifiers
        // needing to be hoisted into the user's node_modules (pnpm
        // strict mode). Without this, Vite discovers them lazily on
        // first auth page load, triggering a disruptive program reload.
        const betterAuthSubpaths = ['client', 'react', 'vue', 'svelte', 'solid'];
        const resolvedAliases = betterAuthSubpaths.flatMap((sub) => {
          try {
            return [{ find: `better-auth/${sub}`, replacement: resolveFile(`better-auth/${sub}`) }];
          } catch {
            return [];
          }
        });

        return { resolve: { alias: resolvedAliases } };
      }

      const entries = validateSsrEntries(root);
      if (!entries || env.command !== 'build') {
        return;
      }

      return {
        build: {
          manifest: true,
          rollupOptions: {
            input: entries.client.absolutePath,
          },
        },
      };
    },

    async buildStart() {
      await rescan();
      if (options.target && (scan?.websockets?.length ?? 0) > 0) {
        throw new Error('WebSocket routes require the default Cloudflare target.');
      }
      resolveAuthCompileOptions();
      await writeAuthDatabaseFiles();
      writeRouteTypes();
      writeQueueTypes();

      // Bundle migrations into the worker for CF targets (in-worker migration runner)
      if (!options.target) {
        const migrationsDir = join(root, 'db', 'migrations');
        if (existsSync(migrationsDir) || compileOptions.auth) {
          const { collectMigrations } = await import('./migrations/collect');
          const migrations = existsSync(migrationsDir) ? collectMigrations(migrationsDir) : [];
          const dialect = getDatabaseDialect(readConfig(root));
          compileOptions.migrationHandlerPath = resolveFile(
            dialect === 'postgresql'
              ? '#self/runtime/migration-handler-pg'
              : '#self/runtime/migration-handler',
          );
          compileOptions.migrations = migrations;
          compileOptions.migrationDialect = dialect;
        }
      }
      // Re-write entry with queue handler if needed
      if (options.target) {
        writeFileSync(
          join(outDir, 'app.ts'),
          compileNodeApp(options.target, compileOptions.honoPath),
        );
        writeFileSync(join(outDir, 'index.ts'), compileNodeServer(options.target));
      } else {
        writeFileSync(
          join(outDir, 'entry.ts'),
          compileWorkerEntry(
            scan!.queues.length > 0,
            remote,
            resolvedConfig?.build.assetsDir,
            (scan!.websockets ?? []).map((route) => route.className),
            compileOptions.runtimeEnvPath,
          ),
        );
      }
    },

    resolveId: {
      filter: { id: RESOLVE_ID_FILTER },
      handler(id) {
        if (id === VIRTUAL_ROUTES_ID) {
          return VIRTUAL_ROUTES_ID;
        }
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          return VIRTUAL_CLIENT_WORKER_ID;
        }
        if (id === VIRTUAL_CLIENT_BROWSER_ID) {
          return VIRTUAL_CLIENT_BROWSER_ID;
        }
        // Redirect bare "void" imports to the lightweight handler
        // subpath to avoid pulling the entire plugin into the Worker bundle.
        if (id === 'void') {
          return handlerFile;
        }
        // Redirect void/queues to the built runtime module
        if (id === 'void/queues') {
          return resolveFile('#self/queues');
        }
        if (id === 'void/client') {
          return this.environment?.name === 'client'
            ? VIRTUAL_CLIENT_BROWSER_ID
            : VIRTUAL_CLIENT_WORKER_ID;
        }
      },
    },

    load: {
      filter: { id: LOAD_ID_FILTER },
      async handler(id) {
        if (id === VIRTUAL_CLIENT_BROWSER_ID) {
          return compileBrowserClient(authClientPath, fetchPath, fetchStreamPath);
        }
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          if (options.target) {
            return compileNodeClient(authClientPath);
          }
          return compileWorkerClient(authClientPath);
        }
        if (id !== VIRTUAL_ROUTES_ID) {
          return;
        }
        if (!scan) {
          await rescan();
        }
        return compileRouteTable(
          scan!,
          routesDir,
          middlewareDir,
          jobsDir,
          queuesDir,
          ssr,
          compileOptions,
          getPagesCompileOptions(),
        );
      },
    },

    configureServer(devServer) {
      // Watch routes/ and middleware/ for new/removed files
      const watcher = devServer.watcher;

      const handleFileChange = async (path: string, event: 'add' | 'change' | 'unlink') => {
        if (
          !path.startsWith(routesDir) &&
          !path.startsWith(middlewareDir) &&
          !path.startsWith(jobsDir) &&
          !path.startsWith(queuesDir) &&
          !path.startsWith(pagesDir) &&
          !path.startsWith(srcDir) &&
          !isPotentialAuthConfigPath(path)
        ) {
          return;
        }

        if (path.startsWith(srcDir) && !ssrEntryAbsPaths.has(path)) {
          return;
        }

        // Re-scan and invalidate the virtual module in ALL environments.
        // The route table virtual module lives in the workerd environment,
        // not the client — so we must iterate all environments.
        await rescan();
        resolveAuthCompileOptions();
        await writeAuthDatabaseFiles();
        writeRouteTypes();
        writeQueueTypes();
        if (options.target) {
          writeFileSync(
            join(outDir, 'app.ts'),
            compileNodeApp(options.target, compileOptions.honoPath),
          );
          writeFileSync(join(outDir, 'index.ts'), compileNodeServer(options.target));
        } else {
          writeFileSync(
            join(outDir, 'entry.ts'),
            compileWorkerEntry(
              scan!.queues.length > 0,
              remote,
              resolvedConfig?.build.assetsDir,
              (scan!.websockets ?? []).map((route) => route.className),
              compileOptions.runtimeEnvPath,
            ),
          );
        }

        // For structural changes (file add/remove), send full-reload to trigger
        // a program reload so the workerd picks up new/removed routes.
        // For content-only changes, module invalidation alone is sufficient —
        // the workerd re-evaluates stale modules on the next request. Sending
        // full-reload for content changes triggers an unnecessary program reload
        // that can break React SSR (dual module instances).
        const structural = event !== 'change';

        for (const env of Object.values(devServer.environments)) {
          const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
            if (structural) {
              env.hot.send({ type: 'full-reload' });
            }
          }
        }

        // Reload the browser for island page changes — islands are
        // server-rendered only, so there's no client HMR to handle updates.
        // .md pages are implicit islands (no client JS), so reload those too.
        if (/\.island\./.test(path) || path.endsWith('.md')) {
          devServer.environments.client?.hot.send({ type: 'full-reload' });
        }
      };

      watcher.on('add', (path) => handleFileChange(path, 'add'));
      watcher.on('change', (path) => handleFileChange(path, 'change'));
      watcher.on('unlink', (path) => handleFileChange(path, 'unlink'));
    },
  };
}
