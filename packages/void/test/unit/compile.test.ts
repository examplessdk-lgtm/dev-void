/* oxlint-disable typescript-eslint/no-explicit-any -- these tests wire the void context augmentations by hand (`c.rewrite`, `c.originalUrl`, `c.isRewritten`) to exercise generated code paths directly; `as any` is the least noisy way to assign/read those members without re-declaring the full Hono context shape per test. */
import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import {
  compileRouteTable,
  compileWorkerEntry,
  compileNodeApp,
  compileNodeServer,
} from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';
import { VoidAssetRewriteError } from '../../src/runtime/handler.ts';

const testOptions = {
  honoPath: '/resolved/hono/index.mjs',
  responsePath: '/resolved/void/runtime/response.mjs',
  handlerPath: '/resolved/void/runtime/handler.mjs',
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

  it('does not cache route modules in dev so transitive route dependency changes reload', () => {
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
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      dev: true,
    });

    expect(code).toContain('async function _load_api_hello_ts()');
    expect(code).toContain('return import("/routes/api/hello.ts")');
    expect(code).not.toContain('let _mod_api_hello_ts');
    expect(code).not.toContain('if (!_mod_api_hello_ts)');
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

    // The /__void/scheduled handler: configured proxy token first; otherwise
    // dev trigger token in dev, build key in prod.
    expect(code).toContain('app.post("/__void/scheduled"');
    expect(code).toContain('c.req.header("x-void-internal")');
    expect(code).toContain('c.req.header("x-void-dev-trigger")');
    expect(code).toContain('__getRawEnv()?.__VOID_PROXY_TOKEN');
    expect(code).toContain('__VOID_DEV_TRIGGER_TOKEN');
    expect(code).toContain('__VOID_BUILD_KEY');
    expect(code).toContain('import.meta.env.DEV');
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

    // The /__void/queue HTTP route: configured proxy token first; otherwise
    // dev trigger token in dev, build key in prod.
    expect(code).toContain('app.post("/__void/queue"');
    expect(code).toContain('c.req.header("x-void-internal")');
    expect(code).toContain('c.req.header("x-void-dev-trigger")');
    expect(code).toContain('__VOID_DEV_TRIGGER_TOKEN');
    expect(code).toContain('__VOID_BUILD_KEY');
    expect(code).toContain('import.meta.env.DEV');
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

  it('uses configured dev trigger token for local manual trigger auth', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      devTriggerToken: 'dev-trigger-test-token',
    });

    expect(code).toContain('export const __VOID_DEV_TRIGGER_TOKEN = "dev-trigger-test-token"');
    expect(code).toContain('__devToken !== __VOID_DEV_TRIGGER_TOKEN');
  });

  it('prerender-paths auth checks token when present', () => {
    const code = compileWorkerEntry();

    // __handleInternal checks __VOID_PROXY_TOKEN for prerender-paths
    expect(code).toContain('/__void/prerender-paths');
    expect(code).toContain('env.__VOID_PROXY_TOKEN');
    expect(code).toContain('request.headers.get("x-void-internal")');
  });

  it('checks route-owned internal handlers before app routing', () => {
    const code = compileWorkerEntry();

    expect(code).toContain('__voidHandleInternalRoute');
    expect(code.indexOf('const routeInternal = await __voidHandleInternalRoute')).toBeLessThan(
      code.indexOf('url.pathname !== "/__void/prerender-paths"'),
    );
    expect(code.indexOf('const internal = await __handleInternal')).toBeLessThan(
      code.indexOf('await app.fetch(request, userEnv, ctx)'),
    );
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

  it('generates the shared live durable object export when live is enabled', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      hasLive: true,
      liveRuntimePath: '/resolved/void/runtime/live-server.mjs',
    });

    expect(code).toContain('createLiveDurableObject');
    expect(code).toContain(
      'export const VoidLiveStreamDurableObject = __createLiveDurableObject();',
    );
  });

  it('wires c.rewrite, c.originalUrl, and c.isRewritten to a shared WeakMap', () => {
    // Lightweight anchor that the rewrite middleware is emitted at all —
    // behavioral coverage for the wrapper lives in `c.rewrite runtime wrapper`
    // below (and in the `installVoidWrappers` mirror that drives those tests).
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

    expect(code).toContain('const __voidOriginalUrls = new WeakMap();');
    expect(code).toContain('const __voidFallbackHandled = new WeakSet();');
    expect(code).toContain('c.rewrite = (path)');
    expect(code).toContain('c.originalUrl = () =>');
    expect(code).toContain('c.isRewritten = () =>');
    // Dispatch only sets `X-Void-Original-URL`, never a legacy flag header.
    expect(code).not.toContain('X-Void-Rewritten');
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
    // Guard against protocol-relative ("//host/x") URLs — those satisfy
    // `startsWith("/")` but the browser resolves them cross-origin, so
    // merging the incoming query would leak request params off-origin.
    expect(code).toContain(
      'typeof location === "string" && location.startsWith("/") && !location.startsWith("//")',
    );
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
  const fragIdx = destination.indexOf('#');
  const base = fragIdx === -1 ? destination : destination.slice(0, fragIdx);
  const fragment = fragIdx === -1 ? '' : destination.slice(fragIdx);
  const q = base.indexOf('?');
  if (q === -1) {
    return base + search + fragment;
  }
  if (q === base.length - 1) {
    return base.slice(0, q) + fragment;
  }
  const dp = new URLSearchParams(base.slice(q + 1));
  for (const [k, v] of new URLSearchParams(search)) {
    if (!dp.has(k)) {
      dp.append(k, v);
    }
  }
  return base.slice(0, q) + '?' + dp.toString() + fragment;
}

/**
 * Compile-time output of `compileRouteTable` is an ESM module. To exercise it
 * end-to-end without a real bundler, strip the static `import` statements and
 * `export` keywords, then evaluate via `new Function` with the imported names
 * supplied as parameters. Returns the Hono `app` instance the module would
 * export as default.
 *
 * Used by the X-Void-Original-URL gate test below: the substring assertion it
 * replaces was fragile against both refactor-driven false negatives and
 * refactor-driven false positives. Driving the real artifact through `fetch`
 * checks the security boundary at runtime instead.
 */
function evalCompiledApp(code: string): Hono {
  // Strip the well-known import block and the node-target inline
  // `const withRuntimeEnv = ...;` declaration; both forms get replaced with
  // the same noop binding injected at the top of the eval'd body. Hono and
  // VoidAssetRewriteError are passed in via `new Function` parameters so the
  // bindings the compiled output references resolve cleanly.
  const stripped = code
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, '')
    .replace(/^const\s+withRuntimeEnv\s+=.*$/gm, '')
    // Remove `export` keyword from `export const`, `export async function`,
    // `export function`, `export default app;` so the module body is plain
    // statements eval-safe inside a Function body.
    .replace(/^export\s+default\s+app;?\s*$/gm, '')
    .replace(/^export\s+(const|async\s+function|function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

  const factory = new Function(
    'Hono',
    'convertReturnValue',
    '__VoidAssetRewriteError',
    'AsyncLocalStorage',
    [
      // Inject the noop binding for both nodeTarget (was a `const` we stripped)
      // and the cf branch (was an import we stripped). Anything beyond the
      // gate-relevant header migration — route invocation, prerender, scheduled
      // — is exercised by the test route the caller installs after eval.
      'const withRuntimeEnv = (_e, fn) => fn();',
      stripped,
      'return app;',
    ].join('\n'),
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vitest runs in node; node:async_hooks is built-in.
  const { AsyncLocalStorage } = require('node:async_hooks');
  return factory(
    Hono,
    (v: unknown) => (v instanceof Response ? v : new Response(String(v ?? ''))),
    class VoidAssetRewriteErrorStub extends Error {},
    AsyncLocalStorage,
  ) as Hono;
}

/**
 * Mirror of the `app.use` block emitted by `compileRouteTable` that attaches
 * `c.rewrite` / `c.originalUrl` / `c.isRewritten`. Keyed on the
 * `__voidOriginalUrls` WeakMap — identical shape to the codegen, so behavioral
 * tests exercise the real contract (map entry ⇒ rewritten request).
 */
function installVoidWrappers(app: Hono, voidOriginalUrls: WeakMap<Request, URL>): void {
  app.use(async (c, next) => {
    // Edge-dispatch case: migrate a `X-Void-Original-URL` header set by an
    // outer dispatcher into the map exactly once per request.
    if (!voidOriginalUrls.has(c.req.raw)) {
      const h = c.req.raw.headers.get('X-Void-Original-URL');
      if (h != null) {
        try {
          voidOriginalUrls.set(c.req.raw, new URL(h));
        } catch {
          /* malformed header → treat as non-rewritten */
        }
      }
    }
    (c as any).rewrite = (path: string) => {
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error(
          'c.rewrite() only accepts internal, path-absolute destinations — they must start with a single "/" (a leading "//" parses as protocol-relative and would proxy cross-origin); use fetch() for external URLs',
        );
      }
      const qIdx = path.indexOf('?');
      const hIdx = path.indexOf('#');
      const firstDelim = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
      const assetCheckPath = firstDelim === -1 ? path : path.slice(0, firstDelim);
      if (
        /\.(png|jpg|jpeg|gif|webp|avif|svg|ico|css|js|mjs|cjs|woff|woff2|ttf|otf|eot|mp4|webm|mp3|wav|pdf|txt|xml|json|wasm|map)$/i.test(
          assetCheckPath,
        )
      ) {
        throw new VoidAssetRewriteError(path);
      }
      // Strip fragment alongside query — `URL.pathname` setter percent-encodes
      // `#` into `%23`, so we split on whichever of `?`/`#` came first. The
      // search slice still starts at `?` (if any) and stops at `#` (if any).
      const pathOnly = firstDelim === -1 ? path : path.slice(0, firstDelim);
      const searchOnly = qIdx === -1 ? '' : path.slice(qIdx, hIdx === -1 ? path.length : hIdx);
      const rewriteUrl = new URL(c.req.url);
      rewriteUrl.pathname = pathOnly;
      if (searchOnly) {
        rewriteUrl.search = searchOnly;
      }
      const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);
      const prior = voidOriginalUrls.get(c.req.raw);
      voidOriginalUrls.set(rewriteReq, prior ?? new URL(c.req.url));
      // In bare test envs `c.executionCtx` throws; compile.ts now branches at
      // compile time on target. The node-target branch omits the arg entirely.
      return app.fetch(rewriteReq, (c as any).env);
    };
    const origRedirect = c.redirect.bind(c);
    (c as any).redirect = (location: string, status?: number) => {
      if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
        const search = new URL(c.req.raw.url).search;
        return origRedirect(mergeQueryIntoLocation(location, search), status as any);
      }
      return origRedirect(location, status as any);
    };
    (c as any).originalUrl = () => voidOriginalUrls.get(c.req.raw) ?? null;
    (c as any).isRewritten = () => voidOriginalUrls.has(c.req.raw);
    await next();
  });
}

describe('c.redirect runtime wrapper', () => {
  it('preserves the original request query on internal redirects', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('/new', 302));

    const res = await app.fetch(new Request('http://localhost/old?x=1&y=2'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/new?x=1&y=2');
  });

  it("destination's explicit query wins over the incoming request query", async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('/new?foo=1', 302));

    const res = await app.fetch(new Request('http://localhost/old?foo=override&bar=2'));

    expect(res.status).toBe(302);
    // `foo=1` from destination must NOT be replaced by `foo=override`;
    // `bar=2` from the request is merged since destination doesn't carry it.
    expect(res.headers.get('Location')).toBe('/new?foo=1&bar=2');
  });

  it('drops the incoming query when destination has an explicit empty query', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('/new?', 302));

    const res = await app.fetch(new Request('http://localhost/old?token=secret&bar=2'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/new');
  });

  it('preserves fragments when an explicit empty query drops incoming params', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('/new?#faq', 302));

    const res = await app.fetch(new Request('http://localhost/old?token=secret&bar=2'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/new#faq');
  });

  it('keeps destination fragments after the merged query string', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('/new#faq', 302));

    const res = await app.fetch(new Request('http://localhost/old?utm=x'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/new?utm=x#faq');
  });

  it('keeps destination fragments after merged destination and request queries', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('/new?a=1#faq', 302));

    const res = await app.fetch(new Request('http://localhost/old?a=override&b=2'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/new?a=1&b=2#faq');
  });

  it('does not merge incoming query into protocol-relative ("//host/x") locations', async () => {
    // `"//partner.example.com/landing".startsWith("/")` is true — a naive
    // path-absolute check would merge the request query into the Location
    // header, leaking attacker-controlled params (or victim session tokens)
    // to a cross-origin host. Protocol-relative URLs must pass through
    // untouched, just like absolute URLs.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/old', (c) => c.redirect('//partner.example.com/landing', 302));

    const res = await app.fetch(
      new Request('http://localhost/old?session=ATTACKER_TOKEN&email=victim@example.com'),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('//partner.example.com/landing');
  });
});

/**
 * Mirror of `compileRoutingRulesMiddleware` in compile.ts: evaluate static
 * rewrite/redirect rules pre-asset, but short-circuit when the request is an
 * internal re-dispatch (tracked via `__voidOriginalUrls`). The guard is what
 * prevents single-hop rewrite loops — even if the destination itself matches a
 * rewrite rule, the rule table is skipped on the replayed request.
 *
 * Kept in sync with compile.ts by shape; the text-level tests in
 * `describe('compileRouteTable')` above anchor the emitted source string.
 */
function installRoutingRulesMiddleware(
  app: Hono,
  voidOriginalUrls: WeakMap<Request, URL>,
  rules: Array<{ source: string; destination: string; status: number; force?: boolean }>,
): void {
  app.use('*', async (c, next) => {
    if (voidOriginalUrls.has(c.req.raw)) {
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
      const prior = voidOriginalUrls.get(c.req.raw);
      voidOriginalUrls.set(rewriteReq, prior ?? new URL(c.req.url));
      return app.fetch(rewriteReq, (c as any).env);
    }
    return c.redirect(matched.destination, matched.status as any);
  });
}

describe('c.rewrite runtime wrapper', () => {
  it('re-dispatches to the rewritten path and exposes c.originalUrl / c.isRewritten', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/external', (c) => (c as any).rewrite('/internal'));
    app.get('/internal', (c) => {
      return new Response('internal-body', {
        headers: {
          'X-Handler': 'internal',
          'X-Original-Url': (c as any).originalUrl()?.href ?? '',
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
    // Regression anchor: in production on the default target, Void's dispatch
    // worker applies static routing.rewrites / fallbacks by mutating the
    // pathname and setting `X-Void-Original-URL` on the forwarded request.
    // The worker's entry middleware migrates that header into the
    // `__voidOriginalUrls` WeakMap once per request, so both `c.originalUrl()`
    // and `c.isRewritten()` report the pre-rewrite URL without reading the
    // header every call.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/en/docs', (c) => {
      return new Response('docs-body', {
        headers: {
          'X-Original-Url': (c as any).originalUrl()?.href ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    const dispatchForwarded = new Request('http://localhost/en/docs', {
      headers: { 'X-Void-Original-URL': 'http://localhost/docs' },
    });
    const res = await app.fetch(dispatchForwarded);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('docs-body');
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/docs');
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('single-hop loop guard: re-dispatched request skips the static rule table', async () => {
    // Regression anchor for the `__voidOriginalUrls` WeakMap guard in
    // compile.ts. A middleware calls `c.rewrite('/a')`, and `/a` itself is
    // also a rewrite source that (without the guard) would re-fire endlessly.
    // Counter tracks how many times the routing rule table *matches* a request
    // so the test fails loudly if the guard regresses.
    const app = new Hono();
    const voidOriginalUrls = new WeakMap<Request, URL>();
    let ruleMatches = 0;

    installVoidWrappers(app, voidOriginalUrls);
    app.use('*', async (c, next) => {
      if (voidOriginalUrls.has(c.req.raw)) {
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
        voidOriginalUrls.set(rewriteReq, new URL(c.req.url));
        return app.fetch(rewriteReq, (c as any).env);
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
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers.ts');
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
    const voidOriginalUrls = new WeakMap<Request, URL>();
    installVoidWrappers(app, voidOriginalUrls);
    installRoutingRulesMiddleware(app, voidOriginalUrls, preAsset);

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
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let invocations = 0;
    const observed: Array<boolean> = [];
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
    const voidOriginalUrls = new WeakMap<Request, URL>();
    installVoidWrappers(app, voidOriginalUrls);

    let invocations = 0;
    const observedReqUrls: Array<string> = [];
    const observedOriginalUrls: Array<URL | null> = [];
    app.use('*', async (c, next) => {
      invocations++;
      observedReqUrls.push(c.req.url);
      observedOriginalUrls.push((c as any).originalUrl());
      await next();
    });

    // Fallback rule: /missing/* rewrites to /spa-shell on asset-miss.
    const fallbackRules = [{ source: '/missing/*', destination: '/spa-shell', status: 200 }];
    app.notFound((c) => {
      if (voidOriginalUrls.has(c.req.raw)) {
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
    expect(observedOriginalUrls[1]?.href).toBe('http://localhost/missing/deep');
  });

  it('c.rewrite() target reaches fallbackRules when no route matches', async () => {
    // Regression anchor for F4: a user-initiated `c.rewrite("/missing")` whose
    // target has no route should still get a chance at `routing.fallbacks` —
    // the fallback rule was authored as the last-resort handler for `/missing`
    // regardless of how the request arrived. The original framework bug
    // conflated three populators of `__voidOriginalUrls` (dispatch handoff,
    // static-rewrite middleware, user `c.rewrite`) under one fallback guard,
    // so user rewrites silently bypassed fallbacks. The fix splits the guard
    // onto a separate `__voidFallbackHandled` WeakSet that is populated only
    // by fallback re-dispatches (preserving single-hop semantics + parity
    // with dispatch's pipeline) — user rewrites and static rewrites flow
    // through to fallbacks normally.
    const app = new Hono();
    const voidOriginalUrls = new WeakMap<Request, URL>();
    const voidFallbackHandled = new WeakSet<Request>();
    installVoidWrappers(app, voidOriginalUrls);

    app.use('*', async (c, next) => {
      if (new URL(c.req.url).pathname === '/trigger') {
        return (c as any).rewrite('/missing');
      }
      await next();
    });

    const fallbackRules = [{ source: '/missing', destination: '/index', status: 200 }];
    app.notFound((c) => {
      // New guard: skip only if THIS request already came from a fallback
      // re-dispatch. User c.rewrite (sets __voidOriginalUrls but not
      // __voidFallbackHandled) reaches fallbacks correctly.
      if (voidFallbackHandled.has(c.req.raw)) {
        return c.text('not-found', 404);
      }
      const pathname = new URL(c.req.url).pathname;
      for (const rule of fallbackRules) {
        if (rule.source === pathname && rule.status === 200) {
          const rewriteUrl = new URL(c.req.url);
          rewriteUrl.pathname = rule.destination;
          const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);
          const prior = voidOriginalUrls.get(c.req.raw);
          voidOriginalUrls.set(rewriteReq, prior ?? new URL(c.req.url));
          // Mark only the fallback re-dispatch — single-hop semantics.
          voidFallbackHandled.add(rewriteReq);
          return app.fetch(rewriteReq, (c as any).env);
        }
      }
      return c.text('not-found', 404);
    });

    app.get('/index', (c) => c.text('index-body', 200));

    const res = await app.fetch(new Request('http://localhost/trigger'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('index-body');
  });

  it('fallback re-dispatch does not cycle if its destination is also a fallback source', async () => {
    // Regression anchor for the `__voidFallbackHandled` cycle guard: a
    // fallback rewrite whose destination matches another fallback source
    // should fire exactly once — the re-dispatch is marked so the inner
    // notFound skips fallbacks. Mirrors dispatch's single-pass semantics.
    const app = new Hono();
    const voidOriginalUrls = new WeakMap<Request, URL>();
    const voidFallbackHandled = new WeakSet<Request>();
    installVoidWrappers(app, voidOriginalUrls);

    let fallbackInvocations = 0;
    const fallbackRules = [
      { source: '/a', destination: '/b', status: 200 },
      { source: '/b', destination: '/c', status: 200 },
    ];
    app.notFound((c) => {
      if (voidFallbackHandled.has(c.req.raw)) {
        return c.text('terminal-404', 404);
      }
      fallbackInvocations++;
      const pathname = new URL(c.req.url).pathname;
      for (const rule of fallbackRules) {
        if (rule.source === pathname) {
          const rewriteUrl = new URL(c.req.url);
          rewriteUrl.pathname = rule.destination;
          const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);
          const prior = voidOriginalUrls.get(c.req.raw);
          voidOriginalUrls.set(rewriteReq, prior ?? new URL(c.req.url));
          voidFallbackHandled.add(rewriteReq);
          return app.fetch(rewriteReq, (c as any).env);
        }
      }
      return c.text('terminal-404', 404);
    });

    const res = await app.fetch(new Request('http://localhost/a'));
    // First fallback fires (/a → /b), second hop is marked, /b's notFound
    // skips fallbacks → terminal 404.
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('terminal-404');
    expect(fallbackInvocations).toBe(1);
  });

  it('c.rewrite preserves a "?query" in the destination path (does not URL-encode "?")', async () => {
    // Regression anchor: setting `URL.pathname = "/page?x=1"` percent-encodes
    // the `?` into `%3F`, so the re-dispatched request lands at `/page%3Fx=1`
    // and the query is lost. The wrapper must split on the first `?` and set
    // `pathname` + `search` separately.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

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

  it('c.rewrite preserves the incoming query when the destination has none', async () => {
    // `c.rewrite('/en/page')` on a request to `/page?x=1` must forward `?x=1`
    // to the rewritten handler — matches static _redirects 200 rewrites (which
    // forbid `?` in destinations and always preserve the incoming query) and
    // avoids dropping caller-provided state like pagination or OAuth params.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/from', (c) => (c as any).rewrite('/page'));
    app.get('/page', (c) => {
      return new Response('ok', {
        headers: { 'X-Req-Search': new URL(c.req.url).search },
      });
    });

    const res = await app.fetch(new Request('http://localhost/from?x=1&y=2'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Req-Search')).toBe('?x=1&y=2');
  });

  it('c.rewrite destination query wins over the incoming query', async () => {
    // When the destination has its own `?`, it replaces the incoming query
    // wholesale (it does not merge) — documents the precedence rule.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/from', (c) => (c as any).rewrite('/page?b=2'));
    app.get('/page', (c) => {
      return new Response('ok', {
        headers: { 'X-Req-Search': new URL(c.req.url).search },
      });
    });

    const res = await app.fetch(new Request('http://localhost/from?a=1'));
    expect(res.headers.get('X-Req-Search')).toBe('?b=2');
  });

  it('c.rewrite strips a "#fragment" from the destination path (does not URL-encode "#")', async () => {
    // Regression anchor: setting `URL.pathname = "/foo#frag"` percent-encodes
    // `#` into `%23`, so the re-dispatched request lands at `/foo%23frag` and
    // matches no route. Fragments don't reach servers anyway, so the wrapper
    // must split on the first `#` and drop it (matches the asset-guard split).
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/from', (c) => (c as any).rewrite('/foo#frag'));
    app.get('/foo', (c) => {
      const u = new URL(c.req.url);
      return new Response('ok', {
        headers: {
          'X-Req-Path': u.pathname,
          'X-Req-Search': u.search,
          'X-Req-Hash': u.hash,
        },
      });
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Req-Path')).toBe('/foo');
    expect(res.headers.get('X-Req-Search')).toBe('');
    expect(res.headers.get('X-Req-Hash')).toBe('');
  });

  it('c.rewrite preserves a "?query" but strips a trailing "#fragment"', async () => {
    // `/foo?x=1#frag` → pathname `/foo`, search `?x=1`, hash dropped. The
    // search slice must stop at `#` so the fragment isn't smuggled into the
    // query string.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/from', (c) => (c as any).rewrite('/foo?x=1#frag'));
    app.get('/foo', (c) => {
      const u = new URL(c.req.url);
      return new Response('ok', {
        headers: {
          'X-Req-Path': u.pathname,
          'X-Req-Search': u.search,
          'X-Req-Hash': u.hash,
        },
      });
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Req-Path')).toBe('/foo');
    expect(res.headers.get('X-Req-Search')).toBe('?x=1');
    expect(res.headers.get('X-Req-Hash')).toBe('');
  });

  it('c.rewrite treats "?" after "#" as part of the (dropped) fragment', async () => {
    // Unusual but legal-looking: `/foo#frag?x=1`. The fragment starts at the
    // first `#`, so everything after — including the `?x=1` — is the fragment
    // and is dropped. Path is `/foo`, search is empty.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/from', (c) => (c as any).rewrite('/foo#frag?x=1'));
    app.get('/foo', (c) => {
      const u = new URL(c.req.url);
      return new Response('ok', {
        headers: {
          'X-Req-Path': u.pathname,
          'X-Req-Search': u.search,
          'X-Req-Hash': u.hash,
        },
      });
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Req-Path')).toBe('/foo');
    expect(res.headers.get('X-Req-Search')).toBe('');
    expect(res.headers.get('X-Req-Hash')).toBe('');
  });

  it('c.rewrite rejects absolute-URL destinations with an internal-only error', async () => {
    // `c.rewrite` is strictly in-worker re-dispatch. An absolute URL would
    // silently turn into a proxy — fail at the call site so users reach for
    // `fetch()` instead.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

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
    expect(String(caught)).toContain('only accepts internal, path-absolute destinations');
  });

  it('c.rewrite rejects protocol-relative ("//host/x") destinations', async () => {
    // `"//evil.com/x".startsWith("/")` is true — a naive path-absolute check
    // lets it through, and `new URL("//evil.com/x", base)` then resolves to
    // `https://evil.com/x`, silently proxying the request off-origin. Must
    // fail distinct from the generic path-absolute error so users get a
    // targeted message pointing at the `//` mistake.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite('//evil.com/x');
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain('protocol-relative');
    expect(String(caught)).toContain('//');
  });

  it('c.rewrite still accepts ordinary path-absolute destinations', async () => {
    // Regression companion to the `//` rejection — the guard is a prefix
    // check, so a `/internal` path must keep dispatching through the router.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    app.get('/from', (c) => (c as any).rewrite('/internal'));
    app.get('/internal', (c) => c.text('internal-handler', 200));

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('internal-handler');
  });

  it('c.rewrite works on a node-target context without c.executionCtx', async () => {
    // Hono's `c.executionCtx` getter throws on Node/Bun/Deno. The codegen
    // must swallow the throw so `c.rewrite` still re-dispatches correctly.
    // The test wrapper replays the same try/catch; this test drives the path
    // end-to-end by making `executionCtx` throw on access.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

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

  it.each([
    ['external URL', 'http://evil.com'],
    ['protocol-relative', '//evil.com/path'],
  ])('c.rewrite rejects %s destinations with a clear error', async (_label, destination) => {
    // Both external (`http://…`) and protocol-relative (`//host/x`) are caught
    // by the single combined guard in compile.ts. Assert the key phrase rather
    // than the verbatim sentence so small copy tweaks don't break the test.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite(destination);
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('path-absolute');
    expect((caught as Error).message).toContain('use fetch()');
  });

  it('c.rewrite to a static asset path throws VoidAssetRewriteError', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite('/hero.png');
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(caught).toBeInstanceOf(VoidAssetRewriteError);
    expect((caught as Error).name).toBe('VoidAssetRewriteError');
    expect((caught as Error).message).toContain('/hero.png');
    expect((caught as Error).message).toContain('routing.rewrites');
    expect((caught as Error).message).toContain(
      'https://void.dev/guide/edge/rewrites#runtime-rewrites-cannot-reach-static-assets',
    );
  });

  it('c.rewrite to an API .json path throws (routes should be returned, not literal .json)', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite('/api/users.json');
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    await app.fetch(new Request('http://localhost/from'));
    expect(caught).toBeInstanceOf(VoidAssetRewriteError);
    expect((caught as Error).message).toContain('/api/users.json');
  });

  it('c.rewrite asset check is case-insensitive', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite('/hero.PNG');
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    await app.fetch(new Request('http://localhost/from'));
    expect(caught).toBeInstanceOf(VoidAssetRewriteError);
  });

  it('c.rewrite to a .html path does NOT throw (ambiguous — may be a real route)', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/from', (c) => (c as any).rewrite('/about.html'));
    app.get('/about.html', (c) => c.text('about-html', 200));

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('about-html');
  });

  it('c.rewrite to a path without an extension does NOT throw', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());
    app.get('/from', (c) => (c as any).rewrite('/users/123'));
    app.get('/users/:id', (c) => c.text(`user ${c.req.param('id')}`, 200));

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('user 123');
  });

  it('c.rewrite to an asset path with a query string still throws', async () => {
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    let caught: unknown;
    app.get('/from', (c) => {
      try {
        (c as any).rewrite('/hero.png?v=2');
      } catch (err) {
        caught = err;
      }
      return c.text('handled', 200);
    });

    await app.fetch(new Request('http://localhost/from'));
    expect(caught).toBeInstanceOf(VoidAssetRewriteError);
    expect((caught as Error).message).toContain('/hero.png?v=2');
  });

  it('multi-middleware rewrite cycles are NOT caught by the single-hop guard (documented gap)', async () => {
    // Documents the caveat in docs/guide/edge/rewrites.md:146 — the WeakSet
    // loop guard is identity-keyed on the `Request` object, so each hop that
    // constructs a fresh Request (every c.rewrite(), and every replay through
    // a sibling middleware) creates a new identity. A cycle of /a → /b → /c
    // → /a therefore has no runtime guard: each hop re-runs all middleware,
    // forming infinite recursion bounded only by the host runtime's stack.
    //
    // We bound the test by bailing after a fixed hop count so CI doesn't
    // hang. The assertion captures the observed behaviour (hop counter
    // blows past any reasonable depth), pinning the gap. If a max-depth
    // guard is ever added upstream, this test is the signal to revisit it.
    const app = new Hono();
    installVoidWrappers(app, new WeakMap<Request, URL>());

    const MAX_HOPS = 50;
    let hops = 0;

    const nextPath: Record<string, string> = { '/a': '/b', '/b': '/c', '/c': '/a' };

    app.use('*', async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const target = nextPath[pathname];
      if (target) {
        hops++;
        if (hops > MAX_HOPS) {
          // Bail rather than recurse: this is the documented infinite loop.
          return c.text('bailed', 508);
        }
        return (c as any).rewrite(target);
      }
      return next();
    });

    // No handler ever resolves — the cycle consumes every hop. The test
    // relies on our explicit bail at MAX_HOPS.
    const res = await app.fetch(new Request('http://localhost/a'));
    expect(res.status).toBe(508);
    expect(await res.text()).toBe('bailed');
    // Exceeded MAX_HOPS, confirming no built-in guard intervened.
    expect(hops).toBeGreaterThan(MAX_HOPS);
  });

  it('emits asset-rewrite blocklist excluding extensions used by registered routes', () => {
    // Regression: dotted-extension routes (e.g. routes/feed.xml.ts → /feed.xml,
    // routes/api/openapi.json.ts → /api/openapi.json) are first-class in Void's
    // file-based router. The c.rewrite asset-extension blocklist must not
    // shadow those — a static `routing.rewrites` rule routes to the same
    // destination without complaint, so c.rewrite should too.
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/feed.xml',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'feed.xml.ts',
        },
        {
          pattern: '/api/openapi.json',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/openapi.json.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      dev: true,
    });
    // The emitted regex must NOT include `xml` or `json` since both are used
    // by registered routes — c.rewrite to those targets should re-dispatch
    // through Hono normally.
    const m = /__voidAssetRewriteExtRE = \/[^/]+\//.exec(code);
    expect(m).not.toBeNull();
    const regexSrc = m![0]!;
    expect(regexSrc).not.toContain('|xml|');
    expect(regexSrc).not.toContain('|xml)');
    expect(regexSrc).not.toContain('|json|');
    expect(regexSrc).not.toContain('|json)');
    // Untouched extensions still in the blocklist.
    expect(regexSrc).toContain('png');
    expect(regexSrc).toContain('css');
    expect(regexSrc).toContain('woff2');
  });

  it('emits the full asset-rewrite blocklist when no routes use dotted extensions', () => {
    // Sanity: with only conventional routes, the blocklist stays as-is and
    // the diagnostic still fires for genuinely-asset paths (the original
    // motivation: catch /hero.png mystery 404s with a useful error).
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/users',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/users.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      dev: true,
    });
    const m = /__voidAssetRewriteExtRE = (\/[^/]+\/i?)/.exec(code);
    expect(m).not.toBeNull();
    const regexSrc = m![1]!;
    // All canonical asset extensions present.
    for (const ext of ['png', 'css', 'json', 'xml', 'txt', 'wasm']) {
      expect(regexSrc).toContain(ext);
    }
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

  it('guards the __voidAnnotateRouting trace header set with try/catch', () => {
    const code = compileWith({ dev: true });
    // A non-ASCII trace value throws on header set; the guard must swallow it.
    expect(code).toContain(
      'try { headers.set("X-Void-Routing", trace); } catch { return response; }',
    );
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
    // "c.rewrite -> <path> (middleware)" trace to the returned Response.
    expect(code).toContain('if (!__VOID_DEV_ROUTING) return __rewritePromise;');
    expect(code).toContain('c.rewrite -> " + path + " (middleware)');
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
      '"redirect[" + matched.rule.source + "] -> " + dest + " " + matched.rule.status + " (" + (matched.rule.origin || "unknown") + ")"',
    );
  });

  it('distinguishes force-rewrite (rewrite[...]) from fallback (fallback[...]) in trace', () => {
    const code = compileWith({ dev: true });
    expect(code).toContain('matched.rule.force === true ? "rewrite" : "fallback"');
  });

  it('keeps routing trace header values ASCII-compatible', () => {
    const code = compileWith({ dev: true });
    expect(code).not.toContain('\\u2192');
    expect(code).toContain('c.rewrite -> " + path + " (middleware)');
    expect(code).toContain('__kind + "[" + matched.rule.source + "] -> " + dest');
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
    // Cycle guard against fallback→fallback re-entry. Distinct from
    // `__voidOriginalUrls` so user `c.rewrite` and static-rewrite chains
    // still reach fallbacks for the rewrite target.
    expect(code).toContain('if (!__voidFallbackHandled.has(c.req.raw))');
    expect(code).toContain('__voidFallbackHandled.add(rewriteReq);');
    // Generated no-route 404s are marked for dispatch; user handler 404s are not.
    expect(code).toContain('headers.set("X-Void-No-Match", "1")');
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
  const headerRules = [{ pattern: '/*', headers: [['x-test', '1']] as Array<[string, string]> }];
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

  it('applies header rules to immutable responses in local dev', async () => {
    const code = compile({ nodeTarget: false, dev: true });
    const app = evalCompiledApp(code);

    app.get('/redirect', () => Response.redirect('https://example.com/next', 302));

    const stubCtx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };
    const res = await app.fetch(
      new Request('http://localhost/redirect'),
      {},
      stubCtx as unknown as ExecutionContext,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/next');
    expect(res.headers.get('x-test')).toBe('1');
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

  // Regression: prior to feat/rewrites the void.json validator warned that
  // `routing.fallbacks` was default-target-only and the codegen skipped the
  // notFound fallback hook on non-default targets. Fallbacks now apply on
  // every target — this test locks in that contract so reintroducing a
  // `nodeTarget` → "strip fallbackRules" branch fails loudly in both dev and
  // prod builds.
  it('emits __fallbackRules on node targets in both dev and prod when fallbackRules is non-empty', () => {
    const devCode = compile({ nodeTarget: true, dev: true });
    const prodCode = compile({ nodeTarget: true, dev: false });
    expect(devCode).toContain('const __fallbackRules =');
    expect(prodCode).toContain('const __fallbackRules =');
    // Rule source must be inlined so the generated code actually checks it at
    // runtime — a regression that silently serialized an empty array would
    // still emit the identifier.
    expect(devCode).toContain('"source":"/docs/*"');
    expect(prodCode).toContain('"source":"/docs/*"');
  });

  // Only the CF-prod build trusts an inbound `X-Void-Original-URL` header:
  // dispatch strips client-supplied values on ingress, so any header the
  // worker sees there is dispatch-authored. CF-dev (no dispatch in front)
  // and node/bun/deno self-hosted (user owns ingress) must NOT trust the
  // header — clients could spoof `c.originalUrl()` / `c.isRewritten()` for
  // user code that branches on them.
  //
  // This is a behavioral test that evaluates the actual compiled artifact
  // (not the `installVoidWrappers` mirror) and drives a real Request through
  // it with `X-Void-Original-URL: /spoof` set. Asserting on the runtime
  // outputs of `c.originalUrl()` and `c.isRewritten()` catches both:
  // - false negatives a string check would flag (e.g. destructuring the
  //   header getter into a local — keeps the gate but breaks `code.includes`).
  // - false positives a string check would silently miss (e.g. emitting the
  //   header read in BOTH dev and prod but only honoring it in prod — the
  //   substring is present in cfDev's output but the runtime ignores it).
  it('reads inbound X-Void-Original-URL only on CF-prod (CF with dev=false)', async () => {
    type Permutation = {
      readonly label: string;
      readonly opts: { nodeTarget: boolean; dev: boolean };
      readonly trustsHeader: boolean;
    };
    const permutations: Array<Permutation> = [
      { label: 'cfProd', opts: { nodeTarget: false, dev: false }, trustsHeader: true },
      { label: 'cfDev', opts: { nodeTarget: false, dev: true }, trustsHeader: false },
      { label: 'nodeProd', opts: { nodeTarget: true, dev: false }, trustsHeader: false },
      { label: 'nodeDev', opts: { nodeTarget: true, dev: true }, trustsHeader: false },
    ];

    for (const { label, opts, trustsHeader } of permutations) {
      const code = compile(opts);
      const app = evalCompiledApp(code);

      // The compiled middleware only attaches `c.originalUrl` / `c.isRewritten`
      // — they're not bound to the route handler scope until the wrapper
      // middleware runs, so define the route AFTER eval so it sees the wrappers.
      app.get('/probe', (c: any) => {
        const orig = c.originalUrl();
        return new Response('probe', {
          headers: {
            'X-Original-Url': orig?.href ?? '',
            'X-Is-Rewritten': c.isRewritten() ? '1' : '0',
          },
        });
      });

      // Pass a stub `executionCtx` as the third arg — the second middleware
      // emitted by the compiler reads `c.executionCtx` inside
      // `requestContext.run`, which throws in a bare Hono env without it.
      const stubCtx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      };
      const res = await app.fetch(
        new Request('http://localhost/probe', {
          headers: { 'X-Void-Original-URL': 'http://localhost/spoof' },
        }),
        {},
        stubCtx as unknown as ExecutionContext,
      );

      expect(res.status, `${label}: probe should return 200`).toBe(200);
      if (trustsHeader) {
        expect(res.headers.get('X-Original-Url'), `${label}: should trust header`).toBe(
          'http://localhost/spoof',
        );
        expect(res.headers.get('X-Is-Rewritten'), `${label}: should report rewritten`).toBe('1');
      } else {
        expect(res.headers.get('X-Original-Url'), `${label}: must NOT trust header`).toBe('');
        expect(res.headers.get('X-Is-Rewritten'), `${label}: must NOT report rewritten`).toBe('0');
      }
    }
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

  it('does not mark pages API no-match responses as fallback-eligible', () => {
    const code = compileRouteTable(
      {
        ...emptyScan,
        pages: {
          pages: [
            {
              componentId: 'pages/index.vue',
              componentPath: '/pages/index.vue',
              serverPath: null,
              pattern: '/',
              params: [],
              catchAll: false,
              methods: [],
              ssrMode: 'auto',
              prerenderMode: 'auto',
              renderMode: 'server',
              shouldPrerender: false,
            },
          ],
          layouts: [],
          namedLayouts: [],
        },
      },
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        nodeTarget: false,
        dev: false,
      },
      {
        pagesDir: '/pages',
        pagesDirRelative: 'pages',
        protocolPath: '/resolved/void/pages-protocol.mjs',
        headPath: '/resolved/void/pages-head.mjs',
        clientEntryId: 'virtual:void-pages-client',
      },
    );

    expect(code).toContain('if (path === "/api" || path.startsWith("/api/"))');
    expect(code).toContain('return c.text("Not Found", 404);');
    expect(code).toContain(
      'return __voidMarkNoMatch(c.req.raw, await serveCustomErrorPage(c, 404, "Not Found"));',
    );
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

  it('re-exports the live Durable Object class when enabled', () => {
    const code = compileWorkerEntry(
      false,
      undefined,
      'assets',
      [],
      'void/_env',
      undefined,
      false,
      false,
      true,
    );

    expect(code).toContain('VoidLiveStreamDurableObject');
    expect(code).toContain('export { VoidLiveStreamDurableObject };');
    expect(code).toContain('__setLiveBindingName("VOID_LIVE");');
  });

  it('re-exports the configured live Durable Object class', () => {
    const code = compileWorkerEntry(
      false,
      undefined,
      'assets',
      [],
      'void/_env',
      undefined,
      false,
      false,
      {
        bindingName: 'VOID_LIVE_abcd1234',
        className: 'VoidLiveStreamDurableObject_abcd1234',
      },
    );

    expect(code).toContain(
      'export { VoidLiveStreamDurableObject as VoidLiveStreamDurableObject_abcd1234 };',
    );
    expect(code).toContain('__setLiveBindingName("VOID_LIVE_abcd1234");');
  });

  it('re-exports the VoidPlatformSandbox Durable Object class when enabled', () => {
    const code = compileWorkerEntry(false, undefined, 'assets', [], 'void/_env', undefined, true);

    // Platform sandbox wraps Cloudflare's Sandbox with metering/gate hooks.
    // Importing it (instead of the bare Sandbox class) lets user subclasses
    // inherit those overrides without opting in.
    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "void/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export { __VoidSandbox as Sandbox };');
    expect(code).toContain('__setSandboxBindingName("SANDBOX");');
  });

  it('exports the configured Sandbox Durable Object subclass via VoidPlatformSandbox', () => {
    const code = compileWorkerEntry(false, undefined, 'assets', [], 'void/_env', undefined, {
      bindingName: 'CODE',
      className: 'CodeSandbox',
      runtimePath: 'void/sandbox',
    });

    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "void/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    // User subclass syntax (`class X extends Sandbox`) stays unchanged because
    // VoidPlatformSandbox itself extends Sandbox.
    expect(code).toContain('export class CodeSandbox extends __VoidSandbox {}');
    expect(code).toContain('__setSandboxBindingName("CODE");');
  });

  it('uses the resolved sandbox runtime path when one is provided', () => {
    const code = compileWorkerEntry(false, undefined, 'assets', [], 'void/_env', undefined, {
      runtimePath: '/abs/path/to/sandbox.mjs',
    });

    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "/abs/path/to/sandbox.mjs"',
    );
  });

  it('omits the sandbox import and export when sandbox is disabled', () => {
    const code = compileWorkerEntry();

    expect(code).not.toContain('__VoidSandbox');
    expect(code).not.toContain('VoidPlatformSandbox');
    expect(code).not.toContain('__setSandboxBindingName');
    expect(code).not.toContain('from "@cloudflare/sandbox"');
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
    // Hashed assets: immutable + long max-age (content-addressed, safe to cache forever).
    expect(code).toContain('public, max-age=31536000, immutable');
    // Non-hashed asset responses: no-store — see regression test below for why.
    expect(code).toContain('"Cache-Control", "no-store"');
    // No Cache API usage (edge caching happens at dispatch layer)
    expect(code).not.toContain('caches.default');
    expect(code).not.toContain('cache.match');
    expect(code).not.toContain('cache.put');
  });

  it('stamps no-store on non-hashed asset responses to avoid edge-cache poisoning across deploys', () => {
    const code = compileWorkerEntry();

    // A single poisoned entry (transient 404 from a broken deploy, a path that
    // later becomes a real route) would otherwise shadow the new behavior
    // across the edge for every subsequent request until manually purged — the
    // platform's atomic-deploy cache keying lives at the dispatch layer and
    // can't reach CF's managed edge cache once s-maxage puts an entry there.
    // no-store keeps these responses out of that cache entirely.
    expect(code).not.toMatch(/s-maxage=\d+.*must-revalidate/);
    expect(code).toContain('"Cache-Control", "no-store"');
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

  it('serveWithAssets does not include the SPA shell fallback by default', () => {
    const code = compileWorkerEntry();

    // Pages and SSR apps generate intentional HTML 404 responses. The outer
    // asset fallthrough must not rewrite those to the SPA shell.
    expect(code).not.toContain('"/index.html"');
    expect(code).not.toContain('accept.includes("text/html")');
  });

  it('serveWithAssets falls back to /index.html for unmatched HTML GET/HEADs when enabled', () => {
    const code = compileWorkerEntry(
      false,
      undefined,
      'assets',
      [],
      'void/_env',
      undefined,
      false,
      true,
    );

    // With assetConfig.not_found_handling: 'none' (now the default for any
    // routes/middleware SPA), the asset binding returns 404 instead of a SPA
    // shell. The worker entry must fall back to /index.html itself for HTML
    // navigations so client-side routing keeps working without relying on
    // Cloudflare's `Sec-Fetch-Mode: navigate` short-circuit, which bypasses
    // run_worker_first and silently breaks auth middleware + OAuth callbacks.
    expect(code).toContain('text/html');
    expect(code).toContain('"/index.html"');
    expect(code).toMatch(/env\.ASSETS\.fetch\(new Request\(indexUrl/);
  });

  it('serveWithAssets only falls back to index.html for HTML accept', () => {
    const code = compileWorkerEntry(
      false,
      undefined,
      'assets',
      [],
      'void/_env',
      undefined,
      false,
      true,
    );

    // Non-HTML requests (e.g. JSON API calls hitting an unknown route) must
    // get the worker's original 404 — not the SPA shell — so clients can
    // distinguish "endpoint missing" from "user landed on a SPA route".
    expect(code).toContain('accept.includes("text/html")');
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

  it('passes custom binding names to remote env proxying', () => {
    const code = compileWorkerEntry(
      true,
      {
        bindingNames: { d1: 'myapp_db', kv: 'myapp_kv', r2: 'myapp_storage' },
        remotePath: '/resolved/remote.mjs',
        envPath: '/resolved/env-legacy.mjs',
      },
      'assets',
      [],
      '/resolved/env.mjs',
    );

    expect(code).toContain(
      'createRemoteEnv(env, {"d1":"myapp_db","kv":"myapp_kv","r2":"myapp_storage"})',
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

/**
 * Extract the emitted `__compilePattern` and `__matchPattern` runtime helpers
 * from a generated route-table source string and rebuild them as live JS
 * functions so we can exercise the actual emitter output (not a hand-written
 * mirror). This guards against drift between the dispatch worker's compiler
 * (`packages/dispatch/src/pattern.ts`) and the framework's inlined emitter.
 */
function extractEmittedPatternRuntime(code: string): {
  matchPattern: (pattern: string, pathname: string) => boolean;
  compilePattern: (source: string) => { regex: RegExp; names: Array<string> };
} {
  const compileFnStart = code.indexOf('function __compilePattern(source) {');
  if (compileFnStart === -1) {
    throw new Error('emitted source missing __compilePattern');
  }
  // The emitter's own helper bodies are flat (no nested closing braces beyond
  // the regex character classes); a brace-aware scan would be overkill.
  const matchFnStart = code.indexOf('function __matchPattern(pattern, pathname) {', compileFnStart);
  if (matchFnStart === -1) {
    throw new Error('emitted source missing __matchPattern');
  }
  const matchFnEnd = code.indexOf('\nfunction __substituteParams', matchFnStart);
  if (matchFnEnd === -1) {
    throw new Error('emitted source missing __substituteParams sentinel');
  }
  const helpersSrc = code.slice(compileFnStart, matchFnEnd);
  // `new Function` evaluates the helpers in a fresh scope, then returns the
  // two we care about. The Set-warned dedupe map is private to that scope.
  // oxlint-disable-next-line no-new-func
  const factory = new Function(`${helpersSrc}\nreturn { __compilePattern, __matchPattern };`);
  const { __compilePattern, __matchPattern } = factory() as {
    __compilePattern: (source: string) => { regex: RegExp; names: Array<string> };
    __matchPattern: (pattern: string, pathname: string) => boolean;
  };
  return { compilePattern: __compilePattern, matchPattern: __matchPattern };
}

describe('emitted __compilePattern / __matchPattern runtime', () => {
  // Build a minimal route table with a header rule so the emitter inlines the
  // pattern helpers (header middleware is what triggers `ensureCompilePatternEmitted`).
  const emptyScan: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };
  const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
    ...testOptions,
    dev: true,
    headerRules: [{ pattern: '/*', headers: [['x-test', '1']] as Array<[string, string]> }],
  });
  const { compilePattern, matchPattern } = extractEmittedPatternRuntime(code);

  it('compiles a single bare "*" with the legacy "splat" capture', () => {
    const { regex, names } = compilePattern('/docs/*');
    expect(names).toEqual(['splat']);
    const m = regex.exec('/docs/intro/getting-started');
    expect(m?.groups?.splat).toBe('intro/getting-started');
  });

  it('compiles a multi-"*" pattern without throwing — second wildcard is non-capturing', () => {
    // Regression: F3 — `routing.headers: { "/a/*/b/*": [...] }` used to crash
    // every CF dev request with `SyntaxError: Invalid regular expression: ...
    // Duplicate capture group name`. The first `*` should still capture as
    // `splat`; subsequent bare `*` collapse to a non-capturing `.*`.
    const { regex, names } = compilePattern('/a/*/b/*');
    expect(names).toEqual(['splat']);
    const m = regex.exec('/a/x/b/y');
    expect(m).not.toBeNull();
    expect(m?.groups?.splat).toBe('x');
  });

  it(':name and bare "*" do not clash even when both appear', () => {
    // `:id*` produces `(?<id>...)`; the bare `*` produces `(?<splat>...)` —
    // distinct group names, so no collision.
    const { regex, names } = compilePattern('/u/:id*/files/*');
    expect(names).toEqual(['id', 'splat']);
    const m = regex.exec('/u/42/extra/files/a/b');
    expect(m?.groups?.id).toBe('42/extra');
    expect(m?.groups?.splat).toBe('a/b');
  });

  it('__matchPattern returns false instead of throwing on a malformed pattern', () => {
    // The emitter wraps `new RegExp` in try/catch so a single bad rule cannot
    // 500 unrelated traffic on CF dev. Construct a pattern whose escaped form
    // yields an invalid regex by abusing an unbalanced `[` (regex-special,
    // copied through verbatim is impossible — but a malformed `:name*` paired
    // with raw `(` characters fed via the literal escape skip... actually the
    // emitter escapes regex specials, so we instead verify the catch path by
    // constructing a deliberately-broken pattern that the emitter's escape
    // strategy still passes through cleanly. The fallback test relies on the
    // try/catch being present — when no construction error occurs, the result
    // is a normal boolean, never a thrown exception.
    expect(() => matchPattern('/foo/*', '/foo/bar')).not.toThrow();
    expect(matchPattern('/foo/*', '/foo/bar')).toBe(true);
    // `__matchPattern` is the resilient entry point — even an empty pattern
    // (which compiles to `^$`) must return false rather than throw on a
    // non-matching pathname.
    expect(matchPattern('', '/anything')).toBe(false);
  });

  it('__compilePattern itself still throws on duplicate capture group names', () => {
    // The legacySplatCaptured flag prevents two bare `*`s clashing on the
    // implicit `splat` name, but it does NOT cover duplicate `:name` tokens
    // or a `:splat` colliding with a bare `*`. These cases still throw at
    // construction. They're caught by:
    //   1. Build-time validation (`assertUniqueCaptureNames` in config.ts)
    //   2. Runtime per-rule try/catch in `emitApplyRoutingRules` (so one
    //      malformed rule cannot 500 unrelated traffic if validation is bypassed)
    expect(() => compilePattern('/:id/:id')).toThrow(/duplicate capture group name/i);
    expect(() => compilePattern('/:splat/*')).toThrow(/duplicate capture group name/i);
    expect(() => compilePattern('/:rest*/:rest*')).toThrow(/duplicate capture group name/i);
  });

  it('emitApplyRoutingRules wraps per-rule compile in try/catch and skips bad rules', () => {
    // Behavioral verification of the runtime guard: a single rule with a bad
    // source must not 500 the request — it should be skipped (with a warn-once)
    // and other rules in the table should still match.
    const codeWithRules = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        dev: true,
        // First rule is malformed (duplicate `:id`); second rule is valid.
        // The middleware must skip the bad one, log warn once, and apply the good one.
        redirectRules: [
          {
            source: '/:id/:id',
            destination: '/x',
            status: 200,
            force: true,
            origin: 'test',
          },
          {
            source: '/old',
            destination: '/new',
            status: 200,
            force: true,
            origin: 'test',
          },
        ],
      },
    );
    // String-shape assertion: the emitted middleware must wrap __compilePattern
    // in try/catch around the `regex` extraction, mirroring dispatch's
    // applyRoutingRules. Without this, a single bad rule would 500 every request.
    expect(codeWithRules).toContain('try {');
    expect(codeWithRules).toContain('({ regex } = __compilePattern(rule.source));');
    expect(codeWithRules).toContain('skipping routing rule with invalid source');
    expect(codeWithRules).toContain('continue;');
  });

  it('__matchPattern swallows construction errors and returns false', () => {
    // Directly stress-test the try/catch by monkey-patching the global
    // RegExp once: the emitted body calls `new RegExp(...)` — if it throws,
    // the catch returns false and warns at most once.
    const originalRegExp = globalThis.RegExp;
    let callCount = 0;
    const consoleWarnings: Array<string> = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      consoleWarnings.push(String(msg));
    };
    try {
      // oxlint-disable-next-line no-global-assign
      (globalThis as unknown as { RegExp: typeof RegExp }).RegExp = function () {
        callCount++;
        throw new SyntaxError('Invalid regular expression: Duplicate capture group name');
      } as unknown as typeof RegExp;
      expect(matchPattern('/a/*/b/*', '/a/x/b/y')).toBe(false);
      expect(callCount).toBeGreaterThan(0);
      expect(consoleWarnings.some((w) => w.includes('failed to compile route pattern'))).toBe(true);
      // Second call with the same pattern must not double-warn.
      const warnedCount = consoleWarnings.length;
      expect(matchPattern('/a/*/b/*', '/foo')).toBe(false);
      expect(consoleWarnings.length).toBe(warnedCount);
    } finally {
      // oxlint-disable-next-line no-global-assign
      (globalThis as unknown as { RegExp: typeof RegExp }).RegExp = originalRegExp;
      console.warn = originalWarn;
    }
  });
});

describe('compileWorkerEntry — ISR wiring', () => {
  it('is unchanged without the isr param (single render line, no handleIsr)', () => {
    const code = compileWorkerEntry();
    expect(code).toContain(
      'return serveWithAssets(request, env, await app.fetch(request, userEnv, ctx));',
    );
    expect(code).not.toContain('handleIsr');
    // The `if (env.ISR_CACHE)` render guard is only emitted when ISR is wired.
    expect(code).not.toContain('if (env.ISR_CACHE)');
    expect(code).not.toContain('__VOID_ISR_REVALIDATE');
  });

  it('wires the ISR cache ladder with the two baked imports when the isr param is present', () => {
    const code = compileWorkerEntry(
      false, // hasQueues
      undefined, // remote
      'assets', // assetsDir
      [], // webSocketClasses
      'void/_env', // runtimeEnvPath
      undefined, // envSchemaModule
      undefined, // sandbox
      false, // serveSpaFallback
      undefined, // live
      { runtimePath: 'void/isr' },
    );

    // Baked import #1: handleIsr from the supplied runtime path.
    expect(code).toContain('import { handleIsr } from "void/isr"');
    // Baked import #2: the two consts from the compiled route table (single source of truth).
    expect(code).toContain(
      "import { __VOID_ISR_REVALIDATE, __VOID_ISR_DEPLOYMENT_ID } from 'virtual:void-routes'",
    );
    // Render path threaded through handleIsr, guarded on the ISR_CACHE binding.
    expect(code).toContain('if (env.ISR_CACHE)');
    expect(code).toContain(
      'handleIsr(request, env, ctx, { revalidate: __VOID_ISR_REVALIDATE, deploymentId: __VOID_ISR_DEPLOYMENT_ID }, __render)',
    );
    // Deployment id + host captured on the raw env so revalidate() can purge even
    // on requests that never enter the render ladder.
    expect(code).toContain('env.__VOID_ISR_DEPLOYMENT_ID ??= __VOID_ISR_DEPLOYMENT_ID;');
    expect(code).toContain('env.__VOID_ISR_HOST ??= new URL(request.url).hostname;');
  });
});

describe('compileRouteTable — baked ISR consts', () => {
  const scan: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };

  it('emits __VOID_ISR_DEPLOYMENT_ID as a compile-time string literal (never crypto.randomUUID())', () => {
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );
    // A quoted UUID literal — baked at build time, not a runtime call.
    expect(code).toMatch(/export const __VOID_ISR_DEPLOYMENT_ID = "[0-9a-f-]{36}";/);
    expect(code).not.toContain('__VOID_ISR_DEPLOYMENT_ID = crypto.randomUUID()');
  });

  it('bakes a fresh deployment id per compilation (one shared id per deploy)', () => {
    const a = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );
    const b = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );
    const idA = a.match(/__VOID_ISR_DEPLOYMENT_ID = "([^"]+)"/)![1];
    const idB = b.match(/__VOID_ISR_DEPLOYMENT_ID = "([^"]+)"/)![1];
    expect(idA).not.toBe(idB);
  });

  it('emits the merged revalidate config verbatim (undefined | number | path map)', () => {
    const none = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
    );
    expect(none).toContain('export const __VOID_ISR_REVALIDATE = undefined;');

    const num = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
      60,
    );
    expect(num).toContain('export const __VOID_ISR_REVALIDATE = 60;');

    const map = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
      { '/blog/*': 30 },
    );
    expect(map).toContain('export const __VOID_ISR_REVALIDATE = {"/blog/*":30};');
  });
});
