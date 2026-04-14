import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/plugin.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  external: ['svelte', 'svelte/*', 'vite', 'void', 'void/*', '@sveltejs/vite-plugin-svelte'],
});
