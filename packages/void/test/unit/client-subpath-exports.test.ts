import { readFileSync } from 'node:fs';
import { join } from 'pathe';
import { describe, expect, it } from 'vite-plus/test';

describe('client package exports', () => {
  it('publishes framework-specific client subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
    );

    expect(packageJson.exports['./client/react']).toEqual({
      import: './dist/runtime/client-react.mjs',
      require: './dist/runtime/client-react.mjs',
      types: './dist/runtime/client-react.d.mts',
    });
    expect(packageJson.exports['./client/vue']).toEqual({
      import: './dist/runtime/client-vue.mjs',
      require: './dist/runtime/client-vue.mjs',
      types: './dist/runtime/client-vue.d.mts',
    });
    expect(packageJson.exports['./client/svelte']).toEqual({
      import: './dist/runtime/client-svelte.mjs',
      require: './dist/runtime/client-svelte.mjs',
      types: './dist/runtime/client-svelte.d.mts',
    });
    expect(packageJson.exports['./client/solid']).toEqual({
      import: './dist/runtime/client-solid.mjs',
      require: './dist/runtime/client-solid.mjs',
      types: './dist/runtime/client-solid.d.mts',
    });
  });
});
