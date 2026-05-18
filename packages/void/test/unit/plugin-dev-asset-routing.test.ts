import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

type MockCloudflarePlugin = Plugin & {
  api: {
    pluginConfig: MockCloudflarePluginConfig;
  };
};

vi.mock('@cloudflare/vite-plugin', () => ({
  cloudflare(pluginConfig: MockCloudflarePluginConfig): Array<MockCloudflarePlugin> {
    return [
      {
        name: 'mock:cloudflare',
        api: { pluginConfig },
      },
    ];
  },
}));

const tempDirs: Array<string> = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-dev-assets-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

function createPagesProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'index.tsx'),
    'export default function Page() { return null; }',
  );
  return root;
}

function createApiOnlyProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(join(root, 'routes/api/hello.ts'), 'export const GET = () => Response.json({});');
  return root;
}

function createDocumentRouteProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes'), { recursive: true });
  writeFileSync(join(root, 'routes/hello.ts'), "export const GET = () => new Response('hello');");
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

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('voidPlugin dev asset routing', () => {
  async function resolveVoidPluginAssets(
    root: string,
    resolved: Record<string, unknown> = {},
  ): Promise<{ not_found_handling?: string; run_worker_first?: Array<string> }> {
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const { voidPlugin } = await import('../../src/index.ts');
    const plugins = voidPlugin();

    const envPlugin = plugins.find((plugin) => plugin.name === 'void:env');
    const config = getHookHandler(envPlugin?.config) as (
      config: import('vite').UserConfig,
      env: import('vite').ConfigEnv,
    ) => void;
    config({}, { command: 'serve', mode: 'development' });

    const cloudflarePlugin = plugins.find(
      (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
    );
    if (!cloudflarePlugin) {
      throw new Error('Expected mocked Cloudflare plugin.');
    }

    const merged = cloudflarePlugin.api.pluginConfig.config(resolved);
    return merged.assets as { not_found_handling?: string; run_worker_first?: Array<string> };
  }

  it('keeps page requests on the worker while letting Vite internals bypass it', async () => {
    const root = createPagesProjectRoot();
    const assets = await resolveVoidPluginAssets(root);

    expect(assets?.run_worker_first).toEqual([
      '!/@vite/*',
      '!/@id/*',
      '!/@fs/*',
      '!/@react-refresh',
      '!/@svelte/*',
      '!/node_modules/*',
      '!/__uno.css',
      '/**',
    ]);
    expect(assets?.not_found_handling).toBe('none');
  });

  it('keeps API-only projects on the static SPA fallback and clears stale worker-first rules', async () => {
    const root = createApiOnlyProjectRoot();
    const assets = await resolveVoidPluginAssets(root, {
      assets: {
        binding: 'ASSETS',
        not_found_handling: 'none',
        run_worker_first: ['/', '/*.html'],
      },
    });

    expect(assets?.not_found_handling).toBe('single-page-application');
    expect(assets?.run_worker_first).toBeUndefined();
  });

  it('routes document routes through the worker before SPA fallback HTML', async () => {
    const root = createDocumentRouteProjectRoot();
    const assets = await resolveVoidPluginAssets(root);

    expect(assets?.not_found_handling).toBe('none');
    expect(assets?.run_worker_first).toEqual([
      '!/@vite/*',
      '!/@id/*',
      '!/@fs/*',
      '!/@react-refresh',
      '!/@svelte/*',
      '!/node_modules/*',
      '!/__uno.css',
      '/**',
    ]);
  });
});
