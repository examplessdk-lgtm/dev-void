import { describe, expect, it } from 'vitest';
import {
  compileRouteTable,
  compileWorkerEntry,
  compileNodeApp,
  compileNodeServer,
} from '../../src/router/compile';
import type { ScanResult } from '../../src/router/scan';

const testOptions = {
  honoPath: '/resolved/hono/index.mjs',
  responsePath: '/resolved/void/runtime/response.mjs',
  runtimeEnvPath: '/resolved/void/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  webSocketRuntimePath: '/resolved/void/runtime/ws-server.mjs',
  reactRefresh: true,
  auth: null,
};

describe('compileRouteTable', () => {
  it('generates valid module code with named-export routes and middleware', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
        {
          pattern: '/api/users/:id',
          methods: ['GET', 'PUT'],
          params: ['id'],
          catchAll: false,
          env: null,
          filePath: 'api/users/[id].ts',
        },
      ],
      middleware: [{ order: 1, filePath: '01.logger.ts' }],
      jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
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
    expect(code).toContain('const app = new Hono()');
    // Should register middleware
    expect(code).toContain('app.use(middleware0)');
    // Should register routes with named exports
    expect(code).toContain('app.get("/api/hello"');
    expect(code).toContain('mod.GET(c)');
    expect(code).toContain('app.get("/api/users/:id"');
    expect(code).toContain('app.put("/api/users/:id"');
    expect(code).toContain('mod.PUT(c)');
    // Should have shared lazy loaders
    expect(code).toContain('async function _load_api_hello_ts()');
    expect(code).toContain('import("/routes/api/hello.ts")');
    expect(code).toContain('import("/routes/api/users/[id].ts")');
    // Should generate scheduled handler for cron jobs
    expect(code).toContain('export async function scheduled(controller, env, ctx)');
    expect(code).toContain('const job0Crons = ["0 * * * *"]');
    expect(code).toContain('import("/crons/sync.ts")');
    // Should export app as default
    expect(code).toContain('export default app');
  });

  it('generates multiple case labels for multi-cron jobs', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [{ filePath: 'multi.ts', name: 'multi', crons: ['0 * * * *', '30 * * * *'] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).toContain('const job0Crons = ["0 * * * *","30 * * * *"]');
    // Two case labels falling through to the same handler
    expect(code).toContain('case job0Crons[0]:');
    expect(code).toContain('case job0Crons[1]: {');
    expect(code).toContain('import("/crons/multi.ts")');
  });

  it('falls back to app.all with mod.default for no HTTP exports', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/legacy',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/legacy.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).toContain('app.all("/api/legacy"');
    expect(code).toContain('mod.default(c)');
  });

  it('handles empty scan result', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).toContain('const app = new Hono()');
    expect(code).toContain('export async function scheduled() {}');
    expect(code).toContain('export default app');
  });

  it('does not import getRuntimeEnv for node targets', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      nodeTarget: true,
    });

    // Node targets must not import getRuntimeEnv — generated code uses __getRawEnv() instead
    expect(code).not.toContain('getRuntimeEnv');
  });

  it('does not import runtime env helpers for node targets', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      nodeTarget: true,
    });

    expect(code).not.toContain(`import { withRuntimeEnv }`);
    expect(code).toContain('const withRuntimeEnv = (_env, fn) => fn();');
  });

  it('adds SSR fallback handler when ssr entry is provided', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      {
        serverEntryPath: '/src/main.ssr.ts',
        clientEntryRelativePath: 'src/main.client.tsx',
      },
      testOptions,
    );

    expect(code).toContain('app.notFound(async (c) => {');
    expect(code).toContain('if (!shouldHandleSsrRequest(c))');
    expect(code).toContain('return fetchFromAssets(c)');
    expect(code).toContain('import("/src/main.ssr.ts")');
    expect(code).toContain('return renderSsrResponse(c, mod)');
    expect(code).toContain('return render(c, assetTags)');
    expect(code).toContain('const SSR_CLIENT_ENTRY_ID = "src/main.client.tsx"');
    expect(code).toContain('const SSR_CLIENT_ENTRY_URL = "/src/main.client.tsx"');
    expect(code).toContain('new URL("/.vite/manifest.json", request.url)');
    expect(code).toContain('src="/@vite/client"');
    expect(code).toContain('from "/@react-refresh"');
    expect(code).toContain('__vite_plugin_react_preamble_installed__ = true');
  });

  it('generates /__void/queue route for queue consumers', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [
        {
          filePath: 'emails.ts',
          name: 'emails',
          bindingName: 'QUEUE_EMAILS',
        },
      ],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).toContain('app.post("/__void/queue"');
    expect(code).toContain('const queue0Name = "emails"');
    expect(code).toContain('import("/queues/emails.ts")');
    expect(code).toContain('mod.default(batch, env)');
    expect(code).toContain('export async function __processQueue');
  });

  it('matches queue name with endsWith for prefixed names', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [
        {
          filePath: 'emails.ts',
          name: 'emails',
          bindingName: 'QUEUE_EMAILS',
        },
      ],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).toContain('queueSuffix.endsWith("-" + queue0Name)');
  });

  it('omits /__void/queue route when no queues defined', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).not.toContain('/__void/queue');
  });

  it('generates /__void/scheduled auth guard with getRuntimeEnv and x-void-internal check', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    // The /__void/scheduled handler: token check OR build key fallback
    expect(code).toContain('app.post("/__void/scheduled"');
    expect(code).toContain('c.req.header("x-void-internal")');
    expect(code).toContain('__getRawEnv()?.__VOID_PROXY_TOKEN');
    expect(code).toContain('__VOID_BUILD_KEY');
  });

  it('generates /__void/queue auth guard with __getRawEnv() and x-void-internal check', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [
        {
          filePath: 'emails.ts',
          name: 'emails',
          bindingName: 'QUEUE_EMAILS',
        },
      ],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    // The /__void/queue HTTP route: token check OR build key fallback
    expect(code).toContain('app.post("/__void/queue"');
    expect(code).toContain('c.req.header("x-void-internal")');
    expect(code).toContain('__VOID_BUILD_KEY');
    // Queue dispatch logic must be exported as __processQueue for direct native handler use
    expect(code).toContain('export async function __processQueue');
  });

  it('exports __VOID_BUILD_KEY as a unique UUID for build-time auth', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code1 = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );
    const code2 = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    // Must export a build key
    expect(code1).toContain('export const __VOID_BUILD_KEY =');
    // Each compilation generates a different key
    const match1 = code1.match(/__VOID_BUILD_KEY = "([^"]+)"/);
    const match2 = code2.match(/__VOID_BUILD_KEY = "([^"]+)"/);
    expect(match1).toBeTruthy();
    expect(match2).toBeTruthy();
    expect(match1![1]).not.toBe(match2![1]);
  });

  it('prerender-paths auth checks token when present', () => {
    const code = compileWorkerEntry();

    // __handleInternal checks __VOID_PROXY_TOKEN for prerender-paths
    expect(code).toContain('/__void/prerender-paths');
    expect(code).toContain('env.__VOID_PROXY_TOKEN');
    expect(code).toContain('request.headers.get("x-void-internal")');
  });

  it('generates websocket durable object exports and proxy routes', () => {
    const scan: ScanResult = {
      routes: [],
      websockets: [
        {
          pattern: '/chat/:room',
          methods: [],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: 'room',
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
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    expect(code).toContain('import websocket0 from "/routes/chat/[room].ws.ts"');
    expect(code).toContain('createWebSocketDurableObject');
    expect(code).toContain('export const ChatRoomWs = __createWebSocketDurableObject');
    expect(code).toContain('const __voidWebSocketRoutes = [{"pattern":"/chat/:room"');
    expect(code).toContain('export async function __voidHandleWebSocket(request, env)');
    expect(code).toContain('app.all("/chat/:room"');
    expect(code).toContain('__forwardWebSocketRequest');
  });

  it('sets X-Void-Original-URL on c.rewrite re-dispatch (without overwriting existing)', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    // The c.rewrite wrapper must set X-Void-Original-URL for symmetry with the
    // platform/edge layer (which sets it on static rewrites), but must not
    // overwrite an existing value so multi-hop rewrites preserve the true
    // original URL.
    expect(code).toContain('if (!rewriteReq.headers.has("X-Void-Original-URL"))');
    expect(code).toContain('rewriteReq.headers.set("X-Void-Original-URL", c.req.url)');
  });

  it('wraps c.redirect so internal redirects merge the incoming query string', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );

    // The __mergeQueryIntoLocation helper must be emitted even without
    // static routing rules, since the c.redirect wrapper now depends on it.
    expect(code).toContain('function __mergeQueryIntoLocation(destination, search)');
    // And the c.redirect wrapper must reference it for string paths that
    // start with "/" (internal), passing through absolute URLs untouched.
    expect(code).toContain('const __origRedirect = c.redirect.bind(c);');
    expect(code).toContain('c.redirect = (location, status)');
    expect(code).toContain('typeof location === "string" && location.startsWith("/")');
    expect(code).toContain('__origRedirect(__mergeQueryIntoLocation(location, search), status)');
  });
});

describe('X-Void-Routing dev trace header', () => {
  const emptyScan: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };

  const redirectRules = [
    {
      source: '/old',
      destination: '/new',
      status: 301,
      origin: 'void.json#routing.redirects',
    },
    {
      source: '/api/*',
      destination: '/backend/:splat',
      status: 200,
      force: true,
      origin: 'void.json#routing.rewrites',
    },
  ];

  function compileWith(options: Partial<typeof testOptions> & { dev?: boolean }) {
    return compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      nodeTarget: true,
      redirectRules,
      ...options,
    });
  }

  it('emits __VOID_DEV_ROUTING=true and preserves origin fields in dev', () => {
    const code = compileWith({ dev: true });
    expect(code).toContain('const __VOID_DEV_ROUTING = true;');
    // Rule table retains origin metadata in dev so the trace can reference it
    expect(code).toContain('"origin":"void.json#routing.redirects"');
    expect(code).toContain('"origin":"void.json#routing.rewrites"');
    // Header-emission branches fire on matches
    expect(code).toContain('"redirect["');
    expect(code).toContain('"rewrite"');
    expect(code).toContain('__voidAnnotateRouting');
    // Pass-through default after next() runs
    expect(code).toContain('c.res.headers.set("X-Void-Routing", "pass-through")');
  });

  it('emits __VOID_DEV_ROUTING=false and strips origin fields in prod', () => {
    const code = compileWith({ dev: false });
    expect(code).toContain('const __VOID_DEV_ROUTING = false;');
    // Prod rule table must not carry the authoring origin metadata
    expect(code).not.toContain('"origin":"void.json#routing.redirects"');
    expect(code).not.toContain('"origin":"void.json#routing.rewrites"');
    // No pass-through header in prod — the middleware just returns next()
    expect(code).not.toContain('"X-Void-Routing", "pass-through"');
  });

  it('annotates c.rewrite() downstream response with middleware trace in dev', () => {
    const code = compileWith({ dev: true });
    // The c.rewrite wrapper branches on __VOID_DEV_ROUTING and appends a
    // "c.rewrite → <path> (middleware)" trace to the returned Response.
    expect(code).toContain('if (!__VOID_DEV_ROUTING) return __rewritePromise;');
    expect(code).toContain('c.rewrite \\u2192 " + path + " (middleware)');
  });

  it('keeps c.rewrite passthrough in prod (no annotator call)', () => {
    const code = compileWith({ dev: false });
    // Guard stays, but the returned promise is not wrapped — the annotator
    // dead-branch is eliminated at the `__VOID_DEV_ROUTING` check.
    expect(code).toContain('if (!__VOID_DEV_ROUTING) return __rewritePromise;');
  });

  it('tags redirect match with status, destination and origin', () => {
    const code = compileWith({ dev: true });
    expect(code).toContain(
      '"redirect[" + matched.rule.source + "] \\u2192 " + dest + " " + matched.rule.status + " (" + (matched.rule.origin || "unknown") + ")"',
    );
  });

  it('distinguishes force-rewrite (rewrite[...]) from fallback (fallback[...]) in trace', () => {
    const code = compileWith({ dev: true });
    expect(code).toContain('matched.rule.force === true ? "rewrite" : "fallback"');
  });
});

describe('compileWorkerEntry', () => {
  it('generates valid worker entry code without queues', () => {
    const code = compileWorkerEntry();

    expect(code).toContain('__withRawEnv');
    expect(code).not.toContain('__setVoidInternalCall');
    expect(code).toContain('import { withRuntimeEnv } from "void/_env"');
    expect(code).toContain('serveWithAssets');
    expect(code).toContain('return withRuntimeEnv(env, async () => {');
    expect(code).toContain('export default { fetch:');
    expect(code).toContain('scheduled: handleScheduled');
    expect(code).not.toContain('queue(');
  });

  it('re-exports websocket classes when present', () => {
    const code = compileWorkerEntry(false, undefined, 'assets', ['ChatRoomWs']);

    expect(code).toContain('__voidHandleWebSocket');
    expect(code).toContain('ChatRoomWs');
    expect(code).toContain('export { ChatRoomWs };');
    expect(code).toContain('const ws = await __voidHandleWebSocket(request, env);');
  });

  it('generates queue() export in worker entry when hasQueues=true', () => {
    const code = compileWorkerEntry(true);

    expect(code).toContain('async function queue(batch, env, ctx)');
    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('serveWithAssets');
    expect(code).toContain('scheduled: handleScheduled, queue }');
    expect(code).toContain('__processQueue');
    expect(code).toContain('batch.queue');
    expect(code).toContain('m.timestamp.toISOString()');
    // Native queue handler calls __processQueue directly (no HTTP round-trip)
    expect(code).toContain('withRuntimeEnv(env, () => __processQueue(payload, userEnv))');
  });

  it('omits queue() export when hasQueues=false', () => {
    const code = compileWorkerEntry(false);

    expect(code).not.toContain('queue');
  });

  it('generates serveWithAssets helper with cache headers', () => {
    const code = compileWorkerEntry();

    expect(code).toContain('async function serveWithAssets(request, env, response)');
    expect(code).toContain('url.pathname !== "/__void/prerender-paths"');
    expect(code).toContain('env.ASSETS');
    expect(code).toContain('"/assets/"');
    // Both cache-control values (hashed + non-hashed)
    expect(code).toContain('public, max-age=31536000, immutable');
    expect(code).toContain('public, s-maxage=60, max-age=0, must-revalidate');
    // No Cache API usage (edge caching happens at dispatch layer)
    expect(code).not.toContain('caches.default');
    expect(code).not.toContain('cache.match');
    expect(code).not.toContain('cache.put');
  });

  it('serveWithAssets skips non-GET/HEAD requests to avoid body-reuse crash', () => {
    const code = compileWorkerEntry();

    // Must guard against POST/PUT/etc — their body is consumed by app.fetch()
    // and passing the original request to env.ASSETS.fetch() would throw
    // "Cannot reconstruct a Request with a used body"
    expect(code).toContain('request.method !== "GET" && request.method !== "HEAD"');
  });

  it('serveWithAssets creates a fresh Request for ASSETS.fetch to avoid body-reuse', () => {
    const code = compileWorkerEntry();

    // Must not pass the original request to env.ASSETS.fetch() because
    // app.fetch() may have marked it as disturbed. Use new Request(url) instead.
    expect(code).toContain(
      'env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: request.headers }))',
    );
    expect(code).not.toMatch(/env\.ASSETS\.fetch\(request\)/);
  });

  it('uses custom assetsDir in serveWithAssets path check', () => {
    const code = compileWorkerEntry(false, undefined, '_astro');

    expect(code).toContain('"/_astro/"');
    expect(code).not.toContain('"/assets/"');
  });

  it('native queue handler calls __processQueue directly without HTTP', () => {
    const code = compileWorkerEntry(true);

    // Native queue handler must call __processQueue directly (no /__void/queue HTTP round-trip)
    // This avoids the global-flag race condition with concurrent fetch events
    expect(code).toContain('__processQueue(payload, userEnv)');
    expect(code).not.toContain('__voidInternalCall');
    expect(code).not.toContain('__setVoidInternalCall');
  });

  it('passes filtered env (userEnv) not raw env to scheduled handler', () => {
    const code = compileWorkerEntry();

    // handleScheduled must filter internal bindings before passing to user code
    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('const userEnv = __filterInternalBindings(env)');
    expect(code).toContain('scheduled(controller, userEnv, ctx)');
    // Must NOT pass raw env to scheduled()
    expect(code).not.toMatch(/scheduled\(controller,\s*env,\s*ctx\)/);
  });

  it('filters internal bindings in native queue handler', () => {
    const code = compileWorkerEntry(true);

    // Queue handler must filter env before passing to __processQueue
    expect(code).toContain('const userEnv = __filterInternalBindings(env)');
    expect(code).toContain('__processQueue(payload, userEnv)');
  });

  it('omits boot-time env validation when no envSchemaModule is provided', () => {
    const code = compileWorkerEntry();
    expect(code).not.toContain('_validateEnvOnce');
  });

  it('splices boot-time env validation when envSchemaModule is provided', () => {
    const code = compileWorkerEntry(true, undefined, 'assets', [], 'void/_env', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    // Side-effect import of user env.ts so the schema is registered
    expect(code).toContain('import "/abs/path/to/env.ts"');
    // Helper import
    expect(code).toContain('import { _validateEnvOnce } from "/resolved/env-public.mjs"');
    // Spliced into fetch, scheduled, AND queue handlers
    const callCount = (code.match(/_validateEnvOnce\(env\)/g) ?? []).length;
    expect(callCount).toBe(3);
  });

  it('wraps remote-mode fetch and scheduled handlers with resolved runtime env', () => {
    const code = compileWorkerEntry(
      false,
      { remotePath: '/resolved/remote.mjs', envPath: '/resolved/env-legacy.mjs' },
      'assets',
      [],
      '/resolved/env.mjs',
    );

    expect(code).toContain('import { withRuntimeEnv } from "/resolved/env.mjs"');
    expect(code).toContain('import { createRemoteEnv } from "/resolved/remote.mjs"');
    expect(code).toContain('if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);');
    expect(code).toContain('return withRuntimeEnv(env, async () => {');
    expect(code).toContain(
      'return withRuntimeEnv(env, () => scheduled(controller, userEnv, ctx));',
    );
  });
});

describe('compileNodeApp', () => {
  it('generates node app with serveStatic and default export', () => {
    const code = compileNodeApp('node', '/resolved/hono/index.mjs');
    expect(code).toContain('import { serveStatic } from "@hono/node-server/serve-static"');
    expect(code).toContain('import { Hono } from "/resolved/hono/index.mjs"');
    expect(code).toContain('export default app');
    expect(code).toContain(
      'import innerApp, { __voidCollectPrerenderPaths } from "virtual:void-routes"',
    );
    expect(code).toContain('app.post("/__void/prerender-paths"');
  });

  it('generates bun app with hono/bun serveStatic', () => {
    const code = compileNodeApp('bun', '/resolved/hono/index.mjs');
    expect(code).toContain('import { serveStatic } from "hono/bun"');
    expect(code).toContain('export default app');
    expect(code).not.toContain('@hono/node-server');
  });

  it('generates deno app with hono/deno serveStatic', () => {
    const code = compileNodeApp('deno', '/resolved/hono/index.mjs');
    expect(code).toContain('import { serveStatic } from "hono/deno"');
    expect(code).toContain('export default app');
    expect(code).not.toContain('@hono/node-server');
  });

  it('omits boot-time env validation when no envSchemaModule is provided', () => {
    const code = compileNodeApp('node', '/resolved/hono/index.mjs');
    expect(code).not.toContain('_validateEnvOnce');
  });

  it('splices boot-time env validation when envSchemaModule is provided (node)', () => {
    const code = compileNodeApp('node', '/resolved/hono/index.mjs', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    // Side-effect import of user env.ts so the schema is registered
    expect(code).toContain('import "/abs/path/to/env.ts"');
    // Helper import
    expect(code).toContain('import { _validateEnvOnce } from "/resolved/env-public.mjs"');
    // Middleware runs validation on every request before route handlers,
    // including the /__void/prerender-paths endpoint used by the prerender
    // child process. Node/Bun read env from process.env.
    expect(code).toContain('app.use("*", async (c, next)');
    expect(code).toContain('await _validateEnvOnce(process.env)');
  });

  it('uses Deno.env.toObject() as the env source on the deno target', () => {
    const code = compileNodeApp('deno', '/resolved/hono/index.mjs', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    expect(code).toContain('await _validateEnvOnce(Deno.env.toObject())');
    expect(code).not.toContain('process.env');
  });

  it('splices boot-time env validation on the bun target', () => {
    const code = compileNodeApp('bun', '/resolved/hono/index.mjs', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    expect(code).toContain('await _validateEnvOnce(process.env)');
  });
});

describe('compileNodeServer', () => {
  it('generates node server with @hono/node-server', () => {
    const code = compileNodeServer('node');
    expect(code).toContain('import { serve } from "@hono/node-server"');
    expect(code).toContain('import app from "./app.js"');
    expect(code).toContain('app.fetch');
    expect(code).toContain('process.env.PORT');
  });

  it('generates bun server with Bun.serve', () => {
    const code = compileNodeServer('bun');
    expect(code).toContain('Bun.serve');
    expect(code).toContain('import app from "./app.js"');
    expect(code).not.toContain('@hono/node-server');
  });

  it('generates deno server with Deno.serve', () => {
    const code = compileNodeServer('deno');
    expect(code).toContain('Deno.serve');
    expect(code).toContain('import app from "./app.js"');
    expect(code).not.toContain('@hono/node-server');
  });
});
