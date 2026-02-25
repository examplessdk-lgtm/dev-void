import type { Plugin } from "vite";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuthProvider } from "./index";

import { generateQueueTypes } from "./codegen/queue-types";
import { generateRouteTypes } from "./codegen/route-types";
import { inferBindingsFromSource } from "./inference/walk";
import {
  compileRouteTable,
  compileWorkerEntry,
  compileWorkerClient,
  type CompileOptions,
  type SsrCompileOptions,
  type PagesCompileOptions,
} from "./router/compile";
import { scanRoutes, type ScanResult } from "./router/scan";
import {
  validateSsrEntries,
  SSR_SERVER_ENTRY_RELATIVE_PATHS,
  SSR_CLIENT_ENTRY_RELATIVE_PATHS,
} from "./ssr/entry";

const VIRTUAL_ROUTES_ID = "virtual:void-routes";
const VIRTUAL_CLIENT_WORKER_ID = "virtual:void-client-worker";
// Rolldown resolveId hook filters currently require RegExp for `id`.
const RESOLVE_ID_FILTER = /^(virtual:void-(routes|client-worker)|void(\/client|\/queues)?)$/;
const LOAD_ID_FILTER = /^virtual:void-(routes|client-worker)$/;

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
interface RoutingPluginOptions {
  getAuth: () => AuthProvider[] | null;
  autoDetect: boolean;
}

export function routingPlugin(root: string, options: RoutingPluginOptions): Plugin {
  let scan: ScanResult | null = null;
  let ssr: SsrCompileOptions | null = null;
  const routesDir = join(root, "routes");
  const middlewareDir = join(root, "middleware");
  const jobsDir = join(root, "crons");
  const queuesDir = join(root, "queues");
  const pagesDir = join(root, "pages");
  const srcDir = join(root, "src");
  const ssrEntryAbsPaths = new Set(
    [...SSR_SERVER_ENTRY_RELATIVE_PATHS, ...SSR_CLIENT_ENTRY_RELATIVE_PATHS].map((path) =>
      join(root, path),
    ),
  );

  function writeRouteTypes() {
    if (!scan) return;
    const { dts } = generateRouteTypes(scan, routesDir, outDir, pagesDir);
    writeFileSync(join(outDir, "routes.d.ts"), dts);
  }

  function writeQueueTypes() {
    if (!scan) return;
    const dts = generateQueueTypes(scan.queues, queuesDir, outDir);
    writeFileSync(join(outDir, "queues.d.ts"), dts);
  }

  async function rescan() {
    scan = await scanRoutes(root);
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

  const handlerFile = resolveFile("void/handler");
  const authClientPath = join(dirname(resolveFile("void/client")), "auth-client.mjs");
  const compileOptions: CompileOptions = {
    honoPath: resolveFile("hono"),
    responsePath: resolveFile("void/response"),
    reactRefresh: false,
    auth: null,
  };

  // Auth compile options are set up lazily in buildStart (after env plugin
  // has run its config hook and authProviders is fully resolved).
  function resolveAuthCompileOptions(): void {
    const providers = options.getAuth();
    if (!providers) {
      compileOptions.auth = null;
      return;
    }
    const hasEmail = providers.includes("email");
    const hasGitHub = providers.includes("github");
    const hasGoogle = providers.includes("google");
    compileOptions.auth = {
      providers,
      sessionPath: resolveFile("void/auth/session"),
      passwordPath: hasEmail ? resolveFile("void/auth/password") : null,
      schemaPath: resolveFile("void/auth/schema"),
      githubProviderPath: hasGitHub ? resolveFile("@hono/oauth-providers/github") : null,
      googleProviderPath: hasGoogle ? resolveFile("@hono/oauth-providers/google") : null,
      authRuntimePath: resolveFile("void/auth"),
    };
  }

  function getPagesCompileOptions(): PagesCompileOptions | null {
    if (!scan || scan.pages.pages.length === 0) return null;
    const hasIslandPages = scan.pages.pages.some((p) => p.island);
    return {
      pagesDir,
      protocolPath: resolveFile("void/pages-protocol"),
      clientEntryId: "virtual:void-pages-client",
      islandClientEntryId: hasIslandPages ? "virtual:void-islands-client" : undefined,
    };
  }

  // Generate the entry file and tsconfig eagerly (at plugin creation time,
  // during voidPlugin()). The CF plugin needs the `main` file to exist at
  // config resolution time, which is before any hooks like buildStart fire.
  // The tsconfig.json allows users to extend it from their root tsconfig
  // so generated types (.void/routes.d.ts) are discovered automatically.
  const outDir = join(root, ".void");
  mkdirSync(outDir, { recursive: true });
  // Write initial entry — will be re-written with hasQueues once scan completes
  writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry());

  return {
    name: "void:routing",
    enforce: "pre",
    configResolved(config) {
      compileOptions.reactRefresh = config.plugins.some(
        (plugin) =>
          plugin.name === "vite:react-babel" ||
          plugin.name === "vite:react-refresh" ||
          plugin.name === "vite:react-swc",
      );
    },
    config(_, env) {
      const entries = validateSsrEntries(root);
      if (!entries || env.command !== "build") return;

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
      resolveAuthCompileOptions();
      await rescan();
      writeRouteTypes();
      writeQueueTypes();
      // Re-write entry with queue handler if needed
      writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry(scan!.queues.length > 0));
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
        // Redirect bare "void" imports to the lightweight handler
        // subpath to avoid pulling the entire plugin into the Worker bundle.
        if (id === "void") {
          return handlerFile;
        }
        // Redirect void/queues to the built runtime module
        if (id === "void/queues") {
          return resolveFile("void/queues");
        }
        // In worker environments, redirect void/client to the worker
        // virtual module that calls app.fetch() directly (no HTTP round-trip).
        if (id === "void/client" && this.environment?.name !== "client") {
          return VIRTUAL_CLIENT_WORKER_ID;
        }
      },
    },

    load: {
      filter: { id: LOAD_ID_FILTER },
      async handler(id) {
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          return compileWorkerClient(authClientPath);
        }
        if (id !== VIRTUAL_ROUTES_ID) return;
        if (!scan) await rescan();
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
      let authHintShown = false;

      const handleFileChange = async (path: string, event: "add" | "change" | "unlink") => {
        if (
          !path.startsWith(routesDir) &&
          !path.startsWith(middlewareDir) &&
          !path.startsWith(jobsDir) &&
          !path.startsWith(queuesDir) &&
          !path.startsWith(pagesDir) &&
          !path.startsWith(srcDir)
        ) {
          return;
        }

        // Check for auth imports when auth is not currently enabled
        if (options.autoDetect && !options.getAuth() && !authHintShown) {
          try {
            const code = readFileSync(path, "utf-8");
            if (inferBindingsFromSource(code, path.split("/").pop()!).needsAuth) {
              authHintShown = true;
              devServer.config.logger.warn(
                "[void] auth import detected — restart to enable auth routes.",
              );
            }
          } catch {}
        }

        if (path.startsWith(srcDir) && !ssrEntryAbsPaths.has(path)) return;

        // Re-scan and invalidate the virtual module in ALL environments.
        // The route table virtual module lives in the workerd environment,
        // not the client — so we must iterate all environments.
        await rescan();
        writeRouteTypes();
        writeQueueTypes();
        writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry(scan!.queues.length > 0));

        // For structural changes (file add/remove), send full-reload to trigger
        // a program reload so the workerd picks up new/removed routes.
        // For content-only changes, module invalidation alone is sufficient —
        // the workerd re-evaluates stale modules on the next request. Sending
        // full-reload for content changes triggers an unnecessary program reload
        // that can break React SSR (dual module instances).
        const structural = event !== "change";

        for (const env of Object.values(devServer.environments)) {
          const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
            if (structural) {
              env.hot.send({ type: "full-reload" });
            }
          }
        }

        // Reload the browser for island page changes — islands are
        // server-rendered only, so there's no client HMR to handle updates.
        if (/\.island\./.test(path)) {
          devServer.environments.client?.hot.send({ type: "full-reload" });
        }
      };

      watcher.on("add", (path) => handleFileChange(path, "add"));
      watcher.on("change", (path) => handleFileChange(path, "change"));
      watcher.on("unlink", (path) => handleFileChange(path, "unlink"));
    },
  };
}
