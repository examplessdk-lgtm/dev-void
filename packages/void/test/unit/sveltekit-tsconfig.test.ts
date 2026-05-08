import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { mergeVoidSvelteKitTsconfig, withVoidTSConfig } from '../../src/sveltekit.ts';

const TMP = join(import.meta.dirname, '.tmp-sveltekit-tsconfig-test');

beforeEach(() => {
  mkdirSync(join(TMP, '.void'), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('mergeVoidSvelteKitTsconfig', () => {
  it('merges Void files and paths into SvelteKit generated config', () => {
    writeFileSync(
      join(TMP, '.void', 'tsconfig.json'),
      JSON.stringify(
        {
          files: ['db.d.ts', 'env.d.ts'],
          compilerOptions: {
            paths: {
              'void/db': ['./db.d.ts'],
              '@schema': ['../db/schema.ts'],
              '@schema/*': ['../db/schema/*'],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = mergeVoidSvelteKitTsconfig(
      {
        compilerOptions: {
          paths: {
            '$app/types': ['./types/index.d.ts'],
          },
        },
        files: ['ambient.d.ts'],
      },
      { root: TMP },
    );

    expect(config.files).toEqual(['ambient.d.ts', '../.void/db.d.ts', '../.void/env.d.ts']);
    expect((config.compilerOptions as { paths?: Record<string, Array<string>> }).paths).toEqual({
      '$app/types': ['./types/index.d.ts'],
      'void/db': ['../.void/db.d.ts'],
      '@schema': ['../db/schema.ts'],
      '@schema/*': ['../db/schema/*'],
    });
  });

  it('is a no-op when Void tsconfig has not been generated yet', () => {
    rmSync(join(TMP, '.void'), { recursive: true, force: true });
    const config = { compilerOptions: { paths: { '$app/types': ['./types/index.d.ts'] } } };

    expect(mergeVoidSvelteKitTsconfig(config, { root: TMP })).toBe(config);
    expect(config).toEqual({
      compilerOptions: { paths: { '$app/types': ['./types/index.d.ts'] } },
    });
  });

  it('composes with an existing SvelteKit tsconfig hook', () => {
    writeFileSync(
      join(TMP, '.void', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          paths: {
            'void/db': ['./db.d.ts'],
          },
        },
      }),
    );

    const hook = withVoidTSConfig(
      (config) => {
        config.files = ['custom.d.ts'];
      },
      { root: TMP },
    );

    expect(hook({})).toEqual({
      files: ['custom.d.ts'],
      compilerOptions: {
        paths: {
          'void/db': ['../.void/db.d.ts'],
        },
      },
    });
  });
});
