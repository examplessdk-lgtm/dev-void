import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { join } from 'pathslash';
import pc from 'picocolors';
import { loadEnv, type Plugin } from 'vite';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetRoutingPolicy,
  type AssetRoutingPolicy,
} from './asset-routing.ts';
import { findVoidAuthConfig } from './auth/config.ts';
import { getToken, isStagingMode } from './cli/auth.ts';
import { readProjectConfig } from './cli/project.ts';
import {
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  hasDurableObjectSqliteMigration,
  LIVE_MIGRATION_TAG,
  normalizeWranglerCompatibilityFlags,
  nextDurableObjectMigrationTag,
  readWranglerCompat,
  readExistingLiveBindingConfig,
  resolveLiveBindingConfig,
  syncWranglerBindings,
} from './cli/wrangler.ts';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import {
  readConfig,
  resolveBindingNames,
  isNodeTarget,
  getDatabaseDialect,
  type NotFoundHandling,
} from './config.ts';
import { scanJobsSync } from './crons/scan.ts';
import { inferBindingsFromSource } from './inference/walk.ts';
import { voidLog, voidWarn, voidError } from './log.ts';
import { pagesDevCssAssetsPlugin } from './pages/dev-css-assets.ts';
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
  writeFrameworkTriggersDispatch,
} from './plugin-framework-triggers.ts';
import {
  DEFAULT_SCAN_DIRS,
  inferProjectBindings,
  detectFramework,
  FRAMEWORK_SCAN_DIRS,
  type Framework,
} from './plugin-inference.ts';
import { migrationPlugin } from './plugin-migration.ts';
import { nodeTargetPlugin } from './plugin-node-target.ts';
import { prerenderPlugin } from './plugin-prerender.ts';
import { restartPlugin } from './plugin-restart.ts';
import { routingPlugin } from './plugin-routing.ts';
import { assertNoRootSourceConventionConflicts, resolveProjectPaths } from './project-paths.ts';
import { scanQueuesSync } from './queues/scan.ts';
import { compileAssetFallbackHelper } from './router/compile.ts';
import { isRouteEnabledForEnvironment, type RouteEnvironment } from './router/parse-filename.ts';
import { scanMiddlewareSync, scanRoutePatternsSync } from './router/scan.ts';
import { scanWebSocketRoutesSync } from './router/websocket.ts';
import { SANDBOX_MIGRATION_TAG, isSandboxEnabled, resolveSandboxConfig } from './sandbox/config.ts';
import { filterLoadedEnv, resolveRemoteMode, stripInternalEnvKeys } from './shared/env.ts';
import { DEFAULT_PROXY_URL, STAGING_PROXY_URL } from './shared/proxy.ts';
import { validateSsrEntry } from './ssr/entry.ts';

/**
 * Persist the dev-trigger token at `<root>/.void/dev-trigger-token` so
 * every voidPlugin() invocation against the same project reads the same
 * value. This matters because `@cloudflare/vite-plugin` spawns a
 * worker-environment child Vite that re-imports vite.config.ts and calls
 * voidPlugin() again — without persistence the parent and child would
 * generate different UUIDs, the dispatch file would embed one and the
 * hint plugin would print the other, and curls would land on
 * `unauthorized`.
 *
 * The file persists across dev sessions by design — it lives under `.void/`
 * (gitignored), and `cleanupWrapper` in `void deploy` explicitly preserves
 * it across its own wipe so saved curl scripts keep working between deploys.
 * The token is local to the project and only honored by a worker bound to
 * localhost; treat it like the rest of `.void/` — disposable scratch state,
 * safe to remove manually if desired.
 */
/**
 * Best-effort detection of `vite build` (and `vite preview`) so we can skip
 * dev-only side effects — writing the dev-trigger token and the dispatch
 * file — when no dev server will run. Vite's CLI passes the subcommand as
 * `process.argv[2]`; programmatic API users (and `vite` with no subcommand)
 * default to `dev`, which we detect as the absence of a build-shaped first
 * positional. This is intentionally permissive: when in doubt, we behave as
 * if we're in dev so first-request correctness is preserved.
 */
function isViteBuildOrPreview(): boolean {
  const subcommand = process.argv[2];
  return subcommand === 'build' || subcommand === 'preview';
}

function getOrCreateDevTriggerToken(root: string): string {
  const tokenPath = join(root, '.void', 'dev-trigger-token');
  const readExisting = (): string | undefined => {
    try {
      const existing = readFileSync(tokenPath, 'utf-8').trim();
      return existing.length > 0 ? existing : undefined;
    } catch {
      return undefined;
    }
  };

  const existing = readExisting();
  if (existing) {
    return existing;
  }

  // Atomic create — `wx` fails with EEXIST if the file appeared between the
  // read above and the write below (parent + child Vite both racing). On
  // EEXIST we re-read the winner's token and use that, so both processes
  // converge on the same UUID.
  mkdirSync(join(root, '.void'), { recursive: true });
  const fresh = crypto.randomUUID();
  try {
    const fd = openSync(tokenPath, 'wx');
    try {
      writeSync(fd, fresh);
    } finally {
      closeSync(fd);
    }
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    const winner = readExisting();
    if (winner) {
      return winner;
    }
    // EEXIST but file is empty — extreme edge case (interrupted writer).
    // Fall through and accept the fresh UUID; subsequent reads will win.
    return fresh;
  }
}

/**
 * Warn when the project's `package.json` does not declare `"type": "module"`.
 *
 * Vite's default `configLoader: "bundle"` bundles `vite.config.ts`,
 * externalizes deps, and then loads the bundle. When `package.json` is non-ESM
 * the bundle is written as `.js` and loaded via CJS `require()`, which throws
 * `ERR_REQUIRE_ASYNC_MODULE` if any externalized dep's ESM graph contains
 * top-level await. `@cloudflare/vite-plugin` (which voidPlugin pulls in) has
 * exactly such a TLA, so non-ESM consumers hit this on every Vite invocation.
 *
 * Runs once per Vite process (factory time), single sync read.
 */
function warnIfPackageJsonIsNotEsm(root: string): void {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return;
  }
  let pkg: { type?: unknown };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }
  if (pkg.type === 'module') {
    return;
  }
  voidWarn(
    'package.json is missing `"type": "module"`. Vite\'s default config loader ' +
      'will fail with ERR_REQUIRE_ASYNC_MODULE on transitive top-level await ' +
      '(e.g. @cloudflare/vite-plugin). Add `"type": "module"` to package.json, ' +
      'or run vite build with `--configLoader runner`.',
  );
}

/**
 * Resolve the server entry module for a Class A framework. We always wrap
 * the framework's own entry with a tiny shim that intercepts
 * `/__void/{scheduled,queue}` in dev so cron and queue handlers run with
 * the worker's full CF bindings. The interception block is gated on
 * `import.meta.env.DEV` and the dispatch module is loaded via dynamic
 * `import()` so the entire dev path (including user cron imports) is
 * dead-code-eliminated in `vite build`. Production deploys go through
 * `cli/wrapper.ts` instead.
 */
function getFrameworkEntry(
  framework: Framework,
  root: string,
  devTriggerToken: string,
  notFound?: NotFoundHandling,
): string {
  const isBuild = isViteBuildOrPreview();
  // In dev, eagerly write the dispatch file so the wrapper's dynamic
  // import resolves on the very first request (the plugin's
  // `configResolved` hook also rewrites it, but we can't rely on that
  // having run before the first request hits the worker).
  //
  // In `vite build`, we instead emit a dispatch-free wrapper, so the
  // dispatch file is unreferenced and we don't write it. Rolldown
  // would otherwise emit it as a separate chunk in the prod bundle —
  // an `if (import.meta.env.DEV)` guard around `await import()` is
  // *not* enough to suppress chunk emission, because chunk splitting
  // runs before constant folding eliminates the dead branch.
  if (!isBuild) {
    writeFrameworkTriggersDispatch(root, devTriggerToken);
  }
  return generateClassATriggerWrapper(
    root,
    framework,
    getOriginalFrameworkEntry(framework, root),
    isBuild,
    undefined,
    notFound,
  );
}

/** The framework's own server entry, before our trigger wrapper. */
function getOriginalFrameworkEntry(framework: Framework, root: string): string {
  switch (framework) {
    case 'tanstack-start':
      return '@tanstack/react-start/server-entry';
    case 'react-router':
      return generateReactRouterEntry(root);
    case 'vinext-app':
      return 'vinext/server/app-router-entry';
    case 'vinext-pages':
      return generateVinextPagesEntry(root);
  }
}

/**
 * Generate `<root>/.void/<framework>-trigger-wrapper.ts`. This file becomes
 * `workerConfig.main` so the dev miniflare/workerd evaluates *our* fetch
 * first, dispatches `/__void/{scheduled,queue}` if it matches, and otherwise
 * delegates to the framework's original entry.
 *
 * We emit two shapes of the wrapper depending on the Vite command:
 *
 * - Serve: dispatch is dynamically imported and gets a chance to handle
 *   `/__void/{scheduled,queue}` before falling through to the framework.
 * - Build: dispatch is omitted entirely. The wrapper just delegates fetch.
 *
 * We can't simply gate the dynamic import on `import.meta.env.DEV` and
 * trust DCE: rolldown emits chunks for dynamic imports during chunk
 * splitting, *before* constant folding removes the dead branch, so the
 * dispatch file (and its transitive user-cron/queue imports + dev token)
 * would still ship in the production bundle.
 */
function generateClassATriggerWrapper(
  root: string,
  framework: Framework,
  original: string,
  isBuild: boolean,
  assetsDir = 'assets',
  /**
   * Resolved `assetConfig.not_found_handling`. A Class A app deploys through
   * `runFullDeploy`, which honors `routing.notFound`, so this wrapper's
   * `serveWithAssets` has to honor it too or the asset binding's 404 page is
   * fetched and then thrown away.
   */
  notFound?: NotFoundHandling,
): string {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const wrapperPath = join(outDir, `${framework}-trigger-wrapper.ts`);
  const body = isBuild
    ? `// @ts-nocheck — Auto-generated by Void for vite build. Do NOT edit.
import original from ${JSON.stringify(original)};

export default {
  ...original,
  async fetch(request, env, ctx) {
    return serveWithAssets(request, env, await original.fetch(request, env, ctx));
  },
};
${compileAssetFallbackHelper(assetsDir, false, notFound)}
`
    : `// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit.
import original from ${JSON.stringify(original)};

export default {
  ...original,
  async fetch(request, env, ctx) {
    const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
    const response = await handleDevTrigger(request, env, ctx);
    if (response) return response;
    return original.fetch(request, env, ctx);
  },
};
`;
  writeFileIfChanged(wrapperPath, body);
  return wrapperPath;
}

/** Generate a worker entry for vinext Pages Router projects. */
function generateVinextPagesEntry(root: string): string {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const entryPath = join(outDir, 'vinext-pages-entry.ts');
  writeFileIfChanged(
    entryPath,
    `// Auto-generated by Void — vinext Pages Router worker entry
// @ts-expect-error virtual module resolved by vinext at build time
import { renderPage, handleApiRoute } from "virtual:vinext-server-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.replaceAll("\\\\", "/").startsWith("//")) {
      return new Response("404 Not Found", { status: 404 });
    }
    const urlWithQuery = pathname + url.search;
    if (pathname.startsWith("/api/") || pathname === "/api") {
      return await handleApiRoute(request, urlWithQuery);
    }
    return await renderPage(request, urlWithQuery, null);
  },
};
`,
  );
  return entryPath;
}

/** Generate a worker entry for React Router v7 projects. */
function generateReactRouterEntry(root: string): string {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const entryPath = join(outDir, 'react-router-entry.ts');
  writeFileIfChanged(
    entryPath,
    `// Auto-generated by Void — React Router v7 worker entry
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  // @ts-expect-error virtual module resolved by @react-router/dev at build time
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request: Request): Promise<Response> {
    return requestHandler(request);
  },
};
`,
  );
  return entryPath;
}

/** Check whether a binding name already exists in a resolved bindings array. */
function hasBinding(list: Array<{ binding: string }> | undefined, name: string): boolean {
  return Array.isArray(list) && list.some((b) => b.binding === name);
}

/**
 * Decide whether to inject a Workers AI binding into the built wrangler config.
 *
 * Build-only: dev/miniflare has no local Workers AI, so serve must never bind
 * `env.AI` (dev uses the P2 `__VOID_TOKEN` proxy path instead).
 *
 * `!resolvedAi` is load-bearing: mergeBindings' return is defu-merged over the
 * resolved root-wrangler config and wins, so skipping when the user already
 * declared an `ai` binding avoids clobbering theirs. `!resultAi` is harmless
 * defense-in-depth (nothing else in mergeBindings sets `result.ai`).
 */
export function shouldBindWorkersAi(
  command: string,
  needsAI: boolean,
  resolvedAi: unknown,
  resultAi: unknown,
): boolean {
  return needsAI && command === 'build' && !resultAi && !resolvedAi;
}

const CLOUDFLARE_BUILTIN_IMPORT = /^cloudflare:/;
const SANDBOX_SDK_IMPORT = '@cloudflare/sandbox';
const SANDBOX_SDK_IMPORT_FILTER = /^@cloudflare\/sandbox$/;
const DEFAULT_WORKER_ENVIRONMENT_NAME = 'void_worker';
const DEFAULT_WORKER_OUT_DIR = 'dist/ssr';
const DEV_ASSET_ROUTING_EXCLUSIONS = [
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

function createCloudflareBuiltinsExternalPlugin(): Plugin {
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

function createDefaultWorkerEnvironmentPlugin(): Plugin {
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

function createWorkerEnvironmentSanitizerPlugin(environmentNames: ReadonlyArray<string>): Plugin {
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

function createSandboxSdkResolvePlugin(): Plugin {
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

function createWranglerCompatPersistPlugin(
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

type CredentialStatus =
  | { status: 'ok'; token: string; projectId: string; staging?: boolean }
  | { status: 'no-token' }
  | { status: 'no-project'; token: string; staging?: boolean };

/**
 * Read Void auth credentials for local dev AI proxy access.
 * Returns a discriminated union so callers can distinguish
 * "no token" from "no project" for targeted onboarding guidance.
 */
function readVoidDevCredentials(root: string): CredentialStatus {
  const token = getToken(root);
  if (!token) {
    return { status: 'no-token' };
  }
  const staging = isStagingMode(root) || undefined;

  const project = readProjectConfig(root);
  if (!project) {
    return { status: 'no-project', token, staging };
  }

  return { status: 'ok', token, projectId: project.projectId, staging };
}

const DEFAULT_API_URL = 'https://api.void.cloud';
const STAGING_API_URL = 'https://api.staging.void.cloud';

/**
 * Interactive AI setup prompt shown during dev server startup when the user
 * has a token but no linked project. Runs as fire-and-forget so it doesn't
 * block the server. On completion, writes project.json and restarts the server.
 */
async function runAiSetupPrompt(
  root: string,
  token: string,
  staging: boolean | undefined,
  server: import('vite').ViteDevServer,
): Promise<void> {
  const { select, text, isCancel, log } = await import('@clack/prompts');
  const { PlatformClient } = await import('./cli/client.ts');
  const { writeProjectConfig } = await import('./cli/project.ts');
  const { inferDefaultSlug } = await import('./cli/resolve-project.ts');

  const apiUrl = staging ? STAGING_API_URL : DEFAULT_API_URL;
  const client = new PlatformClient(token, apiUrl);

  let projects: Array<import('./cli/client.ts').ProjectResponse>;
  try {
    projects = await client.listProjects();
  } catch {
    voidWarn('Failed to fetch projects. Run `void project link` to link a project manually.');
    return;
  }

  const options = [
    { value: '__create__' as const, label: 'Create new project' },
    ...projects.map((p: import('./cli/client.ts').ProjectResponse) => ({
      value: p.id,
      label: p.slug,
    })),
  ];

  console.log();
  log.info("[void] AI requires a linked project. Let's set one up:");

  const result = await select({ message: 'Select a project:', options });
  if (isCancel(result)) {
    return;
  }

  let projectId: string;
  let slug: string;

  if (result === '__create__') {
    const { validateProjectSlug } = await import('./cli/project-slug.ts');
    const { createProjectWithSlugRetry } = await import('./cli/create-project.ts');
    let created;
    try {
      // Share the slug-retry loop with deploy/link paths so server-side plan
      // rejections (e.g. free-plan short-slug 403) re-prompt consistently.
      // The prompt callback returns `undefined` on Ctrl+C so the helper can
      // exit cleanly instead of calling process.exit().
      created = await createProjectWithSlugRetry(
        client,
        inferDefaultSlug(root),
        async (defaultSlug) => {
          const slugResult = await text({
            message: 'Choose a slug for your new Void project:',
            placeholder: 'my-app',
            initialValue: defaultSlug,
            validate: validateProjectSlug,
          });
          if (isCancel(slugResult)) {
            return undefined;
          }
          return slugResult.trim();
        },
      );
    } catch (err: unknown) {
      voidError(
        `project: Failed to create project: '${err instanceof Error ? err.message : String(err)}'.`,
      );
      return;
    }
    if (!created) {
      return;
    }
    projectId = created.id;
    slug = created.slug;
  } else {
    const project = projects.find(
      (p: import('./cli/client.ts').ProjectResponse) => p.id === result,
    )!;
    projectId = project.id;
    slug = project.slug;
  }

  writeProjectConfig(root, { projectId, slug });
  log.success(`Linked to ${pc.blue(slug)}`);

  // Restart the dev server so mergeBindings picks up fresh credentials
  await server.restart();
}

/**
 * Void plugin — the main entry point.
 *
 * Composes:
 * 1. Routing plugin (file-based routing from routes/ and middleware/)
 * 2. Migration plugin (auto-apply .sql migrations on dev startup)
 * 3. @cloudflare/vite-plugin (workerd runtime, HMR, builds)
 *
 * Binding inference runs synchronously here so results are available
 * before the Cloudflare plugin initializes.
 *
 * If the user has a `wrangler.jsonc` / `wrangler.json` in their project root,
 * the Cloudflare plugin reads it and provides the resolved config to our
 * config function. Bindings already defined there (with real IDs for
 * production deployment) are preserved — we only add inferred bindings
 * that are missing. This allows `vite build && wrangler deploy` to work
 * for deploying directly to Cloudflare without the Void platform.
 */
export function voidPlugin(options?: {
  persistTo?: string;
  auxiliaryWorkers?: PluginConfig['auxiliaryWorkers'];
}): Array<Plugin> {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();
  warnIfPackageJsonIsNotEsm(root);
  // Token only matters in serve — the dispatch module that uses it is
  // DCE'd from production worker bundles. In build/preview we still need
  // *some* string (the wrapper embeds it for completeness), but we skip
  // persisting it so build-only CI workflows don't materialize dev state.
  const devTriggerToken = isViteBuildOrPreview()
    ? crypto.randomUUID()
    : getOrCreateDevTriggerToken(root);
  const config = readConfig(root);
  const paths = resolveProjectPaths(root, config);
  let routeEnvironment: RouteEnvironment = 'prod';
  assertNoRootSourceConventionConflicts(paths);
  const dialect = getDatabaseDialect(config);
  const detected = detectFramework(root);
  const framework = detected?.class === 'a' ? (detected.name as Framework) : undefined;
  const initialFrameworkShellEnv = framework ? { ...process.env } : undefined;

  // Infer bindings synchronously from source files
  const scanDirs = config.inference?.scanDirs ?? (detected ? FRAMEWORK_SCAN_DIRS : undefined);
  const inferenceOptions = config.inference?.bindings
    ? { bindings: config.inference.bindings }
    : undefined;
  const bindingNames = resolveBindingNames(config.inference?.bindings);
  const inferredBindings = inferProjectBindings(root, { ...inferenceOptions, paths }, scanDirs);
  const sandboxEnabled = isSandboxEnabled(config);
  const bindings = sandboxEnabled ? { ...inferredBindings, needsSandbox: true } : inferredBindings;
  const sandboxConfig = bindings.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  const authConfigPath = findVoidAuthConfig(root, paths);
  const authEnabled = bindings.needsAuth || authConfigPath !== null || config.auth !== undefined;

  if (detected && authEnabled) {
    throw new Error(
      "auth: Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
  }
  if (detected && bindings.needsSandbox) {
    throw new Error('sandbox: Cloudflare Sandboxes are currently supported in Void apps only.');
  }
  if (detected && bindings.needsLive) {
    throw new Error('live: void/live is currently supported in Void apps only.');
  }

  // Server-only void/* imports (db, kv, ai, etc.) must not pull in
  // cloudflare:workers or node: builtins when bundled for the browser.
  // Resolve them to empty stubs in any client environment.
  const STUB_PREFIX = '\0void-client-stub:';
  const SERVER_ONLY_STUBS: Record<string, string> = {
    'void/db': 'export const db = {}; export const createDb = () => ({});',
    'void/kv': 'export const kv = {}; export const createKV = () => ({});',
    'void/ai': 'export const ai = {};',
    'void/queues': 'export const queues = {};',
    'void/storage': 'export const storage = {}; export const createStorage = () => ({});',
    'void/isr': 'export const revalidate = async () => {};',
    // Client stub must mirror the real runtime/sandbox.ts surface so any
    // client-side `instanceof SandboxLimitError` check doesn't crash with a
    // TypeError, and async `await getSandbox(...)` callers don't silently
    // mis-handle a sync return. Throwing here makes accidental client imports
    // fail loudly rather than returning a misleading bare `{}`.
    'void/sandbox': `
      export class SandboxLimitError extends Error {
        constructor(reason = 'concurrency', message) {
          super(message ?? 'Sandbox limit reached: ' + reason);
          this.name = 'SandboxLimitError';
          this.reason = reason;
        }
      }
      export async function getSandbox() {
        throw new Error('void/sandbox is server-only and cannot be imported by browser code.');
      }
      export const sandbox = { get: getSandbox };
    `,
    'void/live': '',
  };
  const STUB_RESOLVE_FILTER = new RegExp(
    `^(${Object.keys(SERVER_ONLY_STUBS).join('|').replaceAll('/', '\\/')})$`,
  );
  // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
  const STUB_LOAD_FILTER = new RegExp(`^\\0void-client-stub:`);

  const clientStubsPlugin: Plugin = {
    name: 'void:client-stubs',
    enforce: 'pre',
    resolveId: {
      filter: { id: STUB_RESOLVE_FILTER },
      handler(id) {
        if (this.environment?.name === 'client') {
          if (id === 'void/live') {
            this.error(
              'void/live is server-only and cannot be imported by browser code. Import void/live/client instead.',
            );
          }
          return STUB_PREFIX + id;
        }
      },
    },
    load: {
      filter: { id: STUB_LOAD_FILTER },
      handler(id) {
        return SERVER_ONLY_STUBS[id.slice(STUB_PREFIX.length)] ?? 'export default {};';
      },
    },
  };

  // Scan queues/websocket routes early so both framework-mode and default-mode
  // branches can safely close over these bindings.
  const queues = framework ? [] : scanQueuesSync(root, paths.queuesDir);
  // Deliberately scanned with NO environment: this list is the superset used to
  // RESERVE binding and Durable Object class names below, and reservation must
  // not depend on which command is running. A filtered list would let the live
  // DO resolve to `VOID_LIVE` under `vite dev` and `VOID_LIVE_2` under
  // `vite build` for the same project. Consumers that emit config rather than
  // reserve names re-filter by `routeEnvironment` (see `mergeBindings` and
  // `resolveConfiguredAssetRoutingPolicy`).
  const websocketRoutes = framework ? [] : scanWebSocketRoutesSync(root, paths);
  const liveConfig = !isNodeTarget(config.target)
    ? bindings.needsLive
      ? resolveLiveBindingConfig(root, {
          reservedBindings: websocketRoutes.map((route) => route.bindingName),
          reservedClasses: [
            ...websocketRoutes.map((route) => route.className),
            sandboxConfig?.className,
          ],
        })
      : readExistingLiveBindingConfig(root)
    : undefined;

  // Class B/C: lighter composition — DB types + migrations only.
  // The framework's own adapter handles the CF worker build and dev server.
  // voidPlugin() only provides DB type codegen, migration management, and
  // wrangler.jsonc binding sync for local dev.
  if (detected && (detected.class === 'b' || detected.class === 'c')) {
    const frameworkPersistRoot = join(root, '.wrangler', 'state');
    const syncFrameworkCompat = (compat: ReturnType<typeof readWranglerCompat>) => {
      const syncedDate = ensureWranglerCompatibilityDate(root, compat.compatibilityDate);
      if (syncedDate) {
        voidLog('Synced compatibility_date to wrangler config');
      }
    };

    // Ensure required compat flags are written before framework adapters
    // initialize Cloudflare dev runtime / Miniflare.
    const wranglerCompatPlugin: Plugin = {
      name: 'void:wrangler-compat',
      enforce: 'pre',
      config(_, env) {
        syncFrameworkCompat(ensureWranglerCompat(root, config));
        if (env.command !== 'serve') {
          return;
        }
        const synced = ensureWranglerNodejsAlsFlag(root);
        if (synced) {
          voidLog('Synced nodejs_als to wrangler config');
        }
      },
      buildStart() {
        syncFrameworkCompat(ensureWranglerCompat(root, config));
      },
      configureServer() {
        syncFrameworkCompat(ensureWranglerCompat(root, config));
      },
    };

    // Wrangler.jsonc binding sync plugin — runs on dev startup
    const wranglerSyncPlugin: Plugin = {
      name: 'void:wrangler-sync',
      configResolved(resolvedConfig) {
        syncFrameworkCompat(readWranglerCompat(root, config));
        if (resolvedConfig.command !== 'serve') {
          return;
        }
        const synced = syncWranglerBindings(root, bindings, {
          bindingNames,
          websockets: websocketRoutes,
          sandbox: sandboxConfig,
          live: liveConfig,
        });
        if (synced) {
          voidLog('Synced bindings to wrangler.jsonc');
        }
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
    // withRuntimeEnv(event.platform.env, ...). This stores the env in
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
        if (!id.includes('.svelte-kit/generated/server/internal')) {
          return;
        }
        if (!code.includes('export async function get_hooks')) {
          return;
        }

        const dispatchPath = JSON.stringify(frameworkTriggersDispatchPath(root));
        return code
          .replace(
            'export async function get_hooks() {',
            `export async function get_hooks() {\n` +
              `  const { withRuntimeEnv } = await import("void/_env");\n` +
              `  const { handleDevTrigger } = await import(${dispatchPath});`,
          )
          .replace(
            /return\s*\{/,
            `const __origHandle = handle ?? (({ event, resolve }) => resolve(event));\n` +
              `  handle = ({ event, resolve }) => withRuntimeEnv(event.platform?.env, async () => {\n` +
              `    const __triggerResp = await handleDevTrigger(event.request, event.platform?.env, undefined);\n` +
              `    if (__triggerResp) return __triggerResp;\n` +
              `    return __origHandle({ event, resolve });\n` +
              `  });\n` +
              `  return {`,
          );
      },
    };

    return [
      createCloudflareBuiltinsExternalPlugin(),
      wranglerCompatPlugin,
      wranglerSyncPlugin,
      ...(nuxtVite8WebSocketCompatPlugin ? [nuxtVite8WebSocketCompatPlugin] : []),
      svelteKitHooksInjectPlugin,
      clientStubsPlugin,
      bindingRuntimePlugin(bindingNames),
      // Framework-agnostic env DX: typegen, client leak guard, and build-time
      // folding all operate on env.ts + the Vite client module graph, so they
      // apply equally to SvelteKit/Nuxt/Analog/Astro. We intentionally omit
      // envPlugin itself — it mutates workerConfig.vars for Void's own CF
      // build, which Class B/C frameworks don't go through.
      envSchemaPlugin(root, { frameworkOwnsRuntimeEnv: true }),
      envClientGuardPlugin(root),
      envClientFoldPlugin(),
      drizzlePlugin(root, false, dialect, {
        d1BindingName: bindingNames?.d1,
        forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
        localD1PersistRoot: frameworkPersistRoot,
      }),
      migrationPlugin(root, dialect, 'local', frameworkPersistRoot, {
        enabled: false,
      }),
      devTriggersHintPlugin(root, { framework: true, devTriggerToken }),
      frameworkTriggersPlugin(root, { devTriggerToken }),
      ...(detected.name === 'nuxt'
        ? [nitroDevTriggerInjectPlugin(root, { serverDir: 'server' })]
        : []),
      ...(detected.name === 'analog' ? [analogDevTriggerInjectPlugin(root)] : []),
      ...(detected.name === 'astro' ? [astroDevTriggerInjectPlugin(root)] : []),
    ];
  }

  // Remote mode — use platform proxy for D1/KV/R2 instead of local miniflare.
  const remoteMode = resolveRemoteMode(config.remote);

  // Core worker config — always set by voidPlugin (main, triggers, assets).
  // Bindings are handled separately in the config function below.
  const workerConfig: Record<string, unknown> = {};
  let assetRouting: AssetRoutingPolicy;
  if (config.worker?.vars) {
    workerConfig.vars = { ...config.worker.vars };
  }

  // Tracks whether vite is running in dev or build mode. Set early in
  // envPlugin.config so mergeBindings can gate credential injection on 'serve'.
  let viteCommand: 'serve' | 'build' = 'build';

  // Merge curated wrangler fields from void.json
  const wranglerCompat = isNodeTarget(config.target) ? undefined : readWranglerCompat(root, config);
  if (wranglerCompat) {
    workerConfig.compatibility_date = wranglerCompat.compatibilityDate;
    if (wranglerCompat.compatibilityFlags) {
      workerConfig.compatibility_flags = wranglerCompat.compatibilityFlags;
    }
  }
  // CPU cap from void.json `worker.limits.cpu_ms` (validated in config.ts as an
  // integer 1..300000). The CF plugin passes `limits` through into the generated
  // `dist/ssr/wrangler.json`, so a self-host `wrangler deploy` / `void deploy
  // --backend cloudflare` enforces it directly. Managed `void deploy` ignores
  // the generated wrangler config and carries the cap in the deploy manifest.
  if (config.worker?.limits?.cpu_ms) {
    workerConfig.limits = { cpu_ms: config.worker.limits.cpu_ms };
  }
  const inspectorPortEnv = process.env.VOID_INSPECTOR_PORT;
  const inspectorPort =
    inspectorPortEnv === 'false'
      ? false
      : typeof inspectorPortEnv === 'string' && inspectorPortEnv.length > 0
        ? Number.parseInt(inspectorPortEnv, 10)
        : undefined;

  const inspectorPortOption: { inspectorPort?: number | false } =
    inspectorPort === false
      ? { inspectorPort: false }
      : typeof inspectorPort === 'number'
        ? { inspectorPort }
        : {};

  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });

  // Config function that merges inferred bindings with the resolved config.
  // When the user has a wrangler.json with real binding IDs (for raw CF
  // deployment), those take precedence. We only add placeholder bindings
  // for inferred bindings that are missing from their config.
  // When no wrangler.json exists, resolved config has empty bindings and
  // all inferred bindings are added — matching the previous behavior.
  function mergeBindings(resolved: WorkerConfig): Partial<WorkerConfig> {
    const environmentWebsocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, routeEnvironment),
    );
    const result: Record<string, unknown> = { ...workerConfig };

    // Void owns the generated asset routing policy. Replace stale root
    // wrangler settings instead of letting the Cloudflare plugin concatenate
    // them with generated rules. This preserves static-first behavior for
    // API-only apps while avoiding asset-served HTML bypassing middleware.
    if (workerConfig.assets && resolved.assets) {
      delete (resolved.assets as Record<string, unknown>).not_found_handling;
      delete (resolved.assets as Record<string, unknown>).run_worker_first;
    }

    // D1 — auth requires the app DB only for sqlite apps
    const d1Name = bindingNames?.d1 ?? 'DB';
    const d1: Array<Record<string, unknown>> = [];
    if (
      (bindings.needsD1 || (authEnabled && dialect === 'sqlite')) &&
      !hasBinding(resolved.d1_databases, d1Name)
    ) {
      d1.push({ binding: d1Name, database_name: 'default', database_id: 'local' });
    }
    if (d1.length > 0) {
      result.d1_databases = d1;
    }

    const kvName = bindingNames?.kv ?? 'KV';
    const kv: Array<{ binding: string; id: string }> = [];
    if (bindings.needsKV && !hasBinding(resolved.kv_namespaces, kvName)) {
      kv.push({ binding: kvName, id: 'local' });
    }
    if (kv.length > 0) {
      result.kv_namespaces = kv;
    }

    // R2
    const r2Name = bindingNames?.r2 ?? 'STORAGE';
    if (bindings.needsR2 && !hasBinding(resolved.r2_buckets, r2Name)) {
      result.r2_buckets = [{ binding: r2Name, bucket_name: 'default' }];
    }

    // Workers AI — self-host only. The managed deploy ignores dist/wrangler.json,
    // so this binding only takes effect on a real `wrangler deploy`. Build-gated
    // because dev/miniflare has no local Workers AI (dev uses the P2
    // __VOID_TOKEN proxy path). The `ai` config is a single object (not an array)
    // and needs no external id, so it is safe to inject unconditionally here.
    // Guard rationale: mergeBindings' return is defu-merged over `resolved` and
    // wins, so `!resolvedAi` is load-bearing (prevents clobbering a user's own
    // root-wrangler `ai` binding); `!resultAi` is harmless defense-in-depth
    // (nothing else in mergeBindings ever sets `result.ai`).
    if (
      shouldBindWorkersAi(
        viteCommand,
        bindings.needsAI,
        (resolved as { ai?: unknown }).ai,
        (result as { ai?: unknown }).ai,
      )
    ) {
      (result as Record<string, unknown>).ai = { binding: 'AI' };
    }

    // AI Gateway id → runtime var (harmless in serve; only read by the P3 direct
    // backend that routes Workers AI inference through the user's own Gateway).
    if (config.ai?.gateway) {
      const vars = (result.vars as Record<string, string>) ?? {};
      vars.__VOID_AI_GATEWAY = config.ai.gateway;
      result.vars = vars;
    }

    // Queues — add producer + consumer bindings for local dev
    if (queues.length > 0) {
      (result as Record<string, unknown>).queues = {
        producers: queues.map((q) => ({ queue: q.name, binding: q.bindingName })),
        consumers: queues.map((q) => ({
          queue: q.name,
          ...(q.maxBatchSize != null && { max_batch_size: q.maxBatchSize }),
          ...(q.maxBatchTimeout != null && { max_batch_timeout: q.maxBatchTimeout }),
          ...(q.maxRetries != null && { max_retries: q.maxRetries }),
          ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
        })),
      };
    }

    if (environmentWebsocketRoutes.length > 0) {
      type DurableObjectBindingsConfig = {
        durable_objects?: {
          bindings?: Array<{ name: string; class_name: string }>;
        };
      };
      const existingDurableObjectBindings =
        ((resolved as DurableObjectBindingsConfig).durable_objects?.bindings as
          | Array<{ name: string; class_name: string }>
          | undefined) ?? [];
      const missingDurableObjectBindings = environmentWebsocketRoutes
        .filter(
          (route) =>
            !existingDurableObjectBindings.some((binding) => binding.name === route.bindingName),
        )
        .map((route) => ({
          name: route.bindingName,
          class_name: route.className,
        }));

      if (missingDurableObjectBindings.length > 0) {
        (result as Record<string, unknown>).durable_objects = {
          bindings: [...existingDurableObjectBindings, ...missingDurableObjectBindings],
        };
      }

      if (!Array.isArray((resolved as Record<string, unknown>).migrations)) {
        (result as Record<string, unknown>).migrations = [
          {
            tag: 'void-ws-v1',
            new_classes: environmentWebsocketRoutes.map((route) => route.className),
          },
        ];
      }
    }

    if (bindings.needsSandbox && sandboxConfig) {
      const currentDurableObjects =
        ((result as Record<string, unknown>).durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined) ??
        ((resolved as Record<string, unknown>).durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined);
      const existingDurableObjectBindings =
        (currentDurableObjects?.bindings as
          | Array<{ name: string; class_name: string }>
          | undefined) ?? [];
      if (
        !existingDurableObjectBindings.some((binding) => binding.name === sandboxConfig.binding)
      ) {
        (result as Record<string, unknown>).durable_objects = {
          bindings: [
            ...existingDurableObjectBindings,
            {
              name: sandboxConfig.binding,
              class_name: sandboxConfig.className,
            },
          ],
        };
      }

      const existingContainers =
        ((result as Record<string, unknown>).containers as
          | Array<{ class_name?: string }>
          | undefined) ??
        ((resolved as Record<string, unknown>).containers as
          | Array<{ class_name?: string }>
          | undefined) ??
        [];
      if (
        !existingContainers.some((container) => container.class_name === sandboxConfig.className)
      ) {
        (result as Record<string, unknown>).containers = [
          ...existingContainers,
          {
            name: sandboxConfig.containerName,
            class_name: sandboxConfig.className,
            image: sandboxConfig.image,
            ...(sandboxConfig.imageBuildContext && {
              image_build_context: sandboxConfig.imageBuildContext,
            }),
            ...(sandboxConfig.instanceType && { instance_type: sandboxConfig.instanceType }),
            ...(sandboxConfig.maxInstances != null && {
              max_instances: sandboxConfig.maxInstances,
            }),
          },
        ];
      }

      const currentMigrations =
        (result as Record<string, unknown>).migrations ??
        (resolved as Record<string, unknown>).migrations;
      const existingMigrations = Array.isArray(currentMigrations)
        ? (currentMigrations as Array<{
            tag?: string;
            new_classes?: Array<string>;
            new_sqlite_classes?: Array<string>;
          }>)
        : [];
      if (
        !existingMigrations.some(
          (migration) =>
            migration.tag === SANDBOX_MIGRATION_TAG ||
            migration.new_sqlite_classes?.includes(sandboxConfig.className),
        )
      ) {
        (result as Record<string, unknown>).migrations = [
          ...existingMigrations,
          {
            tag: SANDBOX_MIGRATION_TAG,
            new_sqlite_classes: [sandboxConfig.className],
          },
        ];
      }
    }

    if (liveConfig) {
      const currentDurableObjects =
        ((result as Record<string, unknown>).durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined) ??
        ((resolved as Record<string, unknown>).durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined);
      const existingDurableObjectBindings =
        (currentDurableObjects?.bindings as
          | Array<{ name: string; class_name: string }>
          | undefined) ?? [];
      if (
        !existingDurableObjectBindings.some((binding) => binding.name === liveConfig.bindingName)
      ) {
        (result as Record<string, unknown>).durable_objects = {
          bindings: [
            ...existingDurableObjectBindings,
            {
              name: liveConfig.bindingName,
              class_name: liveConfig.className,
            },
          ],
        };
      }

      const currentMigrations =
        (result as Record<string, unknown>).migrations ??
        (resolved as Record<string, unknown>).migrations;
      const existingMigrations = Array.isArray(currentMigrations)
        ? (currentMigrations as Array<{
            tag?: string;
            new_classes?: Array<string>;
            new_sqlite_classes?: Array<string>;
          }>)
        : [];
      if (!hasDurableObjectSqliteMigration(existingMigrations, liveConfig.className)) {
        (result as Record<string, unknown>).migrations = [
          ...existingMigrations,
          {
            tag: nextDurableObjectMigrationTag(existingMigrations, LIVE_MIGRATION_TAG),
            new_sqlite_classes: [liveConfig.className],
          },
        ];
      }
    }

    // AI — in local dev, inject VC credentials for HTTPS proxy path.
    // In production, the platform adds a __VOID_PROXY service binding instead.
    if (viteCommand === 'serve' && bindings.needsAI) {
      const credentials = readVoidDevCredentials(root);
      if (credentials.status === 'ok') {
        // Prefer HTTPS proxy — inject credentials, skip direct AI binding
        const vars = (result.vars as Record<string, string>) ?? {};
        vars.__VOID_TOKEN = credentials.token;
        vars.__VOID_PROJECT_ID = credentials.projectId;
        if (credentials.staging) {
          vars.__VOID_STAGING = '1';
        }
        result.vars = vars;
      }
    }

    // Remote bindings — inject proxy credentials when remote mode is enabled.
    // In remote mode, D1/KV/R2 bindings are replaced with proxy-backed versions
    // that forward operations to the platform proxy over HTTPS.
    if (
      viteCommand === 'serve' &&
      remoteMode &&
      (bindings.needsD1 || bindings.needsKV || bindings.needsR2)
    ) {
      const credentials = readVoidDevCredentials(root);
      if (credentials.status === 'ok') {
        const vars = (result.vars as Record<string, string>) ?? {};
        vars.__VOID_PROXY_URL = credentials.staging ? STAGING_PROXY_URL : DEFAULT_PROXY_URL;
        vars.__VOID_TOKEN = credentials.token;
        vars.__VOID_PROJECT_ID = credentials.projectId;
        vars.__VOID_REMOTE = '1';
        result.vars = vars;
      }
    }

    return result as Partial<WorkerConfig>;
  }

  // Merge schema defaults from env.ts into workerConfig.vars without
  // shadowing values already provided by .env files / shell. Wired into
  // envSchemaPlugin's onDefaults callback for CF targets only (the node
  // target reads from process.env at runtime).
  function applySchemaDefaultsToWorkerVars(defaults: Record<string, string>): void {
    const vars = (workerConfig.vars as Record<string, string> | undefined) ?? {};
    for (const [key, value] of Object.entries(defaults)) {
      if (vars[key] === undefined) {
        vars[key] = value;
      }
    }
    workerConfig.vars = vars;
  }

  // Plugin that loads .env files and merges them into workerConfig.vars.
  // Runs before the Cloudflare plugin so vars are available as worker bindings.
  //
  // The `{ mode, envDir }` this hook OBSERVES (raw, root-relative) is exposed via `api` so the
  // self-host `void deploy --backend cloudflare` secret preflight can validate the SAME `.env*`
  // set the build ships. It must be captured HERE, at this hook's position, not read off the
  // final `resolved.envDir`: config hooks run in sequence, and a LATER plugin's `config` hook
  // that returns a different `envDir` would change `resolved.envDir` while this hook already
  // loaded env from the value it saw — the preflight reading the final value would then diverge
  // from what the build baked.
  let voidDeployBuildConfig: { mode: string; envDir: string | undefined } | undefined;
  let loadedUserEnv: Record<string, string> | undefined;
  const envPlugin: Plugin = {
    name: 'void:env',
    api: {
      getVoidDeployBuildConfig: (): { mode: string; envDir: string | undefined } | undefined =>
        voidDeployBuildConfig,
    },
    config(userConfig, { mode, command, isPreview }) {
      viteCommand = command;
      // `dev` is the Vite dev server only. Every build, `void deploy`, and
      // `vite preview` (which reports `command: 'serve'`) is `prod`.
      routeEnvironment = command === 'serve' && !isPreview ? 'dev' : 'prod';
      // Re-resolve now that the environment is known — the construction-time
      // value below always assumes `prod`.
      //
      // The guard is NOT an optimization. `envPlugin` is also returned by the
      // framework and node-target branches, and both of those `return` before
      // `ssrEntry` / `hasPages` / `hasMiddleware` are declared. Calling
      // `resolveConfiguredAssetRoutingPolicy()` there throws a TDZ
      // `ReferenceError`. Those branches also must not write
      // `workerConfig.assets` at all — `mergeBindings` keys off it staying
      // unset.
      if (!framework && !isNodeTarget(config.target)) {
        assetRouting = resolveConfiguredAssetRoutingPolicy();
        applyAssetRoutingPolicy(assetRouting);
      }
      // Exclude the .void cache directory from the file watcher so that
      // miniflare SQLite writes don't trigger infinite HMR refreshes.
      const ignored = ['**/.void/**'];
      // Honour the user's `envDir` config — projects that keep .env files
      // in `config/` or similar would otherwise be silently ignored. Falls
      // back to the project root, matching Vite's own default.
      const rawEnvDir =
        typeof userConfig.envDir === 'string' && userConfig.envDir.length > 0
          ? userConfig.envDir
          : undefined;
      voidDeployBuildConfig = { mode, envDir: rawEnvDir };
      const envDir = rawEnvDir ? join(root, rawEnvDir) : root;
      // loadEnv with prefix "" returns .env file vars AND all process.env vars.
      // filterLoadedEnv strips shell pollution (PATH, HOME, etc.) so only
      // .env-file vars reach worker bindings. stripInternalEnvKeys then
      // removes any internal Void keys a user may have set in their .env
      // files, so they can't hijack credential-shaped worker bindings.
      const filtered = filterLoadedEnv(
        loadEnv(mode, envDir, ''),
        initialFrameworkShellEnv ?? process.env,
      );
      const { sanitized: env, stripped } = stripInternalEnvKeys(filtered);
      loadedUserEnv = env;
      if (stripped.length > 0) {
        voidWarn(
          `Ignoring internal env keys from .env files: ${stripped.join(', ')}. These are reserved for Void runtime use.`,
        );
      }
      workerConfig.vars = { ...(workerConfig.vars as Record<string, string> | undefined), ...env };

      // In dev, keep document requests on the user worker. If this is deleted,
      // the CF router may route a page request to the user worker, the dev
      // override sends that request back through Vite middleware, and Vite's
      // final Cloudflare handler routes it to the CF router again. Workerd
      // reports that loop as a hung request.
      //
      // Vite's own module URLs still need to bypass the worker so HMR,
      // virtual modules, and dev CSS are served by Vite middleware directly.
      const assets = workerConfig.assets as { run_worker_first?: Array<string> } | undefined;
      if (command === 'serve' && !isPreview && assets?.run_worker_first?.includes('/**')) {
        assets.run_worker_first = [...DEV_ASSET_ROUTING_EXCLUSIONS, '/**'];
      }

      const watchConfig = { server: { watch: { ignored } } };

      // Minify worker bundles for smaller deploys (skip when output: "static"
      // because prerendering runs the SSR bundle in Miniflare, which cannot
      // resolve template-literal dynamic imports produced by the minifier)
      if (!isNodeTarget(config.target) && config.output !== 'static') {
        const envNames = framework === 'vinext-app' ? ['rsc', 'ssr'] : ['ssr'];
        return {
          ...watchConfig,
          environments: Object.fromEntries(envNames.map((n) => [n, { build: { minify: true } }])),
        };
      }

      return watchConfig;
    },
    configureServer(server) {
      // Defer status messages until after Vite prints "ready" so they're visible.
      const afterReady = (fn: () => void) => {
        if (server.httpServer) {
          server.httpServer.once('listening', () => setTimeout(fn, 100));
        } else {
          fn();
        }
      };

      // Remote mode status — log which bindings are using the proxy
      if (remoteMode && (bindings.needsD1 || bindings.needsKV || bindings.needsR2)) {
        const credentials = readVoidDevCredentials(root);
        if (credentials.status === 'ok') {
          const lines = ['\x1b[36mRemote bindings active\x1b[39m'];
          if (bindings.needsD1) {
            lines.push('  DB      \x1b[2m→ remote D1\x1b[22m');
          }
          if (bindings.needsKV) {
            lines.push('  KV      \x1b[2m→ remote KV\x1b[22m');
          }
          if (bindings.needsR2) {
            lines.push('  STORAGE \x1b[2m→ remote R2\x1b[22m');
          }
          afterReady(() => {
            console.log();
            voidLog(lines.join('\n         '));
          });
        } else if (credentials.status === 'no-token') {
          afterReady(() => {
            console.log();
            voidWarn('Remote mode requires authentication. Run `void auth login`, then restart.');
            voidWarn('Falling back to local bindings.');
          });
        } else {
          afterReady(() => {
            console.log();
            voidWarn('Remote mode requires a linked project. Run `void project link` first.');
            voidWarn('Falling back to local bindings.');
          });
        }
      }

      // AI onboarding: detect missing credentials early and guide users
      if (bindings.needsAI) {
        const credentials = readVoidDevCredentials(root);
        if (credentials.status === 'no-token') {
          afterReady(() => {
            console.log();
            voidWarn(
              'AI requires authentication. Run `void auth login`, then restart the dev server.',
            );
          });
        } else if (credentials.status === 'no-project') {
          if (process.stdin.isTTY) {
            // Fire-and-forget interactive setup
            afterReady(() => {
              console.log();
              runAiSetupPrompt(root, credentials.token, credentials.staging, server);
            });
          } else {
            afterReady(() => {
              console.log();
              voidWarn('AI requires a linked project. Run `void project link` to set one up.');
            });
          }
        }
      }
    },
  };

  // Binding watch plugin — detects new binding imports mid-session and
  // notifies the developer via terminal log + browser toast.
  const autoDetectBindings = !inferenceOptions;
  const autoDetectAuth = !authEnabled;
  const bindingWatchPlugin: Plugin = {
    name: 'void:binding-watch',
    apply: 'serve',
    configureServer(server) {
      if (!autoDetectBindings && !autoDetectAuth) {
        return;
      }
      const effectiveDirs = scanDirs ?? DEFAULT_SCAN_DIRS;
      const watchDirs = [...new Set([...effectiveDirs, 'src'])].map((d) => join(root, d));
      let hintShown = false;
      const check = (path: string) => {
        if (hintShown) {
          return;
        }
        if (!watchDirs.some((d) => path.startsWith(d))) {
          return;
        }
        try {
          const code = readFileSync(path, 'utf-8');
          const fileBindings = inferBindingsFromSource(code, path.split('/').pop()!);
          const newBindings: Array<string> = [];
          if (autoDetectBindings) {
            if (fileBindings.needsD1 && !bindings.needsD1) {
              newBindings.push('D1 (void/db)');
            }
            if (fileBindings.needsKV && !bindings.needsKV) {
              newBindings.push('KV (void/kv)');
            }
            if (fileBindings.needsR2 && !bindings.needsR2) {
              newBindings.push('R2 (void/storage)');
            }
            if (fileBindings.needsAI && !bindings.needsAI) {
              newBindings.push('AI (void/ai)');
            }
            if (fileBindings.needsSandbox && !bindings.needsSandbox) {
              newBindings.push('Sandbox (void/sandbox)');
            }
          }
          if (autoDetectAuth && fileBindings.needsAuth) {
            newBindings.push('Auth (void/auth)');
          }
          if (newBindings.length > 0) {
            hintShown = true;
            const detected = newBindings.join(', ');
            setTimeout(() => {
              voidLog(`New ${detected} binding detected. Restart to apply.`);
            }, 300);
            server.hot.send({
              type: 'custom',
              event: 'void:new-binding',
              data: { message: `New ${detected} binding detected.` },
            });
          }
        } catch {
          // Ignore transient read errors while files are being written or removed.
        }
      };
      // Attach after the HTTP server is listening so initial plugin file
      // writes (typegen, entry generation) don't trigger a spurious check.
      const attach = () => {
        server.watcher.on('add', check);
        server.watcher.on('change', check);
      };
      if (server.httpServer) {
        server.httpServer.once('listening', attach);
      } else {
        attach();
      }
    },
  };

  if (framework) {
    workerConfig.main = getFrameworkEntry(
      framework,
      root,
      devTriggerToken,
      config.routing?.notFound,
    );
    // `routing.notFound` only reaches a Class A worker through the DEPLOYED
    // script's `assets` config, and Void writes none for these frameworks: the
    // Class A branch returns long before `applyAssetRoutingPolicy`, and writing
    // `not_found_handling` on its own is worse than nothing — Cloudflare's asset
    // layer would then answer unmatched requests itself and the framework worker
    // would never run (only `run_worker_first` sends them to the worker first,
    // and Void does not own `assets.binding`/`directory` here to complete that
    // policy). Managed `void deploy` supplies the policy out-of-band
    // (`runFullDeploy` → `resolveAssetConfig` → `manifest.assetConfig`), so it
    // IS honored there.
    //
    // On a hand-rolled `vite build && wrangler deploy` it is NOT necessarily
    // dropped, which is why this says "Void does not generate it" rather than
    // "it does nothing": the generated wrapper consumes `routing.notFound` and
    // serves through `env.ASSETS`, and `mergeBindings` leaves a Class A root
    // wrangler config's `assets` untouched (its gate needs `workerConfig.assets`,
    // which is never set here). So a user who declares a COMPLETE policy of their
    // own — `binding`, `directory`, `not_found_handling`, `run_worker_first` —
    // gets working behavior, and must not be told their config is inert. Warn
    // once per build, and only when this build is not a managed deploy
    // (`void deploy` sets `VOID_DEPLOY_BUILD` on the build child env).
    let notFoundIgnoredWarned = false;
    const frameworkBuildWrapperPlugin: Plugin = {
      name: 'void:framework-build-wrapper',
      configResolved(resolved) {
        if (resolved.command !== 'build') {
          return;
        }
        if (
          config.routing?.notFound !== undefined &&
          !process.env.VOID_DEPLOY_BUILD &&
          !notFoundIgnoredWarned
        ) {
          notFoundIgnoredWarned = true;
          voidWarn(
            `Void generates no asset routing policy for a ${framework} build, so "routing.notFound" in ` +
              'void.json is not written to the built worker config. On a self-hosted `vite build && ' +
              'wrangler deploy` it takes effect only if your own wrangler config declares a complete ' +
              '`assets` policy (`binding`, `directory`, `not_found_handling`, `run_worker_first`); ' +
              "otherwise Cloudflare's default applies. Managed `void deploy` supplies the policy for you.",
          );
        }
        generateClassATriggerWrapper(
          root,
          framework,
          getOriginalFrameworkEntry(framework, root),
          true,
          resolved.build.assetsDir,
          config.routing?.notFound,
        );
      },
    };
    const existingFlags = (workerConfig.compatibility_flags as Array<string> | undefined) ?? [];
    if (!existingFlags.includes('nodejs_compat')) {
      workerConfig.compatibility_flags = [...existingFlags, 'nodejs_compat'];
    }

    // vinext App Router uses RSC with SSR as child environment;
    // all other Class A frameworks and vinext Pages Router use plain SSR.
    const viteEnvironment: { name: string; childEnvironments?: Array<string> } =
      framework === 'vinext-app' ? { name: 'rsc', childEnvironments: ['ssr'] } : { name: 'ssr' };
    const redirectDbTypePaths = framework !== 'vinext-app' && framework !== 'vinext-pages';

    // vinext injects vite-tsconfig-paths which spams warnings for every
    // tsconfig that extends a non-existent .void/tsconfig.json. Void
    // already generates its own tsconfig — the plugin is unnecessary.
    const vinextCompat: import('vite').Plugin | undefined =
      framework === 'vinext-app' || framework === 'vinext-pages'
        ? {
            name: 'void:vinext-compat',
            enforce: 'pre',
            config(userConfig) {
              // Neuter vite-tsconfig-paths before Vite wires up hooks.
              // Must happen in `config` — by `configResolved` hooks are
              // already cached and can't be removed.
              const plugins = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
              for (const p of plugins) {
                if (
                  p &&
                  typeof p === 'object' &&
                  !Array.isArray(p) &&
                  'name' in p &&
                  (p as { name?: unknown }).name === 'vite-tsconfig-paths'
                ) {
                  const plugin = p as Record<string, unknown>;
                  for (const key of Object.keys(plugin)) {
                    if (key !== 'name' && typeof plugin[key] === 'function') {
                      plugin[key] = () => {};
                    }
                  }
                }
              }
            },
          }
        : undefined;

    return [
      createCloudflareBuiltinsExternalPlugin(),
      createWorkerEnvironmentSanitizerPlugin([
        viteEnvironment.name,
        ...(viteEnvironment.childEnvironments ?? []),
      ]),
      createWranglerCompatPersistPlugin(root, config),
      restartPlugin(),
      bindingWatchPlugin,
      envPlugin,
      envSchemaPlugin(root, {
        onDefaults: applySchemaDefaultsToWorkerVars,
        getValidationEnv: () => loadedUserEnv,
      }),
      envClientGuardPlugin(root),
      envClientFoldPlugin(),
      clientStubsPlugin,
      bindingRuntimePlugin(bindingNames),
      drizzlePlugin(root, false, getDatabaseDialect(config), {
        d1BindingName: bindingNames?.d1,
        forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
        localD1PersistRoot: options?.persistTo ?? outDir,
        redirectDbTypePaths,
      }),
      migrationPlugin(root, getDatabaseDialect(config)),
      ...(vinextCompat ? [vinextCompat] : []),
      frameworkBuildWrapperPlugin,
      frameworkTriggersPlugin(root, { devTriggerToken }),
      devTriggersHintPlugin(root, { framework: true, devTriggerToken }),
      ...cloudflare({
        ...inspectorPortOption,
        persistState: { path: options?.persistTo ?? outDir },
        auxiliaryWorkers: options?.auxiliaryWorkers,
        viteEnvironment,
        config: mergeBindings,
      }),
    ];
  }

  // Default mode: full Hono routing + generated entry

  // Non-CF targets: skip binding inference, D1, migrations, wrangler
  if (isNodeTarget(config.target)) {
    if (authEnabled) {
      throw new Error(
        'auth: Void-managed Better Auth is only supported in Cloudflare Void apps. Use Better Auth directly for this target instead.',
      );
    }
    if (config.inference?.bindings) {
      voidWarn('"inference.bindings" in void.json is ignored with target: "' + config.target + '"');
    }
    if (config.worker) {
      voidWarn('"worker" in void.json is ignored with target: "' + config.target + '"');
    }
    if (config.remote) {
      voidWarn('"remote" in void.json is ignored with target: "' + config.target + '"');
    }
    if (bindings.needsSandbox) {
      throw new Error(
        `sandbox: Cloudflare Sandboxes require target: "cloudflare". They are not available with target: '${config.target}'.`,
      );
    }
    if (bindings.needsLive) {
      throw new Error(
        `live: void/live requires target: "cloudflare". It is not available with target: '${config.target}'.`,
      );
    }
    if (config.routing?.revalidate) {
      voidWarn(
        '"routing.revalidate" in void.json is ignored with target: "' +
          config.target +
          '" (edge caching is CF-only)',
      );
    }

    return [
      restartPlugin(),
      envPlugin,
      envSchemaPlugin(root, { getValidationEnv: () => loadedUserEnv }),
      ...pagesDevCssAssetsPlugin(root, devTriggerToken),
      routingPlugin(root, {
        isAuthEnabled: () => false,
        devTriggerToken,
        headConfig: config.head,
        output: config.output,
        prerenderPaths: config.routing?.prerender,
        target: config.target as 'node' | 'bun' | 'deno',
        // Pass the full routing section so the plugin can merge
        // `public/_redirects` / `public/_headers` with `void.json` rules at
        // `configResolved` time and again on HMR (parity with deploy).
        routing: config.routing,
        hasSandbox: false,
      }),
      prerenderPlugin(root, config),
      ...nodeTargetPlugin(config.target as 'node' | 'bun' | 'deno'),
    ];
  }

  // Void-managed auth uses native node:crypto password hashing.
  // PostgreSQL needs nodejs_compat for the `pg` driver (events, net, tls, dns, etc.).
  // Cloudflare's Sandbox SDK also imports Node built-ins.
  // Other apps only need nodejs_als for AsyncLocalStorage (isomorphic fetch context threading).
  const existingFlags = (workerConfig.compatibility_flags as Array<string> | undefined) ?? [];
  const needsNodejsCompat = authEnabled || dialect === 'postgresql' || bindings.needsSandbox;
  const normalizedFlags = normalizeWranglerCompatibilityFlags(existingFlags, {
    needsNodejsCompat,
  });
  if (normalizedFlags && normalizedFlags !== existingFlags) {
    workerConfig.compatibility_flags = normalizedFlags;
  }

  const jobs = scanJobsSync(root, paths.cronsDir);
  const ssrEntry = validateSsrEntry(root, paths);
  const hasPages = existsSync(paths.pagesDir);
  const hasMiddleware = scanMiddlewareSync(root, paths).length > 0;

  function resolveConfiguredAssetRoutingPolicy(): AssetRoutingPolicy {
    const routePatterns = scanRoutePatternsSync(root, paths, routeEnvironment);
    const environmentWebsocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, routeEnvironment),
    );
    return resolveAssetRoutingPolicy({
      isSsr: Boolean(ssrEntry),
      hasPages,
      hasApiRoutes:
        routeScanHasApiRoutes(routePatterns) ||
        routeScanHasApiRoutes(environmentWebsocketRoutes) ||
        authEnabled,
      hasDocumentRoutes: routeScanHasDocumentRoutes(routePatterns),
      hasMiddleware,
      hasWebSockets: routeScanHasDocumentRoutes(environmentWebsocketRoutes),
      authEnabled,
      liveEnabled: liveConfig !== undefined,
      notFound: config.routing?.notFound,
    });
  }

  // Provisional: `routeEnvironment` is still its `prod` default here, because no
  // `config` hook has run yet. `envPlugin.config` recomputes this before any
  // consumer reads it — `mergeBindings` runs inside the Cloudflare plugin's own
  // `config` hook, which Vite sorts after `envPlugin`'s. It is assigned here so
  // `assetRouting` is never read while unassigned.
  assetRouting = resolveConfiguredAssetRoutingPolicy();

  workerConfig.main = join(root, '.void', 'entry.ts');

  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: jobs.flatMap((job) => job.crons),
    };
  }

  function applyAssetRoutingPolicy(policy: AssetRoutingPolicy): void {
    workerConfig.assets = {
      binding: 'ASSETS',
      ...policy.assetConfig,
    };
  }

  function updateDevAssetRoutingPolicy(next: AssetRoutingPolicy): boolean {
    const previous = assetRouting;
    const requiresRestart =
      previous.workerFirst !== next.workerFirst ||
      previous.apiWorkerFirst !== next.apiWorkerFirst ||
      previous.assetConfig.not_found_handling !== next.assetConfig.not_found_handling ||
      JSON.stringify(previous.assetConfig.run_worker_first) !==
        JSON.stringify(next.assetConfig.run_worker_first);
    assetRouting = next;
    if (requiresRestart) {
      applyAssetRoutingPolicy(next);
    }
    return requiresRestart;
  }

  applyAssetRoutingPolicy(assetRouting);

  return [
    createCloudflareBuiltinsExternalPlugin(),
    createDefaultWorkerEnvironmentPlugin(),
    createWorkerEnvironmentSanitizerPlugin([DEFAULT_WORKER_ENVIRONMENT_NAME]),
    createWranglerCompatPersistPlugin(root, config),
    restartPlugin(),
    bindingWatchPlugin,
    envPlugin,
    envSchemaPlugin(root, {
      onDefaults: applySchemaDefaultsToWorkerVars,
      getValidationEnv: () => loadedUserEnv,
    }),
    envClientGuardPlugin(root),
    envClientFoldPlugin(),
    clientStubsPlugin,
    bindingRuntimePlugin(bindingNames),
    ...(bindings.needsSandbox ? [createSandboxSdkResolvePlugin()] : []),
    ...pagesDevCssAssetsPlugin(root, devTriggerToken),
    routingPlugin(root, {
      isAuthEnabled: () => authEnabled,
      devTriggerToken,
      headConfig: config.head,
      output: config.output,
      prerenderPaths: config.routing?.prerender,
      remoteMode,
      // Pass the full routing section so the plugin can merge
      // `public/_redirects` / `public/_headers` with `void.json` rules for
      // dev-time parity with the deployment runtime. In production the
      // platform dispatch worker owns the pipeline and the plugin compiles
      // these rules out of the worker bundle.
      routing: config.routing,
      bindingNames,
      hasSandbox: bindings.needsSandbox,
      sandboxBindingName: sandboxConfig?.binding,
      sandboxClassName: sandboxConfig?.className,
      live: liveConfig,
      onDevAssetRoutingPolicyChange: updateDevAssetRoutingPolicy,
    }),
    drizzlePlugin(root, true, dialect, {
      d1BindingName: bindingNames?.d1,
      forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
      localD1PersistRoot: options?.persistTo ?? outDir,
    }),
    migrationPlugin(root, dialect, 'local', join(root, '.void'), {
      enabled: authEnabled,
      configPath: authConfigPath,
    }),
    prerenderPlugin(root, config),
    devTriggersHintPlugin(root, { framework: false, devTriggerToken }),
    ...cloudflare({
      ...inspectorPortOption,
      persistState: { path: options?.persistTo ?? outDir },
      auxiliaryWorkers: options?.auxiliaryWorkers,
      viteEnvironment: { name: DEFAULT_WORKER_ENVIRONMENT_NAME },
      config: mergeBindings,
    }),
  ];
}

// Re-export runtime types and functions
export {
  defineHandler,
  defineMiddleware,
  basicAuth,
  defineScheduled,
  defineRender,
  defineHead,
  defineQueue,
  VoidAssetRewriteError,
} from './runtime/handler.ts';
export type {
  CloudContext,
  CloudContextVariables,
  CloudEnv,
  BasicAuthOptions,
  RenderAssetTags,
  TypedHandler,
  TypedQueueHandler,
  QueueBatch,
  QueueMessage,
  QueueRetryOptions,
} from './runtime/handler.ts';
export type { ValidatorSlots, HandlerInput } from './runtime/validator.ts';
export type { AuthUser } from './runtime/auth.ts';
export type { QueueMap } from './runtime/queues.ts';
export { defer } from './pages/defer.ts';
export type { Deferred, DeferredState, InferProps } from './pages/defer.ts';
export type { HeadDescriptor } from './pages/head.ts';
