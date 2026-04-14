import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/plugin.ts',
    'src/runtime/index.ts',
    'src/runtime/use-deferred.ts',
    'src/runtime/prefetch.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  external: ['vue', 'vue/server-renderer', 'vite', 'void', 'void/*', '@vitejs/plugin-vue'],
});
