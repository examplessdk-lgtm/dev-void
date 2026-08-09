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
