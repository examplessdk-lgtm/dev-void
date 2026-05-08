import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), sveltekit()],
});
