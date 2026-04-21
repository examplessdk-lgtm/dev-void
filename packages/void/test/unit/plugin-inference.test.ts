import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { voidPlugin } from '../../src/index';
import { inferProjectBindings, detectFramework } from '../../src/plugin-inference';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-inference-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function writeCompatConfig(root: string): void {
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
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

describe('inferProjectBindings', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('infers bindings from src/main.ssr.tsx', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'main.ssr.tsx'),
      `
      export async function render(request, env) {
        await env.KV.put("k", "v");
        return new Response("ok");
      }
      `,
    );

    expect(inferProjectBindings(root)).toEqual({
      needsD1: false,
      needsKV: true,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });
  });

  it('detects auth from void/client import with auth specifier in src/', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "void/client";
      export default function App() {
        auth.signIn;
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('detects auth from void/auth import in routes/', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'routes', 'api', 'profile.ts'),
      `
      import { requireAuth } from "void/auth";
      export const GET = (c) => {
        const user = requireAuth(c);
        return { user };
      };
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('does not detect auth from void/client with only fetch', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { fetch } from "void/client";
      export default function App() {
        fetch("/api/hello");
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(false);
  });

  it('detects bindings from pages/ .server.ts files', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'index.server.ts'),
      `
      import { db } from "void/db";
      export function loader() {
        return db.select().from(users);
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(true);
  });

  it('does not scan src/ twice in framework mode', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "void/client";
      `,
    );

    // When scanDirs already includes "src", it should not double-scan
    const result = inferProjectBindings(root, undefined, ['src', 'routes']);
    expect(result.needsAuth).toBe(true);
  });

  it('detects bindings from .astro frontmatter', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'pages', 'smoke.astro'),
      `---
import { db } from "void/db";
import { kv } from "void/kv";
const row = await Astro.locals.runtime.env.DB.prepare("SELECT 1").first();
---
<h1>{row ? "ok" : "none"}</h1>
`,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
  });

  it('ignores env.* references outside Astro frontmatter', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'pages', 'index.astro'),
      `
<script>
  console.log(env.DB);
</script>
`,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
  });
});

describe('detectFramework', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vinext-pages when no app/ directory', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vinext: '^0.0.5', react: '^19.0.0' } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: 'vinext-pages', class: 'a' });
  });

  it('detects vinext-app when app/ directory exists', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'app'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vinext: '^0.0.5', react: '^19.0.0' } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: 'vinext-app', class: 'a' });
  });

  it('detects vinext-pages from devDependencies', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vinext: '^0.0.5' } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: 'vinext-pages', class: 'a' });
  });

  it('lets framework-mode configResolved run without touching websocket TDZ state', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { astro: '^5.0.0' } }),
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const wranglerSyncPlugin = plugins.find((plugin) => plugin.name === 'void:wrangler-sync');
      const configResolved = wranglerSyncPlugin?.configResolved;
      const handler =
        typeof configResolved === 'function' ? configResolved : configResolved?.handler;

      expect(wranglerSyncPlugin).toBeTruthy();
      expect(handler).toBeTypeOf('function');
      expect(() =>
        handler?.call({} as never, { command: 'serve' } as import('vite').ResolvedConfig),
      ).not.toThrow();
    } finally {
      cwd.mockRestore();
    }
  });

  it('externalizes Cloudflare builtins for default worker builds', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const externalPlugin = plugins.find(
        (plugin) => plugin.name === 'void:cloudflare-builtins-external',
      );
      const config = getHookHandler(externalPlugin?.config) as (
        this: object,
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => import('vite').UserConfig | void;

      expect(externalPlugin).toBeTruthy();
      const result = config.call(
        {} as never,
        {},
        {
          command: 'build',
          mode: 'production',
        },
      );

      const rootExternal = result?.build?.rollupOptions?.external as Array<unknown>;
      expect(rootExternal).toBeTruthy();
      expect(
        rootExternal.some((value) => value instanceof RegExp && value.test('cloudflare:workers')),
      ).toBe(true);
      expect(result?.environments).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });

  it('includes Cloudflare builtin externalization for class A frameworks', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@tanstack/react-start': '^1.0.0' } }),
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const externalPlugin = plugins.find(
        (plugin) => plugin.name === 'void:cloudflare-builtins-external',
      );
      const config = getHookHandler(externalPlugin?.config) as (
        this: object,
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => import('vite').UserConfig | void;

      expect(externalPlugin).toBeTruthy();

      const result = config.call({} as never, {}, { command: 'build', mode: 'production' });
      const rootExternal = result?.build?.rollupOptions?.external as Array<unknown>;
      expect(rootExternal).toBeTruthy();
      expect(
        rootExternal.some((value) => value instanceof RegExp && value.test('cloudflare:workers')),
      ).toBe(true);
      expect(result?.environments).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });

  it('externalizes Cloudflare builtins for class B/C server builds', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const externalPlugin = plugins.find(
        (plugin) => plugin.name === 'void:cloudflare-builtins-external',
      );
      const config = getHookHandler(externalPlugin?.config) as (
        this: object,
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => import('vite').UserConfig | void;

      expect(externalPlugin).toBeTruthy();
      const result = config.call({} as never, {}, { command: 'build', mode: 'production' });
      const rootExternal = result?.build?.rollupOptions?.external as Array<unknown>;
      expect(rootExternal).toBeTruthy();
      expect(
        rootExternal.some((value) => value instanceof RegExp && value.test('cloudflare:workers')),
      ).toBe(true);
      expect(result?.environments).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });

  it('does not add Cloudflare builtin externalization for node targets', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      expect(plugins.some((plugin) => plugin.name === 'void:cloudflare-builtins-external')).toBe(
        false,
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('warns when routing.fallbacks is configured on a non-default target', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({
        target: 'node',
        routing: {
          fallbacks: {
            '/app/*': '/index.html',
            '/docs/*': '/docs/index.html',
          },
        },
      }),
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    // voidWarn writes via console.log (with ANSI yellow), not console.warn.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      voidPlugin();
      const calls = logSpy.mock.calls.map((c) => String(c[0] ?? ''));
      const joined = calls.join('\n');
      expect(joined).toContain('"routing.fallbacks"');
      expect(joined).toContain('default target');
      expect(joined).toContain('2 rule(s)');
      expect(joined).toContain('target="node"');
    } finally {
      logSpy.mockRestore();
      cwd.mockRestore();
    }
  });

  it('does not warn about fallbacks when target is the default', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    // Overwrite with a config that includes fallbacks but leaves target unset (default target).
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({
        worker: { compatibility_date: '2026-02-24' },
        routing: { fallbacks: { '/app/*': '/index.html' } },
      }),
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      voidPlugin();
      const joined = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(joined).not.toContain('"routing.fallbacks"');
    } finally {
      logSpy.mockRestore();
      cwd.mockRestore();
    }
  });

  it('does not warn when fallbacks is absent on a non-default target', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      voidPlugin();
      const joined = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(joined).not.toContain('"routing.fallbacks"');
    } finally {
      logSpy.mockRestore();
      cwd.mockRestore();
    }
  });
});
