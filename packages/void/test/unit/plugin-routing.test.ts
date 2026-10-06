import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { routingPlugin } from '../../src/plugin-routing.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-routing-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'routes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function createBareTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-routing-'));
  tempDirs.push(root);
  return root;
}

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

describe('routingPlugin', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables the worker SPA fallback for websocket-only routes', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'routes', 'notifications.ws.ts'),
      'export default defineWebSocket({});\n',
    );

    const plugin = routingPlugin(root, { isAuthEnabled: () => false });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'build',
      mode: 'production',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);

    await buildStart.call({} as never);

    const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
    expect(entry).toContain('app, assets: serveWithAssets');
    expect(entry).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":true,"notFound":"none"});',
    );
  });

  it('does not enable the worker SPA fallback for auth-only apps', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ auth: { providers: ['email'] } }));

    const plugin = routingPlugin(root, { isAuthEnabled: () => true });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'build',
      mode: 'production',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);

    await buildStart.call({} as never);

    const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
    expect(entry).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":false,"notFound":"single-page-application"});',
    );
  });

  it('bakes explicit page opt-outs into the native ISR policy', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', 'private.tsx'), 'export default function Page() {}\n');
    writeFileSync(join(root, 'pages', 'private.server.ts'), 'export const revalidate = 0;\n');
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ routing: { revalidate: { '/private': 60 } } }),
    );

    const savedProjectId = process.env.VOID_DEPLOY_PROJECT_ID;
    delete process.env.VOID_DEPLOY_PROJECT_ID;
    try {
      const plugin = routingPlugin(root, { isAuthEnabled: () => false });
      const config = getHookHandler(plugin.config) as (
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => void;
      const configResolved = getHookHandler(plugin.configResolved) as (
        config: import('vite').ResolvedConfig,
      ) => void;
      const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;
      const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;

      config({}, { command: 'build', mode: 'production' });
      configResolved({
        build: { assetsDir: 'assets' },
        command: 'build',
        mode: 'production',
        plugins: [],
      } as unknown as import('vite').ResolvedConfig);
      await buildStart.call({} as never);
      const routes = await load('virtual:void-routes');

      expect(routes).toContain(
        'export const __VOID_ISR_PAGES = [{"pattern":"/private","revalidate":0}];',
      );
      expect(routes).toContain('export const __VOID_ISR_PATH_REVALIDATE = {"/private":60};');
    } finally {
      if (savedProjectId === undefined) {
        delete process.env.VOID_DEPLOY_PROJECT_ID;
      } else {
        process.env.VOID_DEPLOY_PROJECT_ID = savedProjectId;
      }
    }
  });

  it('resolves explicit framework client subpaths to framework auth clients', async () => {
    const root = createBareTempRoot();
    const plugin = routingPlugin(root, { isAuthEnabled: () => false });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment?: { name?: string } },
      id: string,
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'serve',
      mode: 'development',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);

    expect(resolveId.call({ environment: { name: 'client' } }, 'void/client/react')).toBe(
      'virtual:void-client-browser:react',
    );
    expect(resolveId.call({ environment: { name: 'void_worker' } }, 'void/client/react')).toBe(
      'virtual:void-client-worker:react',
    );

    const browserCode = await load('virtual:void-client-browser:react');
    expect(browserCode).toContain('auth-client-react.mjs');
    expect(browserCode).not.toContain('cloudflare:workers');

    const workerCode = await load('virtual:void-client-worker:react');
    expect(workerCode).toContain('auth-client-react.mjs');
    expect(workerCode).toContain('cloudflare:workers');
  });

  it('restarts dev when a structural route change changes the asset routing policy', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'routes', 'api.ts'), 'export const GET = () => new Response();\n');

    const onPolicyChange = vi.fn(() => true);
    const plugin = routingPlugin(root, {
      isAuthEnabled: () => false,
      onDevAssetRoutingPolicyChange: onPolicyChange,
    });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;
    const configureServer = getHookHandler(plugin.configureServer) as (server: unknown) => void;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'serve',
      mode: 'development',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);
    await buildStart.call({} as never);

    const handlers: Record<string, (path: string) => Promise<void>> = {};
    const restart = vi.fn(async () => {});
    configureServer({
      watcher: {
        on: vi.fn((event: string, handler: (path: string) => Promise<void>) => {
          handlers[event] = handler;
        }),
      },
      environments: {},
      restart,
    });

    const documentRoute = join(root, 'routes', 'dashboard.ts');
    writeFileSync(documentRoute, 'export const GET = () => new Response("dashboard");\n');
    await handlers.add(documentRoute);

    expect(onPolicyChange).toHaveBeenCalledWith(
      expect.objectContaining({
        assetConfig: expect.objectContaining({ not_found_handling: 'none' }),
        workerFirst: true,
      }),
    );
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('restarts dev when adding the first API route changes the asset routing policy', async () => {
    const root = createTempRoot();

    const onPolicyChange = vi.fn(() => true);
    const plugin = routingPlugin(root, {
      isAuthEnabled: () => false,
      onDevAssetRoutingPolicyChange: onPolicyChange,
    });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;
    const configureServer = getHookHandler(plugin.configureServer) as (server: unknown) => void;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'serve',
      mode: 'development',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);
    await buildStart.call({} as never);

    const handlers: Record<string, (path: string) => Promise<void>> = {};
    const restart = vi.fn(async () => {});
    configureServer({
      watcher: {
        on: vi.fn((event: string, handler: (path: string) => Promise<void>) => {
          handlers[event] = handler;
        }),
      },
      environments: {},
      restart,
    });

    const apiRoute = join(root, 'routes', 'api.ts');
    writeFileSync(apiRoute, 'export const GET = () => new Response("api");\n');
    await handlers.add(apiRoute);

    expect(onPolicyChange).toHaveBeenCalledWith(
      expect.objectContaining({
        apiWorkerFirst: true,
        assetConfig: expect.objectContaining({
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api', '/api/*', '/__void', '/__void/*'],
        }),
        workerFirst: false,
      }),
    );
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('invalidates page renderer modules before route table reloads for new pages', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'index.tsx'),
      'export default function Index() { return null; }',
    );

    const plugin = routingPlugin(root, { isAuthEnabled: () => false });
    const configureServer = getHookHandler(plugin.configureServer) as (server: unknown) => void;
    const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
    const invalidated: Array<string> = [];
    const modules = new Map(
      ['\0virtual:void-pages-renderer', '\0virtual:void-pages-client', 'virtual:void-routes'].map(
        (id) => [id, { id }],
      ),
    );

    configureServer({
      watcher: {
        on(event: string, handler: (path: string) => Promise<void> | void) {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
        },
      },
      environments: {
        void_worker: {
          moduleGraph: {
            getModuleById(id: string) {
              return modules.get(id);
            },
            invalidateModule(mod: { id: string }) {
              invalidated.push(mod.id);
            },
          },
          hot: { send() {} },
        },
      },
    });

    writeFileSync(
      join(root, 'pages', 'test.tsx'),
      'export default function Test() { return null; }',
    );
    for (const handler of handlers.get('add') ?? []) {
      await handler(join(root, 'pages', 'test.tsx'));
    }

    expect(invalidated).toEqual([
      '\0virtual:void-pages-renderer',
      '\0virtual:void-pages-client',
      'virtual:void-routes',
    ]);
  });

  it('does not invalidate page renderer modules for component-only page saves', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    const pagePath = join(root, 'pages', 'index.tsx');
    writeFileSync(pagePath, 'export default function Index() { return null; }');

    const plugin = routingPlugin(root, { isAuthEnabled: () => false });
    const configureServer = getHookHandler(plugin.configureServer) as (server: unknown) => void;
    const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
    const invalidated: Array<string> = [];
    const modules = new Map(
      ['\0virtual:void-pages-renderer', '\0virtual:void-pages-client', 'virtual:void-routes'].map(
        (id) => [id, { id }],
      ),
    );

    configureServer({
      watcher: {
        on(event: string, handler: (path: string) => Promise<void> | void) {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
        },
      },
      environments: {
        void_worker: {
          moduleGraph: {
            getModuleById(id: string) {
              return modules.get(id);
            },
            invalidateModule(mod: { id: string }) {
              invalidated.push(mod.id);
            },
          },
          hot: { send() {} },
        },
      },
    });

    writeFileSync(pagePath, 'export default function Index() { return <h1>Updated</h1>; }');
    for (const handler of handlers.get('change') ?? []) {
      await handler(pagePath);
    }

    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it('rescans sourceDir route changes during dev', async () => {
    const root = createBareTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }));
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });

    const onPolicyChange = vi.fn(() => false);
    const plugin = routingPlugin(root, {
      isAuthEnabled: () => false,
      onDevAssetRoutingPolicyChange: onPolicyChange,
    });
    const configureServer = getHookHandler(plugin.configureServer) as (server: unknown) => void;
    const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
    const invalidated: Array<string> = [];
    const modules = new Map([['virtual:void-routes', { id: 'virtual:void-routes' }]]);

    configureServer({
      watcher: {
        on(event: string, handler: (path: string) => Promise<void> | void) {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
        },
      },
      environments: {
        void_worker: {
          moduleGraph: {
            getModuleById(id: string) {
              return modules.get(id);
            },
            invalidateModule(mod: { id: string }) {
              invalidated.push(mod.id);
            },
          },
          hot: { send() {} },
        },
      },
    });

    const routePath = join(root, 'src', 'routes', 'api.ts');
    writeFileSync(routePath, 'export const GET = () => new Response("ok");\n');
    for (const handler of handlers.get('add') ?? []) {
      await handler(routePath);
    }

    expect(onPolicyChange).toHaveBeenCalled();
    expect(invalidated).toEqual(['virtual:void-routes']);
    expect(readFileSync(join(root, '.void', 'routes.d.ts'), 'utf-8')).toContain(
      '../src/routes/api.ts',
    );
  });

  it('invalidates sourceDir page manifest changes during dev', async () => {
    const root = createBareTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }));
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });

    const plugin = routingPlugin(root, { isAuthEnabled: () => false });
    const configureServer = getHookHandler(plugin.configureServer) as (server: unknown) => void;
    const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
    const invalidated: Array<string> = [];
    const modules = new Map(
      ['\0virtual:void-pages-renderer', '\0virtual:void-pages-client', 'virtual:void-routes'].map(
        (id) => [id, { id }],
      ),
    );

    configureServer({
      watcher: {
        on(event: string, handler: (path: string) => Promise<void> | void) {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
        },
      },
      environments: {
        void_worker: {
          moduleGraph: {
            getModuleById(id: string) {
              return modules.get(id);
            },
            invalidateModule(mod: { id: string }) {
              invalidated.push(mod.id);
            },
          },
          hot: { send() {} },
        },
      },
    });

    const pagePath = join(root, 'src', 'pages', 'test.tsx');
    writeFileSync(pagePath, 'export default function Test() { return null; }');
    for (const handler of handlers.get('add') ?? []) {
      await handler(pagePath);
    }

    expect(invalidated).toEqual([
      '\0virtual:void-pages-renderer',
      '\0virtual:void-pages-client',
      'virtual:void-routes',
    ]);
  });

  // Manual trigger auth is baked into the route table: dev accepts only the
  // dev trigger header. `vite preview` reports `command: 'serve'` but runs
  // the built bundle, so it must keep the build rule.
  it.each([
    { command: 'serve' as const, isPreview: false, serve: true },
    { command: 'serve' as const, isPreview: true, serve: false },
    { command: 'build' as const, isPreview: false, serve: false },
  ])(
    'compiles trigger auth for $command (preview: $isPreview) as serve=$serve',
    async ({ command, isPreview, serve }) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'crons'), { recursive: true });
      writeFileSync(
        join(root, 'crons', 'sync.ts'),
        'export const cron = "0 * * * *";\nexport default async () => {};\n',
      );

      const plugin = routingPlugin(root, { isAuthEnabled: () => false });
      const config = getHookHandler(plugin.config) as (
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => unknown;
      const configResolved = getHookHandler(plugin.configResolved) as (
        config: import('vite').ResolvedConfig,
      ) => void;
      const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;

      config({}, { command, mode: command === 'build' ? 'production' : 'development', isPreview });
      configResolved({
        build: { assetsDir: 'assets' },
        command,
        mode: 'development',
        plugins: [],
      } as unknown as import('vite').ResolvedConfig);

      const code = await load('virtual:void-routes');
      expect(code).toContain('app.post("/__void/scheduled"');
      expect(code).toContain(`const __VOID_SERVE = ${serve};`);
    },
  );
});
