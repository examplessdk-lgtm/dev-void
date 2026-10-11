import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

describe('client package exports', () => {
  it('publishes framework-specific client subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
    );

    expect(Object.keys(packageJson.exports)).toEqual(
      expect.arrayContaining([
        './client/react',
        './client/vue',
        './client/svelte',
        './client/solid',
      ]),
    );
  });
});
