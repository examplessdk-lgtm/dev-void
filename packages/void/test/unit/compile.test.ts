import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/router/scan";

import { compileRouteTable, compileWorkerEntry } from "../../src/router/compile";

const testOptions = {
  honoPath: "/resolved/hono/index.mjs",
  responsePath: "/resolved/void/runtime/response.mjs",
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
      pages: { pages: [], layouts: [] },
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
      pages: { pages: [], layouts: [] },
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
      pages: { pages: [], layouts: [] },
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
      pages: { pages: [], layouts: [] },
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

  it("adds SSR fallback handler when ssr entry is provided", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
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
      pages: { pages: [], layouts: [] },
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
    expect(code).toContain("mod.default(payload, c.env)");
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
      pages: { pages: [], layouts: [] },
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
      pages: { pages: [], layouts: [] },
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
});

describe("compileWorkerEntry", () => {
  it("generates valid worker entry code without queues", () => {
    const code = compileWorkerEntry();

    expect(code).toContain("import app, { scheduled } from 'virtual:void-routes'");
    expect(code).toContain("export default { fetch: app.fetch, scheduled }");
    expect(code).not.toContain("queue");
  });

  it("generates queue() export in worker entry when hasQueues=true", () => {
    const code = compileWorkerEntry(true);

    expect(code).toContain("async function queue(batch, env, ctx)");
    expect(code).toContain("export default { fetch: app.fetch, scheduled, queue }");
    expect(code).toContain("/__queue");
    expect(code).toContain("batch.queue");
    expect(code).toContain("m.timestamp.toISOString()");
  });

  it("omits queue() export when hasQueues=false", () => {
    const code = compileWorkerEntry(false);

    expect(code).not.toContain("queue");
  });
});
