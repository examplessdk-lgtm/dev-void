import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const runtimeSource = (file: string) => join(import.meta.dirname, '../../src/runtime', file);
let directory: string;
let runtime: Miniflare | undefined;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'void-native-asset-policy-'));
  const assets = join(directory, 'client');
  const output = join(directory, 'output');
  mkdirSync(join(assets, 'static'), { recursive: true });
  for (const file of [
    'client-abcdefgh.js',
    'private-abcdefgh.js',
    'client.js',
    'page-abcdefgh.html',
  ]) {
    writeFileSync(
      join(assets, 'static', file),
      file.endsWith('.html') ? '<html>asset</html>' : 'export const value = 1;',
    );
  }
  writeFileSync(
    join(assets, '_headers'),
    '/static/private-abcdefgh.js\n  Cache-Control: private, no-store\n',
  );
  const entry = join(directory, 'worker.ts');
  writeFileSync(
    entry,
    `
    import { Hono } from ${JSON.stringify(fileURLToPath(import.meta.resolve('hono')))};
    import { createPagesFallback, createSsrFallback, createAssetNotFound } from ${JSON.stringify(runtimeSource('routing-pages.ts'))};
    import { applyAssetCachePolicy, createAssetFallback } from ${JSON.stringify(runtimeSource('routing-worker.ts'))};
    import { createRoutingRuntime } from ${JSON.stringify(runtimeSource('routing.ts'))};
    import { createErrorRenderer } from ${JSON.stringify(runtimeSource('routing-errors.ts'))};
    const apps = {};
    for (const mode of ['pages', 'ssr', 'static']) {
      const app = new Hono();
      const routing = createRoutingRuntime(app, {});
      app.use(routing.contextMiddleware);
      app.notFound(mode === 'pages'
        ? createPagesFallback({ routing, assetsDir: 'static', errors: createErrorRenderer({ projectRoot: '/fixture', homeDir: '/home' }) })
        : mode === 'ssr'
          ? createSsrFallback({ routing, assetsDir: 'static', load: async () => ({ render: () => new Response('document') }), assets: async () => ({ css: '', body: '', preloads: '' }) })
          : createAssetNotFound({ routing, assetsDir: 'static' }));
      apps[mode] = app;
    }
    const outer = createAssetFallback({ assetsDir: 'static' });
    export default { async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === '/cache-proof') {
        const key = new Request('https://cache.test/static/client-abcdefgh.js');
        await caches.default.put(key, new Response(new Uint8Array([1, 2, 3]), { headers: { 'cache-control': 'public, max-age=600' } }));
        const original = await caches.default.match(key);
        let immutable = false;
        try { original.headers.set('x-immutable-probe', '1'); } catch { immutable = true; }
        const result = applyAssetCachePolicy(key, original, 'static');
        return Response.json({ immutable, originalContentType: original.headers.get('content-type'), resultContentType: result.headers.get('content-type'), originalPolicy: original.headers.get('cache-control'), resultPolicy: result.headers.get('cache-control'), body: [...new Uint8Array(await result.arrayBuffer())] });
      }
      const mode = url.searchParams.get('mode') ?? 'pages';
      return mode === 'outer'
        ? outer(request, env, new Response('not found', { status: 404 }))
        : apps[mode].fetch(request, env, context);
    }};
  `,
  );
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: {
      outDir: output,
      emptyOutDir: true,
      ssr: entry,
      target: 'esnext',
      rollupOptions: {
        external: [/^cloudflare:/, /^node:/],
        output: { entryFileNames: 'worker.mjs', codeSplitting: false },
      },
    },
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: true,
      modulesRoot: output,
      scriptPath: join(output, 'worker.mjs'),
      assets: {
        directory: assets,
        binding: 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          html_handling: 'none',
          not_found_handling: 'none',
        },
      },
    }),
  );
});

afterAll(async () => {
  await runtime?.dispose();
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native asset cache policy in real Workers', () => {
  it.each(['pages', 'ssr', 'static', 'outer'])(
    'normalizes successful native ASSETS responses in %s',
    async (mode) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await runtime!.dispatchFetch(
          `https://app.test/static/client-abcdefgh.js?mode=${mode}`,
        );
        expect(response.status, response.status === 200 ? undefined : await response.text()).toBe(
          200,
        );
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('content-type')).toContain('javascript');
        await expect(response.text()).resolves.toBe('export const value = 1;');
      }
    },
  );

  it.each(['pages', 'ssr', 'static', 'outer'])(
    'preserves authored privacy, unhashed/HTML defaults and missing files in %s',
    async (mode) => {
      for (const [file, policy] of [
        ['private-abcdefgh.js', 'private, no-store'],
        ['client.js', 'public, max-age=0, must-revalidate'],
        ['page-abcdefgh.html', 'public, max-age=0, must-revalidate'],
      ]) {
        const response = await runtime!.dispatchFetch(
          `https://app.test/static/${file}?mode=${mode}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe(policy);
      }
      const missing = await runtime!.dispatchFetch(
        `https://app.test/static/missing-abcdefgh.js?mode=${mode}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
    },
  );

  it('wraps an immutable Cache API response without mutating its headers or consuming its body', async () => {
    const response = await runtime!.dispatchFetch('https://app.test/cache-proof');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      immutable: true,
      originalContentType: null,
      resultContentType: 'text/javascript; charset=utf-8',
      originalPolicy: 'public, max-age=600',
      resultPolicy: 'public, max-age=600',
      body: [1, 2, 3],
    });
  });
});
