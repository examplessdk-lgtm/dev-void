import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';

type PackageExport = {
  default?: string;
  types?: string;
};

describe('@void/solid package types', () => {
  it('publishes built declarations while retaining transformable runtime source', () => {
    const packageRoot = join(import.meta.dirname, '../..');
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
      exports: Record<string, PackageExport>;
    };

    expect(manifest.exports['.']).toEqual({
      types: './dist/runtime/index.d.mts',
      default: './src/runtime/index.ts',
    });
    const buildConfig = readFileSync(join(packageRoot, 'vite.config.ts'), 'utf-8');
    for (const entry of ['src/runtime/index.ts', 'src/runtime/context.ts']) {
      expect(buildConfig).toContain(`'${entry}'`);
    }
  });
});
