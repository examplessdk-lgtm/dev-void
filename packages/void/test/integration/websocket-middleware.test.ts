import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'pathslash';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'void-websocket-middleware-'));
const output = join(temporary, 'dist');
const routeTablePath = join(temporary, 'virtual-void-routes.ts');
const workerPath = join(temporary, 'worker.ts');

type MiniflareInstance = {
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
  getBindings<T extends Record<string, unknown>>(): Promise<T>;
};

let miniflare: MiniflareInstance;

describe('generated worker WebSocket middleware', () => {
  beforeAll(async () => {
    const routesDir = join(temporary, 'routes');
    const middlewareDir = join(temporary, 'middleware');
    const websocketPath = join(routesDir, 'chat.ws.ts');
    const httpRoutePath = join(routesDir, 'chat.ts');
    const middlewarePath = join(middlewareDir, '01.auth.ts');
    const handlerPath = join(temporary, 'handler.ts');
    const responsePath = join(temporary, 'response.ts');
    const runtimeEnvPath = join(temporary, 'runtime-env.ts');
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(middlewareDir, { recursive: true });

    writeFileSync(
      websocketPath,
      `const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
export default {
  __kind: "socket",
  messages: { client: schema, server: schema },
  async onConnect({ storage }) {
    await storage.put("dispatches", ((await storage.get("dispatches")) ?? 0) + 1);
  },
  async onRequest({ storage }) {
    return Response.json({ dispatches: (await storage.get("dispatches")) ?? 0 });
  },
};\n`,
    );
    writeFileSync(httpRoutePath, 'export function GET(c) { return c.text("HTTP route"); }\n');
    writeFileSync(
      middlewarePath,
      `export default async function auth(c, next) {
  if (c.req.raw.headers.get("authorization") !== "Bearer allowed") {
    return c.text("Unauthorized", 401);
  }
  return next();
}\n`,
    );
    writeFileSync(handlerPath, 'export class VoidAssetRewriteError extends Error {}\n');
    writeFileSync(
      responsePath,
      'export function convertReturnValue(value) { return value instanceof Response ? value : Response.json(value); }\n',
    );
    writeFileSync(runtimeEnvPath, 'export function withRuntimeEnv(_env, fn) { return fn(); }\n');

    const scan: ScanResult = {
      routes: [
        {
          pattern: '/chat',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'chat.ts',
        },
      ],
      websockets: [
        {
          pattern: '/chat',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'chat.ws.ts',
          className: 'ChatWs',
          bindingName: 'CHAT_WS',
          mode: 'socket',
          hasAuthGate: false,
        },
      ],
      middleware: [{ order: 1, filePath: '01.auth.ts' }],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    writeFileSync(
      routeTablePath,
      compileRouteTable(scan, routesDir, middlewareDir, temporary, temporary, null, {
        honoPath: import.meta.resolve('hono'),
        responsePath,
        handlerPath,
        runtimeEnvPath,
        webSocketRuntimePath: join(root, 'packages/void/src/runtime/ws-server.ts'),
        projectRoot: temporary,
        homeDir: temporary,
        reactRefresh: false,
        auth: null,
      }),
    );
    writeFileSync(workerPath, compileWorkerEntry({ webSocketClasses: ['ChatWs'], runtimeEnvPath }));

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'void-websocket-middleware-test',
          resolveId(id) {
            return id === 'virtual:void-routes' ? routeTablePath : null;
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        emptyOutDir: true,
        outDir: output,
        ssr: workerPath,
        target: 'esnext',
        rollupOptions: {
          external: [/^cloudflare:/],
          output: { entryFileNames: 'worker.mjs', codeSplitting: false },
        },
      },
    });

    const voidRequire = createRequire(join(root, 'packages/void/package.json'));
    const miniflarePath = createRequire(voidRequire.resolve('wrangler')).resolve('miniflare');
    const { Miniflare, convertV4MiniflareOptions } = (await import(
      pathToFileURL(miniflarePath).href
    )) as {
      convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>;
      Miniflare: new (options: Record<string, unknown>) => MiniflareInstance;
    };
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { CHAT_WS: 'ChatWs' },
        modules: true,
        modulesRoot: output,
        scriptPath: join(output, 'worker.mjs'),
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await miniflare?.dispose();
    rmSync(temporary, { force: true, recursive: true });
  });

  it('authorizes upgrades before Durable Object dispatch and preserves the WebSocket response', async () => {
    const unauthorized = await miniflare.dispatchFetch('http://localhost/chat', {
      headers: { Upgrade: 'websocket' },
    });

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe('Unauthorized');
    expect(unauthorized.webSocket).toBeNull();

    const { CHAT_WS } = await miniflare.getBindings<{
      CHAT_WS: DurableObjectNamespace;
    }>();
    const stub = CHAT_WS.get(CHAT_WS.idFromName('default'));
    const beforeAuthorized = await stub.fetch('http://localhost/chat');
    expect(await beforeAuthorized.json()).toEqual({ dispatches: 0 });

    const authorized = await miniflare.dispatchFetch('http://localhost/chat', {
      headers: { Authorization: 'Bearer allowed', Upgrade: 'websocket' },
    });

    expect(authorized.status).toBe(101);
    expect(authorized.webSocket).not.toBeNull();
    const afterAuthorized = await stub.fetch('http://localhost/chat');
    expect(await afterAuthorized.json()).toEqual({ dispatches: 1 });
    const socket = authorized.webSocket!;
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
    });
    socket.accept();
    socket.close(1000, 'test complete');
    // Finish the close handshake before disposing workerd. Killing it while
    // the upgrade transport is open can emit an unhandled Windows ECONNRESET.
    await closed;
  });

  it('continues non-upgrade requests to an HTTP route at the same path', async () => {
    const response = await miniflare.dispatchFetch('http://localhost/chat', {
      headers: { Authorization: 'Bearer allowed' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('HTTP route');
  });
});
