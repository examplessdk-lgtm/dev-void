import { describe, expect, it } from 'vite-plus/test';
import { shouldCopyPlaygroundPath } from '../../../../test/integration-helpers.ts';

describe('shouldCopyPlaygroundPath', () => {
  it('excludes generated top-level entries from native Windows paths', () => {
    const sourceRoot = String.raw`D:\a\void\void\playground\spa`;

    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\node_modules`)).toBe(
      false,
    );
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\.void`)).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\src\index.ts`)).toBe(true);
  });

  it('only excludes generated entries at the playground root', () => {
    const sourceRoot = '/workspace/playground/spa';

    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/dist`)).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/src/dist/example.ts`)).toBe(true);
  });
});
