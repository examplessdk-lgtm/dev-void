import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUserEnvFile } from '../../src/host/load-user-env';

/**
 * Coverage for the jiti-based env.ts loader.
 *
 * The motivating bug: a user env.ts that imports from a tsconfig path
 * alias (e.g. `@shared/env-keys`) used to fail with `Cannot find package
 * '@shared'` because Node's bare `import()` ignores tsconfig paths. These
 * tests pin the new loader to the contract: aliases resolve, and repeat
 * loads re-evaluate the file (HMR semantics).
 *
 * Capture pattern: the user fixture writes an evaluation marker to a
 * sentinel file. We use that to assert the file ran. We avoid asserting
 * against `_getRegisteredSchema()` here because jiti loads modules in its
 * own CJS-shimmed instance, so the env-public singleton it touches is a
 * different module instance from the one this test file imports directly.
 * The end-to-end singleton path is exercised by `env-cli.test.ts`
 * (subprocess) and `plugin-env-schema.test.ts`.
 */

const roots: string[] = [];

function createTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-load-user-env-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('loadUserEnvFile', () => {
  it('resolves tsconfig path aliases when env.ts imports from them', async () => {
    const root = createTempProject();
    const sentinel = join(root, 'sentinel.txt');
    // tsconfig with the classic `@shared/*` alias — this is what Node's
    // bare import() can't resolve.
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@shared/*': ['./shared/*'] },
        },
      }),
    );
    mkdirSync(join(root, 'shared'), { recursive: true });
    writeFileSync(
      join(root, 'shared', 'env-keys.ts'),
      'export const STRIPE_KEY = "STRIPE_KEY" as const;\n' +
        'export const PUBLIC_URL = "PUBLIC_URL" as const;\n',
    );
    writeFileSync(
      join(root, 'env.ts'),
      'import { writeFileSync } from "node:fs";\n' +
        'import { STRIPE_KEY, PUBLIC_URL } from "@shared/env-keys";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, [STRIPE_KEY, PUBLIC_URL].join(","));\n`,
    );

    await loadUserEnvFile(join(root, 'env.ts'));

    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf-8')).toBe('STRIPE_KEY,PUBLIC_URL');
  });

  it('resolves an exact-match (non-wildcard) alias from tsconfig paths', async () => {
    const root = createTempProject();
    const sentinel = join(root, 'sentinel.txt');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@config': ['./config.ts'] },
        },
      }),
    );
    writeFileSync(join(root, 'config.ts'), 'export const APP = "alias-resolved";\n');
    writeFileSync(
      join(root, 'env.ts'),
      'import { writeFileSync } from "node:fs";\n' +
        'import { APP } from "@config";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, APP);\n`,
    );

    await loadUserEnvFile(join(root, 'env.ts'));

    expect(readFileSync(sentinel, 'utf-8')).toBe('alias-resolved');
  });

  it('re-evaluates the file on repeat loads so HMR picks up edits', async () => {
    const root = createTempProject();
    const sentinel = join(root, 'sentinel.txt');
    const envPath = join(root, 'env.ts');

    writeFileSync(
      envPath,
      'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, "first");\n`,
    );
    await loadUserEnvFile(envPath);
    expect(readFileSync(sentinel, 'utf-8')).toBe('first');

    // Edit env.ts — second load must execute the new body, not return a
    // cached evaluation.
    writeFileSync(
      envPath,
      'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, "second");\n`,
    );
    await loadUserEnvFile(envPath);
    expect(readFileSync(sentinel, 'utf-8')).toBe('second');
  });

  it('wraps load failures with the source file path in the error message', async () => {
    const root = createTempProject();
    const envPath = join(root, 'env.ts');
    writeFileSync(envPath, 'throw new Error("boom from env.ts");\n');

    await expect(loadUserEnvFile(envPath)).rejects.toThrow(
      /Failed to load.*env\.ts.*boom from env\.ts/s,
    );
  });

  it('works without a tsconfig.json (falls back to plain Node resolution)', async () => {
    const root = createTempProject();
    const sentinel = join(root, 'sentinel.txt');
    // No tsconfig — env.ts uses only built-in Node modules.
    writeFileSync(
      join(root, 'env.ts'),
      'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, "no-tsconfig-ok");\n`,
    );

    await loadUserEnvFile(join(root, 'env.ts'));

    expect(readFileSync(sentinel, 'utf-8')).toBe('no-tsconfig-ok');
  });
});
