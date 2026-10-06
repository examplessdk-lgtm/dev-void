import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { envClientFoldPlugin } from '../../src/plugin-env-client-fold.ts';
import { envSchemaPlugin } from '../../src/plugin-env-schema.ts';

/**
 * Integration coverage for the auto-discovery path of `envSchemaPlugin`.
 * Unit tests already cover `findEnvFile` and `generateEnvTypes` in isolation;
 * here we assert the plugin's `config()` hook glues them together correctly
 * (finds env.ts at the root, writes `.void/env.d.ts`, and produces content
 * that augments both `void/env` and `void/handler`). A silent regression in
 * this path would leave users without typed `env.X` / `c.env.X` access even
 * though `env.ts` exists.
 */

const roots: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-plugin-env-'));
  roots.push(root);
  return root;
}

async function runConfig(plugin: ReturnType<typeof envSchemaPlugin>): Promise<void> {
  const hook = plugin.config as unknown;
  if (typeof hook === 'function') {
    // The hook is called by vite with (config, env) — pass stubs.
    await (hook as (c: unknown, e: unknown) => unknown).call({}, {}, { mode: 'development' });
    return;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    const handler = (hook as { handler: (c: unknown, e: unknown) => unknown }).handler;
    await handler.call({}, {}, { mode: 'development' });
  }
}

async function runConfigResolved(
  plugin: ReturnType<typeof envSchemaPlugin>,
  resolved: Record<string, unknown>,
): Promise<void> {
  const hook = plugin.configResolved as unknown;
  if (typeof hook === 'function') {
    await (hook as (c: unknown) => unknown).call({}, resolved);
    return;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    const handler = (hook as { handler: (c: unknown) => unknown }).handler;
    await handler.call({}, resolved);
  }
}

async function buildEntry(root: string, config: { envDir?: string } = {}): Promise<string> {
  const output = await build({
    ...config,
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [envSchemaPlugin(root)],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: join(root, 'entry.js'), preserveEntrySignatures: 'strict' },
    },
  });
  return [output]
    .flat()
    .flatMap((result) => ('output' in result ? result.output : []))
    .map((chunk) => ('code' in chunk ? chunk.code : ''))
    .join('\n');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('envSchemaPlugin auto-discovery', () => {
  it.each([undefined, 'Build shell'])(
    'folds settled production values after concurrent config hooks (shell: %s)',
    async (shellValue) => {
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      const root = createTempRoot();
      writeFileSync(join(root, 'env.ts'), 'export default {};\n');
      writeFileSync(join(root, '.env'), 'VITE_TITLE=Local only\n');
      vi.stubEnv('VITE_TITLE', shellValue);
      defineEnv({ VITE_TITLE: string().default('Production default') });

      const fold = envClientFoldPlugin();
      const resolved = await resolveConfig(
        { root, configFile: false, plugins: [envSchemaPlugin(root), fold] },
        'build',
      );
      const transform = fold.transform as unknown as (
        this: { environment: { name: string } },
        code: string,
        id: string,
      ) => Promise<{ code: string }>;
      const result = await transform.call(
        { environment: { name: 'client' } },
        'import { env } from "void/env"; export const title = env.VITE_TITLE;',
        join(root, 'client.ts'),
      );

      const expected = shellValue ?? 'Production default';
      expect(resolved.env.VITE_TITLE).toBe(expected);
      expect(result.code).toContain(JSON.stringify(expected));
      expect(result.code).not.toContain('Local only');
    },
  );

  it('writes .void/env.d.ts when env.ts exists at the project root', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ STRIPE_KEY: string(), PUBLIC_URL: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const dtsPath = join(root, '.void', 'env.d.ts');
    expect(existsSync(dtsPath)).toBe(true);

    const dts = readFileSync(dtsPath, 'utf-8');
    // Top-level export makes this a module augmentation (required; see the
    // "declare module augmentation requires `export {}`" pitfall in AGENTS.md).
    expect(dts).toContain('export {}');
    // Augments both public type surfaces — env proxy and Hono c.env bindings.
    expect(dts).toContain('declare module "void/env"');
    expect(dts).toContain('declare module "void/handler"');
    expect(dts).toContain('interface ValidatedEnv extends _VoidEnvShape');
    expect(dts).toContain('interface CloudBindings extends _VoidEnvShape');
    // Generated import path is relative from .void/ back to env.ts.
    expect(dts).toContain('typeof import("../env.ts")');
  });

  it('discovers env.ts nested under src/ and resolves the import path correctly', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ API_KEY: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const dts = readFileSync(join(root, '.void', 'env.d.ts'), 'utf-8');
    // Relative path from .void/ to src/env.ts.
    expect(dts).toContain('typeof import("../src/env.ts")');
  });

  it('is a no-op when no env.ts exists (no .void/env.d.ts is written)', async () => {
    const root = createTempRoot();

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    expect(existsSync(join(root, '.void', 'env.d.ts'))).toBe(false);
  });

  it('rejects legacy dotenv variants when env.ts exists', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    writeFileSync(join(root, '.env.production'), 'API_URL=https://example.com\n');

    await expect(runConfig(envSchemaPlugin(root))).rejects.toThrow('supports one local file: .env');
  });

  it('removes local .env client values from production builds', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    writeFileSync(join(root, '.env'), 'VITE_TITLE=Local only\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({ VITE_TITLE: string() });
    const resolved = {
      command: 'build',
      mode: 'production',
      envDir: root,
      envPrefix: 'VITE_',
      env: { VITE_TITLE: 'Local only' },
      define: {},
    };

    await expect(runConfigResolved(plugin, resolved)).rejects.toThrow('VITE_TITLE is required');
    expect(resolved.env.VITE_TITLE).toBeUndefined();
  });

  it('keeps every local .env client value out of a production client build', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, '.env'),
      [
        'export VITE_B=local-export',
        // Vite drops the inline comment, so its value differs from Void's.
        'VITE_C=local-comment # note',
        'VITE_D=local-plain',
        // Vite reads this key; Void's own parser skips it.
        'VITE_E.F=local-dot',
        'MODE=local-mode',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'entry.js'), 'export const env = import.meta.env;\n');
    for (const key of ['VITE_B', 'VITE_C', 'VITE_D', 'VITE_E.F', 'MODE']) {
      vi.stubEnv(key, undefined);
    }

    const code = await buildEntry(root);

    expect(code).not.toContain('local-');
    expect(code).toContain('"production"');
  });

  it('keeps a shell value for a key that is also in .env', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'VITE_API=local-api\n');
    writeFileSync(join(root, 'entry.js'), 'export const api = import.meta.env.VITE_API;\n');
    vi.stubEnv('VITE_API', 'shell-api');

    const code = await buildEntry(root);

    expect(code).toContain('"shell-api"');
    expect(code).not.toContain('local-api');
  });

  it('keeps values Vite loads from another envDir', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'envs'));
    writeFileSync(join(root, '.env'), 'VITE_API=local-api\n');
    writeFileSync(join(root, 'envs', '.env.production'), 'VITE_API=prod-api\n');
    writeFileSync(join(root, 'entry.js'), 'export const api = import.meta.env.VITE_API;\n');
    vi.stubEnv('VITE_API', undefined);

    const code = await buildEntry(root, { envDir: 'envs' });

    expect(code).toContain('"prod-api"');
  });

  it('reports server and required names without values', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({
      API_TOKEN: string(),
      OPTIONAL_REGION: string().optional(),
      VITE_TITLE: string(),
    });
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    const facts: Array<unknown> = [];

    const plugin = envSchemaPlugin(root, { onSchema: (value) => facts.push(value) });
    const configHook = plugin.config as (config: Record<string, unknown>, env: unknown) => unknown;
    await configHook.call({}, { envPrefix: 'PUBLIC_' }, { mode: 'production' });

    expect(facts.at(-1)).toEqual({
      keys: ['API_TOKEN', 'OPTIONAL_REGION', 'VITE_TITLE'],
      clientKeys: ['VITE_TITLE'],
      serverKeys: ['API_TOKEN', 'OPTIONAL_REGION'],
      requiredServerKeys: ['API_TOKEN'],
    });
  });

  // The define-overlap warning runs in `configResolved`. We register the
  // schema directly via `defineEnv` (rather than through a temp env.ts loaded
  // by jiti) so the singleton the plugin reads matches the one the test
  // mutated — jiti's own module instance is invisible to vitest imports.
  it('warns when vite `define` shadows a schema env key', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({ STRIPE_KEY: string(), VITE_TITLE: string() });

    const root = createTempRoot();
    writeFileSync(
      join(root, 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ STRIPE_KEY: string(), VITE_TITLE: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin); // sets envFile so configResolved emits the warning

    // voidWarn writes via console.log (with ANSI yellow), not console.warn.
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigResolved(plugin, {
      mode: 'development',
      envDir: root,
      define: {
        'process.env.STRIPE_KEY': '"shadowed"',
        'import.meta.env.VITE_TITLE': '"hello"',
        // unrelated define — should not be flagged
        __BUILD_VERSION__: '"1.2.3"',
      },
    });

    const calls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    warnSpy.mockRestore();
    const joined = calls.join('\n');
    expect(joined).toContain('shadowing schema env keys');
    expect(joined).toContain('STRIPE_KEY');
    expect(joined).toContain('VITE_TITLE');
    expect(joined).not.toContain('__BUILD_VERSION__');
  });

  it('does not warn when define has no overlap with the schema', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({ STRIPE_KEY: string() });

    const root = createTempRoot();
    writeFileSync(
      join(root, 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ STRIPE_KEY: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigResolved(plugin, {
      mode: 'development',
      envDir: root,
      define: {
        'process.env.UNRELATED': '"x"',
        __BUILD_VERSION__: '"1.2.3"',
      },
    });

    const calls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    warnSpy.mockRestore();
    const joined = calls.join('\n');
    expect(joined).not.toContain('shadowing schema env keys');
  });

  it('adds client-exposed schema defaults to Vite env', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { number, string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({ VITE_GIT_SHA: string().default('abc123'), PORT: number().default(3000) });

    const resolved = {
      mode: 'development',
      envDir: root,
      envPrefix: 'VITE_',
      env: {},
      define: {},
    };
    await runConfigResolved(plugin, resolved);

    expect(resolved.env).toEqual({ VITE_GIT_SHA: 'abc123' });
    expect('PORT' in resolved.env).toBe(false);
  });

  it('does not overwrite a Vite env value with a schema default', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({ VITE_TITLE: string().default('Default') });

    const resolved = {
      mode: 'development',
      envDir: root,
      envPrefix: 'VITE_',
      env: { VITE_TITLE: 'FromEnv' },
      define: {},
    };
    await runConfigResolved(plugin, resolved);

    expect(resolved.env.VITE_TITLE).toBe('FromEnv');
  });

  it('uses VITE_ even when Vite has a custom envPrefix', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({
      PUBLIC_TITLE: string().default('Public'),
      VITE_TITLE: string().default('Vite'),
    });

    const resolved = {
      mode: 'development',
      envDir: root,
      envPrefix: ['PUBLIC_'],
      env: {},
      define: {},
    };
    await runConfigResolved(plugin, resolved);

    expect(resolved.env).toEqual({ VITE_TITLE: 'Vite' });
  });
});

describe('envSchemaPlugin reserved __VOID_ names', () => {
  async function runConfigFor(root: string, command: 'serve' | 'build'): Promise<void> {
    const handler = envSchemaPlugin(root).config as (c: unknown, e: unknown) => Promise<void>;
    await handler.call(
      {},
      {},
      { command, mode: command === 'build' ? 'production' : 'development' },
    );
  }

  afterEach(async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    defineEnv({});
  });

  for (const command of ['serve', 'build'] as const) {
    for (const withEnvTs of [false, true]) {
      it.each(['__VOID_PROXY_TOKEN', '__VOID_EMAIL_FROM'])(
        `rejects %s in .env (${command}, env.ts: ${withEnvTs})`,
        async (key) => {
          const root = createTempRoot();
          if (withEnvTs) {
            writeFileSync(join(root, 'env.ts'), 'export default {};\n');
          }
          writeFileSync(join(root, '.env'), `API_URL=http://localhost\n${key}=local\n`);

          await expect(runConfigFor(root, command)).rejects.toThrow(
            `.env defines names reserved for Void: ${key}. Void sets these itself; remove them. ` +
              'To trigger crons or queues locally, use the x-void-dev-trigger header printed at dev start.',
          );
        },
      );
    }

    // Wrangler loads these forms into the dev Worker too.
    it.each([
      ['export __VOID_PROXY_TOKEN=x', '__VOID_PROXY_TOKEN'],
      ['__VOID_EMAIL_FROM: a@b.c', '__VOID_EMAIL_FROM'],
    ])(`rejects the Wrangler-only line %s in .env (${command})`, async (line, key) => {
      const root = createTempRoot();
      writeFileSync(join(root, '.env'), `API_URL=http://localhost\n${line}\n`);

      await expect(runConfigFor(root, command)).rejects.toThrow(
        `.env defines names reserved for Void: ${key}.`,
      );
    });

    it(`ignores __VOID_ in a comment or a value (${command})`, async () => {
      const root = createTempRoot();
      writeFileSync(
        join(root, '.env'),
        '# __VOID_X=1\nAPI_URL=http://localhost/__VOID_X\nNOTE: __VOID_Y=2\n',
      );

      await expect(runConfigFor(root, command)).resolves.toBeUndefined();
    });

    it(`accepts a normal .env and a reserved name set only in the shell (${command})`, async () => {
      const root = createTempRoot();
      writeFileSync(join(root, '.env'), 'API_URL=http://localhost\n');
      vi.stubEnv('__VOID_PROXY_TOKEN', 'from-shell');

      await expect(runConfigFor(root, command)).resolves.toBeUndefined();
    });

    it(`rejects a reserved name declared in env.ts (${command})`, async () => {
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      const root = createTempRoot();
      writeFileSync(join(root, 'env.ts'), 'export default {};\n');
      defineEnv({ API_URL: string(), __VOID_X: string().optional() });

      await expect(runConfigFor(root, command)).rejects.toThrow(
        'env.ts declares names reserved for Void: __VOID_X.',
      );
    });
  }
});
