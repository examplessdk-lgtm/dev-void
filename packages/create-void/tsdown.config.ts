import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: false,
  clean: true,
  minify: true,
  deps: {
    onlyBundle: [
      '@clack/prompts',
      '@clack/core',
      'fast-string-truncated-width',
      'fast-string-width',
      'fast-wrap-ansi',
      'sisteransi',
      'picocolors',
    ],
  },
});
