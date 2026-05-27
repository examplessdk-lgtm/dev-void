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

function createBindingProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/bindings.ts'),
    `
import { db } from "void/db";
import { storage } from "void/storage";

export async function GET() {
  await db.select();
  await storage.head("key");
  return Response.json({});
}
`,
  );
  return root;
}

function createCustomBindingProjectRoot(): string {
  const root = createBindingProjectRoot();
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({
      inference: { bindings: { db: 'myapp_db', kv: 'myapp_kv', storage: 'myapp_storage' } },
      worker: { compatibility_date: '2026-02-24' },
    }),
  );
  return root;
}

function createApiWebSocketOnlyProjectRoot(): string {
  const root = createProjectRoot();
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/chat.ws.ts'),
    'export default defineWebSocket({ onMessage() {} });',
  );
  return root;
}

function createAuthOnlyProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({
      auth: { providers: ['email'] },
      worker: { compatibility_date: '2026-02-24' },
    }),
  );
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
  async function resolveCloudflareConfig(
    root: string,
    resolved: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
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

    return cloudflarePlugin.api.pluginConfig.config(resolved);
  }

  async function resolveVoidPluginAssets(
    root: string,
    resolved: Record<string, unknown> = {},
  ): Promise<{ not_found_handling?: string; run_worker_first?: Array<string> }> {
    const merged = await resolveCloudflareConfig(root, resolved);
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

  it('keeps API-only projects on the static SPA fallback while routing API requests to the worker', async () => {
    const root = createApiOnlyProjectRoot();
    const assets = await resolveVoidPluginAssets(root, {
      assets: {
        binding: 'ASSETS',
        not_found_handling: 'none',
        run_worker_first: ['/', '/*.html'],
      },
    });

    expect(assets?.not_found_handling).toBe('single-page-application');
    expect(assets?.run_worker_first).toEqual(['/api', '/api/*']);
  });

  it('does not return existing D1 or R2 bindings when adding inferred defaults', async () => {
    const root = createBindingProjectRoot();
    const config = await resolveCloudflareConfig(root, {
      d1_databases: [{ binding: 'myapp_db', database_name: 'prod', database_id: 'real-id' }],
      r2_buckets: [{ binding: 'myapp_storage', bucket_name: 'prod' }],
    });

    expect(config.d1_databases).toEqual([
      { binding: 'DB', database_name: 'default', database_id: 'local' },
    ]);
    expect(config.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'default' }]);
  });

  it('uses custom inference binding names for generated D1 and R2 bindings', async () => {
    const root = createCustomBindingProjectRoot();
    const config = await resolveCloudflareConfig(root);

    expect(config.d1_databases).toEqual([
      { binding: 'myapp_db', database_name: 'default', database_id: 'local' },
    ]);
    expect(config.kv_namespaces).toEqual([{ binding: 'myapp_kv', id: 'local' }]);
    expect(config.r2_buckets).toEqual([{ binding: 'myapp_storage', bucket_name: 'default' }]);
  });

  it('keeps projects with only API websocket routes static-first for document requests', async () => {
    const root = createApiWebSocketOnlyProjectRoot();
    const assets = await resolveVoidPluginAssets(root);

    expect(assets?.not_found_handling).toBe('single-page-application');
    expect(assets?.run_worker_first).toEqual(['/api', '/api/*']);
  });

  it('routes managed auth endpoints to the worker without making all documents worker-first', async () => {
    const root = createAuthOnlyProjectRoot();
    const assets = await resolveVoidPluginAssets(root);

    expect(assets?.not_found_handling).toBe('single-page-application');
    expect(assets?.run_worker_first).toEqual(['/api', '/api/*']);
  });

  it('keeps API-only projects static-first when middleware directory has no active files', async () => {
    const root = createApiOnlyProjectRoot();
    mkdirSync(join(root, 'middleware'), { recursive: true });
    writeFileSync(join(root, 'middleware', '_ignored.ts'), 'export default () => undefined;');

    const assets = await resolveVoidPluginAssets(root);

    expect(assets?.not_found_handling).toBe('single-page-application');
    expect(assets?.run_worker_first).toEqual(['/api', '/api/*']);
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
