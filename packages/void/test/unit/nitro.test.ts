import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toSlash } from 'pathslash';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import voidNitroModule from '../../src/nitro.ts';
import { db } from '../../src/runtime/db.ts';
import { getRuntimeRequestResource, withRuntimeEnv } from '../../src/runtime/env.ts';

const roots: Array<string> = [];
const envModuleFile = fileURLToPath(import.meta.resolve('#self/_env'));

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete (globalThis as { __env__?: unknown }).__env__;
});

function createApp(database: 'pg' | 'mysql' | 'd1'): string {
  const root = mkdtempSync(join(tmpdir(), 'void-nitro-'));
  roots.push(root);
  writeFileSync(join(root, 'void.json'), JSON.stringify(database === 'd1' ? {} : { database }));
  mkdirSync(join(root, 'db'));
  writeFileSync(join(root, 'db', 'schema.ts'), 'export const users = {};\n');
  return root;
}

type NitroOptions = {
  dev: boolean;
  rootDir: string;
  buildDir: string;
  exportConditions: Array<string>;
  plugins: Array<string>;
  virtual: Record<string, string | (() => string | Promise<string>)>;
  rollupConfig: { plugins?: unknown };
};

/** Run the module against the options of a Nitro Worker build. */
function setUp(root: string, options: { dev: boolean; plugins?: unknown }): NitroOptions {
  const nitro = {
    options: {
      dev: options.dev,
      rootDir: root,
      buildDir: join(root, '.nitro'),
      exportConditions: ['workerd'],
      plugins: [],
      virtual: {},
      rollupConfig: { plugins: options.plugins },
    } as NitroOptions,
  };
  voidNitroModule.setup(nitro);
  return nitro.options;
}

type ResolveResult = string | { id: string; external?: boolean } | null | undefined;

// Nitro's Rollup calls the hooks as plain functions, with its plugin context as `this`.
const context = {
  async resolve(source: string): Promise<{ id: string }> {
    return { id: source };
  },
};

function resolve(plugin: Plugin, id: string, importer: string): Promise<ResolveResult> {
  return (plugin.resolveId as (id: string, importer: string) => Promise<ResolveResult>).call(
    context,
    id,
    importer,
  );
}

describe('void/nitro', () => {
  it("serves the app's void/db and @schema before Nitro's own plugins", async () => {
    const root = createApp('pg');
    const existing = { name: 'existing' };
    const options = setUp(root, { dev: true, plugins: existing });
    const [plugin, ...rest] = options.rollupConfig.plugins as Array<Plugin>;
    expect(rest).toEqual([existing]);

    const route = join(root, 'server', 'api', 'users.ts');
    const schema = toSlash(join(root, 'db', 'schema.ts'));
    const id = await resolve(plugin!, 'void/db', route);
    const code = (plugin!.load as (id: string) => string | null)(id as string);
    expect(code).toMatch(/drizzle-orm[\\/]+node-postgres/);
    expect(code).toContain(JSON.stringify(schema));
    expect(await resolve(plugin!, '@schema', route)).toEqual({ id: schema });
    // Development runs in Node, which loads the driver itself.
    expect(await resolve(plugin!, 'pg', route)).toBeNull();
  });

  it('serves a workerd build of the driver to a Worker build', async () => {
    const root = createApp('mysql');
    const [plugin, asyncHooks] = setUp(root, { dev: false }).rollupConfig.plugins as Array<Plugin>;
    const route = join(root, 'server', 'api', 'users.ts');

    const driver = await resolve(plugin!, 'mysql2', route);
    expect(typeof driver).toBe('string');
    expect(existsSync(driver as string)).toBe(true);
    expect(readFileSync(driver as string, 'utf8')).toContain('export {');
    // The driver and Void's request scope keep workerd's Node modules instead of Nitro's stubs.
    expect(await resolve(plugin!, 'node:net', driver as string)).toEqual({
      id: 'node:net',
      external: true,
    });
    expect(await resolve(asyncHooks!, 'node:async_hooks', envModuleFile)).toEqual({
      id: 'node:async_hooks',
      external: true,
    });
    expect(await resolve(asyncHooks!, 'node:async_hooks', route)).toBeNull();
  });

  it('runs each PostgreSQL or MySQL request in one Void request scope', async () => {
    const options = setUp(createApp('pg'), { dev: true });
    expect(options.plugins).toHaveLength(1);
    const source = options.virtual[options.plugins[0]!] as string;
    const pluginFile = join(roots[0]!, 'request-scope.mjs');
    writeFileSync(
      pluginFile,
      source.replace(
        JSON.stringify(envModuleFile),
        JSON.stringify(pathToFileURL(envModuleFile).href),
      ),
    );
    const { default: requestScope } = (await import(pathToFileURL(pluginFile).href)) as {
      default: (nitroApp: { h3App: { handler: (event: string) => Promise<unknown> } }) => void;
    };

    const key = {};
    const nitroApp = {
      h3App: {
        // A route that reads its request's resource before and after an await.
        async handler(event: string) {
          const first = getRuntimeRequestResource(key, () => ({ event }));
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [first, getRuntimeRequestResource(key, () => ({ event }))];
        },
      },
    };
    requestScope(nitroApp);
    // A dev plugin can set a promise of the env before the env itself.
    (globalThis as { __env__?: unknown }).__env__ = Promise.resolve({ DATABASE_URL: 'x' });

    const [a, b] = (await Promise.all([
      nitroApp.h3App.handler('a'),
      nitroApp.h3App.handler('b'),
    ])) as Array<[object, object]>;
    expect(a[1]).toBe(a[0]);
    expect(b[1]).toBe(b[0]);
    expect(a[0]).toEqual({ event: 'a' });
    expect(b[0]).toEqual({ event: 'b' });
  });

  it('keeps D1 requests and Node modules as Nitro has them', () => {
    const options = setUp(createApp('d1'), { dev: false });
    expect(options.plugins).toEqual([]);
    expect(options.virtual).toEqual({});
    expect(options.rollupConfig.plugins).toHaveLength(1);
  });

  it('tells an app whose bundle skipped the module to add it', () => {
    expect(() =>
      withRuntimeEnv({ HYPERDRIVE: { connectionString: 'postgresql://db/app' } }, () => db.select),
    ).toThrow("add 'void/nitro' to the Nitro modules");
  });
});
