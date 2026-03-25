import type { HeaderRule, RedirectRule } from "../cli/types";
import type { VoidAuthProvider } from "../auth/providers";
import type { ScanResult } from "./scan";
import { resolveLayoutIds } from "../pages/layout-resolution";

/**
 * Script tag injected into dev HTML to load the binding-hint virtual module.
 * The virtual module (served by restartPlugin) listens for `void:new-binding`
 * HMR events and shows a toast with a click-to-restart action.
 */
const BINDING_HINT_SCRIPT = `<script type="module" src="/@id/virtual:void/binding-hint"></script>`;

export interface AuthCompileOptions {
  authRuntimePath: string;
  authConfigPath: string | null;
  authDatabasePath: string | null;
  authSchemaPath: string | null;
  dialect: "sqlite" | "postgresql";
  providers: readonly VoidAuthProvider[] | null;
}

export interface CompileOptions {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to the void/response module */
  responsePath: string;
  /** Absolute path to the void/_env module */
  runtimeEnvPath: string;
  /** Whether to inject React Fast Refresh preamble in dev SSR HTML. */
  reactRefresh: boolean;
  /** Auth configuration (null = disabled) */
  auth: AuthCompileOptions | null;
  /** Non-CF target — omits executionCtx from ALS context */
  nodeTarget?: boolean;
  /** Absolute path to the binding handler module (for /__void/* native binding access) */
  bindingHandlerPath?: string;
  /** Absolute path to the migration handler module */
  migrationHandlerPath?: string;
  /** Bundled migration SQL entries */
  migrations?: { name: string; sql: string }[];
  /** Migration dialect (sqlite or postgresql) */
  migrationDialect?: "sqlite" | "postgresql";
  /** Header rules from routing.headers config (node targets only) */
  headerRules?: HeaderRule[];
  /** Redirect rules from routing.redirects config (node targets only) */
  redirectRules?: RedirectRule[];
  /** Explicit prerender paths from void.json routing.prerender */
  explicitPrerenderPaths?: string[];
  /** Absolute path to the internal WebSocket runtime module */
  webSocketRuntimePath?: string;
}

export interface SsrCompileOptions {
  /** Absolute path to src/main.ssr.ts(x) */
  serverEntryPath: string;
  /** Relative project path for src/main.client.ts(x), e.g. src/main.client.tsx */
  clientEntryRelativePath: string;
}

export interface PagesCompileOptions {
  /** Absolute path to pages/ directory */
  pagesDir: string;
  /** Pages directory relative to Vite root, e.g. "pages" — used for manifest key lookup */
  pagesDirRelative: string;
  /** Absolute path to void/pages-protocol module */
  protocolPath: string;
  /** Absolute path to void/pages-head module */
  headPath: string;
  /** Virtual module ID for the client entry (used for asset tags) */
  clientEntryId: string;
  /** Virtual module ID for the islands client entry (used for island asset tags) */
  islandClientEntryId?: string;
  /** Virtual module ID for the md plugin's client entry (script execution) */
  mdClientEntryId?: string;
  /** Head config from void.json */
  headConfig?: import("../pages/head").HeadConfig;
}

/**
 * Generate the code for the virtual route table module (virtual:void-routes).
 * This module creates a Hono app with:
 * - Middleware registered via app.use()
 * - Routes registered with lazy-loaded handlers and auto-conversion
 */
export function compileRouteTable(
  scan: ScanResult,
  routesDir: string,
  middlewareDir: string,
  jobsDir: string,
  queuesDir: string,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
  pages: PagesCompileOptions | null = null,
): string {
  const lines: string[] = [];
  const auth = options.auth;
  const webSockets = scan.websockets ?? [];

  lines.push(`import { AsyncLocalStorage } from "node:async_hooks";`);
  lines.push(`import { Hono } from ${JSON.stringify(options.honoPath)};`);
  lines.push(`import { convertReturnValue } from ${JSON.stringify(options.responsePath)};`);
  if (options.nodeTarget) {
    lines.push(`const withRuntimeEnv = (_env, fn) => fn();`);
  } else {
    lines.push(`import { withRuntimeEnv } from ${JSON.stringify(options.runtimeEnvPath)};`);
  }

  if (auth) {
    const authImports = ["runVoidAuthMiddleware", "handleVoidAuthRequest", "runVoidAuthMigrations"];
    if (webSockets.length > 0) {
      authImports.push("resolveVoidAuthState as __resolveVoidAuthStateRuntime");
    }
    lines.push(
      `import { ${authImports.join(", ")} } from ${JSON.stringify(auth.authRuntimePath)};`,
    );
    if (auth.authDatabasePath) {
      lines.push(`import { __voidAuthDatabase } from ${JSON.stringify(auth.authDatabasePath)};`);
    }
    if (auth.authSchemaPath) {
      lines.push(
        `import { migrationSchema as __voidAuthMigrationSchema } from ${JSON.stringify(auth.authSchemaPath)};`,
      );
    }
    if (auth.authConfigPath) {
      lines.push(`import __voidAuthConfig from ${JSON.stringify(auth.authConfigPath)};`);
    }
  }
  if (webSockets.length > 0 && options.webSocketRuntimePath) {
    lines.push(
      `import { createWebSocketDurableObject as __createWebSocketDurableObject, handleWebSocketUpgrade as __handleWebSocketUpgrade, forwardWebSocketRequest as __forwardWebSocketRequest } from ${JSON.stringify(options.webSocketRuntimePath)};`,
    );
  }
  lines.push("");

  // Generate eager imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  for (let i = 0; i < webSockets.length; i++) {
    const route = webSockets[i];
    lines.push(`import websocket${i} from ${JSON.stringify(`${routesDir}/${route.filePath}`)};`);
  }
  lines.push("");

  if (auth) {
    lines.push(
      `const __voidAuthOptions = { dialect: ${JSON.stringify(auth.dialect)}, providers: ${JSON.stringify(auth.providers)}, userConfig: ${auth.authConfigPath ? "__voidAuthConfig" : "undefined"} };`,
    );
    if (webSockets.length > 0) {
      lines.push(
        `const __resolveVoidAuthState = (request, env, runtime) => __resolveVoidAuthStateRuntime(request, env, runtime${auth.authDatabasePath ? ", __voidAuthDatabase" : ""});`,
      );
    }
    lines.push("");
  }

  lines.push(`const app = new Hono();`);
  lines.push(`export const requestContext = new AsyncLocalStorage();`);
  lines.push("");

  // Request context middleware — threads outer request into ALS for isomorphic fetch
  lines.push("app.use(async (c, next) => {");
  if (options.nodeTarget) {
    lines.push("  await requestContext.run({ request: c.req.raw }, next);");
  } else {
    lines.push(
      "  await requestContext.run({ request: c.req.raw, executionCtx: c.executionCtx }, next);",
    );
  }
  lines.push("});");
  lines.push("");

  // Edge routing middleware (node targets only — on CF these are handled by the dispatch worker)
  if (options.nodeTarget && options.redirectRules?.length) {
    compileRedirectMiddleware(lines, options.redirectRules);
  }
  if (options.nodeTarget && options.headerRules?.length) {
    compileHeaderMiddleware(lines, options.headerRules);
  }

  if (auth) {
    lines.push("app.use(async (c, next) => {");
    lines.push(
      `  return runVoidAuthMiddleware(c, next, __voidAuthOptions${auth.authDatabasePath ? ", __voidAuthDatabase" : ""});`,
    );
    lines.push("});");
    lines.push("");
  }

  // Register user middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    lines.push(`app.use(middleware${i});`);
  }
  if (scan.middleware.length > 0) {
    lines.push("");
  }

  if (auth) {
    lines.push('app.all("/api/auth", async (c) => {');
    lines.push(
      `  return handleVoidAuthRequest(c, __voidAuthOptions${auth.authDatabasePath ? ", __voidAuthDatabase" : ""});`,
    );
    lines.push("});");
    lines.push("");
    lines.push('app.all("/api/auth/*", async (c) => {');
    lines.push(
      `  return handleVoidAuthRequest(c, __voidAuthOptions${auth.authDatabasePath ? ", __voidAuthDatabase" : ""});`,
    );
    lines.push("});");
    lines.push("");
  }

  // Register routes with lazy-loaded handlers (shared loader per file)
  const seenFiles = new Set<string>();
  for (const route of scan.routes) {
    const filePath = `${routesDir}/${route.filePath}`;
    const varName = `_mod_${route.filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const loaderName = `_load_${route.filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;

    if (!seenFiles.has(route.filePath)) {
      seenFiles.add(route.filePath);
      lines.push(`let ${varName};`);
      lines.push(`async function ${loaderName}() {`);
      lines.push(`  if (!${varName}) ${varName} = await import(${JSON.stringify(filePath)});`);
      lines.push(`  return ${varName};`);
      lines.push(`}`);
    }

    if (route.methods.length === 0) {
      // No recognized HTTP exports — register as all()
      lines.push(`app.all(${JSON.stringify(route.pattern)}, async (c) => {`);
      lines.push(`  const mod = await ${loaderName}();`);
      lines.push(`  return convertReturnValue(await mod.default(c));`);
      lines.push(`});`);
    } else {
      for (const method of route.methods) {
        const honoMethod = method.toLowerCase();
        lines.push(`app.${honoMethod}(${JSON.stringify(route.pattern)}, async (c) => {`);
        lines.push(`  const mod = await ${loaderName}();`);
        lines.push(`  return convertReturnValue(await mod.${method}(c));`);
        lines.push(`});`);
      }
    }
  }
  lines.push("");

  if (webSockets.length > 0) {
    for (let i = 0; i < webSockets.length; i++) {
      const route = webSockets[i];
      lines.push(
        `export const ${route.className} = __createWebSocketDurableObject(websocket${i}, ${JSON.stringify(
          {
            pattern: route.pattern,
            params: route.params,
            className: route.className,
            bindingName: route.bindingName,
          },
        )}, ${auth ? "__voidAuthOptions" : "undefined"}, ${auth ? "__resolveVoidAuthState" : "undefined"});`,
      );
    }
    lines.push("");
    lines.push(
      `const __voidWebSocketRoutes = ${JSON.stringify(
        webSockets.map((route) => ({
          pattern: route.pattern,
          params: route.params,
          className: route.className,
          bindingName: route.bindingName,
        })),
      )};`,
    );
    lines.push("export async function __voidHandleWebSocket(request, env) {");
    lines.push("  return __handleWebSocketUpgrade(request, env, __voidWebSocketRoutes);");
    lines.push("}");
    lines.push("");
    for (let i = 0; i < webSockets.length; i++) {
      const route = webSockets[i];
      lines.push(`app.all(${JSON.stringify(route.pattern)}, async (c) => {`);
      lines.push(
        `  return __forwardWebSocketRequest(c.req.raw, c.env, __voidWebSocketRoutes[${i}]);`,
      );
      lines.push("});");
    }
    lines.push("");
  } else {
    lines.push("export async function __voidHandleWebSocket() { return null; }");
    lines.push("");
  }

  // Pages mode — generate page route handlers
  if (pages && scan.pages.pages.length > 0) {
    compilePageRoutes(lines, scan, pages);
  }

  compilePrerenderCollector(lines, scan, ssr, options);

  if (ssr) {
    const clientEntryUrl = `/${ssr.clientEntryRelativePath}`;
    lines.push(`const SSR_CLIENT_ENTRY_ID = ${JSON.stringify(ssr.clientEntryRelativePath)};`);
    lines.push(`const SSR_CLIENT_ENTRY_URL = ${JSON.stringify(clientEntryUrl)};`);
    lines.push(`let cachedSsrManifest = null;`);
    lines.push("");
    lines.push(`function escapeHtml(value) {`);
    lines.push(`  return String(value).replace(/"/g, "&quot;");`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function getDevClientTags() {`);
    lines.push(`  const preloadTags = [\`<script type="module" src="/@vite/client"></script>\`];`);
    lines.push(`  preloadTags.push(\`${BINDING_HINT_SCRIPT}\`);`);
    if (options.reactRefresh) {
      lines.push(`  preloadTags.push(\`<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>\`);`);
    }
    lines.push(
      `  const bodyTag = \`<script type="module" src="\${escapeHtml(SSR_CLIENT_ENTRY_URL)}"></script>\`;`,
    );
    lines.push(`  return { css: "", preloads: preloadTags.join("\\n"), body: bodyTag };`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function collectManifestFiles(manifest, entryId) {`);
    lines.push(`  const seen = new Set();`);
    lines.push(`  const toVisit = [entryId];`);
    lines.push(`  while (toVisit.length > 0) {`);
    lines.push(`    const currentId = toVisit.pop();`);
    lines.push(`    if (seen.has(currentId)) continue;`);
    lines.push(`    seen.add(currentId);`);
    lines.push(`    const chunk = manifest[currentId];`);
    lines.push(`    if (!chunk || !Array.isArray(chunk.imports)) continue;`);
    lines.push(`    for (const importedId of chunk.imports) toVisit.push(importedId);`);
    lines.push(`  }`);
    lines.push(`  return Array.from(seen);`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function loadSsrManifest(request, env) {`);
    lines.push(`  if (cachedSsrManifest) return cachedSsrManifest;`);
    lines.push(
      `  if (typeof globalThis.__VITE_MANIFEST__ === "object" && globalThis.__VITE_MANIFEST__) {`,
    );
    lines.push(`    cachedSsrManifest = globalThis.__VITE_MANIFEST__;`);
    lines.push(`    return cachedSsrManifest;`);
    lines.push(`  }`);
    lines.push(`  const assets = env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") return null;`);
    lines.push(`  const manifestUrl = new URL("/.vite/manifest.json", request.url);`);
    lines.push(`  const response = await assets.fetch(new Request(manifestUrl.toString()));`);
    lines.push(`  if (!response.ok) return null;`);
    lines.push(`  cachedSsrManifest = await response.json();`);
    lines.push(`  return cachedSsrManifest;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function getClientAssetTags(request, env) {`);
    lines.push(`  const manifest = await loadSsrManifest(request, env);`);
    lines.push(`  if (!manifest || typeof manifest !== "object") {`);
    lines.push(`    if (!import.meta.env.DEV) return { css: "", preloads: "", body: "" };`);
    lines.push(`    return getDevClientTags();`);
    lines.push(`  }`);
    lines.push(`  const entry = manifest[SSR_CLIENT_ENTRY_ID];`);
    lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
    lines.push(`    return { css: "", preloads: "", body: "" };`);
    lines.push(`  }`);
    lines.push(`  const ids = collectManifestFiles(manifest, SSR_CLIENT_ENTRY_ID);`);
    lines.push(`  const cssFiles = new Set();`);
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    lines.push(`    if (Array.isArray(chunk.css)) {`);
    lines.push(`      for (const cssFile of chunk.css) cssFiles.add(cssFile);`);
    lines.push(`    }`);
    lines.push(`    if (id !== SSR_CLIENT_ENTRY_ID && typeof chunk.file === "string") {`);
    lines.push(`      preloadFiles.add(chunk.file);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const cssTags = [];`);
    lines.push(`  for (const cssFile of cssFiles) {`);
    lines.push(`    cssTags.push(\`<link rel="stylesheet" href="/\${escapeHtml(cssFile)}">\`);`);
    lines.push(`  }`);
    lines.push(`  const preloadTags = [];`);
    lines.push(`  for (const preloadFile of preloadFiles) {`);
    lines.push(
      `    preloadTags.push(\`<link rel="modulepreload" href="/\${escapeHtml(preloadFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(
      `  const bodyTag = \`<script type="module" src="/\${escapeHtml(entry.file)}"></script>\`;`,
    );
    lines.push(
      `  return { css: cssTags.join("\\n"), preloads: preloadTags.join("\\n"), body: bodyTag };`,
    );
    lines.push(`}`);
    lines.push("");
    lines.push(`function shouldHandleSsrRequest(c) {`);
    lines.push(`  const path = c.req.path;`);
    lines.push(`  if (path === "/api" || path.startsWith("/api/")) return false;`);
    lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(path)) return false;`);
    lines.push(`  const destination = c.req.header("sec-fetch-dest");`);
    lines.push(
      `  if (destination && destination !== "document" && destination !== "empty") return false;`,
    );
    lines.push(`  return true;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function fetchFromAssets(c) {`);
    lines.push(`  const assets = c.env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
    lines.push(`    return new Response("Not Found", { status: 404 });`);
    lines.push(`  }`);
    lines.push(`  const response = await assets.fetch(c.req.raw);`);
    lines.push(
      `  return response.status === 404 ? new Response("Not Found", { status: 404 }) : response;`,
    );
    lines.push(`}`);
    lines.push("");
    lines.push(`async function renderSsrResponse(c, mod) {`);
    lines.push(`  const render = typeof mod.render === "function" ? mod.render : mod.default;`);
    lines.push(`  if (typeof render !== "function") {`);
    lines.push(
      `    throw new Error("Invalid SSR entry: expected exported render(c, assetTags) function.");`,
    );
    lines.push(`  }`);
    lines.push(`  const assetTags = await getClientAssetTags(c.req.raw, c.env);`);
    lines.push(`  return render(c, assetTags);`);
    lines.push(`}`);
    lines.push("");
    lines.push(`app.notFound(async (c) => {`);
    lines.push(`  if (!shouldHandleSsrRequest(c)) {`);
    lines.push(`    return fetchFromAssets(c);`);
    lines.push(`  }`);
    lines.push(`  const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`  return renderSsrResponse(c, mod);`);
    lines.push(`});`);
    lines.push("");
  }

  if (scan.jobs.length > 0) {
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      lines.push(`const job${i}Crons = ${JSON.stringify(job.crons)};`);
    }
    lines.push("");
    lines.push("export async function scheduled(controller, env, ctx) {");
    lines.push("  switch (controller.cron) {");
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      const filePath = JSON.stringify(`${jobsDir}/${job.filePath}`);
      for (let j = 0; j < job.crons.length; j++) {
        if (j < job.crons.length - 1) {
          lines.push(`    case job${i}Crons[${j}]:`);
        } else {
          lines.push(`    case job${i}Crons[${j}]: {`);
        }
      }
      lines.push(`      const mod = await import(${filePath});`);
      lines.push("      if (typeof mod.default === 'function') {");
      lines.push("        await mod.default(controller, env, ctx);");
      lines.push("      }");
      lines.push("      return;");
      lines.push("    }");
    }
    lines.push("    default:");
    lines.push("      return;");
    lines.push("  }");
    lines.push("}");
    lines.push("");
  } else {
    lines.push("export async function scheduled() {}");
    lines.push("");
  }

  if (scan.jobs.length > 0) {
    lines.push('app.post("/__scheduled", async (c) => {');
    lines.push("  const { cron, scheduledTime } = await c.req.json();");
    lines.push("  const controller = { cron, scheduledTime, noRetry() {} };");
    lines.push("  await scheduled(controller, c.env, c.executionCtx);");
    lines.push("  return c.json({ ok: true });");
    lines.push("});");
    lines.push("");
  }

  if (scan.queues.length > 0) {
    for (let i = 0; i < scan.queues.length; i++) {
      lines.push(`const queue${i}Name = ${JSON.stringify(scan.queues[i].name)};`);
    }
    lines.push("");
    lines.push('app.post("/__queue", async (c) => {');
    lines.push("  const payload = await c.req.json();");
    lines.push("  const queueSuffix = payload.queue;");
    lines.push("  const __decisions = new Map();");
    lines.push("  function __wrapMsg(m) {");
    lines.push("    let decided = false;");
    lines.push("    return {");
    lines.push(
      "      id: m.id, timestamp: new Date(m.timestamp), body: m.body, attempts: m.attempts,",
    );
    lines.push(
      '      ack() { if (!decided) { decided = true; __decisions.set(m.id, { action: "ack" }); } },',
    );
    lines.push(
      '      retry(opts) { if (!decided) { decided = true; __decisions.set(m.id, { action: "retry", ...(opts?.delaySeconds != null ? { delaySeconds: opts.delaySeconds } : {}) }); } },',
    );
    lines.push("    };");
    lines.push("  }");
    lines.push("  const __msgs = payload.messages.map(__wrapMsg);");
    lines.push("  const batch = {");
    lines.push("    queue: queueSuffix,");
    lines.push("    messages: __msgs,");
    lines.push("    ackAll() { for (const m of __msgs) m.ack(); },");
    lines.push("    retryAll(opts) { for (const m of __msgs) m.retry(opts); },");
    lines.push("  };");
    lines.push("  let __ok = true;");
    lines.push("  try {");
    for (let i = 0; i < scan.queues.length; i++) {
      const q = scan.queues[i];
      const cond = i === 0 ? "if" : "} else if";
      lines.push(
        `    ${cond} (queueSuffix === queue${i}Name || queueSuffix.endsWith("-" + queue${i}Name)) {`,
      );
      lines.push(
        `      const mod = await import(${JSON.stringify(`${queuesDir}/${q.filePath}`)});`,
      );
      lines.push("      if (typeof mod.default === 'function') await mod.default(batch, c.env);");
    }
    lines.push("    }");
    lines.push("  } catch { __ok = false; }");
    lines.push(
      "  return c.json({ ok: __ok, ...(__decisions.size > 0 ? { decisions: Object.fromEntries(__decisions) } : {}) });",
    );
    lines.push("});");
    lines.push("");
  }

  // /__void/migrate handler — runs bundled DB + auth migrations in-worker
  if (options.migrationHandlerPath && (options.migrations?.length || auth)) {
    lines.push(
      `import { createMigrationHandler as __createMigrationHandler } from ${JSON.stringify(options.migrationHandlerPath)};`,
    );
    lines.push(`const __migrations = ${JSON.stringify(options.migrations)};`);
    lines.push(
      `const __migrationDialect = ${JSON.stringify(options.migrationDialect ?? "sqlite")};`,
    );
    lines.push('app.post("/__void/migrate", async (c) => {');
    lines.push("  const __voidMigrationHandler = __createMigrationHandler(");
    lines.push("    c.env,");
    lines.push("    __migrations,");
    lines.push("    __migrationDialect,");
    if (auth) {
      lines.push(
        `    () => runVoidAuthMigrations(new Request(c.req.url), c.env, __voidAuthOptions${
          auth.authSchemaPath ? ", __voidAuthMigrationSchema" : ""
        }),`,
      );
    } else {
      lines.push("    undefined,");
    }
    lines.push("  );");
    lines.push("  return __voidMigrationHandler(c.req.raw);");
    lines.push("});");
    lines.push("");
  }

  // /__void/* handler — native binding access via WfP dispatch (always injected for CF targets)
  if (options.bindingHandlerPath) {
    lines.push(
      `import { createBindingHandler as __createBindingHandler } from ${JSON.stringify(options.bindingHandlerPath)};`,
    );
    lines.push("let __voidBindingApp;");
    lines.push('app.all("/__void/*", async (c) => {');
    lines.push("  if (!__voidBindingApp) __voidBindingApp = __createBindingHandler(c.env);");
    lines.push("  const url = new URL(c.req.url);");
    lines.push("  url.pathname = url.pathname.slice(7);");
    lines.push("  return __voidBindingApp.fetch(new Request(url.toString(), c.req.raw));");
    lines.push("});");
    lines.push("");
  }

  lines.push(`export default app;`);

  return lines.join("\n");
}

function compilePrerenderCollector(
  lines: string[],
  scan: ScanResult,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
): void {
  const staticPaths = scan.pages.pages
    .filter((page) => page.prerender && page.params.length === 0 && !page.catchAll)
    .map((page) => page.pattern);
  const dynamicPages = scan.pages.pages.filter(
    (page) =>
      page.prerender && page.hasGetPrerenderPaths && (page.params.length > 0 || page.catchAll),
  );
  const explicitPaths = options.explicitPrerenderPaths ?? [];

  lines.push(`function __voidBuildPrerenderPath(pattern, params) {`);
  lines.push(`  let path = pattern;`);
  lines.push(`  for (const [key, value] of Object.entries(params)) {`);
  lines.push(`    path = path.replace(":" + key, value);`);
  lines.push(`  }`);
  lines.push(`  return path;`);
  lines.push(`}`);
  lines.push("");

  lines.push(`export async function __voidCollectPrerenderPaths(request, env, ctx) {`);
  lines.push(`  return withRuntimeEnv(env, async () => {`);
  if (options.nodeTarget) {
    lines.push(`    return requestContext.run({ request }, async () => {`);
  } else {
    lines.push(`    return requestContext.run({ request, executionCtx: ctx }, async () => {`);
  }
  lines.push(`      const paths = [];`);

  for (const path of staticPaths) {
    lines.push(`      paths.push(${JSON.stringify(path)});`);
  }

  for (const page of dynamicPages) {
    const loaderName = `_pload_${page.componentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
    lines.push(`      {`);
    lines.push(`        const mod = await ${loaderName}();`);
    lines.push(`        if (typeof mod.getPrerenderPaths === "function") {`);
    lines.push(`          const paramSets = await mod.getPrerenderPaths();`);
    lines.push(`          if (Array.isArray(paramSets)) {`);
    lines.push(`            for (const params of paramSets) {`);
    lines.push(
      `              paths.push(__voidBuildPrerenderPath(${JSON.stringify(page.pattern)}, params));`,
    );
    lines.push(`            }`);
    lines.push(`          }`);
    lines.push(`        }`);
    lines.push(`      }`);
  }

  if (ssr) {
    lines.push(`      {`);
    lines.push(`        const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`        if (typeof mod.getPrerenderPaths === "function") {`);
    lines.push(`          const ssrPaths = await mod.getPrerenderPaths();`);
    lines.push(`          if (Array.isArray(ssrPaths)) {`);
    lines.push(`            for (const path of ssrPaths) {`);
    lines.push(`              if (typeof path === "string") paths.push(path);`);
    lines.push(`            }`);
    lines.push(`          }`);
    lines.push(`        }`);
    lines.push(`      }`);
  }

  for (const path of explicitPaths) {
    lines.push(`      paths.push(${JSON.stringify(path)});`);
  }

  lines.push(`      return [...new Set(paths)];`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");
}

function compilePageRoutes(lines: string[], scan: ScanResult, pages: PagesCompileOptions): void {
  // Import protocol helpers and renderer
  lines.push(
    `import { handlePageGet, handlePageMutation } from ${JSON.stringify(pages.protocolPath)};`,
  );
  lines.push(
    `import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from ${JSON.stringify(pages.headPath)};`,
  );
  lines.push(`import { renderPage } from "virtual:void-pages-renderer";`);

  // Import island renderer if any island pages exist
  const hasIslandPages = scan.pages.pages.some((p) => p.island);
  if (hasIslandPages) {
    lines.push(`import { renderIslandPage } from "virtual:void-islands-renderer";`);
  }
  lines.push("");

  // Emit head config constant from void.json
  lines.push(`const __voidHeadConfig = ${JSON.stringify(pages.headConfig ?? null)};`);
  lines.push("");

  // Asset tags — reuse the SSR asset tags pattern with the pages client entry
  const clientEntryId = pages.clientEntryId;
  lines.push(`const PAGES_CLIENT_ENTRY_ID = ${JSON.stringify(clientEntryId)};`);
  lines.push(`const PAGES_CLIENT_ENTRY_URL = ${JSON.stringify("/@id/__x00__" + clientEntryId)};`);
  lines.push(`let cachedPagesManifest = null;`);
  lines.push("");
  lines.push(`function escapeHtmlAttr(value) {`);
  lines.push(`  return String(value).replace(/"/g, "&quot;");`);
  lines.push(`}`);
  lines.push("");
  lines.push(`function getPagesDevClientTags() {`);
  lines.push(
    `  const preloads = \`<script type="module" src="/@vite/client"></script>\\n${BINDING_HINT_SCRIPT}\`;`,
  );
  lines.push(
    `  const bodyTag = \`<script type="module" src="\${escapeHtmlAttr(PAGES_CLIENT_ENTRY_URL)}"></script>\`;`,
  );
  lines.push(`  return { css: "", preloads, body: bodyTag };`);
  lines.push(`}`);
  lines.push("");
  lines.push(`function collectPagesManifestFiles(manifest, entryId) {`);
  lines.push(`  const seen = new Set();`);
  lines.push(`  const toVisit = [entryId];`);
  lines.push(`  while (toVisit.length > 0) {`);
  lines.push(`    const currentId = toVisit.pop();`);
  lines.push(`    if (seen.has(currentId)) continue;`);
  lines.push(`    seen.add(currentId);`);
  lines.push(`    const chunk = manifest[currentId];`);
  lines.push(`    if (!chunk || !Array.isArray(chunk.imports)) continue;`);
  lines.push(`    for (const importedId of chunk.imports) toVisit.push(importedId);`);
  lines.push(`  }`);
  lines.push(`  return Array.from(seen);`);
  lines.push(`}`);
  lines.push("");
  // Build manifest-key mapping for each page and its layout chain
  // so CSS collection can be scoped to the active route only
  const relPagesDir = pages.pagesDirRelative;
  const pageCssKeys: Record<string, string[]> = {};
  for (const page of scan.pages.pages) {
    const keys = [`${relPagesDir}/${page.componentPath}`];
    const layoutIds = resolveLayoutIds(page, scan.pages.layouts, scan.pages.namedLayouts);
    for (const layoutId of layoutIds) {
      // Map layout IDs back to file paths
      const layout = scan.pages.layouts.find(
        (l) => (l.directory ? `${l.directory}/layout` : "layout") === layoutId,
      );
      if (layout) {
        keys.push(`${relPagesDir}/${layout.filePath}`);
        continue;
      }
      const named = scan.pages.namedLayouts.find((nl) => {
        const id = nl.directory ? `${nl.directory}/_layouts/${nl.name}` : `_layouts/${nl.name}`;
        return id === layoutId;
      });
      if (named) {
        keys.push(`${relPagesDir}/${named.filePath}`);
      }
    }
    pageCssKeys[page.componentId] = keys;
  }
  lines.push(`const PAGE_CSS_KEYS = ${JSON.stringify(pageCssKeys)};`);
  lines.push("");

  lines.push(`function collectRouteCss(manifest, entryId, pageKeys) {`);
  lines.push(`  const cssFiles = new Set();`);
  lines.push(`  const visited = new Set();`);
  lines.push(`  const toVisit = [entryId];`);
  lines.push(`  while (toVisit.length > 0) {`);
  lines.push(`    const id = toVisit.pop();`);
  lines.push(`    if (visited.has(id)) continue;`);
  lines.push(`    visited.add(id);`);
  lines.push(`    const chunk = manifest[id];`);
  lines.push(`    if (!chunk) continue;`);
  lines.push(`    if (Array.isArray(chunk.css)) {`);
  lines.push(`      for (const f of chunk.css) cssFiles.add(f);`);
  lines.push(`    }`);
  lines.push(`    if (Array.isArray(chunk.imports)) {`);
  lines.push(`      for (const i of chunk.imports) toVisit.push(i);`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  for (const key of pageKeys) {`);
  lines.push(`    const stack = [key];`);
  lines.push(`    while (stack.length > 0) {`);
  lines.push(`      const id = stack.pop();`);
  lines.push(`      if (visited.has(id)) continue;`);
  lines.push(`      visited.add(id);`);
  lines.push(`      const chunk = manifest[id];`);
  lines.push(`      if (!chunk) continue;`);
  lines.push(`      if (Array.isArray(chunk.css)) {`);
  lines.push(`        for (const f of chunk.css) cssFiles.add(f);`);
  lines.push(`      }`);
  lines.push(`      if (Array.isArray(chunk.imports)) {`);
  lines.push(`        for (const i of chunk.imports) stack.push(i);`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  return cssFiles;`);
  lines.push(`}`);
  lines.push("");
  lines.push(`async function loadPagesManifest(request, env) {`);
  lines.push(`  if (cachedPagesManifest) return cachedPagesManifest;`);
  lines.push(
    `  if (typeof globalThis.__VITE_MANIFEST__ === "object" && globalThis.__VITE_MANIFEST__) {`,
  );
  lines.push(`    cachedPagesManifest = globalThis.__VITE_MANIFEST__;`);
  lines.push(`    return cachedPagesManifest;`);
  lines.push(`  }`);
  lines.push(`  const assets = env?.ASSETS;`);
  lines.push(`  if (!assets || typeof assets.fetch !== "function") return null;`);
  lines.push(`  const manifestUrl = new URL("/.vite/manifest.json", request.url);`);
  lines.push(`  const response = await assets.fetch(new Request(manifestUrl.toString()));`);
  lines.push(`  if (!response.ok) return null;`);
  lines.push(`  cachedPagesManifest = await response.json();`);
  lines.push(`  return cachedPagesManifest;`);
  lines.push(`}`);
  lines.push("");
  lines.push(`async function getPagesAssetTags(request, env, componentId) {`);
  lines.push(`  const manifest = await loadPagesManifest(request, env);`);
  lines.push(`  if (!manifest || typeof manifest !== "object") {`);
  lines.push(`    if (!import.meta.env.DEV) return { css: "", preloads: "", body: "" };`);
  lines.push(`    return getPagesDevClientTags();`);
  lines.push(`  }`);
  lines.push(`  const entry = manifest[PAGES_CLIENT_ENTRY_ID];`);
  lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
  lines.push(`    return { css: "", preloads: "", body: "" };`);
  lines.push(`  }`);
  lines.push(`  const ids = collectPagesManifestFiles(manifest, PAGES_CLIENT_ENTRY_ID);`);
  lines.push(`  const pageKeys = componentId ? (PAGE_CSS_KEYS[componentId] || []) : [];`);
  lines.push(`  const cssFiles = collectRouteCss(manifest, PAGES_CLIENT_ENTRY_ID, pageKeys);`);
  lines.push(`  const preloadFiles = new Set();`);
  lines.push(`  for (const id of ids) {`);
  lines.push(`    const chunk = manifest[id];`);
  lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
  lines.push(`    if (id !== PAGES_CLIENT_ENTRY_ID && typeof chunk.file === "string") {`);
  lines.push(`      preloadFiles.add(chunk.file);`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  const cssTags = [];`);
  lines.push(`  for (const cssFile of cssFiles) {`);
  lines.push(`    cssTags.push(\`<link rel="stylesheet" href="/\${escapeHtmlAttr(cssFile)}">\`);`);
  lines.push(`  }`);
  lines.push(`  const preloadTags = [];`);
  lines.push(`  for (const preloadFile of preloadFiles) {`);
  lines.push(
    `    preloadTags.push(\`<link rel="modulepreload" href="/\${escapeHtmlAttr(preloadFile)}">\`);`,
  );
  lines.push(`  }`);
  lines.push(
    `  const bodyTag = \`<script type="module" src="/\${escapeHtmlAttr(entry.file)}"></script>\`;`,
  );
  lines.push(
    `  return { css: cssTags.join("\\n"), preloads: preloadTags.join("\\n"), body: bodyTag };`,
  );
  lines.push(`}`);
  lines.push("");

  // Island asset tags — same pattern but using the islands client entry
  if (hasIslandPages && pages.islandClientEntryId) {
    const islandEntryId = pages.islandClientEntryId;
    lines.push(`const ISLANDS_CLIENT_ENTRY_ID = ${JSON.stringify(islandEntryId)};`);
    lines.push(
      `const ISLANDS_CLIENT_ENTRY_URL = ${JSON.stringify("/@id/__x00__" + islandEntryId)};`,
    );
    if (pages.mdClientEntryId) {
      lines.push(`const MD_CLIENT_ENTRY_ID = ${JSON.stringify(pages.mdClientEntryId)};`);
      lines.push(
        `const MD_CLIENT_ENTRY_URL = ${JSON.stringify("/@id/__x00__" + pages.mdClientEntryId)};`,
      );
    }
    lines.push("");
    lines.push(`function getIslandsDevClientTags() {`);
    lines.push(
      `  const preloads = \`<script type="module" src="/@vite/client"></script>\\n${BINDING_HINT_SCRIPT}\`;`,
    );
    lines.push(
      `  let bodyTag = \`<script type="module" src="\${escapeHtmlAttr(ISLANDS_CLIENT_ENTRY_URL)}"></script>\`;`,
    );
    if (pages.mdClientEntryId) {
      lines.push(
        `  bodyTag += \`\\n<script type="module" src="\${escapeHtmlAttr(MD_CLIENT_ENTRY_URL)}"></script>\`;`,
      );
    }
    lines.push(`  return { css: "", preloads, body: bodyTag };`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function getIslandsAssetTags(request, env, componentId) {`);
    lines.push(`  const manifest = await loadPagesManifest(request, env);`);
    lines.push(`  if (!manifest || typeof manifest !== "object") {`);
    lines.push(`    if (!import.meta.env.DEV) return { css: "", preloads: "", body: "" };`);
    lines.push(`    return getIslandsDevClientTags();`);
    lines.push(`  }`);
    lines.push(`  const entry = manifest[ISLANDS_CLIENT_ENTRY_ID];`);
    lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
    lines.push(`    return { css: "", preloads: "", body: "" };`);
    lines.push(`  }`);
    lines.push(`  const ids = collectPagesManifestFiles(manifest, ISLANDS_CLIENT_ENTRY_ID);`);
    // Collect md entry files too
    if (pages.mdClientEntryId) {
      lines.push(`  const mdEntry = manifest[MD_CLIENT_ENTRY_ID];`);
      lines.push(`  if (mdEntry && typeof mdEntry.file === "string") {`);
      lines.push(`    const mdIds = collectPagesManifestFiles(manifest, MD_CLIENT_ENTRY_ID);`);
      lines.push(`    for (const mdId of mdIds) ids.push(mdId);`);
      lines.push(`  }`);
    }
    // Collect route-scoped CSS (page + layout chunks) plus static-import CSS
    lines.push(`  const pageKeys = componentId ? (PAGE_CSS_KEYS[componentId] || []) : [];`);
    lines.push(`  const cssFiles = collectRouteCss(manifest, ISLANDS_CLIENT_ENTRY_ID, pageKeys);`);
    if (pages.mdClientEntryId) {
      // Also collect CSS from the md client entry's static imports
      lines.push(`  if (mdEntry && typeof mdEntry.file === "string") {`);
      lines.push(`    const mdKeys = [];`);
      lines.push(`    const mdCss = collectRouteCss(manifest, MD_CLIENT_ENTRY_ID, mdKeys);`);
      lines.push(`    for (const f of mdCss) cssFiles.add(f);`);
      lines.push(`  }`);
    }
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    // Exclude entry points from preloads (they get their own <script> tags)
    const excludeFromPreload = pages.mdClientEntryId
      ? `id !== ISLANDS_CLIENT_ENTRY_ID && id !== MD_CLIENT_ENTRY_ID`
      : `id !== ISLANDS_CLIENT_ENTRY_ID`;
    lines.push(`    if (${excludeFromPreload} && typeof chunk.file === "string") {`);
    lines.push(`      preloadFiles.add(chunk.file);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const cssTags = [];`);
    lines.push(`  for (const cssFile of cssFiles) {`);
    lines.push(
      `    cssTags.push(\`<link rel="stylesheet" href="/\${escapeHtmlAttr(cssFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(`  const preloadTags = [];`);
    lines.push(`  for (const preloadFile of preloadFiles) {`);
    lines.push(
      `    preloadTags.push(\`<link rel="modulepreload" href="/\${escapeHtmlAttr(preloadFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(
      `  let bodyTag = \`<script type="module" src="/\${escapeHtmlAttr(entry.file)}"></script>\`;`,
    );
    if (pages.mdClientEntryId) {
      lines.push(`  if (mdEntry && typeof mdEntry.file === "string") {`);
      lines.push(
        `    bodyTag += \`\\n<script type="module" src="/\${escapeHtmlAttr(mdEntry.file)}"></script>\`;`,
      );
      lines.push(`  }`);
    }
    lines.push(
      `  return { css: cssTags.join("\\n"), preloads: preloadTags.join("\\n"), body: bodyTag };`,
    );
    lines.push(`}`);
    lines.push("");
  }

  // Generate lazy loaders and route registrations for each page
  const seenServerFiles = new Set<string>();
  for (const page of scan.pages.pages) {
    const safeId = page.componentId.replace(/[^a-zA-Z0-9]/g, "_");

    // Determine server module path
    let serverImportPath: string | null = null;
    if (page.serverPath) {
      serverImportPath = `${pages.pagesDir}/${page.serverPath}`;
    }

    // Generate lazy loader for server module (if any)
    if (serverImportPath && !seenServerFiles.has(serverImportPath)) {
      seenServerFiles.add(serverImportPath);
      const varName = `_pmod_${safeId}`;
      const loaderName = `_pload_${safeId}`;
      lines.push(`let ${varName};`);
      lines.push(`async function ${loaderName}() {`);
      lines.push(
        `  if (!${varName}) ${varName} = await import(${JSON.stringify(serverImportPath)});`,
      );
      lines.push(`  return ${varName};`);
      lines.push(`}`);
    }

    // Generate inline head function for markdown pages without .server.ts
    let mdHeadRef: string | null = null;
    if (!serverImportPath && page.metadata && (page.metadata.title || page.metadata.description)) {
      const headObj: Record<string, unknown> = {};
      if (page.metadata.title) headObj.title = page.metadata.title;
      if (page.metadata.description) {
        headObj.meta = [{ name: "description", content: page.metadata.description }];
      }
      const headVarName = `__mdHead_${safeId}`;
      lines.push(`const ${headVarName} = () => (${JSON.stringify(headObj)});`);
      mdHeadRef = headVarName;
    }

    // Choose renderer and asset tags based on island flag
    const renderer = page.island ? "renderIslandPage" : "renderPage";
    const assetTags =
      page.island && pages.islandClientEntryId ? "getIslandsAssetTags" : "getPagesAssetTags";
    const islandFlag = page.island ? ", true" : "";

    // Loader (always registered — pages always handle GET)
    lines.push(`app.get(${JSON.stringify(page.pattern)}, async (c) => {`);
    if (serverImportPath) {
      const loaderName = `_pload_${safeId}`;
      lines.push(`  const mod = await ${loaderName}();`);
      lines.push(
        `  return handlePageGet(mod.loader, mod.head, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
      );
    } else {
      const headArg = mdHeadRef ?? "undefined";
      lines.push(
        `  return handlePageGet(undefined, ${headArg}, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
      );
    }
    lines.push(`});`);

    // Action (POST, PUT, PATCH, DELETE all route to action)
    if (page.methods.includes("action") || page.methods.includes("actions")) {
      const loaderName = `_pload_${safeId}`;
      lines.push(
        `app.on(["POST", "PUT", "PATCH", "DELETE"], ${JSON.stringify(page.pattern)}, async (c) => {`,
      );
      lines.push(`  const mod = await ${loaderName}();`);

      if (page.methods.includes("actions")) {
        // Named actions — resolve from query string
        lines.push(`  const actionName = new URL(c.req.url).searchParams.keys().next().value;`);
        lines.push(
          `  const handler = actionName ? mod.actions?.[actionName] : mod.actions?.default;`,
        );
        lines.push(
          `  if (!handler) return new Response("Unknown action" + (actionName ? ": " + actionName : ""), { status: 404 });`,
        );
      } else {
        // Single action (backward compat)
        lines.push(`  const handler = mod.action;`);
      }

      lines.push(
        `  return handlePageMutation(handler, mod.loader, mod.head, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
      );
      lines.push(`});`);
    }
  }
  lines.push("");

  // Asset fallback — delegates to env.ASSETS binding (static files from dist/client)
  lines.push(`async function fetchPagesAsset(c) {`);
  lines.push(`  const assets = c.env?.ASSETS;`);
  lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
  lines.push(`    return new Response("Not Found", { status: 404 });`);
  lines.push(`  }`);
  lines.push(`  return assets.fetch(c.req.raw);`);
  lines.push(`}`);
  lines.push("");

  // Custom error page helper — serves {status}.html from static assets (e.g. 404.html, 500.html)
  lines.push(`async function serveCustomErrorPage(c, status, fallbackText) {`);
  lines.push(`  try {`);
  lines.push(`    const assets = c.env?.ASSETS;`);
  lines.push(`    if (assets && typeof assets.fetch === "function") {`);
  lines.push(`      const errReq = new Request(new URL("/" + status + ".html", c.req.url));`);
  lines.push(`      const errRes = await assets.fetch(errReq);`);
  lines.push(`      if (errRes.ok) {`);
  lines.push(
    `        return new Response(errRes.body, { status, headers: { "content-type": "text/html; charset=utf-8" } });`,
  );
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  } catch {}`);
  lines.push(`  return new Response(fallbackText, { status });`);
  lines.push(`}`);
  lines.push("");

  // Global error handler — preserve HTTPException responses (e.g. 401 from requireAuth),
  // serve custom 500.html for unexpected errors
  lines.push(`app.onError((err, c) => {`);
  lines.push(`  if ("getResponse" in err) return err.getResponse();`);
  lines.push(`  console.error(err);`);
  lines.push(`  return serveCustomErrorPage(c, 500, "Internal Server Error");`);
  lines.push(`});`);
  lines.push("");

  // Page fallback — for unmatched non-API paths, try static assets first,
  // then attempt to render the index page as an SPA fallback.
  // Uses notFound (not get("*")) so Vite's module pipeline can serve .vue/.ts files in dev.
  lines.push(`app.notFound(async (c) => {`);
  lines.push(`  const path = c.req.path;`);
  lines.push(`  if (path === "/api" || path.startsWith("/api/")) {`);
  lines.push(`    return c.text("Not Found", 404);`);
  lines.push(`  }`);
  // Try static assets for any path (not just dot-containing last segments)
  lines.push(`  const assetRes = await fetchPagesAsset(c);`);
  lines.push(`  if (assetRes.status !== 404) return assetRes;`);
  // If path has a file extension (e.g. /missing.css), don't fall through to SPA —
  // serve 404 so the browser doesn't try to parse HTML as CSS/JS/image
  lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(path)) {`);
  lines.push(`    return serveCustomErrorPage(c, 404, "Not Found");`);
  lines.push(`  }`);
  // SPA fallback — render the index page; errors propagate to app.onError (500)
  lines.push(
    `  return handlePageGet(undefined, undefined, c, "index", renderPage, getPagesAssetTags, __voidHeadConfig);`,
  );
  lines.push(`});`);
  lines.push("");
}

/**
 * Generate the Worker entry module code.
 * Re-exports the Hono app from the virtual module with an asset-serving
 * fallthrough: when the app returns 404, the entry tries env.ASSETS.fetch()
 * and adds proper Cache-Control headers (immutable for Vite-hashed /assets/*).
 *
 * When `hasQueues` is true, also exports a `queue()` handler that
 * serializes the native MessageBatch and dispatches it to the
 * `/__queue` Hono route. In local dev Miniflare delivers batches
 * natively to this export; in production the relay worker does it.
 *
 * When `remotePath` is provided, wraps the fetch handler to detect
 * remote mode (`__VOID_REMOTE`) and replace local bindings with
 * proxy-backed versions.
 */
export function compileWorkerEntry(
  hasQueues = false,
  remote?: { remotePath: string; envPath: string },
  assetsDir = "assets",
  webSocketClasses: string[] = [],
  runtimeEnvPath = "void/_env",
): string {
  const remotePath = remote?.remotePath;
  const runtimeEnvImport = `import { withRuntimeEnv } from ${JSON.stringify(runtimeEnvPath)};\n`;
  const remoteImport = remote
    ? `import { createRemoteEnv } from ${JSON.stringify(remote.remotePath)};\n`
    : "";

  // Asset fallthrough helper — if the app returns 404, check ASSETS binding
  // for static files and set cache headers. Edge caching of hashed assets
  // happens at the dispatch layer (see design doc 0042).
  // Safe for workers without ASSETS binding (env.ASSETS check short-circuits).
  const assetHelper = `
async function serveWithAssets(request, env, response) {
  if (response.status !== 404 || !env.ASSETS) return response;
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return response;
  const res = new Response(asset.body, asset);
  if (new URL(request.url).pathname.startsWith(${JSON.stringify("/" + assetsDir + "/")})) {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.headers.set("Cache-Control", "public, s-maxage=60, max-age=0, must-revalidate");
  }
  return res;
}
`;

  const fetchHandler = remotePath
    ? `async (request, env, ctx) => {
  const ws = await __voidHandleWebSocket(request, env);
  if (ws) return ws;
  if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);
  return withRuntimeEnv(env, async () => {
    const internal = await __handleInternal(request, env, ctx);
    if (internal) return internal;
    return serveWithAssets(request, env, await app.fetch(request, env, ctx));
  });
}`
    : `async (request, env, ctx) => {
  const ws = await __voidHandleWebSocket(request, env);
  if (ws) return ws;
  return withRuntimeEnv(env, async () => {
    const internal = await __handleInternal(request, env, ctx);
    if (internal) return internal;
    return serveWithAssets(request, env, await app.fetch(request, env, ctx));
  });
}`;

  const queueFetchCall = remotePath
    ? `if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);
  const __queueRes = await withRuntimeEnv(env, () => app.fetch(req, env, ctx));`
    : "const __queueRes = await withRuntimeEnv(env, () => app.fetch(req, env, ctx));";

  const queueDecisionCode = `const __qr = await __queueRes.json();
  if (__qr.decisions) {
    const __msgMap = new Map();
    for (const m of batch.messages) __msgMap.set(m.id, m);
    for (const [id, d] of Object.entries(__qr.decisions)) {
      const m = __msgMap.get(id);
      if (!m) continue;
      if (d.action === "ack") m.ack();
      else if (d.action === "retry") m.retry(d.delaySeconds != null ? { delaySeconds: d.delaySeconds } : undefined);
    }
  }
  if (!__qr.ok) throw new Error("Queue handler failed");`;

  const internalRouteHelper = `async function __handleInternal(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/__void/prerender-paths") return null;
  const paths = await __voidCollectPrerenderPaths(request, env, ctx);
  return Response.json({ paths });
}`;

  const scheduledHandler = remotePath
    ? `async function handleScheduled(controller, env, ctx) {
  if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);
  return withRuntimeEnv(env, () => scheduled(controller, env, ctx));
}`
    : `async function handleScheduled(controller, env, ctx) {
  return withRuntimeEnv(env, () => scheduled(controller, env, ctx));
}`;

  if (hasQueues) {
    return `import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleWebSocket${webSocketClasses.length > 0 ? `, ${webSocketClasses.join(", ")}` : ""} } from 'virtual:void-routes';
${runtimeEnvImport}${remoteImport}${assetHelper}
${internalRouteHelper}
${scheduledHandler}
async function queue(batch, env, ctx) {
  const messages = [...batch.messages].map(m => ({
    id: m.id, timestamp: m.timestamp.toISOString(),
    body: m.body, attempts: m.attempts,
  }));
  const req = new Request("https://localhost/__queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue: batch.queue, messages }),
  });
  ${queueFetchCall}
  ${queueDecisionCode}
}

${webSocketClasses.map((name) => `export { ${name} };`).join("\n")}
export default { fetch: ${fetchHandler}, scheduled: handleScheduled, queue };`;
  }
  return `import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleWebSocket${webSocketClasses.length > 0 ? `, ${webSocketClasses.join(", ")}` : ""} } from 'virtual:void-routes';
${runtimeEnvImport}${remoteImport}${assetHelper}
${internalRouteHelper}
${scheduledHandler}
${webSocketClasses.map((name) => `export { ${name} };`).join("\n")}
export default { fetch: ${fetchHandler}, scheduled: handleScheduled };`;
}

/**
 * Generate the app module — exports the Hono app with static asset serving.
 * This is the entry imported by `vite preview` and can be used programmatically.
 */
export function compileNodeApp(target: "node" | "bun" | "deno", honoPath: string): string {
  const staticImport =
    target === "bun"
      ? `import { serveStatic } from "hono/bun";`
      : target === "deno"
        ? `import { serveStatic } from "hono/deno";`
        : `import { serveStatic } from "@hono/node-server/serve-static";`;

  return `${staticImport}
import { Hono } from ${JSON.stringify(honoPath)};
import innerApp, { __voidCollectPrerenderPaths } from "virtual:void-routes";

const app = new Hono();
app.post("/__void/prerender-paths", async (c) => {
  const paths = await __voidCollectPrerenderPaths(c.req.raw);
  return c.json({ paths });
});
app.use("/assets/*", serveStatic({ root: "./client" }));
app.all("*", (c) => innerApp.fetch(c.req.raw));
export default app;`;
}

/**
 * Generate the server entry — imports the app and starts an HTTP server.
 * This is what users run with `node dist/ssr/index.js`.
 */
export function compileNodeServer(target: "node" | "bun" | "deno"): string {
  if (target === "bun") {
    return `import app from "./app.js";

const port = Number(process.env.PORT || 3000);
Bun.serve({ fetch: app.fetch, port });
console.log("Listening on http://localhost:" + port);`;
  }

  if (target === "deno") {
    return `import app from "./app.js";

const port = Number(Deno.env.get("PORT") || 3000);
Deno.serve({ port }, app.fetch);`;
  }

  // Node.js (default)
  return `import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log("Listening on http://localhost:" + info.port);
});`;
}

/**
 * Generate the server-side fetch client module for non-CF targets.
 * Same as compileWorkerClient but without cloudflare:workers dependency.
 * Calls app.fetch() directly (no HTTP round-trip) with ALS context forwarding.
 */
export function compileBrowserClient(
  authClientPath: string,
  fetchPath: string,
  fetchStreamPath: string,
): string {
  return `export { fetch, FetchError } from ${JSON.stringify(fetchPath)};
export { fetchStream, StreamError } from ${JSON.stringify(fetchStreamPath)};
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};`;
}

export function compileNodeClient(authClientPath: string): string {
  return `import app, { requestContext } from "virtual:void-routes";
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};

export class FetchError extends Error {
  constructor(status, statusText, data) {
    super(\`Request failed with status \${status}\`);
    this.name = "FetchError";
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

export async function fetch(path, options) {
  let url = path;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(":" + key, encodeURIComponent(value));
    }
  }

  if (options?.query) {
    const qs = new URLSearchParams(options.query).toString();
    if (qs) url += "?" + qs;
  }

  const method = options?.method ?? "GET";
  const headers = new Headers(options?.headers);

  const store = requestContext.getStore();
  if (store?.request) {
    const outerReq = store.request;
    if (!headers.has("cookie")) {
      const cookie = outerReq.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
    }
    if (!headers.has("authorization")) {
      const auth = outerReq.headers.get("authorization");
      if (auth) headers.set("authorization", auth);
    }
  }

  if (options?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request("http://localhost" + url, {
    method,
    headers,
    body: options?.body != null ? JSON.stringify(options.body) : undefined,
  });

  const response = await app.fetch(request);

  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new FetchError(response.status, response.statusText, data);
  }

  return data;
}`;
}

/**
 * Emit inline `matchPattern()` — glob `*` → regex matching.
 * Mirrors the dispatch worker's `matchPattern()` from `packages/dispatch/src/headers.ts`.
 */
function emitMatchPattern(lines: string[]): void {
  lines.push("function __matchPattern(pattern, pathname) {");
  lines.push(
    '  const escaped = pattern.replace(/[.+?^${}()|[\\]\\\\]/g, "\\\\$&").replaceAll("*", ".*");',
  );
  lines.push("  return new RegExp(`^${escaped}$`).test(pathname);");
  lines.push("}");
  lines.push("");
}

/**
 * Emit redirect middleware — short-circuits matching requests before route handlers.
 * Last match wins, consistent with dispatch worker behavior.
 */
function compileRedirectMiddleware(lines: string[], rules: RedirectRule[]): void {
  emitMatchPattern(lines);
  lines.push("// Redirect rules (applied before route handlers)");
  lines.push(`const __redirectRules = ${JSON.stringify(rules)};`);
  lines.push('app.use("*", async (c, next) => {');
  lines.push("  const pathname = new URL(c.req.url).pathname;");
  lines.push("  let matched;");
  lines.push("  for (const rule of __redirectRules) {");
  lines.push("    if (__matchPattern(rule.source, pathname)) matched = rule;");
  lines.push("  }");
  lines.push("  if (matched) {");
  lines.push("    let dest = matched.destination;");
  lines.push('    if (dest.includes(":splat") && matched.source.includes("*")) {');
  lines.push('      const prefix = matched.source.split("*")[0];');
  lines.push("      const splat = pathname.slice(prefix.length);");
  lines.push('      dest = dest.replace(":splat", splat);');
  lines.push("    }");
  lines.push("    return c.redirect(dest, matched.status);");
  lines.push("  }");
  lines.push("  return next();");
  lines.push("});");
  lines.push("");
}

/**
 * Emit header middleware — applies matching header rules to every response.
 * All matching rules merge; last match wins for same header name.
 */
function compileHeaderMiddleware(lines: string[], rules: HeaderRule[]): void {
  // matchPattern may already be emitted by redirect middleware
  if (!lines.some((l) => l.includes("function __matchPattern"))) {
    emitMatchPattern(lines);
  }
  lines.push("// Header rules (applied to responses)");
  lines.push(`const __headerRules = ${JSON.stringify(rules)};`);
  lines.push('app.use("*", async (c, next) => {');
  lines.push("  await next();");
  lines.push("  const pathname = new URL(c.req.url).pathname;");
  lines.push("  const matched = [];");
  lines.push("  for (const rule of __headerRules) {");
  lines.push("    if (__matchPattern(rule.pattern, pathname)) matched.push(...rule.headers);");
  lines.push("  }");
  lines.push("  for (const [name, value] of matched) {");
  lines.push("    c.res.headers.set(name, value);");
  lines.push("  }");
  lines.push("});");
  lines.push("");
}

export function compileWorkerClient(authClientPath: string): string {
  return `import app, { requestContext } from "virtual:void-routes";
import { env } from "cloudflare:workers";
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};

export class FetchError extends Error {
  constructor(status, statusText, data) {
    super(\`Request failed with status \${status}\`);
    this.name = "FetchError";
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

export async function fetch(path, options) {
  let url = path;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(":" + key, encodeURIComponent(value));
    }
  }

  if (options?.query) {
    const qs = new URLSearchParams(options.query).toString();
    if (qs) url += "?" + qs;
  }

  const method = options?.method ?? "GET";
  const headers = new Headers(options?.headers);

  // Auto-forward cookie and authorization from the outer request via ALS
  const store = requestContext.getStore();
  if (store?.request) {
    const outerReq = store.request;
    if (!headers.has("cookie")) {
      const cookie = outerReq.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
    }
    if (!headers.has("authorization")) {
      const auth = outerReq.headers.get("authorization");
      if (auth) headers.set("authorization", auth);
    }
  }

  if (options?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request("http://worker.local" + url, {
    method,
    headers,
    body: options?.body != null ? JSON.stringify(options.body) : undefined,
  });

  // Use real executionCtx from ALS if available, otherwise provide a no-op fallback
  const executionCtx = store?.executionCtx ?? { waitUntil() {}, passThroughOnException() {} };
  const response = await app.fetch(request, env, executionCtx);

  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new FetchError(response.status, response.statusText, data);
  }

  return data;
}
`;
}
