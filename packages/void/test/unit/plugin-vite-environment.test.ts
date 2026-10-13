import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createServer, normalizePath, resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { voidPlugin } from '../../src/index.ts';

const roots: Array<string> = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-vite-env-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {},
    }),
  );
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('voidPlugin Vite environments', () => {
  it('does not create void.json during Vite config resolution', async () => {
    const root = createProjectRoot();
    rmSync(join(root, 'void.json'), { force: true });
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
      },
      'serve',
      'development',
    );

    expect(existsSync(join(root, 'void.json'))).toBe(false);
  });

  it('does not claim Vite SSR environments configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await expect(
      resolveConfig(
        {
          root,
          plugins: [voidPlugin()],
          environments: {
            ssr: {
              resolve: {
                external: ['node:fs'],
              },
            },
          },
        },
        'serve',
        'test',
      ),
    ).resolves.toMatchObject({
      environments: {
        void_worker: {
          build: {
            outDir: 'dist/ssr',
          },
        },
      },
    });
  });

  it('clears resolve.external from the worker environment configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
        environments: {
          void_worker: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
            build: {
              emptyOutDir: false,
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.void_worker.resolve.external).toEqual([]);
    expect(config.environments.void_worker.resolve.conditions).toContain('workerd');
    expect(config.environments.void_worker.build).toMatchObject({
      emptyOutDir: false,
      outDir: 'dist/ssr',
    });
  });

  it('clears resolve.external from class A framework worker environments', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          '@tanstack/react-start': '^1.0.0',
        },
      }),
    );

    const config = await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
        environments: {
          ssr: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.ssr.resolve.external).toEqual([]);
    expect(config.environments.ssr.resolve.conditions).toContain('workerd');
  });

  it('prebundles void CommonJS dependencies only in the worker environment', async () => {
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig({ root, plugins: [voidPlugin()] }, 'serve', 'development');

    expect(config.environments.void_worker.optimizeDeps.include).toEqual(
      expect.arrayContaining(['void > email-validator', 'void > pg']),
    );
    expect(config.environments.ssr.optimizeDeps.include).toEqual([]);
  });

  it.each(['before', 'after'])(
    'prebundles them in an adapter-owned workerd environment with Void listed %s it',
    async (order) => {
      const root = createProjectRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { astro: '^7.0.0' } }),
      );
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: 'mysql', worker: { compatibility_date: '2026-02-24' } }),
      );
      writeFileSync(join(root, 'worker.ts'), 'export default {};\n');
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        JSON.stringify({
          name: 'adapter-app',
          main: './worker.ts',
          compatibility_date: '2026-02-24',
        }),
      );
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      // @astrojs/cloudflare runs Astro's ssr environment in workerd this way.
      const adapter = cloudflare({
        configPath: join(root, 'wrangler.jsonc'),
        viteEnvironment: { name: 'ssr' },
      });

      const config = await resolveConfig(
        { root, plugins: order === 'before' ? [voidPlugin(), adapter] : [adapter, voidPlugin()] },
        'serve',
        'development',
      );

      expect(config.environments.ssr.optimizeDeps.include).toEqual(
        expect.arrayContaining(['void > email-validator', 'void > mysql2']),
      );
    },
  );

  it.each([
    ['sveltekit', '@sveltejs/kit', 'serve', true],
    ['sveltekit', '@sveltejs/kit', 'build', false],
    ['nuxt', 'nuxt', 'serve', false],
    ['analog', '@analogjs/platform', 'serve', false],
    ['astro', 'astro', 'serve', false],
  ] as const)(
    'keeps void in the Node SSR graph for %s (%s, %s): %s',
    async (_name, dependency, command, inlined) => {
      const root = createProjectRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { [dependency]: '*' } }),
      );
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const config = await resolveConfig({ root, plugins: [voidPlugin()] }, command, 'development');

      expect(config.ssr.noExternal).toEqual(
        inlined ? expect.arrayContaining(['void']) : expect.not.arrayContaining(['void']),
      );
    },
  );

  it('serves the void/db virtual module to SvelteKit server code from an installed void', async () => {
    // Windows runners report a short-name temp path, which Vite refuses to serve.
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', devDependencies: { '@sveltejs/kit': '*', void: '*' } }),
    );
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
    );
    mkdirSync(join(root, 'db'));
    writeFileSync(
      join(root, 'db/schema.ts'),
      "import { pgTable, serial } from 'void/schema-pg';\nexport const users = pgTable('users', { id: serial('id') });\n",
    );
    // A packed install: Vite externalizes bare SSR imports that resolve into node_modules.
    const installed = join(root, 'node_modules/void');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({
        name: 'void',
        type: 'module',
        exports: { './db': './db.mjs', './_env': './env.mjs', './schema-pg': './schema-pg.mjs' },
      }),
    );
    for (const file of ['db.mjs', 'env.mjs', 'schema-pg.mjs']) {
      writeFileSync(join(installed, file), 'export {};\n');
    }
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src/server.ts'),
      "import { db } from 'void/db';\nimport { withRuntimeEnv } from 'void/_env';\nexport { db, withRuntimeEnv };\n",
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      const result = await server.environments.ssr.transformRequest('/src/server.ts');

      expect(result?.code).toContain('virtual:void-db');
      expect(result?.code).not.toMatch(/__vite_ssr_import__\("void\/(?:db|_env)"/);
    } finally {
      await server.close();
    }
  });

  it('rejects Cloudflare-only imports from an installed void on the Node target dev server', async () => {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', devDependencies: { void: '*' } }),
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));
    const installed = join(root, 'node_modules/void');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: 'void', type: 'module', exports: { './kv': './kv.mjs' } }),
    );
    writeFileSync(join(installed, 'kv.mjs'), 'export const kv = {};\n');
    mkdirSync(join(root, 'routes/api'), { recursive: true });
    writeFileSync(
      join(root, 'routes/api/cache.ts'),
      "import { kv } from 'void/kv';\nexport const GET = () => Response.json({ kv: typeof kv });\n",
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      await expect(
        server.environments.ssr.transformRequest('/routes/api/cache.ts'),
      ).rejects.toThrow("target: 'void/kv' is not available with target 'node'.");
    } finally {
      await server.close();
    }
  });

  // The package entry is the whole Vite plugin; server code needs only its handler helpers.
  it.each([
    ['sveltekit', '@sveltejs/kit', 'ssr', true],
    ['sveltekit', '@sveltejs/kit', 'client', false],
    ['astro', 'astro', 'ssr', false],
  ] as const)(
    'sends bare void from %s %s code in the %s environment to the handler entry: %s',
    async (_name, dependency, environment, redirected) => {
      const root = realpathSync.native(createProjectRoot());
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', devDependencies: { [dependency]: '*', void: '*' } }),
      );
      const installed = join(root, 'node_modules/void');
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, 'package.json'),
        JSON.stringify({ name: 'void', type: 'module', exports: { '.': './index.mjs' } }),
      );
      writeFileSync(join(installed, 'index.mjs'), 'export {};\n');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [voidPlugin()],
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, ws: false, preTransformRequests: false },
      });
      try {
        const resolved = await server.environments[environment]!.pluginContainer.resolveId(
          'void',
          join(root, 'src/hooks.server.ts'),
        );

        expect(resolved?.id).toBe(
          normalizePath(
            redirected
              ? createRequire(import.meta.url).resolve('void/handler')
              : join(installed, 'index.mjs'),
          ),
        );
      } finally {
        await server.close();
      }
    },
  );
});
