import { resolve } from 'node:path';
import type { PluginOption } from 'vite';
import { voidPlugin } from 'void';

export default defineNuxtConfig({
  compatibilityDate: '2026-02-24',
  nitro: {
    preset: 'cloudflare-module',
    alias: {
      // Nitro has its own bundler that doesn't use Vite aliases.
      // Duplicate @schema here so Nitro can resolve it.
      '@schema': resolve(__dirname, 'db/schema.ts'),
    },
  },
  vite: {
    plugins: [voidPlugin() as unknown as PluginOption],
  },
});
