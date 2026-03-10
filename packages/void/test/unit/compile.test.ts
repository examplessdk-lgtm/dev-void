import { describe, expect, it } from "vitest";
import {
  compileRouteTable,
  compileWorkerEntry,
  compileNodeApp,
  compileNodeServer,
} from "../../src/router/compile";
import type { ScanResult } from "../../src/router/scan";

const testOptions = {
  honoPath: "/resolved/hono/index.mjs",
  responsePath: "/resolved/void/runtime/response.mjs",
  runtimeEnvPath: "/resolved/void/runtime/env.mjs",
  webSocketRuntimePath: "/resolved/void/runtime/ws-server.mjs",
  reactRefresh: true,
  auth: null,
};

describe("compileRouteTable", () => {
  it("generates valid module code with named-export routes and middleware", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/hello",
          methods: ["GET"],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/hello.ts",
        },
        {
          pattern: "/api/users/:id",
          methods: ["GET", "PUT"],
          params: ["id"],
          catchAll: false,
          env: null,
          filePath: "api/users/[id].ts",
        },
      ],
      middleware: [{ order: 1, filePath: "01.logger.ts" }],
      jobs: [{ filePath: "sync.ts", name: "sync", crons: ["0 * * * *"] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    // Should import Hono from resolved path
    expect(code).toContain(`import { Hono } from "/resolved/hono/index.mjs"`);
    // Should import convertReturnValue
    expect(code).toContain(
      `import { convertReturnValue } from "/resolved/void/runtime/response.mjs"`,
    );
    // Should import middleware eagerly
    expect(code).toContain('import middleware0 from "/middleware/01.logger.ts"');
    // Should create Hono app
    expect(code).toContain("const app = new Hono()");
    // Should register middleware
    expect(code).toContain("app.use(middleware0)");
    // Should register routes with named exports
    expect(code).toContain('app.get("/api/hello"');
    expect(code).toContain("mod.GET(c)");
    expect(code).toContain('app.get("/api/users/:id"');
    expect(code).toContain('app.put("/api/users/:id"');
    expect(code).toContain("mod.PUT(c)");
    // Should have shared lazy loaders
    expect(code).toContain("async function _load_api_hello_ts()");
    expect(code).toContain('import("/routes/api/hello.ts")');
    expect(code).toContain('import("/routes/api/users/[id].ts")');
    // Should generate scheduled handler for cron jobs
    expect(code).toContain("export async function scheduled(controller, env, ctx)");
    expect(code).toContain('const job0Crons = ["0 * * * *"]');
    expect(code).toContain('import("/crons/sync.ts")');
    // Should export app as default
    expect(code).toContain("export default app");
  });

  it("generates multiple case labels for multi-cron jobs", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [{ filePath: "multi.ts", name: "multi", crons: ["0 * * * *", "30 * * * *"] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).toContain('const job0Crons = ["0 * * * *","30 * * * *"]');
    // Two case labels falling through to the same handler
    expect(code).toContain("case job0Crons[0]:");
    expect(code).toContain("case job0Crons[1]: {");
    expect(code).toContain('import("/crons/multi.ts")');
  });

  it("falls back to app.all with mod.default for no HTTP exports", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/legacy",
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/legacy.ts",
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).toContain('app.all("/api/legacy"');
    expect(code).toContain("mod.default(c)");
  });

  it("handles empty scan result", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).toContain("const app = new Hono()");
    expect(code).toContain("export async function scheduled() {}");
    expect(code).toContain("export default app");
  });

  it("does not import runtime env helpers for node targets", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...testOptions,
      nodeTarget: true,
    });

    expect(code).not.toContain(`import { withRuntimeEnv }`);
    expect(code).toContain("const withRuntimeEnv = (_env, fn) => fn();");
  });

  it("adds SSR fallback handler when ssr entry is provided", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      {
        serverEntryPath: "/src/main.ssr.ts",
        clientEntryRelativePath: "src/main.client.tsx",
      },
      testOptions,
    );

    expect(code).toContain("app.notFound(async (c) => {");
    expect(code).toContain("if (!shouldHandleSsrRequest(c))");
    expect(code).toContain("return fetchFromAssets(c)");
    expect(code).toContain('import("/src/main.ssr.ts")');
    expect(code).toContain("return renderSsrResponse(c, mod)");
    expect(code).toContain("return render(c, assetTags)");
    expect(code).toContain('const SSR_CLIENT_ENTRY_ID = "src/main.client.tsx"');
    expect(code).toContain('const SSR_CLIENT_ENTRY_URL = "/src/main.client.tsx"');
    expect(code).toContain('new URL("/.vite/manifest.json", request.url)');
    expect(code).toContain('src="/@vite/client"');
    expect(code).toContain('from "/@react-refresh"');
    expect(code).toContain("__vite_plugin_react_preamble_installed__ = true");
  });

  it("generates /__queue route for queue consumers", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [
        {
          filePath: "emails.ts",
          name: "emails",
          bindingName: "QUEUE_EMAILS",
        },
      ],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).toContain('app.post("/__queue"');
    expect(code).toContain('const queue0Name = "emails"');
    expect(code).toContain('import("/queues/emails.ts")');
    expect(code).toContain("mod.default(batch, c.env)");
  });

  it("matches queue name with endsWith for prefixed names", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [
        {
          filePath: "emails.ts",
          name: "emails",
          bindingName: "QUEUE_EMAILS",
        },
      ],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).toContain('queueSuffix.endsWith("-" + queue0Name)');
  });

  it("omits /__queue route when no queues defined", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).not.toContain("/__queue");
  });

  it("generates websocket durable object exports and proxy routes", () => {
    const scan: ScanResult = {
      routes: [],
      websockets: [
        {
          pattern: "/chat/:room",
          methods: [],
          params: ["room"],
          catchAll: false,
          env: null,
          filePath: "chat/[room].ws.ts",
          className: "ChatRoomWs",
          bindingName: "ChatRoomWs",
          mode: "room",
          hasAuthGate: true,
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
    );

    expect(code).toContain('import websocket0 from "/routes/chat/[room].ws.ts"');
    expect(code).toContain("createWebSocketDurableObject");
    expect(code).toContain("export const ChatRoomWs = __createWebSocketDurableObject");
    expect(code).toContain('const __voidWebSocketRoutes = [{"pattern":"/chat/:room"');
    expect(code).toContain("export async function __voidHandleWebSocket(request, env)");
    expect(code).toContain('app.all("/chat/:room"');
    expect(code).toContain("__forwardWebSocketRequest");
  });
});

describe("compileWorkerEntry", () => {
  it("generates valid worker entry code without queues", () => {
    const code = compileWorkerEntry();

    expect(code).toContain(
      "import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleWebSocket } from 'virtual:void-routes'",
    );
    expect(code).toContain('import { withRuntimeEnv } from "void/_env"');
    expect(code).toContain("serveWithAssets");
    expect(code).toContain("return withRuntimeEnv(env, async () => {");
    expect(code).toContain("export default { fetch:");
    expect(code).toContain("scheduled: handleScheduled");
    expect(code).not.toContain("queue");
  });

  it("re-exports websocket classes when present", () => {
    const code = compileWorkerEntry(false, undefined, "assets", ["ChatRoomWs"]);

    expect(code).toContain(
      "import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleWebSocket, ChatRoomWs } from 'virtual:void-routes'",
    );
    expect(code).toContain("export { ChatRoomWs };");
    expect(code).toContain("const ws = await __voidHandleWebSocket(request, env);");
  });

  it("generates queue() export in worker entry when hasQueues=true", () => {
    const code = compileWorkerEntry(true);

    expect(code).toContain("async function queue(batch, env, ctx)");
    expect(code).toContain("async function handleScheduled(controller, env, ctx)");
    expect(code).toContain("serveWithAssets");
    expect(code).toContain("scheduled: handleScheduled, queue }");
    expect(code).toContain("/__queue");
    expect(code).toContain("batch.queue");
    expect(code).toContain("m.timestamp.toISOString()");
    expect(code).toContain("withRuntimeEnv(env, () => app.fetch(req, env, ctx))");
  });

  it("omits queue() export when hasQueues=false", () => {
    const code = compileWorkerEntry(false);

    expect(code).not.toContain("queue");
  });

  it("generates serveWithAssets helper with cache headers", () => {
    const code = compileWorkerEntry();

    expect(code).toContain("async function serveWithAssets(request, env, response)");
    expect(code).toContain('url.pathname !== "/__void/prerender-paths"');
    expect(code).toContain("env.ASSETS");
    expect(code).toContain('"/assets/"');
    // Both cache-control values (hashed + non-hashed)
    expect(code).toContain("public, max-age=31536000, immutable");
    expect(code).toContain("public, s-maxage=60, max-age=0, must-revalidate");
    // No Cache API usage (edge caching happens at dispatch layer)
    expect(code).not.toContain("caches.default");
    expect(code).not.toContain("cache.match");
    expect(code).not.toContain("cache.put");
  });

  it("uses custom assetsDir in serveWithAssets path check", () => {
    const code = compileWorkerEntry(false, undefined, "_astro");

    expect(code).toContain('"/_astro/"');
    expect(code).not.toContain('"/assets/"');
  });

  it("wraps remote-mode fetch and scheduled handlers with resolved runtime env", () => {
    const code = compileWorkerEntry(
      false,
      { remotePath: "/resolved/remote.mjs", envPath: "/resolved/env-legacy.mjs" },
      "assets",
      [],
      "/resolved/env.mjs",
    );

    expect(code).toContain('import { withRuntimeEnv } from "/resolved/env.mjs"');
    expect(code).toContain('import { createRemoteEnv } from "/resolved/remote.mjs"');
    expect(code).toContain('if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);');
    expect(code).toContain("return withRuntimeEnv(env, async () => {");
    expect(code).toContain("return withRuntimeEnv(env, () => scheduled(controller, env, ctx));");
  });
});

describe("compileNodeApp", () => {
  it("generates node app with serveStatic and default export", () => {
    const code = compileNodeApp("node", "/resolved/hono/index.mjs");
    expect(code).toContain('import { serveStatic } from "@hono/node-server/serve-static"');
    expect(code).toContain('import { Hono } from "/resolved/hono/index.mjs"');
    expect(code).toContain("export default app");
    expect(code).toContain(
      'import innerApp, { __voidCollectPrerenderPaths } from "virtual:void-routes"',
    );
    expect(code).toContain('app.post("/__void/prerender-paths"');
  });

  it("generates bun app with hono/bun serveStatic", () => {
    const code = compileNodeApp("bun", "/resolved/hono/index.mjs");
    expect(code).toContain('import { serveStatic } from "hono/bun"');
    expect(code).toContain("export default app");
    expect(code).not.toContain("@hono/node-server");
  });

  it("generates deno app with hono/deno serveStatic", () => {
    const code = compileNodeApp("deno", "/resolved/hono/index.mjs");
    expect(code).toContain('import { serveStatic } from "hono/deno"');
    expect(code).toContain("export default app");
    expect(code).not.toContain("@hono/node-server");
  });
});

describe("compileNodeServer", () => {
  it("generates node server with @hono/node-server", () => {
    const code = compileNodeServer("node");
    expect(code).toContain('import { serve } from "@hono/node-server"');
    expect(code).toContain('import app from "./app.js"');
    expect(code).toContain("app.fetch");
    expect(code).toContain("process.env.PORT");
  });

  it("generates bun server with Bun.serve", () => {
    const code = compileNodeServer("bun");
    expect(code).toContain("Bun.serve");
    expect(code).toContain('import app from "./app.js"');
    expect(code).not.toContain("@hono/node-server");
  });

  it("generates deno server with Deno.serve", () => {
    const code = compileNodeServer("deno");
    expect(code).toContain("Deno.serve");
    expect(code).toContain('import app from "./app.js"');
    expect(code).not.toContain("@hono/node-server");
  });
});
