import analog from '@analogjs/platform';
import { resolve } from 'pathe';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    analog({
      ssr: true,
      nitro: {
        preset: 'cloudflare-module',
        modules: ['nitro-cloudflare-dev'],
        alias: {
          // Nitro has its own bundler that doesn't use Vite aliases.
          // Duplicate @schema here so Nitro can resolve it.
          '@schema': resolve(__dirname, 'db/schema.ts'),
        },
      },
    }),
    voidPlugin(),
  ],
});
