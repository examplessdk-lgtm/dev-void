import { cpSync } from 'node:fs';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/plugin.ts', 'src/runtime/index.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      neverBundle: ['vite', 'void', 'vue'],
    },
    onSuccess() {
      cpSync('src/theme', 'dist/theme', { recursive: true });
    },
  },
});
