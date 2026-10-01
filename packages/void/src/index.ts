import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { appendSqliteClassMigration } from '@void/deploy-core';
import { join, resolve } from 'pathslash';
import pc from 'picocolors';
import { type Plugin } from 'vite';
import { analyzeApplicationSync, type ApplicationAnalysis } from './application-analysis.ts';
import { applyBindingOverrides } from './application-features.ts';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetRoutingPolicy,
  type AssetRoutingPolicy,
} from './asset-routing.ts';
import { getApiUrl, getProxyUrl, getToken, isStagingMode } from './cli/auth.ts';
import { ensurePlatformProxyAccess } from './cli/cf-access.ts';
import { SEND_EMAIL_BINDING } from './cli/email-cloudflare.ts';
import { mergeRoutingRules } from './cli/headers.ts';
import { readDeploymentPlatform, readProjectConfig } from './cli/project.ts';
import {
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  findBindingNameOwner,
  hasDurableObjectSqliteMigration,
  LIVE_MIGRATION_TAG,
  normalizeWranglerCompatibilityFlags,
  nextDurableObjectMigrationTag,
  readWranglerCompat,
  readWranglerWebSocketTombstones,
  readExistingLiveBindingConfig,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  syncWranglerDurableObjects,
  syncWranglerWebSockets,
} from './cli/wrangler.ts';
import {
  materializeCloudflareConfig,
  restoreCloudflarePreviewPointer,
  stashCloudflareDeployPointer,
} from './cloudflare-config.ts';
import { finalizeDurableObjectPatch } from './cloudflare-durable-patch.ts';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import { readConfig, isNodeTarget, type NotFoundHandling } from './config.ts';
import { inferBindingsFromSource } from './inference/walk.ts';
import { resolveLocalD1Target, writeLocalD1PersistState } from './local-d1.ts';
import { voidLog, voidWarn, voidError } from './log.ts';
import { pagesDevCssAssetsPlugin } from './pages/dev-css-assets.ts';
import { bindingRuntimePlugin } from './plugin-binding-runtime.ts';
import { devTriggersHintPlugin } from './plugin-dev-triggers-hint.ts';
import { drizzlePlugin } from './plugin-drizzle.ts';
import { emailDevInboxPlugin } from './plugin-email-dev-inbox.ts';
import { envClientFoldPlugin } from './plugin-env-client-fold.ts';
import { envClientGuardPlugin } from './plugin-env-client-guard.ts';
import { envSchemaPlugin, type EnvSchemaFacts } from './plugin-env-schema.ts';
import {
  analogDevTriggerInjectPlugin,
  astroDevTriggerInjectPlugin,
  frameworkTriggersDispatchPath,
  frameworkTriggersPlugin,
  nitroDevTriggerInjectPlugin,
  writeFrameworkTriggersDispatch,
} from './plugin-framework-triggers.ts';
import { DEFAULT_SCAN_DIRS, FRAMEWORK_SCAN_DIRS, type Framework } from './plugin-inference.ts';
import { migrationPlugin } from './plugin-migration.ts';
import { nodeTargetPlugin } from './plugin-node-target.ts';
import { prerenderPlugin } from './plugin-prerender.ts';
import { restartPlugin } from './plugin-restart.ts';
import { routingPlugin } from './plugin-routing.ts';
import { assertNoRootSourceConventionConflicts } from './project-paths.ts';
import { compileAssetFallbackHelper } from './router/compile.ts';
import { hasEmailHandlers } from './router/email.ts';
import { isRouteEnabledForEnvironment, type RouteEnvironment } from './router/parse-filename.ts';
import { DEV_INBOX_ENV_VAR, DEV_INBOX_TOKEN_ENV_VAR } from './runtime/email/dev-inbox.ts';
import {
  SANDBOX_MIGRATION_TAG,
  hasSandboxSqliteMigration,
  resolveSandboxConfig,
  sandboxContainerConfig,
  assertSandboxNamespaceConfig,
} from './sandbox/config.ts';
import { scopedAccessCredentials } from './shared/cf-access.ts';
import {
  CLOUDFLARE_DEPLOY_BUILD_ENV,
  loadLocalEnv,
  resolveRemoteMode,
  stripInternalEnvKeys,
} from './shared/env.ts';
import {
  CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  selectNativeVersionMetadataBinding,
} from './shared/version-metadata.ts';
import { validateSsrEntry } from './ssr/entry.ts';
import { injectSvelteKitHooks } from './sveltekit-hooks-transform.ts';

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
 *
 * The file is owner-only (0600). It is the one credential the dev-inbox
 * routes accept, and loopback is reachable by every account on the host,
 * so a default-umask 0644 file would hand any other local user the raw MIME,
 * the DELETE, and the capture endpoint. A file persisted by an earlier
 * release is tightened in place, never rotated. Windows has no group/other
 * bits — `mode` and `chmod` only toggle write there — so it is left alone.
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

const DEV_TRIGGER_TOKEN_FILE_MODE = 0o600;

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
  // Best-effort: a token we can read but not chmod (foreign owner, read-only
  // mount) must still start the dev server.
  const tightenExisting = (): void => {
    if (process.platform === 'win32') {
      return;
    }
    try {
      if ((statSync(tokenPath).mode & 0o077) !== 0) {
        chmodSync(tokenPath, DEV_TRIGGER_TOKEN_FILE_MODE);
      }
    } catch {
      // ignore
    }
  };

  const existing = readExisting();
  if (existing) {
    tightenExisting();
    return existing;
  }

  // Atomic create — `wx` fails with EEXIST if the file appeared between the
  // read above and the write below (parent + child Vite both racing). On
  // EEXIST we re-read the winner's token and use that, so both processes
  // converge on the same UUID.
  mkdirSync(join(root, '.void'), { recursive: true });
  const fresh = crypto.randomUUID();
  try {
    const fd = openSync(tokenPath, 'wx', DEV_TRIGGER_TOKEN_FILE_MODE);
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
    if (request.method === "POST") {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__void/scheduled" || pathname === "/__void/queue") {
        const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
        const response = await handleDevTrigger(request, env, ctx);
        if (response) return response;
      }
    }
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
 * Builds use the production binding. During dev, a project explicitly saved
 * with the direct Cloudflare destination uses Cloudflare's remote binding;
 * managed and unsaved projects keep using the Void HTTPS proxy.
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
  directCloudflareDev: boolean = false,
): boolean {
  return (
    needsAI &&
    (command === 'build' || (command === 'serve' && directCloudflareDev)) &&
    !resultAi &&
    !resolvedAi
  );
}

/**
 * Decide whether to inject the `void dev` email-inbox loopback var.
 *
 * The dev inbox buffer lives in the Vite dev server's Node process;
 * `sendEmail` runs in workerd and reaches it by fetching the inbox capture
 * endpoint through the worker's assets binding, which
 * `@cloudflare/vite-plugin` wires straight into the dev server's middleware
 * stack. The var carries that binding's NAME (`ASSETS` for a Void app, or
 * whatever a Class A framework's own wrangler config declares) and its
 * presence is what arms the dev path at runtime — so it must never reach a
 * production build's `wrangler.json`, exactly like the `__VOID_TOKEN`
 * credential gate.
 *
 * Gated on `routeEnvironment`, not on `command`: `vite preview` also reports
 * `command: 'serve'`, but it runs the BUILT worker whose assets binding is a
 * real asset directory rather than a dev-server loopback. `routeEnvironment`
 * is the existing `command === 'serve' && !isPreview` distinction.
 *
 * Without an assets binding there is no loopback, so injecting the var would
 * only arm a path that must then fail; gate on it instead.
 */
export function shouldInjectEmailDevInboxVar(
  routeEnvironment: RouteEnvironment,
  needsEmail: boolean | undefined,
  assetsBinding: string | undefined,
): boolean {
  return (
    routeEnvironment === 'dev' &&
    !!needsEmail &&
    typeof assetsBinding === 'string' &&
    !!assetsBinding
  );
}

/** Resolve the runtime Workers AI binding, preserving a root Wrangler declaration. */
export function resolveWorkersAiBindingName(resolvedAi: unknown, configuredName?: string): string {
  if (typeof resolvedAi === 'object' && resolvedAi !== null) {
    const binding = (resolvedAi as { binding?: unknown }).binding;
    if (typeof binding === 'string') {
      return binding;
    }
  }
  return configuredName ?? 'AI';
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
  | {
      status: 'ok';
      token: string;
      projectId: string;
      proxyUrl: string;
      accessCredentials?: string;
      staging?: boolean;
    }
  | { status: 'no-token' }
  | { status: 'no-project'; apiUrl: string; token: string; staging?: boolean };

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
  const apiUrl = getApiUrl(root);

  const project = readProjectConfig(root);
  if (!project) {
    return { status: 'no-project', apiUrl, token, staging };
  }

  const proxyUrl = getProxyUrl(root);
  ensurePlatformProxyAccess(apiUrl, proxyUrl);
  return {
    status: 'ok',
    token,
    projectId: project.projectId,
    proxyUrl,
    accessCredentials: scopedAccessCredentials(process.env, proxyUrl),
    staging,
  };
}

/**
 * Interactive AI setup prompt shown during dev server startup when the user
 * has a token but no linked project. Runs as fire-and-forget so it doesn't
 * block the server. On completion, writes project.json and restarts the server.
 */
async function runAiSetupPrompt(
  root: string,
  token: string,
  apiUrl: string,
  server: import('vite').ViteDevServer,
): Promise<void> {
  const { select, text, isCancel, log } = await import('@clack/prompts');
  const { PlatformClient } = await import('./cli/client.ts');
  const { attachSelectedPlatform, writeProjectConfig } = await import('./cli/project.ts');
  const { inferDefaultSlug } = await import('./cli/resolve-project.ts');

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
          if (isCancel(slugResult) || typeof slugResult === 'symbol') {
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

  writeProjectConfig(root, attachSelectedPlatform(root, { projectId, slug }, client.apiUrl));
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
 * The Cloudflare plugin reads Void's generated config and provides it to our
 * config function. Bindings already defined there (with real IDs for
 * production deployment) are preserved — we only add inferred bindings
 * that are missing. This allows `vite build && wrangler deploy` to work
 * for deploying directly to Cloudflare without the Void platform.
 */
const scheduledPointerCleanups = new Set<string>();
const scheduledPreviewPointerCleanups = new Set<string>();

export function voidPlugin(options?: {
  persistTo?: string;
  auxiliaryWorkers?: PluginConfig['auxiliaryWorkers'];
}): Array<Plugin> {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();
  const directCloudflareDestination = readDeploymentPlatform(root) === 'cloudflare';
  warnIfPackageJsonIsNotEsm(root);
  // Token only matters in serve — the dispatch module that uses it is
  // DCE'd from production worker bundles. In build/preview we still need
  // *some* string (the wrapper embeds it for completeness), but we skip
  // persisting it so build-only CI workflows don't materialize dev state.
  const devTriggerToken = isViteBuildOrPreview()
    ? crypto.randomUUID()
    : getOrCreateDevTriggerToken(root);
  const config = readConfig(root);
  const projectCloudflareConfigPath = !isNodeTarget(config.target)
    ? materializeCloudflareConfig(root)
    : undefined;
  const cloudflareConfigPath =
    projectCloudflareConfigPath && existsSync(projectCloudflareConfigPath)
      ? projectCloudflareConfigPath
      : undefined;
  let previewing = false;
  const implicitDeployGuard: Plugin = {
    name: 'void:remove-implicit-cloudflare-deploy-pointer',
    enforce: 'pre',
    config(_config, environment) {
      previewing = environment.isPreview === true;
      if (previewing && existsSync(join(root, 'void.config.ts'))) {
        if (restoreCloudflarePreviewPointer(root) && !scheduledPreviewPointerCleanups.has(root)) {
          scheduledPreviewPointerCleanups.add(root);
          process.once('exit', () => {
            rmSync(join(root, '.wrangler', 'deploy', 'config.json'), { force: true });
          });
        }
      }
    },
    closeBundle() {
      if (
        !previewing &&
        existsSync(join(root, 'void.config.ts')) &&
        process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] !== '1'
      ) {
        const removePointer = () => stashCloudflareDeployPointer(root);
        if (detected?.name === 'astro') {
          // Astro previews the built Worker after Vite closes its bundle.
          if (!scheduledPointerCleanups.has(root)) {
            scheduledPointerCleanups.add(root);
            process.once('exit', removePointer);
          }
        } else {
          removePointer();
        }
      }
    },
  };
  let application = analyzeApplicationSync(root, { config });
  const { paths, dialect, bindingNames, authConfigPath } = application;
  const analyses = new Map<RouteEnvironment | undefined, ApplicationAnalysis>([
    [undefined, application],
  ]);
  const getApplicationAnalysis = (environment: RouteEnvironment, refresh = false) => {
    let result = refresh ? undefined : analyses.get(environment);
    if (!result) {
      result = analyzeApplicationSync(root, { config, environment });
      analyses.set(environment, result);
    }
    application = result;
    return result;
  };
  let routeEnvironment: RouteEnvironment = 'prod';
  assertNoRootSourceConventionConflicts(paths);
  const detected = application.framework;
  const framework = detected?.class === 'a' ? (detected.name as Framework) : undefined;

  // Infer bindings synchronously from source files
  const scanDirs = config.inference?.scanDirs ?? (detected ? FRAMEWORK_SCAN_DIRS : undefined);
  const frameworkOwnsCloudflareRuntime =
    detected !== undefined && (detected.class === 'b' || detected.class === 'c');
  const localD1PersistRoot = frameworkOwnsCloudflareRuntime
    ? join(root, '.wrangler', 'state')
    : (options?.persistTo ?? join(root, '.void'));
  const localD1 = resolveLocalD1Target(root, {
    bindingName: bindingNames?.d1 ?? 'DB',
    persistRoot: localD1PersistRoot,
  });
  writeLocalD1PersistState(
    root,
    !isNodeTarget(config.target) && !frameworkOwnsCloudflareRuntime
      ? options?.persistTo
      : undefined,
  );
  let bindings = application.bindings;
  const sandboxConfig = bindings.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  let authEnabled = application.authEnabled;

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
  // Inbound handlers are compiled into the worker's `email()` export by
  // `routingPlugin`, which no framework branch installs — the framework
  // wrapper wires crons and queues only. Without this guard the build
  // succeeds, every file in `email/` is dead code, and inbound mail bounces
  // at the platform with a message telling the user to redeploy.
  //
  // Gated on the handler DIRECTORY, not on `bindings.needsEmail`. Outbound
  // `sendEmail` is a binding rather than a compiled export, so it keeps
  // working in every framework and must not be caught here.
  const hasInboundEmail = hasEmailHandlers(application.email);
  if (detected && hasInboundEmail) {
    throw new Error(
      'email: inbound email handlers are only supported in Void apps. Remove the email/ directory — `sendEmail` from void/email keeps working.',
    );
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
    // client-side `instanceof` check for either runtime error doesn't crash with a
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
      export class SandboxUnavailableError extends Error {
        constructor(message = 'Managed Sandbox is unavailable on this Void platform.') {
          super(message);
          this.name = 'SandboxUnavailableError';
        }
      }
      export async function getSandbox() {
        throw new Error('void/sandbox is server-only and cannot be imported by browser code.');
      }
      export const sandbox = { get: getSandbox };
    `,
    // Server-only for the same reason as the rest: `void/email` reaches
    // `runtime/env-raw.ts`, whose top-level `node:async_hooks` import and
    // module-scope `new AsyncLocalStorage()` have no browser equivalent.
    // Without a stub the client build SUCCEEDS with only an externalization
    // warning and ships `new (emptyStub).AsyncLocalStorage` — the page then
    // white-screens on load, which is worse than a build failure.
    // `void/email/testing` needs its own entry (the filter is anchored) for
    // a different reason: it pulls `router/email.ts`, dragging node:path,
    // node:fs and node:module plus ~24 KB of build-time router machinery
    // into the browser bundle.
    //
    // Throwing rather than returning `{}`, following `void/sandbox`: an
    // accidental client import should fail legibly instead of silently
    // no-oping a send the caller believes happened.
    'void/email': `
      const serverOnly = (name) => () => {
        throw new Error(name + ' is server-only and cannot be imported by browser code.');
      };
      export const sendEmail = serverOnly('sendEmail');
      export const createEmail = serverOnly('createEmail');
      export const defineEmail = serverOnly('defineEmail');
      export const parseEmail = serverOnly('parseEmail');
      export const replyEmail = serverOnly('replyEmail');
      export const createMessageProxy = serverOnly('createMessageProxy');
    `,
    'void/email/testing': `
      const serverOnly = (name) => () => {
        throw new Error(name + ' is server-only and cannot be imported by browser code.');
      };
      export const createEmailTestHarness = serverOnly('createEmailTestHarness');
      export const createInboundTestHarness = serverOnly('createInboundTestHarness');
    `,
    'void/live': '',
    'void/durable': '',
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
          if (id === 'void/live' || id === 'void/durable') {
            this.error(
              id === 'void/live'
                ? 'void/live is server-only and cannot be imported by browser code. Import void/live/client instead.'
                : 'void/durable is server-only and cannot be imported by browser code.',
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

  // Generated server entries import the env module by its resolved file path.
  // Prebundling a bare `void` runtime subpath creates another package module
  // graph and therefore another envContext, so request bindings disappear for
  // the prebundled copy. Every return path includes this plugin, including
  // framework and Node targets that do not all use bindingRuntimePlugin.
  const serverRuntimeOptimizerPlugin: Plugin = {
    name: 'void:server-runtime-optimizer',
    configEnvironment(name) {
      if (name !== 'client') {
        return { optimizeDeps: { exclude: ['void'] } };
      }
    },
  };

  // Scan queues/websocket routes early so both framework-mode and default-mode
  // branches can safely close over these bindings.
  const queues = framework ? [] : application.queues;
  // Deliberately scanned with NO environment: this list is the superset used to
  // RESERVE binding and Durable Object class names below, and reservation must
  // not depend on which command is running. A filtered list would let the live
  // DO resolve to `VOID_LIVE` under `vite dev` and `VOID_LIVE_2` under
  // `vite build` for the same project. Consumers that emit config rather than
  // reserve names re-filter by `routeEnvironment` (see `mergeBindings` and
  // `resolveConfiguredAssetRoutingPolicy`).
  const websocketRoutes = framework ? [] : application.allWebsockets;
  const durableObjects = application.durableObjects;
  if (detected && durableObjects.length > 0) {
    throw new Error(
      'durable: durable-objects/ is currently supported in Void apps only, not framework adapter mode.',
    );
  }
  for (const module of durableObjects) {
    const websocketCollision = websocketRoutes.find(
      (route) => route.bindingName === module.bindingName || route.className === module.className,
    );
    if (websocketCollision) {
      throw new Error(
        `durable: durable-objects/${module.filePath.split('/').pop()} conflicts with WebSocket route '${websocketCollision.filePath}'. Rename one of the files.`,
      );
    }
    if (
      sandboxConfig &&
      (sandboxConfig.binding === module.bindingName || sandboxConfig.className === module.className)
    ) {
      throw new Error(
        `durable: durable-objects/${module.filePath.split('/').pop()} conflicts with the configured Sandbox binding or class. Rename the Durable Object file.`,
      );
    }
  }
  let websocketTombstones: Array<string> = [];
  if (!isNodeTarget(config.target)) {
    syncWranglerDurableObjects(root, durableObjects);
    const productionWebSocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, 'prod'),
    );
    syncWranglerWebSockets(root, productionWebSocketRoutes);
    websocketTombstones = readWranglerWebSocketTombstones(root, productionWebSocketRoutes);
  }
  const existingLiveConfig = !isNodeTarget(config.target)
    ? readExistingLiveBindingConfig(root)
    : undefined;
  const liveConfig = !isNodeTarget(config.target)
    ? bindings.needsLive
      ? resolveLiveBindingConfig(root, {
          reservedBindings: [
            ...websocketRoutes.map((route) => route.bindingName),
            ...durableObjects.map((module) => module.bindingName),
          ],
          reservedClasses: [
            ...websocketRoutes.map((route) => route.className),
            ...durableObjects.map((module) => module.className),
            sandboxConfig?.className,
          ],
        })
      : existingLiveConfig
    : undefined;
  const shouldEmitLive = () => bindings.needsLive || existingLiveConfig !== undefined;

  // Class B/C: lighter composition — DB types + migrations only.
  // The framework's own adapter handles the CF worker build and dev server.
  // voidPlugin() only provides DB type codegen, migration management, and
  // wrangler.jsonc binding sync for local dev.
  if (detected && (detected.class === 'b' || detected.class === 'c')) {
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

  // Remote mode — use platform proxy for D1/KV/R2 instead of local miniflare.
  const remoteMode = resolveRemoteMode(config.remote);

  // Core worker config — always set by voidPlugin (main, triggers, assets).
  // Bindings are handled separately in the config function below.
  const workerConfig: Record<string, unknown> = {};
  const jobs = application.jobs;
  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: [...new Set(jobs.flatMap((job) => job.crons))],
    };
  }
  let envSchemaFacts: EnvSchemaFacts | undefined;
  let assetRouting: AssetRoutingPolicy;
  if (config.worker?.vars) {
    workerConfig.vars = { ...config.worker.vars };
  }

  // Tracks whether vite is running in dev or build mode. Set early in
  // envPlugin.config so mergeBindings can gate credential injection on 'serve'.
  let viteCommand: 'serve' | 'build' = 'build';
  let versionMetadataBinding: string | undefined;

  // Merge curated wrangler fields from void.config.ts
  const wranglerCompat = isNodeTarget(config.target) ? undefined : readWranglerCompat(root, config);
  if (wranglerCompat) {
    workerConfig.compatibility_date = wranglerCompat.compatibilityDate;
    if (wranglerCompat.compatibilityFlags) {
      workerConfig.compatibility_flags = wranglerCompat.compatibilityFlags;
    }
  }
  // CPU cap from void.config.ts `worker.limits.cpu_ms` (validated in config.ts as an
  // integer 1..300000). The CF plugin passes `limits` through into the generated
  // `dist/ssr/wrangler.json`, so a self-host `wrangler deploy` / `void deploy
  // --platform cloudflare` enforces it directly. Managed `void deploy` ignores
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

    // The Cloudflare plugin defu-merges this patch over resolved, concatenating arrays.
    // Flags read from the root config therefore occur in both inputs. Emit their union
    // once and clear only the in-memory fallback so uploads never repeat a flag.
    result.compatibility_flags = [
      ...new Set([
        ...((result.compatibility_flags as Array<string> | undefined) ?? []),
        ...(resolved.compatibility_flags ?? []),
      ]),
    ];
    resolved.compatibility_flags = [];

    if (envSchemaFacts || (authEnabled && process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1')) {
      const plaintextVars = {
        ...((resolved.vars as Record<string, unknown> | undefined) ?? {}),
        ...((result.vars as Record<string, unknown> | undefined) ?? {}),
      };
      const plaintextServerKeys = (envSchemaFacts?.serverKeys ?? []).filter(
        (key) => key in plaintextVars,
      );
      if (viteCommand === 'build' && plaintextServerKeys.length > 0) {
        throw new Error(
          `Server env keys cannot be Worker plaintext vars: ${plaintextServerKeys.join(', ')}. ` +
            'Remove them from worker.vars/wrangler vars and set them with the remote secret store.',
        );
      }
      const configuredRequired = resolved.secrets?.required ?? [];
      const required = [
        ...new Set([
          ...configuredRequired,
          ...(envSchemaFacts?.requiredServerKeys ?? []),
          ...(authEnabled && process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1'
            ? ['BETTER_AUTH_SECRET']
            : []),
        ]),
      ];
      if (required.length > 0) {
        result.secrets = { required };
      }
    }

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
      dialect === 'sqlite' &&
      application.needsDatabase &&
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

    // Workers AI — direct builds use the production binding. A saved direct
    // Cloudflare destination uses the owner's remote Workers AI binding during
    // dev because Workers AI has no local simulator. Managed and unsaved dev
    // projects continue through the Void HTTPS proxy below.
    // An explicit root binding keeps its name and staging choice. Direct dev
    // only adds `remote: true`, which is required because there is no local AI
    // simulator. Builds never override the user's root binding.
    const resolvedAi = (resolved as { ai?: unknown }).ai;
    const resultAi = (result as { ai?: unknown }).ai;
    const aiBindingName = resolveWorkersAiBindingName(resolvedAi, bindingNames?.ai);
    if (
      viteCommand === 'serve' &&
      bindings.needsAI &&
      directCloudflareDestination &&
      !resultAi &&
      typeof resolvedAi === 'object' &&
      resolvedAi !== null &&
      'binding' in resolvedAi &&
      typeof resolvedAi.binding === 'string'
    ) {
      // Preserve an explicit binding name and staging choice while selecting
      // its only supported local mode.
      (result as Record<string, unknown>).ai = { ...resolvedAi, remote: true };
    } else if (
      shouldBindWorkersAi(
        viteCommand,
        bindings.needsAI,
        resolvedAi,
        resultAi,
        directCloudflareDestination,
      )
    ) {
      (result as Record<string, unknown>).ai = {
        binding: aiBindingName,
        ...(viteCommand === 'serve' && { remote: true }),
      };
    }

    // AI binding name / Gateway id → runtime vars (harmless in serve; only read
    // by the P3 direct backend). The default binding needs no extra variable.
    if (aiBindingName !== 'AI' || config.ai?.gateway) {
      const vars = (result.vars as Record<string, string>) ?? {};
      if (aiBindingName !== 'AI') {
        vars.__VOID_AI_BINDING = aiBindingName;
      }
      if (config.ai?.gateway) {
        vars.__VOID_AI_GATEWAY = config.ai.gateway;
      }
      result.vars = vars;
    }

    // Email — no send binding is emitted on purpose. Outbound mail routes
    // through __VOID_PROXY/email/send (the proxy worker holds the
    // platform-level send_email binding), so `bindings.needsEmail` only gates
    // the dev-inbox plugin and the deploy manifest flag.
    //
    // Dev only: name the assets binding so `sendEmail` can loop back into the
    // Vite dev server and reach the `/__void/inbox` buffer, which lives in the
    // Node process rather than in this worker's isolate — and hand it the
    // dev-trigger token the inbox middleware requires on every route.
    const emailDevInboxBinding =
      (workerConfig.assets as { binding?: string } | undefined)?.binding ??
      (resolved.assets as { binding?: string } | undefined)?.binding;
    if (shouldInjectEmailDevInboxVar(routeEnvironment, bindings.needsEmail, emailDevInboxBinding)) {
      const vars = (result.vars as Record<string, string>) ?? {};
      vars[DEV_INBOX_ENV_VAR] = emailDevInboxBinding as string;
      vars[DEV_INBOX_TOKEN_ENV_VAR] = devTriggerToken;
      result.vars = vars;
    }

    // Serve never carries Void's own `send_email` binding, so the dev inbox
    // stays the only sink. `void deploy --platform cloudflare` writes
    // `send_email: [{ name: "SEND_EMAIL" }]` into the root wrangler.jsonc, and
    // `sendEmail` falls through to `env.SEND_EMAIL` whenever the inbox is not
    // armed (`sendInDev: true`, or no assets binding to reach the dev server
    // through) — under miniflare that binding writes .eml files to disk, or
    // with `remote: true` sends real mail. Only the entry under the reserved
    // `SEND_EMAIL` name is removed: a user's own `send_email` binding under
    // another name is theirs — nothing in Void reads it, and the root config
    // takes precedence — so it reaches miniflare exactly as declared. Gated on
    // `needsEmail`, the same signal that arms the inbox: without `void/email`
    // in the app there is no `sendEmail` to guard, and a `SEND_EMAIL` entry is
    // then either a stale leftover nothing reads or the user's own choice of
    // name; `void deploy` warns about the former and deploys as-is, and dev
    // must not be stricter about the root config than deploy is. Mutate
    // `resolved`, as the assets policy above does: the return value is
    // defu-merged over it (arrays concatenate, `undefined` is skipped), so
    // this is the only way to remove an entry. An emptied array drops the key
    // — the Cloudflare plugin treats `[]` and absent alike. Build passes the
    // root entries through untouched.
    if (viteCommand === 'serve' && bindings.needsEmail) {
      const sendEmail = (resolved as { send_email?: unknown }).send_email;
      if (Array.isArray(sendEmail)) {
        const kept = sendEmail.filter(
          (entry) => (entry as { name?: unknown } | null)?.name !== SEND_EMAIL_BINDING,
        );
        if (kept.length > 0) {
          (resolved as Record<string, unknown>).send_email = kept;
        } else {
          delete (resolved as Record<string, unknown>).send_email;
        }
      }
    }

    // Default sender for `sendEmail()` from void.config.ts `email.from`. Serve-only,
    // the same gate as `__VOID_TOKEN` — not because it is a credential, but
    // because on a build the root wrangler.jsonc already owns the var:
    // `void deploy --platform cloudflare` writes the same `__VOID_EMAIL_FROM`
    // there once the domain's routing or sending is ready, and that entry
    // reaches `dist/ssr/wrangler.json` through `resolved.vars`. Injecting it on
    // build too would advertise a sender on an account nothing was set up on.
    // The managed deploy ignores the generated wrangler config and injects its
    // own sender.
    if (viteCommand === 'serve' && config.email?.from) {
      const vars = (result.vars as Record<string, string>) ?? {};
      vars.__VOID_EMAIL_FROM = config.email.from;
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
      for (const route of environmentWebsocketRoutes) {
        const conflict = existingDurableObjectBindings.find(
          (binding) => binding.name === route.bindingName && binding.class_name !== route.className,
        );
        if (conflict) {
          throw new Error(
            `websocket: binding '${route.bindingName}' is already configured for class '${conflict.class_name}', but '${route.filePath}' requires '${route.className}'.`,
          );
        }
      }
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

      const currentMigrations = (resolved as Record<string, unknown>).migrations;
      const planned = appendSqliteClassMigration(
        Array.isArray(currentMigrations) ? currentMigrations : [],
        environmentWebsocketRoutes.map((route) => route.className),
        'void-ws-v1',
        existingDurableObjectBindings.map((binding) => binding.class_name),
      );
      if (planned.added) {
        (result as Record<string, unknown>).migrations = planned.migrations;
      }
    }

    if (durableObjects.length > 0) {
      const currentDurableObjects =
        ((result as Record<string, unknown>).durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined) ??
        ((resolved as Record<string, unknown>).durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined);
      const existingBindings = currentDurableObjects?.bindings ?? [];
      for (const module of durableObjects) {
        const conflict = existingBindings.find(
          (binding) =>
            binding.name === module.bindingName && binding.class_name !== module.className,
        );
        if (conflict) {
          throw new Error(
            `durable: binding '${module.bindingName}' is already configured for class '${conflict.class_name}', but durable-objects/ requires '${module.className}'.`,
          );
        }
      }
      const additions = durableObjects
        .filter(
          (module) => !existingBindings.some((binding) => binding.name === module.bindingName),
        )
        .map((module) => ({ name: module.bindingName, class_name: module.className }));
      if (additions.length > 0) {
        (result as Record<string, unknown>).durable_objects = {
          bindings: [...existingBindings, ...additions],
        };
      }

      const currentMigrations =
        (result as Record<string, unknown>).migrations ??
        (resolved as Record<string, unknown>).migrations;
      const existingMigrations = Array.isArray(currentMigrations)
        ? (currentMigrations as Array<{
            tag?: string;
            new_sqlite_classes?: Array<string>;
          }>)
        : [];
      for (const module of durableObjects) {
        const tagConflict = existingMigrations.find(
          (migration) =>
            migration.tag === module.migrationTag &&
            !migration.new_sqlite_classes?.includes(module.className),
        );
        if (tagConflict) {
          throw new Error(
            `durable: migration tag '${module.migrationTag}' is already used by another Durable Object migration.`,
          );
        }
      }
      const migrationAdditions = durableObjects
        .filter(
          (module) =>
            !existingMigrations.some(
              (migration) =>
                migration.tag === module.migrationTag ||
                migration.new_sqlite_classes?.includes(module.className),
            ),
        )
        .map((module) => ({
          tag: module.migrationTag,
          new_sqlite_classes: [module.className],
        }));
      if (migrationAdditions.length > 0) {
        (result as Record<string, unknown>).migrations = [
          ...existingMigrations,
          ...migrationAdditions,
        ];
      }
    }

    if (bindings.needsSandbox && sandboxConfig) {
      assertSandboxNamespaceConfig({ ...resolved, ...result }, sandboxConfig);
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
      (result as Record<string, unknown>).containers = [
        ...existingContainers.filter(
          (container) => container.class_name !== sandboxConfig.className,
        ),
        sandboxContainerConfig(sandboxConfig),
      ];
      // Cloudflare concatenates callback arrays with the resolved config. This
      // patch already contains every existing Container, so emit the list once.
      (resolved as Record<string, unknown>).containers = [];

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
      if (!hasSandboxSqliteMigration(existingMigrations, sandboxConfig.className)) {
        (result as Record<string, unknown>).migrations = [
          ...existingMigrations,
          {
            tag: SANDBOX_MIGRATION_TAG,
            new_sqlite_classes: [sandboxConfig.className],
          },
        ];
      }
    }

    if (shouldEmitLive() && liveConfig) {
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
    if (viteCommand === 'serve' && bindings.needsAI && !directCloudflareDestination) {
      const credentials = readVoidDevCredentials(root);
      if (credentials.status === 'ok') {
        // Prefer HTTPS proxy — inject credentials, skip direct AI binding
        const vars = (result.vars as Record<string, string>) ?? {};
        vars.__VOID_TOKEN = credentials.token;
        vars.__VOID_PROJECT_ID = credentials.projectId;
        vars.__VOID_PROXY_URL = credentials.proxyUrl;
        if (credentials.accessCredentials) {
          vars.__VOID_ACCESS_CREDENTIALS = credentials.accessCredentials;
        }
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
        vars.__VOID_PROXY_URL = credentials.proxyUrl;
        if (credentials.accessCredentials) {
          vars.__VOID_ACCESS_CREDENTIALS = credentials.accessCredentials;
        }
        vars.__VOID_TOKEN = credentials.token;
        vars.__VOID_PROJECT_ID = credentials.projectId;
        vars.__VOID_REMOTE = '1';
        result.vars = vars;
      }
    }

    versionMetadataBinding = selectNativeVersionMetadataBinding(
      resolved as Record<string, unknown>,
      {
        nativeBuild: viteCommand === 'build' && process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1',
        preserveBindings: process.env[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV] === '1',
      },
    );
    if (versionMetadataBinding) {
      const owner = findBindingNameOwner(result, 'version_metadata', versionMetadataBinding);
      if (owner) {
        throw new Error(
          `Cloudflare version metadata binding ${versionMetadataBinding} conflicts with ${owner}.`,
        );
      }
      if (!resolved.version_metadata) {
        result.version_metadata = { binding: versionMetadataBinding };
      }
    }
    finalizeDurableObjectPatch(resolved as Record<string, unknown>, result, [
      ...environmentWebsocketRoutes.map((route) => ({
        name: route.bindingName,
        class_name: route.className,
      })),
      ...durableObjects.map((module) => ({
        name: module.bindingName,
        class_name: module.className,
      })),
      ...(bindings.needsSandbox && sandboxConfig
        ? [{ name: sandboxConfig.binding, class_name: sandboxConfig.className }]
        : []),
      ...(shouldEmitLive() && liveConfig
        ? [{ name: liveConfig.bindingName, class_name: liveConfig.className }]
        : []),
    ]);
    return result as Partial<WorkerConfig>;
  }

  function applyEnvSchema(facts: EnvSchemaFacts): void {
    envSchemaFacts = facts;
  }

  // Plugin that loads the single local `.env` file into worker bindings for
  // local dev and preview only. Production values come from remote secrets;
  // builds never turn local dotenv entries into deployable Worker vars.
  const envPlugin: Plugin = {
    name: 'void:env',
    config(userConfig, { command, isPreview }) {
      viteCommand = command;
      // `dev` is the Vite dev server only. Every build, `void deploy`, and
      // `vite preview` (which reports `command: 'serve'`) is `prod`.
      routeEnvironment = command === 'serve' && !isPreview ? 'dev' : 'prod';
      application = getApplicationAnalysis(routeEnvironment);
      bindings = application.bindings;
      authEnabled = application.authEnabled;
      // `void cloudflare login` stores OAuth in Wrangler's OS-keychain-backed
      // credential store. The Cloudflare Vite plugin runs in this process, so
      // select that same store before it opens the remote Workers AI session.
      // Explicit API tokens remain Wrangler's highest-priority credential.
      if (command === 'serve' && directCloudflareDestination && bindings.needsAI) {
        process.env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
      }
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
        managedCloudflareBuild = command === 'build' && Boolean(process.env.VOID_DEPLOY_PROJECT_ID);
        assetRoutingPublicDir =
          userConfig.publicDir === false
            ? null
            : typeof userConfig.publicDir === 'string'
              ? resolve(root, userConfig.publicDir)
              : join(root, 'public');
        assetRouting = resolveConfiguredAssetRoutingPolicy();
        applyAssetRoutingPolicy(assetRouting);
      }
      // Exclude the .void cache directory from the file watcher so that
      // miniflare SQLite writes don't trigger infinite HMR refreshes.
      const ignored = ['**/.void/**'];
      if (command === 'serve') {
        const local = loadLocalEnv(root, { onWarn: (message) => voidWarn(message) });
        // Keep the dev Worker on the same values that env-schema validation
        // sees. Shell values override .env, and shell-only values are included
        // only when declared by the schema. Never copy unrelated host secrets.
        const devEnv = { ...local };
        for (const key of new Set([...Object.keys(local), ...(envSchemaFacts?.keys ?? [])])) {
          if (process.env[key] !== undefined) {
            devEnv[key] = process.env[key];
          }
        }
        const { sanitized: env, stripped } = stripInternalEnvKeys(devEnv);
        if (stripped.length > 0) {
          voidWarn(
            `Ignoring internal env keys from .env: ${stripped.join(', ')}. These are reserved for Void runtime use.`,
          );
        }
        workerConfig.vars = {
          ...(workerConfig.vars as Record<string, string> | undefined),
          ...env,
        };
        // The Cloudflare preview server runs the already-built wrangler
        // artifact and sources its declared secrets from process.env instead
        // of the in-memory worker config. Populate only missing entries so the
        // shell still wins and `.env` remains a local runtime input.
        if (isPreview) {
          for (const [key, value] of Object.entries(env)) {
            process.env[key] ??= value;
          }
        }
      }

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
            voidWarn(
              'Remote mode requires authentication. Run `void account login`, then restart.',
            );
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
      if (bindings.needsAI && !directCloudflareDestination) {
        const credentials = readVoidDevCredentials(root);
        if (credentials.status === 'no-token') {
          afterReady(() => {
            console.log();
            voidWarn(
              'AI requires authentication. Run `void account login`, then restart the dev server.',
            );
          });
        } else if (credentials.status === 'no-project') {
          if (process.stdin.isTTY) {
            // Fire-and-forget interactive setup
            afterReady(() => {
              console.log();
              runAiSetupPrompt(root, credentials.token, credentials.apiUrl, server);
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
  const autoDetectBindings = true;
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
          const fileBindings = applyBindingOverrides(
            inferBindingsFromSource(code, path.split('/').pop()!),
            config.inference?.bindings,
          );
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
            if (fileBindings.needsEmail && !bindings.needsEmail) {
              newBindings.push('Email (void/email)');
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
              'void.config.ts is not written to the built worker config. During a self-hosted build and ' +
              'direct Cloudflare deployment, it takes effect only if your own Cloudflare config declares a complete ' +
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
      ...(bindings.needsEmail ? [emailDevInboxPlugin({ devTriggerToken })] : []),
      envPlugin,
      envSchemaPlugin(root, { onSchema: applyEnvSchema }),
      envClientGuardPlugin(root),
      envClientFoldPlugin(),
      clientStubsPlugin,
      serverRuntimeOptimizerPlugin,
      bindingRuntimePlugin(bindingNames),
      drizzlePlugin(root, false, dialect, {
        d1BindingName: bindingNames?.d1,
        forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
        localD1DatabaseId: localD1.databaseId,
        localD1PersistRoot: localD1.persistRoot,
        redirectDbTypePaths,
      }),
      migrationPlugin(root, dialect, localD1.databaseId, localD1.persistRoot),
      ...(vinextCompat ? [vinextCompat] : []),
      frameworkBuildWrapperPlugin,
      frameworkTriggersPlugin(root, { devTriggerToken }),
      devTriggersHintPlugin(root, { framework: true, devTriggerToken }),
      ...cloudflare({
        configPath: cloudflareConfigPath,
        ...inspectorPortOption,
        persistState: { path: localD1.persistRoot },
        auxiliaryWorkers: options?.auxiliaryWorkers,
        viteEnvironment,
        config: mergeBindings,
      }),
      implicitDeployGuard,
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
      voidWarn(
        '"inference.bindings" in void.config.ts is ignored with target: "' + config.target + '"',
      );
    }
    if (config.worker) {
      voidWarn('"worker" in void.config.ts is ignored with target: "' + config.target + '"');
    }
    if (config.remote) {
      voidWarn('"remote" in void.config.ts is ignored with target: "' + config.target + '"');
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
    if (durableObjects.length > 0) {
      throw new Error(
        `durable: durable-objects/ requires target: "cloudflare". It is not available with target: '${config.target}'.`,
      );
    }
    // `compileNodeApp` imports only the Hono app from the route table; the
    // `__emailHandler` the table exports for `email/` is never invoked, so
    // without this the build succeeds and every inbound handler is dead code.
    if (hasInboundEmail) {
      throw new Error(
        `email: inbound email handlers (email/) require target: "cloudflare". They are not available with target: '${config.target}'.`,
      );
    }
    if (config.routing?.revalidate) {
      voidWarn(
        '"routing.revalidate" in void.config.ts is ignored with target: "' +
          config.target +
          '" (edge caching is CF-only)',
      );
    }

    return [
      restartPlugin(),
      envPlugin,
      serverRuntimeOptimizerPlugin,
      envSchemaPlugin(root),
      ...pagesDevCssAssetsPlugin(root, devTriggerToken),
      routingPlugin(root, {
        getApplicationAnalysis,
        isAuthEnabled: () => false,
        devTriggerToken,
        headConfig: config.head,
        output: config.output,
        prerenderPaths: config.routing?.prerender,
        target: config.target as 'node' | 'bun' | 'deno',
        // Pass the full routing section so the plugin can merge
        // `public/_redirects` / `public/_headers` with `void.config.ts` rules at
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
  const needsNodejsCompat = authEnabled || dialect !== 'sqlite' || bindings.needsSandbox;
  const normalizedFlags = normalizeWranglerCompatibilityFlags(existingFlags, {
    needsNodejsCompat,
  });
  if (normalizedFlags && normalizedFlags !== existingFlags) {
    workerConfig.compatibility_flags = normalizedFlags;
  }

  const ssrEntry = validateSsrEntry(root, paths);
  const hasPages = existsSync(paths.pagesDir);
  let assetRoutingPublicDir: string | null = join(root, 'public');
  let managedCloudflareBuild = false;

  function resolveConfiguredAssetRoutingPolicy(): AssetRoutingPolicy {
    const routePatterns = application.routes;
    const environmentWebsocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, routeEnvironment),
    );
    const policy = resolveAssetRoutingPolicy({
      isSsr: Boolean(ssrEntry),
      hasPages,
      hasApiRoutes:
        routeScanHasApiRoutes(routePatterns) ||
        routeScanHasApiRoutes(environmentWebsocketRoutes) ||
        authEnabled,
      hasDocumentRoutes: routeScanHasDocumentRoutes(routePatterns),
      hasMiddleware: application.middleware.length > 0,
      hasWebSockets: routeScanHasDocumentRoutes(environmentWebsocketRoutes),
      authEnabled,
      liveEnabled: shouldEmitLive() && liveConfig !== undefined,
      notFound: config.routing?.notFound,
    });
    const rules = mergeRoutingRules({ dir: assetRoutingPublicDir, routing: config.routing });
    const nativeOwnsEdgeRouting =
      !managedCloudflareBuild &&
      (rules.headerRules.length > 0 ||
        rules.redirectRules.length > 0 ||
        (rules.fallbackRules?.length ?? 0) > 0);
    if (nativeOwnsEdgeRouting) {
      // Cloudflare otherwise serves an existing asset before the generated
      // Worker can apply redirects or response headers. Native builds own the
      // rule pipeline, so send every path through the Worker first. Managed
      // builds keep their inferred policy because dispatch owns these rules.
      policy.assetConfig.run_worker_first = ['/**'];
      // A SPA asset binding resolves its shell before the Worker can observe
      // an asset miss. Disable that platform fallback when native fallback
      // rules exist, then restore the SPA shell in serveWithAssets after the
      // ordered user fallbacks have had their chance.
      if (
        rules.fallbackRules?.length &&
        policy.assetConfig.not_found_handling === 'single-page-application'
      ) {
        policy.assetConfig.not_found_handling = 'none';
        policy.workerSpaFallback = true;
      }
    }
    return policy;
  }

  // Provisional: `routeEnvironment` is still its `prod` default here, because no
  // `config` hook has run yet. `envPlugin.config` recomputes this before any
  // consumer reads it — `mergeBindings` runs inside the Cloudflare plugin's own
  // `config` hook, which Vite sorts after `envPlugin`'s. It is assigned here so
  // `assetRouting` is never read while unassigned.
  assetRouting = resolveConfiguredAssetRoutingPolicy();

  workerConfig.main = join(root, '.void', 'entry.ts');

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
    ...(bindings.needsEmail ? [emailDevInboxPlugin({ devTriggerToken })] : []),
    envPlugin,
    envSchemaPlugin(root, { onSchema: applyEnvSchema }),
    envClientGuardPlugin(root),
    envClientFoldPlugin(),
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    bindingRuntimePlugin(bindingNames),
    ...(bindings.needsSandbox ? [createSandboxSdkResolvePlugin()] : []),
    ...pagesDevCssAssetsPlugin(root, devTriggerToken),
    routingPlugin(root, {
      getApplicationAnalysis,
      isAuthEnabled: () => authEnabled,
      getVersionMetadataBinding: () => versionMetadataBinding,
      devTriggerToken,
      headConfig: config.head,
      output: config.output,
      prerenderPaths: config.routing?.prerender,
      remoteMode,
      // Pass the full routing section so the plugin can merge
      // `public/_redirects` / `public/_headers` with `void.config.ts` rules for
      // parity with the deployment runtime. Managed production builds omit
      // the rules because dispatch owns them; native builds keep them.
      routing: config.routing,
      bindingNames,
      get hasSandbox() {
        return bindings.needsSandbox;
      },
      sandboxBindingName: sandboxConfig?.binding,
      sandboxClassName: sandboxConfig?.className,
      sandboxInstanceType: sandboxConfig?.instanceType,
      get live() {
        return shouldEmitLive() ? liveConfig : undefined;
      },
      durableObjects,
      websocketTombstones,
      onDevAssetRoutingPolicyChange: updateDevAssetRoutingPolicy,
    }),
    drizzlePlugin(root, true, dialect, {
      d1BindingName: bindingNames?.d1,
      forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
      localD1DatabaseId: localD1.databaseId,
      localD1PersistRoot: localD1.persistRoot,
    }),
    migrationPlugin(root, dialect, localD1.databaseId, localD1.persistRoot, {
      enabled: authEnabled,
      configPath: authConfigPath,
    }),
    prerenderPlugin(root, config),
    devTriggersHintPlugin(root, { framework: false, devTriggerToken }),
    ...cloudflare({
      configPath: cloudflareConfigPath,
      ...inspectorPortOption,
      persistState: { path: localD1.persistRoot },
      auxiliaryWorkers: options?.auxiliaryWorkers,
      viteEnvironment: { name: DEFAULT_WORKER_ENVIRONMENT_NAME },
      config: mergeBindings,
    }),
    implicitDeployGuard,
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
