import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import type { Plugin, ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

vi.mock('@cloudflare/vite-plugin', () => ({
  cloudflare(pluginConfig: MockCloudflarePluginConfig): Array<Plugin> {
    return [{ name: 'mock:cloudflare', api: { pluginConfig } } as Plugin];
  },
}));

const roots: Array<string> = [];

function createTanStackRoot(voidConfig?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-class-a-wrapper-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {
        '@tanstack/react-start': '^1.168.19',
      },
    }),
  );
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' }, ...voidConfig }),
  );
  return root;
}

function callConfig(plugin: Plugin, command: 'build' | 'serve') {
  const hook = plugin.config;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('config not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)({}, { command, mode: command === 'build' ? 'production' : 'development' });
}

/** Run the Cloudflare plugin's `config` customizer the way the real plugin does. */
function mergeWorkerConfig(
  plugins: Array<Plugin>,
  resolved: Record<string, unknown> = {},
): Record<string, unknown> {
  const cloudflarePlugin = plugins.find((plugin) => plugin.name === 'mock:cloudflare');
  if (!cloudflarePlugin) {
    throw new Error('Expected mocked Cloudflare plugin.');
  }
  const pluginConfig = (cloudflarePlugin.api as { pluginConfig: MockCloudflarePluginConfig })
    .pluginConfig;
  return pluginConfig.config(resolved);
}

function callConfigResolved(plugin: Plugin, config: Partial<ResolvedConfig>) {
  const hook = plugin.configResolved;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configResolved not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)(config);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('Class A framework build wrapper', () => {
  it('falls through framework 404 responses to ASSETS for uploaded client assets', async () => {
    const root = createTanStackRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const { voidPlugin } = await import('../../src/index.ts');
    const plugins = voidPlugin();
    const wrapperPlugin = plugins.find((plugin) => plugin.name === 'void:framework-build-wrapper');
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }

    callConfigResolved(wrapperPlugin, {
      command: 'build',
      build: { assetsDir: 'static' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>);

    const code = readFileSync(join(root, '.void', 'tanstack-start-trigger-wrapper.ts'), 'utf-8');
    expect(code).toContain('return serveWithAssets(request, env, await original.fetch');
    expect(code).toContain('async function serveWithAssets(request, env, response)');
    expect(code).toContain('env.ASSETS.fetch(new Request(request.url');
    expect(code).toContain('request.method !== "GET" && request.method !== "HEAD"');
    expect(code).toContain('"public, max-age=31536000, immutable"');
    expect(code).toContain('"/static/"');
    // No `routing.notFound` → the pre-existing "hand the framework's own 404
    // back" behavior.
    expect(code).not.toContain('asset.headers.get("content-type")');
  });

  // A Class A app deploys through `runFullDeploy`, which DOES honor
  // `routing.notFound` when it builds the wrangler asset config. This wrapper is
  // the code that then sits in front of the asset binding, so it has to agree —
  // otherwise it fetches the generator's `404.html` and throws it away.
  it('honors routing.notFound: 404-page in the generated wrapper', async () => {
    const root = createTanStackRoot({ routing: { notFound: '404-page' } });
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const { voidPlugin } = await import('../../src/index.ts');
    const plugins = voidPlugin();
    const wrapperPlugin = plugins.find((plugin) => plugin.name === 'void:framework-build-wrapper');
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }

    callConfigResolved(wrapperPlugin, {
      command: 'build',
      build: { assetsDir: 'static' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>);

    const code = readFileSync(join(root, '.void', 'tanstack-start-trigger-wrapper.ts'), 'utf-8');
    expect(code).toContain('asset.headers.get("content-type")');
    expect(code).toContain('new Response(asset.body, asset)');
  });
});

// The wrapper above only has an HTML 404 page to pass through when the asset
// binding itself is set to `404-page`. Managed `void deploy` supplies that via
// `manifest.assetConfig`; the built `dist/ssr/wrangler.json` has to carry it too
// or a `wrangler deploy` of the same build silently ignores `routing.notFound`.
describe('Class A wrangler asset config', () => {
  async function loadPlugins(voidConfig?: Record<string, unknown>): Promise<Array<Plugin>> {
    const root = createTanStackRoot(voidConfig);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    return voidPlugin();
  }

  function wrapperOf(plugins: Array<Plugin>): Plugin {
    const plugin = plugins.find((p) => p.name === 'void:framework-build-wrapper');
    if (!plugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }
    return plugin;
  }

  it('writes routing.notFound into the built worker asset config', async () => {
    const plugins = await loadPlugins({ routing: { notFound: '404-page' } });
    callConfig(wrapperOf(plugins), 'build');

    const merged = mergeWorkerConfig(plugins);
    expect(merged.assets).toEqual({ not_found_handling: '404-page' });
  });

  it('invents no asset policy when routing.notFound is unset', async () => {
    const plugins = await loadPlugins();
    callConfig(wrapperOf(plugins), 'build');

    expect(mergeWorkerConfig(plugins).assets).toBeUndefined();
  });

  it('leaves the dev asset router alone', async () => {
    const plugins = await loadPlugins({ routing: { notFound: '404-page' } });
    callConfig(wrapperOf(plugins), 'serve');

    expect(mergeWorkerConfig(plugins).assets).toBeUndefined();
  });

  // Void generates no `run_worker_first` for Class A, so the root wrangler value
  // is the only one there is — replacing the pair wholesale would drop it.
  it('replaces a stale root not_found_handling but keeps root run_worker_first', async () => {
    const plugins = await loadPlugins({ routing: { notFound: '404-page' } });
    callConfig(wrapperOf(plugins), 'build');

    const resolved = {
      assets: {
        binding: 'ASSETS',
        directory: './dist/client',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api/*'],
      },
    };
    mergeWorkerConfig(plugins, resolved);

    expect(resolved.assets).toEqual({
      binding: 'ASSETS',
      directory: './dist/client',
      run_worker_first: ['/api/*'],
    });
  });
});
