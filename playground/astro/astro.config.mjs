import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';
import { voidPlugin } from 'void';

function vite8AstroDevToolbarCompat() {
  return {
    name: 'playground-astro:vite8-dev-toolbar-compat',
    config(config) {
      const plugins = config.optimizeDeps?.esbuildOptions?.plugins;

      if (plugins) {
        config.optimizeDeps.esbuildOptions.plugins = plugins.filter(
          (plugin) => plugin?.name !== 'astro:strip-toolbar-sourcemap',
        );
      }
    },
  };
}

export default defineConfig({
  adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
  vite: {
    plugins: [voidPlugin(), vite8AstroDevToolbarCompat()],
  },
});
