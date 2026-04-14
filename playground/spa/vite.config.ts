import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [react(), voidPlugin()],
});
