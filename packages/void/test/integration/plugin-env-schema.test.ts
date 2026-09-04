import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
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

async function runConfigureServer(plugin: ReturnType<typeof envSchemaPlugin>): Promise<void> {
  const hook = plugin.configureServer as unknown;
  const server = {
    httpServer: undefined,
    watcher: {
      add() {},
      on() {},
    },
    config: {},
    ws: {
      send() {},
    },
  };
  if (typeof hook === 'function') {
    await (hook as (server: unknown) => unknown).call({}, server);
    return;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    const handler = (hook as { handler: (server: unknown) => unknown }).handler;
    await handler.call({}, server);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for asynchronous env validation');
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('envSchemaPlugin auto-discovery', () => {
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

    const { readFileSync } = await import('node:fs');
    const dts = readFileSync(dtsPath, 'utf-8');
    // Top-level export makes this a module augmentation (required; see the
    // "declare module augmentation requires `export {}`" pitfall in CLAUDE.md).
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
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ API_KEY: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const { readFileSync } = await import('node:fs');
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

  it('honours custom envPrefix values when exposing schema defaults', async () => {
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

    expect(resolved.env).toEqual({ PUBLIC_TITLE: 'Public' });
  });

  it('treats initial shell-only schema values as missing during validation', async () => {
    const key = 'VOID_ENV_SCHEMA_SHELL_ONLY_TEST';
    const previous = process.env[key];
    process.env[key] = 'from-shell';

    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    const plugin = envSchemaPlugin(root);

    try {
      await runConfig(plugin);
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      defineEnv({ [key]: string() });
      await runConfigResolved(plugin, {
        mode: 'development',
        envDir: root,
        envPrefix: 'VITE_',
        env: {},
        define: {},
      });

      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runConfigureServer(plugin);
        await waitFor(() =>
          warnSpy.mock.calls.some((call) =>
            String(call[0] ?? '').includes(`${key} is required but missing`),
          ),
        );
        const output = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
        expect(output).toContain('add it to .env.local');
        expect(output).not.toContain('set in your shell');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it('validates post-construction process.env values for framework-owned runtimes', async () => {
    const key = 'VOID_ENV_SCHEMA_FRAMEWORK_DOTENV_TEST';
    const missingKey = 'VOID_ENV_SCHEMA_VALIDATION_SENTINEL';
    const previous = process.env[key];
    const previousMissing = process.env[missingKey];
    delete process.env[key];
    delete process.env[missingKey];

    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    const plugin = envSchemaPlugin(root, { frameworkOwnsRuntimeEnv: true });
    process.env[key] = 'from-framework-dotenv';

    try {
      await runConfig(plugin);
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      defineEnv({ [key]: string(), [missingKey]: string() });
      await runConfigResolved(plugin, {
        mode: 'development',
        envDir: root,
        envPrefix: 'VITE_',
        env: {},
        define: {},
      });

      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runConfigureServer(plugin);
        await waitFor(() =>
          warnSpy.mock.calls.some((call) =>
            String(call[0] ?? '').includes(`${missingKey} is required but missing`),
          ),
        );
        const output = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
        expect(output).not.toContain(`${key} is required but missing`);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
      if (previousMissing === undefined) {
        delete process.env[missingKey];
      } else {
        process.env[missingKey] = previousMissing;
      }
    }
  });

  it('validates the Void-loaded env snapshot after process.env is mutated', async () => {
    const key = 'VOID_ENV_SCHEMA_WORKER_ENV_TEST';
    const missingKey = 'VOID_ENV_SCHEMA_WORKER_ENV_SENTINEL';
    const previous = process.env[key];
    delete process.env[key];

    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    const loadedUserEnv = { [key]: 'from-dotenv' };
    const plugin = envSchemaPlugin(root, { getValidationEnv: () => loadedUserEnv });

    try {
      await runConfig(plugin);
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      defineEnv({ [key]: string(), [missingKey]: string() });
      await runConfigResolved(plugin, {
        mode: 'development',
        envDir: root,
        envPrefix: 'VITE_',
        env: {},
        define: {},
      });

      // Simulate a later framework/plugin copying the dotenv value into the
      // process environment after Void captured its worker-vars snapshot.
      process.env[key] = loadedUserEnv[key];

      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runConfigureServer(plugin);
        await waitFor(() =>
          warnSpy.mock.calls.some((call) =>
            String(call[0] ?? '').includes(`${missingKey} is required but missing`),
          ),
        );
        const output = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
        expect(output).not.toContain(`${key} is required but missing`);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it('excludes post-construction process.env values for Void-owned runtimes', async () => {
    const key = 'VOID_ENV_SCHEMA_POST_CONSTRUCTION_SHELL_TEST';
    const previous = process.env[key];
    delete process.env[key];

    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    const plugin = envSchemaPlugin(root);
    process.env[key] = 'from-earlier-plugin';

    try {
      await runConfig(plugin);
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      defineEnv({ [key]: string() });
      await runConfigResolved(plugin, {
        mode: 'development',
        envDir: root,
        envPrefix: 'VITE_',
        env: {},
        define: {},
      });

      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runConfigureServer(plugin);
        await waitFor(() =>
          warnSpy.mock.calls.some((call) =>
            String(call[0] ?? '').includes(`${key} is required but missing`),
          ),
        );
        const output = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
        expect(output).toContain(`${key} is required but missing`);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
});
