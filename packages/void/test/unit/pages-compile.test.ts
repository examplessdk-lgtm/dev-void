import { describe, expect, it } from 'vitest';
import { compileRouteTable, type PagesCompileOptions } from '../../src/router/compile';
import type { ScanResult } from '../../src/router/scan';

const testOptions = {
  honoPath: '/resolved/hono/index.mjs',
  responsePath: '/resolved/void/runtime/response.mjs',
  handlerPath: '/resolved/void/runtime/handler.mjs',
  runtimeEnvPath: '/resolved/void/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  reactRefresh: false,
  dev: true,
  auth: null,
};

const pagesOptions: PagesCompileOptions = {
  pagesDir: '/project/pages',
  pagesDirRelative: 'pages',
  protocolPath: '/resolved/void/pages/protocol.mjs',
  headPath: '/resolved/void/pages/head.mjs',
  clientEntryId: 'virtual:void-pages-client',
};

function makeScan(pages: ScanResult['pages']): ScanResult {
  return {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages,
  };
}

describe('compileRouteTable with pages', () => {
  it('imports handlePageGet and handlePageMutation from protocol', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain(
      `import { handlePageGet, handlePageMutation } from "/resolved/void/pages/protocol.mjs"`,
    );
  });

  it('imports renderPage from virtual module', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain(`import { renderPage } from "virtual:void-pages-renderer"`);
  });

  it('registers GET handler for page without server module', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/about',
          params: [],
          catchAll: false,
          componentPath: 'about.vue',
          serverPath: null,
          methods: [],
          componentId: 'about',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('app.get("/about"');
    expect(code).toContain(
      'handlePageGet(undefined, undefined, c, "about", renderPage, getPagesAssetTags',
    );
  });

  it('generates lazy loader for companion .server.ts', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/users',
          params: [],
          catchAll: false,
          componentPath: 'users/index.vue',
          serverPath: 'users/index.server.ts',
          methods: ['loader', 'action'],
          componentId: 'users',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    // Lazy loader
    expect(code).toContain('let _pmod_users;');
    expect(code).toContain('async function _pload_users()');
    expect(code).toContain('import("/project/pages/users/index.server.ts")');

    // GET handler uses loader
    expect(code).toContain('app.get("/users"');
    expect(code).toContain('mod.loader, mod.head, c');

    // Action mutation handler (POST, PUT, PATCH, DELETE)
    expect(code).toContain('app.on(["POST", "PUT", "PATCH", "DELETE"], "/users"');
    expect(code).toContain('const handler = mod.action;');
    expect(code).toContain('handlePageMutation(handler, mod.loader, mod.head');
  });

  it('generates catch-all for SPA navigation', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('app.notFound(');
    // Should skip API routes
    expect(code).toContain('path.startsWith("/api/")');
    // Dot-prefixed segments (/.well-known, /.env, /.git) → 404
    expect(code).toContain('path.includes("/.")');
    // Last segment with dot (style.css, wp-login.php) → 404
    expect(code).toContain('lastSeg.includes(".")');
    // Trailing slash redirect
    expect(code).toContain('path.endsWith("/")');
    // notFound fallback: try render index as 404, catch errors
    expect(code).toContain('try {');
    expect(code).toContain('{ status: 404, headers: res.headers }');
    expect(code).toContain('} catch {');
    expect(code).toContain('serveCustomErrorPage(c, 404, "Not Found")');
  });

  it('embeds the default self-contained error page helper and dev overlay support', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('place-items: center;');
    expect(code).toContain('border-radius: 32px;');
    expect(code).toContain('corner-shape: squircle;');
    expect(code).toContain('function __voidRenderDevErrorOverlay(request, status, title, error) {');
    expect(code).toContain('function __voidInjectDevErrorOverlay(html, overlay) {');
    expect(code).toContain('function __voidGetStackFrames(error) {');
    expect(code).toContain('function __voidEditorHref(value, line, column) {');
    expect(code).toContain('const __VOID_DEV = true;');
    expect(code).toContain('const __VOID_PROJECT_ROOT =');
    expect(code).toContain('const __VOID_HOME_DIR =');
    expect(code).toContain('__VOID_DEV && status === 500 && error');
    expect(code).toContain('data-void-error-close');
    expect(code).toContain('data-void-error-toggle');
    expect(code).toContain('is-minimized');
    expect(code).toContain('Minimize error overlay');
    expect(code).toContain('vscode://file/');
    expect(code).toContain(
      'return __voidCreateErrorResponse(c.req.raw, status, fallbackText, error);',
    );
    expect(code).toContain(
      'if (err && typeof err === "object" && "getResponse" in err) return err.getResponse();',
    );
    expect(code).toContain('return serveCustomErrorPage(c, 500, "Internal Server Error", err);');
  });

  it('does not generate page code when pages is null', () => {
    const scan = makeScan({ pages: [], layouts: [], namedLayouts: [] });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
    );

    expect(code).not.toContain('handlePageGet');
    expect(code).not.toContain('renderPage');
  });

  it('does not generate page code when pages array is empty', () => {
    const scan = makeScan({ pages: [], layouts: [], namedLayouts: [] });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).not.toContain('handlePageGet');
    expect(code).not.toContain('renderPage');
  });

  it('island page uses renderIslandPage and getIslandsAssetTags', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.island.tsx',
          serverPath: null,
          methods: [],
          componentId: 'index',
          island: true,
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const islandPagesOptions: PagesCompileOptions = {
      ...pagesOptions,
      islandClientEntryId: 'virtual:void-islands-client',
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      islandPagesOptions,
    );

    expect(code).toContain(`import { renderIslandPage } from "virtual:void-islands-renderer"`);
    expect(code).toContain('renderIslandPage');
    expect(code).toContain('getIslandsAssetTags');
    expect(code).toContain(', true)');
  });

  it('non-island page does not use island renderer', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/dash',
          params: [],
          catchAll: false,
          componentPath: 'dash.tsx',
          serverPath: null,
          methods: [],
          componentId: 'dash',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('renderPage');
    expect(code).not.toContain('renderIslandPage');
    expect(code).not.toContain('getIslandsAssetTags');
  });

  it('mixed island and non-island pages import both renderers', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.island.tsx',
          serverPath: null,
          methods: [],
          componentId: 'index',
          island: true,
        },
        {
          pattern: '/dash',
          params: [],
          catchAll: false,
          componentPath: 'dash.tsx',
          serverPath: null,
          methods: [],
          componentId: 'dash',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const islandPagesOptions: PagesCompileOptions = {
      ...pagesOptions,
      islandClientEntryId: 'virtual:void-islands-client',
    };

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      islandPagesOptions,
    );

    expect(code).toContain(`import { renderPage } from "virtual:void-pages-renderer"`);
    expect(code).toContain(`import { renderIslandPage } from "virtual:void-islands-renderer"`);
  });

  it('generates asset tags function for production manifest', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('getPagesAssetTags');
    expect(code).toContain('loadPagesManifest');
    expect(code).toContain('getPagesDevClientTags');
    expect(code).toContain('collectRouteCss');
    expect(code).toContain('PAGE_CSS_KEYS');
  });

  it('injects fallback rules into the pages notFound body on default target dev', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const fallbackRules = [
      {
        source: '/docs/*',
        destination: '/docs.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        nodeTarget: false,
        dev: true,
        fallbackRules,
      },
      pagesOptions,
    );

    // Fallback rules live inside the pages notFound body between the
    // asset-miss check and the SPA fallback, not in a standalone notFound.
    expect(code).toContain('const __fallbackRules =');
    expect(code).toContain('if (assetRes.status !== 404) return assetRes;');
    // Pages mode owns the notFound — no duplicate standalone hook that
    // would override it.
    expect(code.match(/app\.notFound\(async \(c\) => \{/g)?.length).toBe(1);
  });

  it('omits fallback rules on default target prod (pages notFound stays pure)', () => {
    const scan = makeScan({
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.vue',
          serverPath: null,
          methods: [],
          componentId: 'index',
        },
      ],
      layouts: [],
      namedLayouts: [],
    });

    const fallbackRules = [
      {
        source: '/docs/*',
        destination: '/docs.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];

    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        nodeTarget: false,
        dev: false,
        fallbackRules,
      },
      pagesOptions,
    );

    expect(code).not.toContain('const __fallbackRules =');
  });
});
