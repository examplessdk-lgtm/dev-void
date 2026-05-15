import { describe, expect, it } from 'vite-plus/test';
import {
  appendInlineQuery,
  DEV_CSS_ASSET_ENDPOINT,
  DEV_CSS_ASSET_MODULE_ID,
  extractInlineCss,
  extractViteDevId,
  normalizeDevCssUrl,
  pagesDevCssAssetsPlugin,
} from '../../src/pages/dev-css-assets.ts';

type Middleware = (
  req: {
    headers: Record<string, string | undefined>;
    method?: string;
    url?: string;
  },
  res: {
    end(chunk?: string): void;
    setHeader(name: string, value: string): void;
    statusCode: number;
  },
  next: () => void,
) => void | Promise<void>;

function createMiddleware(): Middleware {
  let middleware: Middleware | undefined;
  const [plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({
    config: { logger: { warn() {}, warnOnce() {} } },
    environments: { client: {} },
    middlewares: {
      use(fn: Middleware) {
        middleware = fn;
      },
    },
    watcher: { on() {} },
  });
  if (!middleware) {
    throw new Error('Expected middleware to be registered.');
  }
  return middleware;
}

function createConfiguredPlugin(address = '::', resolvedLocalUrl?: string) {
  const [plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({
    config: {
      logger: { warn() {}, warnOnce() {} },
      server: {},
    },
    environments: { client: {} },
    httpServer: {
      address: () => ({ address, port: 6199 }),
    },
    middlewares: {
      use() {},
    },
    resolvedUrls: resolvedLocalUrl ? { local: [resolvedLocalUrl] } : undefined,
    watcher: { on() {} },
  });
  return plugin;
}

function loadDevAssetModule(plugin: ReturnType<typeof createConfiguredPlugin>): string {
  const load = plugin.load as (this: unknown, id: string) => string;
  return load.call({}, `\0${DEV_CSS_ASSET_MODULE_ID}`);
}

function createResponse() {
  return {
    body: '',
    headers: new Map<string, string>(),
    statusCode: 200,
    end(chunk = '') {
      this.body += chunk;
    },
    setHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
    },
  };
}

async function postCollector(
  middleware: Middleware,
  body: unknown,
): Promise<ReturnType<typeof createResponse>> {
  const response = createResponse();
  const payload = Buffer.from(JSON.stringify(body));
  await middleware(
    {
      async *[Symbol.asyncIterator]() {
        yield payload;
      },
      headers: {
        authorization: 'Bearer secret',
        'x-void-dev-asset-request': 'pages-css',
      },
      method: 'POST',
      url: DEV_CSS_ASSET_ENDPOINT,
    } as never,
    response,
    () => {
      throw new Error('Unexpected next() call.');
    },
  );
  return response;
}

describe('pages dev CSS assets', () => {
  it('preserves existing Vite client URLs during normalization', () => {
    expect(normalizeDevCssUrl('/@fs/Users/me/app/src/page.css', '/Users/me/app')).toBe(
      '/@fs/Users/me/app/src/page.css',
    );
    expect(normalizeDevCssUrl('/src/page.css?used', '/Users/me/app')).toBe('/src/page.css?used');
    expect(normalizeDevCssUrl('/pages/index.vue', '/Users/me/app')).toBe('/pages/index.vue');
    expect(normalizeDevCssUrl('/@vite/client', '/Users/me/app')).toBe('/@vite/client');
    expect(normalizeDevCssUrl('/@react-refresh', '/Users/me/app')).toBe('/@react-refresh');
  });

  it('normalizes filesystem ids under the project root to Vite root URLs', () => {
    expect(normalizeDevCssUrl('/Users/me/app/src/page.css', '/Users/me/app')).toBe('/src/page.css');
    expect(normalizeDevCssUrl('/Users/me/shared/page.css', '/Users/me/app')).toBe(
      '/@fs/Users/me/shared/page.css',
    );
  });

  it('appends inline without dropping existing query or hash', () => {
    expect(appendInlineQuery('/src/page.vue?vue&type=style&index=0.css#x')).toBe(
      '/src/page.vue?vue=&type=style&index=0.css&inline=#x',
    );
  });

  it('does not duplicate inline query', () => {
    expect(appendInlineQuery('/src/app.css?inline')).toBe('/src/app.css?inline');
  });

  it('extracts Vite inline CSS default exports', () => {
    expect(extractInlineCss('export default ".button{color:red}"')).toBe('.button{color:red}');
  });

  it('extracts Vite __vite__css assignments', () => {
    expect(
      extractInlineCss('const __vite__css = "body{margin:0}"\nexport default __vite__css'),
    ).toBe('body{margin:0}');
  });

  it('rejects arbitrary inline CSS JavaScript', () => {
    expect(() => extractInlineCss('export default getCss()')).toThrow(/Unable to extract/);
  });

  it('extracts the Vite dev style id from CSS module transforms', () => {
    expect(
      extractViteDevId(
        'const __vite__id = "/Users/me/app/src/page.css"\nconst __vite__css = ".x{}"',
      ),
    ).toBe('/Users/me/app/src/page.css');
  });

  it('rejects the token-bearing virtual module in the client environment', () => {
    const [plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
    const resolveId = plugin.resolveId as (
      this: unknown,
      source: string,
      importer?: string,
      options?: unknown,
    ) => unknown;

    expect(() =>
      resolveId.call(
        { environment: { name: 'client' } } as never,
        DEV_CSS_ASSET_MODULE_ID,
        undefined,
        {} as never,
      ),
    ).toThrow('server-only');
  });

  it('blocks direct client requests for the token-bearing virtual module', async () => {
    const middleware = createMiddleware();
    const response = createResponse();

    await middleware(
      { headers: {}, method: 'GET', url: `/@id/__x00__${DEV_CSS_ASSET_MODULE_ID}` },
      response,
      () => {
        throw new Error('Unexpected next() call.');
      },
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('Not Found');
  });

  it('rejects dev asset endpoint requests with an invalid bearer token', async () => {
    const middleware = createMiddleware();
    const response = createResponse();

    await middleware(
      {
        headers: {
          authorization: 'Bearer wrong',
          'x-void-dev-asset-request': 'pages-css',
        },
        method: 'POST',
        url: DEV_CSS_ASSET_ENDPOINT,
      },
      response,
      () => {
        throw new Error('Unexpected next() call.');
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('Unauthorized');
  });

  it('generates the worker bridge with the internal Vite origin, not request.url', () => {
    const plugin = createConfiguredPlugin();
    const code = loadDevAssetModule(plugin);

    expect(code).toContain('const INTERNAL_ORIGIN = "http://127.0.0.1:6199"');
    expect(code).toContain('new URL(ENDPOINT, INTERNAL_ORIGIN)');
    expect(code).toContain('env?.ASSETS');
    expect(code).toContain('new URL(ENDPOINT, request.url)');
  });

  it('brackets IPv6 internal Vite origins', () => {
    const plugin = createConfiguredPlugin('::1');
    const code = loadDevAssetModule(plugin);

    expect(code).toContain('const INTERNAL_ORIGIN = "http://[::1]:6199"');
    expect(() => new URL('/__void/dev/pages-css', 'http://[::1]:6199')).not.toThrow();
  });

  it('prefers concrete bound IPv6 loopback over ambiguous localhost display URLs', () => {
    const plugin = createConfiguredPlugin('::1', 'http://localhost:6199/');
    const code = loadDevAssetModule(plugin);

    expect(code).toContain('const INTERNAL_ORIGIN = "http://[::1]:6199"');
    expect(code).not.toContain('const INTERNAL_ORIGIN = "http://localhost:6199"');
  });

  it('collects CSS through ordered static edges and ignores dynamic imports', async () => {
    let middleware: Middleware | undefined;
    const nodes = new Map([
      ['/src/page.ts', { id: '/root/src/page.ts', url: '/src/page.ts' }],
      ['/src/component.ts', { id: '/root/src/component.ts', url: '/src/component.ts' }],
      ['/src/static.css', { id: '/root/src/static.css', url: '/src/static.css' }],
      ['/src/dynamic.css', { id: '/root/src/dynamic.css', url: '/src/dynamic.css' }],
    ]);
    const transformCalls: Array<string> = [];
    const [assetPlugin, edgePlugin] = pagesDevCssAssetsPlugin('/root', 'secret');
    const configureServer = assetPlugin.configureServer as (server: unknown) => void;
    configureServer({
      config: { logger: { warn() {}, warnOnce() {} }, server: {} },
      environments: {
        client: {
          moduleGraph: {
            getModuleByUrl: async (url: string) => nodes.get(url),
          },
          transformRequest: async (url: string) => {
            transformCalls.push(url);
            if (url === '/src/static.css') {
              return {
                code: 'const __vite__id = "/root/src/static.css"\nconst __vite__css = ".static{}"',
              };
            }
            if (url === '/src/static.css?inline=') {
              return { code: 'export default ".static{}"' };
            }
            if (url === '/src/dynamic.css') {
              return {
                code: 'const __vite__id = "/root/src/dynamic.css"\nconst __vite__css = ".dynamic{}"',
              };
            }
            if (url === '/src/dynamic.css?inline=') {
              return { code: 'export default ".dynamic{}"' };
            }
            return { code: '' };
          },
        },
      },
      middlewares: {
        use(fn: Middleware) {
          middleware = fn;
        },
      },
      watcher: { on() {} },
    });
    const transform = edgePlugin.transform as (
      this: unknown,
      code: string,
      id: string,
    ) => Promise<void>;
    const context = {
      environment: { name: 'client' },
      resolve: async (specifier: string) => {
        if (specifier === './component.ts') {
          return { id: '/root/src/component.ts' };
        }
        if (specifier === './static.css') {
          return { id: '/root/src/static.css' };
        }
        if (specifier === './dynamic.css') {
          return { id: '/root/src/dynamic.css' };
        }
      },
    };

    await transform.call(
      context,
      'import "./component.ts"; import("./dynamic.css");',
      '/root/src/page.ts',
    );
    await transform.call(context, 'import "./static.css";', '/root/src/component.ts');

    const response = await postCollector(middleware!, { rootPhases: [['/src/page.ts']] });
    const body = JSON.parse(response.body);

    expect(body.assets).toEqual([
      { url: '/src/static.css', id: '/root/src/static.css', css: '.static{}' },
    ]);
    expect(transformCalls).not.toContain('/src/dynamic.css');
  });

  it('unwraps virtual /@id roots before transforming them', async () => {
    let middleware: Middleware | undefined;
    const nodes = new Map([
      [
        '/@id/__x00__virtual:void-pages-client',
        { id: '\0virtual:void-pages-client', url: '/@id/__x00__virtual:void-pages-client' },
      ],
      ['/src/page.css', { id: '/root/src/page.css', url: '/src/page.css' }],
    ]);
    const transformCalls: Array<string> = [];
    const [assetPlugin, edgePlugin] = pagesDevCssAssetsPlugin('/root', 'secret');
    const configureServer = assetPlugin.configureServer as (server: unknown) => void;
    configureServer({
      config: { logger: { warn() {}, warnOnce() {} }, server: {} },
      environments: {
        client: {
          moduleGraph: {
            getModuleByUrl: async (url: string) => nodes.get(url),
          },
          transformRequest: async (url: string) => {
            transformCalls.push(url);
            if (url === '/src/page.css?inline=') {
              return { code: 'export default ".page{}"' };
            }
            return { code: '' };
          },
        },
      },
      middlewares: {
        use(fn: Middleware) {
          middleware = fn;
        },
      },
      watcher: { on() {} },
    });
    const transform = edgePlugin.transform as (
      this: unknown,
      code: string,
      id: string,
    ) => Promise<void>;
    await transform.call(
      {
        environment: { name: 'client' },
        resolve: async () => ({ id: '/root/src/page.css' }),
      },
      'import "./page.css";',
      '\0virtual:void-pages-client',
    );

    const response = await postCollector(middleware!, {
      rootPhases: [['/@id/__x00__virtual:void-pages-client']],
    });
    const body = JSON.parse(response.body);

    expect(transformCalls[0]).toBe('\0virtual:void-pages-client');
    expect(body.assets).toEqual([
      { url: '/src/page.css', id: '/root/src/page.css', css: '.page{}' },
    ]);
  });

  it('skips optimized deps and continues collecting route CSS', async () => {
    let middleware: Middleware | undefined;
    const nodes = new Map([
      ['/src/page.ts', { id: '/root/src/page.ts', url: '/src/page.ts' }],
      ['/src/page.css', { id: '/root/src/page.css', url: '/src/page.css' }],
    ]);
    const transformCalls: Array<string> = [];
    const [assetPlugin, edgePlugin] = pagesDevCssAssetsPlugin('/root', 'secret');
    const configureServer = assetPlugin.configureServer as (server: unknown) => void;
    configureServer({
      config: { logger: { warn() {}, warnOnce() {} }, server: {} },
      environments: {
        client: {
          moduleGraph: {
            getModuleByUrl: async (url: string) => nodes.get(url),
          },
          transformRequest: async (url: string) => {
            transformCalls.push(url);
            if (url === '/src/page.css?inline=') {
              return { code: 'export default ".page{}"' };
            }
            return { code: '' };
          },
        },
      },
      middlewares: {
        use(fn: Middleware) {
          middleware = fn;
        },
      },
      watcher: { on() {} },
    });
    const transform = edgePlugin.transform as (
      this: unknown,
      code: string,
      id: string,
    ) => Promise<void>;
    await transform.call(
      {
        environment: { name: 'client' },
        resolve: async (specifier: string) => {
          if (specifier === './page.css') {
            return { id: '/root/src/page.css' };
          }
          return { id: '/node_modules/.vite/deps/react.js?v=123' };
        },
      },
      'import "react"; import "./page.css";',
      '/root/src/page.ts',
    );

    const response = await postCollector(middleware!, { rootPhases: [['/src/page.ts']] });
    const body = JSON.parse(response.body);

    expect(transformCalls).not.toContain('/node_modules/.vite/deps/react.js?v=123');
    expect(body.assets).toEqual([
      { url: '/src/page.css', id: '/root/src/page.css', css: '.page{}' },
    ]);
  });
});
