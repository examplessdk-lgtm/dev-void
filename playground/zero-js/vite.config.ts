import { voidMarkdown } from '@void/md/plugin';
import { voidVue } from '@void/vue/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
