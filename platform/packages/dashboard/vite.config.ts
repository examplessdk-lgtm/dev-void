import { resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    tailwind(),
    voidPlugin({
      persistTo: resolve(__dirname, '../api/.wrangler/state'),
    }),
    voidReact(),
  ],
});
