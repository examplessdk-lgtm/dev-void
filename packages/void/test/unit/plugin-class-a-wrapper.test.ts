import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  vi.unstubAllEnvs();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('Class A framework build wrapper', () => {
  it.each([
    [undefined, 'none'],
    ['404-page', '404-page'],
  ] as const)(
    'falls through framework 404s to ASSETS with routing.notFound %s',
    async (notFound, expected) => {
      const root = createTanStackRoot(notFound ? { routing: { notFound } } : undefined);
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const { voidPlugin } = await import('../../src/index.ts');
      const plugins = voidPlugin();
      const wrapperPlugin = plugins.find(
        (plugin) => plugin.name === 'void:framework-build-wrapper',
      );
      if (!wrapperPlugin) {
        throw new Error('Expected Class A wrapper plugin.');
      }

      callConfigResolved(wrapperPlugin, {
        command: 'build',
        build: { assetsDir: 'static' } as ResolvedConfig['build'],
      } as Partial<ResolvedConfig>);

      const code = readFileSync(join(root, '.void', 'tanstack-start-trigger-wrapper.ts'), 'utf-8');
      expect(code).toContain('return serveWithAssets(request, env, await original.fetch');
      expect(code).toContain('import { createAssetFallback as __createAssetFallback }');
      expect(code).toContain(
        `const serveWithAssets = __createAssetFallback({"assetsDir":"static","serveSpaFallback":false,"notFound":"${expected}"});`,
      );
    },
  );
});

describe('Class A framework dev wrapper', () => {
  it('serves an ordinary request without loading a broken cron dependency', async () => {
    const root = createTanStackRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'helpers'), { recursive: true });
    writeFileSync(join(root, 'helpers/explode.ts'), 'throw new Error("cron dependency loaded");');
    writeFileSync(
      join(root, 'crons/tick.ts'),
      'import "../helpers/explode.ts"; export const cron = "* * * * *"; export default async function tick() {}',
    );
    const packageRoot = join(root, 'node_modules/@tanstack/react-start');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './server-entry': './server-entry.js' } }),
    );
    writeFileSync(
      join(packageRoot, 'server-entry.js'),
      'export default { fetch: async () => new Response("ordinary page") };',
    );

    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    voidPlugin();

    const runner = join(root, 'run.mjs');
    writeFileSync(
      runner,
      `import worker from ${JSON.stringify(pathToFileURL(join(root, '.void/tanstack-start-trigger-wrapper.ts')).href)};\n` +
        'const response = await worker.fetch(new Request("https://example.test/"), {}, {});\n' +
        'process.stdout.write(await response.text());\n',
    );
    expect(execFileSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' })).toBe(
      'ordinary page',
    );
  });
});

describe('Class A routing.notFound self-host warning', () => {
  /** Run a Class A `build` twice and return every line the plugin logged. */
  async function buildTwiceWithNotFound(): Promise<Array<string>> {
    const root = createTanStackRoot({ routing: { notFound: '404-page' } });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { voidPlugin } = await import('../../src/index.ts');
    const wrapperPlugin = voidPlugin().find(
      (plugin) => plugin.name === 'void:framework-build-wrapper',
    );
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }
    const resolved = {
      command: 'build',
      build: { assetsDir: 'static' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>;
    // Twice on purpose: at most one warning per build, however many times the
    // hook runs (the Cloudflare plugin resolves config per environment).
    callConfigResolved(wrapperPlugin, resolved);
    callConfigResolved(wrapperPlugin, resolved);

    return logSpy.mock.calls.map((args) => args.join(' '));
  }

  function notFoundWarnings(lines: Array<string>): Array<string> {
    return lines.filter((line) => line.includes('"routing.notFound" in void.config.ts'));
  }

  it('warns once that a self-hosted build generates no policy for routing.notFound', async () => {
    const warnings = notFoundWarnings(await buildTwiceWithNotFound());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tanstack-start');
    expect(warnings[0]).toContain('direct Cloudflare deployment');
    expect(warnings[0]).toContain('void deploy');
    for (const field of ['binding', 'directory', 'not_found_handling', 'run_worker_first']) {
      expect(warnings[0]).toContain(field);
    }
  });

  it('stays quiet when a managed `void deploy` drives the build', async () => {
    vi.stubEnv('VOID_DEPLOY_BUILD', '1');
    expect(notFoundWarnings(await buildTwiceWithNotFound())).toEqual([]);
  });

  it('says nothing when routing.notFound is unset', async () => {
    const root = createTanStackRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { voidPlugin } = await import('../../src/index.ts');
    const wrapperPlugin = voidPlugin().find(
      (plugin) => plugin.name === 'void:framework-build-wrapper',
    );
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }
    callConfigResolved(wrapperPlugin, {
      command: 'build',
      build: { assetsDir: 'static' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>);

    expect(notFoundWarnings(logSpy.mock.calls.map((args) => args.join(' ')))).toEqual([]);
  });
});
