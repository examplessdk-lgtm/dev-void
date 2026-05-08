import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/plugin.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        'solid-js',
        'solid-js/web',
        'solid-js/store',
        'vite',
        'void',
        'void/*',
        'vite-plugin-solid',
      ],
    },
  },
});
