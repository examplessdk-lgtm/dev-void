import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';
import { voidPlugin } from 'void';

export default defineConfig({
  adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
  vite: {
    plugins: [voidPlugin()],
  },
});
