import { Hono } from 'hono';
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

  it('strips client-supplied X-Void-Original-URL at entry and before rewrite re-dispatch', () => {
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

    // Entry-point strip: any request that is not an internal re-dispatch has
    // its X-Void-Original-URL header removed before user code runs.
    expect(code).toContain('if (!__rewrittenReqs.has(c.req.raw)) {');
    expect(code).toContain('c.req.raw.headers.delete("X-Void-Original-URL")');

    // Defense-in-depth: c.rewrite snapshots whether the current hop is an
    // internal re-dispatch, and drops any X-Void-Original-URL on the cloned
    // rewriteReq when it is not — so an immutable-headers runtime (where the
    // entry-point delete silently failed) still can't propagate a spoof.
    expect(code).toContain('const __isInternalRedispatch = __rewrittenReqs.has(c.req.raw);');
    expect(code).toContain('if (!__isInternalRedispatch) {');
    expect(code).toContain('rewriteReq.headers.delete("X-Void-Original-URL")');
  });

  it('attaches c.originalUrl and c.isRewritten as per-request helpers', () => {
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

    // Per-instance assignment in the same middleware that attaches c.rewrite,
    // so vanilla Hono Contexts (which never flow through this middleware) do
    // not pick up the helpers at runtime — matching the env-scoped types.
    expect(code).toContain('c.originalUrl = () => c.req.header("X-Void-Original-URL") ?? null;');
    expect(code).toContain('c.isRewritten = () => c.req.header("X-Void-Original-URL") != null;');
    // Regression anchor for the fix that aligned c.isRewritten with the
    // dispatch-worker contract: dispatch only sets X-Void-Original-URL, never
    // X-Void-Rewritten, so reading the latter would falsely report false on
    // every default-target static rewrite in production. Ensure the old header name is gone from
    // the generated code entirely.
    expect(code).not.toContain('X-Void-Rewritten');
  });

  it('c.rewrite splits path at "?" so queries do not get percent-encoded, and guards external destinations and missing executionCtx', () => {
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

    // Guard: external / non-path-absolute destinations must fail loudly.
    expect(code).toContain('c.rewrite destination must be path-absolute');
    // Split on first `?` to avoid `URL.pathname`'s percent-encoding of `?`.
    expect(code).toContain('const __qIdx = path.indexOf("?");');
    expect(code).toContain('rewriteUrl.pathname = __pathOnly;');
    expect(code).toContain('rewriteUrl.search = __searchOnly;');
    // `c.executionCtx` getter throws on node/bun/deno — guarded with try/catch.
    expect(code).toContain('try { __execCtx = c.executionCtx; } catch {}');
    expect(code).toContain('app.fetch(rewriteReq, c.env, __execCtx)');
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

/**
 * Runtime behaviour tests for the c.redirect / c.rewrite wrappers. The
 * compile.ts tests above assert the emitted source string; these drive the
 * equivalent wrappers through a real Hono app so the actual behaviour
 * (query merge, re-dispatch, helper plumbing) is covered end-to-end.
 *
 * The wrapper logic is replicated here verbatim from compile.ts to keep the
 * test independent of the eval-and-import dance a real integration test
 * would require. If compile.ts drifts, the text-level tests above will
 * fail first and point at this file.
 */
function mergeQueryIntoLocation(destination: string, search: string): string {
  if (!search || search === '?') {
    return destination;
  }
  const q = destination.indexOf('?');
  if (q === -1) {
    return destination + search;
  }
  const dp = new URLSearchParams(destination.slice(q + 1));
  for (const [k, v] of new URLSearchParams(search)) {
    if (!dp.has(k)) {
      dp.append(k, v);
    }
  }
  return destination.slice(0, q) + '?' + dp.toString();
}

function installVoidWrappers(app: Hono, rewrittenReqs: WeakSet<Request>): void {
  app.use(async (c, next) => {
    if (!rewrittenReqs.has(c.req.raw)) {
      try {
        c.req.raw.headers.delete('X-Void-Original-URL');
      } catch {
        /* ignore immutable-headers runtimes */
      }
    }
    const isInternalRedispatch = rewrittenReqs.has(c.req.raw);
    (c as any).rewrite = (path: string) => {
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error('c.rewrite destination must be path-absolute (start with "/")');
      }
      // Split on the first `?` so queries aren't URL-encoded by the
      // `URL.pathname` setter (which would produce `%3F`). Mirrors the
      // codegen in compile.ts.
      const qIdx = path.indexOf('?');
      const pathOnly = qIdx === -1 ? path : path.slice(0, qIdx);
      const searchOnly = qIdx === -1 ? '' : path.slice(qIdx);
      const rewriteUrl = new URL(c.req.url);
      rewriteUrl.pathname = pathOnly;
      rewriteUrl.search = searchOnly;
      const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);
      if (!isInternalRedispatch) {
        rewriteReq.headers.delete('X-Void-Original-URL');
      }
      if (!rewriteReq.headers.has('X-Void-Original-URL')) {
        rewriteReq.headers.set('X-Void-Original-URL', c.req.url);
      }
      rewrittenReqs.add(rewriteReq);
      // `c.executionCtx` throws in bare test envs; compile.ts forwards it
      // unconditionally because Workers/Node targets always provide one.
      let ctx: ExecutionContext | undefined;
      try {
        ctx = (c as any).executionCtx;
      } catch {
        ctx = undefined;
      }
      return app.fetch(rewriteReq, (c as any).env, ctx);
    };
    const origRedirect = c.redirect.bind(c);
    (c as any).redirect = (location: string, status?: number) => {
      if (typeof location === 'string' && location.startsWith('/')) {
        const search = new URL(c.req.raw.url).search;
        return origRedirect(mergeQueryIntoLocation(location, search), status as any);
      }
      return origRedirect(location, status as any);
    };
    (c as any).originalUrl = () => c.req.header('X-Void-Original-URL') ?? null;
    (c as any).isRewritten = () => c.req.header('X-Void-Original-URL') != null;
    await next();
  });
}

describe('c.redirect runtime wrapper', () => {
  it('preserves the original request query on internal redirects', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());
    app.get('/old', (c) => c.redirect('/new', 302));

    const res = await app.fetch(new Request('http://localhost/old?x=1&y=2'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/new?x=1&y=2');
  });

  it("destination's explicit query wins over the incoming request query", async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());
    app.get('/old', (c) => c.redirect('/new?foo=1', 302));

    const res = await app.fetch(new Request('http://localhost/old?foo=override&bar=2'));

    expect(res.status).toBe(302);
    // `foo=1` from destination must NOT be replaced by `foo=override`;
    // `bar=2` from the request is merged since destination doesn't carry it.
    expect(res.headers.get('Location')).toBe('/new?foo=1&bar=2');
  });
});

/**
 * Mirror of `compileRoutingRulesMiddleware` in compile.ts: evaluate static
 * rewrite/redirect rules pre-asset, but short-circuit when the request is an
 * internal re-dispatch (tracked via `__rewrittenReqs`). The guard is what
 * prevents single-hop rewrite loops — even if the destination itself matches a
 * rewrite rule, the rule table is skipped on the replayed request.
 *
 * Kept in sync with compile.ts by shape; the text-level tests in
 * `describe('compileRouteTable')` above anchor the emitted source string.
 */
function installRoutingRulesMiddleware(
  app: Hono,
  rewrittenReqs: WeakSet<Request>,
  rules: Array<{ source: string; destination: string; status: number; force?: boolean }>,
): void {
  app.use('*', async (c, next) => {
    if (rewrittenReqs.has(c.req.raw)) {
      return next();
    }
    const pathname = new URL(c.req.url).pathname;
    let matched: (typeof rules)[number] | undefined;
    for (const rule of rules) {
      // Simple equality + `/*` prefix match is enough for these tests — the
      // real implementation uses `__compilePattern` from compile.ts.
      if (rule.source === pathname) {
        matched = rule;
      } else if (rule.source.endsWith('/*') && pathname.startsWith(rule.source.slice(0, -2))) {
        matched = rule;
      }
    }
    if (!matched) {
      return next();
    }
    if (matched.status === 200) {
      const rewriteUrl = new URL(c.req.url);
      rewriteUrl.pathname = matched.destination;
      const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);
      if (!rewriteReq.headers.has('X-Void-Original-URL')) {
        rewriteReq.headers.set('X-Void-Original-URL', c.req.url);
      }
      rewrittenReqs.add(rewriteReq);
      let ctx: ExecutionContext | undefined;
      try {
        ctx = (c as any).executionCtx;
      } catch {
        ctx = undefined;
      }
      return app.fetch(rewriteReq, (c as any).env, ctx);
    }
    return c.redirect(matched.destination, matched.status as any);
  });
}

describe('c.rewrite runtime wrapper', () => {
  it('re-dispatches to the rewritten path and exposes c.originalUrl / c.isRewritten', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());

    app.get('/external', (c) => (c as any).rewrite('/internal'));
    app.get('/internal', (c) => {
      return new Response('internal-body', {
        headers: {
          'X-Handler': 'internal',
          'X-Original-Url': (c as any).originalUrl() ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    const res = await app.fetch(new Request('http://localhost/external?keep=1'));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('internal-body');
    // Response came from the /internal handler, proving re-dispatch happened.
    expect(res.headers.get('X-Handler')).toBe('internal');
    // `c.originalUrl()` on the re-dispatched context returns the pre-rewrite URL.
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/external?keep=1');
    // `c.isRewritten()` is true on the replayed hop.
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('c.isRewritten() is true when dispatch sets X-Void-Original-URL (platform edge rewrite)', async () => {
    // Regression anchor: in production on the default target, Void's dispatch worker applies static
    // routing.rewrites / fallbacks by mutating the pathname and setting only
    // X-Void-Original-URL on the forwarded request — it does NOT set any
    // rewritten-specific flag header. c.isRewritten() must read presence of
    // X-Void-Original-URL so it returns true in this scenario too, matching
    // docs/guide/edge/rewrites.md and docs/reference/api.md.
    //
    // On the default target, incoming `c.req.raw.headers` are immutable, so the entry-point
    // anti-spoof strip (`headers.delete("X-Void-Original-URL")`) throws and
    // is silently swallowed by the try/catch in compile.ts — which is what
    // lets dispatch-provided headers reach the handler. We simulate that by
    // making the incoming request's `headers.delete` throw.
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());

    app.get('/en/docs', (c) => {
      return new Response('docs-body', {
        headers: {
          'X-Original-Url': (c as any).originalUrl() ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    // Simulate a dispatch-forwarded request: the pathname has already been
    // rewritten and X-Void-Original-URL is set. No X-Void-Rewritten header,
    // no entry in rewrittenReqs (dispatch is out-of-process from the worker).
    const dispatchForwarded = new Request('http://localhost/en/docs', {
      headers: { 'X-Void-Original-URL': 'http://localhost/docs' },
    });
    // Make incoming headers behave as immutable (matches the default target's
    // production semantics for incoming Requests).
    const originalDelete = dispatchForwarded.headers.delete.bind(dispatchForwarded.headers);
    dispatchForwarded.headers.delete = (name: string) => {
      if (name.toLowerCase() === 'x-void-original-url') {
        throw new TypeError('immutable headers');
      }
      return originalDelete(name);
    };

    const res = await app.fetch(dispatchForwarded);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('docs-body');
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/docs');
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('single-hop loop guard: re-dispatched request skips the static rule table', async () => {
    // Regression anchor for the `__rewrittenReqs` WeakSet guard in compile.ts.
    // A middleware calls `c.rewrite('/a')`, and `/a` itself is also a rewrite
    // source that (without the guard) would re-fire endlessly. Counter
    // tracks how many times the routing rule table *matches* a request so the
    // test fails loudly if the guard regresses.
    const app = new Hono();
    const rewrittenReqs = new WeakSet<Request>();
    let ruleMatches = 0;

    installVoidWrappers(app, rewrittenReqs);
    app.use('*', async (c, next) => {
      if (rewrittenReqs.has(c.req.raw)) {
        return next();
      }
      const pathname = new URL(c.req.url).pathname;
      // Static force rewrite: /a → /elsewhere. If the guard were removed, this
      // would match again on the re-dispatched /a request and loop.
      if (pathname === '/a') {
        ruleMatches++;
        const rewriteUrl = new URL(c.req.url);
        rewriteUrl.pathname = '/a';
        const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);
        if (!rewriteReq.headers.has('X-Void-Original-URL')) {
          rewriteReq.headers.set('X-Void-Original-URL', c.req.url);
        }
        rewrittenReqs.add(rewriteReq);
        return app.fetch(rewriteReq, (c as any).env, undefined);
      }
      return next();
    });

    app.get('/a', (c) => {
      return new Response('handler-a', {
        headers: { 'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0' },
      });
    });

    const res = await app.fetch(new Request('http://localhost/a'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('handler-a');
    // Exactly one match: the original request. The re-dispatched request
    // carries the internal flag and is skipped by the rule table.
    expect(ruleMatches).toBe(1);
    // The handler ran under the re-dispatched context, so `c.isRewritten()` is true.
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('rewrite vs fallback interaction: force-rewrite (always) wins over fallback (post-asset)', async () => {
    // When the same source matches both a rewrite (force=true, pre-asset) and
    // a fallback (force=false, post-asset), the rewrite bucket fires first and
    // the fallback never reaches the request. This is enforced by splitting
    // rules into separate buckets via `splitRedirectRulesByForce` — the
    // pre-asset bucket resolves the request before the post-asset one runs.
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers');
    const allRules = [
      {
        source: '/docs/*',
        destination: '/fallback.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
      {
        source: '/docs/*',
        destination: '/rewrite-target',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ];
    const { always: preAsset, fallbacks: postAsset } = splitRedirectRulesByForce(allRules);

    // Buckets are disjoint — the rewrite lands in pre-asset, the fallback in post-asset.
    expect(preAsset).toHaveLength(1);
    expect(preAsset[0].destination).toBe('/rewrite-target');
    expect(postAsset).toHaveLength(1);
    expect(postAsset[0].destination).toBe('/fallback.html');

    // Drive the pre-asset bucket through the routing-rules middleware: the
    // rewrite fires and the request resolves to /rewrite-target. The fallback
    // bucket is never consulted because the request was resolved before the
    // asset-miss phase would run.
    const app = new Hono();
    const rewrittenReqs = new WeakSet<Request>();
    installVoidWrappers(app, rewrittenReqs);
    installRoutingRulesMiddleware(app, rewrittenReqs, preAsset);

    let fallbackFired = false;
    // Emulate the post-asset fallback check that would normally run on 404.
    // If the pre-asset rewrite succeeds, this branch must never execute.
    app.notFound((_c) => {
      for (const rule of postAsset) {
        if (
          rule.source === '/docs/*' ||
          (rule.source.endsWith('/*') && '/docs/intro'.startsWith(rule.source.slice(0, -2)))
        ) {
          fallbackFired = true;
        }
      }
      return new Response('fallback-hit', { status: 200 });
    });

    app.get('/rewrite-target', (c) => c.text('rewrite-target', 200));

    const res = await app.fetch(new Request('http://localhost/docs/intro'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('rewrite-target');
    expect(fallbackFired).toBe(false);
  });

  it('middleware runs twice on c.rewrite, with c.isRewritten() flipping false → true', async () => {
    // Every rewrite hop replays the full middleware stack. A counter-style
    // middleware therefore fires twice (once for the original request, once
    // for the re-dispatched one), and `c.isRewritten()` lets users skip
    // side-effectful work on the replay.
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());

    let invocations = 0;
    const observed: boolean[] = [];
    app.use('*', async (c, next) => {
      invocations++;
      observed.push((c as any).isRewritten());
      await next();
    });

    app.get('/from', (c) => (c as any).rewrite('/to'));
    app.get('/to', (c) => c.text('to-handler', 200));

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('to-handler');

    // Counter middleware fired once per dispatch — twice total.
    expect(invocations).toBe(2);
    // First invocation is the original request (not rewritten), second is the replay.
    expect(observed).toEqual([false, true]);
  });

  it('middleware runs twice when a post-asset fallback rewrite re-dispatches', async () => {
    // Same replay semantics as a force-phase rewrite, but driven by a
    // fallback-phase rule (status=200, force=false) that fires from
    // `app.notFound` — mirroring how compile.ts wires `fallbackRules` into
    // the notFound hook after the asset lookup misses. The middleware must
    // still run twice (once per dispatch) and both URLs — the original and
    // the rewritten — must be observable from the appropriate context APIs.
    const app = new Hono();
    const rewrittenReqs = new WeakSet<Request>();
    installVoidWrappers(app, rewrittenReqs);

    let invocations = 0;
    const observedReqUrls: string[] = [];
    const observedOriginalUrls: Array<string | null> = [];
    app.use('*', async (c, next) => {
      invocations++;
      observedReqUrls.push(c.req.url);
      observedOriginalUrls.push((c as any).originalUrl());
      await next();
    });

    // Fallback rule: /missing/* rewrites to /spa-shell on asset-miss.
    const fallbackRules = [{ source: '/missing/*', destination: '/spa-shell', status: 200 }];
    app.notFound((c) => {
      if (rewrittenReqs.has(c.req.raw)) {
        return c.text('not-found', 404);
      }
      const pathname = new URL(c.req.url).pathname;
      for (const rule of fallbackRules) {
        if (rule.source.endsWith('/*') && pathname.startsWith(rule.source.slice(0, -2))) {
          return (c as any).rewrite(rule.destination);
        }
      }
      return c.text('not-found', 404);
    });

    app.get('/spa-shell', (c) => c.text('shell-body', 200));

    const res = await app.fetch(new Request('http://localhost/missing/deep'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('shell-body');

    // Middleware fired once per dispatch — twice total.
    expect(invocations).toBe(2);
    // First hop: original request URL, no X-Void-Original-URL yet.
    expect(observedReqUrls[0]).toBe('http://localhost/missing/deep');
    expect(observedOriginalUrls[0]).toBeNull();
    // Second hop: rewritten URL on c.req.url, and c.originalUrl() surfaces
    // the pre-rewrite URL — both observable from the replayed context.
    expect(observedReqUrls[1]).toBe('http://localhost/spa-shell');
    expect(observedOriginalUrls[1]).toBe('http://localhost/missing/deep');
  });

  it('c.rewrite preserves a "?query" in the destination path (does not URL-encode "?")', async () => {
    // Regression anchor: setting `URL.pathname = "/page?x=1"` percent-encodes
    // the `?` into `%3F`, so the re-dispatched request lands at `/page%3Fx=1`
    // and the query is lost. The wrapper must split on the first `?` and set
    // `pathname` + `search` separately.
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());

    app.get('/from', (c) => (c as any).rewrite('/page?x=1'));
    app.get('/page', (c) => {
      return new Response('ok', {
        headers: {
          'X-Req-Path': new URL(c.req.url).pathname,
          'X-Req-Search': new URL(c.req.url).search,
        },
      });
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Req-Path')).toBe('/page');
    expect(res.headers.get('X-Req-Search')).toBe('?x=1');
  });

  it('c.rewrite rejects external / protocol-absolute destinations', async () => {
    // `c.rewrite` is strictly in-worker re-dispatch. An absolute URL would
    // silently turn into a proxy — fail at the call site so users reach for
    // `fetch()` instead.
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite('https://upstream.example/path');
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain('must be path-absolute');
  });

  it('c.rewrite works on a node-target context without c.executionCtx', async () => {
    // Hono's `c.executionCtx` getter throws on Node/Bun/Deno. The codegen
    // must swallow the throw so `c.rewrite` still re-dispatches correctly.
    // The test wrapper replays the same try/catch; this test drives the path
    // end-to-end by making `executionCtx` throw on access.
    const app = new Hono();
    installVoidWrappers(app, new WeakSet<Request>());

    app.use('*', async (c, next) => {
      Object.defineProperty(c, 'executionCtx', {
        get() {
          throw new Error('ExecutionContext not available on node targets');
        },
        configurable: true,
      });
      await next();
    });

    app.get('/from', (c) => (c as any).rewrite('/to'));
    app.get('/to', (c) => c.text('to-handler', 200));

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('to-handler');
  });

  it('c.rewrite is not installed on a vanilla Hono app — calling it throws at runtime', async () => {
    // Locks in the documented trade-off from feat/rewrites revert 7c9d2d6:
    // `c.rewrite` is attached per-Context by the generated router middleware,
    // so a vanilla `new Hono()` Context (no `installVoidWrappers`) never picks
    // it up. Calling it surfaces the usual TypeError — the same behaviour
    // users hit if they mount a third-party Hono sub-app that widens the env
    // and then dispatches through it.
    const app = new Hono();
    let caught: unknown;
    app.get('/unmanaged', (c) => {
      try {
        (c as any).rewrite('/elsewhere');
      } catch (err) {
        caught = err;
      }
      return c.text('unmanaged', 200);
    });

    const res = await app.fetch(new Request('http://localhost/unmanaged'));
    expect(res.status).toBe(200);
    expect(caught).toBeInstanceOf(TypeError);
    expect(String(caught)).toContain('is not a function');
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

  it('guards the pass-through header set with try/catch for runtimes with immutable Response headers', () => {
    const code = compileWith({ dev: true });
    // Some runtimes produce Responses whose Headers are guarded/immutable —
    // the dev middleware must silently swallow the resulting TypeError instead
    // of crashing, matching the existing pattern elsewhere in the file.
    expect(code).toContain('try { c.res.headers.set("X-Void-Routing", "pass-through"); } catch {}');
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

  it('emits a standalone notFound fallback hook on node targets when only fallbackRules are set', () => {
    const fallbackRules = [
      {
        source: '/docs/*',
        destination: '/docs.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      nodeTarget: true,
      dev: true,
      fallbackRules,
    });
    // The fallback rule table is hoisted to module scope and referenced by the
    // notFound body — not conflated with the pre-asset `__routingRules` table.
    expect(code).toContain('const __fallbackRules =');
    expect(code).toContain('"origin":"void.json#routing.fallbacks"');
    expect(code).toContain('app.notFound(async (c) => {');
    // Guard against re-dispatched loops (same invariant as the pre-asset phase).
    expect(code).toContain('if (!__rewrittenReqs.has(c.req.raw))');
  });

  it('strips fallback origin metadata in production builds', () => {
    const fallbackRules = [
      {
        source: '/docs/*',
        destination: '/docs.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      nodeTarget: true,
      dev: false,
      fallbackRules,
    });
    expect(code).toContain('const __fallbackRules =');
    expect(code).not.toContain('"origin":"void.json#routing.fallbacks"');
  });

  it('skips notFound fallback emission when fallbackRules is empty or undefined', () => {
    const codeEmpty = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        nodeTarget: true,
        fallbackRules: [],
      },
    );
    expect(codeEmpty).not.toContain('__fallbackRules');

    const codeUndef = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        nodeTarget: true,
      },
    );
    expect(codeUndef).not.toContain('__fallbackRules');
  });
});

describe('default-target dev parity', () => {
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
  ];
  const headerRules = [{ pattern: '/*', headers: [['x-test', '1']] as [string, string][] }];
  const fallbackRules = [
    {
      source: '/docs/*',
      destination: '/docs.html',
      status: 200,
      force: false,
      origin: 'void.json#routing.fallbacks',
    },
  ];

  function compile(opts: Partial<typeof testOptions> & { dev?: boolean; nodeTarget?: boolean }) {
    return compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      redirectRules,
      headerRules,
      fallbackRules,
      ...opts,
    });
  }

  it('emits redirect + header middleware on the default target in dev', () => {
    const code = compile({ nodeTarget: false, dev: true });
    expect(code).toContain('const __routingRules =');
    expect(code).toContain('const __headerRules =');
    // Fallback rules are emitted inside the assets-then-fallback notFound body
    expect(code).toContain('const __fallbackRules =');
  });

  it('omits redirect + header + fallback middleware on the default target in prod', () => {
    const code = compile({ nodeTarget: false, dev: false });
    // Production bundles let the platform dispatch worker own the pipeline
    expect(code).not.toContain('const __routingRules =');
    expect(code).not.toContain('const __headerRules =');
    expect(code).not.toContain('const __fallbackRules =');
  });

  it('emits assets-first-then-fallback notFound hook on default target in dev', () => {
    const code = compile({ nodeTarget: false, dev: true });
    // Standalone (non-SSR) notFound on default target dev looks up assets
    // before applying fallback rules.
    expect(code).toContain('const assets = c.env?.ASSETS;');
    expect(code).toContain('await assets.fetch(c.req.raw)');
    expect(code).toContain('if (__assetRes.status !== 404) return __assetRes;');
    expect(code).toContain('const __fallbackRules =');
  });

  it('keeps pre-asset fallback order on node target (no assets-first wrapping)', () => {
    const code = compile({ nodeTarget: true, dev: true });
    // Node target hosts both routing and assets inside the Hono app, so the
    // notFound hook runs fallbacks first without a platform asset lookup.
    expect(code).not.toContain('assets.fetch(c.req.raw)');
    expect(code).toContain('const __fallbackRules =');
  });

  it('wraps SSR notFound with assets-first-then-fallback on default target dev', () => {
    const ssrOptions = {
      serverEntryPath: '/project/src/main.ssr.ts',
      clientEntryRelativePath: 'src/main.client.ts',
    };
    const code = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      ssrOptions,
      {
        ...testOptions,
        nodeTarget: false,
        dev: true,
        fallbackRules,
      },
    );
    // SSR notFound falls through to the platform asset binding, then applies
    // fallback rules on asset-miss before giving up with 404.
    expect(code).toContain('if (!shouldHandleSsrRequest(c)) {');
    expect(code).toContain('const __assetRes = await fetchFromAssets(c);');
    expect(code).toContain('if (__assetRes.status !== 404) return __assetRes;');
  });

  it('leaves SSR notFound unchanged on node target (plain fetchFromAssets return)', () => {
    const ssrOptions = {
      serverEntryPath: '/project/src/main.ssr.ts',
      clientEntryRelativePath: 'src/main.client.ts',
    };
    const code = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      ssrOptions,
      {
        ...testOptions,
        nodeTarget: true,
        dev: true,
        fallbackRules,
      },
    );
    // On node targets the SSR notFound keeps its direct `return fetchFromAssets(c)`
    // body — fallback rules already ran before this branch.
    expect(code).toContain('return fetchFromAssets(c);');
    expect(code).not.toContain('const __assetRes = await fetchFromAssets(c);');
  });

  it('keeps node target emissions identical in dev and prod', () => {
    const devCode = compile({ nodeTarget: true, dev: true });
    const prodCode = compile({ nodeTarget: true, dev: false });
    expect(devCode).toContain('const __routingRules =');
    expect(prodCode).toContain('const __routingRules =');
    expect(devCode).toContain('const __headerRules =');
    expect(prodCode).toContain('const __headerRules =');
    expect(devCode).toContain('const __fallbackRules =');
    expect(prodCode).toContain('const __fallbackRules =');
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
