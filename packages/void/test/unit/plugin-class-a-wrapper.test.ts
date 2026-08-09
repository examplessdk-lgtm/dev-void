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

// `routing.notFound` reaches a Class A worker only through the DEPLOYED script's
// `assets` config, and Void writes none for these frameworks. Managed
// `void deploy` supplies it out-of-band (`manifest.assetConfig`) and marks the
// build child with `VOID_DEPLOY_BUILD`; every other build is a self-hosted
// `vite build && wrangler deploy`, which has to be told that Void generated
// nothing instead of having the setting dropped silently.
//
// The warning must NOT say the setting does nothing. The generated wrapper
// consumes `routing.notFound` and serves through `env.ASSETS`, and
// `mergeBindings` leaves a Class A root wrangler `assets` block untouched, so a
// user who writes a complete policy themselves has a WORKING config and must
// not be told otherwise.
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
    return lines.filter((line) => line.includes('"routing.notFound" in void.json'));
  }

  it('warns once that a self-hosted build generates no policy for routing.notFound', async () => {
    const warnings = notFoundWarnings(await buildTwiceWithNotFound());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tanstack-start');
    expect(warnings[0]).toContain('vite build && wrangler deploy');
    expect(warnings[0]).toContain('void deploy');
  });

  // Guards the correction from PR review: an earlier draft told every self-host
  // build the setting was "inert", which is false for anyone who declares their
  // own complete `assets` policy — Void leaves that policy alone and the wrapper
  // honors it.
  it('does not claim the setting is inert, and names the config that makes it work', async () => {
    const [warning] = notFoundWarnings(await buildTwiceWithNotFound());

    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/\binert\b/);
    for (const field of ['binding', 'directory', 'not_found_handling', 'run_worker_first']) {
      expect(warning).toContain(field);
    }
  });

  it('stays quiet when a managed `void deploy` drives the build', async () => {
    const previous = process.env.VOID_DEPLOY_BUILD;
    process.env.VOID_DEPLOY_BUILD = '1';
    try {
      expect(notFoundWarnings(await buildTwiceWithNotFound())).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env.VOID_DEPLOY_BUILD;
      } else {
        process.env.VOID_DEPLOY_BUILD = previous;
      }
    }
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
