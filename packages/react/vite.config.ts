import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: [
      'src/index.ts',
      'src/plugin.ts',
      'src/runtime/index.ts',
      'src/runtime/prefetch.ts',
      'src/runtime/pages-client.ts',
      'src/runtime/pages-server.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/server',
        'react-dom/client',
        'vite',
        'void',
        'void/*',
        '@vitejs/plugin-react',
      ],
    },
  },
});
