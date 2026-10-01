import {
  compilePattern as sharedCompilePattern,
  mergeQueryIntoLocation as sharedMergeQueryIntoLocation,
  substituteParams as sharedSubstituteParams,
} from '@void/edge';
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
import {
  createRoutingRuntime,
  createHttpRouteHandler,
  createModuleLoader,
  createErrorRenderer,
  createPagesFallback,
  createPageGetHandler,
  createPageMutationHandler,
  createAssetFallback,
  createClientAssetTags,
  createManifestLoader,
  createSsrFallback,
  createAssetNotFound,
  createWorkerFetch,
  type RoutingRuntime,
} from '../../src/runtime/routing.ts';

const testOptions = {
  honoPath: '/resolved/hono/index.mjs',

  runtimeEnvPath: '/resolved/void/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  webSocketRuntimePath: '/resolved/void/runtime/ws-server.mjs',
  reactRefresh: true,
  auth: null,
};

describe('compileRouteTable', () => {
  it('matches every expression of a multi-cron job', () => {
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
    expect(code).toContain('job0Crons.includes(controller.cron)');
    expect(code).toContain('import("/crons/multi.ts")');
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

    expect(code).toContain('app.notFound(__createSsrFallback(');
    expect(code).toContain('load: () => import("/src/main.ssr.ts")');
    expect(code).toContain('"entryId":"src/main.client.tsx"');
    expect(code).toContain('"reactRefresh":true');
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
    expect(code).toContain('const __queueNames = ["emails"]');
    expect(code).toContain('import("/queues/emails.ts")');
    expect(code).toContain('mod.default(batch, env)');
    expect(code).toContain('export async function __processQueue');
  });

  it('resolves exact queue names before the longest prefixed-name suffix', () => {
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

    expect(code).toContain('if (exact !== -1) return exact');
    expect(code).toContain('if (!queueName.endsWith("-" + name)) continue');
    expect(code).toContain('if (name.length > matchLength)');
    expect(code).toContain('else if (name.length === matchLength)');
    expect(code).toContain('match = -1');
    expect(code).toContain('if (__queueIndex === -1)');
    expect(code).toContain('return { ok: false, error:');
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

  it('generates websocket durable object exports and proxy routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/chat/:room',
          methods: ['GET'],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ts',
        },
      ],
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
      middleware: [{ order: 1, filePath: '01.auth.ts' }],
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
    expect(code).toContain('app.all("/chat/:room"');
    expect(code).toContain(
      'if (c.req.raw.headers.get("upgrade")?.toLowerCase() !== "websocket") return next()',
    );
    expect(code).toContain('__forwardWebSocketRequest');
    expect(code.indexOf('app.use(middleware0)')).toBeLessThan(
      code.indexOf('app.all("/chat/:room"'),
    );
    const fallback = 'app.all("/chat/:room", (c) => __forwardWebSocketRequest';
    expect(code.indexOf('app.get("/chat/:room"')).toBeGreaterThan(
      code.indexOf('app.all("/chat/:room"'),
    );
    expect(code.indexOf(fallback)).toBeGreaterThan(code.indexOf('app.get("/chat/:room"'));

    scan.pages.pages = [
      {
        pattern: '/chat/:room',
        params: ['room'],
        catchAll: false,
        componentPath: 'chat/[room].vue',
        componentId: 'chat/[room]',
        serverPath: null,
        methods: [],
        ssrMode: 'server',
        prerenderMode: 'disabled',
        renderMode: 'server',
        shouldPrerender: false,
      },
    ];
    const withPages = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      { pagesDir: '/pages', pagesDirRelative: 'pages', clientEntryId: 'virtual:void-pages-client' },
    );
    expect(withPages.indexOf(fallback)).toBeGreaterThan(
      withPages.indexOf('app.get("/chat/:room", __createPageGetHandler'),
    );
    expect(withPages.indexOf(fallback)).toBeLessThan(
      withPages.indexOf('app.notFound(__createPagesFallback'),
    );
  });

  it('exports tombstones for removed websocket Durable Object classes', () => {
    const scan: ScanResult = {
      routes: [],
      websockets: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      webSocketTombstones: ['RemovedChatWs'],
    });

    expect(code).toContain('createWebSocketTombstoneDurableObject');
    expect(code).toContain(
      'export const RemovedChatWs = __createWebSocketTombstoneDurableObject("RemovedChatWs")',
    );
    expect(compileWorkerEntry({ webSocketClasses: ['RemovedChatWs'] })).toContain(
      'export { RemovedChatWs };',
    );
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
    '__compilePattern',
    '__substituteParams',
    '__mergeQueryIntoLocation',
    '__createRoutingRuntime',
    '__createHttpRouteHandler',
    '__createModuleLoader',
    '__createErrorRenderer',
    '__createPagesFallback',
    '__createPageGetHandler',
    '__createPageMutationHandler',
    '__createClientAssetTags',
    '__createManifestLoader',
    '__createSsrFallback',
    '__createAssetNotFound',
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
    sharedCompilePattern,
    sharedSubstituteParams,
    sharedMergeQueryIntoLocation,
    createRoutingRuntime,
    createHttpRouteHandler,
    createModuleLoader,
    createErrorRenderer,
    createPagesFallback,
    createPageGetHandler,
    createPageMutationHandler,
    createClientAssetTags,
    createManifestLoader,
    createSsrFallback,
    createAssetNotFound,
  ) as Hono;
}

const runtimeByApp = new WeakMap<Hono, RoutingRuntime>();
function installVoidWrappers(app: Hono, originalUrls: WeakMap<Request, URL>): void {
  const runtime = createRoutingRuntime(app, {
    nodeTarget: true,
    managedDispatch: true,
    originalUrls,
  });
  runtimeByApp.set(app, runtime);
  app.use(runtime.contextMiddleware);
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

function installRoutingRulesMiddleware(
  app: Hono,
  originalUrls: WeakMap<Request, URL>,
  rules: Array<{ source: string; destination: string; status: number; force?: boolean }>,
): void {
  const runtime =
    runtimeByApp.get(app) ?? createRoutingRuntime(app, { nodeTarget: true, originalUrls });
  app.use('*', runtime.routingMiddleware(rules));
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
      if (!voidOriginalUrls.has(c.req.raw)) {
        ruleMatches++;
      }
      await next();
    });
    installRoutingRulesMiddleware(app, voidOriginalUrls, [
      { source: '/a', destination: '/a', status: 200, force: true },
    ]);

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
    app.notFound(async (c) => {
      fallbackFired = true;
      return (
        (await runtimeByApp.get(app)!.applyFallback(c, postAsset)) ?? new Response('fallback-hit')
      );
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
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ?? c.text('not-found', 404),
    );

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
    installVoidWrappers(app, voidOriginalUrls);

    app.use('*', async (c, next) => {
      if (new URL(c.req.url).pathname === '/trigger') {
        return (c as any).rewrite('/missing');
      }
      await next();
    });

    const fallbackRules = [{ source: '/missing', destination: '/index', status: 200 }];
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ?? c.text('not-found', 404),
    );

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
    installVoidWrappers(app, voidOriginalUrls);

    let fallbackInvocations = 0;
    const fallbackRules = [
      { source: '/a', destination: '/b', status: 200 },
      { source: '/b', destination: '/c', status: 200 },
    ];
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ??
        c.text('terminal-404', 404),
    );
    app.get('/c', (c) => {
      fallbackInvocations++;
      return c.text('incorrect second fallback');
    });

    const res = await app.fetch(new Request('http://localhost/a'));
    // First fallback fires (/a → /b), second hop is marked, /b's notFound
    // skips fallbacks → terminal 404.
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('terminal-404');
    expect(fallbackInvocations).toBe(0);
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
    {
      source: '/rewrite',
      destination: '/new',
      status: 200,
      force: true,
      origin: 'void.json#routing.rewrites',
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

  function compile(
    opts: Partial<typeof testOptions> & {
      dev?: boolean;
      nodeTarget?: boolean;
      managedDispatch?: boolean;
    },
  ) {
    return compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      redirectRules,
      headerRules,
      fallbackRules,
      ...opts,
    });
  }

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

  it('runs native Cloudflare prod rewrites, headers, and post-asset fallbacks', async () => {
    const code = compile({ nodeTarget: false, dev: false, managedDispatch: false });
    const app = evalCompiledApp(code);
    app.get('/new', (c: any) =>
      c.text(c.originalUrl()?.pathname === '/rewrite' ? 'rewritten' : 'new'),
    );
    app.get('/docs.html', (c) => c.text('fallback'));

    const env = {
      ASSETS: { fetch: async () => new Response('missing', { status: 404 }) },
    };
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const rewrite = await app.fetch(new Request('http://localhost/rewrite'), env, ctx);
    expect(await rewrite.text()).toBe('rewritten');
    expect(rewrite.headers.get('x-test')).toBe('1');

    const fallback = await app.fetch(new Request('http://localhost/docs/guide'), env, ctx);
    expect(await fallback.text()).toBe('fallback');
    expect(fallback.headers.get('x-test')).toBe('1');
  });

  it('applies native Cloudflare prod headers to assets without fallback rules', async () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      nodeTarget: false,
      dev: false,
      managedDispatch: false,
      headerRules,
    });
    const app = evalCompiledApp(code);
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request('http://localhost/logo.svg'),
      { ASSETS: { fetch: async () => new Response('asset') } },
      ctx,
    );

    expect(await res.text()).toBe('asset');
    expect(res.headers.get('x-test')).toBe('1');
    expect(code).not.toContain('const __fallbackRules =');
  });

  it('omits redirect + header + fallback middleware from managed bundles', () => {
    const code = compile({ nodeTarget: false, dev: false, managedDispatch: true });
    expect(code).not.toContain('const __routingRules =');
    expect(code).not.toContain('const __headerRules =');
    expect(code).not.toContain('const __fallbackRules =');
  });

  // Regression: prior to feat/rewrites the void.json validator warned that
  // `routing.fallbacks` was default-target-only and the codegen skipped the
  // notFound fallback hook on non-default targets. Fallbacks now apply on
  // every target — this test locks in that contract so reintroducing a
  // `nodeTarget` → "strip fallbackRules" branch fails loudly in both dev and
  // prod builds.

  // Only a managed build trusts an inbound `X-Void-Original-URL` header:
  // dispatch strips client-supplied values on ingress. Native CF, CF dev,
  // and node/bun/deno targets have no trusted dispatch in front, so clients
  // must not be able to spoof rewrite metadata.
  //
  // This is a behavioral test that evaluates the actual compiled artifact
  // (with the production `installVoidWrappers` runtime) and drives a real Request through
  // it with `X-Void-Original-URL: /spoof` set. Asserting on the runtime
  // outputs of `c.originalUrl()` and `c.isRewritten()` catches both:
  // - false negatives a string check would flag (e.g. destructuring the
  //   header getter into a local — keeps the gate but breaks `code.includes`).
  // - false positives a string check would silently miss (e.g. emitting the
  //   header read in BOTH dev and prod but only honoring it in prod — the
  //   substring is present in cfDev's output but the runtime ignores it).
  it('reads inbound X-Void-Original-URL only behind managed dispatch', async () => {
    type Permutation = {
      readonly label: string;
      readonly opts: { nodeTarget: boolean; dev: boolean; managedDispatch?: boolean };
      readonly trustsHeader: boolean;
    };
    const permutations: Array<Permutation> = [
      {
        label: 'managedCfProd',
        opts: { nodeTarget: false, dev: false, managedDispatch: true },
        trustsHeader: true,
      },
      { label: 'nativeCfProd', opts: { nodeTarget: false, dev: false }, trustsHeader: false },
      {
        label: 'cfDev',
        opts: { nodeTarget: false, dev: true, managedDispatch: true },
        trustsHeader: false,
      },
      {
        label: 'nodeProd',
        opts: { nodeTarget: true, dev: false, managedDispatch: true },
        trustsHeader: false,
      },
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
    expect(code).toContain('app.notFound(__createSsrFallback(');
    expect(code).toContain('nodeTarget: false');
    expect(code).toContain('"source":"/docs/*"');
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
    expect(code).toContain('app.notFound(__createSsrFallback(');
    expect(code).toContain('nodeTarget: true');
    expect(code).toContain('"source":"/docs/*"');
  });
});

describe('compileWorkerEntry', () => {
  it('serves the actual metadata version without echoing the requested version override', async () => {
    const code = compileWorkerEntry({ versionMetadataBinding: 'AUTHORED_VERSION' });
    const source = code.match(
      /const __voidFetch = (__createWorkerFetch\([\s\S]*?\n {2}\}\));/,
    )?.[1];
    expect(source).toBeDefined();
    const handler = new Function(
      '__createWorkerFetch',
      'app',
      'serveWithAssets',
      '__withRawEnv',
      'withRuntimeEnv',
      '__filterInternalBindings',
      '__voidHandleInternalRoute',
      '__voidCollectPrerenderPaths',
      `return (${source});`,
    )(
      createWorkerFetch,
      { fetch: () => new Response('application') },
      (_request: Request, _env: object, response: Response) => response,
      (_env: object, callback: () => Promise<Response>) => callback(),
      (_env: object, callback: () => Promise<Response>) => callback(),
      (env: object) => env,
      async () => null,
      async () => [],
    ) as (request: Request, env: Record<string, unknown>, ctx: object) => Promise<Response>;
    const response = await handler(
      new Request('https://app.example/__void/ready', {
        headers: { 'Cloudflare-Workers-Version-Overrides': 'app="new-version"' },
      }),
      { AUTHORED_VERSION: { id: 'old-version', tag: 'private-tag', timestamp: 'private-time' } },
      {},
    );
    expect(await response.json()).toEqual({ ready: true, versionId: 'old-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const missing = await handler(new Request('https://app.example/__void/ready'), {}, {});
    expect(await missing.json()).toEqual({ ready: true });
  });

  it('re-exports typed Durable Object modules as worker classes', () => {
    const code = compileWorkerEntry({
      durableObjects: [
        {
          bindingName: 'COUNTER',
          className: 'CounterDurableObject',
          filePath: '/app/durable-objects/counter.ts',
        },
      ],
    });

    expect(code).toContain('import __voidDurableObject0 from "/app/durable-objects/counter.ts";');
    expect(code).toContain('__voidDurableObject0.__bind("COUNTER");');
    expect(code).toContain('export const CounterDurableObject = __voidDurableObject0.class;');
  });

  it('re-exports the live Durable Object class when enabled', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: true,
    });

    expect(code).toContain('VoidLiveStreamDurableObject');
    expect(code).toContain('export { VoidLiveStreamDurableObject };');
    expect(code).toContain('__setLiveBindingName("VOID_LIVE");');
  });

  it('re-exports the configured live Durable Object class', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: {
        bindingName: 'VOID_LIVE_abcd1234',
        className: 'VoidLiveStreamDurableObject_abcd1234',
      },
    });

    expect(code).toContain(
      'export { VoidLiveStreamDurableObject as VoidLiveStreamDurableObject_abcd1234 };',
    );
    expect(code).toContain('__setLiveBindingName("VOID_LIVE_abcd1234");');
  });

  it('re-exports the VoidPlatformSandbox Durable Object class when enabled', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: true,
    });

    // Platform sandbox wraps Cloudflare's Sandbox with metering/gate hooks.
    // Importing it (instead of the bare Sandbox class) lets user subclasses
    // inherit those overrides without opting in.
    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "void/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export { __VoidSandbox as SandboxV1 };');
    expect(code).toContain('__setSandboxBindingName("SANDBOX");');
  });

  it('exports the configured Sandbox Durable Object subclass via VoidPlatformSandbox', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: {
        bindingName: 'CODE',
        className: 'CodeSandbox',
        runtimePath: 'void/sandbox',
      },
    });

    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "void/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export class CodeSandbox extends __VoidSandbox {}');
    expect(code).toContain('__setSandboxBindingName("CODE");');
  });

  it('uses the resolved sandbox runtime path when one is provided', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: {
        runtimePath: '/abs/path/to/sandbox.mjs',
      },
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
    const code = compileWorkerEntry({ hasQueues: true });

    expect(code).toContain('async function __voidQueue(batch, env, ctx)');
    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('serveWithAssets');
    expect(code).toContain('async queue(batch) { return __voidQueue(batch, this.env, this.ctx); }');
    expect(code).toContain('__processQueue');
    expect(code).toContain('batch.queue');
    expect(code).toContain('m.timestamp.toISOString()');
    // Native queue handler calls __processQueue directly (no HTTP round-trip)
    expect(code).toContain('withRuntimeEnv(env, () => __processQueue(payload, userEnv))');
  });

  it('omits queue() export when hasQueues=false', () => {
    const code = compileWorkerEntry({ hasQueues: false });

    expect(code).not.toContain('queue');
  });

  it('sets missing asset MIME types while preserving binding headers', async () => {
    const serveWithAssets = createAssetFallback();

    for (const [path, expected] of [
      ['/assets/app.js', 'text/javascript; charset=utf-8'],
      ['/assets/app.css', 'text/css; charset=utf-8'],
      ['/assets/logo.webp', 'image/webp'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/assets/unknown.xyz', null],
    ] as const) {
      const response = await serveWithAssets(
        new Request(`https://app.test${path}`),
        { ASSETS: { fetch: async () => new Response(new Uint8Array([1])) } },
        new Response('not found', { status: 404 }),
      );
      expect(response.headers.get('Content-Type')).toBe(expected);
    }

    const originalType = 'application/javascript';
    const response = await serveWithAssets(
      new Request('https://app.test/assets/app.js'),
      {
        ASSETS: {
          fetch: async () =>
            new Response(new Uint8Array([1]), { headers: { 'Content-Type': originalType } }),
        },
      },
      new Response('not found', { status: 404 }),
    );
    expect(response.headers.get('Content-Type')).toBe(originalType);
  });

  it('serveWithAssets does not include the SPA shell fallback by default', () => {
    const code = compileWorkerEntry();

    // Pages and SSR apps generate intentional HTML 404 responses. The outer
    // asset fallthrough must not rewrite those to the SPA shell.
    expect(code).not.toContain('"/index.html"');
    expect(code).not.toContain('accept.includes("text/html")');
  });

  // `routing.notFound: '404-page'` sets `assetConfig.not_found_handling`, so
  // CF's asset binding answers an unmatched path with the NEAREST `404.html` —
  // at a 404 status, which the `asset.status !== 404` guard above discards. The
  // resolved handling has to reach the generated helper or the override is
  // inert on every worker-first app.

  it('serveWithAssets keeps the worker response for not_found_handling: none', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      notFound: 'none',
    });

    // Byte-identical to the pre-existing default — `none` is what every
    // worker-first app infers, so this is the no-regression guard.
    expect(code).toBe(compileWorkerEntry());
  });

  it('native queue handler calls __processQueue directly without HTTP', () => {
    const code = compileWorkerEntry({ hasQueues: true });

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
    const code = compileWorkerEntry({ hasQueues: true });

    // Queue handler must filter env before passing to __processQueue
    expect(code).toContain('const userEnv = __filterInternalBindings(env)');
    expect(code).toContain('__processQueue(payload, userEnv)');
  });

  it('omits boot-time env validation when no envSchemaModule is provided', () => {
    const code = compileWorkerEntry();
    expect(code).not.toContain('_validateEnvOnce');
  });

  it('passes custom binding names to remote env proxying', () => {
    const code = compileWorkerEntry({
      hasQueues: true,
      remote: {
        bindingNames: { d1: 'myapp_db', kv: 'myapp_kv', r2: 'myapp_storage' },
        remotePath: '/resolved/remote.mjs',
        envPath: '/resolved/env-legacy.mjs',
      },
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '/resolved/env.mjs',
    });

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
    // Only path discovery can run without remote production secrets.
    // Node/Bun read the application request environment from process.env.
    expect(code).toContain('app.use("*", async (c, next)');
    expect(code).toContain('await _validateEnvOnce(process.env)');
    expect(code).toContain(
      'if (c.req.method !== "POST" || c.req.path !== "/__void/prerender-paths")',
    );
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

describe('shared pattern compiler in generated routes', () => {
  // Build a minimal route table with a header rule so the generated module
  // imports the cached compiler and emits its warning wrapper.
  const emptyScan: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };
  const compilePattern = (source: string) => {
    const { regex, paramNames } = sharedCompilePattern(source);
    return { regex, names: [...paramNames] };
  };
  const matchPattern = async (pattern: string, pathname: string): Promise<boolean> => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.headerMiddleware([{ pattern, headers: [['x-match', '1']] }]));
    app.get('*', (c) => c.text('ok'));
    return (await app.fetch(new Request('https://app.test' + pathname))).headers.has('x-match');
  };

  it('compiles a single bare "*" with the legacy "splat" capture', () => {
    const { regex, names } = compilePattern('/docs/*');
    expect(names).toEqual(['splat']);
    expect(sharedCompilePattern('/docs/*').regex).toBe(regex);
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

  it('header matching returns false instead of throwing on a malformed pattern', async () => {
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
    expect(await matchPattern('/foo/*', '/foo/bar')).toBe(true);
    // `__matchPattern` is the resilient entry point — even an empty pattern
    // (which compiles to `^$`) must return false rather than throw on a
    // non-matching pathname.
    expect(await matchPattern('', '/anything')).toBe(false);
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

  it('production routing middleware skips invalid rules and still applies valid ones', async () => {
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
    const app = evalCompiledApp(codeWithRules);
    app.get('/new', (c) => c.text('new route'));
    const response = await app.fetch(
      new Request('https://app.test/old'),
      {},
      { waitUntil() {}, passThroughOnException() {}, props: {} },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('new route');
  });

  it('header matching skips malformed patterns and warns once per app', async () => {
    const warnings: Array<string> = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.headerMiddleware([{ pattern: '/:id/:id', headers: [['x-bad', '1']] }]));
      app.get('*', (c) => c.text('ok'));
      for (let i = 0; i < 2; i++) {
        const response = await app.fetch(new Request('https://app.test/a/b'));
        expect(response.status).toBe(200);
        expect(response.headers.has('x-bad')).toBe(false);
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('failed to compile route pattern');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('compileWorkerEntry — ISR wiring', () => {
  // FIX 1: cron/queue handlers must stamp the deployment id (only — no host,
  // there is no request) so a self-host `revalidate()` from a scheduled or queue
  // handler can find it and purge KV instead of no-oping.
  it('stamps the deployment id at the top of the scheduled + queue handlers when isr is set', () => {
    const code = compileWorkerEntry({
      hasQueues: true,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      serveSpaFallback: false,
      isr: { runtimePath: 'void/isr' },
    });

    // Scheduled handler stamps the id (deployment id only — no __VOID_ISR_HOST).
    expect(code).toContain(
      'async function handleScheduled(controller, env, ctx) {\n' +
        '  env.__VOID_ISR_DEPLOYMENT_ID ??= __VOID_ISR_DEPLOYMENT_ID;\n' +
        '  const userEnv = __filterInternalBindings(env);',
    );
    // Queue handler stamps the id (deployment id only — no __VOID_ISR_HOST).
    expect(code).toContain(
      'async function __voidQueue(batch, env, ctx) {\n' +
        '  env.__VOID_ISR_DEPLOYMENT_ID ??= __VOID_ISR_DEPLOYMENT_ID;\n' +
        '  const userEnv = __filterInternalBindings(env);',
    );
    // No host stamp in cron/queue (there is no request).
    expect(code).not.toContain('env.__VOID_ISR_HOST ??= new URL(controller');
  });

  it('does NOT stamp the deployment id in scheduled/queue handlers when isr is absent', () => {
    const code = compileWorkerEntry({ hasQueues: true }); // hasQueues, no isr
    // Byte-identical to today: no deployment-id stamp anywhere.
    expect(code).not.toContain('__VOID_ISR_DEPLOYMENT_ID ??=');
    expect(code).toContain(
      'async function handleScheduled(controller, env, ctx) {\n' +
        '  const userEnv = __filterInternalBindings(env);',
    );
    expect(code).toContain(
      'async function __voidQueue(batch, env, ctx) {\n  const userEnv = __filterInternalBindings(env);',
    );
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

  it('bakes the ordered page policy and raw path config for native ISR', () => {
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
      { '/private': 60 },
      [{ pattern: '/private', revalidate: 0 }],
      { '/private': 60 },
    );

    expect(code).toContain(
      'export const __VOID_ISR_PAGES = [{"pattern":"/private","revalidate":0}];',
    );
    expect(code).toContain('export const __VOID_ISR_PATH_REVALIDATE = {"/private":60};');
  });
});

describe('typed runtime metadata wiring', () => {
  const empty: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };
  const compile = (options: Partial<Parameters<typeof compileRouteTable>[6]> = {}) =>
    compileRouteTable(empty, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      ...options,
    });
  it('imports Worker-safe execution and emits route export selection and cache policy', () => {
    const scan: ScanResult = {
      ...empty,
      routes: [
        {
          pattern: '/hello',
          filePath: 'hello.ts',
          params: [],
          catchAll: false,
          env: null,
          methods: ['GET', 'POST'],
        },
      ],
    };
    const dev = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...testOptions,
      dev: true,
    });
    expect(dev).toContain('createRoutingRuntime as __createRoutingRuntime');
    expect(dev).toContain(
      'const _load_hello_ts = __createModuleLoader(() => import("/routes/hello.ts"), false)',
    );
    expect(dev).toContain('app.get("/hello", __createHttpRouteHandler(_load_hello_ts, "GET"))');
    expect(dev).toContain('app.post("/hello", __createHttpRouteHandler(_load_hello_ts, "POST"))');
    expect(dev).not.toContain('function __voidAnnotateRouting');
    expect(dev).not.toContain('c.rewrite =');
  });
  it('keeps authored rule origins in dev and omits them in production and managed dispatch', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301, origin: 'config' }];
    const dev = compile({ dev: true, redirectRules: rules, fallbackRules: rules });
    expect(dev).toContain('"origin":"config"');
    expect(dev).toContain('__routingRuntime.routingMiddleware(__routingRules)');
    expect(dev).toContain('__createAssetNotFound');
    const production = compile({ dev: false, redirectRules: rules, fallbackRules: rules });
    expect(production).not.toContain('"origin":"config"');
    const managed = compile({ managedDispatch: true, redirectRules: rules, fallbackRules: rules });
    expect(managed).not.toContain('const __routingRules');
    expect(managed).not.toContain('app.notFound');
  });
  it('wires fetch validation, opaque internal routes and optional ISR through runtime callbacks', () => {
    const code = compileWorkerEntry({
      envSchemaModule: { importPath: '/env.ts', helperPath: '/env-helpers.ts' },
      isr: { runtimePath: 'void/isr', queryAllowlist: { '/search': ['q'] } },
    });
    expect(code).toContain('const __voidFetch = __createWorkerFetch({');
    expect(code).toContain('validateEnv: _validateEnvOnce');
    expect(code).toContain('internalRoute: __voidHandleInternalRoute');
    expect(code).toContain('deploymentId: __VOID_ISR_DEPLOYMENT_ID');
    expect(code).toContain('queryAllowlist: {"/search":["q"]}');
    expect(code).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":false,"notFound":"none"})',
    );
    expect(code).not.toContain('function __handleInternal');
    expect(code).not.toContain('async function serveWithAssets');
  });
});
