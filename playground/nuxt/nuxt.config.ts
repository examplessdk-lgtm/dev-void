import { resolve } from 'pathslash';
import type { PluginOption } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineNuxtConfig({
  compatibilityDate: '2026-02-24',
  nitro: {
    preset: 'cloudflare-module',
    modules: ['void/nitro'],
    cloudflareDev: { configPath: './.void-wrangler.jsonc' },
    // Remove when Nuxt ships https://github.com/nuxt/nuxt/commit/21657c6fcf.
    externals: {
      inline: [/[\\/]node_modules[\\/]nuxt[\\/]dist[\\/]/],
    },
    alias: {
      // Nuxt types server routes from Nitro's aliases.
      '@schema': resolve(import.meta.dirname, 'db/schema.ts'),
    },
  },
  vite: {
    plugins: [voidPlugin() as unknown as PluginOption],
  },
});
