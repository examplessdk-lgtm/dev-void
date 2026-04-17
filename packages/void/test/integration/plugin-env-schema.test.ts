import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envSchemaPlugin } from '../../src/plugin-env-schema';

/**
 * Integration coverage for the auto-discovery path of `envSchemaPlugin`.
 * Unit tests already cover `findEnvFile` and `generateEnvTypes` in isolation;
 * here we assert the plugin's `config()` hook glues them together correctly
 * (finds env.ts at the root, writes `.void/env.d.ts`, and produces content
 * that augments both `void/env` and `void/handler`). A silent regression in
 * this path would leave users without typed `env.X` / `c.env.X` access even
 * though `env.ts` exists.
 */

const roots: string[] = [];

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
    // Generated import path is relative from .void/ back to env.ts, extension stripped.
    expect(dts).toContain('typeof import("../env")');
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
    // Relative path from .void/ to src/env → ../src/env.
    expect(dts).toContain('typeof import("../src/env")');
  });

  it('is a no-op when no env.ts exists (no .void/env.d.ts is written)', async () => {
    const root = createTempRoot();

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    expect(existsSync(join(root, '.void', 'env.d.ts'))).toBe(false);
  });
});
