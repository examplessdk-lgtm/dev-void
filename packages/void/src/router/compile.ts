import type { HeaderRule, RedirectRule } from "../cli/types";
import type { ScanResult } from "./scan";

/**
 * Script tag injected into dev HTML to load the binding-hint virtual module.
 * The virtual module (served by restartPlugin) listens for `void:new-binding`
 * HMR events and shows a toast with a click-to-restart action.
 */
const BINDING_HINT_SCRIPT = `<script type="module" src="/@id/virtual:void/binding-hint"></script>`;

export type AuthProvider = "github" | "google" | "email";

export interface AuthCompileOptions {
  providers: AuthProvider[];
  sessionPath: string;
  passwordPath: string | null;
  schemaPath: string;
  githubProviderPath: string | null;
  googleProviderPath: string | null;
  /** Resolved path to void/auth — used to import the shared authContext ALS. */
  authRuntimePath: string;
}

export interface CompileOptions {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to the void/response module */
  responsePath: string;
  /** Whether to inject React Fast Refresh preamble in dev SSR HTML. */
  reactRefresh: boolean;
  /** Auth configuration (null = disabled) */
  auth: AuthCompileOptions | null;
  /** Non-CF target — omits executionCtx from ALS context */
  nodeTarget?: boolean;
  /** Header rules from routing.headers config (node targets only) */
  headerRules?: HeaderRule[];
  /** Redirect rules from routing.redirects config (node targets only) */
  redirectRules?: RedirectRule[];
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

  lines.push(`import { AsyncLocalStorage } from "node:async_hooks";`);
  lines.push(`import { Hono } from ${JSON.stringify(options.honoPath)};`);
  lines.push(`import { convertReturnValue } from ${JSON.stringify(options.responsePath)};`);

  // Auth imports
  if (auth) {
    lines.push(
      `import { parseSessionCookie, buildSetCookieHeader, buildClearCookieHeader, generateSessionId, SESSION_TTL_SECONDS } from ${JSON.stringify(auth.sessionPath)};`,
    );
    lines.push(
      `import { CREATE_AUTH_TABLES_SQL, generateUserId } from ${JSON.stringify(auth.schemaPath)};`,
    );
    if (auth.passwordPath) {
      lines.push(
        `import { hashPassword, verifyPassword } from ${JSON.stringify(auth.passwordPath)};`,
      );
    }
    if (auth.githubProviderPath) {
      lines.push(`import { githubAuth } from ${JSON.stringify(auth.githubProviderPath)};`);
    }
    if (auth.googleProviderPath) {
      lines.push(`import { googleAuth } from ${JSON.stringify(auth.googleProviderPath)};`);
    }
    lines.push(`import { authContext } from ${JSON.stringify(auth.authRuntimePath)};`);
  }
  lines.push("");

  // Generate eager imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  lines.push("");

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

  // Auth: ensure tables exist + session middleware
  if (auth) {
    lines.push("let authReady = false;");
    lines.push("app.use(async (c, next) => {");
    lines.push("  if (!authReady) {");
    lines.push("    await c.env.DB.prepare(CREATE_AUTH_TABLES_SQL).run();");
    lines.push("    authReady = true;");
    lines.push("  }");
    lines.push("  await next();");
    lines.push("});");
    lines.push("");
    lines.push("app.use(async (c, next) => {");
    lines.push('  const sid = parseSessionCookie(c.req.header("cookie"));');
    lines.push("  if (sid) {");
    lines.push('    const session = await c.env.AUTH_KV.get("session:" + sid, "json");');
    lines.push("    if (session && session.expiresAt > Date.now()) {");
    lines.push('      c.set("user", {');
    lines.push("        id: session.userId,");
    lines.push("        provider: session.provider,");
    lines.push("        email: session.email,");
    lines.push("        name: session.name,");
    lines.push("        avatar_url: session.avatar_url,");
    lines.push("      });");
    lines.push("    }");
    lines.push("  }");
    lines.push('  const __user = c.get("user") ?? null;');
    lines.push("  await authContext.run({ user: __user }, next);");
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

  // Auth routes
  if (auth) {
    compileAuthRoutes(lines, auth);
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

  // Pages mode — generate page route handlers
  if (pages && scan.pages.pages.length > 0) {
    compilePageRoutes(lines, scan, pages);
  }

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

  lines.push(`export default app;`);

  return lines.join("\n");
}

function compileAuthRoutes(lines: string[], auth: AuthCompileOptions): void {
  const hasEmail = auth.providers.includes("email");
  const hasGitHub = auth.providers.includes("github");
  const hasGoogle = auth.providers.includes("google");

  if (hasEmail) {
    // POST /auth/register
    lines.push('app.post("/auth/register", async (c) => {');
    lines.push("  const { email, password, name } = await c.req.json();");
    lines.push(
      '  if (!email || !password) return c.json({ error: "email and password required" }, 400);',
    );
    lines.push("  const existing = await c.env.DB.prepare(");
    lines.push("    \"SELECT id FROM auth_users WHERE provider = 'email' AND provider_id = ?\"");
    lines.push("  ).bind(email).first();");
    lines.push('  if (existing) return c.json({ error: "email already registered" }, 409);');
    lines.push("  const userId = generateUserId();");
    lines.push("  const hash = await hashPassword(password);");
    lines.push("  await c.env.DB.prepare(");
    lines.push(
      "    \"INSERT INTO auth_users (id, provider, provider_id, email, name, password_hash) VALUES (?, 'email', ?, ?, ?, ?)\"",
    );
    lines.push("  ).bind(userId, email, email, name ?? null, hash).run();");
    lines.push("  const sessionId = generateSessionId();");
    lines.push('  await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push('    userId, provider: "email", email, name: name ?? null, avatar_url: null,');
    lines.push("    createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("  }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('  const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("  const headers = new Headers();");
    lines.push('  headers.set("Set-Cookie", buildSetCookieHeader(sessionId, secure));');
    lines.push(
      "  return c.json({ id: userId, email, name: name ?? null }, { status: 201, headers });",
    );
    lines.push("});");
    lines.push("");

    // POST /auth/login
    lines.push('app.post("/auth/login", async (c) => {');
    lines.push("  const { email, password } = await c.req.json();");
    lines.push(
      '  if (!email || !password) return c.json({ error: "email and password required" }, 400);',
    );
    lines.push("  const user = await c.env.DB.prepare(");
    lines.push(
      "    \"SELECT id, email, name, avatar_url, password_hash FROM auth_users WHERE provider = 'email' AND provider_id = ?\"",
    );
    lines.push("  ).bind(email).first();");
    lines.push(
      '  if (!user || !user.password_hash) return c.json({ error: "invalid credentials" }, 401);',
    );
    lines.push("  const valid = await verifyPassword(password, user.password_hash);");
    lines.push('  if (!valid) return c.json({ error: "invalid credentials" }, 401);');
    lines.push("  const sessionId = generateSessionId();");
    lines.push('  await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push(
      '    userId: user.id, provider: "email", email: user.email, name: user.name, avatar_url: user.avatar_url,',
    );
    lines.push("    createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("  }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('  const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("  const headers = new Headers();");
    lines.push('  headers.set("Set-Cookie", buildSetCookieHeader(sessionId, secure));');
    lines.push(
      "  return c.json({ id: user.id, email: user.email, name: user.name }, { headers });",
    );
    lines.push("});");
    lines.push("");
  }

  if (hasGitHub) {
    lines.push('app.get("/auth/login/github",');
    lines.push("  (c, next) => {");
    lines.push(
      '    if (!c.env.GITHUB_OAUTH_ID || !c.env.GITHUB_OAUTH_SECRET) return c.json({ error: "GitHub OAuth not configured. Set GITHUB_OAUTH_ID and GITHUB_OAUTH_SECRET secrets." }, 500);',
    );
    lines.push("    return githubAuth({");
    lines.push("      client_id: c.env.GITHUB_OAUTH_ID,");
    lines.push("      client_secret: c.env.GITHUB_OAUTH_SECRET,");
    lines.push('      scope: ["read:user", "user:email"],');
    lines.push("      oauthApp: true,");
    lines.push("    })(c, next);");
    lines.push("  },");
    lines.push("  async (c) => {");
    lines.push('    const ghUser = c.get("user-github");');
    lines.push("    const providerId = String(ghUser.id);");
    lines.push("    let user = await c.env.DB.prepare(");
    lines.push(
      "      \"SELECT id, email, name, avatar_url FROM auth_users WHERE provider = 'github' AND provider_id = ?\"",
    );
    lines.push("    ).bind(providerId).first();");
    lines.push("    if (!user) {");
    lines.push("      const userId = generateUserId();");
    lines.push("      await c.env.DB.prepare(");
    lines.push(
      "        \"INSERT INTO auth_users (id, provider, provider_id, email, name, avatar_url) VALUES (?, 'github', ?, ?, ?, ?)\"",
    );
    lines.push(
      "      ).bind(userId, providerId, ghUser.email ?? null, ghUser.name ?? ghUser.login ?? null, ghUser.avatar_url ?? null).run();",
    );
    lines.push(
      "      user = { id: userId, email: ghUser.email, name: ghUser.name ?? ghUser.login, avatar_url: ghUser.avatar_url };",
    );
    lines.push("    }");
    lines.push("    const sessionId = generateSessionId();");
    lines.push('    await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push(
      '      userId: user.id, provider: "github", email: user.email, name: user.name, avatar_url: user.avatar_url,',
    );
    lines.push("      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("    }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('    const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("    return new Response(null, { status: 302, headers: {");
    lines.push('      Location: "/", "Set-Cookie": buildSetCookieHeader(sessionId, secure)');
    lines.push("    }});");
    lines.push("  }");
    lines.push(");");
    lines.push("");
  }

  if (hasGoogle) {
    lines.push('app.get("/auth/login/google",');
    lines.push("  (c, next) => {");
    lines.push(
      '    if (!c.env.GOOGLE_OAUTH_ID || !c.env.GOOGLE_OAUTH_SECRET) return c.json({ error: "Google OAuth not configured. Set GOOGLE_OAUTH_ID and GOOGLE_OAUTH_SECRET secrets." }, 500);',
    );
    lines.push("    return googleAuth({");
    lines.push("      client_id: c.env.GOOGLE_OAUTH_ID,");
    lines.push("      client_secret: c.env.GOOGLE_OAUTH_SECRET,");
    lines.push('      scope: ["openid", "email", "profile"],');
    lines.push("    })(c, next);");
    lines.push("  },");
    lines.push("  async (c) => {");
    lines.push('    const googleUser = c.get("user-google");');
    lines.push("    const providerId = String(googleUser.id);");
    lines.push("    let user = await c.env.DB.prepare(");
    lines.push(
      "      \"SELECT id, email, name, avatar_url FROM auth_users WHERE provider = 'google' AND provider_id = ?\"",
    );
    lines.push("    ).bind(providerId).first();");
    lines.push("    if (!user) {");
    lines.push("      const userId = generateUserId();");
    lines.push("      await c.env.DB.prepare(");
    lines.push(
      "        \"INSERT INTO auth_users (id, provider, provider_id, email, name, avatar_url) VALUES (?, 'google', ?, ?, ?, ?)\"",
    );
    lines.push(
      "      ).bind(userId, providerId, googleUser.email ?? null, googleUser.name ?? null, googleUser.picture ?? null).run();",
    );
    lines.push(
      "      user = { id: userId, email: googleUser.email, name: googleUser.name, avatar_url: googleUser.picture };",
    );
    lines.push("    }");
    lines.push("    const sessionId = generateSessionId();");
    lines.push('    await c.env.AUTH_KV.put("session:" + sessionId, JSON.stringify({');
    lines.push(
      '      userId: user.id, provider: "google", email: user.email, name: user.name, avatar_url: user.avatar_url,',
    );
    lines.push("      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,");
    lines.push("    }), { expirationTtl: SESSION_TTL_SECONDS });");
    lines.push('    const secure = new URL(c.req.url).protocol === "https:";');
    lines.push("    return new Response(null, { status: 302, headers: {");
    lines.push('      Location: "/", "Set-Cookie": buildSetCookieHeader(sessionId, secure)');
    lines.push("    }});");
    lines.push("  }");
    lines.push(");");
    lines.push("");
  }

  // GET /auth/me — always present when auth enabled
  lines.push('app.get("/auth/me", (c) => {');
  lines.push('  const user = c.get("user");');
  lines.push('  if (!user) return c.json({ error: "unauthorized" }, 401);');
  lines.push("  return c.json(user);");
  lines.push("});");
  lines.push("");

  // POST /auth/logout — always present when auth enabled
  lines.push('app.post("/auth/logout", async (c) => {');
  lines.push('  const sid = parseSessionCookie(c.req.header("cookie"));');
  lines.push('  if (sid) await c.env.AUTH_KV.delete("session:" + sid);');
  lines.push("  return new Response(null, { status: 302, headers: {");
  lines.push('    Location: "/", "Set-Cookie": buildClearCookieHeader()');
  lines.push("  }});");
  lines.push("});");
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
  lines.push(`async function getPagesAssetTags(request, env) {`);
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
  lines.push(`  const cssFiles = new Set();`);
  lines.push(`  const preloadFiles = new Set();`);
  lines.push(`  for (const id of ids) {`);
  lines.push(`    const chunk = manifest[id];`);
  lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
  lines.push(`    if (Array.isArray(chunk.css)) {`);
  lines.push(`      for (const cssFile of chunk.css) cssFiles.add(cssFile);`);
  lines.push(`    }`);
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
    lines.push(`async function getIslandsAssetTags(request, env) {`);
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
    lines.push(`  const cssFiles = new Set();`);
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    lines.push(`    if (Array.isArray(chunk.css)) {`);
    lines.push(`      for (const cssFile of chunk.css) cssFiles.add(cssFile);`);
    lines.push(`    }`);
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
    if (page.methods.includes("action")) {
      const loaderName = `_pload_${safeId}`;
      lines.push(
        `app.on(["POST", "PUT", "PATCH", "DELETE"], ${JSON.stringify(page.pattern)}, async (c) => {`,
      );
      lines.push(`  const mod = await ${loaderName}();`);
      lines.push(
        `  return handlePageMutation(mod.action, mod.loader, mod.head, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
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

  // Page fallback — renders index page for unmatched non-API, non-asset paths.
  // Uses notFound (not get("*")) so Vite's module pipeline can serve .vue/.ts files in dev.
  lines.push(`app.notFound(async (c) => {`);
  lines.push(`  const path = c.req.path;`);
  lines.push(`  if (path === "/api" || path.startsWith("/api/")) {`);
  lines.push(`    return c.text("Not Found", 404);`);
  lines.push(`  }`);
  lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(path)) {`);
  lines.push(`    return fetchPagesAsset(c);`);
  lines.push(`  }`);
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
): string {
  const remotePath = remote?.remotePath;
  const remoteImport = remote
    ? `import { createRemoteEnv } from ${JSON.stringify(remote.remotePath)};\nimport { withRuntimeEnv } from ${JSON.stringify(remote.envPath)};\n`
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
  if (env.__VOID_REMOTE === "1") {
    env = createRemoteEnv(env);
    return serveWithAssets(request, env, await withRuntimeEnv(env, () => app.fetch(request, env, ctx)));
  }
  return serveWithAssets(request, env, await app.fetch(request, env, ctx));
}`
    : `async (request, env, ctx) => serveWithAssets(request, env, await app.fetch(request, env, ctx))`;

  const queueFetchCall = remotePath
    ? `let __queueRes;
  if (env.__VOID_REMOTE === "1") {
    env = createRemoteEnv(env);
    __queueRes = await withRuntimeEnv(env, () => app.fetch(req, env, ctx));
  } else {
    __queueRes = await app.fetch(req, env, ctx);
  }`
    : "const __queueRes = await app.fetch(req, env, ctx);";

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

  if (hasQueues) {
    return `import app, { scheduled } from 'virtual:void-routes';
${remoteImport}${assetHelper}
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

export default { fetch: ${fetchHandler}, scheduled, queue };`;
  }
  return `import app, { scheduled } from 'virtual:void-routes';
${remoteImport}${assetHelper}
export default { fetch: ${fetchHandler}, scheduled };`;
}

/**
 * Generate the app module — exports the Hono app with static asset serving.
 * This is the entry imported by `vite preview` and can be used programmatically.
 */
export function compileNodeApp(target: "node" | "bun" | "deno"): string {
  const staticImport =
    target === "bun"
      ? `import { serveStatic } from "hono/bun";`
      : target === "deno"
        ? `import { serveStatic } from "hono/deno";`
        : `import { serveStatic } from "@hono/node-server/serve-static";`;

  return `${staticImport}
import app from "virtual:void-routes";

app.use("/assets/*", serveStatic({ root: "./client" }));
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
export function compileNodeClient(): string {
  return `import app, { requestContext } from "virtual:void-routes";

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
export { auth, AuthError } from ${JSON.stringify(authClientPath)};

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
